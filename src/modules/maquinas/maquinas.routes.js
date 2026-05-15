/**
 * Módulo Máquinas — Router principal
 *
 * Reutiliza verificarTokenSolicitacao do módulo solicitacao (mesma sessão de
 * cliente — o atendente da loja loga uma vez e opera tudo: corridas + máquinas).
 *
 * Endpoints admin Tutts (visão global) usam verificarToken do staff/auth.
 */

const express = require('express');
const { createSolicitacaoHelpers } = require('../solicitacao/solicitacao.shared');
const { createMaquinasClienteRoutes } = require('./routes/cliente.routes');
const { createMaquinasAdminRoutes } = require('./routes/admin.routes');
const { createMaquinasMotoboyRoutes } = require('./routes/motoboy.routes');

function createMaquinasRouter(pool, verificarToken) {
  const router = express.Router();
  const solicitacaoHelpers = createSolicitacaoHelpers(pool);

  router.use(createMaquinasClienteRoutes(pool, solicitacaoHelpers));
  router.use(createMaquinasAdminRoutes(pool, verificarToken));
  router.use(createMaquinasMotoboyRoutes(pool, verificarToken));

  return router;
}

module.exports = { createMaquinasRouter };
