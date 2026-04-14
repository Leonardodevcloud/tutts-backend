/**
 * MÓDULO UBER - Router Principal
 * Monta sub-routers: admin (JWT), tracking (JWT)
 *
 * ⚠️ O sub-router de webhook NÃO é montado aqui — ele é montado direto
 * em server.js (em /api/uber/webhook) ANTES dos middlewares globais de
 * auth, porque webhooks da Uber são públicos (validados via HMAC) e
 * morreriam num verificarToken global se passassem por aqui.
 */
const express = require('express');
const { createUberAdminRoutes } = require('./routes/admin.routes');
const { createUberTrackingRoutes } = require('./routes/tracking.routes');

function createUberRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // Admin: config, entregas, métricas (requer JWT + admin)
  router.use(createUberAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

  // Tracking: posição em tempo real (requer JWT)
  router.use('/tracking', createUberTrackingRoutes(pool, verificarToken));

  // Webhook: NÃO montado aqui (vide nota acima — montado em server.js)

  return router;
}

module.exports = { createUberRouter };
