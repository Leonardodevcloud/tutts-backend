/**
 * MÓDULO ANTI-FRAUDE
 * Detecção de NFs/pedidos duplicados via consulta direta na bi_entregas.
 * Sem Playwright — 100% SQL.
 */

const { initAntiFraudeTables } = require('./antifraude.migration');
const { createAntiFraudeRouter } = require('./antifraude.routes');
const { startAntiFraudeWorker } = require('./antifraude-worker');

function initAntiFraudeRoutes(pool, verificarAdmin) {
  return createAntiFraudeRouter(pool, verificarAdmin);
}

module.exports = { initAntiFraudeRoutes, initAntiFraudeTables, startAntiFraudeWorker };
