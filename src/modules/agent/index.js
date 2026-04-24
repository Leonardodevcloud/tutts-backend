// ============================================================
// MÓDULO AGENTE RPA - INDEX (refactor pool 2026-04)
// Ponto de entrada único do módulo
//
// MUDANÇAS PRINCIPAIS:
//   - Workers antigos (agent-worker.js, sla-capture-worker.js, sla-detector-worker.js)
//     substituídos por agentes registrados no agent-pool.
//   - Cada agente roda N slots paralelos com 1 conta por slot.
//   - browser-pool global garante max BROWSER_POOL_SIZE Chromiums simultâneos.
//
// Endpoints:
//   POST /agent/corrigir-endereco
//   GET  /agent/status/:id
//   GET  /agent/historico        (admin)
//   PATCH /agent/validar/:id     (admin)
//   GET  /agent/historico/csv    (admin)
//   GET  /agent/pool/status      (admin) — snapshot do pool
//   POST /agent/sla-capture/trigger      (extensão — Origin validada)
//   GET  /agent/sla-capture/historico    (admin)
//   GET  /agent/sla-capture/status/:os   (admin)
//
// Tabelas: ajustes_automaticos, sla_capturas
// ============================================================

const { createAgentRouter } = require('./agent.routes');
const initAgentTablesBase   = require('./agent.migration');
const initSlaCaptureTables  = require('./sla-capture.migration');
const agentPool             = require('./core/agent-pool');

// Agentes registrados
const slaCaptureAgent   = require('./agents/sla-capture.agent');
const agentCorrecaoAgent = require('./agents/agent-correcao.agent');
const slaDetectorAgent  = require('./agents/sla-detector.agent');

// Init agregado
async function initAgentTables(pool) {
  await initAgentTablesBase(pool);
  try {
    await initSlaCaptureTables(pool);
  } catch (e) {
    console.error('⚠️ SLA Capture tables error:', e.message);
  }
}

// Registra os 3 agentes e inicia o pool
function startAgentWorker(pool) {
  // Skip se rodando em modo worker separado E não estamos no worker
  // (controlado por AGENTS_RUN_HERE — ver worker-agents.js)
  if (process.env.AGENTS_WORKER_SEPARADO === 'true' && process.env.AGENTS_RUN_HERE !== 'true') {
    console.log('🔇 Agentes Playwright desabilitados neste processo (rodando no worker separado)');
    return;
  }

  try {
    agentPool.register(slaCaptureAgent);
    agentPool.register(agentCorrecaoAgent);
    agentPool.register(slaDetectorAgent);
    agentPool.startAll(pool);
    console.log('✅ Agent pool iniciado com 3 agentes');
  } catch (e) {
    console.error('❌ Falha ao iniciar agent pool:', e.message);
  }
}

// Expõe snapshot pra rota de health
function getPoolSnapshot() {
  return agentPool.snapshot();
}

module.exports = {
  initAgentRoutes: createAgentRouter,
  initAgentTables,
  startAgentWorker,
  getPoolSnapshot,
  // Acesso direto ao pool pra testes/debug
  _agentPool: agentPool,
};
