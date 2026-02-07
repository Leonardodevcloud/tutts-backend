const express = require('express');
const { createFilasAdminRoutes } = require('./routes/admin.routes');
const { createFilasProfRoutes } = require('./routes/profissional.routes');

function createFilasRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  router.use(createFilasAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
  router.use(createFilasProfRoutes(pool, verificarToken));
  return router;
}

module.exports = { createFilasRouter };
