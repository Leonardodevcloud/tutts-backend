/**
 * agents/bi-import.agent.js
 * Worker do pool — processa fila bi_imports.
 *
 * 2 modos combinados em 1 agente:
 *  - Cron diário 10h (TZ America/Bahia): cria job D-1 (origem='cron') e processa
 *  - Fila pendente: pega jobs origem='manual' criados via endpoint
 *
 * Cron usa INSERT idempotente (UNIQUE INDEX da migration impede duplicação).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { defineAgent } = require('../core/agent-base');
const playwrightLib    = require('../playwright-bi-export');
const { processarArquivo } = require('../processar-planilha-bi');

const SLOTS = Number(process.env.POOL_BI_IMPORT_SLOTS || 1);
const CRON_DEFAULT = '0 10 * * *';  // 10h diário

// URL base do próprio backend (pra POST interno em /bi/entregas/upload)
// Em produção: BACKEND_INTERNAL_URL=http://tutts-backend.railway.internal:3000
// Local: http://localhost:3000
const BACKEND_URL = () => (
  process.env.BACKEND_INTERNAL_URL ||
  process.env.BACKEND_URL ||
  'http://localhost:3000'
).replace(/\/$/, '');

/**
 * Calcula data D-1 no formato YYYY-MM-DD (TZ America/Bahia)
 */
function calcularDataD1() {
  // America/Bahia é UTC-3 fixo (sem horário de verão)
  const agora = new Date();
  const bahiaMs = agora.getTime() - (3 * 60 * 60 * 1000);
  const bahia = new Date(bahiaMs);
  bahia.setUTCDate(bahia.getUTCDate() - 1);
  return bahia.toISOString().slice(0, 10);
}

/**
 * Faz POST com JSON pro endpoint interno do BI.
 * Retorna { ok, status, body }
 */
function postJsonInterno(pathUrl, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BACKEND_URL() + pathUrl);
    const dados = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dados),
        // 2026-04 v3: header pra bypass do CSRF + verificarToken no backend principal.
        // Backend valida que o secret bate com INTERNAL_SECRET (env)
        ...(process.env.INTERNAL_SECRET ? { 'x-internal-secret': process.env.INTERNAL_SECRET } : {}),
        // Token Bearer opcional (se um dia adicionarem auth extra)
        ...(process.env.BACKEND_INTERNAL_TOKEN ? { 'Authorization': `Bearer ${process.env.BACKEND_INTERNAL_TOKEN}` } : {}),
      },
      timeout: 600_000,  // 10min — payload pode ser GRANDE (~3000 linhas)
    };

    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout 10min postando ao endpoint BI')); });
    req.write(dados);
    req.end();
  });
}

/**
 * Cria job 'cron' do dia (idempotente — UNIQUE INDEX impede duplicação).
 * Retorna o registro criado, ou null se já existia (caiu na unique).
 */
async function criarJobCronSeNaoExistir(pool, dataReferencia) {
  try {
    const { rows } = await pool.query(`
      INSERT INTO bi_imports (data_referencia, origem, status, usuario_nome)
      VALUES ($1, 'cron', 'pendente', 'Sistema (cron 10h)')
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [dataReferencia]);
    if (rows.length > 0) {
      console.log(`[bi-import] 📅 Job cron criado pra ${dataReferencia}, id=${rows[0].id}`);
      return rows[0];
    }
    console.log(`[bi-import] ⏭️ Job cron pra ${dataReferencia} já existe, pulando`);
    return null;
  } catch (err) {
    console.error(`[bi-import] ❌ Erro criando job cron:`, err.message);
    return null;
  }
}

module.exports = defineAgent({
  nome: 'bi-import',
  slots: SLOTS,
  sessionStrategy: 'isolada',
  intervalo: 30_000,
  // 2026-04 fix: removido cronExpression daqui — o agente roda em modo PARALELO
  // (pega jobs pendentes da fila bi_imports). O cron 10h continua existindo,
  // mas é gerenciado externamente em index.js que CRIA o job, e este worker
  // apenas processa.
  // timezone: 'America/Bahia',

  // ── Cron 10h: cria job D-1 e deixa o tickGlobal/buscarPendentes processar
  // (defineAgent suporta cron OU paralelo, não ambos. Vamos usar PARALELO
  //  com buscarPendentes E rodar uma função SEPARADA pra cron.
  //  → MAS o agent-pool registra cron OU paralelo. Solução: agente paralelo +
  //  iniciar cron próprio dentro de habilitado/init)
  // Decisão: deixar como PARALELO (pega bi_imports pendentes), e iniciar
  //  o cron de criação no init do módulo (index.js).

  buscarPendentes: async (pool, _limite) => {
    const { rows } = await pool.query(`
      SELECT * FROM bi_imports
      WHERE status = 'pendente'
      ORDER BY criado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return rows[0] || null;
  },

  marcarProcessando: async (pool, registro) => {
    await pool.query(
      `UPDATE bi_imports SET status = 'processando' WHERE id = $1`,
      [registro.id]
    );
  },

  processar: async (pool, registro, ctx) => {
    ctx.log(`📥 Job ${registro.id} | data=${registro.data_referencia} | origem=${registro.origem}`);

    // Aplica overrides (sessão isolada por slot)
    const overrides = ctx.overrides || {};
    if (overrides.credentials || overrides.sessionFile) {
      playwrightLib.setOverrides(overrides);
    }

    try {
      // 1. Baixar planilha do sistema externo
      const dataRef = (typeof registro.data_referencia === 'string')
        ? registro.data_referencia
        : registro.data_referencia.toISOString().slice(0, 10);

      const exportRes = await playwrightLib.executarExportBI({
        dataReferencia: dataRef,
        onProgresso: (etapa, pct) => {
          // Mapear progresso 0-100 do Playwright pra 0-70 do job total
          // (deixa 70-100 pro processamento + envio)
          const progAjustado = Math.round(pct * 0.7);
          pool.query(
            `UPDATE bi_imports SET etapa_atual = $1, progresso = $2 WHERE id = $3`,
            [etapa, progAjustado, registro.id]
          ).catch(() => {});
        },
      });

      if (!exportRes.sucesso) {
        await pool.query(`
          UPDATE bi_imports
             SET status = 'falhou', erro = $1, finalizado_em = NOW(),
                 screenshot_path = $2
           WHERE id = $3
        `, [exportRes.erro.slice(0, 500), exportRes.screenshot_path || null, registro.id]);
        ctx.log(`❌ Falhou no Playwright: ${exportRes.erro}`);
        return;
      }

      const arquivoPath = exportRes.arquivo_path;
      ctx.log(`📁 Arquivo baixado: ${arquivoPath}`);
      await pool.query(
        `UPDATE bi_imports SET arquivo_path = $1 WHERE id = $2`,
        [arquivoPath, registro.id]
      );

      // 2. Processar (lê xlsx, aplica tratamento Power Query)
      await pool.query(
        `UPDATE bi_imports SET etapa_atual = 'processando_planilha', progresso = 75 WHERE id = $1`,
        [registro.id]
      );
      const { total, entregas } = processarArquivo(arquivoPath);
      ctx.log(`📊 Processadas ${total} linhas → ${entregas.length} entregas`);

      await pool.query(
        `UPDATE bi_imports SET total_linhas = $1 WHERE id = $2`,
        [total, registro.id]
      );

      if (entregas.length === 0) {
        await pool.query(`
          UPDATE bi_imports
             SET status = 'sucesso', etapa_atual = 'concluido', progresso = 100,
                 finalizado_em = NOW(),
                 linhas_inseridas = 0, linhas_ignoradas = 0,
                 erro = 'Planilha vazia (0 linhas)'
           WHERE id = $1
        `, [registro.id]);
        ctx.log(`⚠️ Planilha sem linhas — concluído com 0 inserções`);
        return;
      }

      // 3. POST pro endpoint interno
      await pool.query(
        `UPDATE bi_imports SET etapa_atual = 'enviando_bi', progresso = 85 WHERE id = $1`,
        [registro.id]
      );

      ctx.log(`📤 Enviando ${entregas.length} entregas pro /bi/entregas/upload`);
      const postRes = await postJsonInterno('/bi/entregas/upload', {
        entregas,
        data_referencia: dataRef,
        usuario_id: registro.usuario_id || null,
        usuario_nome: registro.usuario_nome || (registro.origem === 'cron' ? 'Sistema (cron 10h)' : 'Importação manual'),
        nome_arquivo: path.basename(arquivoPath),
      });

      if (!postRes.ok) {
        const msgErro = `BI retornou ${postRes.status}: ${JSON.stringify(postRes.body).slice(0, 300)}`;
        await pool.query(`
          UPDATE bi_imports
             SET status = 'falhou', erro = $1, finalizado_em = NOW()
           WHERE id = $2
        `, [msgErro.slice(0, 500), registro.id]);
        ctx.log(`❌ POST falhou: ${msgErro}`);
        return;
      }

      // 4. Sucesso — extrai contadores da resposta do BI
      const body = postRes.body || {};
      // Endpoint do BI retorna campos como linhas_inseridas, linhas_ignoradas no historico
      const linhasInseridas = body.entregasInseridas || body.linhas_inseridas || body.inseridas || entregas.length;
      const linhasIgnoradas = body.entregasIgnoradas || body.linhas_ignoradas || body.ignoradas || 0;

      await pool.query(`
        UPDATE bi_imports
           SET status = 'sucesso', etapa_atual = 'concluido', progresso = 100,
               finalizado_em = NOW(),
               linhas_inseridas = $1, linhas_ignoradas = $2
         WHERE id = $3
      `, [linhasInseridas, linhasIgnoradas, registro.id]);

      ctx.log(`✅ Job ${registro.id} concluído: ${linhasInseridas} inseridas, ${linhasIgnoradas} ignoradas`);

      // Limpa arquivo .xlsx local pra não acumular (mantém só por debug em /tmp)
      try {
        // Mantém arquivo por enquanto — útil pra debug. Apaga depois de 24h via cron de limpeza separado.
        // fs.unlinkSync(arquivoPath);
      } catch (_) {}

    } finally {
      playwrightLib.clearOverrides();
    }
  },

  onErro: async (pool, registro, err) => {
    if (registro?.id) {
      try {
        await pool.query(`
          UPDATE bi_imports
             SET status = 'falhou',
                 erro = $1,
                 finalizado_em = NOW()
           WHERE id = $2 AND status = 'processando'
        `, [`pool_exception: ${err.message}`.slice(0, 500), registro.id]);
      } catch (_) {}
    }
  },
});

// Exporta também o helper pra index.js usar no cron
module.exports.criarJobCronSeNaoExistir = criarJobCronSeNaoExistir;
module.exports.calcularDataD1 = calcularDataD1;
