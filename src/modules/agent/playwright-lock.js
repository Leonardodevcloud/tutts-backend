/**
 * playwright-lock.js
 * Semáforo global para Playwright — garante que apenas 1 instância de Chromium
 * rode por vez em todo o processo, independente de qual worker chamou.
 *
 * Uso:
 *   const { withBrowserLock } = require('./playwright-lock');
 *   const resultado = await withBrowserLock('agent-worker', async () => {
 *     const browser = await chromium.launch(...);
 *     try { ... } finally { await browser.close(); }
 *   });
 *
 * Se o lock já estiver ocupado, a chamada ESPERA até liberar (fila FIFO).
 *
 * 🔧 CRÍTICO (2026-04): O lock NÃO tem mais force-release por timeout.
 * Liberação só acontece via `await fn()` resolver/rejeitar.
 *
 * Por quê? O force-release antigo (5 min) liberava o lock enquanto o Chromium
 * ainda estava vivo no processo anterior — o próximo job pegava o lock e
 * tentava `chromium.launch()` em paralelo, causando SIGTRAP / "Target page,
 * context or browser has been closed".
 *
 * A garantia de não-deadlock agora é responsabilidade do callee:
 *   1. Toda função que pega o lock TEM que ter try/finally fechando o browser.
 *   2. O callee usa watchdog INTERNO (próprio das funções do playwright-sla-capture
 *      e playwright-agent) — quando dispara, mata o Chromium ANTES de retornar,
 *      e SÓ DEPOIS o lock é liberado.
 */

'use strict';

const { logger } = require('../../config/logger');

let _busy = false;
let _heldBy = null;
let _heldSince = null;
let _queue = [];

function log(msg) {
  logger.info(`[playwright-lock] ${msg}`);
}

function _release() {
  const elapsed = _heldSince ? Math.round((Date.now() - _heldSince) / 1000) : 0;
  log(`🔓 Lock liberado por [${_heldBy}] após ${elapsed}s (fila: ${_queue.length})`);

  _heldBy = null;
  _heldSince = null;

  if (_queue.length > 0) {
    const next = _queue.shift();
    _heldBy = next.quem;
    _heldSince = Date.now();
    log(`🔒 Lock concedido a [${next.quem}] (restam ${_queue.length} na fila)`);
    next.resolve();
  } else {
    _busy = false;
  }
}

function _acquire(quem) {
  return new Promise((resolve) => {
    if (!_busy) {
      _busy = true;
      _heldBy = quem;
      _heldSince = Date.now();
      log(`🔒 Lock concedido a [${quem}] (fila vazia)`);
      resolve();
    } else {
      log(`⏳ [${quem}] aguardando lock (ocupado por [${_heldBy}] há ${Math.round((Date.now() - _heldSince) / 1000)}s, fila: ${_queue.length})`);
      _queue.push({ quem, resolve });
    }
  });
}

/**
 * Executa fn() com lock exclusivo de Playwright.
 * Se outro worker já tem o lock, espera na fila.
 * O lock é SEMPRE liberado no finally, mesmo se fn() lançar erro.
 *
 * IMPORTANTE: fn() DEVE garantir que qualquer browser/context aberto seja
 * fechado ANTES de retornar (sucesso ou erro). Caso contrário, o próximo
 * job na fila vai disparar Chromium concorrente.
 */
async function withBrowserLock(quem, fn) {
  await _acquire(quem);
  try {
    return await fn();
  } finally {
    _release();
  }
}

/**
 * Verifica status do lock (para health-check/debug).
 */
function lockStatus() {
  return {
    busy: _busy,
    heldBy: _heldBy,
    heldSince: _heldSince,
    heldForMs: _heldSince ? Date.now() - _heldSince : 0,
    queueLength: _queue.length,
    queueWaiters: _queue.map(q => q.quem)
  };
}

module.exports = { withBrowserLock, lockStatus };
