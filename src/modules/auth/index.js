/**
 * MÓDULO AUTH - Autenticação e Gestão de Usuários
 * 23 endpoints, 6 tabelas
 */

const { initAuthTables } = require('./auth.migration');
const { createAuthRouter } = require('./auth.routes');

function initAuthRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter) {
  return createAuthRouter(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter);
}

module.exports = { initAuthRoutes, initAuthTables };
