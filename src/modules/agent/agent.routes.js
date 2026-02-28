/**
 * MÓDULO AGENTE RPA - Route Orchestrator
 * Monta sub-routers por domínio.
 * 0 lógica de negócio aqui — só wiring.
 */

'use strict';

const express = require('express');
const { createCorrecaoRoutes } = require('./routes/correcao.routes');
const { createHistoricoRoutes } = require('./routes/historico.routes');

function createAgentRouter(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  router.use(createCorrecaoRoutes(pool));
  router.use(createHistoricoRoutes(pool, verificarAdmin));

  console.log('✅ Módulo Agente RPA — rotas montadas (2 sub-routers)');
  return router;
}

module.exports = { createAgentRouter };
