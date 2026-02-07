/**
 * src/middleware/webhookAuth.js
 * 🔒 SECURITY: Validação de webhooks
 * 
 * Se WEBHOOK_SECRET estiver configurada: valida HMAC-SHA256
 * Se não: loga + validação básica (payload não vazio)
 */

const crypto = require('crypto');

/**
 * Validar assinatura HMAC-SHA256 do webhook
 * Header esperado: X-Webhook-Signature: sha256=<hmac>
 */
function verificarWebhookSignature(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;

  // Sem secret = modo permissivo com logging
  if (!secret) {
    console.log(`📨 [WEBHOOK] ${req.method} ${req.path} from ${req.ip} (sem validação de assinatura)`);
    return next();
  }

  const signature = req.headers['x-webhook-signature'] || req.headers['x-hub-signature-256'];

  if (!signature) {
    console.warn(`⚠️ [WEBHOOK] Rejeitado - sem header de assinatura de ${req.ip}`);
    return res.status(401).json({ error: 'Assinatura do webhook ausente' });
  }

  const body = JSON.stringify(req.body);
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn(`⚠️ [WEBHOOK] Rejeitado - assinatura inválida de ${req.ip}`);
    return res.status(403).json({ error: 'Assinatura inválida' });
  }

  console.log(`✅ [WEBHOOK] Assinatura válida de ${req.ip}`);
  next();
}

/**
 * Validação básica de webhook (defense-in-depth)
 */
function webhookBasicValidation(req, res, next) {
  if (!req.body || Object.keys(req.body).length === 0) {
    console.warn(`⚠️ [WEBHOOK] Body vazio de ${req.ip}`);
    return res.status(400).json({ error: 'Payload vazio' });
  }

  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 1048576) {
    console.warn(`⚠️ [WEBHOOK] Payload muito grande (${contentLength}b) de ${req.ip}`);
    return res.status(413).json({ error: 'Payload muito grande' });
  }

  next();
}

module.exports = { verificarWebhookSignature, webhookBasicValidation };
