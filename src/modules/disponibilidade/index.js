/**
 * MÓDULO DISPONIBILIDADE
 * 39 endpoints, 9 tabelas
 */
const { initDisponibilidadeTables } = require('./disponibilidade.migration');
const { createDisponibilidadeRouter } = require('./disponibilidade.routes');
const { marcarMotoboyEmLoja } = require('./disponibilidade.shared');

function initDisponibilidadeRoutes(pool, verificarToken) {
  return createDisponibilidadeRouter(pool, verificarToken);
}

module.exports = {
  initDisponibilidadeRoutes,
  initDisponibilidadeTables,
  // 🆕 2026-05-24: integração filas → disponibilidade (status EM LOJA automático)
  marcarMotoboyEmLoja,
};
