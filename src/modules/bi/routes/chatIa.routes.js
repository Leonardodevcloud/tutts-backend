/**
 * BI Sub-Router: Chat IA — Analista de Dados Conversacional
 * v4.0 — Claude API (Anthropic)
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

  // ==================== CHAMAR CLAUDE ====================
  async function chamarClaude(messages, systemPrompt, opts = {}) {
    const { temperature = 0.4, maxTokens = 4096 } = opts;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada');

    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages
    };

    console.log(`📡 [Chat IA] Chamando Claude (${messages.length} msgs, temp=${temperature})...`);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ [Chat IA] Claude HTTP ${resp.status}:`, errText);
      throw new Error(`Claude API HTTP ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();
    if (data.error) {
      console.error(`❌ [Chat IA] Claude error:`, data.error);
      throw new Error(`Claude API: ${data.error.message}`);
    }

    const text = data.content
      ?.filter(b => b.type === 'text')
      ?.map(b => b.text)
      ?.join('\n') || '';

    console.log(`✅ [Chat IA] Claude respondeu (${text.length} chars, stop=${data.stop_reason})`);
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

    const tabelasUsadas = sqlLimpo.toUpperCase().match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'generate_series')
        return { valido: false, erro: `Tabela "${tabela}" não autorizada.` };
    }

    if (!sqlLimpo.toUpperCase().includes('LIMIT')) sqlLimpo += ' LIMIT 500';
    return { valido: true, sql: sqlLimpo };
  }

  async function executarSQL(sql) {
    const validacao = validarSQL(sql);
    if (!validacao.valido) return { success: false, erro: validacao.erro, sql };
    try {
      await pool.query('SET statement_timeout = 15000');
      const result = await pool.query(validacao.sql);
      await pool.query('SET statement_timeout = 0');
      return { success: true, rows: result.rows, fields: result.fields?.map(f => f.name) || [], rowCount: result.rowCount, sql: validacao.sql };
    } catch (sqlError) {
      await pool.query('SET statement_timeout = 0').catch(() => {});
      return { success: false, erro: sqlError.message, sql: validacao.sql };
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
- Receita bruta = SUM(valor)
- Custo profissionais = SUM(valor_prof)
- Faturamento líquido = SUM(valor) - COALESCE(SUM(valor_prof), 0). NUNCA use SUM(valor) como faturamento.
- Ticket médio = receita / total entregas
- Garantido (bi_garantido_cache): complemento = MAX(0, valor_negociado - valor_produzido)

## 5. FROTA
- Motos/dia = COUNT(DISTINCT cod_prof). Ideal: 10 entregas/moto/dia

## 6. ESTRUTURA
- bi_entregas: cada linha = um PONTO de uma OS
- Ponto 1 = COLETA, Ponto >= 2 = ENTREGAS. SEMPRE: WHERE COALESCE(ponto, 1) >= 2

## 7. DETRATORES
- Profissional com 3+ OS atrasadas = detrator de prazo`;

  // ==================== SYSTEM PROMPT ====================
  function buildSystemPrompt(schemaTexto, samplesTexto, contextoFiltros) {
    return `Você é o analista de dados sênior da Tutts, empresa de logística de entregas com motoboys em Salvador/BA.
Você tem acesso DIRETO ao banco PostgreSQL. O usuário conversa naturalmente — mantenha contexto completo.

# IDENTIDADE
- Você É funcionário da Tutts. Use "nós", "nossa operação".
- Português brasileiro, profissional e amigável.
- NUNCA fale como consultor externo. NUNCA sugira "aumentar contato com cliente".

# COMO FUNCIONA
1. Pergunta CONCEITUAL → responda direto usando o Knowledge Base
2. Precisa de DADOS → gere SQL dentro de um bloco \`\`\`sql ... \`\`\`
   O sistema detecta, valida, executa e te devolve o resultado.
3. Refinamento → ajuste o SQL mantendo contexto da conversa

# REGRAS SQL
1. SEMPRE: WHERE COALESCE(ponto, 1) >= 2
2. SEMPRE: LIMIT (máx 500)
3. SEMPRE: NULLIF(x, 0) em divisões
4. Taxa prazo: ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2)
5. Faturamento líquido = SUM(valor) - COALESCE(SUM(valor_prof), 0)
6. Retornos: LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%retorno%'
7. Use nome_fantasia para clientes, nome_prof para profissionais
8. Prefira COUNT(*) FILTER (WHERE ...) em vez de SUM(CASE WHEN)
9. Só tabelas do schema abaixo

# FILTROS ATIVOS
${contextoFiltros || 'Nenhum filtro — todos os dados.'}
${contextoFiltros ? 'TODAS as queries DEVEM incluir estes filtros.' : ''}

# SCHEMA
${schemaTexto}
${samplesTexto}

# KNOWLEDGE BASE
${KNOWLEDGE_BASE}

# FORMATO DE RESPOSTA
- Markdown: **negrito** para números, emojis para classificação
- 🟢 Bom (>=80%) · 🟡 Atenção (50-79%) · 🔴 Crítico (<50%)
- Valores: R$ 1.234,56 | Tempos >60min: Xh XXmin | Taxas: 1 decimal
- NUNCA blocos SQL na resposta final ao usuário
- NUNCA invente dados
- NUNCA termine com sugestões de perguntas
- Gráficos quando fizer sentido:

[CHART]
{"type":"bar","title":"Título","labels":["A","B"],"datasets":[{"label":"Série","data":[10,20],"color":"#10b981"}]}
[/CHART]

Tipos: "bar", "horizontalBar", "line", "pie", "doughnut". Máx 2 por resposta.`;
  }

  // ==================== MONTAR FILTROS ====================
  function montarContextoFiltros(filtros) {
    const rawCliente = filtros?.cod_cliente || null;
    const rawCentro = filtros?.centro_custo || null;
    const dataInicio = filtros?.data_inicio || null;
    const dataFim = filtros?.data_fim || null;
    const nomeCliente = filtros?.nome_fantasia || null;

    const codClientes = rawCliente
      ? (Array.isArray(rawCliente) ? rawCliente : [rawCliente]).map(c => parseInt(c)).filter(c => !isNaN(c))
      : [];
    const centrosCusto = rawCentro
      ? (Array.isArray(rawCentro) ? rawCentro : [rawCentro]).filter(c => c && c.trim())
      : [];

    let contexto = '';
    let filtroSQL = '';

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
      if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY não configurada. Adicione nas variáveis de ambiente do Railway.' });

      console.log(`\n🤖 [Chat IA v4] Prompt: "${prompt.substring(0, 100)}"`);
      console.log(`   Filtros: ${JSON.stringify(filtros || {}).substring(0, 200)}`);
      console.log(`   Histórico: ${historico?.length || 0} msgs`);

      const contextoFiltros = montarContextoFiltros(filtros);

      let schema, samples;
      try {
        [schema, samples] = await Promise.all([getSchema(), getSamples()]);
      } catch (dbErr) {
        console.error('❌ [Chat IA] Erro schema/samples:', dbErr.message);
        return res.status(500).json({ error: 'Erro banco: ' + dbErr.message });
      }

      const systemPrompt = buildSystemPrompt(formatarSchema(schema), formatarSamples(samples), contextoFiltros);
      const messages = [];
      if (historico?.length > 0) {
        for (const h of historico) {
          if (h.prompt) messages.push({ role: 'user', content: h.prompt });
          if (h.resposta) messages.push({ role: 'assistant', content: h.resposta });
        }
      }
      messages.push({ role: 'user', content: prompt });

      // ETAPA 1
      let resposta1;
      try {
        resposta1 = await chamarClaude(messages, systemPrompt, { temperature: 0.4, maxTokens: 4096 });
      } catch (claudeErr) {
        console.error('❌ [Chat IA] Erro Claude:', claudeErr.message);
        return res.status(500).json({ error: 'Erro IA: ' + claudeErr.message });
      }

      const sqlBlocks = [];
      const sqlRegex = /```sql\n?([\s\S]*?)\n?```/g;
      let match;
      while ((match = sqlRegex.exec(resposta1)) !== null) sqlBlocks.push(match[1].trim());

      if (sqlBlocks.length === 0) {
        console.log('✅ [Chat IA v4] Resposta direta');
        if (conversa_id) await salvarMensagem(conversa_id, prompt, resposta1, null, null);
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
          const retryMsgs = [...messages, { role: 'assistant', content: resposta1 }, { role: 'user', content: `Queries falharam:\n${erros.join('\n')}\n\nCorrija usando o schema fornecido.` }];
          const resp2 = await chamarClaude(retryMsgs, systemPrompt, { temperature: 0.3, maxTokens: 4096 });
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
        respostaFinal = await chamarClaude(analiseMsgs, systemPrompt, { temperature: 0.5, maxTokens: 4096 });
      } catch (e) {
        respostaFinal = `Dados encontrados (${todosResultados.length} registros), mas houve erro na análise.`;
      }

      const sqlFinal = sqlsExecutadas.join(';\n\n');
      if (conversa_id) await salvarMensagem(conversa_id, prompt, respostaFinal, sqlFinal, { total: todosResultados.length });

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
