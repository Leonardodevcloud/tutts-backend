/**
 * BI Sub-Router: Chat IA com acesso ao banco de dados
 * Permite prompts livres — Gemini gera SQL, executa e analisa os resultados
 */
const express = require('express');

function createChatIaRoutes(pool) {
  const router = express.Router();

  // ==================== SCHEMA CACHE ====================
  let schemaCache = { data: null, timestamp: 0 };
  const SCHEMA_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

  // Tabelas permitidas para consulta (segurança)
  const TABELAS_PERMITIDAS = [
    'bi_entregas', 'bi_upload_historico', 'bi_relatorios_ia',
    'bi_prazos_cliente', 'bi_faixas_prazo', 'bi_prazo_padrao',
    'bi_prazos_prof_cliente', 'bi_faixas_prazo_prof', 'bi_prazo_prof_padrao',
    'bi_regioes', 'bi_regras_contagem', 'bi_mascaras',
    'bi_resumo_cliente', 'bi_resumo_diario', 'bi_resumo_geral', 'bi_resumo_profissional',
    'withdrawal_requests', 'gratuities', 'restricted_professionals',
    'cs_clientes', 'cs_interacoes', 'cs_ocorrencias',
    'solicitacoes_corrida', 'solicitacoes_pontos',
    'operacoes', 'operacoes_faixas_km',
    'disponibilidade_linhas', 'disponibilidade_lojas', 'disponibilidade_regioes',
    'score_totais', 'score_historico',
    'indicacoes', 'indicacao_links',
    'loja_produtos', 'loja_pedidos', 'loja_estoque'
  ];

  // Buscar schema das tabelas permitidas
  async function getSchema() {
    if (schemaCache.data && Date.now() - schemaCache.timestamp < SCHEMA_CACHE_TTL) {
      return schemaCache.data;
    }

    const result = await pool.query(`
      SELECT 
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position
    `, [TABELAS_PERMITIDAS]);

    // Agrupar por tabela
    const schema = {};
    for (const row of result.rows) {
      if (!schema[row.table_name]) {
        schema[row.table_name] = [];
      }
      schema[row.table_name].push({
        coluna: row.column_name,
        tipo: row.data_type,
        nullable: row.is_nullable === 'YES'
      });
    }

    // Contar registros por tabela (aprox)
    for (const tabela of Object.keys(schema)) {
      try {
        const countResult = await pool.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = $1`, [tabela]);
        schema[tabela].count = parseInt(countResult.rows[0]?.count) || 0;
      } catch (e) {
        schema[tabela].count = '?';
      }
    }

    schemaCache = { data: schema, timestamp: Date.now() };
    return schema;
  }

  // Formatar schema para o prompt
  function formatarSchema(schema) {
    let texto = '';
    for (const [tabela, colunas] of Object.entries(schema)) {
      const count = colunas.count !== undefined ? ` (~${colunas.count} registros)` : '';
      texto += `\n📋 ${tabela}${count}:\n`;
      const cols = Array.isArray(colunas) ? colunas : [];
      for (const col of cols) {
        texto += `  - ${col.coluna} (${col.tipo}${col.nullable ? ', nullable' : ''})\n`;
      }
    }
    return texto;
  }

  // Validar SQL - APENAS SELECT permitido
  function validarSQL(sql) {
    const sqlLimpo = sql.trim().replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();
    const upper = sqlLimpo.toUpperCase().replace(/\s+/g, ' ').trim();

    // Bloquear qualquer coisa que não seja SELECT
    const proibidos = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'COPY', 'VACUUM', 'REINDEX'];
    for (const cmd of proibidos) {
      // Verificar se o comando aparece como primeira palavra ou após ;
      if (upper.startsWith(cmd + ' ') || upper.includes('; ' + cmd) || upper.includes(';' + cmd)) {
        return { valido: false, erro: `Comando ${cmd} não é permitido. Apenas SELECT é autorizado.` };
      }
    }

    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
      return { valido: false, erro: 'Apenas queries SELECT ou WITH (CTE) são permitidas.' };
    }

    // Bloquear múltiplas queries
    const semStrings = sqlLimpo.replace(/'[^']*'/g, '');
    if ((semStrings.match(/;/g) || []).length > 1) {
      return { valido: false, erro: 'Apenas uma query por vez é permitida.' };
    }

    // Verificar se referencia apenas tabelas permitidas
    // (não é 100% preciso mas pega os casos óbvios)
    const tabelasUsadas = upper.match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'pg_class') {
        return { valido: false, erro: `Tabela "${tabela}" não está autorizada para consulta.` };
      }
    }

    return { valido: true, sql: sqlLimpo };
  }

  // ==================== ENDPOINT: Chat IA ====================
  router.post('/bi/chat-ia', async (req, res) => {
    try {
      const { prompt, historico } = req.body;

      if (!prompt || prompt.trim().length < 3) {
        return res.status(400).json({ error: 'Prompt deve ter pelo menos 3 caracteres.' });
      }

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) {
        return res.status(400).json({ error: 'API Key do Gemini não configurada. Adicione GEMINI_API_KEY nas variáveis de ambiente.' });
      }

      console.log(`🤖 [Chat IA] Prompt: "${prompt.substring(0, 100)}..."`);

      // 1. Buscar schema do banco
      const schema = await getSchema();
      const schemaTexto = formatarSchema(schema);

      // 2. Montar histórico de mensagens (se houver)
      const mensagens = [];

      // System message via primeiro user message
      const systemContent = `Você é um analista de dados SQL expert. Seu ÚNICO trabalho é gerar queries SQL para responder perguntas sobre o banco de dados PostgreSQL da empresa Tutts (logística de motoboys).

⚠️ REGRA ABSOLUTA: Você SEMPRE gera uma query SQL. NUNCA invente dados. NUNCA dê respostas hipotéticas. Se não tem certeza da query, gere a melhor aproximação possível.

📊 SCHEMA DO BANCO:
${schemaTexto}

🔑 DICIONÁRIO DE DADOS (bi_entregas - tabela principal):
- os: número da Ordem de Serviço
- ponto: 1=coleta, 2+=entrega (SEMPRE filtre ponto >= 2 para entregas reais)
- num_pedido: número do pedido do cliente
- cod_cliente / nome_cliente / nome_fantasia / empresa: identificação do cliente
- centro_custo: unidade/filial do cliente
- cod_prof / nome_prof: código e nome do motoboy/entregador
- data_solicitado: data da OS (DATE) — USE ESTE CAMPO para filtrar por período
- hora_solicitado / hora_chegada / hora_saida: horários da entrega
- data_hora: timestamp completo da criação
- categoria: tipo de serviço
- valor: valor cobrado do cliente (R$)
- valor_prof: valor pago ao motoboy (R$)
- distancia: distância em km
- status: status da entrega (Finalizado, Cancelado, etc)
- motivo: motivo de cancelamento/ocorrência
- ocorrencia: tipo de ocorrência
- dentro_prazo: BOOLEAN - se entregou dentro do prazo SLA do cliente
- prazo_minutos: prazo máximo em minutos para aquele cliente
- tempo_execucao_minutos: tempo real que levou a entrega (em minutos)
- dentro_prazo_prof: BOOLEAN - se o profissional cumpriu o prazo dele
- tempo_execucao_prof_minutos: tempo de execução do profissional
- cidade / bairro / estado: localização da entrega
- velocidade_media: velocidade média do motoboy

🔑 OUTRAS TABELAS:
- withdrawal_requests: saques dos motoboys (status: aguardando_aprovacao, aprovado, rejeitado)
- cs_clientes: cadastro de clientes do Customer Success
- cs_interacoes / cs_ocorrencias: interações e ocorrências de clientes
- score_totais / score_historico: pontuação dos profissionais

📋 FORMATO DA RESPOSTA:
Responda APENAS com um bloco SQL assim:

\`\`\`sql
SELECT ... FROM bi_entregas WHERE ... LIMIT 200
\`\`\`

REGRAS SQL:
1. SEMPRE gere SQL. Nunca responda sem SQL.
2. SEMPRE filtre entregas reais: WHERE COALESCE(ponto, 1) >= 2
3. SEMPRE adicione LIMIT (máximo 500)
4. Para tempo médio de entrega, use: AVG(tempo_execucao_minutos)
5. Para taxa de prazo, use: ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*), 0), 1)
6. Para filtrar por período, use: data_solicitado BETWEEN '2026-01-01' AND '2026-01-31'
7. Para detratores/piores profissionais, ordene por taxa de prazo ASC ou tempo médio DESC
8. NUNCA invente dados ou dê exemplos hipotéticos
9. Se a pergunta mencionar "detratores", são profissionais com PIOR desempenho (menor taxa de prazo)
10. Valores monetários: use TO_CHAR(valor, 'FM999G999D99') para formatar`;

      // Adicionar histórico se existir (turnos anteriores)
      if (historico && Array.isArray(historico) && historico.length > 0) {
        // Primeiro turno com system content
        mensagens.push({
          role: 'user',
          content: systemContent + '\n\n---\n\nPergunta do usuário: ' + historico[0].prompt
        });
        if (historico[0].resposta) {
          mensagens.push({ role: 'assistant', content: historico[0].resposta });
        }
        // Turnos subsequentes
        for (let i = 1; i < historico.length; i++) {
          mensagens.push({ role: 'user', content: historico[i].prompt });
          if (historico[i].resposta) {
            mensagens.push({ role: 'assistant', content: historico[i].resposta });
          }
        }
        // Prompt atual
        mensagens.push({ role: 'user', content: prompt });
      } else {
        mensagens.push({
          role: 'user',
          content: systemContent + '\n\n---\n\nPergunta do usuário: ' + prompt
        });
      }

      // 3. Primeira chamada: Gemini decide se precisa de SQL ou responde direto
      console.log('🤖 [Chat IA] Chamando Gemini (etapa 1: análise do prompt)...');
      
      // Montar conteúdo para Gemini (formato parts)
      const geminiContents = mensagens.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const resp1 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: geminiContents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
        })
      });

      const data1 = await resp1.json();
      if (data1.error) {
        console.error('❌ [Chat IA] Erro Gemini etapa 1:', data1.error);
        return res.status(500).json({ error: `Erro Gemini: ${data1.error.message}` });
      }

      const resposta1 = data1.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log(`🤖 [Chat IA] Resposta etapa 1: ${resposta1.substring(0, 200)}...`);

      // 4. Verificar se há SQL na resposta
      const sqlMatch = resposta1.match(/```sql\n?([\s\S]*?)\n?```/);

      if (!sqlMatch) {
        // Sem SQL — resposta direta
        console.log('✅ [Chat IA] Resposta direta (sem SQL)');
        return res.json({
          success: true,
          resposta: resposta1,
          sql: null,
          dados: null
        });
      }

      // 5. Extrair e validar SQL
      const sqlBruto = sqlMatch[1].trim();
      const validacao = validarSQL(sqlBruto);

      if (!validacao.valido) {
        console.error('❌ [Chat IA] SQL bloqueado:', validacao.erro);
        return res.json({
          success: true,
          resposta: `⚠️ A query gerada foi bloqueada por segurança: ${validacao.erro}\n\nPor favor, reformule sua pergunta.`,
          sql: sqlBruto,
          dados: null,
          bloqueado: true
        });
      }

      // 6. Executar SQL com timeout de 15s
      console.log(`🔍 [Chat IA] Executando SQL: ${validacao.sql.substring(0, 200)}...`);
      let queryResult;
      try {
        await pool.query('SET statement_timeout = 15000');
        queryResult = await pool.query(validacao.sql);
        await pool.query('SET statement_timeout = 0');
      } catch (sqlError) {
        await pool.query('SET statement_timeout = 0').catch(() => {});
        console.error('❌ [Chat IA] Erro SQL:', sqlError.message);

        // Erro na execução SQL
        return res.json({
          success: true,
          resposta: `⚠️ Erro ao executar a query:\n\`\`\`\n${sqlError.message}\n\`\`\`\n\nSQL tentada:\n\`\`\`sql\n${validacao.sql}\n\`\`\`\n\nTente reformular sua pergunta ou ser mais específico.`,
          sql: validacao.sql,
          dados: null,
          erro_sql: sqlError.message
        });
      }

      const linhas = queryResult.rows;
      const colunas = queryResult.fields?.map(f => f.name) || [];
      console.log(`✅ [Chat IA] Query retornou ${linhas.length} linhas, ${colunas.length} colunas`);

      // 7. Enviar resultados para Gemini analisar
      // Limitar dados para não estourar o contexto
      const dadosParaAnalise = linhas.length > 100
        ? linhas.slice(0, 100)
        : linhas;

      const promptAnalise = `Você é um analista de dados da empresa Tutts (logística de motoboys). Analise os dados REAIS abaixo e responda a pergunta do usuário.

Pergunta: "${prompt}"

Query SQL executada:
\`\`\`sql
${validacao.sql}
\`\`\`

Dados REAIS retornados (${linhas.length} linhas${linhas.length > 100 ? ', mostrando as primeiras 100' : ''}, colunas: ${colunas.join(', ')}):
\`\`\`json
${JSON.stringify(dadosParaAnalise, null, 2).substring(0, 15000)}
\`\`\`

REGRAS DA RESPOSTA:
1. Use APENAS os dados acima. NUNCA invente dados ou dê exemplos hipotéticos.
2. Se os dados não respondem completamente a pergunta, diga o que falta e sugira uma nova pergunta.
3. Use tabelas markdown para organizar os dados.
4. Valores monetários em formato R$ 1.234,56
5. Tempos em minutos — converta para horas se > 60min.
6. Destaque os insights mais importantes com emojis.
7. Seja direto e objetivo. Responda em português do Brasil.
8. NÃO inclua blocos SQL — a query já foi executada.
9. Se o resultado estiver vazio, diga claramente que não há dados para o filtro solicitado.`;

      console.log('🤖 [Chat IA] Chamando Gemini (etapa 2: análise dos resultados)...');
      const resp2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptAnalise }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
        })
      });

      const data2 = await resp2.json();
      if (data2.error) {
        console.error('❌ [Chat IA] Erro Gemini etapa 2:', data2.error);
        // Retornar os dados brutos pelo menos
        return res.json({
          success: true,
          resposta: `Consegui buscar os dados mas houve um erro na análise. Aqui estão os dados brutos (${linhas.length} registros):`,
          sql: validacao.sql,
          dados: { colunas, linhas: dadosParaAnalise, total: linhas.length }
        });
      }

      const respostaFinal = data2.candidates?.[0]?.content?.parts?.[0]?.text || 'Não foi possível analisar os resultados.';
      console.log('✅ [Chat IA] Análise completa');

      // 8. Retornar tudo
      return res.json({
        success: true,
        resposta: respostaFinal,
        sql: validacao.sql,
        dados: {
          colunas,
          linhas: dadosParaAnalise,
          total: linhas.length
        }
      });

    } catch (err) {
      console.error('❌ [Chat IA] Erro geral:', err);
      res.status(500).json({ error: 'Erro interno no Chat IA: ' + err.message });
    }
  });

  // ==================== ENDPOINT: Schema (para debug/frontend) ====================
  router.get('/bi/chat-ia/schema', async (req, res) => {
    try {
      const schema = await getSchema();
      res.json({ tabelas: Object.keys(schema).length, schema });
    } catch (err) {
      console.error('❌ Erro ao buscar schema:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createChatIaRoutes };
