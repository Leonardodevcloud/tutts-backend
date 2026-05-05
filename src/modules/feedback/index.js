/**
 * MÓDULO FEEDBACK - Roadmap, Bugs e Sugestões
 * Tela interna pra equipe Tutts acompanhar desenvolvimentos previstos,
 * reportar bugs e registrar sugestões. Apenas admins.
 *
 * 14 endpoints, 2 tabelas (feedback_items + feedback_anexos)
 */

const { initFeedbackTables } = require('./feedback.migration');
const { createFeedbackRouter } = require('./feedback.routes');

function initFeedbackRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  return createFeedbackRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

module.exports = { initFeedbackRoutes, initFeedbackTables };
