/**
 * BI Sub-Router: Chat IA com acesso ao banco de dados
 * v3.0 — Arquitetura Data-First:
 *  - Etapa 0: Classificar intenção (Gemini Flash rápido)
 *  - Etapa 1: Buscar dados DIRETO das tabelas de resumo (queries fixas, sem Gemini)
 *  - Etapa 2: Gemini só ANALISA os dados e responde em linguagem natural
 *  - Fallback: Se nenhum template casar, aí sim gera SQL pelo Gemini
 */
const express = require('express');

function createChatIaRoutes(pool) {
  const router = express.Router();

  // ==================== CACHES ====================
  let schemaCache = { data: null, timestamp: 0 };
  const SCHEMA_CACHE_TTL = 5 * 60 * 1000;
  let samplesCache = { data: null, timestamp: 0 };
  const SAMPLES_CACHE_TTL = 30 * 60 * 1000;
  const queryResponseCache = new Map();
  const QUERY_CACHE_TTL = 10 * 60 * 1000;

  // ==================== TABELAS PERMITIDAS ====================
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
      if (!schema[row.table_name]) schema[row.table_name] = [];
      schema[row.table_name].push({ coluna: row.column_name, tipo: row.data_type, nullable: row.is_nullable === 'YES' });
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
    for (const [tabela, colunas] of Object.entries(schema)) {
      const count = colunas.count !== undefined ? ` (~${colunas.count} registros)` : '';
      texto += `\n📋 ${tabela}${count}:\n`;
      const cols = Array.isArray(colunas) ? colunas : [];
      for (const col of cols) texto += `  - ${col.coluna} (${col.tipo}${col.nullable ? ', nullable' : ''})\n`;
    }
    return texto;
  }

  async function getSamples() {
    if (samplesCache.data && Date.now() - samplesCache.timestamp < SAMPLES_CACHE_TTL) return samplesCache.data;
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
    } catch (e) { console.error('⚠️ [Chat IA] Erro amostras:', e.message); }
    samplesCache = { data: samples, timestamp: Date.now() };
    return samples;
  }

  function formatarSamples(samples) {
    if (!samples) return '';
    let texto = '\n📊 VALORES REAIS NO BANCO:\n';
    if (samples.ocorrencias?.length) texto += `Ocorrências: ${samples.ocorrencias.map(o => `"${o.ocorrencia}" (${o.qtd}x)`).join(', ')}\n`;
    if (samples.status?.length) texto += `Status: ${samples.status.map(s => `"${s.status}" (${s.qtd}x)`).join(', ')}\n`;
    if (samples.periodo) texto += `Período: ${samples.periodo.min_data} até ${samples.periodo.max_data} (${samples.periodo.dias} dias)\n`;
    return texto;
  }

  // ==================== VALIDAÇÃO SQL (para fallback) ====================
  function validarSQL(sql) {
    let sqlLimpo = sql.trim().replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();
    let upper = sqlLimpo.toUpperCase().replace(/\s+/g, ' ').trim();
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
      if (queries.length > 0) { sqlLimpo = queries[0].trim(); upper = sqlLimpo.toUpperCase().replace(/\s+/g, ' ').trim(); }
    }
    const tabelasUsadas = upper.match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      const posMatch = upper.indexOf(match.toUpperCase());
      const antes = upper.substring(Math.max(0, posMatch - 30), posMatch).trim();
      if (/EXTRACT\s*\(\s*\w+\s*$/i.test(antes) || /\(\s*\w+\s*$/i.test(antes)) continue;
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'pg_class' && tabela !== 'generate_series')
        return { valido: false, erro: `Tabela "${tabela}" não autorizada.` };
    }
    return { valido: true, sql: sqlLimpo };
  }

  function posValidarSQL(sql, filtroSQLObrigatorio) {
    let resultado = sql;
    const upper = resultado.toUpperCase();
    if (!upper.includes('COALESCE(PONTO') && !upper.includes('PONTO >= 2') && !upper.includes('PONTO > 1')) {
      if (upper.includes('BI_ENTREGAS') && upper.includes('WHERE')) {
        resultado = resultado.replace(/WHERE\s/i, 'WHERE COALESCE(ponto, 1) >= 2 AND ');
      }
    }
    if (!upper.includes('LIMIT')) resultado += ' LIMIT 200';
    // Proteger divisão por zero
    resultado = resultado.replace(/\/\s*(\w+\.\w+)\)\s*\*\s*100/g, (match, col) => {
      if (match.includes('NULLIF')) return match;
      return `/ NULLIF(${col}, 0)) * 100`;
    });
    if (filtroSQLObrigatorio) {
      const upperR = resultado.toUpperCase();
      if (filtroSQLObrigatorio.includes('cod_cliente') && !upperR.includes('COD_CLIENTE')) {
        if (upperR.includes('WHERE')) resultado = resultado.replace(/WHERE\s/i, `WHERE 1=1 ${filtroSQLObrigatorio} AND `);
      }
      if (filtroSQLObrigatorio.includes('data_solicitado') && !upperR.includes('DATA_SOLICITADO')) {
        if (upperR.includes('WHERE')) resultado = resultado.replace(/WHERE\s/i, `WHERE 1=1 ${filtroSQLObrigatorio} AND `);
      }
    }
    return resultado;
  }

  // ==================== CACHE DE RESPOSTAS ====================
  function normalizarPergunta(prompt, filtros) {
    const clientes = Array.isArray(filtros?.cod_cliente) ? filtros.cod_cliente.sort().join(',') : (filtros?.cod_cliente || '');
    const centros = Array.isArray(filtros?.centro_custo) ? filtros.centro_custo.sort().join(',') : (filtros?.centro_custo || '');
    return `${prompt.toLowerCase().replace(/[?!.,;:'"]/g, '').replace(/\s+/g, ' ').trim()}|${clientes}|${centros}|${filtros?.data_inicio || ''}|${filtros?.data_fim || ''}`;
  }

  function limparCacheExpirado() {
    const agora = Date.now();
    for (const [key, val] of queryResponseCache.entries()) {
      if (agora - val.timestamp > QUERY_CACHE_TTL) queryResponseCache.delete(key);
    }
  }

  // ==================== ETAPA 0: CLASSIFICADOR DE INTENÇÃO ====================
  async function classificarIntencao(prompt, apiKey, historico) {
    // Montar contexto do histórico para o classificador entender follow-ups
    let contextoHistorico = '';
    if (historico?.length > 0) {
      const ultimaMsg = historico[historico.length - 1];
      contextoHistorico = `\nÚLTIMA INTERAÇÃO DO CHAT:\n- Pergunta anterior: "${ultimaMsg.prompt?.substring(0, 150) || ''}"\n- Resposta anterior (trecho): "${ultimaMsg.resposta?.substring(0, 300) || ''}"`;
    }

    const p = `Classifique a pergunta em EXATAMENTE UMA categoria. Responda APENAS o nome da categoria.

CATEGORIAS:
- RESUMO_CLIENTE: resumo, performance, como está, panorama, visão geral de UM cliente
- RESUMO_GERAL: resumo geral, como estamos, panorama geral, performance geral (sem cliente específico)
- EVOLUCAO_DIARIA: evolução por dia, dia a dia, tendência, entregas por dia
- TOP_PROFISSIONAIS: top motoboys, ranking profissionais, melhores profissionais, piores profissionais, detratores
- TOP_CLIENTES: ranking clientes, maiores clientes, top clientes por volume
- PRAZO_PROFISSIONAL: prazo dos motoboys, dentro e fora do prazo por profissional, taxa de prazo profissional
- ATRASO_MOTIVOS: motivos de atraso, por que atrasou, causas de atraso, detratores de prazo, coleta lenta, associado tarde
- RETORNOS: retornos, devoluções, taxa de retorno, cliente fechado, cliente ausente
- FINANCEIRO: faturamento, ticket médio, valores, custos, garantido, receita
- COMPARATIVO: comparar clientes entre si, comparar com mercado, comparar períodos
- FROTA: motos por dia, quantos motoboys, dimensionamento, frota
- HORARIO_PICO: horário de pico, hora com mais entregas, distribuição por hora
- BAIRRO_CIDADE: entregas por bairro, por cidade, por região, mapa
- METODOLOGIA: perguntas sobre COMO o sistema calcula, metrifica ou classifica algo. Inclui: "como chegou a essa conclusão", "como vc metrifica", "qual prazo usou", "que critérios usa", "por que classificou assim", "como calcula", "o que considera", "quais são os possíveis motivos", "como funciona o cálculo", "me explique a regra", "qual a lógica", "como é definido"
- CONCEITUAL: o que significa algo, me explique um conceito, o que é algo (quando NÃO está perguntando sobre como o sistema calcula)
- SAUDACAO: oi, olá, bom dia, obrigado
- AD_HOC: qualquer outra pergunta que não se encaixa acima

REGRAS:
- Se a pergunta é sobre UM cliente e pede resumo/performance → RESUMO_CLIENTE
- Se pergunta "como chegou a isso", "como calcula", "como metrifica", "qual prazo", "que critérios", "quais motivos considera", "como classifica" → METODOLOGIA
- Se pergunta sobre a DEFINIÇÃO de um conceito ("o que é SLA?") → CONCEITUAL
- METODOLOGIA tem prioridade sobre CONCEITUAL quando o usuário questiona a lógica de cálculo
${contextoHistorico}

PERGUNTA: "${prompt}"

CATEGORIA:`;
    try {
      const resp = await chamarGemini(apiKey, p, { temperature: 0.1, maxTokens: 50 });
      const cat = resp.trim().replace(/[^A-Z_]/g, '');
      const validas = ['RESUMO_CLIENTE','RESUMO_GERAL','EVOLUCAO_DIARIA','TOP_PROFISSIONAIS','TOP_CLIENTES',
        'PRAZO_PROFISSIONAL','ATRASO_MOTIVOS','RETORNOS','FINANCEIRO','COMPARATIVO','FROTA',
        'HORARIO_PICO','BAIRRO_CIDADE','METODOLOGIA','CONCEITUAL','SAUDACAO','AD_HOC'];
      if (validas.includes(cat)) { console.log(`🏷️ [Chat IA] Categoria: ${cat}`); return cat; }
      for (const v of validas) { if (resp.toUpperCase().includes(v)) { console.log(`🏷️ [Chat IA] Categoria (fallback): ${v}`); return v; } }
    } catch (e) { console.error('⚠️ [Chat IA] Erro classificador:', e.message); }
    console.log('🏷️ [Chat IA] Categoria: AD_HOC (fallback)');
    return 'AD_HOC';
  }

  // ==================== ETAPA 1: QUERIES DIRETAS (sem Gemini) ====================
  function montarFiltroSQL(codCliente, centroCusto, dataInicio, dataFim) {
    const conditions = [];
    const params = [];
    let idx = 1;

    // codCliente pode ser número/string ou array
    if (codCliente) {
      const clientes = Array.isArray(codCliente)
        ? codCliente.map(c => parseInt(c)).filter(c => !isNaN(c))
        : [parseInt(codCliente)].filter(c => !isNaN(c));

      if (clientes.length === 1) {
        conditions.push(`cod_cliente = $${idx++}`);
        params.push(clientes[0]);
      } else if (clientes.length > 1) {
        const placeholders = clientes.map((_, i) => `$${idx + i}`).join(', ');
        conditions.push(`cod_cliente IN (${placeholders})`);
        clientes.forEach(c => { params.push(c); idx++; });
      }
    }

    // centroCusto pode ser string ou array
    if (centroCusto) {
      const centros = Array.isArray(centroCusto)
        ? centroCusto.filter(c => c && c.trim())
        : [centroCusto].filter(c => c && c.trim());

      if (centros.length === 1) {
        conditions.push(`centro_custo = $${idx++}`);
        params.push(centros[0]);
      } else if (centros.length > 1) {
        const placeholders = centros.map((_, i) => `$${idx + i}`).join(', ');
        conditions.push(`centro_custo IN (${placeholders})`);
        centros.forEach(c => { params.push(c); idx++; });
      }
    }

    if (dataInicio && dataFim) {
      conditions.push(`data_solicitado BETWEEN $${idx++} AND $${idx++}`);
      params.push(dataInicio, dataFim);
    }
    return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
  }

  // Cada template retorna { rows, colunas, sql_descricao }
  const TEMPLATES = {
    RESUMO_CLIENTE: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT
        COUNT(*) as total_entregas,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio_min,
        COUNT(DISTINCT cod_prof) as total_motos,
        COUNT(DISTINCT data_solicitado) as dias_operados,
        ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT data_solicitado), 0), 1) as media_entregas_dia,
        ROUND(SUM(valor)::numeric, 2) as receita_bruta,
        ROUND(SUM(valor_prof)::numeric, 2) as custo_profissionais,
        ROUND((SUM(valor) - COALESCE(SUM(valor_prof), 0))::numeric, 2) as faturamento_liquido,
        ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%retorno%') as retornos,
        ROUND(100.0 * COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%retorno%') / NULLIF(COUNT(*), 0), 2) as taxa_retorno,
        ROUND(SUM(distancia)::numeric, 1) as km_total,
        ROUND(AVG(distancia)::numeric, 1) as km_medio
      FROM bi_entregas ${entregas_where}`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Resumo completo do cliente (query direta)' };
    },

    RESUMO_GERAL: async (filtros) => {
      const { where, params } = montarFiltroSQL(null, null, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT
        COUNT(*) as total_entregas,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio_min,
        COUNT(DISTINCT cod_prof) as total_motos,
        COUNT(DISTINCT cod_cliente) as total_clientes,
        COUNT(DISTINCT data_solicitado) as dias_operados,
        ROUND(SUM(valor)::numeric, 2) as receita_bruta,
        ROUND((SUM(valor) - COALESCE(SUM(valor_prof), 0))::numeric, 2) as faturamento_liquido,
        ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%') as retornos,
        ROUND(100.0 * COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%') / NULLIF(COUNT(*), 0), 2) as taxa_retorno
      FROM bi_entregas ${entregas_where}`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Resumo geral (query direta)' };
    },

    EVOLUCAO_DIARIA: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT data_solicitado as dia, COUNT(*) as entregas, COUNT(DISTINCT cod_prof) as motos,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
        ROUND(SUM(valor)::numeric, 2) as receita,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%') as retornos
      FROM bi_entregas ${entregas_where} GROUP BY data_solicitado ORDER BY data_solicitado LIMIT 60`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Evolução diária (query direta)' };
    },

    TOP_PROFISSIONAIS: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT cod_prof, nome_prof, COUNT(*) as entregas,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
        COUNT(DISTINCT data_solicitado) as dias_rodou,
        ROUND(SUM(distancia)::numeric, 1) as km_total
      FROM bi_entregas ${entregas_where} AND cod_prof IS NOT NULL
      GROUP BY cod_prof, nome_prof HAVING COUNT(*) >= 5 ORDER BY entregas DESC LIMIT 20`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Top profissionais (query direta)' };
    },

    TOP_CLIENTES: async (filtros) => {
      const { where, params } = montarFiltroSQL(null, null, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT cod_cliente, nome_fantasia, COUNT(*) as entregas,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
        ROUND(SUM(valor)::numeric, 2) as receita,
        COUNT(DISTINCT cod_prof) as motos
      FROM bi_entregas ${entregas_where}
      GROUP BY cod_cliente, nome_fantasia ORDER BY entregas DESC LIMIT 20`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Top clientes por volume (query direta)' };
    },

    PRAZO_PROFISSIONAL: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT cod_prof, nome_prof, COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as no_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio
      FROM bi_entregas ${entregas_where} AND cod_prof IS NOT NULL
      GROUP BY cod_prof, nome_prof ORDER BY total_entregas DESC LIMIT 30`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Prazo por profissional (query direta)' };
    },

    ATRASO_MOTIVOS: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `WITH atrasos AS (
        SELECT os, cod_prof, nome_prof,
          EXTRACT(EPOCH FROM (finalizado - data_hora))/60 as sla_total,
          EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 as tempo_alocacao,
          tempo_execucao_minutos
        FROM bi_entregas ${entregas_where} AND dentro_prazo = false AND finalizado IS NOT NULL AND data_hora IS NOT NULL
      )
      SELECT CASE
          WHEN sla_total > 600 AND tempo_alocacao > 300 THEN 'Falha sistêmica'
          WHEN sla_total > 600 THEN 'OS não encerrada'
          WHEN tempo_alocacao > 30 THEN 'Associado tarde'
          WHEN tempo_execucao_minutos > 0 AND sla_total > 0 AND (sla_total - tempo_alocacao - tempo_execucao_minutos) > 45 THEN 'Coleta lenta'
          ELSE 'Atraso do motoboy'
        END as motivo,
        COUNT(*) as quantidade,
        ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER(), 0), 1) as percentual
      FROM atrasos GROUP BY motivo ORDER BY quantidade DESC`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Motivos de atraso (query direta)' };
    },

    RETORNOS: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%') as cliente_fechado,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%') as cliente_ausente,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%loja fechada%') as loja_fechada,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%produto incorreto%') as produto_incorreto,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%') as retorno_generico,
        COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') as total_retornos,
        ROUND(100.0 * COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') / NULLIF(COUNT(*), 0), 2) as taxa_retorno
      FROM bi_entregas ${entregas_where}`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Análise de retornos (query direta)' };
    },

    FINANCEIRO: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT
        COUNT(*) as total_entregas,
        ROUND(SUM(valor)::numeric, 2) as receita_bruta,
        ROUND(SUM(valor_prof)::numeric, 2) as custo_profissionais,
        ROUND((SUM(valor) - COALESCE(SUM(valor_prof), 0))::numeric, 2) as faturamento_liquido,
        ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio,
        ROUND(SUM(valor_prof)::numeric / NULLIF(COUNT(*), 0), 2) as custo_medio_por_entrega,
        ROUND(SUM(distancia)::numeric, 1) as km_total,
        ROUND(SUM(valor)::numeric / NULLIF(SUM(distancia)::numeric, 0), 2) as receita_por_km
      FROM bi_entregas ${entregas_where}`;
      const result = await pool.query(sql, params);
      // Buscar garantido se houver filtro de cliente
      let garantidoRows = [];
      const clientesFiltro = filtros.cod_cliente
        ? (Array.isArray(filtros.cod_cliente) ? filtros.cod_cliente : [filtros.cod_cliente]).map(c => String(c))
        : [];
      if (clientesFiltro.length > 0) {
        try {
          const gParams = [...clientesFiltro];
          const placeholders = gParams.map((_, i) => `$${i + 1}`).join(', ');
          let gWhere = `WHERE cod_cliente IN (${placeholders})`;
          let idx = gParams.length + 1;
          if (filtros.data_inicio && filtros.data_fim) { gWhere += ` AND data BETWEEN $${idx++} AND $${idx++}`; gParams.push(filtros.data_inicio, filtros.data_fim); }
          const g = await pool.query(`SELECT SUM(complemento)::numeric as custo_garantido, SUM(valor_negociado)::numeric as total_negociado, COUNT(*) as registros FROM bi_garantido_cache ${gWhere}`, gParams);
          garantidoRows = g.rows;
        } catch (e) { /* tabela pode não existir ainda */ }
      }
      return { rows: [...result.rows, ...(garantidoRows.length && garantidoRows[0].registros > 0 ? [{ _tipo: 'garantido', ...garantidoRows[0] }] : [])], sql_descricao: 'Análise financeira (query direta)' };
    },

    COMPARATIVO: async (filtros) => {
      const { where, params } = montarFiltroSQL(null, null, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `WITH media_geral AS (
        SELECT
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo_geral,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio_geral,
          ROUND(SUM(valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio_geral
        FROM bi_entregas ${entregas_where}
      )
      SELECT e.cod_cliente, e.nome_fantasia, COUNT(*) as entregas,
        ROUND(100.0 * COUNT(*) FILTER (WHERE e.dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE e.dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
        mg.taxa_prazo_geral,
        ROUND(AVG(e.tempo_execucao_minutos)::numeric, 1) as tempo_medio, mg.tempo_medio_geral,
        ROUND(SUM(e.valor)::numeric / NULLIF(COUNT(*), 0), 2) as ticket_medio, mg.ticket_medio_geral
      FROM bi_entregas e, media_geral mg ${entregas_where ? entregas_where.replace('WHERE', 'WHERE COALESCE(e.ponto, 1) >= 2 AND') : 'WHERE COALESCE(e.ponto, 1) >= 2'}
      GROUP BY e.cod_cliente, e.nome_fantasia, mg.taxa_prazo_geral, mg.tempo_medio_geral, mg.ticket_medio_geral
      ORDER BY entregas DESC LIMIT 20`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Comparativo clientes vs média geral (query direta)' };
    },

    FROTA: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT data_solicitado as dia, COUNT(*) as entregas,
        COUNT(DISTINCT cod_prof) as motos,
        ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 1) as entregas_por_moto
      FROM bi_entregas ${entregas_where} GROUP BY data_solicitado ORDER BY data_solicitado LIMIT 60`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Frota por dia (query direta)' };
    },

    HORARIO_PICO: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT EXTRACT(HOUR FROM data_hora) as hora, COUNT(*) as entregas,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo
      FROM bi_entregas ${entregas_where} AND data_hora IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM data_hora) ORDER BY hora`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Distribuição por hora (query direta)' };
    },

    BAIRRO_CIDADE: async (filtros) => {
      const { where, params } = montarFiltroSQL(filtros.cod_cliente, filtros.centro_custo, filtros.data_inicio, filtros.data_fim);
      const entregas_where = where ? where + ' AND COALESCE(ponto, 1) >= 2' : 'WHERE COALESCE(ponto, 1) >= 2';
      const sql = `SELECT COALESCE(bairro, 'Sem bairro') as bairro, cidade, COUNT(*) as entregas,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio
      FROM bi_entregas ${entregas_where} GROUP BY bairro, cidade ORDER BY entregas DESC LIMIT 30`;
      const result = await pool.query(sql, params);
      return { rows: result.rows, sql_descricao: 'Entregas por bairro/cidade (query direta)' };
    }
  };

  // ==================== KNOWLEDGE BASE: Regras de Negócio da Tutts ====================
  const KNOWLEDGE_BASE = `
## 1. SISTEMA DE PRAZOS (SLA)

### Como o prazo é definido:
O prazo de cada entrega é calculado com base na DISTÂNCIA (km) do ponto de entrega. Existem 3 níveis de configuração:
1. **Prazo por cliente específico**: Se o cliente tem faixas de prazo configuradas, usa essas.
2. **Prazo por centro de custo**: Se não tem prazo por cliente, busca pelo centro de custo.
3. **Prazo padrão (regras DAX)**: Se não tem nenhuma configuração específica, usa a tabela padrão:
   - 0-10km → 60min | 10-15km → 75min | 15-20km → 90min | 20-25km → 105min
   - 25-30km → 120min | 30-35km → 135min | 35-40km → 150min | 40-45km → 165min
   - 45-50km → 180min | 50-55km → 195min | 55-60km → 210min | 60-65km → 225min
   - 65-70km → 240min | 70-75km → 255min | 75-80km → 270min | 80-85km → 285min
   - 85-90km → 300min | 90-95km → 315min | 95-100km → 330min | >100km → Sempre fora do prazo

### Exceção - Cliente 767 (Comollati):
- SLA fixo de 120 minutos independente da distância
- Meta mínima: 95% no prazo (abaixo disso é CRÍTICO)

### Como "dentro do prazo" é calculado:
- **Tempo de execução** = tempo entre a criação da OS (data_hora) e a finalização (finalizado)
- Se o campo execucao_comp (execução complementar) existir, usa ele prioritariamente
- **dentro_prazo = true** quando tempo_execucao_minutos ≤ prazo_minutos
- Esse cálculo é feito no momento do upload do Excel e armazenado no banco

### Prazo do Profissional (segundo prazo):
- Mede o tempo do MOTOBOY especificamente: de data_hora_alocado (quando foi alocado) até finalizado
- Configuração análoga (por cliente, centro de custo ou padrão profissional)
- Fallback profissional: 60 minutos para qualquer distância
- Salvo em dentro_prazo_prof e tempo_entrega_prof_minutos

### Taxa de prazo:
- Fórmula: (entregas dentro do prazo / entregas com prazo calculado) × 100
- Entregas sem prazo calculado (prazo_minutos = NULL) são ignoradas no cálculo
- Meta geral: ≥ 85%. Meta Comollati: ≥ 95%.

## 2. CLASSIFICAÇÃO DE MOTIVOS DE ATRASO

Quando uma entrega está FORA do prazo (dentro_prazo = false), classificamos o MOTIVO automaticamente com base nos tempos:

### Tempos utilizados no cálculo:
- **SLA total** = (finalizado - data_hora) convertido em minutos. É o tempo total desde a criação da OS até ser finalizada.
- **Tempo de alocação** = (data_hora_alocado - data_hora) convertido em minutos. É quanto tempo a mesa de operações levou para alocar um motoboy à OS.
- **Tempo de execução** = campo tempo_execucao_minutos (calculado no upload a partir do campo execucao_comp, ou se vazio, pela diferença data_hora→finalizado). Representa o tempo efetivo de trabalho do motoboy.
- **Tempo residual** = sla_total - tempo_alocacao - tempo_execucao. É o tempo "sobrando" que não é nem alocação nem execução — na prática, é o tempo que o motoboy ficou ESPERANDO na loja do cliente para coletar a mercadoria.

### Classificação (nesta ORDEM DE PRIORIDADE — a ordem importa, o sistema checa de cima pra baixo e para na primeira que bater):
1. **Falha sistêmica** (🔴): Condição: sla_total > 600min (10h) E tempo_alocacao > 300min (5h). OS ficou "perdida" no sistema — nem alocaram nem finalizaram por horas. É uma anomalia grave.
2. **OS não encerrada** (🔴): Condição: sla_total > 600min (10h), MAS a alocação foi normal (≤ 5h). O motoboy foi alocado normalmente, entregou, mas esqueceu de finalizar a OS no app. O SLA parece enorme mas a entrega real provavelmente aconteceu no prazo.
3. **Associado tarde** (🟠): Condição: tempo_alocacao > 30min. A mesa de operações demorou mais de 30 minutos para alocar um motoboy à OS. Isso é problema NOSSO (operação interna). O motoboy pode até ter sido rápido, mas o atraso na alocação comprometeu o SLA.
4. **Coleta lenta** (🟡): Condição: tempo_residual > 45min, ou seja: (sla_total - tempo_alocacao - tempo_execucao) > 45. Esse tempo residual é o tempo que sobrou — na prática, é o tempo que o motoboy ficou esperando no ponto de coleta (loja do cliente). Se ultrapassa 45min, significa que a loja do CLIENTE demorou para separar/liberar a mercadoria. É problema do CLIENTE, não do motoboy nem da Tutts.
5. **Atraso do motoboy** (🟠): Condição: nenhuma das anteriores. O atraso é do deslocamento/entrega em si — pode ser trânsito pesado, rota ruim, distância longa, ou o motoboy foi lento. É o "fallback" quando nenhuma causa específica é identificada.

### Importante:
- "Associado tarde" é problema INTERNO (da Tutts — nossa mesa de operações demorou)
- "Coleta lenta" é problema do CLIENTE (a loja demorou para liberar)
- "Atraso do motoboy" pode ser trânsito, rota, ou performance individual do motoboy
- "Falha sistêmica" e "OS não encerrada" são anomalias operacionais (geralmente não refletem atraso real)

## 3. RETORNOS E OCORRÊNCIAS

### O que é um retorno:
Uma entrega onde o motoboy NÃO conseguiu entregar. Identificado pelo campo ocorrencia da bi_entregas.

### Tipos de retorno reconhecidos:
- **Cliente Fechado**: Estabelecimento estava fechado quando o motoboy chegou
- **Cliente Ausente / ClienteAus**: Ninguém no local para receber
- **Loja Fechada**: O ponto de coleta estava fechado
- **Produto Incorreto**: Produto errado, motoboy devolveu
- **Retorno** (genérico): Outros motivos de retorno

### Referências de taxa de retorno:
- Até **2%**: 🟢 SAUDÁVEL — operação normal
- **2% a 5%**: 🟡 ATENÇÃO — monitorar causas
- Acima de **5%**: 🔴 PREOCUPANTE — ação imediata necessária

### Como é calculado:
- Total de retornos = entregas cujo campo ocorrencia contém os termos acima
- Taxa = (total retornos / total entregas) × 100
- Somente entregas (ponto ≥ 2), exclui coletas (ponto 1)

## 4. FINANCEIRO

### Conceitos:
- **Receita bruta** = SUM(valor) — total cobrado do cliente
- **Custo profissionais** = SUM(valor_prof) — total pago aos motoboys
- **Faturamento líquido** = receita bruta - custo profissionais
- **Ticket médio** = receita bruta / total de entregas
- **Custo por entrega** = custo profissionais / total de entregas

### Mínimo Garantido:
- Acordo diário com motoboy: se ele produzir menos que o valor negociado, a Tutts paga a diferença
- **Valor negociado**: quanto foi acordado por dia
- **Valor produzido**: quanto o motoboy realmente faturou naquele dia (soma de valor_prof das OS)
- **Complemento**: MAX(0, valor_negociado - valor_produzido) — é o CUSTO do garantido
- **Status**: "acima" (produziu mais), "abaixo" (Tutts pagou diferença), "nao_rodou" (não trabalhou, Tutts paga tudo)
- Dados ficam na tabela bi_garantido_cache (sincronizada da planilha)

## 5. FROTA E DIMENSIONAMENTO

- **Motos por dia** = COUNT(DISTINCT cod_prof) — motoboys únicos que operaram no dia
- **Entregas por moto** = total entregas / motos por dia
- Média ideal: **10 entregas/moto/dia**
- Abaixo de 8: sub-utilização (mais motos que o necessário)
- Acima de 15: sobre-utilização (risco de atraso)

## 6. FILTROS E DADOS

### Estrutura de dados:
- Tabela principal: bi_entregas. Cada linha = um PONTO de uma OS.
- **Ponto 1** = COLETA (onde o motoboy pega o pacote). **Ponto ≥ 2** = ENTREGAS.
- SEMPRE filtramos ponto ≥ 2 para métricas de entrega. Coletas são excluídas.
- OS pode ter vários pontos (uma coleta e múltiplas entregas)

### Filtros aplicados:
- **cod_cliente**: filtra por cliente específico
- **centro_custo**: filtra por filial/unidade do cliente  
- **data_solicitado**: período das entregas
- O campo data_solicitado é a data da OS (quando foi criada/solicitada)

## 7. DETRATORES

- **Detrator de prazo**: Profissional com 3 ou mais OS atrasadas no período
- São os motoboys que mais impactam negativamente a taxa de prazo
- Ação: treinar, acompanhar rotas, ou avaliar continuidade

## 8. SAQUES (withdrawal_requests)

- Motoboys solicitam saques que passam por aprovação
- Status: aguardando_aprovacao → aprovado/rejeitado
- Status aprovado_gratuidade = saque de gratuidade (bonificação do Score)
- NÃO confundir com mínimo garantido (que é bi_garantido_cache)`;

  // ==================== PROMPT METODOLOGIA ====================
  function getPromptMetodologia(prompt, contextoFiltros, historico) {
    let contextoAnterior = '';
    if (historico?.length > 0) {
      const lastN = historico.slice(-3); // últimas 3 interações
      contextoAnterior = '\n## CONVERSA ANTERIOR (para contexto):\n';
      for (const h of lastN) {
        if (h.prompt) contextoAnterior += `👤 Usuário: "${h.prompt.substring(0, 200)}"\n`;
        if (h.resposta) contextoAnterior += `🤖 Chat: "${h.resposta.substring(0, 400)}"\n\n`;
      }
    }

    return `Você é o assistente de dados do BI da Tutts (logística de entregas com motoboys).
O usuário está perguntando sobre COMO o sistema calcula, metrifica ou classifica algo.

Responda a pergunta EXPLICANDO A REGRA DE NEGÓCIO exata que o sistema usa.
${contextoAnterior}
## PERGUNTA ATUAL: "${prompt}"
${contextoFiltros ? `\nContexto: ${contextoFiltros}` : ''}

${KNOWLEDGE_BASE}

## REGRAS DE RESPOSTA:
- Responda COM DETALHES TÉCNICOS — o usuário quer saber EXATAMENTE como funciona
- Se a pergunta é "como chegou a essa conclusão?", olhe o CONTEXTO da conversa anterior e explique a regra que gerou aquele resultado
- Se a pergunta é "qual prazo usou?", explique o sistema de faixas de KM e qual se aplica
- Se a pergunta é "quais motivos considera?", liste TODOS os motivos com os critérios exatos (minutos, thresholds)
- Use exemplos concretos: "Se a distância é 12km, o prazo é 75 minutos (faixa 10-15km)"
- Formato: bullets com **negrito** nos valores. Use emojis.
- Fale como funcionário da Tutts: "nós", "nosso sistema"
- ⛔ NUNCA sugira aumentar contato com cliente`;
  }

  // ==================== PROMPT CONCEITUAL ====================
  function getPromptConceitual(prompt, contextoFiltros, historico) {
    let contextoAnterior = '';
    if (historico?.length > 0) {
      const last = historico[historico.length - 1];
      if (last.prompt) contextoAnterior = `\nConversa anterior - Pergunta: "${last.prompt.substring(0, 200)}"\nResposta: "${last.resposta?.substring(0, 300) || ''}"`;
    }

    return `Você é um profissional sênior do time operacional da Tutts (logística de entregas com motoboys).

Responda a pergunta do usuário:
"${prompt}"
${contextoFiltros ? `\nContexto: ${contextoFiltros}` : ''}
${contextoAnterior}

${KNOWLEDGE_BASE}

## REGRAS:
- Fale como funcionário da Tutts: "nós", "nossa operação"
- Seja objetivo e claro, use emojis e markdown
- ⛔ NUNCA sugira aumentar contato com cliente`;
  }

  // ==================== PROMPT DE ANÁLISE (dinâmico por categoria) ====================
  function getPromptAnalise(categoria, prompt, contextoFiltros, dados, sqlDescricao) {
    const linhas = dados.length > 100 ? dados.slice(0, 100) : dados;
    const colunas = linhas.length > 0 ? Object.keys(linhas[0]) : [];

    const regrasBase = `Analise os dados REAIS abaixo e responda a pergunta do usuário.

## IDENTIDADE
- Você É funcionário da Tutts. Use "nós", "nossa operação".
- ⛔ NUNCA fale como consultor externo. NUNCA sugira aumentar contato com cliente.
- Sugestões devem ser sobre melhorias INTERNAS.

## PERGUNTA: "${prompt}"
${contextoFiltros ? `\n## CONTEXTO: ${contextoFiltros}` : ''}

## DADOS (${linhas.length} registros · ${sqlDescricao})
\`\`\`json
${JSON.stringify(linhas, null, 2).substring(0, 15000)}
\`\`\`

## FORMATO
- ⛔ PROIBIDO tabelas markdown (| --- |). Use bullet points.
- Destaque números com **negrito**.
- Emojis: 🟢 Bom (≥80%) · 🟡 Atenção (50-79%) · 🔴 Crítico (<50%)
- Valores: R$ 1.234,56 | Tempos: Xh XXmin se >60min | Taxas: 1 decimal
- ⛔ NUNCA inclua blocos SQL. ⛔ NUNCA invente dados.
- ⛔ NUNCA inclua sugestões de perguntas no final (como "Quer se aprofundar?" ou "Pergunte-me:"). Termine a análise de forma direta.
- Se resultado vazio, diga claramente.`;

    const regrasEspecificas = {
      RESUMO_CLIENTE: `\n## REGRAS ESPECÍFICAS\n- Faturamento líquido = receita_bruta - custo_profissionais. NUNCA apresente receita_bruta como faturamento.\n- Inclua TODOS os KPIs: entregas, taxa prazo, tempo médio, motos, faturamento líquido, ticket médio, taxa retorno.\n- Classifique cada KPI com emoji.\n- Cliente 767 (Comollati): mínimo 95% no prazo.\n- Taxa retorno: até 2% SAUDÁVEL, 2-5% ATENÇÃO, >5% PREOCUPANTE.`,
      RESUMO_GERAL: `\n## REGRAS ESPECÍFICAS\n- Visão geral da operação com todos os KPIs.\n- Faturamento líquido = receita_bruta - custo_profissionais.`,
      EVOLUCAO_DIARIA: `\n## REGRAS ESPECÍFICAS\n- Identifique tendências (crescimento, queda, estabilidade).\n- Destaque dias com pico ou queda.\n- Sempre mencione motos por dia.`,
      TOP_PROFISSIONAIS: `\n## REGRAS ESPECÍFICAS\n- Formato ranking: - **Nome (cod):** X entregas · Y% prazo · Zmin tempo médio\n- Destaque top 3 e piores 3 se houver.\n- Detrator = 3+ OS atrasadas.`,
      PRAZO_PROFISSIONAL: `\n## REGRAS ESPECÍFICAS\n- Mostre entregas no prazo e fora do prazo de cada motoboy.\n- Formato: - **Nome:** X entregas · Y no prazo · Z fora · W% taxa\n- Classifique: 🟢 ≥90% · 🟡 75-89% · 🔴 <75%`,
      ATRASO_MOTIVOS: `\n## REGRAS ESPECÍFICAS\n- EXPLIQUE cada motivo quando mencioná-lo.\n- "Associado tarde" = problema nosso. "Coleta lenta" = problema do cliente.\n- Severidade: 🔴 ≥6% | 🟠 5-6% | 🟡 3-5% | 🟢 <3%`,
      RETORNOS: `\n## REGRAS ESPECÍFICAS\n- SEMPRE informe referência: até 2% SAUDÁVEL | 2-5% ATENÇÃO | >5% PREOCUPANTE.\n- Detalhe por tipo (Cliente Fechado, Ausente, Loja Fechada, etc).`,
      FINANCEIRO: `\n## REGRAS ESPECÍFICAS\n- FATURAMENTO LÍQUIDO = receita_bruta - custo_profissionais. NUNCA apresente receita como faturamento.\n- Se houver dados de garantido (_tipo='garantido'), inclua custo com garantido.\n- Variação > 5% → destaque com ↑ ou ↓.`,
      COMPARATIVO: `\n## REGRAS ESPECÍFICAS\n- Compare cada cliente com a média geral.\n- Use ↑ e ↓ para variações vs média.\n- Se variação < 3%, diga estável.`,
      FROTA: `\n## REGRAS ESPECÍFICAS\n- Motos = motoboys distintos. Média ideal: 10 entregas/moto/dia.\n- Destaque dias com sub/super utilização.`,
      HORARIO_PICO: `\n## REGRAS ESPECÍFICAS\n- Identifique horário de pico e vale.\n- Sugira otimizações de alocação nos horários críticos.`,
      BAIRRO_CIDADE: `\n## REGRAS ESPECÍFICAS\n- Destaque bairros com mais volume e piores taxas de prazo.\n- Identifique regiões problemáticas.`
    };

    const graficos = `\n## GRÁFICOS\nQuando dados beneficiarem de visualização:\n[CHART]\n{"type":"bar","title":"Título","labels":["A","B"],"datasets":[{"label":"Série","data":[10,20],"color":"#10b981"}]}\n[/CHART]\nTipos: "bar", "horizontalBar", "line", "pie", "doughnut". Máx 2 gráficos.`;

    const proatividade = ``;

    return regrasBase + (regrasEspecificas[categoria] || '') + graficos + proatividade;
  }

  // ==================== FALLBACK: Geração SQL pelo Gemini ====================
  function getPromptSQLFallback(schemaTexto, samplesTexto, contextoFiltros, filtroSQLObrigatorio) {
    return `You are a PostgreSQL SQL expert. Generate ONLY valid PostgreSQL queries.

⚠️ Your ENTIRE response must be ONLY a \`\`\`sql ... \`\`\` block. Nothing else.
⚠️ SQL MUST use ENGLISH keywords (SELECT, FROM, WHERE, WITH, COUNT, ROUND, AVG, SUM). NEVER Portuguese.
⚠️ ONLY use tables from the SCHEMA below. NEVER invent table names.

📊 SCHEMA:
${schemaTexto}
${samplesTexto}

RULES:
1. ALWAYS filter deliveries: WHERE COALESCE(ponto, 1) >= 2
2. ALWAYS add LIMIT (max 500)
3. ALWAYS protect division with NULLIF(x, 0)
4. Use COUNT(*) FILTER (WHERE ...) instead of SUM(CASE WHEN)
5. For prazo: ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2)
6. Use nome_fantasia for client display
7. Faturamento líquido = SUM(valor) - SUM(valor_prof). NEVER use SUM(valor) alone as faturamento.
8. For returns: LOWER(ocorrencia) LIKE '%cliente fechado%' OR LIKE '%clienteaus%' OR LIKE '%retorno%'
${contextoFiltros ? `\nACTIVE FILTERS (mandatory): ${contextoFiltros}\nAll queries MUST include: ${filtroSQLObrigatorio}` : ''}`;
  }

  async function executarComRetry(sql, filtroSQLObrigatorio, prompt, apiKey, tentativa = 1) {
    const sqlPV = posValidarSQL(sql, filtroSQLObrigatorio);
    const v = validarSQL(sqlPV);
    if (!v.valido) { console.error(`❌ [Chat IA] SQL bloqueado: ${v.erro}`); return null; }
    try {
      await pool.query('SET statement_timeout = 15000');
      const result = await pool.query(v.sql);
      await pool.query('SET statement_timeout = 0');
      return { result, sql: v.sql };
    } catch (sqlError) {
      await pool.query('SET statement_timeout = 0').catch(() => {});
      console.error(`❌ [Chat IA] Erro SQL (${tentativa}/3):`, sqlError.message);
      if (tentativa >= 3) return null;
      try {
        const retryText = await chamarGemini(apiKey,
          `Fix this PostgreSQL query. Return ONLY the corrected SQL in a \`\`\`sql\`\`\` block.

ORIGINAL QUESTION: "${prompt}"
ERROR: ${sqlError.message}
QUERY:\n\`\`\`sql\n${v.sql}\n\`\`\`

RULES: Keep same logic. Fix only the error. Use NULLIF for divisions. Use COALESCE(ponto,1)>=2. Add LIMIT.`,
          { temperature: 0.1, maxTokens: 2000 });
        const m = retryText.match(/```sql\n?([\s\S]*?)\n?```/);
        if (m) return await executarComRetry(m[1].trim(), filtroSQLObrigatorio, prompt, apiKey, tentativa + 1);
      } catch (e) { console.error('❌ [Chat IA] Retry falhou:', e.message); }
      return null;
    }
  }

  // ==================== ENDPOINT PRINCIPAL ====================
  router.post('/bi/chat-ia', async (req, res) => {
    try {
      const { prompt, historico, filtros } = req.body;
      if (!prompt || prompt.trim().length < 3) return res.status(400).json({ error: 'Prompt deve ter pelo menos 3 caracteres.' });

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY não configurada.' });

      console.log(`🤖 [Chat IA] Prompt: "${prompt.substring(0, 100)}..."`);

      // Suporte a múltiplos clientes e centros de custo
      // cod_cliente pode ser: número, string, ou array de números/strings
      // centro_custo pode ser: string ou array de strings
      const rawCliente = filtros?.cod_cliente || null;
      const rawCentro = filtros?.centro_custo || null;
      const dataInicio = filtros?.data_inicio || null;
      const dataFim = filtros?.data_fim || null;
      const nomeCliente = filtros?.nome_fantasia || null;

      // Normalizar para arrays
      const codClientes = rawCliente
        ? (Array.isArray(rawCliente) ? rawCliente : [rawCliente]).map(c => parseInt(c)).filter(c => !isNaN(c))
        : [];
      const centrosCusto = rawCentro
        ? (Array.isArray(rawCentro) ? rawCentro : [rawCentro]).filter(c => c && c.trim())
        : [];

      let contextoFiltros = '';
      let filtroSQLObrigatorio = '';

      if (codClientes.length === 1) {
        contextoFiltros += `\n🔹 CLIENTE: ${nomeCliente || 'cod ' + codClientes[0]} (cod_cliente = ${codClientes[0]})`;
        filtroSQLObrigatorio += ` AND cod_cliente = ${codClientes[0]}`;
      } else if (codClientes.length > 1) {
        const nomes = filtros?.nomes_clientes || codClientes.map(c => 'cod ' + c).join(', ');
        contextoFiltros += `\n🔹 CLIENTES (${codClientes.length}): ${nomes}`;
        filtroSQLObrigatorio += ` AND cod_cliente IN (${codClientes.join(',')})`;
      }

      if (centrosCusto.length === 1) {
        contextoFiltros += `\n🔹 CENTRO DE CUSTO: ${centrosCusto[0]}`;
        filtroSQLObrigatorio += ` AND centro_custo = '${centrosCusto[0].replace(/'/g, "''")}'`;
      } else if (centrosCusto.length > 1) {
        contextoFiltros += `\n🔹 CENTROS DE CUSTO (${centrosCusto.length}): ${centrosCusto.join(', ')}`;
        filtroSQLObrigatorio += ` AND centro_custo IN (${centrosCusto.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`;
      }

      if (dataInicio && dataFim) {
        contextoFiltros += `\n🔹 PERÍODO: ${dataInicio} até ${dataFim}`;
        filtroSQLObrigatorio += ` AND data_solicitado BETWEEN '${dataInicio}' AND '${dataFim}'`;
      }

      // Cache check
      limparCacheExpirado();
      const cacheKey = normalizarPergunta(prompt, filtros);
      if (queryResponseCache.has(cacheKey)) {
        const cached = queryResponseCache.get(cacheKey);
        if (Date.now() - cached.timestamp < QUERY_CACHE_TTL) {
          console.log('⚡ [Chat IA] Cache hit!');
          return res.json(cached.response);
        }
      }

      // ========== ETAPA 0: Classificar ==========
      const categoria = await classificarIntencao(prompt, GEMINI_API_KEY, historico);

      // ========== SAUDAÇÃO ==========
      if (categoria === 'SAUDACAO') {
        return res.json({ success: true, resposta: '👋 Olá! Sou o assistente de dados da Tutts. Pergunte sobre entregas, prazos, profissionais, financeiro, retornos ou qualquer outra métrica. Posso também explicar conceitos — é só perguntar!', sql: null, dados: null });
      }

      // ========== CONCEITUAL ==========
      if (categoria === 'CONCEITUAL') {
        console.log('📚 [Chat IA] Conceitual — sem SQL');
        try {
          const resp = await chamarGemini(GEMINI_API_KEY, getPromptConceitual(prompt, contextoFiltros, historico), { temperature: 0.5, maxTokens: 3000 });
          if (resp) {
            const r = { success: true, resposta: resp, sql: null, dados: null };
            queryResponseCache.set(cacheKey, { response: r, timestamp: Date.now() });
            return res.json(r);
          }
        } catch (e) { console.error('❌ [Chat IA] Erro conceitual:', e.message); }
      }

      // ========== METODOLOGIA (regras de negócio, como calcula, como metrifica) ==========
      if (categoria === 'METODOLOGIA') {
        console.log('📖 [Chat IA] Metodologia — explicando regra de negócio');
        try {
          const resp = await chamarGemini(GEMINI_API_KEY, getPromptMetodologia(prompt, contextoFiltros, historico), { temperature: 0.5, maxTokens: 4000 });
          if (resp) {
            const r = { success: true, resposta: resp, sql: null, dados: null };
            queryResponseCache.set(cacheKey, { response: r, timestamp: Date.now() });
            return res.json(r);
          }
        } catch (e) { console.error('❌ [Chat IA] Erro metodologia:', e.message); }
      }

      // ========== ETAPA 1: Tentar query direta (template) ==========
      let dadosDirectos = null;
      let sqlDescricao = null;
      const templateFn = TEMPLATES[categoria];

      if (templateFn) {
        try {
          console.log(`📊 [Chat IA] Executando template: ${categoria}`);
          const resultado = await templateFn(filtros || {});
          if (resultado.rows && resultado.rows.length > 0) {
            dadosDirectos = resultado.rows;
            sqlDescricao = resultado.sql_descricao;
            console.log(`✅ [Chat IA] Template ${categoria}: ${dadosDirectos.length} registros`);
          } else {
            console.log(`⚠️ [Chat IA] Template ${categoria}: 0 registros`);
          }
        } catch (templateErr) {
          console.error(`❌ [Chat IA] Erro template ${categoria}:`, templateErr.message);
        }
      }

      // ========== Se template funcionou → Etapa 2: Análise ==========
      if (dadosDirectos && dadosDirectos.length > 0) {
        console.log('🤖 [Chat IA] Chamando Gemini (análise dos dados diretos)...');
        const promptAnalise = getPromptAnalise(categoria, prompt, contextoFiltros, dadosDirectos, sqlDescricao);
        try {
          const analise = await chamarGemini(GEMINI_API_KEY, promptAnalise, { temperature: 0.7, maxTokens: 4096 });
          const resp = {
            success: true,
            resposta: analise || 'Dados encontrados mas não foi possível gerar análise.',
            sql: sqlDescricao,
            dados: { colunas: Object.keys(dadosDirectos[0] || {}), linhas: dadosDirectos.slice(0, 100), total: dadosDirectos.length }
          };
          queryResponseCache.set(cacheKey, { response: resp, timestamp: Date.now() });
          console.log('✅ [Chat IA] Resposta via template + análise');
          return res.json(resp);
        } catch (analiseErr) {
          console.error('❌ [Chat IA] Erro análise:', analiseErr.message);
          const resp = {
            success: true,
            resposta: `Dados encontrados (${dadosDirectos.length} registros) mas houve erro na análise.`,
            sql: sqlDescricao,
            dados: { colunas: Object.keys(dadosDirectos[0] || {}), linhas: dadosDirectos.slice(0, 100), total: dadosDirectos.length }
          };
          return res.json(resp);
        }
      }

      // ========== FALLBACK: Gerar SQL pelo Gemini ==========
      console.log('🔄 [Chat IA] Fallback: gerando SQL pelo Gemini...');
      const [schema, samples] = await Promise.all([getSchema(), getSamples()]);
      const schemaTexto = formatarSchema(schema);
      const samplesTexto = formatarSamples(samples);

      const promptSQL = getPromptSQLFallback(schemaTexto, samplesTexto, contextoFiltros, filtroSQLObrigatorio);

      const mensagens = [];
      if (historico?.length > 0) {
        mensagens.push({ role: 'user', content: promptSQL + '\n\nUser question: ' + historico[0].prompt });
        if (historico[0].resposta) mensagens.push({ role: 'assistant', content: historico[0].resposta });
        for (let i = 1; i < historico.length; i++) {
          mensagens.push({ role: 'user', content: historico[i].prompt });
          if (historico[i].resposta) mensagens.push({ role: 'assistant', content: historico[i].resposta });
        }
        mensagens.push({ role: 'user', content: prompt });
      } else {
        mensagens.push({ role: 'user', content: promptSQL + '\n\nUser question: ' + prompt });
      }

      const geminiContents = mensagens.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const resposta1 = await chamarGemini(GEMINI_API_KEY, null, { temperature: 0.3, maxTokens: 4096, contents: geminiContents });

      // Extrair SQL
      const allSqlBlocks = [];
      const sqlBlockRegex = /```sql\n?([\s\S]*?)\n?```/g;
      let match;
      while ((match = sqlBlockRegex.exec(resposta1)) !== null) allSqlBlocks.push(match[1].trim());
      if (allSqlBlocks.length === 0) {
        const selectMatch = resposta1.match(/((?:WITH|SELECT)[\s\S]*?;)\s*$/im) || resposta1.match(/((?:WITH|SELECT)[\s\S]*?LIMIT\s+\d+)/im);
        if (selectMatch) allSqlBlocks.push(selectMatch[1].trim());
      }

      const queriesParaExecutar = [];
      for (const bloco of allSqlBlocks) {
        const partes = bloco.split(/;\s*/).filter(q => { const t = q.trim().toUpperCase(); return t.startsWith('SELECT') || t.startsWith('WITH'); });
        queriesParaExecutar.push(...partes.map(q => q.trim()));
      }

      if (queriesParaExecutar.length === 0) {
        // Último fallback: conceitual
        try {
          const resp = await chamarGemini(GEMINI_API_KEY, getPromptConceitual(prompt, contextoFiltros, historico), { temperature: 0.5, maxTokens: 3000 });
          if (resp) return res.json({ success: true, resposta: resp, sql: null, dados: null });
        } catch (e) {}
        return res.json({
          success: true,
          resposta: '⚠️ Não consegui processar essa pergunta. Tente reformular.\n\nExemplos:\n- "Qual o resumo de performance?"\n- "Top 10 motoboys por taxa de prazo"\n- "Motivos de atraso"\n- "Me explique o que é coleta lenta"',
          sql: null, dados: null
        });
      }

      // Executar queries
      const todosResultados = [];
      const todasColunas = new Set();
      const sqlsExecutadas = [];
      for (let i = 0; i < queriesParaExecutar.length; i++) {
        const resultado = await executarComRetry(queriesParaExecutar[i], filtroSQLObrigatorio, prompt, GEMINI_API_KEY);
        if (resultado) {
          resultado.result.rows.forEach(row => todosResultados.push(row));
          resultado.result.fields?.forEach(f => todasColunas.add(f.name));
          sqlsExecutadas.push(resultado.sql);
        }
      }

      if (todosResultados.length === 0) {
        return res.json({ success: true, resposta: '⚠️ Erro ao executar as queries. Tente reformular.', sql: queriesParaExecutar.join(';\n'), dados: null });
      }

      const linhas = todosResultados;
      const colunas = [...todasColunas];
      const sqlFinal = sqlsExecutadas.join(';\n\n');

      // Análise do fallback
      const dadosParaAnalise = linhas.length > 100 ? linhas.slice(0, 100) : linhas;
      const promptAnaliseFallback = getPromptAnalise('AD_HOC', prompt, contextoFiltros, dadosParaAnalise, `SQL gerado pelo Gemini`);

      let respostaFinal;
      try {
        respostaFinal = await chamarGemini(GEMINI_API_KEY, promptAnaliseFallback, { temperature: 0.7, maxTokens: 4096 });
      } catch (e) {
        respostaFinal = `Dados encontrados (${linhas.length} registros):`;
      }

      const resp = {
        success: true,
        resposta: respostaFinal || 'Não foi possível analisar.',
        sql: sqlFinal,
        dados: { colunas, linhas: dadosParaAnalise, total: linhas.length }
      };
      queryResponseCache.set(cacheKey, { response: resp, timestamp: Date.now() });
      return res.json(resp);

    } catch (err) {
      console.error('❌ [Chat IA] Erro geral:', err);
      res.status(500).json({ error: 'Erro interno no Chat IA: ' + err.message });
    }
  });

  // ==================== ENDPOINT: Filtros ====================
  router.get('/bi/chat-ia/filtros', async (req, res) => {
    try {
      // Buscar clientes com máscara aplicada
      const clientes = await pool.query(`
        SELECT DISTINCT e.cod_cliente, 
          COALESCE(m.mascara, e.nome_fantasia) as nome_fantasia
        FROM bi_entregas e
        LEFT JOIN bi_mascaras m ON m.cod_cliente = e.cod_cliente::text
        WHERE e.cod_cliente IS NOT NULL AND e.nome_fantasia IS NOT NULL AND e.nome_fantasia != ''
        ORDER BY nome_fantasia
      `);
      const centrosCusto = await pool.query(`SELECT DISTINCT centro_custo FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != '' ORDER BY centro_custo`);

      // Suporte a múltiplos clientes: ?cod_cliente=767&cod_cliente=949 ou ?cod_cliente=767,949
      let rawCodCliente = req.query.cod_cliente;
      let codClientes = [];
      if (rawCodCliente) {
        if (Array.isArray(rawCodCliente)) {
          codClientes = rawCodCliente.map(c => parseInt(c)).filter(c => !isNaN(c));
        } else {
          codClientes = String(rawCodCliente).split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
        }
      }

      let centrosDoCliente = [];
      if (codClientes.length > 0) {
        const placeholders = codClientes.map((_, i) => `$${i + 1}`).join(', ');
        const r = await pool.query(
          `SELECT DISTINCT centro_custo FROM bi_entregas WHERE cod_cliente IN (${placeholders}) AND centro_custo IS NOT NULL AND centro_custo != '' ORDER BY centro_custo`,
          codClientes
        );
        centrosDoCliente = r.rows.map(r => r.centro_custo);
      }
      res.json({ clientes: clientes.rows, centros_custo: centrosCusto.rows.map(r => r.centro_custo), centros_do_cliente: centrosDoCliente });
    } catch (err) {
      console.error('❌ Erro filtros:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== ENDPOINT: Schema (debug) ====================
  router.get('/bi/chat-ia/schema', async (req, res) => {
    try {
      const schema = await getSchema();
      res.json({ tabelas: Object.keys(schema).length, schema });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

module.exports = { createChatIaRoutes };
