/**
 * MÓDULO OPERACIONAL
 * Avisos (7 endpoints) + Incentivos (9 endpoints) + Operações (6 endpoints)
 * Total: 22 endpoints, 5 tabelas
 */

const { initOperacionalTables } = require('./operacional.migration');
const { createAvisosRouter, createIncentivosRouter, createOperacoesRouter } = require('./operacional.routes');

function initOperacionalRoutes(pool) {
  const avisosRouter = createAvisosRouter(pool);
  const incentivosRouter = createIncentivosRouter(pool);
  const operacoesRouter = createOperacoesRouter(pool);

  return { avisosRouter, incentivosRouter, operacoesRouter };
}

module.exports = { initOperacionalRoutes, initOperacionalTables };
