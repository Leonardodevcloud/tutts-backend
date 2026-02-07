const express = require('express');
const { createEstoqueRoutes } = require('./routes/estoque.routes');
const { createPedidosRoutes } = require('./routes/pedidos.routes');

function createLojaRouter(pool) {
  const router = express.Router();
  router.use(createEstoqueRoutes(pool));
  router.use(createPedidosRoutes(pool));
  return router;
}

module.exports = { createLojaRouter };
