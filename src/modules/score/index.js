// ============================================================
// MÓDULO SCORE/GAMIFICAÇÃO - INDEX (v1 + v2)
// ============================================================

// V1 (legado — desativado mas tabelas mantidas)
const initScoreRoutes = require('./score.routes');
const initScoreTables = require('./score.migration');
const initScoreCron = require('./score.cron');
const scoreService = require('./score.service');

// V2 (2026-05) — nova reestruturação por região + 28d rolling
const { initScoreV2Tables } = require('./score-v2.migration');
const scoreV2Service = require('./score-v2.service');
const { createScoreV2Routes } = require('./routes/score-v2.routes');

module.exports = {
  // v1
  initScoreRoutes,
  initScoreTables,
  initScoreCron,
  scoreService,
  // v2
  initScoreV2Tables,
  scoreV2Service,
  createScoreV2Routes,
};
