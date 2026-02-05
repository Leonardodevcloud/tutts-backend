// ============================================================
// MÓDULO AUDITORIA - INDEX
// Ponto de entrada único do módulo
// ============================================================

const initAuditRoutes = require('./audit.routes');
const initAuditTables = require('./audit.migration');
const { AUDIT_CATEGORIES, createRegistrarAuditoria } = require('./audit.service');

module.exports = {
  initAuditRoutes,
  initAuditTables,
  AUDIT_CATEGORIES,
  createRegistrarAuditoria
};
