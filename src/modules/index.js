/**
 * MÓDULO GERENCIAL - Análise Gerencial Semanal
 * Relatório semanal consolidado com KPIs, SLA por cliente,
 * ticket médio, variação de demanda e mínimo garantido.
 * Consome dados de bi_entregas + bi_garantido_cache.
 */
const { createGerencialRouter } = require('./gerencial.routes');

function initGerencialRoutes(pool, verificarToken) {
  return createGerencialRouter(pool, verificarToken);
}

module.exports = { initGerencialRoutes };
