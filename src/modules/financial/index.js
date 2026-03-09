/**
 * MÓDULO FINANCIAL
 * 31+ endpoints, 7 tabelas (5 originais + 2 Stark Bank)
 */

const { initFinancialTables } = require('./financial.migration');
const { createFinancialRouter } = require('./financial.routes');
const { initStarkTables } = require('./routes/stark.migration');

async function initAllFinancialTables(pool) {
  await initFinancialTables(pool);
  await initStarkTables(pool);
}

function initFinancialRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP) {
  return createFinancialRouter(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP);
}

module.exports = { initFinancialRoutes, initFinancialTables: initAllFinancialTables };
