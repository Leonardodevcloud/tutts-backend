/**
 * MÓDULO SUCESSO DO CLIENTE (CS) - Route Orchestrator
 * Monta 5 sub-routers por domínio lógico
 * 0 lógica de negócio aqui — só wiring
 */

const express = require('express');

// Sub-routers por domínio
const { createClientesRoutes } = require('./routes/clientes.routes');
const { createInteracoesRoutes } = require('./routes/interacoes.routes');
const { createOcorrenciasRoutes } = require('./routes/ocorrencias.routes');
const { createDashboardRoutes } = require('./routes/dashboard.routes');
const { createRaioXRoutes } = require('./routes/raioX.routes');

function createCsRouter(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // Montar sub-routers
  router.use(createClientesRoutes(pool));
  router.use(createInteracoesRoutes(pool));
  router.use(createOcorrenciasRoutes(pool));
  router.use(createDashboardRoutes(pool));
  router.use(createRaioXRoutes(pool));

  console.log('✅ Módulo Sucesso do Cliente — rotas montadas (5 sub-routers)');

  return router;
}

module.exports = { createCsRouter };
