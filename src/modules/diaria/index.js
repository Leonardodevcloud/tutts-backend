/**
 * MÓDULO DIÁRIA - Diária por horário individual do motoboy.
 *
 * É o Garantido com o horário podendo ser por motoboy em vez de por central.
 * Padrão da central vale pra todos; a escala é só a lista de exceções.
 * Mutuamente exclusivo com o Garantido (CHECK no banco).
 */

const { initDiariaTables } = require('./diaria.migration');
const { createDiariaRouter } = require('./diaria.routes');
const { registrarDiariaIngresso, estaNaEscalaDiaria } = require('./diaria.shared');

function initDiariaRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  return createDiariaRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

module.exports = { initDiariaRoutes, initDiariaTables, registrarDiariaIngresso, estaNaEscalaDiaria };
