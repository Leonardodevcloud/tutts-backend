const express = require('express');
const { createScoreCoreRoutes } = require('./routes/core.routes');
const { createGamificacaoRoutes } = require('./routes/gamificacao.routes');

function initScoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  router.use(createScoreCoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
  router.use(createGamificacaoRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));
  return router;
}

module.exports = initScoreRoutes;
