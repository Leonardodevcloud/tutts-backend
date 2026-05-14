/**
 * MÓDULO LOGISTICS — Index
 *
 * Ponto de entrada do módulo. Exporta:
 *  - initLogisticsTables(pool)  — cria/migra tabelas + backfill (idempotente)
 *  - initLogisticsRoutes(...)    — monta o master router /api/logistics/*
 *  - startLogisticsWorker(pool)  — Fase 1: inicia polling Mapp
 *
 * Fase 0:
 *  - initLogisticsTables: COMPLETO (cria 7 tabelas + backfill)
 *  - initLogisticsRoutes: COMPLETO mas rotas operacionais retornam 501
 *  - startLogisticsWorker: STUB (loga e dorme — worker Uber legado continua rodando)
 */

const { initLogisticsTables } = require('./logistics.migration');
const { createLogisticsRouter } = require('./logistics.routes');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getEventLogger } = require('./core/EventLogger');

/**
 * Inicializa as rotas do módulo.
 * Chamado a partir de server.js:
 *
 *   app.use('/api/logistics', initLogisticsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
 *
 * Também inicializa o ProviderRegistry (que lê linhas de logistics_providers e
 * tenta instanciar adapters cujas classes foram registradas via registry.registerClass).
 *
 * Na Fase 0, nenhuma classe de adapter é registrada — o registry fica vazio,
 * mas a tabela já tem 'uber' como linha cadastrada (ativo=false).
 */
function initLogisticsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  // Garante que o registry e o logger sejam instanciados (singletons)
  const registry = getProviderRegistry(pool);
  getEventLogger(pool);

  // ────────────────────────────────────────────────────────
  // FASE 1: registrar AdapterClasses aqui antes do .initialize()
  // ────────────────────────────────────────────────────────
  // Ex (na Fase 1):
  //   const { UberAdapter } = require('./adapters/uber/UberAdapter');
  //   registry.registerClass('uber', UberAdapter);
  //
  // Ex (na Fase 3):
  //   const { NinetyNineAdapter } = require('./adapters/ninety_nine/NinetyNineAdapter');
  //   registry.registerClass('noventanove', NinetyNineAdapter);

  // Inicializa o registry (lê providers do banco). Fire-and-forget porque
  // não queremos travar o startup do server caso o banco esteja lento.
  // O singleton garante idempotência: chamadas subsequentes a get() esperam
  // implicitamente porque _initialized vira true ao final.
  registry.initialize().catch(err => {
    console.error('❌ [logistics] erro ao inicializar ProviderRegistry:', err.message);
  });

  return createLogisticsRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

/**
 * Worker stub (Fase 0).
 *
 * Na Fase 1, este worker fará o que o startUberWorker atual faz:
 *  1. Polling Mapp para listar OS abertas (status=0)
 *  2. Para cada OS, consulta DispatchRuleMatcher
 *  3. Chama Orchestrator.tentarDespacho()
 *  4. Verifica timeouts e promove para fallback_queue
 *
 * Aqui só loga e fica em standby — sem mexer no fluxo Uber atual.
 */
function startLogisticsWorker(pool) {
  console.log('🛌 [logistics worker] em standby (Fase 0) — worker Uber legado continua ativo');
  // Retorna handle compatível com startUberWorker pra simetria de API
  return {
    parar: () => {
      console.log('🛌 [logistics worker] standby — nada a parar');
    },
  };
}

module.exports = {
  initLogisticsTables,
  initLogisticsRoutes,
  startLogisticsWorker,
};
