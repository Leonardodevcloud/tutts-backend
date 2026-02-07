/**
 * MÓDULO DISPONIBILIDADE
 * 39 endpoints, 9 tabelas
 */
const { initDisponibilidadeTables } = require('./disponibilidade.migration');
const { createDisponibilidadeRouter } = require('./disponibilidade.routes');

function initDisponibilidadeRoutes(pool, verificarToken) {
  return createDisponibilidadeRouter(pool, verificarToken);
}

module.exports = { initDisponibilidadeRoutes, initDisponibilidadeTables };
