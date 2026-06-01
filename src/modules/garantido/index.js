/**
 * MÓDULO GARANTIDO - Diária garantida proporcional ao horário de ingresso na fila.
 * Funciona para a fila tradicional (gerenciada) E a fila auto-gerenciável.
 * Config por central; alimentado automaticamente no 1º ingresso do dia.
 */

const { initGarantidoTables } = require('./garantido.migration');
const { createGarantidoRouter } = require('./garantido.routes');
const { registrarGarantidoIngresso } = require('./garantido.shared');

function initGarantidoRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  return createGarantidoRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

module.exports = { initGarantidoRoutes, initGarantidoTables, registrarGarantidoIngresso };
