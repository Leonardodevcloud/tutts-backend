/**
 * MÓDULO UBER - Router Principal
 * Monta sub-routers: admin (JWT), webhook (público), tracking (JWT)
 */
const express = require('express');
const { createUberAdminRoutes } = require('./routes/admin.routes');
const { createUberWebhookRoutes } = require('./routes/webhook.routes');
const { createUberTrackingRoutes } = require('./routes/tracking.routes');

function createUberRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // Admin: config, entregas, métricas (requer JWT + admin)
  router.use(createUberAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

  // Tracking: posição em tempo real (requer JWT)
  router.use('/tracking', createUberTrackingRoutes(pool, verificarToken));

  // Webhook: recebe eventos da Uber (PÚBLICO - sem JWT, validação HMAC própria)
  router.use('/webhook', createUberWebhookRoutes(pool));

  return router;
}

module.exports = { createUberRouter };
