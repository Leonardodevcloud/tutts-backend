/**
 * MÓDULO FINANCIAL
 * 33+ endpoints, 10 tabelas
 */

const { initFinancialTables } = require('./financial.migration');
const { createFinancialRouter } = require('./financial.routes');
const { initStarkTables } = require('./routes/stark.migration');
// 2026-05 v2: redesign de gratuidades (motivos pré-definidos + índices)
const { initGratuidadesV2Tables } = require('./gratuidades-v2.migration');
// 2026-05 v3: expires_at, isenções, normalização retroativa
const { initGratuidadesV3Tables } = require('./gratuidades-v3.migration');

async function initAllFinancialTables(pool) {
  await initFinancialTables(pool);
  await initStarkTables(pool);
  await initGratuidadesV2Tables(pool);
  await initGratuidadesV3Tables(pool);
}

function initFinancialRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP) {
  return createFinancialRouter(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP);
}

module.exports = { initFinancialRoutes, initFinancialTables: initAllFinancialTables };
