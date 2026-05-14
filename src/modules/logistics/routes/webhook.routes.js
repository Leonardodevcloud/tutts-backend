/**
 * MÓDULO LOGISTICS — Webhook Routes
 *
 * Router PÚBLICO (sem JWT) para receber webhooks de qualquer provider.
 * Montado em server.js ANTES da auth global, igual ao webhook Uber legado.
 *
 * Rota: POST /api/logistics/webhook/:provider
 *   :provider = 'uber' | 'noventanove' | ...
 *
 * A validação de autenticidade (HMAC, Basic Auth, etc) é responsabilidade
 * do adapter de cada provider — o WebhookDispatcher delega.
 *
 * IMPORTANTE: este router precisa de req.rawBody pra validação HMAC.
 * O server.js deve capturar rawBody para /api/logistics/webhook/* no
 * verify callback do express.json (ver server.js.patch.md).
 *
 * Aceita também subpaths legados pra compatibilidade futura:
 *   POST /api/logistics/webhook/uber
 *   POST /api/logistics/webhook/uber/status
 *   POST /api/logistics/webhook/uber/courier
 * Todos vão pro mesmo handler (o tipo é detectado pelo payload).
 */

const express = require('express');
const { getWebhookDispatcher } = require('../core/WebhookDispatcher');

function createLogisticsWebhookRouter(pool) {
  const router = express.Router();
  const dispatcher = getWebhookDispatcher(pool);

  /**
   * Handler genérico — extrai :provider e delega ao WebhookDispatcher.
   */
  async function handle(req, res) {
    const providerCode = (req.params.provider || '').toLowerCase().trim();

    if (!providerCode) {
      return res.status(400).json({ error: 'provider ausente na URL' });
    }

    // Log mínimo de entrada (o WebhookDispatcher loga o resto em logistics_events)
    console.log(`🪝 [logistics/webhook] recebido para provider='${providerCode}' path=${req.path}`);

    try {
      await dispatcher.handle(providerCode, req, res);
    } catch (err) {
      console.error(`❌ [logistics/webhook] erro não-tratado para ${providerCode}:`, err.message);
      // Se ainda não respondeu, responde 500
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro interno' });
      }
    }
  }

  // Rota principal: POST /api/logistics/webhook/:provider
  router.post('/:provider', handle);

  // Subpaths legados (compat com URLs que possam ser cadastradas com sufixo)
  router.post('/:provider/status', handle);
  router.post('/:provider/courier', handle);
  router.post('/:provider/refund', handle);

  return router;
}

module.exports = { createLogisticsWebhookRouter };
