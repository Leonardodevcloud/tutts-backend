/**
 * MÓDULO SOLICITAÇÃO
 * 28 endpoints, 5 tabelas
 *
 * Exporta também createSolicitacaoHelpers (verificarTokenSolicitacao, etc.)
 * para que outros módulos cliente-facing (ex: maquinas) possam reusar
 * a mesma autenticação de sessão de cliente.
 */

const { initSolicitacaoTables } = require('./solicitacao.migration');
const { createSolicitacaoRouter } = require('./solicitacao.routes');
const { createSolicitacaoHelpers } = require('./solicitacao.shared');

function initSolicitacaoRoutes(pool, verificarToken) {
  return createSolicitacaoRouter(pool, verificarToken);
}

module.exports = {
  initSolicitacaoRoutes,
  initSolicitacaoTables,
  createSolicitacaoHelpers,
};
