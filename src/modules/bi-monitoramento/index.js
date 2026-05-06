/**
 * MÓDULO BI MONITORAMENTO
 *
 * Versão operacional do BI principal — sem dados financeiros.
 * Acesso restrito a admin e admin_master.
 *
 * Read-only sobre tabelas existentes: bi_entregas, bi_regioes.
 * Não cria tabelas próprias (initBiMonitoramentoTables é no-op).
 *
 * Reaproveita 100% das regras do BI principal:
 *  - dentro_prazo já vem pré-calculado por cliente/centro de custo
 *    no upload via Marcos (regra 767 <= 120min, etc).
 *  - COALESCE(ponto, 1) >= 2 pra contar só entregas (não OS).
 *  - Filtro de retornos com mesma string-match do dashboard atual.
 */
const { createBiMonitoramentoRouter } = require('./bi-monitoramento.routes');

function initBiMonitoramentoRoutes(pool, verificarToken, verificarAdmin) {
  return createBiMonitoramentoRouter(pool, verificarToken, verificarAdmin);
}

// No-op: módulo é read-only sobre tabelas do BI principal.
async function initBiMonitoramentoTables(/* pool */) {
  return Promise.resolve();
}

module.exports = { initBiMonitoramentoRoutes, initBiMonitoramentoTables };
