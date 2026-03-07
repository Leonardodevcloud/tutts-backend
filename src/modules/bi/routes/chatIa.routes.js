/**
 * BI Sub-Router: Chat IA — Analista de Dados Conversacional
 * v4.0 — Arquitetura Conversacional com Claude (Anthropic):
 *
 *  Fluxo:
 *   1. Usuário envia mensagem em linguagem natural
 *   2. Backend monta system prompt com schema + knowledge base + filtros ativos
 *   3. Envia histórico COMPLETO de mensagens para Claude (contexto acumulativo)
 *   4. Claude decide: responder direto (conceitual) OU gerar SQL para consultar dados
 *   5. Se gerou SQL → backend valida (só SELECT, tabelas permitidas, timeout) → executa
 *   6. Resultado volta para Claude que analisa e responde naturalmente
 *   7. Experiência: conversa fluida, igual falar com um analista humano
 *
 *  Mudanças vs v3:
 *   - Zero templates SQL hardcoded
 *   - Zero classificação de categorias
 *   - Contexto acumulativo real (histórico completo)
 *   - Claude (Sonnet) no lugar de Gemini Flash
 *   - Uma única chamada inteligente que decide se precisa de SQL ou não
 */
const express = require('express');

function createChatIaRoutes(pool) {
  const router = express.Router();

  // ==================== CACHES ====================
  let schemaCache = { data: null, timestamp: 0 };
  const SCHEMA_CACHE_TTL = 5 * 60 * 1000; // 5 min
  let samplesCache = { data: null, timestamp: 0 };
  const SAMPLES_CACHE_TTL = 30 * 60 * 1000; // 30 min

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

  // ==================== HELPER: Chamar Claude (Anthropic API) ====================
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

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2024-01-01'
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (data.error) throw new Error(`Claude API: ${data.error.message}`);

    // Extrair texto da resposta
    const text = data.content
      ?.filter(b => b.type === 'text')
      ?.map(b => b.text)
      ?.join('\n') || '';

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

    // Contar registros
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
    let texto = '\n# VALORES REAIS NO BANCO (use estes valores exatos em filtros):\n';
    if (samples.ocorrencias?.length) texto += `\nOcorrências possíveis: ${samples.ocorrencias.map(o => `"${o.ocorrencia}" (${o.qtd}x)`).join(', ')}\n`;
    if (samples.status?.length) texto += `Status possíveis: ${samples.status.map(s => `"${s.status}" (${s.qtd}x)`).join(', ')}\n`;
    if (samples.categorias?.length) texto += `Categorias: ${samples.categorias.map(c => `"${c.categoria}" (${c.qtd}x)`).join(', ')}\n`;
    if (samples.periodo) texto += `Período disponível: ${samples.periodo.min_data} até ${samples.periodo.max_data} (${samples.periodo.dias} dias)\n`;
    if (samples.clientes?.length) texto += `\nClientes (top 30 por volume): ${samples.clientes.map(c => `${c.nome_fantasia} (cod:${c.cod_cliente}, ${c.qtd} entregas)`).join(', ')}\n`;
    if (samples.profissionais?.length) texto += `\nProfissionais (top 30 por volume): ${samples.profissionais.map(p => `${p.nome_prof} (cod:${p.cod_prof}, ${p.qtd} entregas)`).join(', ')}\n`;
    return texto;
  }

  // ==================== VALIDAÇÃO SQL ====================
  function validarSQL(sql) {
    let sqlLimpo = sql.trim().replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();
    const upper = sqlLimpo.toUpperCase().replace(/\s+/g, ' ').trim();

    // Bloquear comandos perigosos
    const proibidos = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'COPY', 'VACUUM', 'REINDEX'];
    for (const cmd of proibidos) {
      if (upper.startsWith(cmd + ' ') || upper.includes('; ' + cmd) || upper.includes(';' + cmd))
        return { valido: false, erro: `Comando ${cmd} não permitido.` };
    }

    // Só SELECT ou WITH
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH'))
      return { valido: false, erro: 'Apenas SELECT ou WITH permitidos.' };

    // Múltiplas queries: pegar só a primeira
    const semStrings = sqlLimpo.replace(/'[^']*'/g, '');
    if ((semStrings.match(/;/g) || []).length > 1) {
      const queries = sqlLimpo.split(/;\s*/).filter(q => q.trim().length > 0);
      if (queries.length > 0) sqlLimpo = queries[0].trim();
    }

    // Verificar tabelas usadas
    const tabelasUsadas = sqlLimpo.toUpperCase().match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'generate_series')
        return { valido: false, erro: `Tabela "${tabela}" não autorizada.` };
    }

    // Garantir LIMIT
    if (!sqlLimpo.toUpperCase().includes('LIMIT')) sqlLimpo += ' LIMIT 500';

    return { valido: true, sql: sqlLimpo };
  }

  // ==================== EXECUÇÃO SQL COM TIMEOUT ====================
  async function executarSQL(sql) {
    const validacao = validarSQL(sql);
    if (!validacao.valido) {
      return { success: false, erro: validacao.erro, sql: sql };
    }

    try {
      await pool.query('SET statement_timeout = 15000'); // 15s timeout
      const result = await pool.query(validacao.sql);
      await pool.query('SET statement_timeout = 0');

      return {
        success: true,
        rows: result.rows,
        fields: result.fields?.map(f => f.name) || [],
        rowCount: result.rowCount,
        sql: validacao.sql
      };
    } catch (sqlError) {
      await pool.query('SET statement_timeout = 0').catch(() => {});
      return { success: false, erro: sqlError.message, sql: validacao.sql };
    }
  }

  // ==================== KNOWLEDGE BASE ====================
  const KNOWLEDGE_BASE = `
## 1. SISTEMA DE PRAZOS (SLA)

### Como o prazo é definido:
O prazo de cada entrega é calculado com base na DISTÂNCIA (km) do ponto de entrega. Existem 3 níveis de configuração:
1. **Prazo por cliente específico**: Se o cliente tem faixas de prazo configuradas (bi_prazos_cliente + bi_faixas_prazo), usa essas.
2. **Prazo por centro de custo**: Se não tem prazo por cliente, busca pelo centro de custo.
3. **Prazo padrão**: Faixas genéricas da bi_prazo_padrao.

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

Quando uma entrega está FORA do prazo (dentro_prazo = false), classificamos o MOTIVO automaticamente:

### Tempos utilizados:
- **SLA total** = (finalizado - data_hora) em minutos
- **Tempo de alocação** = (data_hora_alocado - data_hora) em minutos
- **Tempo de execução** = campo tempo_execucao_minutos
- **Tempo residual** = sla_total - tempo_alocacao - tempo_execucao (tempo esperando coleta)

### Classificação (ordem de prioridade):
1. **Falha sistêmica** (🔴): sla_total > 600min E tempo_alocacao > 300min. OS "perdida" no sistema.
2. **OS não encerrada** (🔴): sla_total > 600min, alocação normal. Motoboy não finalizou no app.
3. **Associado tarde** (🟠): tempo_alocacao > 30min. Mesa de operações demorou — problema NOSSO (interno).
4. **Coleta lenta** (🟡): tempo_residual > 45min. Loja do CLIENTE demorou — problema do CLIENTE.
5. **Atraso do motoboy** (🟠): nenhum dos anteriores. Trânsito, rota, performance do motoboy.

SQL para classificar:
\`\`\`sql
CASE
  WHEN EXTRACT(EPOCH FROM (finalizado - data_hora))/60 > 600 AND EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 > 300 THEN 'Falha sistêmica'
  WHEN EXTRACT(EPOCH FROM (finalizado - data_hora))/60 > 600 THEN 'OS não encerrada'
  WHEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 > 30 THEN 'Associado tarde'
  WHEN (EXTRACT(EPOCH FROM (finalizado - data_hora))/60 - EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 - tempo_execucao_minutos) > 45 THEN 'Coleta lenta'
  ELSE 'Atraso do motoboy'
END
\`\`\`

## 3. RETORNOS E OCORRÊNCIAS

### Tipos de retorno (campo ocorrencia):
- **Cliente Fechado**: Estabelecimento estava fechado
- **Cliente Ausente / ClienteAus**: Ninguém no local
- **Loja Fechada**: Ponto de coleta fechado
- **Produto Incorreto**: Produto errado, motoboy devolveu
- **Retorno** (genérico): Outros motivos

### Referências de taxa de retorno:
- Até **2%**: 🟢 SAUDÁVEL
- **2% a 5%**: 🟡 ATENÇÃO
- Acima de **5%**: 🔴 PREOCUPANTE

## 4. FINANCEIRO

### Conceitos:
- **Receita bruta** = SUM(valor) — total cobrado do cliente
- **Custo profissionais** = SUM(valor_prof) — total pago aos motoboys
- **Faturamento líquido** = receita bruta - custo profissionais. NUNCA apresente receita_bruta como faturamento.
- **Ticket médio** = receita bruta / total de entregas
- **Custo por entrega** = custo profissionais / total de entregas

### Mínimo Garantido (tabela bi_garantido_cache):
- Acordo diário com motoboy: se produzir menos que o valor negociado, Tutts paga a diferença
- **Complemento** = MAX(0, valor_negociado - valor_produzido) — é o CUSTO do garantido
- **Status**: "acima" (produziu mais), "abaixo" (Tutts pagou diferença), "nao_rodou" (Tutts paga tudo)

## 5. FROTA E DIMENSIONAMENTO
- **Motos por dia** = COUNT(DISTINCT cod_prof)
- Média ideal: **10 entregas/moto/dia**
- Abaixo de 8: sub-utilização. Acima de 15: sobre-utilização.

## 6. ESTRUTURA DE DADOS

### Tabela principal: bi_entregas
- Cada linha = um PONTO de uma OS
- **Ponto 1** = COLETA. **Ponto ≥ 2** = ENTREGAS
- SEMPRE filtrar ponto ≥ 2 para métricas de entrega: WHERE COALESCE(ponto, 1) >= 2
- OS pode ter vários pontos (uma coleta e múltiplas entregas)

### Filtros do frontend:
- cod_cliente: filtra por cliente
- centro_custo: filtra por filial/unidade
- data_solicitado: período (BETWEEN data_inicio AND data_fim)

## 7. DETRATORES
- Profissional com 3+ OS atrasadas no período = detrator de prazo

## 8. SAQUES (withdrawal_requests)
- Status: aguardando_aprovacao → aprovado/rejeitado
- aprovado_gratuidade = saque de bonificação do Score
- NÃO confundir com mínimo garantido`;

  // ==================== SYSTEM PROMPT ====================
  function buildSystemPrompt(schemaTexto, samplesTexto, contextoFiltros) {
    return `Você é o analista de dados sênior da Tutts, uma empresa de logística de entregas com motoboys em Salvador/BA.

Você tem acesso DIRETO ao banco de dados PostgreSQL da empresa. O usuário conversa com você naturalmente, como se estivesse falando com um colega analista. Você mantém o contexto da conversa completa e pode referir a análises anteriores.

# SUA IDENTIDADE
- Você É funcionário da Tutts. Use "nós", "nossa operação", "nossos motoboys".
- Fale em português brasileiro, tom profissional mas amigável.
- ⛔ NUNCA fale como consultor externo. NUNCA sugira "aumentar contato com o cliente" ou coisas genéricas de consultoria.

# COMO FUNCIONA

Quando o usuário faz uma pergunta:

1. Se é uma pergunta CONCEITUAL (o que é SLA, como funciona o prazo, etc), responda direto usando o Knowledge Base abaixo. Não precisa de SQL.

2. Se precisa de DADOS do banco, você deve gerar SQL. Para isso, responda usando EXATAMENTE este formato:

\`\`\`sql
SELECT ...
\`\`\`

IMPORTANTE: Coloque o SQL dentro de um bloco \`\`\`sql\`\`\`. O sistema vai detectar, executar e te devolver o resultado. Depois disso você receberá os dados e poderá analisar.

3. Se o usuário pede para refinar, filtrar, ou ajustar uma análise anterior, gere o SQL adaptado mantendo o contexto.

# REGRAS SQL OBRIGATÓRIAS

1. **SEMPRE** filtrar entregas com: WHERE COALESCE(ponto, 1) >= 2 (exclui coletas)
2. **SEMPRE** usar LIMIT (máximo 500 registros)
3. **SEMPRE** proteger divisão por zero com NULLIF(x, 0)
4. Para taxa de prazo: ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2)
5. Faturamento líquido = SUM(valor) - COALESCE(SUM(valor_prof), 0). NUNCA use SUM(valor) sozinho como faturamento.
6. Para retornos: LOWER(ocorrencia) LIKE '%cliente fechado%' OR LIKE '%clienteaus%' OR LIKE '%cliente ausente%' OR LIKE '%loja fechada%' OR LIKE '%retorno%'
7. Use nome_fantasia para exibir clientes, nome_prof para profissionais
8. Prefira COUNT(*) FILTER (WHERE ...) em vez de SUM(CASE WHEN)
9. Use apenas as tabelas do schema abaixo
10. SQL em inglês (keywords). Aliases podem ser em português.

# FILTROS ATIVOS DO FRONTEND
${contextoFiltros || 'Nenhum filtro aplicado — considere todos os dados disponíveis.'}

IMPORTANTE: Se há filtros ativos, TODAS as suas queries DEVEM incluí-los no WHERE. Nunca ignore os filtros do frontend.

# SCHEMA DO BANCO
${schemaTexto}

${samplesTexto}

# KNOWLEDGE BASE — REGRAS DE NEGÓCIO
${KNOWLEDGE_BASE}

# FORMATO DE RESPOSTA

- Use markdown: **negrito** para números, emojis para classificação
- 🟢 Bom (≥80%) · 🟡 Atenção (50-79%) · 🔴 Crítico (<50%)
- Valores monetários: R$ 1.234,56
- Tempos > 60min: Xh XXmin
- Taxas: 1 casa decimal
- ⛔ NUNCA inclua blocos SQL na resposta final ao usuário (só no passo de geração)
- ⛔ NUNCA invente dados — só use o que veio do banco
- ⛔ NUNCA termine com "Quer que eu aprofunde?" ou sugestões de perguntas
- Se o resultado estiver vazio, diga claramente
- Quando fizer sentido, sugira um gráfico usando este formato DENTRO da resposta:

[CHART]
{"type":"bar","title":"Título","labels":["A","B"],"datasets":[{"label":"Série","data":[10,20],"color":"#10b981"}]}
[/CHART]

Tipos: "bar", "horizontalBar", "line", "pie", "doughnut". Máx 2 gráficos por resposta.`;
  }

  // ==================== ENDPOINT PRINCIPAL ====================
  router.post('/bi/chat-ia', async (req, res) => {
    try {
      const { prompt, historico, filtros } = req.body;
      if (!prompt || prompt.trim().length < 3) {
        return res.status(400).json({ error: 'Prompt deve ter pelo menos 3 caracteres.' });
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(400).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
      }

      console.log(`🤖 [Chat IA v4] Prompt: "${prompt.substring(0, 100)}..."`);

      // ========== MONTAR FILTROS ==========
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

      let contextoFiltros = '';
      let filtroSQL = '';

      if (codClientes.length === 1) {
        contextoFiltros += `Cliente: ${nomeCliente || 'cod ' + codClientes[0]} (cod_cliente = ${codClientes[0]})\n`;
        filtroSQL += ` AND cod_cliente = ${codClientes[0]}`;
      } else if (codClientes.length > 1) {
        const nomes = filtros?.nomes_clientes || codClientes.map(c => 'cod ' + c).join(', ');
        contextoFiltros += `Clientes (${codClientes.length}): ${nomes} — cod_cliente IN (${codClientes.join(',')})\n`;
        filtroSQL += ` AND cod_cliente IN (${codClientes.join(',')})`;
      }

      if (centrosCusto.length === 1) {
        contextoFiltros += `Centro de custo: ${centrosCusto[0]}\n`;
        filtroSQL += ` AND centro_custo = '${centrosCusto[0].replace(/'/g, "''")}'`;
      } else if (centrosCusto.length > 1) {
        contextoFiltros += `Centros de custo (${centrosCusto.length}): ${centrosCusto.join(', ')}\n`;
        filtroSQL += ` AND centro_custo IN (${centrosCusto.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`;
      }

      if (dataInicio && dataFim) {
        contextoFiltros += `Período: ${dataInicio} até ${dataFim}\n`;
        filtroSQL += ` AND data_solicitado BETWEEN '${dataInicio}' AND '${dataFim}'`;
      }

      if (filtroSQL) {
        contextoFiltros += `\nCláusula SQL obrigatória para TODAS as queries:\nWHERE COALESCE(ponto, 1) >= 2${filtroSQL}`;
      }

      // ========== BUSCAR SCHEMA E AMOSTRAS ==========
      const [schema, samples] = await Promise.all([getSchema(), getSamples()]);
      const schemaTexto = formatarSchema(schema);
      const samplesTexto = formatarSamples(samples);

      // ========== MONTAR SYSTEM PROMPT ==========
      const systemPrompt = buildSystemPrompt(schemaTexto, samplesTexto, contextoFiltros);

      // ========== MONTAR MENSAGENS (histórico completo) ==========
      const messages = [];

      // Converter histórico anterior
      if (historico?.length > 0) {
        for (const h of historico) {
          if (h.prompt) messages.push({ role: 'user', content: h.prompt });
          if (h.resposta) messages.push({ role: 'assistant', content: h.resposta });
        }
      }

      // Mensagem atual do usuário
      messages.push({ role: 'user', content: prompt });

      // ========== ETAPA 1: Primeira chamada ao Claude ==========
      console.log('🧠 [Chat IA v4] Chamando Claude (etapa 1 — entendimento)...');
      const resposta1 = await chamarClaude(messages, systemPrompt, { temperature: 0.4, maxTokens: 4096 });

      // ========== VERIFICAR SE GEROU SQL ==========
      const sqlBlocks = [];
      const sqlRegex = /```sql\n?([\s\S]*?)\n?```/g;
      let match;
      while ((match = sqlRegex.exec(resposta1)) !== null) {
        sqlBlocks.push(match[1].trim());
      }

      // Se não gerou SQL, é resposta direta (conceitual/saudação/contextual)
      if (sqlBlocks.length === 0) {
        console.log('✅ [Chat IA v4] Resposta direta (sem SQL)');
        return res.json({
          success: true,
          resposta: resposta1,
          sql: null,
          dados: null
        });
      }

      // ========== ETAPA 2: Executar SQL(s) ==========
      console.log(`🔄 [Chat IA v4] ${sqlBlocks.length} SQL(s) detectada(s), executando...`);

      const todosResultados = [];
      const todasColunas = new Set();
      const sqlsExecutadas = [];
      const erros = [];

      for (const bloco of sqlBlocks) {
        // Separar múltiplas queries dentro de um bloco
        const queries = bloco.split(/;\s*/).filter(q => {
          const t = q.trim().toUpperCase();
          return t.startsWith('SELECT') || t.startsWith('WITH');
        });

        for (const sql of queries) {
          const resultado = await executarSQL(sql.trim());
          if (resultado.success) {
            resultado.rows.forEach(row => todosResultados.push(row));
            resultado.fields.forEach(f => todasColunas.add(f));
            sqlsExecutadas.push(resultado.sql);
            console.log(`  ✅ Query OK: ${resultado.rowCount} registros`);
          } else {
            erros.push(resultado.erro);
            console.error(`  ❌ Query erro: ${resultado.erro}`);
          }
        }
      }

      // Se todas falharam, tentar retry com Claude
      if (todosResultados.length === 0 && erros.length > 0) {
        console.log('🔄 [Chat IA v4] Todas as queries falharam, pedindo correção...');

        const mensagensRetry = [
          ...messages,
          { role: 'assistant', content: resposta1 },
          { role: 'user', content: `As queries SQL falharam com os seguintes erros:\n${erros.join('\n')}\n\nPor favor, corrija e gere novas queries. Lembre-se de usar apenas as tabelas e colunas do schema fornecido.` }
        ];

        try {
          const resposta2 = await chamarClaude(mensagensRetry, systemPrompt, { temperature: 0.3, maxTokens: 4096 });

          // Tentar extrair e executar SQL da resposta de retry
          const sqlRetry = [];
          const regexRetry = /```sql\n?([\s\S]*?)\n?```/g;
          let m2;
          while ((m2 = regexRetry.exec(resposta2)) !== null) sqlRetry.push(m2[1].trim());

          for (const sql of sqlRetry) {
            const resultado = await executarSQL(sql);
            if (resultado.success) {
              resultado.rows.forEach(row => todosResultados.push(row));
              resultado.fields.forEach(f => todasColunas.add(f));
              sqlsExecutadas.push(resultado.sql);
            }
          }

          // Se ainda falhou, retornar a resposta do retry (pode ter explicação útil)
          if (todosResultados.length === 0) {
            const textoLimpo = resposta2.replace(/```sql[\s\S]*?```/g, '').trim();
            return res.json({
              success: true,
              resposta: textoLimpo || '⚠️ Não consegui executar a consulta. Tente reformular sua pergunta.',
              sql: sqlRetry.join(';\n'),
              dados: null
            });
          }
        } catch (retryErr) {
          console.error('❌ [Chat IA v4] Retry falhou:', retryErr.message);
          return res.json({
            success: true,
            resposta: '⚠️ Houve um erro ao consultar os dados. Tente reformular sua pergunta.',
            sql: sqlBlocks.join(';\n'),
            dados: null
          });
        }
      }

      // ========== ETAPA 3: Claude analisa os resultados ==========
      console.log(`🧠 [Chat IA v4] Chamando Claude (etapa 2 — análise de ${todosResultados.length} registros)...`);

      const dadosParaAnalise = todosResultados.length > 150 ? todosResultados.slice(0, 150) : todosResultados;

      const mensagensAnalise = [
        ...messages,
        { role: 'assistant', content: resposta1 },
        {
          role: 'user',
          content: `Resultado da execução SQL (${todosResultados.length} registros${todosResultados.length > 150 ? ', mostrando 150' : ''}):\n\n\`\`\`json\n${JSON.stringify(dadosParaAnalise, null, 2).substring(0, 30000)}\n\`\`\`\n\nAgora analise esses dados e responda a pergunta original do usuário de forma clara e natural. Lembre-se: NÃO inclua blocos SQL na resposta. Use markdown, emojis e o formato definido nas suas instruções.`
        }
      ];

      let respostaFinal;
      try {
        respostaFinal = await chamarClaude(mensagensAnalise, systemPrompt, { temperature: 0.5, maxTokens: 4096 });
      } catch (analiseErr) {
        console.error('❌ [Chat IA v4] Erro análise:', analiseErr.message);
        respostaFinal = `Dados encontrados (${todosResultados.length} registros), mas houve um erro na análise. Os dados brutos estão disponíveis abaixo.`;
      }

      const colunas = [...todasColunas];
      const sqlFinal = sqlsExecutadas.join(';\n\n');

      console.log('✅ [Chat IA v4] Resposta completa gerada');

      return res.json({
        success: true,
        resposta: respostaFinal,
        sql: sqlFinal,
        dados: {
          colunas,
          linhas: dadosParaAnalise,
          total: todosResultados.length
        }
      });

    } catch (err) {
      console.error('❌ [Chat IA v4] Erro geral:', err);
      res.status(500).json({ error: 'Erro interno no Chat IA: ' + err.message });
    }
  });

  // ==================== ENDPOINT: Filtros ====================
  router.get('/bi/chat-ia/filtros', async (req, res) => {
    try {
      const clientes = await pool.query(`
        SELECT DISTINCT e.cod_cliente, 
          COALESCE(m.mascara, e.nome_fantasia) as nome_fantasia
        FROM bi_entregas e
        LEFT JOIN bi_mascaras m ON m.cod_cliente = e.cod_cliente::text
        WHERE e.cod_cliente IS NOT NULL AND e.nome_fantasia IS NOT NULL AND e.nome_fantasia != ''
        ORDER BY nome_fantasia
      `);
      const centrosCusto = await pool.query(`SELECT DISTINCT centro_custo FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != '' ORDER BY centro_custo`);

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

      res.json({
        clientes: clientes.rows,
        centros_custo: centrosCusto.rows.map(r => r.centro_custo),
        centros_do_cliente: centrosDoCliente
      });
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
