/**
 * MÓDULO BI - Route Orchestrator
 * Monta 8 sub-routers por domínio lógico
 * 70 endpoints, 0 lógica de negócio aqui
 */

const express = require('express');
const { createAtualizarResumos } = require('./bi.shared');

// Sub-routers por domínio
const { createPrazosRoutes } = require('./routes/prazos.routes');
const { createEntregasRoutes } = require('./routes/entregas.routes');
const { createDashboardRoutes } = require('./routes/dashboard.routes');
const { createRelatorioIaRoutes } = require('./routes/relatorioIa.routes');
const { createDadosRoutes } = require('./routes/dados.routes');
const { createGarantidoRoutes } = require('./routes/garantido.routes');
const { createRegioesRoutes } = require('./routes/regioes.routes');
const { createAnalyticsRoutes } = require('./routes/analytics.routes');

function createBiRouter(pool) {
  const router = express.Router();

  // Função compartilhada entre sub-routers
  const atualizarResumos = createAtualizarResumos(pool);

  // Montar sub-routers (cada um é um express.Router)
  router.use(createPrazosRoutes(pool));
  router.use(createEntregasRoutes(pool, atualizarResumos));
  router.use(createDashboardRoutes(pool));
  router.use(createRelatorioIaRoutes(pool));
  router.use(createDadosRoutes(pool));
  router.use(createGarantidoRoutes(pool));
  router.use(createRegioesRoutes(pool));
  router.use(createAnalyticsRoutes(pool));

  return router;
}

module.exports = { createBiRouter };
