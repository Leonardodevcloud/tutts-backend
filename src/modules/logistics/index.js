/**
 * MÓDULO LOGISTICS — Index
 *
 * Ponto de entrada. Fase 2: adiciona o backfill uber_entregas → logistics_deliveries,
 * rodado de forma não-bloqueante após as tabelas base.
 *
 * Exporta:
 *  - initLogisticsTables(pool)         — tabelas (Fase 0) + backfill de entregas (Fase 2)
 *  - initLogisticsBackfill(pool)        — backfill de entregas isolado — exposto p/ resync
 *  - initLogisticsRoutes(...)           — master router /api/logistics/* (autenticado)
 *  - createLogisticsWebhookRouter(pool) — router público /api/logistics/webhook/*
 *  - startLogisticsWorker(pool)         — inicia o PollingWorker real
 */

// Migration base da Fase 0 — importada com alias pra não colidir com o
// wrapper initLogisticsTables exportado por este index.
const { initLogisticsTables: initTabelasBase } = require('./logistics.migration');
const { initLogisticsBackfill } = require('./logistics.backfill');
const { createLogisticsRouter } = require('./logistics.routes');
const { createLogisticsWebhookRouter } = require('./routes/webhook.routes');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getEventLogger } = require('./core/EventLogger');
const { UberAdapter } = require('./adapters/uber/UberAdapter');
const { startPollingWorker } = require('./worker/PollingWorker');

/**
 * Inicializa tabelas (Fase 0) + backfill de entregas (Fase 2).
 *
 * Ordem:
 *  1. initTabelasBase — cria as 7 tabelas + backfill de config/regras/oauth.
 *     BLOQUEANTE: é estrutura, o resto do sistema depende disso.
 *  2. initLogisticsBackfill — copia uber_entregas → logistics_deliveries.
 *     NÃO-BLOQUEANTE: é dado histórico, não caminho crítico. Se falhar,
 *     loga e segue; pode ser re-executado via POST /_admin/resync-deliveries.
 *
 * @param {import('pg').Pool} pool
 */
async function initLogisticsTables(pool) {
  await initTabelasBase(pool);

  initLogisticsBackfill(pool).catch(err => {
    console.error('⚠️ [logistics] backfill de entregas falhou (não crítico):', err.message);
    console.error('   Re-execute via POST /api/logistics/_admin/resync-deliveries');
  });
}

function initLogisticsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const registry = getProviderRegistry(pool);
  getEventLogger(pool);

  registry.registerClass('uber', UberAdapter);

  registry.initialize().catch(err => {
    console.error('❌ [logistics] erro ao inicializar ProviderRegistry:', err.message);
  });

  return createLogisticsRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

function startLogisticsWorker(pool) {
  return startPollingWorker(pool);
}

module.exports = {
  initLogisticsTables,
  initLogisticsBackfill,
  initLogisticsRoutes,
  createLogisticsWebhookRouter,
  startLogisticsWorker,
};
