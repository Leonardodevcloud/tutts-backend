/**
 * performance-worker.js — DEPRECATED 2026-04
 * ─────────────────────────────────────────────────────────────────────────
 * Substituído por:
 *   - agents/performance.agent.js (processa fila com batching)
 *   - agents/performance-cron.agent.js (3 agentes cron, 1 por horário)
 *
 * Stub no-op pra não quebrar imports antigos.
 */

'use strict';

const { logger } = require('../../config/logger');

function startPerformanceWorker(_pool) {
  logger.info('[perf-worker DEPRECATED] start ignorado — use agent-pool');
}

module.exports = { startPerformanceWorker };
