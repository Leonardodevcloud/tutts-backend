/**
 * MÓDULO LOGISTICS — Index
 *
 * Ponto de entrada. Fase 1B.1: agora registra UberAdapter no Registry,
 * que passa a ser instanciado para o provider 'uber' (desde que esteja
 * ativo=true em logistics_providers).
 *
 * Exporta:
 *  - initLogisticsTables(pool)  — migration + backfill (idempotente)
 *  - initLogisticsRoutes(...)    — master router /api/logistics/*
 *  - startLogisticsWorker(pool)  — Fase 1C: inicia polling Mapp
 */

const { initLogisticsTables } = require('./logistics.migration');
const { createLogisticsRouter } = require('./logistics.routes');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getEventLogger } = require('./core/EventLogger');
const { UberAdapter } = require('./adapters/uber/UberAdapter');

function initLogisticsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const registry = getProviderRegistry(pool);
  getEventLogger(pool);

  // ── Fase 1B.1: registra a classe do UberAdapter ────────────
  // O Registry vai instanciar quando logistics_providers.ativo='uber' = true.
  // Pode ficar false durante a Fase 1B — endpoints retornam erro claro nesse caso.
  registry.registerClass('uber', UberAdapter);

  // Carrega providers do banco e instancia ativos
  registry.initialize().catch(err => {
    console.error('❌ [logistics] erro ao inicializar ProviderRegistry:', err.message);
  });

  return createLogisticsRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

/**
 * Worker stub (Fase 1B.1). Implementação real fica na Fase 1C.
 */
function startLogisticsWorker(pool) {
  console.log('🛌 [logistics worker] em standby (Fase 1B.1) — worker Uber legado continua ativo');
  return {
    parar: () => console.log('🛌 [logistics worker] standby — nada a parar'),
  };
}

module.exports = {
  initLogisticsTables,
  initLogisticsRoutes,
  startLogisticsWorker,
};
