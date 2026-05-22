/**
 * core/browser-pool.js
 * ─────────────────────────────────────────────────────────────────────────
 * Pool de slots para Chromium. Substitui o `playwright-lock.js` antigo
 * (que era de 1 slot só).
 *
 * Cada slot é uma "vaga" pra rodar Chromium concorrente. Quem chama
 * `withBrowserSlot` espera até ter slot livre, executa, e libera no finally.
 *
 * GARANTIAS:
 *   - Nunca mais que N Chromiums simultâneos (proteção de RAM/CPU)
 *   - Liberação automática no finally (mesmo se fn() lançar)
 *   - SEM force-release por timeout (era a causa do SIGTRAP do fix anterior)
 *   - O CALLEE precisa garantir que o browser feche antes de retornar —
 *     caso contrário, próximo job no slot vai dar conflito
 *
 * A defesa contra slots presos é feita 1 nível acima, no agent-pool:
 * cada processar()/tickGlobal() é envelopado com timeout (agente.timeoutMs).
 * Quando o timeout dispara, marca BrowserSession como morto e lança erro
 * → o finally do withBrowserSlot libera o slot naturalmente.
 *
 * O watchdog deste arquivo é só de VISIBILIDADE: a cada N segundos, loga
 * WARN se algum slot está ocupado há mais que WATCHDOG_WARN_MS. Não força
 * liberar. Ajuda a detectar regressões do timeout do agent-pool.
 *
 * IDENTIDADE DO SLOT:
 *   `withBrowserSlot` retorna o slotId (0..N-1) pro callee. Isso permite que
 *   cada slot use um arquivo de sessão diferente (1 conta por slot) ou
 *   compartilhe sessão (todos usam o mesmo arquivo).
 *
 * Uso:
 *   const { withBrowserSlot } = require('./core/browser-pool');
 *
 *   await withBrowserSlot('sla-capture', async (slotId) => {
 *     const browser = await chromium.launch(...);
 *     try {
 *       const ctx = await browser.newContext({
 *         storageState: getSessionPath(slotId)
 *       });
 *       // ... trabalho ...
 *     } finally {
 *       await browser.close();
 *     }
 *   });
 */

'use strict';

const { logger } = require('../../../config/logger');

// Tamanho do pool — vem do env (default: 3 pra Railway Pro)
const POOL_SIZE = Number(process.env.BROWSER_POOL_SIZE || 3);

if (!Number.isInteger(POOL_SIZE) || POOL_SIZE < 1 || POOL_SIZE > 10) {
  throw new Error(
    `BROWSER_POOL_SIZE inválido: ${process.env.BROWSER_POOL_SIZE} ` +
    `(esperado inteiro entre 1 e 10)`
  );
}

// Watchdog: a cada CHECK_MS, loga WARN se algum slot está ocupado >WARN_MS
// 5min é o threshold pq mesmo jobs longos (bi-import, perfomance) tendem a
// terminar antes disso. Acima de 5min = quase certo que travou.
const WATCHDOG_CHECK_MS = Number(process.env.BROWSER_POOL_WATCHDOG_CHECK_MS || 60_000);   // 1min
const WATCHDOG_WARN_MS  = Number(process.env.BROWSER_POOL_WATCHDOG_WARN_MS  || 5 * 60_000); // 5min

// Estado de cada slot
const _slots = Array.from({ length: POOL_SIZE }, (_, i) => ({
  id:        i,
  livre:     true,
  heldBy:    null,
  heldSince: null,
  // Marca último WARN emitido pra esse slot, pra evitar spam:
  // só re-loga quando passa >= 1 min do último WARN.
  lastWarnAt: 0,
}));

const _fila = []; // { quem, resolve }

function log(msg) {
  logger.info(`[browser-pool] ${msg}`);
}
function logWarn(msg) {
  logger.warn(`[browser-pool] ${msg}`);
}

function _statusResumido() {
  const ocupados = _slots.filter(s => !s.livre).length;
  return `${ocupados}/${POOL_SIZE} ocupados, fila: ${_fila.length}`;
}

function _adquirirSlot(quem) {
  return new Promise((resolve) => {
    const slot = _slots.find(s => s.livre);
    if (slot) {
      slot.livre     = false;
      slot.heldBy    = quem;
      slot.heldSince = Date.now();
      slot.lastWarnAt = 0; // reset do warn ao re-adquirir
      log(`🔒 slot[${slot.id}] → [${quem}] (${_statusResumido()})`);
      resolve(slot.id);
    } else {
      log(`⏳ [${quem}] aguardando slot (${_statusResumido()})`);
      _fila.push({ quem, resolve });
    }
  });
}

function _liberarSlot(slotId) {
  const slot = _slots[slotId];
  if (!slot) {
    logger.error(`[browser-pool] tentativa de liberar slot inexistente: ${slotId}`);
    return;
  }
  if (slot.livre) {
    logger.error(`[browser-pool] slot[${slotId}] já estava livre — possível double-release`);
    return;
  }

  const elapsed = slot.heldSince ? Math.round((Date.now() - slot.heldSince) / 1000) : 0;
  log(`🔓 slot[${slotId}] liberado por [${slot.heldBy}] após ${elapsed}s`);

  slot.heldBy    = null;
  slot.heldSince = null;
  slot.lastWarnAt = 0;

  // Próximo da fila pega esse slot
  if (_fila.length > 0) {
    const proximo = _fila.shift();
    slot.livre     = false;
    slot.heldBy    = proximo.quem;
    slot.heldSince = Date.now();
    log(`🔒 slot[${slotId}] → [${proximo.quem}] (${_statusResumido()})`);
    proximo.resolve(slotId);
  } else {
    slot.livre = true;
  }
}

/**
 * Executa fn(slotId) com 1 slot exclusivo do pool.
 * Espera na fila se todos estiverem ocupados.
 *
 * fn(slotId) DEVE garantir que qualquer browser/context aberto seja
 * fechado ANTES de retornar (sucesso ou erro). Caso contrário, o próximo
 * job vai disparar Chromium concorrente no mesmo slot.
 */
async function withBrowserSlot(quem, fn) {
  const slotId = await _adquirirSlot(quem);
  try {
    return await fn(slotId);
  } finally {
    _liberarSlot(slotId);
  }
}

// Snapshot do estado pra debug/health endpoint
function snapshot() {
  return {
    poolSize: POOL_SIZE,
    slots: _slots.map(s => ({
      id: s.id,
      livre: s.livre,
      heldBy: s.heldBy,
      heldSinceMs: s.heldSince ? Date.now() - s.heldSince : null,
    })),
    filaSize: _fila.length,
    fila: _fila.map(f => f.quem),
    watchdog: {
      checkMs: WATCHDOG_CHECK_MS,
      warnMs:  WATCHDOG_WARN_MS,
    },
  };
}

// ─── Watchdog de visibilidade ───────────────────────────────────────────
// Loga WARN se algum slot está ocupado há mais que WATCHDOG_WARN_MS.
// NÃO força liberar — só visibilidade pra detectar regressões do timeout
// do agent-pool. Re-loga no máximo 1x por minuto pra não spammar.
function _watchdogTick() {
  const agora = Date.now();
  for (const slot of _slots) {
    if (slot.livre || !slot.heldSince) continue;
    const ageMs = agora - slot.heldSince;
    if (ageMs < WATCHDOG_WARN_MS) continue;
    // Só loga se passou pelo menos 60s do último WARN desse slot
    if (slot.lastWarnAt && (agora - slot.lastWarnAt) < 60_000) continue;
    slot.lastWarnAt = agora;
    logWarn(
      `🩺 slot[${slot.id}] ocupado há ${Math.round(ageMs / 1000)}s por [${slot.heldBy}] ` +
      `— suspeita de deadlock (timeout do agent-pool deveria ter disparado). ` +
      `Investigar: o agente tem timeoutMs definido?`
    );
  }
}
const _watchdogInterval = setInterval(_watchdogTick, WATCHDOG_CHECK_MS);
// Permite que o processo encerre mesmo com o interval ativo
if (_watchdogInterval && typeof _watchdogInterval.unref === 'function') {
  _watchdogInterval.unref();
}

log(`▶️ Pool inicializado com ${POOL_SIZE} slot(s). Watchdog: WARN se slot ocupado >${Math.round(WATCHDOG_WARN_MS / 1000)}s (check a cada ${Math.round(WATCHDOG_CHECK_MS / 1000)}s)`);

module.exports = {
  withBrowserSlot,
  snapshot,
  POOL_SIZE,
};
