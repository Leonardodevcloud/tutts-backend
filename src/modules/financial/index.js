/**
 * MÓDULO FINANCIAL
 * 31 endpoints, 5 tabelas
 */

const { initFinancialTables } = require('./financial.migration');
const { createFinancialRouter } = require('./financial.routes');

function initFinancialRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP) {
  return createFinancialRouter(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP);
}

module.exports = { initFinancialRoutes, initFinancialTables };
