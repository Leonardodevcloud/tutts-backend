/**
 * sla-detector-worker.js — DEPRECATED 2026-04
 * ─────────────────────────────────────────────────────────────────────────
 * Substituído por agents/sla-detector.agent.js.
 */

'use strict';

const { logger } = require('../../config/logger');

function startSlaDetectorWorker(_pool) {
  logger.info('[sla-detector-worker DEPRECATED] start ignorado — use agent-pool');
}

function stopSlaDetectorWorker() {
  logger.info('[sla-detector-worker DEPRECATED] stop ignorado — use agent-pool');
}

module.exports = { startSlaDetectorWorker, stopSlaDetectorWorker };
