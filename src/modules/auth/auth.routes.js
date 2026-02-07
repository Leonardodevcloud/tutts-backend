const express = require('express');
const { createAuthHelpers } = require('./auth.shared');
const { createAuthCoreRoutes } = require('./routes/core.routes');
const { createUserManagementRoutes } = require('./routes/userManagement.routes');

function createAuthRouter(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter) {
  const router = express.Router();
  const helpers = createAuthHelpers(pool);

  router.use(createAuthCoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter, helpers));
  router.use(createUserManagementRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));

  return router;
}

module.exports = { createAuthRouter };
