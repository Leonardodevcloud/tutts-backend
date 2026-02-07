/**
 * MÓDULO BI - Business Intelligence
 * 70 endpoints, 8 sub-routers
 */
const { initBiTables } = require('./bi.migration');
const { createBiRouter } = require('./bi.routes');

function initBiRoutes(pool, verificarToken) {
  return createBiRouter(pool, verificarToken);
}

module.exports = { initBiRoutes, initBiTables };
