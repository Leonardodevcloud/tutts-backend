/**
 * MÓDULO MISC - Setores + Relatórios Diários
 * 10 endpoints
 */
const { initMiscTables } = require('./misc.migration');
const { createMiscRouter } = require('./misc.routes');

function initMiscRoutes(pool, verificarToken) {
  return createMiscRouter(pool, verificarToken);
}

module.exports = { initMiscRoutes, initMiscTables };
