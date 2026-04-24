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

// Estado de cada slot
const _slots = Array.from({ length: POOL_SIZE }, (_, i) => ({
  id:        i,
  livre:     true,
  heldBy:    null,
  heldSince: null,
}));

const _fila = []; // { quem, resolve }

function log(msg) {
  logger.info(`[browser-pool] ${msg}`);
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
  };
}

log(`▶️ Pool inicializado com ${POOL_SIZE} slot(s)`);

module.exports = {
  withBrowserSlot,
  snapshot,
  POOL_SIZE,
};
