const express = require('express');
const { createGestaoRoutes } = require('./routes/gestao.routes');
const { createRestricoesRoutes } = require('./routes/restricoes.routes');
const { createRelatoriosRoutes } = require('./routes/relatorios.routes');

function createDisponibilidadeRouter(pool) {
  const router = express.Router();
  router.use(createGestaoRoutes(pool));
  router.use(createRestricoesRoutes(pool));
  router.use(createRelatoriosRoutes(pool));
  return router;
}

module.exports = { createDisponibilidadeRouter };
