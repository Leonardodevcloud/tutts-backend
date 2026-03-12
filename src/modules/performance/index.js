/**
 * MÓDULO PERFORMANCE DIÁRIA - Index
 * ============================================================
 * Endpoints:
 *   GET  /performance/snapshot
 *   GET  /performance/historico
 *   POST /performance/executar
 *   GET  /performance/jobs
 *   GET  /performance/jobs/:id
 *   GET  /performance/clientes
 *
 * Tabelas: performance_snapshots, performance_jobs
 * Worker: a cada 5min via setTimeout recursivo
 * ============================================================
 */

const { createPerformanceRouter }  = require('./performance.routes');
const initPerformanceTables        = require('./performance.migration');
const { startPerformanceWorker }   = require('./performance-worker');

module.exports = {
  initPerformanceRoutes: createPerformanceRouter,
  initPerformanceTables,
  startPerformanceWorker,
};
