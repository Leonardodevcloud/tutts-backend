// ============================================================
// MÓDULO SCORE/GAMIFICAÇÃO - INDEX
// Ponto de entrada único do módulo
// ============================================================

const initScoreRoutes = require('./score.routes');
const initScoreTables = require('./score.migration');
const initScoreCron = require('./score.cron');
const scoreService = require('./score.service');

module.exports = {
  initScoreRoutes,
  initScoreTables,
  initScoreCron,
  scoreService
};
