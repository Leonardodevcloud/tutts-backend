/**
 * MÓDULO MÁQUINAS
 * Controle de despacho/restituição de máquinas de pagamento (Get, Cielo, Stone, etc.)
 * que o cliente empresta para os motoboys. Bloqueia saque emergencial Plific
 * enquanto o motoboy tiver máquina em mãos.
 *
 * 11 endpoints, 2 tabelas + 1 coluna em clientes_solicitacao
 */

const { initMaquinasTables } = require('./maquinas.migration');
const { createMaquinasRouter } = require('./maquinas.routes');
const { verificarMaquinaPendente } = require('./maquinas.shared');

function initMaquinasRoutes(pool, verificarToken) {
  return createMaquinasRouter(pool, verificarToken);
}

module.exports = {
  initMaquinasRoutes,
  initMaquinasTables,
  verificarMaquinaPendente,
};
