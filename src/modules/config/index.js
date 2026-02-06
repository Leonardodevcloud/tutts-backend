/**
 * MÓDULO CONFIG - Configurações do Sistema
 * 69 endpoints, 14 tabelas
 */

const { initConfigTables } = require('./config.migration');
const { createConfigRouter } = require('./config.routes');
const { gerarTokenIndicacao } = require('./config.service');

function initConfigRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES) {
  return createConfigRouter(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES);
}

module.exports = { initConfigRoutes, initConfigTables, gerarTokenIndicacao };
