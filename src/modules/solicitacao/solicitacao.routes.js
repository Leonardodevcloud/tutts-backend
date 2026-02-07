const express = require('express');
const { createSolicitacaoHelpers } = require('./solicitacao.shared');
const { createClienteRoutes } = require('./routes/cliente.routes');
const { createSolicitacaoAdminRoutes } = require('./routes/admin.routes');

function createSolicitacaoRouter(pool, verificarToken) {
  const router = express.Router();
  const helpers = createSolicitacaoHelpers(pool);

  router.use(createClienteRoutes(pool, helpers));
  router.use(createSolicitacaoAdminRoutes(pool, verificarToken, helpers));

  return router;
}

module.exports = { createSolicitacaoRouter };
