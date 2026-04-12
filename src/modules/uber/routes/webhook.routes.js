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

      const signature = req.headers['x-uber-signature'] || req.headers['x-postmates-signature'];

      if (!signature) {
        console.warn(`⚠️ [Uber Webhook] Rejeitado - sem header de assinatura de ${req.ip}`);
        return res.status(401).json({ error: 'Assinatura ausente' });
      }

      const rawBody = JSON.stringify(req.body);
      const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('hex');

      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);

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
