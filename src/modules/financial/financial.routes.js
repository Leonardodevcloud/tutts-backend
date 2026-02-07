const express = require('express');
const { createFinancialHelpers } = require('./financial.shared');
const { createDadosRoutes } = require('./routes/dados.routes');
const { createWithdrawalsRoutes } = require('./routes/withdrawals.routes');
const { createExtrasRoutes } = require('./routes/extras.routes');

function createFinancialRouter(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP) {
  const router = express.Router();
  const helpers = createFinancialHelpers(getClientIP);

  router.use(createDadosRoutes(pool, verificarToken));
  router.use(createWithdrawalsRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, helpers));
  router.use(createExtrasRoutes(pool, verificarToken, verificarAdminOuFinanceiro, helpers));

  return router;
}

module.exports = { createFinancialRouter };
