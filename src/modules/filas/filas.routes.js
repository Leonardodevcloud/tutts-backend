const express = require('express');
const { createFilasAdminRoutes } = require('./routes/admin.routes');
const { createFilasProfRoutes } = require('./routes/profissional.routes');
const { createFilasAutoRoutes } = require('./routes/auto.routes');
// FILAS_VAGAS_V1_ROUTER_IMPORT (17/07)
const { createFilasVagasRoutes } = require('./routes/vagas.routes');

function createFilasRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  router.use(createFilasAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
  router.use(createFilasProfRoutes(pool, verificarToken, registrarAuditoria));
  // 🆕 2026-05: Fila auto-gerenciável (motoboys se organizam + agente Playwright valida)
  router.use(createFilasAutoRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
  // FILAS_VAGAS_V1_ROUTER_USE (17/07): trava de vagas por dia. Entra aqui e não no server.js
  // porque a trava é da FILA — e este arquivo já é o compositor dos sub-routers.
  router.use(createFilasVagasRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
  return router;
}

module.exports = { createFilasRouter };
