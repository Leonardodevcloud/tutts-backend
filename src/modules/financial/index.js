/**
 * MÓDULO FINANCIAL
 * 31+ endpoints, 8 tabelas (5 originais + 2 Stark Bank + 1 gratuities_motivos)
 */

const { initFinancialTables } = require('./financial.migration');
const { createFinancialRouter } = require('./financial.routes');
const { initStarkTables } = require('./routes/stark.migration');
// 2026-05: redesign de gratuidades (motivos pré-definidos + índices)
const { initGratuidadesV2Tables } = require('./gratuidades-v2.migration');

async function initAllFinancialTables(pool) {
  await initFinancialTables(pool);
  await initStarkTables(pool);
  await initGratuidadesV2Tables(pool);
}

function initFinancialRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP) {
  return createFinancialRouter(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP);
}

module.exports = { initFinancialRoutes, initFinancialTables: initAllFinancialTables };
