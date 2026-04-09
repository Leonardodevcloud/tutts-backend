/**
 * sla-capture-worker.js
 * Worker polling que processa registros pendentes na tabela sla_capturas.
 *
 * Mesmo padrão do agent-worker:
 *   - 1 registro por vez (sessão Playwright SLA é única)
 *   - Circuit breaker pro pool do DB
 *   - Marca 'processando' antes de executar (evita duplo-processamento)
 *
 * Roda no MESMO process do server.js (single Railway service).
 * Startado dentro de startAgentWorker() pra não precisar mexer no server.js.
 */

'use strict';

const { logger } = require('../../config/logger');
const { processarCaptura } = require('./sla-capture.service');

// ── Config ────────────────────────────────────────────────────────────────
const INTERVALO_NORMAL_MS = 5_000;   // 5s — poll interval
const MAX_FALHAS_SEGUIDAS = 3;
const BACKOFF_BASE_MS     = 30_000;  // 30s
const BACKOFF_MAX_MS      = 5 * 60_000; // 5min

// Cleanup de registros "processando" órfãos
const CLEANUP_INTERVAL_MS  = 60_000;      // roda a cada 60s
const PROCESSANDO_TIMEOUT  = 3 * 60_000;  // 3min é tempo máximo razoável de processamento

// ── Estado ────────────────────────────────────────────────────────────────
let workerAtivo = false;
let falhasConsecutivas = 0;
let proximoTick = null;
let cleanupTimer = null;

function log(msg) {
  logger.info(`[sla-capture-worker] ${msg}`);
}

function logErr(msg) {
  logger.error(`[sla-capture-worker] ${msg}`);
}

/**
 * Recupera registros "processando" órfãos.
 *
 * Chamado:
 *   1. No startup — sempre: se o worker tá iniciando, ninguém pode estar
 *      legitimamente em 'processando' (worker é singleton por processo).
 *   2. Periodicamente — só reseta os que passaram do PROCESSANDO_TIMEOUT
 *      (3min), pra não matar capturas que estão genuinamente rodando.
 */
async function recuperarProcessandoOrfaos(pool, modo /* 'startup' | 'periodico' */) {
  try {
    const query = modo === 'startup'
      ? `
        UPDATE sla_capturas
        SET status = 'pendente',
            proximo_retry_em = NOW(),
            erro = COALESCE(erro, '') || ' [recuperado no startup]',
            atualizado_em = NOW()
        WHERE status = 'processando'
        RETURNING id, os_numero
      `
      : `
        UPDATE sla_capturas
        SET status = 'pendente',
            proximo_retry_em = NOW(),
            erro = COALESCE(erro, '') || ' [timeout processando]',
            atualizado_em = NOW()
        WHERE status = 'processando'
          AND atualizado_em < NOW() - INTERVAL '3 minutes'
        RETURNING id, os_numero
      `;

    const { rows } = await pool.query(query);
    if (rows.length > 0) {
      log(`♻️  ${rows.length} órfão(s) recuperado(s) (${modo}): ${rows.map(r => r.os_numero).join(', ')}`);
    }
    return rows.length;
  } catch (err) {
    logErr(`Falha ao recuperar órfãos (${modo}): ${err.message}`);
    return 0;
  }
}

function calcularDelay() {
  if (falhasConsecutivas < MAX_FALHAS_SEGUIDAS) return INTERVALO_NORMAL_MS;
  const expoente = falhasConsecutivas - MAX_FALHAS_SEGUIDAS;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, expoente), BACKOFF_MAX_MS);
}

async function poolSaudavel(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function processarProximoPendente(pool) {
  let registro = null;

  try {
    if (falhasConsecutivas >= MAX_FALHAS_SEGUIDAS) {
      const ok = await poolSaudavel(pool);
      if (!ok) throw new Error('Pool indisponível');
      log(`✅ DB restaurado após ${falhasConsecutivas} falhas`);
      falhasConsecutivas = 0;
    }

    // Busca 1 pendente cujo proximo_retry_em já passou
    // FOR UPDATE SKIP LOCKED evita condição de corrida se algum dia escalar
    const { rows } = await pool.query(
      `
      SELECT * FROM sla_capturas
      WHERE status = 'pendente'
        AND proximo_retry_em <= NOW()
      ORDER BY criado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `
    );

    if (falhasConsecutivas > 0) {
      log(`✅ Circuit breaker resetado (era ${falhasConsecutivas})`);
    }
    falhasConsecutivas = 0;

    if (rows.length === 0) return;

    registro = rows[0];

    // Marca como processando
    await pool.query(
      `UPDATE sla_capturas SET status = 'processando', atualizado_em = NOW() WHERE id = $1`,
      [registro.id]
    );

    // Processa (retry e atualização de status é responsabilidade do service)
    await processarCaptura(pool, registro);
  } catch (err) {
    falhasConsecutivas++;
    logErr(`Falha no tick #${falhasConsecutivas}: ${err.message}`);

    // Se marcou como 'processando' mas estourou antes do service atualizar,
    // volta pra 'pendente' com tentativa conservativa
    if (registro?.id) {
      try {
        await pool.query(
          `UPDATE sla_capturas
           SET status = 'pendente',
               erro = $1,
               proximo_retry_em = NOW() + INTERVAL '10 seconds',
               atualizado_em = NOW()
           WHERE id = $2 AND status = 'processando'`,
          [`worker_exception: ${err.message}`, registro.id]
        );
      } catch (_) {}
    }
  } finally {
    if (workerAtivo) {
      proximoTick = setTimeout(() => processarProximoPendente(pool), calcularDelay());
    }
  }
}

function startSlaCaptureWorker(pool) {
  if ((process.env.SLA_CAPTURE_ATIVO || 'false').toLowerCase() !== 'true') {
    log('⏸️ SLA Capture Worker desativado (SLA_CAPTURE_ATIVO != true)');
    return;
  }
  if (workerAtivo) {
    log('⚠️ Worker já ativo');
    return;
  }
  workerAtivo = true;
  log('▶️ SLA Capture Worker iniciado (poll 5s)');

  // 1. Reclaim de órfãos deixados por deploys anteriores
  recuperarProcessandoOrfaos(pool, 'startup').catch(() => {});

  // 2. Cleanup periódico pra casos de hang durante runtime
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    recuperarProcessandoOrfaos(pool, 'periodico').catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  // 3. Inicia loop principal
  processarProximoPendente(pool);
}

function stopSlaCaptureWorker() {
  workerAtivo = false;
  if (proximoTick) clearTimeout(proximoTick);
  if (cleanupTimer) clearInterval(cleanupTimer);
  proximoTick = null;
  cleanupTimer = null;
  log('⏹️ SLA Capture Worker parado');
}

module.exports = { startSlaCaptureWorker, stopSlaCaptureWorker };
