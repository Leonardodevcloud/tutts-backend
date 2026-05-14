/**
 * MÓDULO LOGISTICS — Index
 *
 * Ponto de entrada. Fase 1B.2: exporta também createLogisticsWebhookRouter,
 * que é montado em server.js como rota pública (sem JWT, antes da auth global).
 *
 * Exporta:
 *  - initLogisticsTables(pool)         — migration + backfill (idempotente)
 *  - initLogisticsRoutes(...)           — master router /api/logistics/* (autenticado)
 *  - createLogisticsWebhookRouter(pool) — router público /api/logistics/webhook/*
 *  - startLogisticsWorker(pool)         — Fase 1C: inicia polling Mapp
 */

const { initLogisticsTables } = require('./logistics.migration');
const { createLogisticsRouter } = require('./logistics.routes');
const { createLogisticsWebhookRouter } = require('./routes/webhook.routes');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getEventLogger } = require('./core/EventLogger');
const { UberAdapter } = require('./adapters/uber/UberAdapter');

function initLogisticsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const registry = getProviderRegistry(pool);
  getEventLogger(pool);

  // Registra a classe do UberAdapter (instanciada quando ativo=true no banco)
  registry.registerClass('uber', UberAdapter);

  registry.initialize().catch(err => {
    console.error('❌ [logistics] erro ao inicializar ProviderRegistry:', err.message);
  });

  return createLogisticsRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

/**
 * Worker stub (Fase 1B.2). Implementação real fica na Fase 1C.
 */
function startLogisticsWorker(pool) {
  console.log('🛌 [logistics worker] em standby (Fase 1B.2) — worker Uber legado continua ativo');
  return {
    parar: () => console.log('🛌 [logistics worker] standby — nada a parar'),
  };
}

module.exports = {
  initLogisticsTables,
  initLogisticsRoutes,
  createLogisticsWebhookRouter,
  startLogisticsWorker,
};
