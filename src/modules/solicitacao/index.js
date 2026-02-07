/**
 * MÓDULO SOLICITAÇÃO
 * 28 endpoints, 5 tabelas
 */

const { initSolicitacaoTables } = require('./solicitacao.migration');
const { createSolicitacaoRouter } = require('./solicitacao.routes');

function initSolicitacaoRoutes(pool, verificarToken) {
  return createSolicitacaoRouter(pool, verificarToken);
}

module.exports = { initSolicitacaoRoutes, initSolicitacaoTables };
