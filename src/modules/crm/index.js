// ============================================================
// MÓDULO CRM - INDEX
// Ponto de entrada único do módulo
// ============================================================

const initCrmRoutes = require('./crm.routes');

let initCrmTables;
try {
  initCrmTables = require('./crm.migration');
} catch (e) {
  console.error('⚠️ [CRM] crm.migration.js não encontrado:', e.message);
  initCrmTables = async () => { console.log('⚠️ [CRM] Migration pulada (arquivo ausente)'); };
}

module.exports = {
  initCrmRoutes,
  initCrmTables,
};
