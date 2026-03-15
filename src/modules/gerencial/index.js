/**
 * MÓDULO GERENCIAL - Análise Gerencial Semanal
 */
const { createGerencialRouter } = require('./gerencial.routes');
const { initGerencialTables } = require('./gerencial.migration');

function initGerencialRoutes(pool, verificarToken) {
  return createGerencialRouter(pool, verificarToken);
}

module.exports = { initGerencialRoutes, initGerencialTables };
