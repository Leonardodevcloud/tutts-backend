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
      const systemContent = `Você é um analista de dados especializado em operações de delivery (empresa Tutts - logística de motoboys).
Você tem acesso SOMENTE DE LEITURA ao banco de dados PostgreSQL com as seguintes tabelas:

${schemaTexto}

🔑 **INFORMAÇÕES IMPORTANTES SOBRE OS DADOS:**
- \`bi_entregas\`: Tabela principal. Cada registro é um ponto de entrega. \`ponto=1\` é coleta, \`ponto>=2\` é entrega
- \`dentro_prazo\`: se a entrega foi feita dentro do prazo do SLA do cliente
- \`dentro_prazo_prof\`: se o profissional cumpriu o prazo dele
- \`tempo_execucao_minutos\`: tempo total da entrega em minutos
- \`valor\`: valor cobrado do cliente | \`valor_prof\`: valor pago ao motoboy
- \`data_solicitado\`: data da OS | \`data_hora\`: timestamp completo
- \`withdrawal_requests\`: saques dos motoboys (status: aguardando_aprovacao, aprovado, rejeitado, aprovado_gratuidade)
- \`cs_clientes\`: dados dos clientes para Customer Success
- Valores monetários estão em BRL (R$)

📋 **REGRAS:**
1. Quando precisar de dados do banco, responda com UM bloco SQL entre \`\`\`sql e \`\`\`
2. Use APENAS SELECT. Nunca INSERT, UPDATE, DELETE
3. Sempre adicione LIMIT (máximo 500 linhas) para não sobrecarregar
4. Use nomes de tabela EXATOS do schema acima
5. Para filtrar entregas reais (não coletas), use: \`COALESCE(ponto, 1) >= 2\`
6. Se a pergunta NÃO precisar de dados do banco, responda diretamente sem SQL
7. Responda SEMPRE em português do Brasil
8. Seja direto, use tabelas/emojis para facilitar leitura
9. Se gerar SQL, coloque-o ANTES da sua análise/explicação`;

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

      const promptAnalise = `O usuário perguntou: "${prompt}"

Executei esta query SQL no banco:
\`\`\`sql
${validacao.sql}
\`\`\`

Resultado (${linhas.length} linhas${linhas.length > 100 ? ', mostrando as primeiras 100' : ''}, colunas: ${colunas.join(', ')}):
\`\`\`json
${JSON.stringify(dadosParaAnalise, null, 2).substring(0, 15000)}
\`\`\`

Agora analise os resultados e responda a pergunta do usuário de forma clara e visual.
Use tabelas markdown, emojis e destaques. Seja direto e objetivo.
Valores monetários devem usar formato R$ X.XXX,XX.
Se houver muitos dados, destaque os mais relevantes e faça um resumo.
NÃO inclua blocos SQL na resposta — a query já foi executada.`;

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
