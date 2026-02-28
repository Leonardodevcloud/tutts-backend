// ============================================================
// MÓDULO AGENTE RPA - INDEX
// Ponto de entrada único do módulo
//
// Endpoints: 5
//   POST /agent/corrigir-endereco
//   GET  /agent/status/:id
//   GET  /agent/historico        (admin)
//   PATCH /agent/validar/:id     (admin)
//   GET  /agent/historico/csv    (admin)
//
// Tabelas: ajustes_automaticos
// Worker: setInterval 10s — 1 registro por vez via Playwright
// ============================================================

const { createAgentRouter } = require('./agent.routes');
const initAgentTables       = require('./agent.migration');
const { startAgentWorker }  = require('./agent-worker');

module.exports = {
  initAgentRoutes: createAgentRouter,
  initAgentTables,
  startAgentWorker,
};
