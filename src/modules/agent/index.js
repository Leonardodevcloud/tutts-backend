// ============================================================
// MÓDULO AGENTE RPA - INDEX
// Ponto de entrada único do módulo
//
// Endpoints:
//   POST /agent/corrigir-endereco
//   GET  /agent/status/:id
//   GET  /agent/historico        (admin)
//   PATCH /agent/validar/:id     (admin)
//   GET  /agent/historico/csv    (admin)
//   POST /agent/sla-capture/trigger      (extensão — Origin validada)
//   GET  /agent/sla-capture/historico    (admin)
//   GET  /agent/sla-capture/status/:os   (admin)
//
// Tabelas: ajustes_automaticos, sla_capturas
// Workers: agent-worker (correção endereços) + sla-capture-worker (rastreio)
// ============================================================

const { createAgentRouter }     = require('./agent.routes');
const initAgentTablesBase       = require('./agent.migration');
const initSlaCaptureTables      = require('./sla-capture.migration');
const { startAgentWorker: startAgentCorrecaoWorker } = require('./agent-worker');
const { startSlaCaptureWorker } = require('./sla-capture-worker');

// Init agregado: cria tabelas do agent + sla-capture numa chamada só
async function initAgentTables(pool) {
  await initAgentTablesBase(pool);
  try {
    await initSlaCaptureTables(pool);
  } catch (e) {
    console.error('⚠️ SLA Capture tables error:', e.message);
  }
}

// Start agregado: sobe worker de correção + worker de sla-capture
function startAgentWorker(pool) {
  startAgentCorrecaoWorker(pool);
  try {
    startSlaCaptureWorker(pool);
  } catch (e) {
    console.error('⚠️ SLA Capture worker error:', e.message);
  }
}

module.exports = {
  initAgentRoutes: createAgentRouter,
  initAgentTables,
  startAgentWorker,
};
