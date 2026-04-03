/**
 * BI Sub-Router: Chat IA — Analista de Dados Conversacional
 * v5.0 — Gemini API (Google)
 */
const express = require('express');

function createChatIaRoutes(pool) {
  const router = express.Router();

  // ==================== CACHES ====================
  let schemaCache = { data: null, timestamp: 0 };
  const SCHEMA_CACHE_TTL = 5 * 60 * 1000;
  let samplesCache = { data: null, timestamp: 0 };
  const SAMPLES_CACHE_TTL = 30 * 60 * 1000;

  // ==================== TABELAS PERMITIDAS ====================
  // 🔒 SECURITY FIX (CRIT-03): Tabelas financeiras sensíveis REMOVIDAS (CPF, Pix, valores de saque)
  // Removidos: withdrawal_requests, gratuities, restricted_professionals, indicacoes, indicacao_links
  const TABELAS_PERMITIDAS = [
    'bi_entregas', 'bi_upload_historico', 'bi_relatorios_ia',
    'bi_prazos_cliente', 'bi_faixas_prazo', 'bi_prazo_padrao',
    'bi_prazos_prof_cliente', 'bi_faixas_prazo_prof', 'bi_prazo_prof_padrao',
    'bi_regioes', 'bi_regras_contagem', 'bi_mascaras',
    'bi_resumo_cliente', 'bi_resumo_diario', 'bi_resumo_geral', 'bi_resumo_profissional',
    'cs_clientes', 'cs_interacoes', 'cs_ocorrencias',
    'solicitacoes_corrida', 'solicitacoes_pontos',
    'operacoes', 'operacoes_faixas_km',
    'disponibilidade_linhas', 'disponibilidade_lojas', 'disponibilidade_regioes',
    'score_totais', 'score_historico',
    'loja_produtos', 'loja_pedidos', 'loja_estoque',
    'bi_garantido_cache', 'garantido_status'
  ];

  // ==================== CHAMAR GEMINI ====================
  async function chamarGemini(messages, systemPrompt, opts = {}) {
    const { temperature = 0.4, maxTokens = 4096 } = opts;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurada');

    // Converter formato messages[] → formato Gemini (contents[])
    const contents = messages.map(function(m) {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      };
    });

    const body = {
      contents: contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens,
        topP: 0.95
      }
    };

    console.log(`📡 [Chat IA] Chamando Gemini (${messages.length} msgs, temp=${temperature})...`);

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ [Chat IA] Gemini HTTP ${resp.status}:`, errText);
      throw new Error(`Gemini API HTTP ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();
    if (data.error) {
      console.error(`❌ [Chat IA] Gemini error:`, data.error);
      throw new Error(`Gemini API: ${data.error.message}`);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokensUsados = data.usageMetadata?.totalTokenCount || 0;

    console.log(`✅ [Chat IA] Gemini respondeu (${text.length} chars, ${tokensUsados} tokens)`);
    return text;
  }

  // ==================== SCHEMA + SAMPLES ====================
  async function getSchema() {
    if (schemaCache.data && Date.now() - schemaCache.timestamp < SCHEMA_CACHE_TTL) return schemaCache.data;
    const result = await pool.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position
    `, [TABELAS_PERMITIDAS]);

    const schema = {};
    for (const row of result.rows) {
      if (!schema[row.table_name]) schema[row.table_name] = { colunas: [], count: 0 };
      schema[row.table_name].colunas.push({
        coluna: row.column_name,
        tipo: row.data_type,
        nullable: row.is_nullable === 'YES'
      });
    }

    for (const tabela of Object.keys(schema)) {
      try {
        const c = await pool.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = $1`, [tabela]);
        schema[tabela].count = parseInt(c.rows[0]?.count) || 0;
      } catch (e) { schema[tabela].count = '?'; }
    }

    schemaCache = { data: schema, timestamp: Date.now() };
    return schema;
  }

  function formatarSchema(schema) {
    let texto = '';
    for (const [tabela, info] of Object.entries(schema)) {
      texto += `\n## ${tabela} (~${info.count} registros)\n`;
      for (const col of info.colunas) {
        texto += `  - ${col.coluna} (${col.tipo}${col.nullable ? ', nullable' : ''})\n`;
      }
    }
    return texto;
  }

  async function getSamples() {
    if (samplesCache.data && Date.now() - samplesCache.timestamp < SAMPLES_CACHE_TTL) return samplesCache.data;
    const samples = {};
    try {
      const [oc, st, cat, datas, clientes, profs] = await Promise.all([
        pool.query(`SELECT DISTINCT ocorrencia, COUNT(*)::int as qtd FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != '' GROUP BY ocorrencia ORDER BY qtd DESC LIMIT 20`),
        pool.query(`SELECT DISTINCT status, COUNT(*)::int as qtd FROM bi_entregas WHERE status IS NOT NULL AND status != '' GROUP BY status ORDER BY qtd DESC LIMIT 15`),
        pool.query(`SELECT DISTINCT categoria, COUNT(*)::int as qtd FROM bi_entregas WHERE categoria IS NOT NULL AND categoria != '' GROUP BY categoria ORDER BY qtd DESC LIMIT 10`),
        pool.query(`SELECT MIN(data_solicitado) as min_data, MAX(data_solicitado) as max_data, COUNT(DISTINCT data_solicitado)::int as dias FROM bi_entregas`),
        pool.query(`SELECT DISTINCT cod_cliente, nome_fantasia, COUNT(*)::int as qtd FROM bi_entregas WHERE cod_cliente IS NOT NULL AND nome_fantasia IS NOT NULL GROUP BY cod_cliente, nome_fantasia ORDER BY qtd DESC LIMIT 30`),
        pool.query(`SELECT DISTINCT cod_prof, nome_prof, COUNT(*)::int as qtd FROM bi_entregas WHERE cod_prof IS NOT NULL AND nome_prof IS NOT NULL GROUP BY cod_prof, nome_prof ORDER BY qtd DESC LIMIT 30`)
      ]);
      samples.ocorrencias = oc.rows;
      samples.status = st.rows;
      samples.categorias = cat.rows;
      samples.periodo = datas.rows[0];
      samples.clientes = clientes.rows;
      samples.profissionais = profs.rows;
    } catch (e) { console.error('⚠️ [Chat IA] Erro amostras:', e.message); }
    samplesCache = { data: samples, timestamp: Date.now() };
    return samples;
  }

  function formatarSamples(samples) {
    if (!samples) return '';
    let texto = '\n# VALORES REAIS NO BANCO:\n';
    if (samples.ocorrencias?.length) texto += `\nOcorrências: ${samples.ocorrencias.map(o => `"${o.ocorrencia}" (${o.qtd}x)`).join(', ')}\n`;
    if (samples.status?.length) texto += `Status: ${samples.status.map(s => `"${s.status}" (${s.qtd}x)`).join(', ')}\n`;
    if (samples.categorias?.length) texto += `Categorias: ${samples.categorias.map(c => `"${c.categoria}" (${c.qtd}x)`).join(', ')}\n`;
    if (samples.periodo) texto += `Período: ${samples.periodo.min_data} até ${samples.periodo.max_data} (${samples.periodo.dias} dias)\n`;
    if (samples.clientes?.length) texto += `\nClientes (top 30): ${samples.clientes.map(c => `${c.nome_fantasia} (cod:${c.cod_cliente}, ${c.qtd})`).join(', ')}\n`;
    if (samples.profissionais?.length) texto += `\nProfissionais (top 30): ${samples.profissionais.map(p => `${p.nome_prof} (cod:${p.cod_prof}, ${p.qtd})`).join(', ')}\n`;
    return texto;
  }

  // ==================== VALIDAÇÃO SQL ====================
  function validarSQL(sql) {
    let sqlLimpo = sql.trim().replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();
    const upper = sqlLimpo.toUpperCase().replace(/\s+/g, ' ').trim();

    const proibidos = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'COPY', 'VACUUM', 'REINDEX'];
    for (const cmd of proibidos) {
      if (upper.startsWith(cmd + ' ') || upper.includes('; ' + cmd) || upper.includes(';' + cmd))
        return { valido: false, erro: `Comando ${cmd} não permitido.` };
    }

    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH'))
      return { valido: false, erro: 'Apenas SELECT ou WITH permitidos.' };

    const semStrings = sqlLimpo.replace(/'[^']*'/g, '');
    if ((semStrings.match(/;/g) || []).length > 1) {
      const queries = sqlLimpo.split(/;\s*/).filter(q => q.trim().length > 0);
      if (queries.length > 0) sqlLimpo = queries[0].trim();
    }

    // 🔒 SECURITY FIX (CRIT-03): Validar subqueries — extrair TODAS as tabelas incluindo subselects
    const sqlSemExtract = sqlLimpo.replace(/EXTRACT\s*\([^)]*\)/gi, '').replace(/DATE_PART\s*\([^)]*\)/gi, '').replace(/DATE_TRUNC\s*\([^)]*\)/gi, '');
    const tabelasUsadas = sqlSemExtract.toUpperCase().match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'generate_series')
        return { valido: false, erro: `Tabela "${tabela}" não autorizada.` };
    }

    // 🔒 SECURITY FIX (CRIT-03): Bloquear tabelas sensíveis mesmo em subqueries
    const tabelasSensiveis = ['users', 'user_financial_data', 'financial_logs', 'withdrawal_requests', 
      'withdrawal_idempotency', 'gratuities', 'restricted_professionals', 'indicacoes', 'indicacao_links',
      'login_attempts', 'user_sessions', 'stark_lotes', 'stark_lote_itens'];
    const sqlLower = sqlLimpo.toLowerCase();
    for (const ts of tabelasSensiveis) {
      if (sqlLower.includes(ts)) {
        return { valido: false, erro: `Acesso à tabela "${ts}" não permitido no Chat IA.` };
      }
    }

    // 🔒 SECURITY FIX: Bloquear pg_catalog, information_schema, pg_*
    if (/\bpg_\w+/i.test(sqlLimpo) || /\binformation_schema\b/i.test(sqlLimpo)) {
      return { valido: false, erro: 'Acesso a tabelas do sistema não permitido.' };
    }

    if (!sqlLimpo.toUpperCase().includes('LIMIT')) sqlLimpo += ' LIMIT 500';
    return { valido: true, sql: sqlLimpo };
  }

  // 🔒 SECURITY FIX (CRIT-03): Usar client dedicado para isolar statement_timeout
  async function executarSQL(sql) {
    const validacao = validarSQL(sql);
    if (!validacao.valido) return { success: false, erro: validacao.erro, sql };
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 15000');
      const result = await client.query(validacao.sql);
      await client.query('SET statement_timeout = 0');
      return { success: true, rows: result.rows, fields: result.fields?.map(f => f.name) || [], rowCount: result.rowCount, sql: validacao.sql };
    } catch (sqlError) {
      await client.query('SET statement_timeout = 0').catch(() => {});
      return { success: false, erro: sqlError.message, sql: validacao.sql };
    } finally {
      client.release();
    }
  }

  // ==================== KNOWLEDGE BASE ====================
  const KNOWLEDGE_BASE = `
## 1. PRAZOS (SLA)
- Prazo por DISTÂNCIA (km): faixas por cliente > centro de custo > padrão
- Cliente 767 (Comollati): SLA fixo 120min, meta >=95%
- dentro_prazo = true quando tempo_execucao_minutos <= prazo_minutos
- Taxa prazo = (dentro prazo / total com prazo calculado) x 100. Meta geral: >=85%

## 2. MOTIVOS DE ATRASO (dentro_prazo = false, ordem de prioridade)
1. Falha sistêmica: SLA total > 600min E alocação > 300min
2. OS não encerrada: SLA total > 600min, alocação normal
3. Associado tarde: alocação > 30min — problema NOSSO
4. Coleta lenta: tempo residual > 45min — problema do CLIENTE
5. Atraso do motoboy: nenhum dos anteriores

SQL:
CASE
  WHEN EXTRACT(EPOCH FROM (finalizado - data_hora))/60 > 600 AND EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 > 300 THEN 'Falha sistêmica'
  WHEN EXTRACT(EPOCH FROM (finalizado - data_hora))/60 > 600 THEN 'OS não encerrada'
  WHEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 > 30 THEN 'Associado tarde'
  WHEN (EXTRACT(EPOCH FROM (finalizado - data_hora))/60 - EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 - tempo_execucao_minutos) > 45 THEN 'Coleta lenta'
  ELSE 'Atraso do motoboy'
END

## 3. RETORNOS (campo ocorrencia)
Tipos: "Cliente Fechado", "ClienteAus"/"Cliente Ausente", "Loja Fechada", "Produto Incorreto", "Retorno"
Taxa: até 2% SAUDÁVEL | 2-5% ATENÇÃO | >5% PREOCUPANTE

## 4. FINANCEIRO
- Receita bruta = valor da OS (1 por OS, não por ponto)
- Custo profissionais = valor_prof da OS
- REGRA CRÍTICA DE FATURAMENTO: Para calcular valor/faturamento, SEMPRE use DISTINCT ON (os) ORDER BY ponto ASC. Isso garante 1 valor por OS (equivale ao FIRSTNONBLANK do Power BI). Exemplo:
  WITH eu_fat AS (SELECT DISTINCT ON (os) os, valor, valor_prof FROM bi_entregas WHERE COALESCE(ponto,1) >= 2 AND os IS NOT NULL ORDER BY os, ponto ASC)
  SELECT SUM(valor) - COALESCE(SUM(valor_prof), 0) as faturamento_liquido FROM eu_fat WHERE ...
- Se fizer SUM(valor) direto da bi_entregas SEM DISTINCT ON, vai DUPLICAR valores porque cada OS tem múltiplos pontos
- Ticket médio = faturamento_liquido / total_entregas (entregas = COUNT(*) da bi_entregas com ponto >= 2)
- Garantido (bi_garantido_cache): complemento = MAX(0, valor_negociado - valor_produzido)

## 5. FROTA
- Motos/dia = COUNT(DISTINCT cod_prof). Ideal: 10 entregas/moto/dia

## 6. ESTRUTURA
- bi_entregas: cada linha = um PONTO de uma OS
- Ponto 1 = COLETA, Ponto >= 2 = ENTREGAS. SEMPRE: WHERE COALESCE(ponto, 1) >= 2

## 7. DETRATORES
- Profissional com 3+ OS atrasadas = detrator de prazo`;

  // ==================== SISTEMA DE MEMÓRIAS ====================
  async function getMemoriasUsuario(userId) {
    try {
      const result = await pool.query(
        `SELECT conteudo FROM bi_chat_memorias WHERE user_id = $1 AND ativo = true ORDER BY created_at ASC LIMIT 50`,
        [userId]
      );
      return result.rows.map(r => r.conteudo);
    } catch (e) {
      console.error('⚠️ [Chat IA] Erro buscar memórias:', e.message);
      return [];
    }
  }

  async function detectarESalvarMemorias(userId, prompt, resposta) {
    try {
      // Detectar se o prompt contém instrução/preferência
      const promptLower = prompt.toLowerCase();
      const indicadores = [
        'sempre que', 'quando eu pedir', 'prefiro', 'quero que', 'lembra que',
        'a partir de agora', 'não precisa', 'pode parar de', 'inclui sempre',
        'mostra sempre', 'separa por', 'formato que eu gosto', 'do jeito que',
        'chamo de', 'aqui a gente chama', 'na tutts a gente', 'nossa regra',
        'minha preferência', 'me mostra como', 'padrão que eu uso'
      ];

      const temInstrucao = indicadores.some(i => promptLower.includes(i));
      if (!temInstrucao) return;

      // Verificar se já existe memória similar
      const existentes = await pool.query(
        `SELECT conteudo FROM bi_chat_memorias WHERE user_id = $1 AND ativo = true`,
        [userId]
      );

      // Usar Gemini pra extrair a memória de forma inteligente
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) return;

      const memoriasAtuais = existentes.rows.map(r => r.conteudo).join('\n');

      const systemText = `Você extrai preferências e instruções de conversas. Responda APENAS com a memória a ser salva, em uma frase curta e direta. Se não houver preferência/instrução clara, responda exatamente "NENHUMA".

Memórias já salvas deste usuário:
${memoriasAtuais || '(nenhuma)'}

Se a nova instrução é igual ou parecida com alguma já salva, responda "NENHUMA" para evitar duplicatas.`;

      const extractResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{ text: `O gestor disse: "${prompt}"\n\nExtraia a preferência/instrução em uma frase curta (máx 100 chars). Ex: "Prefere faturamento separado por centro de custo" ou "Chama motoboys de motos".` }]
            }],
            systemInstruction: { parts: [{ text: systemText }] },
            generationConfig: { temperature: 0, maxOutputTokens: 300 }
          })
        }
      );

      const extractData = await extractResp.json();
      const memoria = extractData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (memoria && memoria !== 'NENHUMA' && memoria.length > 5 && memoria.length < 200) {
        await pool.query(
          `INSERT INTO bi_chat_memorias (user_id, conteudo) VALUES ($1, $2)`,
          [userId, memoria]
        );
        console.log(`🧠 [Chat IA] Nova memória salva: "${memoria}"`);
      }
    } catch (e) {
      console.error('⚠️ [Chat IA] Erro detectar memória:', e.message);
    }
  }

  // ==================== SYSTEM PROMPT ====================
  function buildSystemPrompt(schemaTexto, samplesTexto, contextoFiltros, memorias) {
    const memoriasTexto = memorias && memorias.length > 0
      ? `\nVocê já conhece esse gestor. Coisas que ele já te disse em conversas anteriores:\n${memorias.map(m => `- ${m}`).join('\n')}\nLeve isso em conta nas suas respostas.\n`
      : '';

    return `Você é um analista de dados que trabalha na Tutts, uma empresa de logística de entregas com motoboys em Salvador/BA. Você faz parte do time. O cara que está conversando com você é o gestor da operação — seu colega.
${memoriasTexto}
Conversa com ele do jeito mais natural possível. Como se vocês estivessem lado a lado olhando os dados juntos. Se ele perguntar "quanto a gente faturou?", responde "Faturamos R$ 45 mil líquido no período" — direto assim. Se ele disser "tira o cliente X dessa conta", você ajusta. Se algo não ficou claro, pergunta. Se ele te corrigir, aprende.

Você tem acesso ao banco de dados da empresa. Quando precisar de dados, gere um SQL dentro de \`\`\`sql ... \`\`\` — o sistema executa e te devolve o resultado pra você analisar e responder.

Algumas coisas importantes sobre como se portar:
- Fale como colega, não como robô. "A gente", "nossos motoboys", "essa semana foi puxada".
- Responda com os DADOS primeiro. Número na frente, explicação se precisar.
- Se ele perguntar como algo funciona, explica em linguagem de negócio. "Faturamento líquido é o que sobra pra gente depois de pagar o motoboy." Sem termos técnicos de banco.
- Se não tem certeza de algo, pergunta. "Você quer que eu olhe só as entregas finalizadas ou incluo as canceladas também?"
- Mantém o fio da conversa. Se ele pediu faturamento e depois diz "agora por motoboy", você sabe do que ele tá falando.
- Nunca mostre SQL, nomes de colunas, ou termos de programação pro usuário. Isso é bastidor.
- Nunca invente dados. Se não achou, diz "não encontrei dados pra isso no período selecionado".
- Nunca termine com "posso ajudar com mais alguma coisa?" ou sugestões. Responde e pronto, igual colega faz.

Regras técnicas do SQL (interno, nunca exponha):
- Só entregas: WHERE COALESCE(ponto, 1) >= 2
- Sempre LIMIT (máx 500)
- Divisões: NULLIF(x, 0)
- Taxa prazo: ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2)
- FATURAMENTO: SEMPRE use CTE com DISTINCT ON (os) ORDER BY ponto ASC para somar valores. Exemplo: WITH eu_fat AS (SELECT DISTINCT ON (os) os, valor, valor_prof FROM bi_entregas WHERE COALESCE(ponto,1) >= 2 AND os IS NOT NULL ORDER BY os, ponto ASC) SELECT SUM(valor) - COALESCE(SUM(valor_prof), 0) FROM eu_fat WHERE ...
- NUNCA faça SUM(valor) direto da bi_entregas — duplica valores porque cada OS tem múltiplos pontos
- Retornos: LOWER(ocorrencia) LIKE '%cliente fechado%' OR '%clienteaus%' OR '%cliente ausente%' OR '%loja fechada%' OR '%retorno%'
- Clientes: nome_fantasia. Profissionais: nome_prof
- Só tabelas do schema abaixo

${contextoFiltros ? `ATENÇÃO — FILTROS OBRIGATÓRIOS:
O gestor está olhando dados filtrados. TODA query SQL que você gerar DEVE incluir estes filtros no WHERE, sem exceção:
${contextoFiltros}
Se você gerar uma query sem estes filtros, os dados vão estar errados.` : 'Sem filtros ativos — todos os dados.'}

Schema e dados de referência (interno — nunca mencione pro gestor):
${schemaTexto}
${samplesTexto}

IMPORTANTE: Acima você tem uma AMOSTRA REAL dos dados com o filtro ativo. USE ela pra entender os nomes exatos das colunas, os formatos dos valores, e como os dados se parecem. Quando gerar SQL, use APENAS colunas que você VÊ nessa amostra ou no schema.

Regras de negócio que você precisa saber:
${KNOWLEDGE_BASE}

Sobre formatação: use **negrito** pra destacar números. 🟢 🟡 🔴 pra classificar. Valores em R$ 1.234,56. Se fizer sentido, mande um gráfico:

[CHART]
{"type":"bar","title":"Título","labels":["A","B"],"datasets":[{"label":"Série","data":[10,20],"color":"#10b981"}]}
[/CHART]`;
  }

  // ==================== AMOSTRA REAL DOS DADOS ====================
  async function getAmostraReal(filtros) {
    try {
      const conditions = ['COALESCE(ponto, 1) >= 2'];
      const params = [];
      let idx = 1;

      const codClientes = filtros?.cod_cliente
        ? (Array.isArray(filtros.cod_cliente) ? filtros.cod_cliente : [filtros.cod_cliente]).map(c => parseInt(c)).filter(c => !isNaN(c))
        : [];
      const centrosCusto = filtros?.centro_custo
        ? (Array.isArray(filtros.centro_custo) ? filtros.centro_custo : [filtros.centro_custo]).filter(c => c && c.trim())
        : [];

      if (codClientes.length > 0) {
        conditions.push(`cod_cliente IN (${codClientes.map(() => `$${idx++}`).join(',')})`);
        params.push(...codClientes);
      }
      if (centrosCusto.length > 0) {
        conditions.push(`centro_custo IN (${centrosCusto.map(() => `$${idx++}`).join(',')})`);
        params.push(...centrosCusto);
      }
      if (filtros?.data_inicio && filtros?.data_fim) {
        conditions.push(`data_solicitado BETWEEN $${idx++} AND $${idx++}`);
        params.push(filtros.data_inicio, filtros.data_fim);
      }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      const result = await pool.query(`
        SELECT os, ponto, cod_cliente, nome_fantasia, centro_custo, cod_prof, nome_prof,
          data_hora, data_hora_alocado, data_solicitado, hora_solicitado,
          finalizado, categoria, valor, valor_prof, distancia,
          status, motivo, ocorrencia, dentro_prazo, prazo_minutos, tempo_execucao_minutos,
          bairro, cidade, tipo_pagamento, tempo_espera_minutos, agendado
        FROM bi_entregas ${where}
        ORDER BY data_solicitado DESC, os DESC
        LIMIT 15
      `, params);

      if (result.rows.length === 0) return '';

      return `\n# AMOSTRA REAL DOS DADOS (${result.rows.length} registros recentes do filtro ativo — use como referência dos nomes de colunas e valores reais):\n\`\`\`json\n${JSON.stringify(result.rows, null, 2)}\n\`\`\`\n`;
    } catch (e) {
      console.error('⚠️ [Chat IA] Erro amostra:', e.message);
      return '';
    }
  }

  // ==================== MONTAR FILTROS ====================
  function montarContextoFiltros(filtros) {
    const rawCliente = filtros?.cod_cliente || null;
    const rawCentro = filtros?.centro_custo || null;
    const dataInicio = filtros?.data_inicio || null;
    const dataFim = filtros?.data_fim || null;
    const nomeCliente = filtros?.nome_fantasia || null;
    const nomeRegiao = filtros?.nome_regiao || null;

    const codClientes = rawCliente
      ? (Array.isArray(rawCliente) ? rawCliente : [rawCliente]).map(c => parseInt(c)).filter(c => !isNaN(c))
      : [];
    const centrosCusto = rawCentro
      ? (Array.isArray(rawCentro) ? rawCentro : [rawCentro]).filter(c => c && c.trim())
      : [];

    let contexto = '';
    let filtroSQL = '';

    // Se filtro veio de uma região, informar a IA
    if (nomeRegiao) {
      contexto += `Região selecionada: ${nomeRegiao}\n`;
    }

    if (codClientes.length === 1) {
      contexto += `Cliente: ${nomeCliente || 'cod ' + codClientes[0]} (cod_cliente = ${codClientes[0]})\n`;
      filtroSQL += ` AND cod_cliente = ${codClientes[0]}`;
    } else if (codClientes.length > 1) {
      const nomes = filtros?.nomes_clientes || codClientes.map(c => 'cod ' + c).join(', ');
      contexto += `Clientes (${codClientes.length}): ${nomes} — cod_cliente IN (${codClientes.join(',')})\n`;
      filtroSQL += ` AND cod_cliente IN (${codClientes.join(',')})`;
    }

    if (centrosCusto.length === 1) {
      contexto += `Centro de custo: ${centrosCusto[0]}\n`;
      filtroSQL += ` AND centro_custo = '${centrosCusto[0].replace(/'/g, "''")}'`;
    } else if (centrosCusto.length > 1) {
      contexto += `Centros de custo (${centrosCusto.length}): ${centrosCusto.join(', ')}\n`;
      filtroSQL += ` AND centro_custo IN (${centrosCusto.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`;
    }

    if (dataInicio && dataFim) {
      contexto += `Período: ${dataInicio} até ${dataFim}\n`;
      filtroSQL += ` AND data_solicitado BETWEEN '${dataInicio}' AND '${dataFim}'`;
    }

    if (filtroSQL) {
      contexto += `\nSQL obrigatório: WHERE COALESCE(ponto, 1) >= 2${filtroSQL}`;
    }

    return contexto;
  }

  // ========================================================================
  //  ENDPOINT PRINCIPAL
  // ========================================================================
  router.post('/bi/chat-ia', async (req, res) => {
    try {
      const { prompt, historico, filtros, conversa_id } = req.body;
      if (!prompt || prompt.trim().length < 3) return res.status(400).json({ error: 'Prompt deve ter pelo menos 3 caracteres.' });
      if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY não configurada. Adicione nas variáveis de ambiente do Railway.' });

      // ═══ Expansão de Região → Clientes ═══
      // Se filtros.regiao está definido, buscar bi_regioes e expandir para cod_cliente
      if (filtros && filtros.regiao && !filtros._regiao_expandida) {
        try {
          const regiaoResult = await pool.query('SELECT nome, clientes FROM bi_regioes WHERE id = $1', [parseInt(filtros.regiao)]);
          if (regiaoResult.rows.length > 0) {
            const regiao = regiaoResult.rows[0];
            const itens = typeof regiao.clientes === 'string' ? JSON.parse(regiao.clientes) : regiao.clientes;
            if (Array.isArray(itens) && itens.length > 0) {
              const codClientes = [...new Set(itens.map(i => typeof i === 'number' ? i : parseInt(i.cod_cliente)).filter(c => !isNaN(c)))];
              const centros = itens.filter(i => i.centro_custo).map(i => i.centro_custo);
              
              filtros.cod_cliente = codClientes;
              filtros.nome_regiao = regiao.nome;
              if (centros.length > 0 && centros.length < codClientes.length * 3) {
                filtros.centro_custo = centros;
              }
              // Buscar nomes dos clientes
              try {
                const nomesResult = await pool.query(
                  `SELECT DISTINCT cod_cliente, nome_fantasia FROM bi_entregas WHERE cod_cliente = ANY($1) AND nome_fantasia IS NOT NULL`,
                  [codClientes]
                );
                filtros.nomes_clientes = nomesResult.rows.map(r => r.nome_fantasia || ('cod ' + r.cod_cliente)).join(', ');
              } catch (e) {
                filtros.nomes_clientes = codClientes.map(c => 'cod ' + c).join(', ');
              }
              filtros._regiao_expandida = true;
              console.log(`🗺️ [Chat IA] Região "${regiao.nome}" expandida para ${codClientes.length} clientes`);
            }
          }
        } catch (errRegiao) {
          console.warn('⚠️ [Chat IA] Erro ao expandir região:', errRegiao.message);
        }
      }

      console.log(`\n🤖 [Chat IA v4] Prompt: "${prompt.substring(0, 100)}"`);
      console.log(`   Filtros: ${JSON.stringify(filtros || {}).substring(0, 200)}`);
      console.log(`   Histórico: ${historico?.length || 0} msgs`);

      const contextoFiltros = montarContextoFiltros(filtros);
      const userId = req.user?.id || req.user?.userId || 'anonymous';

      let schema, samples, amostra, memorias;
      try {
        [schema, samples, amostra, memorias] = await Promise.all([
          getSchema(), getSamples(), getAmostraReal(filtros), getMemoriasUsuario(userId)
        ]);
      } catch (dbErr) {
        console.error('❌ [Chat IA] Erro schema/samples:', dbErr.message);
        return res.status(500).json({ error: 'Erro banco: ' + dbErr.message });
      }

      if (memorias.length > 0) console.log(`🧠 [Chat IA] ${memorias.length} memória(s) do usuário carregadas`);

      const systemPrompt = buildSystemPrompt(formatarSchema(schema), formatarSamples(samples) + amostra, contextoFiltros, memorias);
      const messages = [];
      if (historico?.length > 0) {
        for (const h of historico) {
          if (h.prompt) messages.push({ role: 'user', content: h.prompt });
          if (h.resposta) messages.push({ role: 'assistant', content: h.resposta });
        }
      }
      // Injetar filtros no prompt do usuário para reforçar
      const promptComFiltros = contextoFiltros 
        ? `[Contexto: ${contextoFiltros.split('\n').filter(l => !l.startsWith('SQL')).join(', ').trim()}]\n\n${prompt}`
        : prompt;
      messages.push({ role: 'user', content: promptComFiltros });

      // ETAPA 1
      let resposta1;
      try {
        resposta1 = await chamarGemini(messages, systemPrompt, { temperature: 0.8, maxTokens: 4096 });
      } catch (iaErr) {
        console.error('❌ [Chat IA] Erro Gemini:', iaErr.message);
        return res.status(500).json({ error: 'Erro IA: ' + iaErr.message });
      }

      const sqlBlocks = [];
      const sqlRegex = /```sql\n?([\s\S]*?)\n?```/g;
      let match;
      while ((match = sqlRegex.exec(resposta1)) !== null) sqlBlocks.push(match[1].trim());

      if (sqlBlocks.length === 0) {
        console.log('✅ [Chat IA v4] Resposta direta');
        if (conversa_id) await salvarMensagem(conversa_id, prompt, resposta1, null, null);
        // Detectar memórias em background (não bloqueia a resposta)
        detectarESalvarMemorias(userId, prompt, resposta1).catch(() => {});
        return res.json({ success: true, resposta: resposta1, sql: null, dados: null });
      }

      // ETAPA 2
      console.log(`🔄 [Chat IA v4] ${sqlBlocks.length} SQL(s)...`);
      const todosResultados = [];
      const todasColunas = new Set();
      const sqlsExecutadas = [];
      const erros = [];

      for (const bloco of sqlBlocks) {
        const queries = bloco.split(/;\s*/).filter(q => { const t = q.trim().toUpperCase(); return t.startsWith('SELECT') || t.startsWith('WITH'); });
        for (const sql of queries) {
          const resultado = await executarSQL(sql.trim());
          if (resultado.success) {
            resultado.rows.forEach(row => todosResultados.push(row));
            resultado.fields.forEach(f => todasColunas.add(f));
            sqlsExecutadas.push(resultado.sql);
            console.log(`  ✅ ${resultado.rowCount} rows`);
          } else {
            erros.push(resultado.erro);
            console.error(`  ❌ ${resultado.erro}`);
          }
        }
      }

      // Retry
      if (todosResultados.length === 0 && erros.length > 0) {
        console.log('🔄 [Chat IA v4] Retry...');
        try {
          const retryMsgs = [...messages, { role: 'assistant', content: resposta1 }, { role: 'user', content: `As queries SQL falharam com estes erros:\n${erros.join('\n')}\n\nProvavelmente você usou colunas que não existem. Consulte o schema fornecido no system prompt e gere queries usando APENAS as colunas que existem. A tabela principal é bi_entregas.` }];
          const resp2 = await chamarGemini(retryMsgs, systemPrompt, { temperature: 0.3, maxTokens: 4096 });
          const r2 = /```sql\n?([\s\S]*?)\n?```/g;
          let m2;
          while ((m2 = r2.exec(resp2)) !== null) {
            const res2 = await executarSQL(m2[1].trim());
            if (res2.success) { res2.rows.forEach(r => todosResultados.push(r)); res2.fields.forEach(f => todasColunas.add(f)); sqlsExecutadas.push(res2.sql); }
          }
          if (todosResultados.length === 0) {
            return res.json({ success: true, resposta: resp2.replace(/```sql[\s\S]*?```/g, '').trim() || '⚠️ Não consegui. Reformule.', sql: null, dados: null });
          }
        } catch (e) {
          return res.json({ success: true, resposta: '⚠️ Erro na consulta. Reformule.', sql: null, dados: null });
        }
      }

      // ETAPA 3
      const dadosParaAnalise = todosResultados.slice(0, 150);
      console.log(`🧠 [Chat IA v4] Analisando ${todosResultados.length} registros...`);

      let respostaFinal;
      try {
        const analiseMsgs = [...messages, { role: 'assistant', content: resposta1 }, { role: 'user', content: `Resultado SQL (${todosResultados.length} registros${todosResultados.length > 150 ? ', mostrando 150' : ''}):\n\n\`\`\`json\n${JSON.stringify(dadosParaAnalise, null, 2).substring(0, 30000)}\n\`\`\`\n\nAnalise e responda. NÃO inclua SQL.` }];
        respostaFinal = await chamarGemini(analiseMsgs, systemPrompt, { temperature: 1, maxTokens: 4096 });
      } catch (e) {
        respostaFinal = `Dados encontrados (${todosResultados.length} registros), mas houve erro na análise.`;
      }

      const sqlFinal = sqlsExecutadas.join(';\n\n');
      if (conversa_id) await salvarMensagem(conversa_id, prompt, respostaFinal, sqlFinal, { total: todosResultados.length });
      // Detectar memórias em background
      detectarESalvarMemorias(userId, prompt, respostaFinal).catch(() => {});

      console.log('✅ [Chat IA v4] OK');
      return res.json({ success: true, resposta: respostaFinal, sql: sqlFinal, dados: { colunas: [...todasColunas], linhas: dadosParaAnalise, total: todosResultados.length } });
    } catch (err) {
      console.error('❌ [Chat IA v4] ERRO:', err);
      res.status(500).json({ error: 'Erro interno: ' + err.message });
    }
  });

  // ========================================================================
  //  PERSISTÊNCIA DE CONVERSAS
  // ========================================================================
  async function salvarMensagem(conversaId, prompt, resposta, sql, dados) {
    try {
      await pool.query(`INSERT INTO bi_chat_mensagens (conversa_id, role, content, sql_executado, dados_resumo) VALUES ($1, 'user', $2, NULL, NULL), ($1, 'assistant', $3, $4, $5)`, [conversaId, prompt, resposta, sql, dados ? JSON.stringify(dados) : null]);
      await pool.query(`UPDATE bi_chat_conversas SET updated_at = NOW() WHERE id = $1`, [conversaId]);
    } catch (e) { console.error('⚠️ Erro salvar msg:', e.message); }
  }

  router.post('/bi/chat-ia/conversas', async (req, res) => {
    try {
      const { titulo, filtros } = req.body;
      const userId = req.user?.id || req.user?.userId || 'anonymous';
      const result = await pool.query(`INSERT INTO bi_chat_conversas (user_id, titulo, filtros) VALUES ($1, $2, $3) RETURNING *`, [userId, titulo || 'Nova conversa', filtros ? JSON.stringify(filtros) : null]);
      res.json({ success: true, conversa: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/bi/chat-ia/conversas', async (req, res) => {
    try {
      const userId = req.user?.id || req.user?.userId || 'anonymous';
      const result = await pool.query(`SELECT c.*, (SELECT COUNT(*)::int FROM bi_chat_mensagens m WHERE m.conversa_id = c.id AND m.role = 'user') as total_mensagens FROM bi_chat_conversas c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 50`, [userId]);
      res.json({ success: true, conversas: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/bi/chat-ia/conversas/:id', async (req, res) => {
    try {
      const conversa = await pool.query(`SELECT * FROM bi_chat_conversas WHERE id = $1`, [req.params.id]);
      if (conversa.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
      const mensagens = await pool.query(`SELECT * FROM bi_chat_mensagens WHERE conversa_id = $1 ORDER BY created_at ASC`, [req.params.id]);
      const historico = [];
      const msgs = mensagens.rows;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === 'user') {
          const a = msgs[i + 1]?.role === 'assistant' ? msgs[i + 1] : null;
          historico.push({ prompt: msgs[i].content, resposta: a?.content || null, sql: a?.sql_executado || null, dados: a?.dados_resumo ? JSON.parse(a.dados_resumo) : null });
          if (a) i++;
        }
      }
      res.json({ success: true, conversa: conversa.rows[0], historico });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch('/bi/chat-ia/conversas/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE bi_chat_conversas SET titulo = $1, updated_at = NOW() WHERE id = $2`, [req.body.titulo, req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/bi/chat-ia/conversas/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM bi_chat_mensagens WHERE conversa_id = $1`, [req.params.id]);
      await pool.query(`DELETE FROM bi_chat_conversas WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ========================================================================
  //  EXPORTAÇÃO DOCX
  // ========================================================================
  router.post('/bi/chat-ia/exportar', async (req, res) => {
    try {
      const { mensagens, filtros } = req.body;
      if (!mensagens || mensagens.length === 0) return res.status(400).json({ error: 'Nenhuma mensagem.' });

      const { Document, Packer, Paragraph, TextRun, Header, Footer, AlignmentType, BorderStyle, ShadingType, PageNumber } = require('docx');

      let filtroTexto = 'Todos os dados';
      if (filtros) {
        const p = [];
        if (filtros.nomes_clientes?.length) p.push(`Clientes: ${filtros.nomes_clientes.join(', ')}`);
        if (filtros.centro_custo?.length) p.push(`Centros: ${filtros.centro_custo.join(', ')}`);
        if (filtros.data_inicio && filtros.data_fim) p.push(`Período: ${filtros.data_inicio} a ${filtros.data_fim}`);
        if (p.length > 0) filtroTexto = p.join(' · ');
      }

      const dataHoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

      function mdToRuns(text) {
        const runs = [];
        const limpo = text.replace(/\[CHART\][\s\S]*?\[\/CHART\]/g, '[Gráfico]');
        const partes = limpo.split(/(\*\*.*?\*\*)/g);
        for (const parte of partes) {
          if (parte.startsWith('**') && parte.endsWith('**')) runs.push(new TextRun({ text: parte.slice(2, -2), bold: true, size: 22 }));
          else runs.push(new TextRun({ text: parte, size: 22 }));
        }
        return runs;
      }

      const children = [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: 'CENTRAL TUTTS', bold: true, size: 36, color: '7C3AED' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: 'Relatório — Chat IA', bold: true, size: 28, color: '374151' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 50 }, children: [new TextRun({ text: dataHoje, size: 20, color: '6B7280' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: filtroTexto, size: 20, color: '6B7280', italics: true })] }),
        new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: '7C3AED' } }, spacing: { after: 300 } })
      ];

      for (let i = 0; i < mensagens.length; i++) {
        const msg = mensagens[i];
        children.push(new Paragraph({ spacing: { before: 200, after: 100 }, shading: { fill: 'EDE9FE', type: ShadingType.CLEAR }, children: [new TextRun({ text: '👤 Pergunta: ', bold: true, size: 22, color: '7C3AED' }), new TextRun({ text: msg.prompt || '', size: 22, color: '374151' })] }));
        if (msg.resposta) {
          for (const linha of msg.resposta.split('\n').filter(l => l.trim())) {
            if (linha.startsWith('## ')) children.push(new Paragraph({ spacing: { before: 200, after: 80 }, children: [new TextRun({ text: linha.replace(/^#+\s/, ''), bold: true, size: 24, color: '1F2937' })] }));
            else if (linha.startsWith('- ') || linha.startsWith('• ')) children.push(new Paragraph({ spacing: { before: 40, after: 40 }, indent: { left: 400 }, children: mdToRuns('• ' + linha.replace(/^[-•]\s/, '')) }));
            else children.push(new Paragraph({ spacing: { before: 40, after: 40 }, children: mdToRuns(linha) }));
          }
        }
        if (i < mensagens.length - 1) children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' } }, spacing: { before: 200, after: 200 } }));
      }

      children.push(new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 2, color: '7C3AED' } }, spacing: { before: 400 } }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Relatório gerado pela Central Tutts — Chat IA', size: 18, color: '9CA3AF', italics: true })] }));

      const doc = new Document({
        sections: [{
          properties: { page: { margin: { top: 1000, bottom: 1000, left: 1200, right: 1200 } } },
          headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Central Tutts · Chat IA', size: 16, color: '9CA3AF', italics: true })] })] }) },
          footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Página ', size: 16, color: '9CA3AF' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '9CA3AF' })] })] }) },
          children
        }]
      });

      const buffer = await Packer.toBuffer(doc);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename=chat-ia-relatorio-${new Date().toISOString().slice(0, 10)}.docx`);
      res.send(buffer);
    } catch (err) {
      console.error('❌ Exportar:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ========================================================================
  //  MEMÓRIAS DO USUÁRIO
  // ========================================================================
  router.get('/bi/chat-ia/memorias', async (req, res) => {
    try {
      const userId = req.user?.id || req.user?.userId || 'anonymous';
      const result = await pool.query(
        `SELECT id, conteudo, created_at FROM bi_chat_memorias WHERE user_id = $1 AND ativo = true ORDER BY created_at ASC`,
        [userId]
      );
      res.json({ success: true, memorias: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/bi/chat-ia/memorias', async (req, res) => {
    try {
      const userId = req.user?.id || req.user?.userId || 'anonymous';
      const { conteudo } = req.body;
      if (!conteudo || conteudo.trim().length < 3) return res.status(400).json({ error: 'Conteúdo muito curto' });
      const result = await pool.query(
        `INSERT INTO bi_chat_memorias (user_id, conteudo) VALUES ($1, $2) RETURNING *`,
        [userId, conteudo.trim()]
      );
      res.json({ success: true, memoria: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/bi/chat-ia/memorias/:id', async (req, res) => {
    try {
      await pool.query(`UPDATE bi_chat_memorias SET ativo = false WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ========================================================================
  //  FILTROS + SCHEMA
  // ========================================================================
  router.get('/bi/chat-ia/filtros', async (req, res) => {
    try {
      const clientes = await pool.query(`SELECT DISTINCT e.cod_cliente, COALESCE(m.mascara, e.nome_fantasia) as nome_fantasia FROM bi_entregas e LEFT JOIN bi_mascaras m ON m.cod_cliente = e.cod_cliente::text WHERE e.cod_cliente IS NOT NULL AND e.nome_fantasia IS NOT NULL AND e.nome_fantasia != '' ORDER BY nome_fantasia`);
      const centrosCusto = await pool.query(`SELECT DISTINCT centro_custo FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != '' ORDER BY centro_custo`);
      let rawCodCliente = req.query.cod_cliente;
      let codClientes = [];
      if (rawCodCliente) {
        if (Array.isArray(rawCodCliente)) codClientes = rawCodCliente.map(c => parseInt(c)).filter(c => !isNaN(c));
        else codClientes = String(rawCodCliente).split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      }
      let centrosDoCliente = [];
      if (codClientes.length > 0) {
        const ph = codClientes.map((_, i) => `$${i + 1}`).join(', ');
        const r = await pool.query(`SELECT DISTINCT centro_custo FROM bi_entregas WHERE cod_cliente IN (${ph}) AND centro_custo IS NOT NULL AND centro_custo != '' ORDER BY centro_custo`, codClientes);
        centrosDoCliente = r.rows.map(r => r.centro_custo);
      }
      res.json({ clientes: clientes.rows, centros_custo: centrosCusto.rows.map(r => r.centro_custo), centros_do_cliente: centrosDoCliente });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/bi/chat-ia/schema', async (req, res) => {
    try { res.json({ tabelas: Object.keys(await getSchema()).length, schema: await getSchema() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

module.exports = { createChatIaRoutes };
