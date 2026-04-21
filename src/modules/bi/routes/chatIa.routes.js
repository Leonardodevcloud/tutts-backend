/**
 * BI Sub-Router: Chat IA — Analista de Dados Conversacional
 * v6.0 — Filtros obrigatórios reforçados, campo de contexto/treinamento,
 *         gráficos interativos expandidos, IA mais inteligente
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
    // BI Core
    'bi_entregas', 'bi_upload_historico', 'bi_relatorios_ia',
    'bi_prazos_cliente', 'bi_faixas_prazo', 'bi_prazo_padrao',
    'bi_prazos_prof_cliente', 'bi_faixas_prazo_prof', 'bi_prazo_prof_padrao',
    'bi_regioes', 'bi_regras_contagem', 'bi_mascaras',
    'bi_resumo_cliente', 'bi_resumo_diario', 'bi_resumo_geral', 'bi_resumo_profissional',
    'bi_garantido_cache', 'garantido_status',
    // CS
    'cs_clientes', 'cs_interacoes', 'cs_ocorrencias', 'cs_raio_x_historico', 'cs_config',
    // CRM
    'crm_alocacoes', 'crm_leads_capturados', 'crm_ativadores', 'crm_alocacao_clientes', 'crm_alocacao_alocadores', 'crm_captura_jobs',
    // Operacional
    'operacoes', 'operacoes_faixas_km',
    'disponibilidade_linhas', 'disponibilidade_lojas', 'disponibilidade_regioes',
    // Score / Gamificação
    'score_totais', 'score_historico', 'score_conquistas', 'score_gratuidades',
    // Loja
    'loja_produtos', 'loja_pedidos', 'loja_estoque',
    // Financeiro
    'withdrawal_requests', 'gratuities', 'financial_logs', 'user_financial_data',
    // Solicitações
    'solicitacoes_corrida', 'solicitacoes_pontos', 'clientes_solicitacao',
    // Filas
    'filas_centrais', 'filas_posicoes', 'filas_penalidades', 'filas_historico', 'filas_regioes',
    // Disponibilidade extra
    'disponibilidade_em_loja', 'disponibilidade_espelho', 'disponibilidade_faltosos',
    // Gerencial
    'gerencial_sla_grupos',
    // Performance
    'performance_snapshots', 'performance_jobs', 'performance_config',
    // Coleta
    'coleta_enderecos_pendentes', 'coleta_motoboy_ganhos', 'coleta_regioes',
    // Social
    'social_profiles',
    // Uber
    'uber_entregas', 'uber_config', 'uber_regras_cliente'
  ];

  // ==================== MIGRATION: TABELA DE CONTEXTO ====================
  async function initChatIaTables() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bi_chat_contexto (
          id SERIAL PRIMARY KEY,
          titulo VARCHAR(200) NOT NULL,
          conteudo TEXT NOT NULL,
          categoria VARCHAR(50) DEFAULT 'geral',
          ativo BOOLEAN DEFAULT true,
          prioridade INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bi_chat_conversas (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(100) NOT NULL,
          titulo VARCHAR(200),
          filtros TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bi_chat_mensagens (
          id SERIAL PRIMARY KEY,
          conversa_id INT REFERENCES bi_chat_conversas(id),
          role VARCHAR(20) NOT NULL,
          content TEXT,
          sql_executado TEXT,
          dados_resumo TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bi_chat_memorias (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(100) NOT NULL,
          conteudo TEXT NOT NULL,
          ativo BOOLEAN DEFAULT true,
          origem VARCHAR(20) DEFAULT 'auto',
          prompt_origem TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Migration: adicionar colunas se tabela já existia sem elas
      await pool.query(`ALTER TABLE bi_chat_memorias ADD COLUMN IF NOT EXISTS origem VARCHAR(20) DEFAULT 'auto'`).catch(() => {});
      await pool.query(`ALTER TABLE bi_chat_memorias ADD COLUMN IF NOT EXISTS prompt_origem TEXT`).catch(() => {});
      console.log('✅ [Chat IA v6] Tabelas verificadas/criadas');
    } catch (e) {
      console.error('⚠️ [Chat IA v6] Erro init tables:', e.message);
    }
  }
  initChatIaTables();

  // ==================== CHAMAR GEMINI ====================
  async function chamarGemini(messages, systemPrompt, opts = {}) {
    const { temperature = 0.4, maxTokens = 65536 } = opts;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurada');

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

    console.log(`📡 [Chat IA v6] Chamando Gemini (${messages.length} msgs, temp=${temperature})...`);

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`❌ [Chat IA v6] Gemini HTTP ${resp.status}:`, errText);
      
      // Auto-retry para rate limit (429) — espera e tenta de novo até 2x
      if (resp.status === 429) {
        const retryMatch = errText.match(/retry.*?(\d+\.?\d*)\s*s/i);
        const waitSecs = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 15;
        console.log(`⏳ [Chat IA v6] Rate limit — aguardando ${waitSecs}s antes do retry...`);
        await new Promise(r => setTimeout(r, waitSecs * 1000));
        
        console.log(`🔄 [Chat IA v6] Retry após 429...`);
        const resp2 = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        );
        if (!resp2.ok) {
          const errText2 = await resp2.text();
          console.error(`❌ [Chat IA v6] Retry também falhou: HTTP ${resp2.status}`);
          throw new Error(`Gemini API HTTP ${resp2.status} (após retry): ${errText2.substring(0, 200)}`);
        }
        const data2 = await resp2.json();
        const text2 = data2.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const tokens2 = data2.usageMetadata?.totalTokenCount || 0;
        console.log(`✅ [Chat IA v6] Retry OK (${text2.length} chars, ${tokens2} tokens)`);
        return text2;
      }
      
      throw new Error(`Gemini API HTTP ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();
    if (data.error) {
      console.error(`❌ [Chat IA v6] Gemini error:`, data.error);
      throw new Error(`Gemini API: ${data.error.message}`);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokensUsados = data.usageMetadata?.totalTokenCount || 0;

    console.log(`✅ [Chat IA v6] Gemini respondeu (${text.length} chars, ${tokensUsados} tokens)`);
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
    } catch (e) { console.error('⚠️ [Chat IA v6] Erro amostras:', e.message); }
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

    const sqlSemExtract = sqlLimpo.replace(/EXTRACT\s*\([^)]*\)/gi, '').replace(/DATE_PART\s*\([^)]*\)/gi, '').replace(/DATE_TRUNC\s*\([^)]*\)/gi, '');
    const tabelasUsadas = sqlSemExtract.toUpperCase().match(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
    for (const match of tabelasUsadas) {
      const tabela = match.replace(/^(FROM|JOIN)\s+/i, '').trim().toLowerCase();
      if (tabela && !TABELAS_PERMITIDAS.includes(tabela) && !tabela.startsWith('(') && tabela !== 'generate_series')
        return { valido: false, erro: `Tabela "${tabela}" não autorizada.` };
    }

    const tabelasSensiveis = ['users', 'user_financial_data', 'financial_logs', 'withdrawal_requests',
      'withdrawal_idempotency', 'gratuities', 'restricted_professionals', 'indicacoes', 'indicacao_links',
      'login_attempts', 'user_sessions', 'stark_lotes', 'stark_lote_itens'];
    const sqlLower = sqlLimpo.toLowerCase();
    for (const ts of tabelasSensiveis) {
      if (sqlLower.includes(ts)) {
        return { valido: false, erro: `Acesso à tabela "${ts}" não permitido no Chat IA.` };
      }
    }

    if (/\bpg_\w+/i.test(sqlLimpo) || /\binformation_schema\b/i.test(sqlLimpo)) {
      return { valido: false, erro: 'Acesso a tabelas do sistema não permitido.' };
    }

    if (!sqlLimpo.toUpperCase().includes('LIMIT')) sqlLimpo += ' LIMIT 1000';
    return { valido: true, sql: sqlLimpo };
  }

  // ==================== INJEÇÃO DE FILTROS NO SQL ====================
  /**
   * v6.0 FIX CRÍTICO: Após a IA gerar o SQL, verificamos se os filtros obrigatórios
   * estão presentes. Se não estiverem, injetamos automaticamente.
   */
  function injetarFiltrosNoSQL(sql, filtrosObrigatorios) {
    if (!filtrosObrigatorios || !filtrosObrigatorios.clausulas || filtrosObrigatorios.clausulas.length === 0) return sql;

    const sqlUpper = sql.toUpperCase();

    // Para cada cláusula obrigatória, verificar se já está presente
    const clausulasFaltantes = [];
    for (const clausula of filtrosObrigatorios.clausulas) {
      // Filtro inteligente de região (cliente + centro mapeado)
      if (clausula.tipo === 'cliente_centro_map') {
        const temFiltro = sqlUpper.includes('COD_CLIENTE');
        if (!temFiltro) {
          const partes = [];
          const clientesSemCentro = [];
          for (const [cod, centros] of Object.entries(clausula.mapa)) {
            const codInt = parseInt(cod);
            if (isNaN(codInt)) continue;
            if (centros && centros.length > 0) {
              const centrosSQL = centros.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
              partes.push(`(cod_cliente = ${codInt} AND centro_custo IN (${centrosSQL}))`);
            } else {
              clientesSemCentro.push(codInt);
            }
          }
          if (clientesSemCentro.length > 0) {
            partes.push(`cod_cliente IN (${clientesSemCentro.join(',')})`);
          }
          if (partes.length > 0) {
            clausulasFaltantes.push(`(${partes.join(' OR ')})`);
          }
        }
        continue; // Pula os checks de cod_cliente e centro_custo separados
      }
      // Verificar por cod_cliente
      if (clausula.tipo === 'cod_cliente') {
        const codsStr = clausula.valores.join(',');
        // Checa variações: cod_cliente = X, cod_cliente IN (X,Y), e.cod_cliente, etc.
        const temFiltro = sqlUpper.includes('COD_CLIENTE') && (
          sqlUpper.includes(String(clausula.valores[0])) ||
          sqlUpper.includes('COD_CLIENTE = ') ||
          sqlUpper.includes('COD_CLIENTE IN')
        );
        if (!temFiltro) {
          if (clausula.valores.length === 1) {
            clausulasFaltantes.push(`cod_cliente = ${clausula.valores[0]}`);
          } else {
            clausulasFaltantes.push(`cod_cliente IN (${codsStr})`);
          }
        }
      }
      // Verificar por centro_custo
      if (clausula.tipo === 'centro_custo') {
        const temFiltro = sqlUpper.includes('CENTRO_CUSTO');
        if (!temFiltro) {
          if (clausula.valores.length === 1) {
            clausulasFaltantes.push(`centro_custo = '${clausula.valores[0].replace(/'/g, "''")}'`);
          } else {
            clausulasFaltantes.push(`centro_custo IN (${clausula.valores.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`);
          }
        }
      }
      // Verificar por data
      if (clausula.tipo === 'periodo') {
        const temData = sqlUpper.includes('DATA_SOLICITADO') && (
          sqlUpper.includes('BETWEEN') || sqlUpper.includes(clausula.inicio) || sqlUpper.includes('>') 
        );
        if (!temData) {
          clausulasFaltantes.push(`data_solicitado BETWEEN '${clausula.inicio}' AND '${clausula.fim}'`);
        }
      }
    }

    if (clausulasFaltantes.length === 0) return sql;

    console.log(`⚠️ [Chat IA v6] Injetando ${clausulasFaltantes.length} filtro(s) faltante(s) no SQL`);

    // Estratégia de injeção: encontrar WHERE e adicionar, ou encontrar o primeiro FROM e adicionar WHERE
    const injecao = clausulasFaltantes.join(' AND ');

    // Se tem CTE (WITH), precisamos injetar em cada SELECT que referencia bi_entregas
    if (sql.toUpperCase().trimStart().startsWith('WITH')) {
      // Injetar em cada bloco que tenha bi_entregas
      return sql.replace(/(FROM\s+bi_entregas\b(?:\s+\w+)?)(\s+WHERE\s+)/gi, `$1$2${injecao} AND `)
                .replace(/(FROM\s+bi_entregas\b(?:\s+\w+)?)(\s+(?:GROUP|ORDER|LIMIT|HAVING|\)|$))/gi, `$1 WHERE ${injecao} $2`);
    }

    // SQL simples
    if (sqlUpper.includes('WHERE')) {
      // Adicionar após o primeiro WHERE
      return sql.replace(/WHERE\s+/i, `WHERE ${injecao} AND `);
    } else {
      // Adicionar WHERE antes de GROUP BY, ORDER BY, LIMIT, ou no final
      const insertPoint = sql.search(/\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING)\b/i);
      if (insertPoint > -1) {
        return sql.substring(0, insertPoint) + ` WHERE ${injecao} ` + sql.substring(insertPoint);
      }
      // Antes do LIMIT final se existir
      return sql.replace(/(\s+LIMIT\s+\d+)/i, ` WHERE ${injecao} $1`);
    }
  }

  // ==================== EXECUTAR SQL COM INJEÇÃO DE FILTROS ====================
  async function executarSQL(sql, filtrosObrigatorios) {
    const validacao = validarSQL(sql);
    if (!validacao.valido) return { success: false, erro: validacao.erro, sql };

    // v6.0: Injetar filtros faltantes
    let sqlFinal = validacao.sql;
    if (filtrosObrigatorios) {
      sqlFinal = injetarFiltrosNoSQL(sqlFinal, filtrosObrigatorios);
    }

    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      const result = await client.query(sqlFinal);
      await client.query('SET statement_timeout = 0');
      return { success: true, rows: result.rows, fields: result.fields?.map(f => f.name) || [], rowCount: result.rowCount, sql: sqlFinal };
    } catch (sqlError) {
      await client.query('SET statement_timeout = 0').catch(() => {});
      return { success: false, erro: sqlError.message, sql: sqlFinal };
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
      console.error('⚠️ [Chat IA v6] Erro buscar memórias:', e.message);
      return [];
    }
  }

  async function detectarESalvarMemorias(userId, prompt, resposta) {
    try {
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

      const existentes = await pool.query(
        `SELECT conteudo FROM bi_chat_memorias WHERE user_id = $1 AND ativo = true`,
        [userId]
      );

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) return;

      const memoriasAtuais = existentes.rows.map(r => r.conteudo).join('\n');

      const systemText = `Você extrai preferências e instruções de conversas. Responda APENAS com a memória a ser salva, em uma frase curta e direta. Se não houver preferência/instrução clara, responda exatamente "NENHUMA".\n\nMemórias já salvas deste usuário:\n${memoriasAtuais || '(nenhuma)'}\n\nSe a nova instrução é igual ou parecida com alguma já salva, responda "NENHUMA" para evitar duplicatas.`;

      const extractResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `O gestor disse: "${prompt}"\n\nExtraia a preferência/instrução em uma frase curta (máx 100 chars).` }] }],
            systemInstruction: { parts: [{ text: systemText }] },
            generationConfig: { temperature: 0, maxOutputTokens: 300 }
          })
        }
      );

      const extractData = await extractResp.json();
      const memoria = extractData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (memoria && memoria !== 'NENHUMA' && memoria.length > 5 && memoria.length < 200) {
        await pool.query(`INSERT INTO bi_chat_memorias (user_id, conteudo, origem, prompt_origem) VALUES ($1, $2, 'auto', $3)`, [userId, memoria, prompt]);
        console.log(`🧠 [Chat IA v6] Nova memória AUTO salva: "${memoria}"`);
      }
    } catch (e) {
      console.error('⚠️ [Chat IA v6] Erro detectar memória:', e.message);
    }
  }

  // ==================== CONTEXTO CUSTOMIZADO ====================
  async function getContextoCustomizado() {
    try {
      const result = await pool.query(
        `SELECT titulo, conteudo, categoria FROM bi_chat_contexto WHERE ativo = true ORDER BY prioridade DESC, created_at ASC`
      );
      if (result.rows.length === 0) return '';
      let texto = '\n# INSTRUÇÕES CUSTOMIZADAS DO GESTOR (seguir OBRIGATORIAMENTE):\n';
      for (const row of result.rows) {
        texto += `\n### ${row.titulo}${row.categoria !== 'geral' ? ` [${row.categoria}]` : ''}\n${row.conteudo}\n`;
      }
      return texto;
    } catch (e) {
      console.error('⚠️ [Chat IA v6] Erro contexto custom:', e.message);
      return '';
    }
  }

  // ==================== SYSTEM PROMPT ====================
  function buildSystemPrompt(schemaTexto, samplesTexto, contextoFiltros, memorias, contextoCustom, filtrosObrigatorios) {
    const memoriasTexto = memorias && memorias.length > 0
      ? `\nVocê já conhece esse gestor. Coisas que ele já te disse em conversas anteriores:\n${memorias.map(m => `- ${m}`).join('\n')}\nLeve isso em conta nas suas respostas.\n`
      : '';

    // v6.0: Bloco de filtros muito mais explícito e agressivo
    let blocoFiltros = '';
    if (contextoFiltros && filtrosObrigatorios?.clausulas?.length > 0) {
      const sqlParts = [];
      for (const c of filtrosObrigatorios.clausulas) {
        if (c.tipo === 'cod_cliente') {
          sqlParts.push(c.valores.length === 1 ? `cod_cliente = ${c.valores[0]}` : `cod_cliente IN (${c.valores.join(',')})`);
        }
        if (c.tipo === 'centro_custo') {
          sqlParts.push(c.valores.length === 1 ? `centro_custo = '${c.valores[0]}'` : `centro_custo IN (${c.valores.map(v => `'${v}'`).join(',')})`);
        }
        if (c.tipo === 'periodo') {
          sqlParts.push(`data_solicitado BETWEEN '${c.inicio}' AND '${c.fim}'`);
        }
      }
      const whereCompleto = `WHERE COALESCE(ponto, 1) >= 2 AND ${sqlParts.join(' AND ')}`;

      blocoFiltros = `
╔══════════════════════════════════════════════════════════════════╗
║                    ⚠️ FILTROS OBRIGATÓRIOS ⚠️                    ║
║                                                                  ║
║  O gestor está vendo dados FILTRADOS. Toda SQL gerada            ║
║  DEVE conter TODAS as condições abaixo, sem exceção:             ║
║                                                                  ║
║  ${whereCompleto.padEnd(62)}║
║                                                                  ║
║  Se você gerar SQL sem esses filtros, os dados estarão           ║
║  INCORRETOS e o gestor verá informações de OUTROS clientes.      ║
║                                                                  ║
║  ❌ ERRADO: SELECT ... FROM bi_entregas WHERE ponto >= 2         ║
║  ✅ CERTO:  SELECT ... FROM bi_entregas ${whereCompleto.substring(0, 40)}...    ║
║                                                                  ║
║  Em CTEs (WITH), CADA subconsulta que acessa bi_entregas         ║
║  DEVE ter esses filtros.                                         ║
╚══════════════════════════════════════════════════════════════════╝

Contexto do filtro ativo:
${contextoFiltros}`;
    } else {
      blocoFiltros = 'Sem filtros ativos — consulta TODOS os dados.';
    }

    return `Você é um analista de dados sênior da Tutts, uma empresa de logística de entregas com motoboys em Salvador/BA. O cara que tá falando com você é o gestor da operação — seu colega de trabalho.
${memoriasTexto}
PERSONALIDADE:
- Fale como colega do dia a dia. "A gente", "nossos motoboys", "essa semana foi puxada".
- Dados PRIMEIRO. Número na frente, contexto depois.
- Se ele perguntar conceito, explica em linguagem de negócio. Sem termos técnicos de banco.
- Se não tem certeza, pergunta. "Tu quer finalizadas ou inclui canceladas?"
- Mantém o fio da conversa. Se ele pediu faturamento e depois diz "agora por motoboy", sabe do que ele tá falando.
- NUNCA mostre SQL, nomes de colunas, ou termos de programação. Isso é bastidor.
- NUNCA invente dados. Se não achou, diz "não encontrei dados pra isso no período".
- NUNCA termine com "posso ajudar?" ou sugestões genéricas. Responde e pronto.

╔══════════════════════════════════════════════════════════════════╗
║              🚨 REGRA CRÍTICA: SQL OBRIGATÓRIA 🚨               ║
║                                                                  ║
║  PRIORIDADE 1: Use os DADOS PRÉ-CARREGADOS que vêm no prompt.   ║
║  Eles são dados REAIS do banco. Analise-os diretamente.          ║
║                                                                  ║
║  PRIORIDADE 2: Se a pergunta precisa de dados que NÃO estão      ║
║  nos dados pré-carregados (ex: filtro específico, cruzamento     ║
║  incomum, detalhe por endereço), gere SQL com \`\`\`sql ... \`\`\` ║
║                                                                  ║
║  ❌ PROIBIDO: Inventar números que não estão nos dados            ║
║  ❌ PROIBIDO: Arredondar ou "ajustar" os dados reais              ║
║  ✅ CORRETO: Citar os números exatos dos dados pré-carregados     ║
║  ✅ CORRETO: Gerar SQL apenas quando os dados não cobrem          ║
╚══════════════════════════════════════════════════════════════════╝

COMO FUNCIONA — Fluxo Técnico (interno):
1. Gestor pergunta algo → Você gera SQL dentro de \`\`\`sql ... \`\`\`
2. O sistema executa e te devolve o resultado em JSON
3. Você analisa os dados e responde ao gestor de forma natural
4. Se precisar de GRÁFICO, use o formato [CHART]...[/CHART] (detalhes abaixo)

═══════════════════════════════════════════════════════════════
DICIONÁRIO DE DADOS — bi_entregas (tabela principal, ~200k+ linhas)
═══════════════════════════════════════════════════════════════
IDENTIFICADORES:
  os (INT)             → Número da OS (ordem de serviço). Uma OS pode ter múltiplos pontos.
  ponto (INT)          → 1=coleta, 2+=entrega. REGRA: Sempre filtre ponto >= 2 para entregas.
  num_pedido (VARCHAR)  → Número do pedido/nota fiscal do cliente.

CLIENTE:
  cod_cliente (INT)     → Código do cliente.
  nome_cliente (VARCHAR)→ Nome do cliente.
  centro_custo (VARCHAR)→ Subdivisão do cliente (filial, loja, etc).
  empresa (VARCHAR)     → Razão social.
  nome_fantasia (VARCHAR)→ Nome fantasia.

PROFISSIONAL (MOTOBOY):
  cod_prof (INT)        → Código do profissional.
  nome_prof (VARCHAR)   → Nome do profissional.

DATAS E HORÁRIOS:
  data_solicitado (DATE) → Data em que a entrega foi solicitada. USE ESTA para filtrar por período.
  hora_solicitado (TIME) → Hora da solicitação.
  data_hora (TIMESTAMP)  → Timestamp completo da solicitação.
  data_hora_alocado (TIMESTAMP) → Quando o motoboy foi alocado.
  data_chegada (DATE)    → Data que o motoboy chegou ao ponto.
  hora_chegada (TIME)    → Hora que chegou.
  finalizado (TIMESTAMP) → Quando finalizou a entrega.

LOCALIZAÇÃO:
  endereco (TEXT)       → Endereço completo de entrega.
  bairro (VARCHAR)      → Bairro.
  cidade (VARCHAR)      → Cidade.
  estado (VARCHAR)      → UF.
  cidade_p1 (VARCHAR)   → Cidade da coleta (ponto 1).
  distancia (DECIMAL)   → Distância em KM.

FINANCEIRO:
  valor (DECIMAL)       → Valor cobrado do cliente.
  valor_prof (DECIMAL)  → Valor pago ao profissional.
  * FATURAMENTO = valor - valor_prof (calcular na query).
  * ⚠️ Para somar valores, SEMPRE use DISTINCT ON (os) ORDER BY ponto ASC
    para pegar só o ponto 1 de cada OS (evita duplicar).

PERFORMANCE / SLA:
  dentro_prazo (BOOLEAN) → TRUE se a entrega foi feita dentro do prazo do CLIENTE.
  prazo_minutos (INT)    → Prazo configurado para aquele cliente em minutos.
  tempo_execucao_minutos (INT) → Tempo real da entrega em minutos.
  dentro_prazo_prof (BOOLEAN)  → TRUE se dentro do prazo do PROFISSIONAL.
  prazo_prof_minutos (INT)     → Prazo configurado para o profissional.
  tempo_execucao_prof_minutos (INT) → Tempo real vs prazo profissional.

STATUS:
  status (VARCHAR)      → Status da entrega (ex: "Finalizado").
  motivo (VARCHAR)      → Motivo de finalização.
  ocorrencia (VARCHAR)  → Tipo de ocorrência (retorno, insucesso, etc).
  categoria (VARCHAR)   → Categoria do serviço (moto, carro, etc).

═══════════════════════════════════════════════════════════════
FÓRMULAS SQL CORRETAS (use exatamente assim):
═══════════════════════════════════════════════════════════════
-- Taxa de prazo (SLA):
ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) AS taxa_prazo

-- Fora de prazo:
COUNT(*) FILTER (WHERE dentro_prazo = false) AS fora_prazo

-- Tempo médio em minutos:
ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) AS tempo_medio_min

-- Faturamento por OS (sem duplicar):
WITH faturamento AS (
  SELECT DISTINCT ON (os) os, valor, valor_prof
  FROM bi_entregas WHERE ponto >= 2 AND ...filtros...
  ORDER BY os, ponto ASC
)
SELECT SUM(valor) as val_total, SUM(valor_prof) as val_prof, SUM(valor - valor_prof) as faturamento FROM faturamento

-- Retornos:
COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%') AS retornos

-- Contagem de entregas vs OS:
COUNT(*) as total_entregas, COUNT(DISTINCT os) as total_os

REGRAS SQL ADICIONAIS (interno — nunca exponha):
- Só entregas: WHERE COALESCE(ponto, 1) >= 2
- Sempre LIMIT (máx 500)
- Divisões: NULLIF(x, 0)
- NUNCA faça SUM(valor) direto sem DISTINCT ON — duplica valores
- Se precisar de dados por dia, agrupe por data_solicitado
- Clientes: nome_fantasia. Profissionais: nome_prof
- Só tabelas do schema abaixo

${blocoFiltros}
${contextoCustom || ''}

Schema e dados de referência (interno):
${schemaTexto}
${samplesTexto}

Regras de negócio:
${KNOWLEDGE_BASE}

GRÁFICOS — Formato [CHART]...[/CHART]:
Quando os dados se beneficiarem de visualização, gere gráficos usando o formato abaixo. USE BASTANTE quando fizer sentido — o gestor gosta de ver os dados visualmente.

Tipos suportados: bar, horizontalBar, line, pie, doughnut, area, radar, stackedBar, combo

FORMATO:
[CHART]
{"type":"bar","title":"Título do Gráfico","labels":["Label1","Label2"],"datasets":[{"label":"Série 1","data":[10,20],"color":"#10b981"}],"options":{"showValues":true,"stacked":false,"legend":true}}
[/CHART]

Cores sugeridas: #10b981 (verde), #3b82f6 (azul), #f59e0b (amarelo), #ef4444 (vermelho), #8b5cf6 (roxo), #14b8a6 (teal), #f97316 (laranja), #ec4899 (rosa)

Dicas de gráficos:
- Use bar/horizontalBar pra comparações (ranking de motoboys, clientes)
- Use line pra evolução temporal (prazo dia a dia, entregas por semana)
- Use doughnut/pie pra proporções (% dentro/fora prazo, distribuição de categorias)
- Use stackedBar pra composição (entregas dentro/fora prazo por motoboy)
- Use combo pra eixo duplo (ex: entregas em barras + taxa prazo em linha)
- Use radar pra comparar múltiplas métricas de um profissional
- showValues: true mostra o valor em cima de cada barra
- SEMPRE gere gráfico quando tiver dados temporais, rankings, ou distribuições
- Para combos: datasets com type diferente: [{"label":"Entregas","data":[...],"color":"#3b82f6","type":"bar"},{"label":"Taxa","data":[...],"color":"#ef4444","type":"line","yAxisID":"y1"}]

Formatação de texto:
- **negrito** pra destacar números
- 🟢 acima da meta | 🟡 marginal | 🔴 abaixo da meta
- Valores: R$ 1.234,56 (formato brasileiro)
- Use tabelas markdown quando comparar 3+ itens
- Use emojis com moderação pra destacar status`;
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

      return `\n# AMOSTRA REAL DOS DADOS (${result.rows.length} registros recentes do filtro ativo):\n\`\`\`json\n${JSON.stringify(result.rows, null, 2)}\n\`\`\`\n`;
    } catch (e) {
      console.error('⚠️ [Chat IA v6] Erro amostra:', e.message);
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

    if (nomeRegiao) contexto += `Região selecionada: ${nomeRegiao}\n`;

    if (codClientes.length === 1) {
      contexto += `Cliente: ${nomeCliente || 'cod ' + codClientes[0]} (cod_cliente = ${codClientes[0]})\n`;
    } else if (codClientes.length > 1) {
      const nomes = filtros?.nomes_clientes || codClientes.map(c => 'cod ' + c).join(', ');
      contexto += `Clientes (${codClientes.length}): ${nomes} — cod_cliente IN (${codClientes.join(',')})\n`;
    }

    if (centrosCusto.length === 1) {
      contexto += `Centro de custo: ${centrosCusto[0]}\n`;
    } else if (centrosCusto.length > 1) {
      contexto += `Centros de custo (${centrosCusto.length}): ${centrosCusto.join(', ')}\n`;
    }

    if (dataInicio && dataFim) {
      contexto += `Período: ${dataInicio} até ${dataFim}\n`;
    }

    return contexto;
  }

  /**
   * v6.0: Gera estrutura de filtros obrigatórios para injeção automática em SQL
   */
  function montarFiltrosObrigatorios(filtros) {
    const clausulas = [];

    const codClientes = filtros?.cod_cliente
      ? (Array.isArray(filtros.cod_cliente) ? filtros.cod_cliente : [filtros.cod_cliente]).map(c => parseInt(c)).filter(c => !isNaN(c))
      : [];
    const centrosCusto = filtros?.centro_custo
      ? (Array.isArray(filtros.centro_custo) ? filtros.centro_custo : [filtros.centro_custo]).filter(c => c && c.trim())
      : [];
    // Mapa cliente → centros (se disponível da região)
    const clienteCentroMap = filtros?.cliente_centro_map || null;

    if (codClientes.length > 0) {
      if (clienteCentroMap && Object.keys(clienteCentroMap).length > 0) {
        // Região com mapeamento: gera filtro inteligente por cliente
        clausulas.push({ tipo: 'cliente_centro_map', mapa: clienteCentroMap });
      } else if (centrosCusto.length > 0 && codClientes.length === 1) {
        // 1 cliente + centros específicos
        clausulas.push({ tipo: 'cod_cliente', valores: codClientes });
        clausulas.push({ tipo: 'centro_custo', valores: centrosCusto });
      } else {
        // Múltiplos clientes sem mapa OU sem centros → só filtra por cliente
        clausulas.push({ tipo: 'cod_cliente', valores: codClientes });
      }
    }
    if (filtros?.data_inicio && filtros?.data_fim) {
      clausulas.push({ tipo: 'periodo', inicio: filtros.data_inicio, fim: filtros.data_fim });
    }

    return { clausulas };
  }
  
  /**
   * Monta WHERE SQL para filtro de região com mapeamento cliente↔centro.
   * Ex: { "767": ["Pellegrino SSA", "Goiânia"], "1072": [], "949": [] }
   * → ((cod_cliente=767 AND centro_custo IN ('Pellegrino SSA','Goiânia')) OR cod_cliente IN (1072,949))
   */
  function montarWhereClienteCentro(mapa, paramIdx) {
    const partes = [];
    const params = [];
    const clientesSemCentro = [];
    
    for (const [cod, centros] of Object.entries(mapa)) {
      const codInt = parseInt(cod);
      if (isNaN(codInt)) continue;
      
      if (centros && centros.length > 0) {
        // Cliente com centro específico
        const centroPlaceholders = centros.map(() => `$${paramIdx++}`);
        partes.push(`(cod_cliente = $${paramIdx++} AND centro_custo IN (${centroPlaceholders.join(',')}))`);
        params.push(...centros, codInt);
      } else {
        // Cliente sem centro → todos os centros
        clientesSemCentro.push(codInt);
      }
    }
    
    if (clientesSemCentro.length > 0) {
      const placeholders = clientesSemCentro.map(() => `$${paramIdx++}`);
      partes.push(`cod_cliente IN (${placeholders.join(',')})`);
      params.push(...clientesSemCentro);
    }
    
    return { sql: partes.length > 0 ? `(${partes.join(' OR ')})` : 'TRUE', params, nextIdx: paramIdx };
  }

  // ========================================================================
  //  PRÉ-CARREGAMENTO DE DADOS (chamado ao "Iniciar Conversa")
  //  Carrega TODOS os dados do período filtrado de uma vez.
  //  O frontend armazena e envia em cada mensagem como contexto.
  // ========================================================================
  router.post('/bi/chat-ia/pre-carregar', async (req, res) => {
    try {
      let { filtros } = req.body;
      if (!filtros) return res.status(400).json({ error: 'Filtros são obrigatórios' });

      // Expansão de região — só se o frontend NÃO mandou cod_cliente já expandido
      if (filtros.regiao && !filtros._regiao_expandida && (!filtros.cod_cliente || filtros.cod_cliente.length === 0)) {
        try {
          const rr = await pool.query('SELECT nome, clientes FROM bi_regioes WHERE id = $1', [parseInt(filtros.regiao)]);
          if (rr.rows.length > 0) {
            const itens = typeof rr.rows[0].clientes === 'string' ? JSON.parse(rr.rows[0].clientes) : rr.rows[0].clientes;
            if (Array.isArray(itens)) {
              filtros.cod_cliente = [...new Set(itens.map(i => typeof i === 'number' ? i : parseInt(i.cod_cliente)).filter(c => !isNaN(c)))];
              filtros._regiao_expandida = true;
            }
          }
        } catch (e) {}
      }

      const wherePartes = ['COALESCE(ponto, 1) >= 2'];
      const queryParams = [];
      let paramIdx = 1;

      // Mapa cliente→centro (da região) OU filtro simples
      const clienteCentroMap = filtros.cliente_centro_map || null;
      
      if (clienteCentroMap && Object.keys(clienteCentroMap).length > 0) {
        // Região com mapeamento inteligente
        const ccResult = montarWhereClienteCentro(clienteCentroMap, paramIdx);
        wherePartes.push(ccResult.sql);
        queryParams.push(...ccResult.params);
        paramIdx = ccResult.nextIdx;
      } else if (filtros.cod_cliente?.length > 0) {
        const ids = filtros.cod_cliente.map(c => parseInt(c)).filter(c => !isNaN(c));
        if (ids.length > 0) {
          wherePartes.push(`cod_cliente IN (${ids.map(() => `$${paramIdx++}`).join(',')})`);
          queryParams.push(...ids);
        }
        if (filtros.centro_custo?.length > 0 && ids.length <= 1) {
          wherePartes.push(`centro_custo IN (${filtros.centro_custo.map(() => `$${paramIdx++}`).join(',')})`);
          queryParams.push(...filtros.centro_custo);
        }
      }
      if (filtros.data_inicio && filtros.data_fim) {
        wherePartes.push(`data_solicitado BETWEEN $${paramIdx++} AND $${paramIdx++}`);
        queryParams.push(filtros.data_inicio, filtros.data_fim);
      }

      const WHERE = wherePartes.join(' AND ');
      const t0 = Date.now();
      console.log(`📊 [Pre-load] WHERE: ${WHERE} | params: ${JSON.stringify(queryParams)}`);

      const [resumo, porCliente, porDia, porProfissional, porCategoria, faturamento, porCC, porHora, porOcorrencia] = await Promise.all([
        // 1. Resumo geral
        pool.query(`SELECT 
          COUNT(DISTINCT os) as total_os, COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min,
          ROUND(AVG(EXTRACT(EPOCH FROM (data_hora_alocado - data_hora)) / 60) FILTER (WHERE data_hora_alocado IS NOT NULL AND data_hora IS NOT NULL AND data_hora_alocado > data_hora), 0) as tempo_medio_alocacao_min,
          COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%') as retornos,
          COUNT(DISTINCT cod_prof) as total_profissionais,
          MIN(data_solicitado) as data_inicio, MAX(data_solicitado) as data_fim
        FROM bi_entregas WHERE ${WHERE}`, queryParams),

        // 2. Por cliente (todos)
        pool.query(`SELECT 
          cod_cliente, nome_cliente,
          COUNT(DISTINCT os) as total_os, COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min,
          ROUND(AVG(distancia) FILTER (WHERE distancia > 0), 1) as distancia_media_km,
          COUNT(DISTINCT cod_prof) as profissionais,
          COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%') as retornos
        FROM bi_entregas WHERE ${WHERE}
        GROUP BY cod_cliente, nome_cliente ORDER BY COUNT(*) DESC`, queryParams),

        // 3. Por dia
        pool.query(`SELECT 
          data_solicitado as dia,
          COUNT(DISTINCT os) as total_os, COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min,
          COUNT(DISTINCT cod_prof) as profissionais
        FROM bi_entregas WHERE ${WHERE}
        GROUP BY data_solicitado ORDER BY data_solicitado`, queryParams),

        // 4. Top 30 profissionais
        pool.query(`SELECT 
          cod_prof, nome_prof,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min,
          ROUND(AVG(distancia) FILTER (WHERE distancia > 0), 1) as distancia_media_km
        FROM bi_entregas WHERE ${WHERE}
        GROUP BY cod_prof, nome_prof ORDER BY COUNT(*) DESC LIMIT 30`, queryParams),

        // 5. Por categoria
        pool.query(`SELECT 
          COALESCE(categoria, 'Sem categoria') as categoria,
          COUNT(*) as total, 
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo
        FROM bi_entregas WHERE ${WHERE}
        GROUP BY categoria ORDER BY COUNT(*) DESC`, queryParams),

        // 6. Faturamento
        pool.query(`WITH fat AS (
          SELECT DISTINCT ON (os) os, valor, valor_prof
          FROM bi_entregas WHERE ${WHERE}
          ORDER BY os, ponto ASC
        ) SELECT 
          ROUND(COALESCE(SUM(valor), 0), 2) as valor_total,
          ROUND(COALESCE(SUM(valor_prof), 0), 2) as valor_prof_total,
          ROUND(COALESCE(SUM(valor - valor_prof), 0), 2) as faturamento,
          ROUND(COALESCE(AVG(valor), 0), 2) as ticket_medio
        FROM fat`, queryParams),

        // 7. Por centro de custo
        pool.query(`SELECT 
          cod_cliente, nome_cliente, centro_custo,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min
        FROM bi_entregas WHERE ${WHERE} AND centro_custo IS NOT NULL
        GROUP BY cod_cliente, nome_cliente, centro_custo ORDER BY cod_cliente, COUNT(*) DESC LIMIT 60`, queryParams),

        // 8. Por hora do dia
        pool.query(`SELECT 
          EXTRACT(HOUR FROM data_hora)::int as hora,
          COUNT(*) as total
        FROM bi_entregas WHERE ${WHERE} AND data_hora IS NOT NULL
        GROUP BY EXTRACT(HOUR FROM data_hora) ORDER BY hora`, queryParams),

        // 9. Por ocorrência/motivo
        pool.query(`SELECT 
          COALESCE(ocorrencia, 'Normal') as ocorrencia,
          COUNT(*) as total,
          ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER(), 0), 1) as percentual
        FROM bi_entregas WHERE ${WHERE}
        GROUP BY ocorrencia ORDER BY COUNT(*) DESC LIMIT 15`, queryParams)
      ]);

      const rg = resumo.rows[0] || {};
      const fat = faturamento.rows[0] || {};
      const tempo = Date.now() - t0;

      // Montar texto completo
      const texto = `
═══════════════════════════════════════════════════════════════
📊 DADOS COMPLETOS DO PERÍODO (carregados em ${tempo}ms do banco de dados)
ESTES são os dados REAIS. Use-os para responder QUALQUER pergunta.
NÃO invente, NÃO arredonde, NÃO altere nenhum número.
Se a pergunta não pode ser respondida com estes dados, gere SQL.
═══════════════════════════════════════════════════════════════

PERÍODO: ${rg.data_inicio || 'N/A'} a ${rg.data_fim || 'N/A'}

RESUMO GERAL:
  Total OS: ${rg.total_os || 0} | Total Entregas: ${rg.total_entregas || 0}
  Dentro prazo: ${rg.dentro_prazo || 0} | Fora prazo: ${rg.fora_prazo || 0} | Taxa SLA: ${rg.taxa_prazo || 0}%
  Tempo médio entrega: ${rg.tempo_medio_min || 0} min | Tempo médio alocação: ${rg.tempo_medio_alocacao_min || 0} min
  Retornos: ${rg.retornos || 0} | Profissionais ativos: ${rg.total_profissionais || 0}

FINANCEIRO:
  Valor total cliente: R$ ${parseFloat(fat.valor_total || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}
  Valor profissional: R$ ${parseFloat(fat.valor_prof_total || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}
  Faturamento (lucro): R$ ${parseFloat(fat.faturamento || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}
  Ticket médio: R$ ${parseFloat(fat.ticket_medio || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}

POR CLIENTE (${porCliente.rows.length}):
${porCliente.rows.map(c => `  ${c.cod_cliente} - ${c.nome_cliente}: ${c.total_entregas} entregas, OS=${c.total_os}, prazo=${c.taxa_prazo}%, fora=${c.fora_prazo}, tempo=${c.tempo_medio_min}min, km=${c.distancia_media_km}, retornos=${c.retornos}, profs=${c.profissionais}`).join('\n')}

EVOLUÇÃO DIÁRIA (${porDia.rows.length} dias):
${porDia.rows.map(d => `  ${d.dia}: ${d.total_entregas} entregas, OS=${d.total_os}, prazo=${d.taxa_prazo}%, fora=${d.fora_prazo}, tempo=${d.tempo_medio_min}min, profs=${d.profissionais}`).join('\n')}

TOP PROFISSIONAIS (${porProfissional.rows.length}):
${porProfissional.rows.map(p => `  ${p.cod_prof} - ${p.nome_prof}: ${p.total_entregas} entregas, prazo=${p.taxa_prazo}%, fora=${p.fora_prazo}, tempo=${p.tempo_medio_min}min, km=${p.distancia_media_km}`).join('\n')}

POR CATEGORIA:
${porCategoria.rows.map(c => `  ${c.categoria}: ${c.total} entregas, prazo=${c.taxa_prazo}%`).join('\n')}

${porCC.rows.length > 0 ? `POR CENTRO DE CUSTO (${porCC.rows.length}):
${porCC.rows.map(c => `  ${c.cod_cliente} ${c.nome_cliente} | ${c.centro_custo}: ${c.total_entregas} entregas, prazo=${c.taxa_prazo}%, fora=${c.fora_prazo}, tempo=${c.tempo_medio_min}min`).join('\n')}` : ''}

DISTRIBUIÇÃO POR HORA:
${porHora.rows.map(h => `  ${String(h.hora).padStart(2, '0')}h: ${h.total} entregas`).join('\n')}

OCORRÊNCIAS / MOTIVOS:
${porOcorrencia.rows.map(o => `  ${o.ocorrencia}: ${o.total} (${o.percentual}%)`).join('\n')}
`;

      console.log(`📊 [Pre-load] OK em ${tempo}ms — ${rg.total_entregas} entregas, ${porCliente.rows.length} clientes, ${porDia.rows.length} dias, ${porProfissional.rows.length} profs`);
      res.json({ success: true, dados_contexto: texto, tempo_ms: tempo, resumo: { total_entregas: rg.total_entregas, total_clientes: porCliente.rows.length, total_dias: porDia.rows.length } });

    } catch (err) {
      console.error('❌ [Pre-load] Erro:', err.message);
      res.status(500).json({ error: 'Erro ao pré-carregar dados: ' + err.message });
    }
  });

  // ========================================================================
  //  ENDPOINT PRINCIPAL
  // ========================================================================
  router.post('/bi/chat-ia', async (req, res) => {
    try {
      const { prompt, historico, filtros, conversa_id, dados_contexto } = req.body;
      if (!prompt || prompt.trim().length < 3) return res.status(400).json({ error: 'Prompt deve ter pelo menos 3 caracteres.' });
      if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY não configurada.' });

      console.log(`🔍 [Chat IA v6] dados_contexto recebido: ${dados_contexto ? dados_contexto.length + ' chars' : 'NENHUM'}`);
      console.log(`🔍 [Chat IA v6] filtros recebidos: cod_cliente=[${(filtros?.cod_cliente||[]).join(',')}] centro_custo=[${(filtros?.centro_custo||[]).join(',')}] regiao=${filtros?.regiao||'N/A'} periodo=${filtros?.data_inicio||'?'} a ${filtros?.data_fim||'?'}`);

      // ═══ Expansão de Região → Clientes ═══
      // Se o frontend já mandou cod_cliente expandido, NÃO re-expandir
      if (filtros && filtros.regiao && !filtros._regiao_expandida && (!filtros.cod_cliente || filtros.cod_cliente.length === 0)) {
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
              if (centros.length > 0 && centros.length < codClientes.length * 3) filtros.centro_custo = centros;
              try {
                const nomesResult = await pool.query(
                  `SELECT DISTINCT cod_cliente, nome_fantasia FROM bi_entregas WHERE cod_cliente = ANY($1) AND nome_fantasia IS NOT NULL`,
                  [codClientes]
                );
                filtros.nomes_clientes = nomesResult.rows.map(r => r.nome_fantasia || ('cod ' + r.cod_cliente)).join(', ');
              } catch (e) { filtros.nomes_clientes = codClientes.map(c => 'cod ' + c).join(', '); }
              filtros._regiao_expandida = true;
              console.log(`🗺️ [Chat IA v6] Região "${regiao.nome}" expandida para ${codClientes.length} clientes`);
            }
          }
        } catch (errRegiao) {
          console.warn('⚠️ [Chat IA v6] Erro ao expandir região:', errRegiao.message);
        }
      }

      console.log(`\n🤖 [Chat IA v6] Prompt: "${prompt.substring(0, 100)}"`);
      console.log(`   Filtros: ${JSON.stringify(filtros || {}).substring(0, 200)}`);
      console.log(`   Histórico: ${historico?.length || 0} msgs`);

      const contextoFiltros = montarContextoFiltros(filtros);
      const filtrosObrigatorios = montarFiltrosObrigatorios(filtros || {});
      const userId = req.user?.id || req.user?.userId || 'anonymous';

      let schema, samples, amostra, memorias, contextoCustom;
      try {
        [schema, samples, amostra, memorias, contextoCustom] = await Promise.all([
          getSchema(), getSamples(), getAmostraReal(filtros), getMemoriasUsuario(userId), getContextoCustomizado()
        ]);
      } catch (dbErr) {
        console.error('❌ [Chat IA v6] Erro schema/samples:', dbErr.message);
        return res.status(500).json({ error: 'Erro banco: ' + dbErr.message });
      }

      if (memorias.length > 0) console.log(`🧠 [Chat IA v6] ${memorias.length} memória(s) do usuário carregadas`);
      if (contextoCustom) console.log(`📋 [Chat IA v6] Contexto customizado carregado`);

      const systemPrompt = buildSystemPrompt(
        formatarSchema(schema), formatarSamples(samples) + amostra,
        contextoFiltros, memorias, contextoCustom, filtrosObrigatorios
      );

      const messages = [];
      if (historico?.length > 0) {
        for (const h of historico) {
          if (h.prompt) messages.push({ role: 'user', content: h.prompt });
          if (h.resposta) messages.push({ role: 'assistant', content: h.resposta });
        }
      }

      // ═══════════════════════════════════════════════════════════
      // ETAPA 0: DADOS REAIS
      // Se o frontend mandou dados_contexto (pré-carregado no "Iniciar"),
      // usa direto. Senão, faz pré-load rápido como fallback.
      // ═══════════════════════════════════════════════════════════
      let dadosPreCarregados = dados_contexto || '';
      
      if (!dadosPreCarregados) {
        // Fallback: pré-load rápido (caso o frontend não tenha mandado)
        try {
        const wherePartes = ['COALESCE(ponto, 1) >= 2'];
        const queryParams = [];
        let paramIdx = 1;

        const ccMap = filtros.cliente_centro_map || null;
        if (ccMap && Object.keys(ccMap).length > 0) {
          const ccResult = montarWhereClienteCentro(ccMap, paramIdx);
          wherePartes.push(ccResult.sql);
          queryParams.push(...ccResult.params);
          paramIdx = ccResult.nextIdx;
        } else if (filtros.cod_cliente?.length > 0) {
          const clienteIds = filtros.cod_cliente.map(c => parseInt(c)).filter(c => !isNaN(c));
          if (clienteIds.length > 0) {
            wherePartes.push(`cod_cliente IN (${clienteIds.map(() => `$${paramIdx++}`).join(',')})`);
            queryParams.push(...clienteIds);
          }
          if (filtros.centro_custo?.length > 0 && clienteIds.length <= 1) {
            wherePartes.push(`centro_custo IN (${filtros.centro_custo.map(() => `$${paramIdx++}`).join(',')})`);
            queryParams.push(...filtros.centro_custo);
          }
        }
        if (filtros.data_inicio && filtros.data_fim) {
          wherePartes.push(`data_solicitado BETWEEN $${paramIdx++} AND $${paramIdx++}`);
          queryParams.push(filtros.data_inicio, filtros.data_fim);
        }
        if (filtros.regiao) {
          wherePartes.push(`bairro ILIKE $${paramIdx++}`);
          queryParams.push(`%${filtros.regiao}%`);
        }

        const WHERE = wherePartes.join(' AND ');
        const t0 = Date.now();
        
        console.log(`📊 [Chat IA v6] Pre-load WHERE: ${WHERE}`);
        console.log(`📊 [Chat IA v6] Pre-load params: ${JSON.stringify(queryParams)}`);

        // Executar 6 queries em paralelo
        const [resumoGeral, porCliente, porDia, porProfissional, porCategoria, faturamento, porCentroCusto] = await Promise.all([
          // 1. Resumo geral
          pool.query(`SELECT 
            COUNT(DISTINCT os) as total_os,
            COUNT(*) as total_entregas,
            COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
            COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
            ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
            ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min,
            COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%') as retornos,
            COUNT(DISTINCT cod_prof) as total_profissionais
          FROM bi_entregas WHERE ${WHERE}`, queryParams),

          // 2. Por cliente
          pool.query(`SELECT 
            cod_cliente, nome_cliente,
            COUNT(DISTINCT os) as total_os, COUNT(*) as total_entregas,
            COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
            COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
            ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
            ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min,
            COUNT(DISTINCT cod_prof) as profissionais
          FROM bi_entregas WHERE ${WHERE}
          GROUP BY cod_cliente, nome_cliente ORDER BY COUNT(*) DESC LIMIT 30`, queryParams),

          // 3. Por dia
          pool.query(`SELECT 
            data_solicitado as dia,
            COUNT(DISTINCT os) as total_os, COUNT(*) as total_entregas,
            COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
            COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
            ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
            ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min
          FROM bi_entregas WHERE ${WHERE}
          GROUP BY data_solicitado ORDER BY data_solicitado LIMIT 60`, queryParams),

          // 4. Top profissionais
          pool.query(`SELECT 
            cod_prof, nome_prof,
            COUNT(*) as total_entregas,
            COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
            ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo,
            ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) as tempo_medio_min
          FROM bi_entregas WHERE ${WHERE}
          GROUP BY cod_prof, nome_prof ORDER BY COUNT(*) DESC LIMIT 20`, queryParams),

          // 5. Por categoria
          pool.query(`SELECT 
            COALESCE(categoria, 'Sem categoria') as categoria,
            COUNT(*) as total, 
            ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo
          FROM bi_entregas WHERE ${WHERE}
          GROUP BY categoria ORDER BY COUNT(*) DESC LIMIT 10`, queryParams),

          // 6. Faturamento (com DISTINCT ON para não duplicar)
          pool.query(`WITH fat AS (
            SELECT DISTINCT ON (os) os, valor, valor_prof
            FROM bi_entregas WHERE ${WHERE}
            ORDER BY os, ponto ASC
          ) SELECT 
            ROUND(COALESCE(SUM(valor), 0), 2) as valor_total,
            ROUND(COALESCE(SUM(valor_prof), 0), 2) as valor_prof_total,
            ROUND(COALESCE(SUM(valor) - SUM(valor_prof), 0), 2) as faturamento,
            ROUND(COALESCE(AVG(valor), 0), 2) as ticket_medio,
            COUNT(*) as total_os_fat
          FROM fat`, queryParams),

          // 7. Por centro de custo
          pool.query(`SELECT 
            cod_cliente, nome_cliente, centro_custo,
            COUNT(*) as total_entregas,
            COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
            COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
            ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_prazo
          FROM bi_entregas WHERE ${WHERE} AND centro_custo IS NOT NULL
          GROUP BY cod_cliente, nome_cliente, centro_custo ORDER BY cod_cliente, COUNT(*) DESC LIMIT 50`, queryParams)
        ]);

        // Formatar dados para o prompt
        const rg = resumoGeral.rows[0] || {};
        const fat = faturamento.rows[0] || {};
        dadosPreCarregados = `
═══════════════════════════════════════════════════════════
📊 DADOS REAIS PRÉ-CARREGADOS (fonte: banco de dados, ${Date.now() - t0}ms)
Use ESTES dados para responder. NÃO invente números diferentes.
═══════════════════════════════════════════════════════════

RESUMO GERAL:
  Total OS: ${rg.total_os || 0} | Total Entregas: ${rg.total_entregas || 0}
  Dentro prazo: ${rg.dentro_prazo || 0} | Fora prazo: ${rg.fora_prazo || 0} | Taxa: ${rg.taxa_prazo || 0}%
  Tempo médio: ${rg.tempo_medio_min || 0} min | Retornos: ${rg.retornos || 0}
  Profissionais: ${rg.total_profissionais || 0}

FINANCEIRO:
  Valor total: R$ ${parseFloat(fat.valor_total || 0).toLocaleString('pt-BR')} | Valor profissional: R$ ${parseFloat(fat.valor_prof_total || 0).toLocaleString('pt-BR')}
  Faturamento (lucro): R$ ${parseFloat(fat.faturamento || 0).toLocaleString('pt-BR')} | Ticket médio: R$ ${parseFloat(fat.ticket_medio || 0).toLocaleString('pt-BR')}

POR CLIENTE (${porCliente.rows.length} clientes):
${porCliente.rows.map(c => `  ${c.cod_cliente} - ${c.nome_cliente}: ${c.total_entregas} entregas, prazo=${c.taxa_prazo}%, tempo=${c.tempo_medio_min}min, fora=${c.fora_prazo}, profs=${c.profissionais}`).join('\n')}

POR DIA (${porDia.rows.length} dias):
${porDia.rows.map(d => `  ${d.dia}: ${d.total_entregas} entregas, prazo=${d.taxa_prazo}%, fora=${d.fora_prazo}, tempo=${d.tempo_medio_min}min`).join('\n')}

TOP PROFISSIONAIS (${porProfissional.rows.length}):
${porProfissional.rows.map(p => `  ${p.cod_prof} - ${p.nome_prof}: ${p.total_entregas} entregas, prazo=${p.taxa_prazo}%, tempo=${p.tempo_medio_min}min`).join('\n')}

POR CATEGORIA:
${porCategoria.rows.map(c => `  ${c.categoria}: ${c.total} entregas, prazo=${c.taxa_prazo}%`).join('\n')}

${porCentroCusto.rows.length > 0 ? `POR CENTRO DE CUSTO (${porCentroCusto.rows.length}):
${porCentroCusto.rows.map(c => `  ${c.cod_cliente} - ${c.nome_cliente} | ${c.centro_custo}: ${c.total_entregas} entregas, prazo=${c.taxa_prazo}%, fora=${c.fora_prazo}`).join('\n')}` : ''}
`;
        console.log(`📊 [Chat IA v6] Dados pré-carregados em ${Date.now() - t0}ms (${porCliente.rows.length} clientes, ${porDia.rows.length} dias, ${porProfissional.rows.length} profs, ${porCentroCusto.rows.length} CCs, resumo: ${rg.total_entregas} entregas)`);

      } catch (preErr) {
        console.error('⚠️ [Chat IA v6] Erro ao pré-carregar dados:', preErr.message);
        dadosPreCarregados = '\n⚠️ Não foi possível pré-carregar dados. Use SQL para buscar.\n';
      }
      } else {
        console.log(`📊 [Chat IA v6] Usando dados pré-carregados do frontend (${dadosPreCarregados.length} chars)`);
      }

      // Injetar dados no prompt do usuário
      const promptComFiltros = contextoFiltros
        ? `[FILTROS ATIVOS: ${contextoFiltros.split('\n').filter(l => !l.startsWith('SQL')).join(' | ').trim()}]\n${dadosPreCarregados}\n${prompt}`
        : `${dadosPreCarregados}\n${prompt}`;
      messages.push({ role: 'user', content: promptComFiltros });

      // ETAPA 1: Gerar resposta (a IA já tem os dados reais — pode responder direto OU gerar SQL para queries específicas)
      let resposta1;
      try {
        resposta1 = await chamarGemini(messages, systemPrompt, { temperature: 0.3, maxTokens: 65536 });
      } catch (iaErr) {
        console.error('❌ [Chat IA v6] Erro Gemini:', iaErr.message);
        return res.status(500).json({ error: 'Erro IA: ' + iaErr.message });
      }

      const sqlBlocks = [];
      const sqlRegex = /```sql\n?([\s\S]*?)\n?```/g;
      let match;
      while ((match = sqlRegex.exec(resposta1)) !== null) sqlBlocks.push(match[1].trim());

      if (sqlBlocks.length === 0) {
        // Com dados pré-carregados, resposta direta é esperada e legítima
        if (dadosPreCarregados && dadosPreCarregados.length > 100) {
          console.log('✅ [Chat IA v6] Resposta direta (baseada em dados pré-carregados)');
          if (conversa_id) await salvarMensagem(conversa_id, prompt, resposta1, null, null);
          detectarESalvarMemorias(userId, prompt, resposta1).catch(() => {});
          return res.json({ success: true, resposta: resposta1, sql: null, dados: null });
        }
        
        // Sem dados pré-carregados: detectar se a resposta contém dados numéricos (tabelas inventadas)
        const temDadosSuspeitos = (
          (resposta1.match(/\d{2,}/g) || []).length > 5 &&
          (resposta1.includes('|') || resposta1.includes('100.00') || resposta1.match(/\d+\.\d{2}/g)?.length > 3)
        );
        
        if (temDadosSuspeitos) {
          console.log('⚠️ [Chat IA v6] Resposta direta com dados suspeitos — forçando SQL...');
          try {
            const retryMsgs = [...messages, { role: 'assistant', content: resposta1 }, {
              role: 'user',
              content: 'ATENÇÃO: Você respondeu com dados sem executar SQL e sem dados pré-carregados. Gere obrigatoriamente um bloco ```sql com a query correta para buscar esses dados da tabela bi_entregas. NUNCA invente números.'
            }];
            const resp2 = await chamarGemini(retryMsgs, systemPrompt, { temperature: 0.2, maxTokens: 65536 });
            const r2 = /```sql\n?([\s\S]*?)\n?```/g;
            let m2, temSQL = false;
            while ((m2 = r2.exec(resp2)) !== null) {
              sqlBlocks.push(m2[1].trim());
              temSQL = true;
            }
            if (temSQL) {
              resposta1 = resp2;
              console.log(`🔄 [Chat IA v6] Retry gerou ${sqlBlocks.length} SQL(s) — executando...`);
            } else {
              console.log('⚠️ [Chat IA v6] Retry sem SQL — bloqueando dados inventados');
              return res.json({ success: true, resposta: '⚠️ Não consegui consultar os dados reais. Reformula a pergunta.', sql: null, dados: null });
            }
          } catch (e) {
            console.error('❌ [Chat IA v6] Erro no retry anti-alucinação:', e.message);
            return res.json({ success: true, resposta: '⚠️ Erro ao buscar dados. Tenta de novo.', sql: null, dados: null });
          }
        } else {
          console.log('✅ [Chat IA v6] Resposta direta');
          if (conversa_id) await salvarMensagem(conversa_id, prompt, resposta1, null, null);
          detectarESalvarMemorias(userId, prompt, resposta1).catch(() => {});
          return res.json({ success: true, resposta: resposta1, sql: null, dados: null });
        }
      }

      // ETAPA 2: Executar SQLs (com injeção de filtros)
      console.log(`🔄 [Chat IA v6] ${sqlBlocks.length} SQL(s)...`);
      const todosResultados = [];
      const todasColunas = new Set();
      const sqlsExecutadas = [];
      const erros = [];

      for (const bloco of sqlBlocks) {
        const queries = bloco.split(/;\s*/).filter(q => { const t = q.trim().toUpperCase(); return t.startsWith('SELECT') || t.startsWith('WITH'); });
        for (const sql of queries) {
          const resultado = await executarSQL(sql.trim(), filtrosObrigatorios);
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

      // Retry se todas falharam
      if (todosResultados.length === 0 && erros.length > 0) {
        console.log('🔄 [Chat IA v6] Retry...');
        try {
          const retryMsgs = [...messages, { role: 'assistant', content: resposta1 }, {
            role: 'user',
            content: `ERRO: As queries SQL falharam:\n${erros.join('\n')}\n\n╔══════════════════════════════════════════╗\n║ REGRAS ABSOLUTAS PARA O RETRY:          ║\n║ 1. Use APENAS a tabela: bi_entregas     ║\n║ 2. NUNCA invente dados ou tabelas       ║\n║ 3. Se não sabe a coluna, NÃO use        ║\n║ 4. Colunas válidas: os, cod_cliente,    ║\n║    nome_cliente, cod_prof, nome_prof,    ║\n║    data_solicitado, data_hora, valor,    ║\n║    valor_prof, dentro_prazo, distancia,  ║\n║    ponto, centro_custo, categoria,       ║\n║    tempo_execucao_minutos, ocorrencia,   ║\n║    data_chegada, hora_chegada, finalizado║\n╚══════════════════════════════════════════╝\n${filtrosObrigatorios.clausulas.length > 0 ? `\n⚠️ FILTROS OBRIGATÓRIOS: ${filtrosObrigatorios.clausulas.map(c => c.tipo + '=' + (c.valores || [c.inicio]).join(',')).join(', ')}` : ''}\n\nGere a SQL correta usando APENAS as colunas listadas acima. Responda SOMENTE com o bloco \`\`\`sql.`
          }];
          const resp2 = await chamarGemini(retryMsgs, systemPrompt, { temperature: 0.2, maxTokens: 65536 });
          const r2 = /```sql\n?([\s\S]*?)\n?```/g;
          let m2;
          while ((m2 = r2.exec(resp2)) !== null) {
            const res2 = await executarSQL(m2[1].trim(), filtrosObrigatorios);
            if (res2.success) { res2.rows.forEach(r => todosResultados.push(r)); res2.fields.forEach(f => todasColunas.add(f)); sqlsExecutadas.push(res2.sql); }
          }
          if (todosResultados.length === 0) {
            return res.json({ success: true, resposta: '⚠️ Não consegui consultar os dados. Tenta reformular a pergunta de outra forma.', sql: null, dados: null });
          }
        } catch (e) {
          return res.json({ success: true, resposta: '⚠️ Erro na consulta. Tenta reformular.', sql: null, dados: null });
        }
      }

      // ETAPA 3: Analisar resultados (temperatura mais alta para texto natural)
      const dadosParaAnalise = todosResultados.slice(0, 500);
      console.log(`🧠 [Chat IA v6] Analisando ${todosResultados.length} registros...`);

      let respostaFinal;
      try {
        const analiseMsgs = [...messages, { role: 'assistant', content: resposta1 }, {
          role: 'user',
          content: `Resultado SQL (${todosResultados.length} registros${todosResultados.length > 500 ? ', mostrando 500' : ''}):\n\n\`\`\`json\n${JSON.stringify(dadosParaAnalise, null, 2).substring(0, 100000)}\n\`\`\`\n\nAnalise e responda ao gestor. NÃO inclua SQL. Se fizer sentido, inclua gráfico(s) com [CHART]...[/CHART]. Use gráficos generosamente quando os dados se beneficiarem de visualização.`
        }];
        respostaFinal = await chamarGemini(analiseMsgs, systemPrompt, { temperature: 0.7, maxTokens: 65536 });
      } catch (e) {
        respostaFinal = `Encontrei ${todosResultados.length} registros, mas tive um problema na análise. Os dados estão aí embaixo.`;
      }

      const sqlFinal = sqlsExecutadas.join(';\n\n');
      if (conversa_id) await salvarMensagem(conversa_id, prompt, respostaFinal, sqlFinal, { total: todosResultados.length });
      detectarESalvarMemorias(userId, prompt, respostaFinal).catch(() => {});

      console.log('✅ [Chat IA v6] OK');
      return res.json({
        success: true,
        resposta: respostaFinal,
        sql: sqlFinal,
        dados: { colunas: [...todasColunas], linhas: dadosParaAnalise, total: todosResultados.length }
      });
    } catch (err) {
      console.error('❌ [Chat IA v6] ERRO:', err);
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
        `SELECT id, conteudo, origem, prompt_origem, created_at FROM bi_chat_memorias WHERE user_id = $1 AND ativo = true ORDER BY created_at DESC`,
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
        `INSERT INTO bi_chat_memorias (user_id, conteudo, origem) VALUES ($1, $2, 'manual') RETURNING *`,
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
  //  CONTEXTO CUSTOMIZADO (TREINAMENTO DA IA) — v6.0 NEW
  // ========================================================================
  router.get('/bi/chat-ia/contexto', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, titulo, conteudo, categoria, ativo, prioridade, created_at, updated_at FROM bi_chat_contexto ORDER BY prioridade DESC, created_at ASC`
      );
      res.json({ success: true, contextos: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/bi/chat-ia/contexto', async (req, res) => {
    try {
      const { titulo, conteudo, categoria, prioridade } = req.body;
      if (!titulo || titulo.trim().length < 3) return res.status(400).json({ error: 'Título muito curto' });
      if (!conteudo || conteudo.trim().length < 5) return res.status(400).json({ error: 'Conteúdo muito curto' });
      const result = await pool.query(
        `INSERT INTO bi_chat_contexto (titulo, conteudo, categoria, prioridade) VALUES ($1, $2, $3, $4) RETURNING *`,
        [titulo.trim(), conteudo.trim(), categoria || 'geral', prioridade || 0]
      );
      res.json({ success: true, contexto: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put('/bi/chat-ia/contexto/:id', async (req, res) => {
    try {
      const { titulo, conteudo, categoria, prioridade, ativo } = req.body;
      const result = await pool.query(
        `UPDATE bi_chat_contexto SET titulo = COALESCE($1, titulo), conteudo = COALESCE($2, conteudo), categoria = COALESCE($3, categoria), prioridade = COALESCE($4, prioridade), ativo = COALESCE($5, ativo), updated_at = NOW() WHERE id = $6 RETURNING *`,
        [titulo, conteudo, categoria, prioridade, ativo, req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
      res.json({ success: true, contexto: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/bi/chat-ia/contexto/:id', async (req, res) => {
    try {
      await pool.query(`DELETE FROM bi_chat_contexto WHERE id = $1`, [req.params.id]);
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
