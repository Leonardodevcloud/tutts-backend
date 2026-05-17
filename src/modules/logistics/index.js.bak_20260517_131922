/**
 * MÓDULO LOGISTICS — Index
 *
 * Ponto de entrada. Fase 3: registra o NinetyNineAdapter (provider '99') no
 * ProviderRegistry e roda a migration que insere a linha 'noventanove' em
 * logistics_providers.
 *
 * Exporta:
 *  - initLogisticsTables(pool)         — tabelas (F0) + backfill entregas (F2) + provider 99 (F3)
 *  - initLogisticsBackfill(pool)        — backfill de entregas isolado — exposto p/ resync
 *  - initLogisticsRoutes(...)           — master router /api/logistics/* (autenticado)
 *  - createLogisticsWebhookRouter(pool) — router público /api/logistics/webhook/*
 *  - startLogisticsWorker(pool)         — inicia o PollingWorker real
 */

// Migration base da Fase 0 — importada com alias pra não colidir com o
// wrapper initLogisticsTables exportado por este index.
const { initLogisticsTables: initTabelasBase } = require('./logistics.migration');
const { initLogisticsBackfill } = require('./logistics.backfill');
const { initLogisticsFase3 } = require('./logistics.migration-fase3');
const { createLogisticsRouter } = require('./logistics.routes');
const { createLogisticsWebhookRouter } = require('./routes/webhook.routes');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getEventLogger } = require('./core/EventLogger');
const { UberAdapter } = require('./adapters/uber/UberAdapter');
const { NinetyNineAdapter } = require('./adapters/noventanove/NinetyNineAdapter');
const { startPollingWorker } = require('./worker/PollingWorker');

/**
 * Inicializa tabelas (F0) + backfill de entregas (F2) + provider 99 (F3).
 *
 * Ordem:
 *  1. initTabelasBase — cria as 7 tabelas + backfill de config/regras/oauth.
 *     BLOQUEANTE: é estrutura.
 *  2. initLogisticsFase3 — insere a linha 'noventanove' em logistics_providers.
 *     BLOQUEANTE mas trivial: 1 INSERT idempotente (ON CONFLICT DO NOTHING).
 *     Roda ANTES do backfill porque é estrutura de provider.
 *  3. initLogisticsBackfill — copia uber_entregas → logistics_deliveries.
 *     NÃO-BLOQUEANTE: dado histórico. Se falhar, loga e segue.
 *
 * @param {import('pg').Pool} pool
 */
async function initLogisticsTables(pool) {
  await initTabelasBase(pool);

  // Fase 3: insere o provider 'noventanove' (idempotente, não sobrescreve config)
  await initLogisticsFase3(pool).catch(err => {
    console.error('⚠️ [logistics] migration fase3 (provider 99) falhou:', err.message);
  });

  // Fase 2: backfill de entregas (não-bloqueante)
  initLogisticsBackfill(pool).catch(err => {
    console.error('⚠️ [logistics] backfill de entregas falhou (não crítico):', err.message);
    console.error('   Re-execute via POST /api/logistics/_admin/resync-deliveries');
  });
}

function initLogisticsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const registry = getProviderRegistry(pool);
  getEventLogger(pool);

  // Registra as classes dos adapters. O ProviderRegistry instancia só os que
  // estiverem ativo=true no banco — então registrar a classe é barato e seguro.
  registry.registerClass('uber', UberAdapter);
  registry.registerClass('noventanove', NinetyNineAdapter);

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
