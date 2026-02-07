const express = require('express');
const { createSetoresRoutes } = require('./routes/setores.routes');
const { createRelatoriosDiariosRoutes } = require('./routes/relatorios.routes');

function createMiscRouter(pool) {
  const router = express.Router();
  router.use(createSetoresRoutes(pool));
  router.use(createRelatoriosDiariosRoutes(pool));
  return router;
}

module.exports = { createMiscRouter };
