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

    // Se houver múltiplas queries, pegar apenas a primeira
    const semStrings = sqlLimpo.replace(/'[^']*'/g, '');
    if ((semStrings.match(/;/g) || []).length > 1) {
      // Separar por ; e pegar a primeira query válida
      const queries = sqlLimpo.split(/;\s*/).filter(q => q.trim().length > 0);
      if (queries.length > 0) {
        console.log(`⚠️ [Chat IA] Múltiplas queries detectadas (${queries.length}), usando apenas a primeira`);
        sqlLimpo = queries[0].trim();
        upper = sqlLimpo.toUpperCase();
      }
    }

    // Verificar se referencia apenas tabelas permitidas
    // Excluir falsos positivos como EXTRACT(HOUR FROM data_hora), INTERVAL '1 day' FROM, etc
    const tabelasUsadas = upper.match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      // Ignorar nomes de colunas usados em EXTRACT(... FROM coluna)
      const posMatch = upper.indexOf(match.toUpperCase());
      const antes = upper.substring(Math.max(0, posMatch - 30), posMatch).trim();
      const isExtract = /EXTRACT\s*\(\s*\w+\s*$/i.test(antes) || /\(\s*\w+\s*$/i.test(antes);
      if (isExtract) continue; // É EXTRACT(HOUR FROM data_hora), não uma tabela
      
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'pg_class' && tabela !== 'generate_series') {
        return { valido: false, erro: `Tabela "${tabela}" não está autorizada para consulta.` };
      }
    }

    return { valido: true, sql: sqlLimpo };
  }

  // ==================== ENDPOINT: Chat IA ====================
  router.post('/bi/chat-ia', async (req, res) => {
    try {
      const { prompt, historico, filtros } = req.body;

      if (!prompt || prompt.trim().length < 3) {
        return res.status(400).json({ error: 'Prompt deve ter pelo menos 3 caracteres.' });
      }

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) {
        return res.status(400).json({ error: 'API Key do Gemini não configurada. Adicione GEMINI_API_KEY nas variáveis de ambiente.' });
      }

      console.log(`🤖 [Chat IA] Prompt: "${prompt.substring(0, 100)}..."`);

      // Extrair filtros do contexto da conversa
      const codCliente = filtros?.cod_cliente || null;
      const centroCusto = filtros?.centro_custo || null;
      const dataInicio = filtros?.data_inicio || null;
      const dataFim = filtros?.data_fim || null;
      const nomeCliente = filtros?.nome_fantasia || null;

      // Montar contexto de filtros para injetar no prompt
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

      console.log(`🤖 [Chat IA] Filtros: cliente=${codCliente}, cc=${centroCusto}, periodo=${dataInicio}-${dataFim}`);

      // 1. Buscar schema do banco
      const schema = await getSchema();
      const schemaTexto = formatarSchema(schema);

      // 2. Montar histórico de mensagens (se houver)
      const mensagens = [];

      // System message via primeiro user message
      const systemContent = `Você é um analista de dados SQL expert da empresa Tutts (logística de motoboys/entregadores).
Seu ÚNICO trabalho é gerar queries SQL PostgreSQL para responder perguntas sobre o banco de dados.

⚠️ REGRA ABSOLUTA: Você SEMPRE gera uma query SQL executável. NUNCA invente dados. NUNCA dê respostas hipotéticas. NUNCA dê exemplos fictícios.
⚠️ NUNCA diga "seria necessário analisar", "podemos executar", "sugiro a seguinte query". GERE A QUERY DIRETAMENTE.
⚠️ Sua resposta INTEIRA deve ser APENAS um bloco \`\`\`sql ... \`\`\`. Nada antes, nada depois.

📊 SCHEMA DO BANCO:
${schemaTexto}

═══════════════════════════════════════
🔑 DICIONÁRIO COMPLETO — bi_entregas
═══════════════════════════════════════
Tabela principal. Alimentada por upload de Excel do sistema operacional.
Cada linha = um PONTO de uma OS (Ordem de Serviço).
Uma OS pode ter vários pontos: ponto 1 = COLETA, ponto 2+ = ENTREGAS.

IDENTIFICAÇÃO DA OS:
- os (INTEGER): número da Ordem de Serviço (chave principal junto com ponto)
- ponto (INTEGER): sequência do ponto. 1=coleta no remetente, 2,3,4...=entregas nos destinatários
- num_pedido (VARCHAR): número do pedido do cliente (pode ser nulo)

CLIENTE:
- cod_cliente (INTEGER): código do cliente no sistema
- nome_cliente (VARCHAR): razão social do cliente
- empresa (VARCHAR): nome da empresa
- nome_fantasia (VARCHAR): nome fantasia do cliente (USE ESTE para exibição)
- centro_custo (VARCHAR): filial/unidade do cliente (ex: "GEFPEL SERGIPE", "RMA", "MATRIZ")

LOCALIZAÇÃO:
- cidade_p1 (VARCHAR): cidade do ponto 1 (coleta)
- endereco (TEXT): endereço completo (formato "Ponto X - Rua..., Bairro, Cidade, UF - CEP")
- bairro (VARCHAR): bairro da entrega
- cidade (VARCHAR): cidade da entrega (cuidado: pode ter variações como "Salvador", "SALVADOR", "salvador")
- estado (VARCHAR): UF (BA, SE, PE, GO, etc)
- latitude / longitude (DECIMAL): coordenadas GPS

PROFISSIONAL (MOTOBOY):
- cod_prof (INTEGER): código do profissional/motoboy
- nome_prof (VARCHAR): nome completo do motoboy

DATAS E HORÁRIOS:
- data_solicitado (DATE): data da OS ← USE ESTE PARA FILTRAR POR PERÍODO
- hora_solicitado (TIME): hora que a OS foi criada
- data_hora (TIMESTAMP): timestamp completo da criação da OS
- data_hora_alocado (TIMESTAMP): quando o motoboy foi alocado
- data_chegada (DATE) + hora_chegada (TIME): quando o motoboy CHEGOU no ponto
- data_saida (DATE) + hora_saida (TIME): quando o motoboy SAIU do ponto
- finalizado (TIMESTAMP): quando a OS foi finalizada

VALORES:
- valor (DECIMAL): valor COBRADO do cliente (R$)
- valor_prof (DECIMAL): valor PAGO ao motoboy (R$)
- faturamento = valor - valor_prof (calcular na query)
- distancia (DECIMAL): distância em KM

EXECUÇÃO:
- execucao_comp (VARCHAR): tempo total de execução no formato HH:MM:SS
- execucao_espera (VARCHAR): tempo de espera no formato HH:MM:SS
- categoria (VARCHAR): tipo de serviço (ex: "Motofrete (Expresso)")
- velocidade_media (DECIMAL): velocidade média do motoboy em km/h

STATUS E OCORRÊNCIAS:
- status (VARCHAR): status da OS (ex: "já recebido", "Finalizado", "Cancelado")
- motivo (VARCHAR): motivo (ex: "Sucesso", "Cancelado pelo cliente")
- ocorrencia (VARCHAR): tipo de ocorrência no ponto. Valores importantes:
  • "Coletado" = coleta realizada (ponto 1)
  • "Entregue" = entrega realizada com sucesso
  • "Cliente Fechado" = RETORNO (cliente estava fechado)
  • "ClienteAus" ou "Cliente Ausente" = RETORNO (cliente ausente)
  • "Loja Fechada" = RETORNO
  • "Produto Incorreto" = RETORNO
  • "Retorno" = RETORNO genérico

═══════════════════════════════════════
📐 MÉTRICAS CALCULADAS (no banco)
═══════════════════════════════════════
- dentro_prazo (BOOLEAN): se a entrega cumpriu o SLA do cliente (calculado pelo sistema)
- prazo_minutos (INTEGER): prazo máximo para este cliente/distância
- tempo_execucao_minutos (INTEGER): tempo REAL da entrega em minutos
- dentro_prazo_prof (BOOLEAN): se o profissional cumpriu o prazo dele
- prazo_prof_minutos (INTEGER): prazo do profissional
- tempo_execucao_prof_minutos (INTEGER): tempo de execução do profissional
- tempo_entrega_prof_minutos (INTEGER): tempo de entrega do profissional

═══════════════════════════════════════
📏 REGRAS DE PRAZO (SLA) PADRÃO
═══════════════════════════════════════
Baseado na distância:
- Até 10km = 60min | 15km = 75min | 20km = 90min | 25km = 105min
- 30km = 120min | 35km = 135min | 40km = 150min | 50km = 180min
- Acima de 100km = fora do prazo
Clientes podem ter prazos personalizados (tabela bi_prazos_cliente).

⚠️ EXCEÇÃO CLIENTE 767 (Grupo Comollati): prazo FIXO de 120 minutos (2 horas) para QUALQUER faixa de km.
Todos os outros clientes seguem a tabela de faixas acima.

═══════════════════════════════════════
🔍 ANÁLISE DE DETRATORES DE SLA
═══════════════════════════════════════
SLA completo = tempo entre CRIAÇÃO da OS (data_hora) e FINALIZAÇÃO (finalizado).
Ponto 1 = COLETA (não é entrega), mas o tempo SLA começa a contar desde a criação.

CLASSIFICAÇÃO DO MOTIVO DO ATRASO (aplicar em ordem de prioridade):
Para OS fora do prazo (dentro_prazo = false), o motivo do atraso pode ser:

1. Se SLA > 600min (10h):
   - Se tempo de alocação > 300min → "Falha sistêmica" (OS nunca foi alocada no dia)
   - Senão → "OS não encerrada" (motoboy entregou mas não fechou a OS no app)

2. Se tempo de alocação > 30min → "Associado tarde" (demorou para alocar motoboy)

3. Se tempo de direcionamento > 30min → "Direcionamento lento" (motoboy demorou pra sair)

4. Se tempo até saída do P1 > 45min → "Coleta lenta" (loja demorou pra liberar)

5. Caso contrário → "Atraso do motoboy" (tempo de deslocamento/entrega)

CÁLCULOS:
- tempo_alocacao = data_hora_alocado - data_hora (em minutos)
- tempo_ate_saida_p1 = hora_saida do ponto 1 - data_hora (em minutos)
- sla_total = finalizado - data_hora (em minutos)

DEFINIÇÃO DE DETRATOR: profissional com 3+ OS atrasadas no período.

SISTEMA DE SEVERIDADE:
- 🔴 Crítico: taxa de atraso ≥ 6%
- 🟠 Alto: taxa 5-6%
- 🟣 Anomalia: SLA máximo > 6h (OS não encerrada ou falha sistêmica)
- 🟡 Médio: taxa 3-5%
- 🟢 Baixo: taxa < 3%

═══════════════════════════════════════
🔄 REGRAS DE RETORNO
═══════════════════════════════════════
Uma OS é RETORNO quando algum ponto tem ocorrência:
LOWER(ocorrencia) LIKE '%cliente fechado%'
OR LOWER(ocorrencia) LIKE '%clienteaus%'
OR LOWER(ocorrencia) LIKE '%cliente ausente%'
OR LOWER(ocorrencia) LIKE '%loja fechada%'
OR LOWER(ocorrencia) LIKE '%produto incorreto%'
OR LOWER(ocorrencia) LIKE '%retorno%'

═══════════════════════════════════════
🔢 FÓRMULAS PADRÃO DO BI
═══════════════════════════════════════
- Total OS: COUNT(DISTINCT os)
- Total Entregas: COUNT(*) WHERE COALESCE(ponto, 1) >= 2
- Taxa de Prazo: ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2)
- Taxa Prazo Prof: mesma lógica com dentro_prazo_prof
- Tempo Médio Entrega: ROUND(AVG(tempo_execucao_minutos)::numeric, 2) — apenas ponto >= 2
- Tempo Médio Coleta: AVG(tempo_execucao_minutos) — apenas ponto = 1
- Valor Total: SUM(valor) — apenas ponto >= 2
- Valor Profissional: SUM(valor_prof) — apenas ponto >= 2
- Faturamento: SUM(valor) - SUM(valor_prof)
- Ticket Médio: SUM(valor) / NULLIF(COUNT(*), 0)
- KM Total: SUM(distancia)
- Total Entregadores: COUNT(DISTINCT cod_prof)
- Média Entregas/Entregador: COUNT(*) / NULLIF(COUNT(DISTINCT cod_prof), 0)
- Retornos: COUNT de OS com ocorrências de retorno (ver regras acima)

═══════════════════════════════════════
🗃️ OUTRAS TABELAS
═══════════════════════════════════════
- withdrawal_requests: saques dos motoboys (status: 'aguardando_aprovacao', 'aprovado', 'rejeitado', 'aprovado_gratuidade')
- cs_clientes: cadastro de clientes Customer Success (campos: cod_cliente, nome_fantasia, health_score, status, etc)
- cs_interacoes: interações com clientes CS
- cs_ocorrencias: ocorrências registradas no CS
- score_totais: pontuação acumulada dos profissionais
- score_historico: histórico de pontuação
- bi_prazos_cliente: prazos SLA personalizados por cliente
- bi_faixas_prazo: faixas de km para cálculo de prazo
- bi_resumo_cliente: resumo agregado por cliente
- bi_resumo_diario: resumo agregado por dia
- bi_resumo_profissional: resumo agregado por profissional

═══════════════════════════════════════
📋 FORMATO DA RESPOSTA
═══════════════════════════════════════

⚠️⚠️⚠️ REGRA ABSOLUTA: Sua resposta deve conter APENAS um bloco SQL executável. NADA MAIS.
NUNCA diga "seria necessário", "podemos executar", "sugiro a query". APENAS GERE O SQL.
NUNCA explique, comente ou sugira. Apenas o bloco SQL puro.

\\\`\\\`\\\`sql
SELECT ... FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND ... LIMIT 200
\\\`\\\`\\\`

═══════════════════════════════════════
🧩 RECEITAS SQL PRONTAS (use como base)
═══════════════════════════════════════

-- Horário de pico (hora com mais pedidos):
SELECT EXTRACT(HOUR FROM data_hora) AS hora,
       COUNT(*) AS total_pedidos
FROM bi_entregas
WHERE COALESCE(ponto, 1) >= 2
GROUP BY EXTRACT(HOUR FROM data_hora)
ORDER BY total_pedidos DESC

-- Faixa de KM com mais pedidos:
SELECT CASE
  WHEN distancia <= 5 THEN '0-5 km'
  WHEN distancia <= 10 THEN '5-10 km'
  WHEN distancia <= 15 THEN '10-15 km'
  WHEN distancia <= 20 THEN '15-20 km'
  WHEN distancia <= 30 THEN '20-30 km'
  ELSE '30+ km'
END AS faixa_km,
COUNT(*) AS total,
ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) AS taxa_prazo,
ROUND(AVG(tempo_execucao_minutos)::numeric, 1) AS tempo_medio
FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2
GROUP BY faixa_km ORDER BY total DESC

-- Evolução diária:
SELECT data_solicitado, COUNT(*) AS entregas,
  ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) AS taxa_prazo
FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2
GROUP BY data_solicitado ORDER BY data_solicitado

-- Dia da semana com mais entregas:
SELECT TO_CHAR(data_solicitado, 'Day') AS dia_semana,
  EXTRACT(DOW FROM data_solicitado) AS dow,
  COUNT(*) AS total
FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2
GROUP BY dia_semana, dow ORDER BY dow

-- Detratores (profissionais com mais atrasos):
SELECT cod_prof, nome_prof,
  COUNT(*) AS total_entregas,
  COUNT(*) FILTER (WHERE dentro_prazo = false) AS atrasadas,
  ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*), 0), 1) AS taxa_atraso,
  ROUND(AVG(tempo_execucao_minutos)::numeric, 1) AS tempo_medio
FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2
GROUP BY cod_prof, nome_prof
HAVING COUNT(*) FILTER (WHERE dentro_prazo = false) >= 3
ORDER BY taxa_atraso DESC

-- Análise de SLA por faixa de tempo de alocação:
SELECT CASE
  WHEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 <= 5 THEN '0-5 min'
  WHEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 <= 15 THEN '5-15 min'
  WHEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora))/60 <= 30 THEN '15-30 min'
  ELSE '30+ min'
END AS faixa_alocacao,
COUNT(*) AS total,
ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) AS taxa_prazo
FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND data_hora_alocado IS NOT NULL
GROUP BY faixa_alocacao ORDER BY faixa_alocacao

═══════════════════════════════════════
⚠️ ARMADILHAS SQL — CUIDADO
═══════════════════════════════════════
1. NUNCA use GROUP BY por alias se o alias tem o MESMO NOME de uma coluna da tabela.
   Exemplo ERRADO: SELECT EXTRACT(HOUR FROM data_hora) AS hora_solicitado ... GROUP BY hora_solicitado
   (hora_solicitado É UMA COLUNA da tabela, o PostgreSQL vai usar a coluna, não o alias!)
   Exemplo CORRETO: SELECT EXTRACT(HOUR FROM data_hora) AS hora ... GROUP BY EXTRACT(HOUR FROM data_hora)

2. NUNCA use strftime() — isso é SQLite, não PostgreSQL. Use EXTRACT() ou TO_CHAR().

3. Sempre use COALESCE(ponto, 1) >= 2 (com COALESCE pois ponto pode ser NULL).

4. Para perguntas com múltiplas partes, gere blocos de código SQL separados. O sistema executa todos automaticamente.

REGRAS OBRIGATÓRIAS:
1. SEMPRE gere SQL executável. NUNCA responda sem SQL. NUNCA sugira SQL — GERE diretamente.
2. SEMPRE filtre apenas entregas (não coletas): WHERE COALESCE(ponto, 1) >= 2
3. SEMPRE adicione LIMIT (máximo 500)
4. NUNCA invente dados, dê exemplos hipotéticos ou use tabelas que não existem
5. Se a pergunta mencionar "detratores" ou "piores", ordene por taxa de prazo ASC
6. Se mencionar "promotores" ou "melhores", ordene por taxa de prazo DESC
7. Para filtrar período, use: data_solicitado BETWEEN '2026-01-01' AND '2026-01-31'
8. Use nome_fantasia para exibir nome do cliente
9. Agrupe quando fizer sentido (por cliente, profissional, dia, cidade, etc)
10. Inclua métricas relevantes mesmo que não pedidas (taxa prazo, total entregas, etc)
11. Se a pergunta tiver DUAS ou mais partes, gere uma query para CADA parte em blocos SQL separados. O sistema executa todas automaticamente.
12. PREFIRA gerar UMA query com UNION ALL se possível. Mas se for complexo, pode gerar blocos separados.
13. Quando a pergunta pedir MÚLTIPLAS análises (ex: "faixa de km E horário de pico"), gere dados completos para CADA análise.
14. SEMPRE traga dados suficientes para uma análise rica. Em vez de LIMIT 1 (só o top), traga LIMIT 10-20 para contexto completo.
${contextoFiltros ? `
═══════════════════════════════════════
⚡ FILTROS ATIVOS DA CONVERSA (OBRIGATÓRIOS)
═══════════════════════════════════════
${contextoFiltros}

REGRA: TODAS as queries SQL DEVEM incluir estes filtros:
${filtroSQLObrigatorio}
Adicione esses filtros em TODA query que gerar, sem exceção.` : ''}`;

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

      // 4. Extrair TODAS as queries SQL da resposta
      const allSqlBlocks = [];
      const sqlBlockRegex = /```sql\n?([\s\S]*?)\n?```/g;
      let match;
      while ((match = sqlBlockRegex.exec(resposta1)) !== null) {
        allSqlBlocks.push(match[1].trim());
      }

      // Fallback: se não veio em blocos ```sql```, tentar extrair SELECT/WITH direto
      if (allSqlBlocks.length === 0) {
        const selectMatch = resposta1.match(/((?:WITH|SELECT)[\s\S]*?;)\s*$/im) || 
                           resposta1.match(/((?:WITH|SELECT)[\s\S]*?LIMIT\s+\d+)/im);
        if (selectMatch) {
          console.log('🔄 [Chat IA] SQL encontrado sem bloco de código, extraindo...');
          allSqlBlocks.push(selectMatch[1].trim());
        }
      }

      // Se um bloco contém múltiplas queries separadas por ;, splitá-las
      const queriesParaExecutar = [];
      for (const bloco of allSqlBlocks) {
        const partes = bloco.split(/;\s*/).filter(q => {
          const t = q.trim().toUpperCase();
          return t.startsWith('SELECT') || t.startsWith('WITH');
        });
        queriesParaExecutar.push(...partes.map(q => q.trim()));
      }

      if (queriesParaExecutar.length === 0) {
        console.log('⚠️ [Chat IA] Gemini não gerou SQL');
        return res.json({
          success: true,
          resposta: '⚠️ Não foi possível gerar uma consulta SQL para essa pergunta. Tente reformular de forma mais específica.\n\nExemplos:\n- "Quantas entregas foram feitas em janeiro?"\n- "Qual o top 10 motoboys por taxa de prazo?"\n- "Qual o horário com mais entregas?"',
          sql: null,
          dados: null
        });
      }

      console.log(`🤖 [Chat IA] ${queriesParaExecutar.length} query(ies) extraída(s)`);

      // 5. Validar e executar CADA query
      const todosResultados = [];
      const todasColunas = new Set();
      const sqlsExecutadas = [];

      // Helper: executar uma query com retry
      async function executarComRetry(sql, tentativa = 1) {
        const validacao = validarSQL(sql);
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
          console.error(`❌ [Chat IA] Erro SQL (tentativa ${tentativa}):`, sqlError.message);

          if (tentativa >= 2) return null;

          // Retry: pedir ao Gemini para corrigir
          try {
            console.log('🔄 [Chat IA] Auto-correção via Gemini...');
            const retryResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `A query SQL abaixo deu erro no PostgreSQL. Corrija e retorne APENAS o SQL corrigido em um bloco \`\`\`sql\`\`\`.\n\nERRO: ${sqlError.message}\n\nSQL COM ERRO:\n\`\`\`sql\n${validacao.sql}\n\`\`\`\n\nREGRAS:\n- Retorne APENAS o bloco SQL corrigido.\n- Se o erro for GROUP BY, repita a expressão completa no GROUP BY.\n- NUNCA use strftime (PostgreSQL usa EXTRACT ou TO_CHAR).\n- Mantenha WHERE COALESCE(ponto, 1) >= 2 e LIMIT.` }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 2000 }
              })
            });
            const retryData = await retryResp.json();
            const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const retrySqlMatch = retryText.match(/```sql\n?([\s\S]*?)\n?```/);
            if (retrySqlMatch) {
              return await executarComRetry(retrySqlMatch[1].trim(), 2);
            }
          } catch (retryError) {
            console.error('❌ [Chat IA] Retry falhou:', retryError.message);
          }
          return null;
        }
      }

      // Executar todas as queries (em paralelo se > 1)
      for (let i = 0; i < queriesParaExecutar.length; i++) {
        const resultado = await executarComRetry(queriesParaExecutar[i]);
        if (resultado) {
          // Adicionar marcador de qual query veio o resultado
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
      console.log(`✅ [Chat IA] ${sqlsExecutadas.length} query(ies) executada(s), ${linhas.length} linhas total, ${colunas.length} colunas`);

      // 7. Enviar resultados para Gemini analisar
      // Limitar dados para não estourar o contexto
      const dadosParaAnalise = linhas.length > 100
        ? linhas.slice(0, 100)
        : linhas;

      const promptAnalise = `Você é um consultor sênior de operações logísticas da Tutts. Analise os dados REAIS abaixo e responda a pergunta do usuário de forma profissional, consultiva e analítica.

## PERGUNTA DO USUÁRIO
"${prompt}"
${contextoFiltros ? `\n## CONTEXTO ATIVO\n${contextoFiltros}\nTodos os dados abaixo já estão filtrados por este contexto.` : ''}

## QUERY SQL EXECUTADA
\`\`\`sql
${sqlFinal}
\`\`\`

## DADOS REAIS (${linhas.length} registros${linhas.length > 100 ? ', mostrando os primeiros 100' : ''} · Colunas: ${colunas.join(', ')})
\`\`\`json
${JSON.stringify(dadosParaAnalise, null, 2).substring(0, 15000)}
\`\`\`

## REGRAS DE FORMATO (OBRIGATÓRIO — SIGA À RISCA)
- ⛔ PROIBIDO usar tabelas markdown (com | --- |). Use listas com bullet points (- item) para dados tabulares.
- Destaque números e métricas com **negrito**.
- Português brasileiro, tom profissional, consultivo e parceiro.
- Use emojis para classificar performance: 🟢 Bom (≥80%) · 🟡 Atenção (50-79%) · 🔴 Crítico (<50%)
- Organize a resposta em parágrafos claros. Use ## (h2) e ### (h3) para seções quando a resposta for longa.
- Para listas de dados (rankings, comparativos), use SEMPRE o formato padronizado:
  - **Item:** métrica1 · métrica2 · métrica3
- Valores monetários: formato R$ 1.234,56
- Tempos: em minutos (converta para "Xh XXmin" se > 60 minutos)
- Taxas/percentuais: sempre com 1 casa decimal (ex: **87,3%**)

## REGRAS DE CONTEÚDO (OBRIGATÓRIO)
- Use APENAS os dados retornados acima. NUNCA invente métricas, dados hipotéticos ou exemplos fictícios.
- ⛔ NUNCA mencione valores financeiros, faturamento ou custos EXCETO se a pergunta pedir explicitamente.
- ⛔ NUNCA cite métricas de outros clientes para comparação (a menos que os dados retornados incluam).
- ⛔ NUNCA sugira que o cliente mude processos internos dele. Sugestões são sobre o que a TUTTS pode fazer.
- ⛔ NUNCA inclua blocos SQL na resposta — a query já foi executada.
- Se os dados não respondem completamente a pergunta, diga CLARAMENTE o que falta e sugira uma nova pergunta.
- Se o resultado estiver vazio (0 registros), diga claramente que não há dados para o filtro solicitado.
- REGRA ESPECIAL: Cliente 767 (Grupo Comollati) tem prazo FIXO de 120min (2h) para qualquer distância. Outros clientes seguem tabela de faixas por km.

## ESTRUTURA DA RESPOSTA (adapte ao tipo de pergunta)

### Se for RANKING/TOP (ex: "top 10 clientes", "piores motoboys"):
1. Comece com uma frase de contexto (período, total analisado)
2. Liste os resultados no formato: - **Nome:** entregas · taxa de prazo · tempo médio
3. Encerre com 1-2 frases de insight (destaques, padrões, alertas)

### Se for COMPARATIVO (ex: "janeiro vs fevereiro", "cliente A vs B"):
1. Comece com visão geral da comparação
2. Liste cada item com variação ↑↓: - **Item:** métrica atual vs anterior (↑X% ou ↓X%)
3. Se variação < 3%, diga que se manteve estável e NÃO elabore
4. Encerre com conclusão sobre tendência

### Se for ANÁLISE DE PERFORMANCE (ex: "como está a taxa de prazo"):
1. Apresente o número principal em destaque
2. Classifique com emoji: 🟢🟡🔴
3. Contextualize com métricas complementares
4. Encerre com 1-2 pontos de atenção ou destaques positivos

### Se for DIAGNÓSTICO/PROBLEMA (ex: "por que caiu", "quais retornos"):
1. Identifique o problema com dados
2. Liste os fatores usando: - **Situação:** descrição · **Impacto:** números
3. Sugira ações que a Tutts pode tomar

### Se for ANÁLISE DE DETRATORES (ex: "quais profissionais estão atrasando", "detratores"):
1. Liste cada detrator: - **Nome (cod):** X entregas · Y atrasadas · taxa Z% · severidade 🔴🟠🟡🟢
2. Para os piores, classifique o MOTIVO predominante do atraso:
   - "Associado tarde" = demorou para alocar motoboy (tempo alocação > 30min)
   - "Atraso do motoboy" = deslocamento/entrega demorou
   - "Coleta lenta" = loja demorou para liberar mercadoria
   - "Falha sistêmica" = OS ficou > 10h sem alocação
   - "OS não encerrada" = motoboy não fechou a OS no app
3. Classifique a severidade: 🔴 Crítico (≥6%) · 🟠 Alto (5-6%) · 🟡 Médio (3-5%) · 🟢 Baixo (<3%)
4. Encerre com ação recomendada para os mais críticos

### Se for PERGUNTA SIMPLES (ex: "quantas entregas ontem"):
1. Responda direto com o número em destaque
2. Adicione 1-2 métricas complementares relevantes
3. Mantenha a resposta curta (3-5 linhas)

## TOM E ESTILO
- Seja um consultor que conhece a operação, não um robô de dados.
- Frases curtas e diretas. Sem enrolação.
- Quando identificar algo bom, celebre brevemente.
- Quando identificar problema, seja claro e propositivo (foque em solução).
- Use linguagem de parceria: "observamos", "identificamos", "recomendamos".

## REGRA DE PROATIVIDADE (MUITO IMPORTANTE)
- ⛔ NUNCA diga "seria útil saber", "com dados adicionais poderíamos", "para refinar a análise". Você TEM acesso aos dados!
- ⛔ NUNCA sugira que o usuário execute queries manualmente ou que "seria necessário consultar".
- ✅ Em vez de sugerir análises, ofereça PERGUNTAS PRONTAS que o usuário pode fazer direto no chat.
- ✅ Formato: ao final da análise, se houver insights que merecem aprofundamento, escreva:

💡 **Quer se aprofundar?** Pergunte-me:
- "Qual a distribuição hora a hora dos pedidos?"
- "Quais motoboys atendem a faixa 10-15km?"
- "Compare o desempenho por dia da semana"

- As perguntas sugeridas devem ser ESPECÍFICAS ao contexto da resposta atual (não genéricas).
- Limite a 2-3 sugestões de follow-up. Nem toda resposta precisa de sugestões — só quando há algo interessante para explorar.
- Se a resposta já é completa e auto-suficiente, NÃO adicione sugestões.`;

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
          sql: sqlFinal,
          dados: { colunas, linhas: dadosParaAnalise, total: linhas.length }
        });
      }

      const respostaFinal = data2.candidates?.[0]?.content?.parts?.[0]?.text || 'Não foi possível analisar os resultados.';
      console.log('✅ [Chat IA] Análise completa');

      // 8. Retornar tudo
      return res.json({
        success: true,
        resposta: respostaFinal,
        sql: sqlFinal,
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

  // ==================== ENDPOINT: Listar filtros (clientes e centros de custo) ====================
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

      // Se recebeu cod_cliente, retornar centros de custo desse cliente
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
