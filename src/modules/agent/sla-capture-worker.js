/**
 * sla-capture-worker.js — DEPRECATED 2026-04
 * ─────────────────────────────────────────────────────────────────────────
 * Substituído por agents/sla-capture.agent.js.
 */

'use strict';

const { logger } = require('../../config/logger');

function startSlaCaptureWorker(_pool) {
  logger.info('[sla-capture-worker DEPRECATED] start ignorado — use agent-pool');
}

function stopSlaCaptureWorker() {
  logger.info('[sla-capture-worker DEPRECATED] stop ignorado — use agent-pool');
}

module.exports = { startSlaCaptureWorker, stopSlaCaptureWorker };
