/**
 * Sub-Router: Uber Webhooks
 * Endpoints PÚBLICOS (sem JWT) para receber webhooks da Uber Direct
 * Autenticação via HMAC-SHA256 (x-uber-signature)
 */
const express = require('express');
const crypto = require('crypto');
const { processarWebhookStatus, processarWebhookCourier, obterConfig } = require('../uber.service');

function createUberWebhookRoutes(pool) {
  const router = express.Router();

  /**
   * Middleware: validar assinatura HMAC-SHA256 da Uber
   *
   * Doc oficial:
   *   "Each webhook request has a X-Postmates-Signature header which is
   *    generated using a shared secret and the payload of the webhook request.
   *    To verify that the request came from Postmates, pass the secret and
   *    payload through the SHA-256 hashing algorithm, and make sure it's equal
   *    to X-Postmates-Signature."
   *
   *   Headers aceitos: x-uber-signature OU x-postmates-signature.
   *
   * IMPORTANTE: precisa do RAW BODY (string original recebida na request),
   * não do JSON parseado e re-stringificado — caracteres unicode escapados
   * (\uXXXX) podem reordenar e a assinatura nunca bate.
   *
   * O server.js já captura req.rawBody no middleware express.json
   * (linha ~91) para todas as rotas /api/uber/webhook.
   */
  async function verificarAssinaturaUber(req, res, next) {
    try {
      const config = await obterConfig(pool);
      const secret = config?.webhook_secret;

      // Em dev sem secret configurado, aceitar (com log)
      if (!secret) {
        const isProd = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
        if (isProd) {
          console.error('❌ [Uber Webhook] REJEITADO — webhook_secret não configurado em produção');
          return res.status(503).json({ error: 'Webhook não configurado' });
        }
        console.warn('⚠️ [Uber Webhook] Sem validação de assinatura (dev mode)');
        return next();
      }

      // Tenta múltiplos nomes de header — o Uber Direct varia conforme versão da API
      // Headers conhecidos: x-uber-signature, x-postmates-signature, x-uber-signature-v2, webhook-signature
      const signature =
        req.headers['x-uber-signature'] ||
        req.headers['x-uber-signature-v2'] ||
        req.headers['x-postmates-signature'] ||
        req.headers['webhook-signature'] ||
        req.headers['x-webhook-signature'];

      if (!signature) {
        // Loga TODOS os headers recebidos pra a gente descobrir o nome certo
        const headersDebug = JSON.stringify(req.headers, null, 2);
        console.warn(`⚠️ [Uber Webhook] Rejeitado - sem header de assinatura de ${req.ip}`);
        console.warn(`⚠️ [Uber Webhook] HEADERS RECEBIDOS:\n${headersDebug}`);
        return res.status(401).json({ error: 'Assinatura ausente', received_headers: Object.keys(req.headers) });
      }

      console.log(`✅ [Uber Webhook] Header de assinatura encontrado (${signature.substring(0, 12)}...)`);

      // Usar raw body capturado no express.json verify (server.js)
      const rawBody = req.rawBody;
      if (!rawBody) {
        console.error('❌ [Uber Webhook] req.rawBody não disponível — verificar middleware express.json no server.js');
        return res.status(500).json({ error: 'Raw body não capturado' });
      }

      const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('hex');

      const sigBuf = Buffer.from(String(signature), 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        console.warn(`⚠️ [Uber Webhook] Assinatura inválida de ${req.ip}`);
        return res.status(403).json({ error: 'Assinatura inválida' });
      }

      next();
    } catch (error) {
      console.error('❌ [Uber Webhook] Erro na validação:', error.message);
      return res.status(500).json({ error: 'Erro na validação do webhook' });
    }
  }

  /**
   * POST /webhook/status — Receber atualizações de status da entrega
   * Tipos: event.delivery_status
   */
  router.post('/status', verificarAssinaturaUber, async (req, res) => {
    const payload = req.body;

    // Responder 200 imediatamente (Uber espera resposta rápida)
    res.status(200).json({ received: true });

    try {
      const deliveryId = payload.data?.id || payload.data?.delivery_id;
      const status = payload.data?.status;

      // Buscar codigoOS para log
      let codigoOS = null;
      if (deliveryId) {
        const { rows } = await pool.query(
          'SELECT codigo_os FROM uber_entregas WHERE uber_delivery_id = $1',
          [deliveryId]
        );
        codigoOS = rows[0]?.codigo_os;
      }

      // Registrar no log
      await pool.query(`
        INSERT INTO uber_webhooks_log (tipo, delivery_id, codigo_os, payload, processado)
        VALUES ($1, $2, $3, $4, $5)
      `, ['delivery_status', deliveryId, codigoOS, JSON.stringify(payload), false]);

      console.log(`📨 [Uber Webhook] Status: delivery=${deliveryId}, status=${status}, OS=${codigoOS}`);

      // Processar
      await processarWebhookStatus(pool, payload);

      // Marcar como processado
      await pool.query(`
        UPDATE uber_webhooks_log SET processado = true
        WHERE delivery_id = $1 AND tipo = 'delivery_status'
        AND created_at = (SELECT MAX(created_at) FROM uber_webhooks_log WHERE delivery_id = $1 AND tipo = 'delivery_status')
      `, [deliveryId]);

    } catch (error) {
      console.error('❌ [Uber Webhook] Erro ao processar status:', error.message);
      // Registrar erro no log
      await pool.query(`
        UPDATE uber_webhooks_log SET erro = $1
        WHERE delivery_id = $2 AND tipo = 'delivery_status'
        AND created_at = (SELECT MAX(created_at) FROM uber_webhooks_log WHERE delivery_id = $2 AND tipo = 'delivery_status')
      `, [error.message, req.body?.data?.id]).catch(() => {});
    }
  });

  /**
   * POST /webhook/courier — Receber atualizações do entregador (lat/lng a cada 20s)
   * Tipos: event.courier_update
   */
  router.post('/courier', verificarAssinaturaUber, async (req, res) => {
    const payload = req.body;

    // Responder 200 imediatamente
    res.status(200).json({ received: true });

    try {
      const deliveryId = payload.data?.id || payload.data?.delivery_id;

      // Log (sem salvar payload completo do courier update — é muito frequente)
      await pool.query(`
        INSERT INTO uber_webhooks_log (tipo, delivery_id, payload, processado)
        VALUES ($1, $2, $3, $4)
      `, ['courier_update', deliveryId, JSON.stringify({ status: payload.data?.status, has_courier: !!payload.data?.courier }), true]);

      // Processar
      await processarWebhookCourier(pool, payload);

    } catch (error) {
      console.error('❌ [Uber Webhook] Erro ao processar courier update:', error.message);
    }
  });

  return router;
}

module.exports = { createUberWebhookRoutes };
