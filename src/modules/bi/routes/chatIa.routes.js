/**
 * BI Sub-Router: Chat IA com acesso ao banco de dados
 * Permite prompts livres — Gemini gera SQL, executa e analisa os resultados
 * 
 * v2.0 — Melhorias de assertividade:
 *  1. Classificador de intenção (etapa 0) — prompts menores e focados
 *  2. Detecção semântica de perguntas conceituais (sem lista estática)
 *  3. Pós-validação automática de SQL (filtros obrigatórios)
 *  4. Amostras de valores distintos no prompt (ocorrências, status, etc)
 *  5. Prompt de análise dinâmico por categoria
 *  6. Retry inteligente com contexto do prompt original (até 3 tentativas)
 *  7. Cache de queries semelhantes (10 min TTL)
 */
const express = require('express');

function createChatIaRoutes(pool) {
  const router = express.Router();

  // ==================== CACHES ====================
  let schemaCache = { data: null, timestamp: 0 };
  const SCHEMA_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

  let samplesCache = { data: null, timestamp: 0 };
  const SAMPLES_CACHE_TTL = 30 * 60 * 1000; // 30 minutos

  // Cache de queries por similaridade (melhoria 7)
  const queryCache = new Map();
  const QUERY_CACHE_TTL = 10 * 60 * 1000; // 10 minutos

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
    'loja_produtos', 'loja_pedidos', 'loja_estoque',
    'bi_garantido_cache', 'garantido_status'
  ];

  // ==================== HELPER: Chamar Gemini ====================
  async function chamarGemini(apiKey, prompt, opts = {}) {
    const { temperature = 0.3, maxTokens = 4096, contents = null } = opts;
    const body = {
      contents: contents || [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    };
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await resp.json();
    if (data.error) throw new Error(`Gemini: ${data.error.message}`);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // ==================== MELHORIA 5: Amostras de valores distintos ====================
  async function getSamples() {
    if (samplesCache.data && Date.now() - samplesCache.timestamp < SAMPLES_CACHE_TTL) {
      return samplesCache.data;
    }
    const samples = {};
    try {
      const [oc, st, cat, datas] = await Promise.all([
        pool.query(`SELECT DISTINCT ocorrencia, COUNT(*)::int as qtd FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != '' GROUP BY ocorrencia ORDER BY qtd DESC LIMIT 20`),
        pool.query(`SELECT DISTINCT status, COUNT(*)::int as qtd FROM bi_entregas WHERE status IS NOT NULL AND status != '' GROUP BY status ORDER BY qtd DESC LIMIT 15`),
        pool.query(`SELECT DISTINCT categoria, COUNT(*)::int as qtd FROM bi_entregas WHERE categoria IS NOT NULL AND categoria != '' GROUP BY categoria ORDER BY qtd DESC LIMIT 10`),
        pool.query(`SELECT MIN(data_solicitado) as min_data, MAX(data_solicitado) as max_data, COUNT(DISTINCT data_solicitado)::int as dias FROM bi_entregas`)
      ]);
      samples.ocorrencias = oc.rows;
      samples.status = st.rows;
      samples.categorias = cat.rows;
      samples.periodo = datas.rows[0];
    } catch (e) {
      console.error('⚠️ [Chat IA] Erro ao buscar amostras:', e.message);
    }
    samplesCache = { data: samples, timestamp: Date.now() };
    return samples;
  }

  function formatarSamples(samples) {
    if (!samples) return '';
    let texto = '\n═══════════════════════════════════════\n📊 VALORES REAIS NO BANCO (use para filtrar corretamente)\n═══════════════════════════════════════\n';
    if (samples.ocorrencias?.length) {
      texto += `\nValores de ocorrencia: ${samples.ocorrencias.map(o => `"${o.ocorrencia}" (${o.qtd}x)`).join(', ')}\n`;
    }
    if (samples.status?.length) {
      texto += `Valores de status: ${samples.status.map(s => `"${s.status}" (${s.qtd}x)`).join(', ')}\n`;
    }
    if (samples.categorias?.length) {
      texto += `Valores de categoria: ${samples.categorias.map(c => `"${c.categoria}" (${c.qtd}x)`).join(', ')}\n`;
    }
    if (samples.periodo) {
      texto += `Período disponível: ${samples.periodo.min_data} até ${samples.periodo.max_data} (${samples.periodo.dias} dias)\n`;
    }
    return texto;
  }

  // ==================== SCHEMA ====================
  async function getSchema() {
    if (schemaCache.data && Date.now() - schemaCache.timestamp < SCHEMA_CACHE_TTL) {
      return schemaCache.data;
    }
    const result = await pool.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position
    `, [TABELAS_PERMITIDAS]);

    const schema = {};
    for (const row of result.rows) {
      if (!schema[row.table_name]) schema[row.table_name] = [];
      schema[row.table_name].push({
        coluna: row.column_name,
        tipo: row.data_type,
        nullable: row.is_nullable === 'YES'
      });
    }
    for (const tabela of Object.keys(schema)) {
      try {
        const countResult = await pool.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = $1`, [tabela]);
        schema[tabela].count = parseInt(countResult.rows[0]?.count) || 0;
      } catch (e) { schema[tabela].count = '?'; }
    }
    schemaCache = { data: schema, timestamp: Date.now() };
    return schema;
  }

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

  // ==================== VALIDAÇÃO SQL ====================
  function validarSQL(sql) {
    let sqlLimpo = sql.trim().replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();
    let upper = sqlLimpo.toUpperCase().replace(/\s+/g, ' ').trim();

    const proibidos = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'COPY', 'VACUUM', 'REINDEX'];
    for (const cmd of proibidos) {
      if (upper.startsWith(cmd + ' ') || upper.includes('; ' + cmd) || upper.includes(';' + cmd)) {
        return { valido: false, erro: `Comando ${cmd} não é permitido. Apenas SELECT é autorizado.` };
      }
    }

    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
      return { valido: false, erro: 'Apenas queries SELECT ou WITH (CTE) são permitidas.' };
    }

    // Se houver múltiplas queries, pegar apenas a primeira
    const semStrings = sqlLimpo.replace(/'[^']*'/g, '');
    if ((semStrings.match(/;/g) || []).length > 1) {
      const queries = sqlLimpo.split(/;\s*/).filter(q => q.trim().length > 0);
      if (queries.length > 0) {
        console.log(`⚠️ [Chat IA] Múltiplas queries detectadas (${queries.length}), usando apenas a primeira`);
        sqlLimpo = queries[0].trim();
        upper = sqlLimpo.toUpperCase().replace(/\s+/g, ' ').trim();
      }
    }

    // Verificar tabelas permitidas
    const tabelasUsadas = upper.match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      const posMatch = upper.indexOf(match.toUpperCase());
      const antes = upper.substring(Math.max(0, posMatch - 30), posMatch).trim();
      const isExtract = /EXTRACT\s*\(\s*\w+\s*$/i.test(antes) || /\(\s*\w+\s*$/i.test(antes);
      if (isExtract) continue;
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'pg_class' && tabela !== 'generate_series') {
        return { valido: false, erro: `Tabela "${tabela}" não está autorizada para consulta.` };
      }
    }

    return { valido: true, sql: sqlLimpo };
  }

  // ==================== MELHORIA 3: Pós-validação automática ====================
  function posValidarSQL(sql, filtroSQLObrigatorio) {
    let resultado = sql;
    const upper = resultado.toUpperCase();

    // Garantir filtro de entregas (não coletas) — se não está no CTE principal
    if (!upper.includes('COALESCE(PONTO') && !upper.includes('PONTO >= 2') && !upper.includes('PONTO > 1')) {
      // Só injetar se a query opera sobre bi_entregas diretamente (não em sub-CTEs)
      if (upper.includes('BI_ENTREGAS') && upper.includes('WHERE')) {
        resultado = resultado.replace(/WHERE\s/i, 'WHERE COALESCE(ponto, 1) >= 2 AND ');
        console.log('🔧 [Chat IA] Pós-validação: injetado filtro COALESCE(ponto, 1) >= 2');
      }
    }

    // Garantir LIMIT
    if (!upper.includes('LIMIT')) {
      resultado += ' LIMIT 200';
      console.log('🔧 [Chat IA] Pós-validação: injetado LIMIT 200');
    }

    // Garantir filtros obrigatórios da conversa (cliente, período)
    if (filtroSQLObrigatorio) {
      const upperR = resultado.toUpperCase();
      // Verificar se filtro de cliente está presente
      if (filtroSQLObrigatorio.includes('cod_cliente') && !upperR.includes('COD_CLIENTE')) {
        if (upperR.includes('WHERE')) {
          resultado = resultado.replace(/WHERE\s/i, `WHERE 1=1 ${filtroSQLObrigatorio} AND `);
          console.log('🔧 [Chat IA] Pós-validação: injetados filtros obrigatórios da conversa');
        }
      }
      // Verificar se filtro de período está presente
      if (filtroSQLObrigatorio.includes('data_solicitado') && !upperR.includes('DATA_SOLICITADO')) {
        if (upperR.includes('WHERE')) {
          resultado = resultado.replace(/WHERE\s/i, `WHERE 1=1 ${filtroSQLObrigatorio} AND `);
          console.log('🔧 [Chat IA] Pós-validação: injetado filtro de período');
        }
      }
    }

    return resultado;
  }

  // ==================== MELHORIA 7: Cache de queries ====================
  function normalizarPergunta(prompt, filtros) {
    const clean = prompt.toLowerCase()
      .replace(/[?!.,;:'"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return `${clean}|${filtros?.cod_cliente || ''}|${filtros?.centro_custo || ''}|${filtros?.data_inicio || ''}|${filtros?.data_fim || ''}`;
  }

  function limparCacheExpirado() {
    const agora = Date.now();
    for (const [key, val] of queryCache.entries()) {
      if (agora - val.timestamp > QUERY_CACHE_TTL) queryCache.delete(key);
    }
  }

  // ==================== MELHORIA 1: Classificador de intenção ====================
  const CATEGORIAS = {
    SQL_ENTREGAS: {
      label: 'Entregas, prazos, clientes, profissionais, rankings, volumes',
      tabelas: ['bi_entregas', 'bi_prazos_cliente', 'bi_faixas_prazo', 'bi_resumo_cliente', 'bi_resumo_diario', 'bi_resumo_profissional'],
      dicionario: 'ENTREGAS_COMPLETO'
    },
    SQL_FINANCEIRO: {
      label: 'Faturamento, ticket médio, valores, garantido, custos, saques',
      tabelas: ['bi_entregas', 'withdrawal_requests', 'gratuities'],
      dicionario: 'FINANCEIRO'
    },
    SQL_RETORNO: {
      label: 'Retornos, devoluções, ocorrências',
      tabelas: ['bi_entregas'],
      dicionario: 'RETORNO'
    },
    SQL_ATRASO: {
      label: 'Atrasos, motivos de atraso, detratores, SLA',
      tabelas: ['bi_entregas', 'bi_prazos_cliente'],
      dicionario: 'ATRASO'
    },
    SQL_FROTA: {
      label: 'Motos por dia, profissionais, dimensionamento, escala',
      tabelas: ['bi_entregas', 'disponibilidade_linhas', 'disponibilidade_lojas'],
      dicionario: 'FROTA'
    },
    SQL_COMPARATIVO: {
      label: 'Comparações entre clientes, períodos, mercado',
      tabelas: ['bi_entregas', 'bi_resumo_cliente', 'cs_clientes'],
      dicionario: 'COMPARATIVO'
    },
    SQL_CS: {
      label: 'Customer Success, health score, interações, ocorrências CS',
      tabelas: ['cs_clientes', 'cs_interacoes', 'cs_ocorrencias', 'bi_entregas'],
      dicionario: 'CS'
    },
    CONCEITUAL: {
      label: 'Explicações, definições, como funciona, o que significa'
    },
    SAUDACAO: {
      label: 'Cumprimentos, saudações, agradecimentos'
    }
  };

  async function classificarIntencao(prompt, apiKey) {
    const classificadorPrompt = `Classifique a pergunta abaixo em EXATAMENTE UMA categoria. Responda APENAS com o nome da categoria, nada mais.

CATEGORIAS:
- SQL_ENTREGAS: perguntas sobre entregas, prazos, clientes, profissionais, rankings, volumes, top motoboys, cidades, bairros, evolução diária, horário de pico
- SQL_FINANCEIRO: perguntas sobre faturamento, ticket médio, valores, garantido, custos, saques, receita, margem, lucro, variação de demanda
- SQL_RETORNO: perguntas sobre retornos, devoluções, ocorrências de retorno, cliente fechado, cliente ausente, taxa de retorno
- SQL_ATRASO: perguntas sobre atrasos, motivos de atraso, detratores, SLA, coleta lenta, associado tarde, direcionamento lento, atraso do motoboy, fora do prazo, taxa de prazo
- SQL_FROTA: perguntas sobre motos por dia, quantidade de profissionais, dimensionamento, escala, frota, quantos motoboys
- SQL_COMPARATIVO: perguntas que COMPARAM clientes entre si, períodos entre si, comparar com mercado, ranking, versus, comparar
- SQL_CS: perguntas sobre customer success, health score, interações CS, ocorrências CS, NPS
- CONCEITUAL: perguntas sobre o que significa algo, como funciona, explicações de conceitos, definições, o que é, o que considera, me explique
- SAUDACAO: cumprimentos ("oi", "olá", "bom dia", "tudo bem", "obrigado")

PERGUNTA: "${prompt}"

CATEGORIA:`;

    try {
      const resp = await chamarGemini(apiKey, classificadorPrompt, { temperature: 0.1, maxTokens: 50 });
      const categoria = resp.trim().replace(/[^A-Z_]/g, '');
      if (CATEGORIAS[categoria]) {
        console.log(`🏷️ [Chat IA] Categoria: ${categoria}`);
        return categoria;
      }
      // Fallback: tentar extrair do texto
      for (const cat of Object.keys(CATEGORIAS)) {
        if (resp.toUpperCase().includes(cat)) {
          console.log(`🏷️ [Chat IA] Categoria (fallback): ${cat}`);
          return cat;
        }
      }
    } catch (e) {
      console.error('⚠️ [Chat IA] Erro classificador:', e.message);
    }
    // Fallback seguro
    console.log('🏷️ [Chat IA] Categoria: SQL_ENTREGAS (fallback padrão)');
    return 'SQL_ENTREGAS';
  }

  // ==================== DICIONÁRIOS POR CATEGORIA (Melhoria 1 — prompts focados) ====================
  const DICIONARIO_BASE = `Tabela principal: bi_entregas. Cada linha = um PONTO de uma OS.
Uma OS pode ter vários pontos: ponto 1 = COLETA, ponto 2+ = ENTREGAS.

COLUNAS ESSENCIAIS:
- os (INT): número da Ordem de Serviço
- ponto (INT): 1=coleta, 2+=entregas. SEMPRE filtrar: WHERE COALESCE(ponto, 1) >= 2
- cod_cliente (INT), nome_fantasia (VARCHAR): cliente (USE nome_fantasia para exibição)
- centro_custo (VARCHAR): filial/unidade do cliente
- cod_prof (INT), nome_prof (VARCHAR): motoboy
- data_solicitado (DATE): data da OS — USE PARA FILTRAR POR PERÍODO
- data_hora (TIMESTAMP): timestamp da criação
- data_hora_alocado (TIMESTAMP): quando o motoboy foi alocado
- hora_chegada (TIME), hora_saida (TIME): chegada/saída no ponto
- finalizado (TIMESTAMP): quando a OS foi finalizada
- valor (DECIMAL): valor BRUTO cobrado do cliente (R$). NÃO é faturamento líquido!
- valor_prof (DECIMAL): valor pago ao motoboy (custo operacional)
- ⚠️ FATURAMENTO LÍQUIDO = SUM(valor) - SUM(valor_prof). NUNCA use SUM(valor) sozinho como "faturamento líquido".
- ⚠️ SUM(valor) = receita bruta / valor total cobrado. SUM(valor_prof) = custo com profissionais.
- distancia (DECIMAL): distância em KM
- tempo_execucao_minutos (INT): tempo real em minutos
- dentro_prazo (BOOLEAN): se cumpriu SLA
- prazo_minutos (INT): prazo SLA do cliente
- dentro_prazo_prof (BOOLEAN): se o profissional cumpriu prazo dele
- ocorrencia (VARCHAR): tipo de ocorrência no ponto
- status (VARCHAR): status da OS
- bairro, cidade, estado (VARCHAR): localização
- latitude, longitude (DECIMAL): GPS`;

  const DICIONARIOS_ESPECIFICOS = {
    ENTREGAS_COMPLETO: `${DICIONARIO_BASE}

FÓRMULAS:
- Total Entregas: COUNT(*) WHERE COALESCE(ponto, 1) >= 2
- Taxa Prazo: ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2)
- Tempo Médio: ROUND(AVG(tempo_execucao_minutos)::numeric, 2)
- Receita Bruta: SUM(valor) — total cobrado do cliente
- Custo Profissionais: SUM(valor_prof) — total pago aos motoboys
- Faturamento Líquido: SUM(valor) - SUM(valor_prof) — SEMPRE calcular assim, NUNCA usar SUM(valor) sozinho
- KM Total: SUM(distancia)
- Motos por dia: COUNT(DISTINCT cod_prof) por data_solicitado

RECEITAS SQL:
-- Horário de pico:
SELECT EXTRACT(HOUR FROM data_hora) AS hora, COUNT(*) AS total FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 GROUP BY EXTRACT(HOUR FROM data_hora) ORDER BY total DESC

-- Evolução diária (SEMPRE inclua motos):
SELECT data_solicitado, COUNT(*) AS entregas, COUNT(DISTINCT cod_prof) as motos, ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) AS taxa_prazo FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 GROUP BY data_solicitado ORDER BY data_solicitado`,

    FINANCEIRO: `${DICIONARIO_BASE}

COLUNAS FINANCEIRAS:
- valor (DECIMAL): valor BRUTO cobrado do cliente. NÃO é faturamento líquido!
- valor_prof (DECIMAL): valor pago ao motoboy (custo operacional)
- FATURAMENTO LÍQUIDO = SUM(valor) - SUM(valor_prof). SEMPRE calcular assim.
- RECEITA BRUTA = SUM(valor) (total cobrado do cliente)
- CUSTO PROFISSIONAIS = SUM(valor_prof) (total pago aos motoboys)
- Ticket Médio = SUM(valor) / NULLIF(COUNT(*), 0)

⚠️ REGRA ABSOLUTA: Quando o usuário pedir "faturamento líquido" ou "faturamento", SEMPRE calcule SUM(valor) - SUM(valor_prof). NUNCA retorne SUM(valor) como faturamento líquido.

TABELA bi_garantido_cache: dados de mínimo garantido (sincronizados da planilha)
- cod_cliente (VARCHAR): código do cliente que contratou o garantido
- data (DATE): data do garantido
- cod_prof (VARCHAR): código do profissional
- profissional (VARCHAR): nome do profissional
- valor_negociado (DECIMAL): valor diário garantido ao motoboy
- valor_produzido (DECIMAL): quanto o motoboy produziu naquele dia
- complemento (DECIMAL): diferença que a Tutts paga (valor_negociado - valor_produzido, mín 0). ESTE É O CUSTO COM GARANTIDO.
- status (VARCHAR): 'nao_rodou' (não trabalhou), 'abaixo' (produziu menos que o garantido), 'acima' (produziu mais)
- entregas (INTEGER): quantas entregas fez no dia

⚠️ IMPORTANTE: O "custo com garantido" de um cliente = SUM(complemento) da tabela bi_garantido_cache filtrado por cod_cliente.
- Quando status='nao_rodou', o complemento é o valor_negociado inteiro (a Tutts paga mesmo sem produção).
- Quando status='abaixo', o complemento é a diferença.
- Quando status='acima', o complemento é 0 (motoboy produziu mais que o garantido).

TABELA withdrawal_requests: saques dos motoboys (NÃO é garantido)
- cod_prof, valor, status ('aguardando_aprovacao', 'aprovado', 'rejeitado', 'aprovado_gratuidade'), created_at

RECEITAS SQL:
-- Custo com garantido por cliente:
SELECT cod_cliente, SUM(complemento) as custo_garantido, SUM(valor_negociado) as total_negociado,
  COUNT(*) as dias_garantido, COUNT(*) FILTER (WHERE status = 'nao_rodou') as dias_nao_rodou,
  COUNT(*) FILTER (WHERE status = 'abaixo') as dias_abaixo, COUNT(*) FILTER (WHERE status = 'acima') as dias_acima
FROM bi_garantido_cache GROUP BY cod_cliente ORDER BY custo_garantido DESC LIMIT 20

-- Custo garantido vs faturamento por cliente:
WITH garantido AS (
  SELECT cod_cliente::int as cod_cliente, SUM(complemento) as custo_garantido
  FROM bi_garantido_cache GROUP BY cod_cliente
), faturamento AS (
  SELECT cod_cliente, nome_fantasia, SUM(valor) as faturamento, COUNT(*) as entregas
  FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 GROUP BY cod_cliente, nome_fantasia
)
SELECT f.cod_cliente, f.nome_fantasia, f.faturamento, f.entregas,
  COALESCE(g.custo_garantido, 0) as custo_garantido,
  CASE WHEN f.faturamento > 0 THEN ROUND(100.0 * COALESCE(g.custo_garantido, 0) / f.faturamento, 2) ELSE 0 END as pct_garantido_sobre_fat
FROM faturamento f LEFT JOIN garantido g ON f.cod_cliente = g.cod_cliente
ORDER BY custo_garantido DESC NULLS LAST LIMIT 20

-- Ticket médio por cliente com variação semanal:
WITH semana_atual AS (
  SELECT cod_cliente, nome_fantasia, COUNT(*) as entregas,
    ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio, SUM(valor) as faturamento
  FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND data_solicitado BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE
  GROUP BY cod_cliente, nome_fantasia
), semana_anterior AS (
  SELECT cod_cliente, COUNT(*) as entregas_ant,
    ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio_ant
  FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND data_solicitado BETWEEN CURRENT_DATE - 14 AND CURRENT_DATE - 8
  GROUP BY cod_cliente
)
SELECT sa.*, COALESCE(san.entregas_ant, 0) as entregas_sem_anterior, COALESCE(san.ticket_medio_ant, 0) as ticket_medio_sem_anterior,
  CASE WHEN COALESCE(san.ticket_medio_ant, 0) > 0 THEN ROUND(100.0 * (sa.ticket_medio - san.ticket_medio_ant) / san.ticket_medio_ant, 1) ELSE NULL END as variacao_ticket_pct,
  CASE WHEN COALESCE(san.entregas_ant, 0) > 0 THEN ROUND(100.0 * (sa.entregas - san.entregas_ant)::numeric / san.entregas_ant, 1) ELSE NULL END as variacao_demanda_pct
FROM semana_atual sa LEFT JOIN semana_anterior san ON sa.cod_cliente = san.cod_cliente ORDER BY sa.faturamento DESC LIMIT 30

REGRAS FINANCEIRAS:
- Ticket médio: informar variação %. Se variação > 5%, destacar valor anterior.
- Variação de demanda: Se > 5%, informar valor anterior e variação.
- Mínimo garantido: usar tabela bi_garantido_cache. Custo = SUM(complemento). Comparar com faturamento.
- NUNCA usar withdrawal_requests para calcular custo com garantido.`,

    RETORNO: `${DICIONARIO_BASE}

OCORRÊNCIAS DE RETORNO (filtrar com LOWER):
- 'cliente fechado' | 'clienteaus' | 'cliente ausente' | 'loja fechada' | 'produto incorreto' | 'retorno'

REFERÊNCIA DE TAXA DE RETORNO:
- Até 2% = SAUDÁVEL (normal para autopeças)
- 2% a 5% = ATENÇÃO
- Acima de 5% = PREOCUPANTE

RECEITA SQL:
SELECT cod_cliente, nome_fantasia, COUNT(*) as total_entregas,
  COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') as retornos,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') / NULLIF(COUNT(*), 0), 2) as taxa_retorno
FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 GROUP BY cod_cliente, nome_fantasia ORDER BY taxa_retorno DESC LIMIT 30`,

    ATRASO: `${DICIONARIO_BASE}

CLASSIFICAÇÃO DO MOTIVO DE ATRASO (em ordem de prioridade):
1. SLA > 600min E alocação > 300min → "Falha sistêmica" (OS nunca alocada)
2. SLA > 600min → "OS não encerrada" (motoboy não fechou a OS no app)
3. Tempo alocação > 30min → "Associado tarde" (mesa de operações demorou — problema NOSSO)
4. Direcionamento > 30min → "Direcionamento lento" (motoboy demorou para ir à coleta)
5. Tempo no P1 > 45min → "Coleta lenta" (loja do CLIENTE demorou — problema do CLIENTE)
6. Caso contrário → "Atraso do motoboy" (trânsito, rota, motoboy lento)

SEVERIDADE: 🔴 Crítico ≥6% | 🟠 Alto 5-6% | 🟣 Anomalia SLA>6h | 🟡 Médio 3-5% | 🟢 Baixo <3%
DETRATOR: profissional com 3+ OS atrasadas no período.

EXCEÇÃO CLIENTE 767 (Grupo Comollati): prazo FIXO 120min para QUALQUER km. SLA MÍNIMO exigido: 95% no prazo — abaixo disso é CRÍTICO.

CÁLCULOS:
- tempo_alocacao = EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60
- sla_total = EXTRACT(EPOCH FROM (finalizado - data_hora))/60

RECEITA SQL — Motivos de atraso:
WITH atrasos AS (
  SELECT e.os, e.cod_prof, e.nome_prof,
    EXTRACT(EPOCH FROM (e.finalizado - e.data_hora))/60 as sla_total,
    EXTRACT(EPOCH FROM (e.data_hora_alocado - e.data_hora))/60 as tempo_alocacao,
    e.tempo_execucao_minutos
  FROM bi_entregas e WHERE COALESCE(e.ponto, 1) >= 2 AND e.dentro_prazo = false AND e.finalizado IS NOT NULL AND e.data_hora IS NOT NULL
)
SELECT CASE
    WHEN sla_total > 600 AND tempo_alocacao > 300 THEN 'Falha sistêmica'
    WHEN sla_total > 600 THEN 'OS não encerrada'
    WHEN tempo_alocacao > 30 THEN 'Associado tarde'
    ELSE 'Atraso do motoboy'
  END as motivo_atraso,
  COUNT(*) as quantidade, ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER(), 0), 1) as percentual
FROM atrasos GROUP BY motivo_atraso ORDER BY quantidade DESC`,

    FROTA: `${DICIONARIO_BASE}

MOTOS POR DIA = COUNT(DISTINCT cod_prof) onde COALESCE(ponto, 1) >= 2

RECEITA SQL:
SELECT data_solicitado as dia,
  COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
  COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as motos,
  ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric /
    NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as entregas_por_moto
FROM bi_entregas GROUP BY data_solicitado ORDER BY data_solicitado`,

    COMPARATIVO: `${DICIONARIO_BASE}

REGRA: Quando comparar cliente com mercado, usar a MÉDIA GERAL de TODOS os clientes da Tutts (não apenas da região — pode haver regiões com 1 cliente só).

RECEITA SQL — Comparativo cliente vs média geral:
WITH media_geral AS (
  SELECT
    ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo_geral,
    ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio_geral,
    ROUND(100.0 * COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%') / NULLIF(COUNT(*), 0), 2) as taxa_retorno_geral,
    ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio_geral
  FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2
)
SELECT cod_cliente, nome_fantasia, COUNT(*) as entregas,
  ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo_cliente,
  mg.taxa_prazo_geral,
  ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio_cliente, mg.tempo_medio_geral,
  ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio_cliente, mg.ticket_medio_geral
FROM bi_entregas, media_geral mg WHERE COALESCE(ponto, 1) >= 2
GROUP BY cod_cliente, nome_fantasia, mg.taxa_prazo_geral, mg.tempo_medio_geral, mg.taxa_retorno_geral, mg.ticket_medio_geral
ORDER BY entregas DESC LIMIT 30`,

    CS: `${DICIONARIO_BASE}

TABELAS CS:
- cs_clientes: cod_cliente, nome_fantasia, health_score (0-100), status, segmento, regiao, created_at
- cs_interacoes: cliente_id (FK cs_clientes.id), tipo, titulo, descricao, resultado, data_interacao
- cs_ocorrencias: cliente_id, titulo, descricao, tipo, severidade, status, resolucao, created_at`
  };

  // ==================== PROMPT CONCEITUAL (Melhoria 2 — sem lista estática) ====================
  function getPromptConceitual(prompt, contextoFiltros) {
    return `Você é um profissional sênior do time operacional da Tutts (logística de entregas com motoboys). Você faz parte do time.

Responda a pergunta do usuário usando seu conhecimento profundo do sistema:

PERGUNTA: "${prompt}"
${contextoFiltros ? `\nContexto: ${contextoFiltros}` : ''}

## GLOSSÁRIO COMPLETO DO SISTEMA TUTTS:

### MOTIVOS DE ATRASO (para OS fora do SLA):
1. **Falha sistêmica**: OS com SLA total > 10h (600min) e tempo de alocação > 5h (300min). OS nunca foi alocada — ficou "perdida" no sistema.
2. **OS não encerrada**: SLA total > 10h, mas alocação normal. Motoboy entregou mas não fechou a OS no app.
3. **Associado tarde**: Tempo de alocação > 30 minutos. Nossa mesa de operações demorou para alocar um motoboy. Problema INTERNO da Tutts.
4. **Direcionamento lento**: Após ser alocado, motoboy demorou > 30min para ir até a coleta. Pode estar longe ou ocupado.
5. **Coleta lenta**: Tempo até saída do Ponto 1 > 45min. A LOJA DO CLIENTE demorou para liberar a mercadoria. Problema do CLIENTE, não nosso.
6. **Atraso do motoboy**: Nenhuma das causas acima. Deslocamento/entrega foi longo — trânsito, rota, ou motoboy lento.

### MÉTRICAS:
- **Taxa de prazo**: % de entregas dentro do SLA (meta geral ≥85%, Comollati exige ≥95%)
- **Taxa de retorno**: % que resultaram em retorno. Até 2% = SAUDÁVEL (normal para autopeças). 2-5% = ATENÇÃO. >5% = PREOCUPANTE. Sempre comparar com média geral de TODOS os clientes da Tutts.
- **Health Score**: 0-100 combinando taxa de prazo (50pts), retornos (25pts) e tempo médio (25pts)
- **SLA**: Prazo máximo por distância (10km=60min, 15km=75min, 20km=90min, 25km=105min, 30km=120min)
- **Cliente 767 (Grupo Comollati)**: SLA FIXO de 120 minutos para QUALQUER distância. Mínimo OBRIGATÓRIO: 95% no prazo — abaixo é CRÍTICO e pode gerar perda do contrato.
- **Motos por dia**: COUNT(DISTINCT cod_prof) por data — quantos motoboys operaram. Essencial para dimensionamento.
- **Detrator**: profissional com 3+ OS atrasadas no período.
- **Severidade**: 🔴 Crítico ≥6% | 🟠 Alto 5-6% | 🟡 Médio 3-5% | 🟢 Baixo <3%

### RETORNOS (tipos de ocorrência):
- "Cliente Fechado", "ClienteAus"/"Cliente Ausente", "Loja Fechada", "Produto Incorreto", "Retorno"

### ANÁLISES FINANCEIRAS:
- **Ticket médio**: Valor médio por entrega. Informar variação %. Se >5% entre semanas, destacar anterior.
- **Variação de demanda**: Entregas por cliente semana a semana. Se >5%, destacar.
- **Mínimo garantido**: Valor diário acordado com motoboys para garantir disponibilidade. Se o motoboy produz menos que o valor negociado, a Tutts paga a diferença (complemento). Se não rodou, paga o valor inteiro. O custo com garantido de um cliente = soma dos complementos. Dados na tabela bi_garantido_cache.

### COMPARATIVO COM MERCADO:
Comparar com MÉDIA GERAL de TODOS os clientes (não só da região — pode ter região com 1 cliente só).

## REGRAS:
- Fale como funcionário da Tutts: "nós", "nossa operação", "identificamos"
- Seja objetivo e claro
- Use emojis e formatação markdown
- ⛔ NUNCA sugira aumentar contato com cliente`;
  }

  // ==================== MELHORIA 4: Prompt de análise dinâmico por categoria ====================
  function getRegrasAnalisePorCategoria(categoria) {
    const regrasBase = `## IDENTIDADE
- Você É funcionário da Tutts. Use "nós", "nossa operação", "nosso time".
- ⛔ NUNCA fale como consultor externo. NUNCA use "a Tutts deveria".
- ⛔ NUNCA sugira aumentar frequência de contato com o cliente.
- Sugestões devem ser sobre melhorias INTERNAS.

## REGRAS DE FORMATO
- ⛔ PROIBIDO tabelas markdown (| --- |). Use bullet points.
- Destaque números com **negrito**.
- Português brasileiro, tom profissional.
- Emojis para performance: 🟢 Bom (≥80%) · 🟡 Atenção (50-79%) · 🔴 Crítico (<50%)
- Valores: R$ 1.234,56 | Tempos: Xh XXmin se >60min | Taxas: 1 decimal (87,3%)
- ⛔ NUNCA inclua blocos SQL na resposta.
- Use APENAS os dados retornados. NUNCA invente dados.
- Se resultado vazio, diga claramente.`;

    const regrasEspecificas = {
      SQL_ENTREGAS: `
## REGRAS ESPECÍFICAS — ENTREGAS
- Sempre inclua motos por dia (COUNT DISTINCT cod_prof) quando mostrar evolução.
- Para rankings, formato: - **Nome:** entregas · taxa prazo · tempo médio
- Cliente 767 (Comollati): SLA fixo 120min, mínimo 95% no prazo.`,

      SQL_FINANCEIRO: `
## REGRAS ESPECÍFICAS — FINANCEIRO
- FATURAMENTO LÍQUIDO = receita (SUM valor) MENOS custo com profissionais (SUM valor_prof). NUNCA apresente SUM(valor) como faturamento líquido.
- Inclua valores monetários em R$.
- Compare ticket médio com período anterior. Se variação > 5%, destaque com ↑ ou ↓ e informe valor anterior.
- Para mínimo garantido, compare custo vs faturamento (ROI). Custo com garantido = SUM(complemento) da tabela bi_garantido_cache.
- Variação de demanda: se > 5%, informar valor anterior.`,

      SQL_RETORNO: `
## REGRAS ESPECÍFICAS — RETORNO
- SEMPRE informe a referência: até 2% = SAUDÁVEL (normal para autopeças) | 2-5% = ATENÇÃO | >5% = PREOCUPANTE.
- Compare com a média geral de TODOS os clientes da Tutts.
- Detalhe os tipos de retorno (Cliente Fechado, Ausente, Loja Fechada, etc).`,

      SQL_ATRASO: `
## REGRAS ESPECÍFICAS — ATRASO
- Classifique cada motivo com emoji de severidade (🔴🟠🟡🟢).
- Explique o que cada motivo significa quando mencioná-lo.
- "Associado tarde" = problema nosso (operação). "Coleta lenta" = problema do cliente.
- Sugira ações INTERNAS para os principais detratores.
- Cliente 767 (Comollati): mínimo 95% no prazo, abaixo é CRÍTICO.
- Severidade: 🔴 ≥6% | 🟠 5-6% | 🟣 Anomalia SLA>6h | 🟡 3-5% | 🟢 <3%`,

      SQL_FROTA: `
## REGRAS ESPECÍFICAS — FROTA
- "Motos" = motoboys distintos operando (COUNT DISTINCT cod_prof).
- Média ideal: 10 entregas/moto/dia.
- Mostrar evolução dia a dia: entregas, motos, entregas/moto.`,

      SQL_COMPARATIVO: `
## REGRAS ESPECÍFICAS — COMPARATIVO
- SEMPRE compare com a MÉDIA GERAL de TODOS os clientes da Tutts.
- Nunca compare só com a região (pode ter 1 cliente só).
- Use ↑ e ↓ para variações.
- Se variação < 3%, diga que está estável.`,

      SQL_CS: `
## REGRAS ESPECÍFICAS — CS
- Health Score: 0-100 (50pts prazo + 25pts retornos + 25pts tempo).
- Classifique: 🟢 ≥80 | 🟡 60-79 | 🔴 <60.`
    };

    return regrasBase + (regrasEspecificas[categoria] || '');
  }

  // ==================== PROMPT SQL PRINCIPAL ====================
  function getPromptSQL(categoria, schemaTexto, samplesTexto, contextoFiltros, filtroSQLObrigatorio) {
    const dicionarioKey = CATEGORIAS[categoria]?.dicionario || 'ENTREGAS_COMPLETO';
    const dicionario = DICIONARIOS_ESPECIFICOS[dicionarioKey] || DICIONARIOS_ESPECIFICOS.ENTREGAS_COMPLETO;

    return `Você é um analista SQL expert da Tutts (logística de motoboys). Gere queries PostgreSQL.

⚠️ REGRA ABSOLUTA: Sua resposta INTEIRA deve ser APENAS um bloco \`\`\`sql ... \`\`\`. Nada antes, nada depois.

📊 SCHEMA:
${schemaTexto}
${samplesTexto}

═══════════════════════════════════════
🔑 DICIONÁRIO
═══════════════════════════════════════
${dicionario}

═══════════════════════════════════════
⚠️ ARMADILHAS SQL
═══════════════════════════════════════
1. NUNCA use GROUP BY por alias se o alias tem MESMO NOME de coluna da tabela. Use a expressão completa.
2. NUNCA use strftime() — PostgreSQL usa EXTRACT() ou TO_CHAR().
3. Sempre use COALESCE(ponto, 1) >= 2 (ponto pode ser NULL).
4. Para múltiplas partes, gere blocos SQL separados.
5. Inclua SEMPRE motos por dia (COUNT(DISTINCT cod_prof)) em evolução por dia.

REGRAS:
1. SEMPRE gere SQL executável. NUNCA responda sem SQL.
2. SEMPRE filtre entregas: WHERE COALESCE(ponto, 1) >= 2
3. SEMPRE adicione LIMIT (máx 500)
4. NUNCA invente dados ou use tabelas inexistentes
5. Use nome_fantasia para exibir cliente
6. Traga LIMIT 10-20 para contexto (não LIMIT 1)
7. Inclua métricas relevantes mesmo que não pedidas
8. Em evolução por dia, SEMPRE inclua COUNT(DISTINCT cod_prof) as motos
9. Para retornos, use: LOWER(ocorrencia) LIKE '%cliente fechado%' OR LIKE '%clienteaus%' OR LIKE '%cliente ausente%' OR LIKE '%loja fechada%' OR LIKE '%produto incorreto%' OR LIKE '%retorno%'
10. Para comparativo com mercado, compare com TODOS os clientes (não só região)
${contextoFiltros ? `
═══════════════════════════════════════
⚡ FILTROS ATIVOS (OBRIGATÓRIOS)
═══════════════════════════════════════
${contextoFiltros}
TODAS as queries DEVEM incluir: ${filtroSQLObrigatorio}` : ''}`;
  }

  // ==================== GRÁFICOS + SUGESTÕES (prompt de análise) ====================
  const REGRAS_GRAFICOS = `
## GRÁFICOS
Quando dados beneficiarem de visualização, inclua:
[CHART]
{"type":"bar","title":"Título","labels":["A","B"],"datasets":[{"label":"Série","data":[10,20],"color":"#10b981"}]}
[/CHART]

Tipos: "bar", "horizontalBar", "line", "pie", "doughnut"
Cores: Verde "#10b981", Vermelho "#ef4444", Amarelo "#f59e0b", Azul "#3b82f6", Roxo "#8b5cf6"
- Máximo 2 gráficos. JSON válido em UMA linha.
- Inclua gráfico para RANKINGS (5+), COMPARATIVOS, EVOLUÇÃO TEMPORAL, DISTRIBUIÇÃO.

## PROATIVIDADE
- ⛔ NUNCA diga "seria útil saber" ou "com dados adicionais poderíamos".
- ✅ Ofereça perguntas prontas ao final se houver insights para aprofundar:
💡 **Quer se aprofundar?** Pergunte-me:
- "pergunta específica 1"
- "pergunta específica 2"
- Máx 2-3 sugestões, só quando relevante.`;

  // ==================== ENDPOINT PRINCIPAL: Chat IA ====================
  router.post('/bi/chat-ia', async (req, res) => {
    try {
      const { prompt, historico, filtros } = req.body;

      if (!prompt || prompt.trim().length < 3) {
        return res.status(400).json({ error: 'Prompt deve ter pelo menos 3 caracteres.' });
      }

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) {
        return res.status(400).json({ error: 'API Key do Gemini não configurada.' });
      }

      console.log(`🤖 [Chat IA] Prompt: "${prompt.substring(0, 100)}..."`);

      // Extrair filtros
      const codCliente = filtros?.cod_cliente || null;
      const centroCusto = filtros?.centro_custo || null;
      const dataInicio = filtros?.data_inicio || null;
      const dataFim = filtros?.data_fim || null;
      const nomeCliente = filtros?.nome_fantasia || null;

      let contextoFiltros = '';
      let filtroSQLObrigatorio = '';
      if (codCliente) {
        contextoFiltros += `\n🔹 CLIENTE: ${nomeCliente || 'cod ' + codCliente} (cod_cliente = ${parseInt(codCliente)})`;
        filtroSQLObrigatorio += ` AND cod_cliente = ${parseInt(codCliente)}`;
      }
      if (centroCusto) {
        contextoFiltros += `\n🔹 CENTRO DE CUSTO: ${centroCusto}`;
        filtroSQLObrigatorio += ` AND centro_custo = '${centroCusto.replace(/'/g, "''")}'`;
      }
      if (dataInicio && dataFim) {
        contextoFiltros += `\n🔹 PERÍODO: ${dataInicio} até ${dataFim}`;
        filtroSQLObrigatorio += ` AND data_solicitado BETWEEN '${dataInicio}' AND '${dataFim}'`;
      }

      // ========== MELHORIA 7: Verificar cache ==========
      limparCacheExpirado();
      const cacheKey = normalizarPergunta(prompt, filtros);
      if (queryCache.has(cacheKey)) {
        const cached = queryCache.get(cacheKey);
        if (Date.now() - cached.timestamp < QUERY_CACHE_TTL) {
          console.log('⚡ [Chat IA] Cache hit!');
          return res.json(cached.response);
        }
      }

      // ========== MELHORIA 1: Classificar intenção (etapa 0) ==========
      const categoria = await classificarIntencao(prompt, GEMINI_API_KEY);

      // ========== MELHORIA 2: Perguntas conceituais e saudações ==========
      if (categoria === 'SAUDACAO') {
        const resp = { success: true, resposta: '👋 Olá! Sou o assistente de dados da Tutts. Faça uma pergunta sobre entregas, prazos, profissionais, financeiro, retornos ou qualquer outra métrica do BI. Posso também explicar conceitos do sistema — é só perguntar!', sql: null, dados: null };
        return res.json(resp);
      }

      if (categoria === 'CONCEITUAL') {
        console.log('📚 [Chat IA] Pergunta conceitual — respondendo sem SQL');
        try {
          const respostaConc = await chamarGemini(GEMINI_API_KEY, getPromptConceitual(prompt, contextoFiltros), { temperature: 0.5, maxTokens: 3000 });
          if (respostaConc) {
            const resp = { success: true, resposta: respostaConc, sql: null, dados: null };
            queryCache.set(cacheKey, { response: resp, timestamp: Date.now() });
            return res.json(resp);
          }
        } catch (concErr) {
          console.error('❌ [Chat IA] Erro conceitual:', concErr.message);
        }
      }

      // ========== ETAPA 1: Buscar schema + amostras + gerar SQL ==========
      const [schema, samples] = await Promise.all([getSchema(), getSamples()]);
      const schemaTexto = formatarSchema(schema);
      const samplesTexto = formatarSamples(samples);

      const promptSQL = getPromptSQL(categoria, schemaTexto, samplesTexto, contextoFiltros, filtroSQLObrigatorio);

      // Montar histórico
      const mensagens = [];
      if (historico && Array.isArray(historico) && historico.length > 0) {
        mensagens.push({
          role: 'user',
          content: promptSQL + '\n\n---\n\nPergunta do usuário: ' + historico[0].prompt
        });
        if (historico[0].resposta) {
          mensagens.push({ role: 'assistant', content: historico[0].resposta });
        }
        for (let i = 1; i < historico.length; i++) {
          mensagens.push({ role: 'user', content: historico[i].prompt });
          if (historico[i].resposta) {
            mensagens.push({ role: 'assistant', content: historico[i].resposta });
          }
        }
        mensagens.push({ role: 'user', content: prompt });
      } else {
        mensagens.push({
          role: 'user',
          content: promptSQL + '\n\n---\n\nPergunta do usuário: ' + prompt
        });
      }

      console.log('🤖 [Chat IA] Chamando Gemini (etapa 1: gerar SQL)...');
      const geminiContents = mensagens.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const resposta1 = await chamarGemini(GEMINI_API_KEY, null, {
        temperature: 0.3,
        maxTokens: 4096,
        contents: geminiContents
      });

      console.log(`🤖 [Chat IA] Resposta etapa 1: ${resposta1.substring(0, 200)}...`);

      // ========== Extrair queries SQL ==========
      const allSqlBlocks = [];
      const sqlBlockRegex = /```sql\n?([\s\S]*?)\n?```/g;
      let match;
      while ((match = sqlBlockRegex.exec(resposta1)) !== null) {
        allSqlBlocks.push(match[1].trim());
      }

      if (allSqlBlocks.length === 0) {
        const selectMatch = resposta1.match(/((?:WITH|SELECT)[\s\S]*?;)\s*$/im) ||
                           resposta1.match(/((?:WITH|SELECT)[\s\S]*?LIMIT\s+\d+)/im);
        if (selectMatch) {
          console.log('🔄 [Chat IA] SQL encontrado sem bloco de código');
          allSqlBlocks.push(selectMatch[1].trim());
        }
      }

      // Splittar blocos com múltiplas queries
      const queriesParaExecutar = [];
      for (const bloco of allSqlBlocks) {
        const partes = bloco.split(/;\s*/).filter(q => {
          const t = q.trim().toUpperCase();
          return t.startsWith('SELECT') || t.startsWith('WITH');
        });
        queriesParaExecutar.push(...partes.map(q => q.trim()));
      }

      if (queriesParaExecutar.length === 0) {
        console.log('⚠️ [Chat IA] Sem SQL — tentando resposta conceitual como fallback');
        // Fallback: tentar responder como conceitual
        try {
          const respostaFallback = await chamarGemini(GEMINI_API_KEY, getPromptConceitual(prompt, contextoFiltros), { temperature: 0.5, maxTokens: 3000 });
          if (respostaFallback) {
            const resp = { success: true, resposta: respostaFallback, sql: null, dados: null };
            return res.json(resp);
          }
        } catch (e) {
          console.error('❌ [Chat IA] Fallback conceitual também falhou:', e.message);
        }

        return res.json({
          success: true,
          resposta: '⚠️ Não foi possível gerar uma consulta SQL para essa pergunta. Tente reformular de forma mais específica.\n\nExemplos:\n- "Quantas entregas foram feitas em janeiro?"\n- "Qual o top 10 motoboys por taxa de prazo?"\n- "Qual o horário com mais entregas?"\n- "Me explique o que é coleta lenta"\n- "Quais os motivos de atraso?"',
          sql: null,
          dados: null
        });
      }

      console.log(`🤖 [Chat IA] ${queriesParaExecutar.length} query(ies) extraída(s)`);

      // ========== ETAPA 2: Validar e executar queries ==========
      const todosResultados = [];
      const todasColunas = new Set();
      const sqlsExecutadas = [];

      // ========== MELHORIA 6: Retry inteligente com contexto (até 3 tentativas) ==========
      async function executarComRetry(sql, tentativa = 1) {
        // MELHORIA 3: Pós-validação automática
        const sqlPosValidada = posValidarSQL(sql, filtroSQLObrigatorio);
        const validacao = validarSQL(sqlPosValidada);
        if (!validacao.valido) {
          console.error(`❌ [Chat IA] SQL bloqueado: ${validacao.erro}`);
          return null;
        }

        try {
          await pool.query('SET statement_timeout = 15000');
          const result = await pool.query(validacao.sql);
          await pool.query('SET statement_timeout = 0');
          return { result, sql: validacao.sql };
        } catch (sqlError) {
          await pool.query('SET statement_timeout = 0').catch(() => {});
          console.error(`❌ [Chat IA] Erro SQL (tentativa ${tentativa}/3):`, sqlError.message);

          if (tentativa >= 3) return null;

          // Retry com contexto completo do prompt original
          try {
            console.log(`🔄 [Chat IA] Auto-correção via Gemini (tentativa ${tentativa + 1})...`);
            const retryText = await chamarGemini(GEMINI_API_KEY,
              `A query SQL abaixo deu erro no PostgreSQL. Corrija mantendo a MESMA lógica.

PERGUNTA ORIGINAL DO USUÁRIO: "${prompt}"

ERRO PostgreSQL: ${sqlError.message}

SQL COM ERRO:
\`\`\`sql
${validacao.sql}
\`\`\`

REGRAS:
- Mantenha a mesma lógica e colunas.
- Corrija APENAS o erro reportado.
- Se o erro for GROUP BY, repita a expressão completa (NÃO use alias que tenha mesmo nome de coluna).
- NUNCA use strftime (PostgreSQL usa EXTRACT ou TO_CHAR).
- WHERE COALESCE(ponto, 1) >= 2 é obrigatório.
- LIMIT é obrigatório.
- Retorne APENAS o SQL corrigido em bloco \`\`\`sql\`\`\`.`,
              { temperature: 0.1, maxTokens: 2000 }
            );
            const retrySqlMatch = retryText.match(/```sql\n?([\s\S]*?)\n?```/);
            if (retrySqlMatch) {
              return await executarComRetry(retrySqlMatch[1].trim(), tentativa + 1);
            }
          } catch (retryError) {
            console.error('❌ [Chat IA] Retry falhou:', retryError.message);
          }
          return null;
        }
      }

      for (let i = 0; i < queriesParaExecutar.length; i++) {
        const resultado = await executarComRetry(queriesParaExecutar[i]);
        if (resultado) {
          const queryLabel = queriesParaExecutar.length > 1 ? `query_${i + 1}` : null;
          resultado.result.rows.forEach(row => {
            if (queryLabel) row._query = queryLabel;
            todosResultados.push(row);
          });
          resultado.result.fields?.forEach(f => todasColunas.add(f.name));
          sqlsExecutadas.push(resultado.sql);
        }
      }

      if (todosResultados.length === 0 && sqlsExecutadas.length === 0) {
        return res.json({
          success: true,
          resposta: '⚠️ Erro ao executar as queries. Tente reformular sua pergunta.',
          sql: queriesParaExecutar.join(';\n\n'),
          dados: null
        });
      }

      const linhas = todosResultados;
      const colunas = [...todasColunas];
      const sqlFinal = sqlsExecutadas.join(';\n\n');
      console.log(`✅ [Chat IA] ${sqlsExecutadas.length} query(ies) executada(s), ${linhas.length} linhas, ${colunas.length} colunas`);

      // ========== ETAPA 3: Análise com prompt dinâmico (Melhoria 4) ==========
      const dadosParaAnalise = linhas.length > 100 ? linhas.slice(0, 100) : linhas;

      const regrasAnalise = getRegrasAnalisePorCategoria(categoria);

      const promptAnalise = `Analise os dados REAIS abaixo e responda a pergunta do usuário.

## PERGUNTA
"${prompt}"
${contextoFiltros ? `\n## CONTEXTO ATIVO\n${contextoFiltros}\nDados filtrados por este contexto.` : ''}

## QUERY SQL EXECUTADA
\`\`\`sql
${sqlFinal}
\`\`\`

## DADOS REAIS (${linhas.length} registros${linhas.length > 100 ? ', primeiros 100' : ''} · Colunas: ${colunas.join(', ')})
\`\`\`json
${JSON.stringify(dadosParaAnalise, null, 2).substring(0, 15000)}
\`\`\`

${regrasAnalise}

${REGRAS_GRAFICOS}`;

      console.log('🤖 [Chat IA] Chamando Gemini (etapa 3: análise)...');
      let respostaFinal;
      try {
        respostaFinal = await chamarGemini(GEMINI_API_KEY, promptAnalise, { temperature: 0.7, maxTokens: 4096 });
      } catch (err2) {
        console.error('❌ [Chat IA] Erro Gemini etapa 3:', err2.message);
        const resp = {
          success: true,
          resposta: `Consegui buscar os dados mas houve um erro na análise. Aqui estão os dados brutos (${linhas.length} registros):`,
          sql: sqlFinal,
          dados: { colunas, linhas: dadosParaAnalise, total: linhas.length }
        };
        return res.json(resp);
      }

      if (!respostaFinal) respostaFinal = 'Não foi possível analisar os resultados.';
      console.log('✅ [Chat IA] Análise completa');

      // Montar resposta final
      const respFinal = {
        success: true,
        resposta: respostaFinal,
        sql: sqlFinal,
        dados: { colunas, linhas: dadosParaAnalise, total: linhas.length }
      };

      // Salvar no cache (Melhoria 7)
      queryCache.set(cacheKey, { response: respFinal, timestamp: Date.now() });

      return res.json(respFinal);

    } catch (err) {
      console.error('❌ [Chat IA] Erro geral:', err);
      res.status(500).json({ error: 'Erro interno no Chat IA: ' + err.message });
    }
  });

  // ==================== ENDPOINT: Listar filtros ====================
  router.get('/bi/chat-ia/filtros', async (req, res) => {
    try {
      const clientes = await pool.query(`
        SELECT DISTINCT cod_cliente, nome_fantasia 
        FROM bi_entregas 
        WHERE cod_cliente IS NOT NULL AND nome_fantasia IS NOT NULL AND nome_fantasia != ''
        ORDER BY nome_fantasia
      `);

      const centrosCusto = await pool.query(`
        SELECT DISTINCT centro_custo 
        FROM bi_entregas 
        WHERE centro_custo IS NOT NULL AND centro_custo != ''
        ORDER BY centro_custo
      `);

      const codCliente = req.query.cod_cliente;
      let centrosDoCliente = [];
      if (codCliente) {
        const result = await pool.query(`
          SELECT DISTINCT centro_custo 
          FROM bi_entregas 
          WHERE cod_cliente = $1 AND centro_custo IS NOT NULL AND centro_custo != ''
          ORDER BY centro_custo
        `, [parseInt(codCliente)]);
        centrosDoCliente = result.rows.map(r => r.centro_custo);
      }

      res.json({
        clientes: clientes.rows,
        centros_custo: centrosCusto.rows.map(r => r.centro_custo),
        centros_do_cliente: centrosDoCliente
      });
    } catch (err) {
      console.error('❌ Erro ao buscar filtros:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== ENDPOINT: Schema (debug) ====================
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
