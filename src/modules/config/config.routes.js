/**
 * MÓDULO CONFIG - Route Orchestrator
 * Monta 6 sub-routers por domínio lógico
 * 69 endpoints, 0 lógica de negócio aqui
 */

const express = require('express');

const { createAdminRoutes } = require('./routes/admin.routes');
const { createSubmissionsRoutes } = require('./routes/submissions.routes');
const { createHorariosRoutes } = require('./routes/horarios.routes');
const { createPromocoesRoutes } = require('./routes/promocoes.routes');
const { createNovatosRoutes } = require('./routes/novatos.routes');
const { createRecrutamentoRoutes } = require('./routes/recrutamento.routes');

function createConfigRouter(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

  router.use(createAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));
  router.use(createSubmissionsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));
  router.use(createHorariosRoutes(pool, verificarToken, verificarAdmin));
  router.use(createPromocoesRoutes(pool, verificarToken, verificarAdmin));
  router.use(createNovatosRoutes(pool, verificarToken, verificarAdmin));
  router.use(createRecrutamentoRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));

  return router;
}

module.exports = { createConfigRouter };
