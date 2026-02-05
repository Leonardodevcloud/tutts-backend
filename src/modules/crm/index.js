// ============================================================
// MÓDULO CRM - INDEX
// Ponto de entrada único do módulo
//
// NOTA: O CRM não possui tabelas próprias.
// Ele consulta a tabela bi_entregas (do módulo BI).
// Por isso não há migration nem service.
// ============================================================

const initCrmRoutes = require('./crm.routes');

module.exports = {
  initCrmRoutes
};
