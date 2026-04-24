/**
 * agent-worker.js — DEPRECATED 2026-04
 * ─────────────────────────────────────────────────────────────────────────
 * Substituído por agents/agent-correcao.agent.js (registrado no agent-pool).
 *
 * Este arquivo virou stub no-op pra não quebrar imports antigos. As
 * funções `startAgentWorker` e `stopAgentWorker` agora não fazem nada —
 * o pool é iniciado pelo novo index.js do módulo.
 */

'use strict';

const { logger } = require('../../config/logger');

function startAgentWorker(_pool) {
  logger.info('[agent-worker DEPRECATED] start ignorado — use agent-pool');
}

function stopAgentWorker() {
  logger.info('[agent-worker DEPRECATED] stop ignorado — use agent-pool');
}

module.exports = { startAgentWorker, stopAgentWorker };
