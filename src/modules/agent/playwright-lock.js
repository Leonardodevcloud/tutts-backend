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
 * Timeout de segurança: se um job segurar o lock por mais de 5 minutos,
 * libera automaticamente para evitar deadlock permanente.
 */

'use strict';

const { logger } = require('../../config/logger');

const LOCK_TIMEOUT_MS = 5 * 60_000; // 5 min — timeout absoluto do lock

let _busy = false;
let _heldBy = null;
let _heldSince = null;
let _queue = [];
let _forceReleaseTimer = null;

function log(msg) {
  logger.info(`[playwright-lock] ${msg}`);
}

function _release() {
  if (_forceReleaseTimer) {
    clearTimeout(_forceReleaseTimer);
    _forceReleaseTimer = null;
  }
  
  const elapsed = _heldSince ? Math.round((Date.now() - _heldSince) / 1000) : 0;
  log(`🔓 Lock liberado por [${_heldBy}] após ${elapsed}s (fila: ${_queue.length})`);
  
  _heldBy = null;
  _heldSince = null;

  if (_queue.length > 0) {
    const next = _queue.shift();
    _heldBy = next.quem;
    _heldSince = Date.now();
    log(`🔒 Lock concedido a [${next.quem}] (restam ${_queue.length} na fila)`);
    
    _forceReleaseTimer = setTimeout(() => {
      log(`⚠️ TIMEOUT: [${_heldBy}] segurou o lock por ${LOCK_TIMEOUT_MS / 1000}s — forçando liberação`);
      _release();
    }, LOCK_TIMEOUT_MS);
    
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
      
      _forceReleaseTimer = setTimeout(() => {
        log(`⚠️ TIMEOUT: [${_heldBy}] segurou o lock por ${LOCK_TIMEOUT_MS / 1000}s — forçando liberação`);
        _release();
      }, LOCK_TIMEOUT_MS);
      
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
