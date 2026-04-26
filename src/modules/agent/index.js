// ============================================================
// MÓDULO AGENTE RPA - INDEX (refactor pool 2026-04 - Etapa A)
// Ponto de entrada único do módulo
//
// AGENTES REGISTRADOS:
//   ETAPA INICIAL (já em produção):
//     1. sla-capture       — 3 slots, captura pontos das OS
//     2. agent-correcao    — 2 slots, correção de endereço
//     3. sla-detector      — cron 2min, detecta OS novas
//
//   ETAPA A (esta entrega):
//     4. performance       — fila batch (30s), processa performance_jobs
//     5. performance-cron-1010 — cron 10:10 dias úteis (cria jobs)
//     6. performance-cron-1400 — cron 14:00 dias úteis (cria jobs)
//     7. performance-cron-1710 — cron 17:10 dias úteis (cria jobs)
//     8. crm-leads         — fila item-por-item, processa crm_captura_jobs
//
// Endpoints:
//   POST /agent/corrigir-endereco
//   GET  /agent/status/:id
//   GET  /agent/historico        (admin)
//   GET  /agent/pool/status      (admin)
//   POST /agent/sla-capture/trigger      (extensão)
//   GET  /agent/sla-capture/historico    (admin)
// ============================================================

const { createAgentRouter } = require('./agent.routes');
const initAgentTablesBase   = require('./agent.migration');
const initSlaCaptureTables  = require('./sla-capture.migration');
const initLiberacaoTables   = require('./liberacao.migration');  // 2026-04 v3: novo módulo
const agentPool             = require('./core/agent-pool');

// ── Agentes ──────────────────────────────────────────────────
const slaCaptureAgent     = require('./agents/sla-capture.agent');
const agentCorrecaoAgent  = require('./agents/agent-correcao.agent');
const slaDetectorAgent    = require('./agents/sla-detector.agent');
const performanceAgent    = require('./agents/performance.agent');
const performanceCronAgents = require('./agents/performance-cron.agent'); // ARRAY de 3 agentes
const crmLeadsAgent       = require('./agents/crm-leads.agent');
const liberarPontoAgent   = require('./agents/liberar-ponto.agent');     // 2026-04 v3
const biImportAgent       = require('./agents/bi-import.agent');         // 2026-04 v3
const initBiImportTables  = require('./bi-import.migration');            // 2026-04 v3

async function initAgentTables(pool) {
  await initAgentTablesBase(pool);
  try {
    await initSlaCaptureTables(pool);
  } catch (e) {
    console.error('⚠️ SLA Capture tables error:', e.message);
  }
  // 2026-04 v3: tabela do novo módulo Liberar Ponto
  try {
    await initLiberacaoTables(pool);
  } catch (e) {
    console.error('⚠️ Liberacao tables error:', e.message);
  }
  // 2026-04 v3: tabela do novo módulo BI Import
  try {
    await initBiImportTables(pool);
  } catch (e) {
    console.error('⚠️ BI Import tables error:', e.message);
  }
}

function startAgentWorker(pool) {
  if (process.env.AGENTS_WORKER_SEPARADO === 'true' && process.env.AGENTS_RUN_HERE !== 'true') {
    console.log('🔇 Agentes Playwright desabilitados neste processo (rodando no worker separado)');
    return;
  }

  try {
    // Etapa inicial
    agentPool.register(slaCaptureAgent);
    agentPool.register(agentCorrecaoAgent);
    agentPool.register(slaDetectorAgent);

    // Etapa A — performance
    agentPool.register(performanceAgent);
    for (const cronAgent of performanceCronAgents) {
      agentPool.register(cronAgent);
    }

    // Etapa A — CRM
    agentPool.register(crmLeadsAgent);
    // 2026-04 v3: novo agente "Liberar Ponto"
    agentPool.register(liberarPontoAgent);

    // 2026-04 v3: novo agente "BI Import"
    agentPool.register(biImportAgent);
    // Cron próprio pra criar job D-1 às 10h da manhã (diferente do cron do agent que processa).
    // Esse cron só CRIA o job — o worker do pool pega depois.
    try {
      const cron = require('node-cron');
      const cronExpr = process.env.BI_IMPORT_CRON || '0 10 * * *';
      cron.schedule(cronExpr, async () => {
        try {
          const data = biImportAgent.calcularDataD1();
          await biImportAgent.criarJobCronSeNaoExistir(pool, data);
        } catch (e) {
          console.error('[bi-import-cron] erro:', e.message);
        }
      }, { timezone: 'America/Bahia' });
      console.log(`📅 Cron BI Import agendado: "${cronExpr}" (TZ: America/Bahia)`);
    } catch (e) {
      console.error('⚠️ Falha ao agendar cron BI Import:', e.message);
    }

    agentPool.startAll(pool);
    console.log('✅ Agent pool iniciado com 9 agentes');
  } catch (e) {
    console.error('❌ Falha ao iniciar agent pool:', e.message);
  }
}

function getPoolSnapshot() {
  return agentPool.snapshot();
}

module.exports = {
  initAgentRoutes: createAgentRouter,
  initAgentTables,
  startAgentWorker,
  getPoolSnapshot,
  _agentPool: agentPool,
};
