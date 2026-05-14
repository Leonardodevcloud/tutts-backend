/**
 * MÓDULO LOGISTICS — Index
 *
 * Ponto de entrada. Fase 1C: startLogisticsWorker agora inicia o PollingWorker
 * REAL (substitui o stub que vinha desde a Fase 0).
 *
 * O PollingWorker é controlado por logistics_worker_state (tabela):
 *  - ativo=false → worker dorme (não faz polling)
 *  - ativo=true, auto_despacho=false → polling + só verifica timeouts
 *  - ativo=true, auto_despacho=true → despacha de verdade
 * Ligar/desligar é UPDATE SQL — sem deploy.
 *
 * Exporta:
 *  - initLogisticsTables(pool)         — migration + backfill (idempotente)
 *  - initLogisticsRoutes(...)           — master router /api/logistics/* (autenticado)
 *  - createLogisticsWebhookRouter(pool) — router público /api/logistics/webhook/*
 *  - startLogisticsWorker(pool)         — inicia o PollingWorker real
 */

const { initLogisticsTables } = require('./logistics.migration');
const { createLogisticsRouter } = require('./logistics.routes');
const { createLogisticsWebhookRouter } = require('./routes/webhook.routes');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getEventLogger } = require('./core/EventLogger');
const { UberAdapter } = require('./adapters/uber/UberAdapter');
const { startPollingWorker } = require('./worker/PollingWorker');

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
 * Inicia o PollingWorker real.
 *
 * IMPORTANTE: chamar isto NÃO liga a automação. O worker sobe e fica em
 * standby até logistics_worker_state.ativo = true (controle por SQL).
 * É seguro deployar com isto chamado — o worker dorme sozinho.
 *
 * @param {import('pg').Pool} pool
 * @returns {{ parar: Function }}
 */
function startLogisticsWorker(pool) {
  return startPollingWorker(pool);
}

module.exports = {
  initLogisticsTables,
  initLogisticsRoutes,
  createLogisticsWebhookRouter,
  startLogisticsWorker,
};
