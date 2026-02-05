/**
 * MÓDULO LOJA
 * Estoque (4) + Produtos (5) + Pedidos (5) + Movimentações (4) + Sugestões (5)
 * Total: 23 endpoints, 6 tabelas
 */

const { initLojaTables } = require('./loja.migration');
const { createLojaRouter } = require('./loja.routes');

function initLojaRoutes(pool) {
  return createLojaRouter(pool);
}

module.exports = { initLojaRoutes, initLojaTables };
