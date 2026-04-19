/**
 * MÓDULO COLETA DE ENDEREÇOS - Routes
 *
 * Entry point que monta os sub-routers (admin e motoboy).
 * As rotas do motoboy serão adicionadas na Parte 2.
 */
const express = require('express');
const { createColetaAdminRoutes } = require('./routes/admin.routes');
const { createColetaMotoboyRoutes } = require('./routes/motoboy.routes');

function createColetaEnderecosRouter(pool, verificarToken) {
  const router = express.Router();

  router.use(createColetaAdminRoutes(pool, verificarToken));
  router.use(createColetaMotoboyRoutes(pool, verificarToken));

  return router;
}

module.exports = { createColetaEnderecosRouter };
