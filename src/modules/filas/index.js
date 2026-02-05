/**
 * MÓDULO FILAS - Sistema de Gerenciamento de Filas Logísticas
 * 20 endpoints, 5 tabelas
 */

const { initFilasTables } = require('./filas.migration');
const { createFilasRouter } = require('./filas.routes');
const { calcularDistanciaHaversine } = require('./filas.service');

function initFilasRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  return createFilasRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

module.exports = { initFilasRoutes, initFilasTables, calcularDistanciaHaversine };
