/**
 * MÓDULO ANTI-FRAUDE
 * Detecção automática de NFs/pedidos duplicados e padrões de fraude.
 */

const { initAntiFraudeTables } = require('./antifraude.migration');
const { createAntiFraudeRouter } = require('./antifraude.routes');
const { startAntiFraudeWorker } = require('./antifraude-worker');

function initAntiFraudeRoutes(pool, verificarAdmin) {
  return createAntiFraudeRouter(pool, verificarAdmin);
}

module.exports = { initAntiFraudeRoutes, initAntiFraudeTables, startAntiFraudeWorker };
