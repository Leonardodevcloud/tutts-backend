// ============================================================
// MÓDULO SOCIAL - INDEX
// Ponto de entrada único do módulo
// Inclui: Social (perfis, status, mensagens) + Liderança
// ============================================================

const initSocialRoutes = require('./social.routes');
const initSocialTables = require('./social.migration');

module.exports = {
  initSocialRoutes,
  initSocialTables
};
