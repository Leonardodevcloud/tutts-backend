/**
 * UBER ADAPTER — Webhook handling
 *
 * Validação de assinatura HMAC-SHA256 + parsing de payload Uber → CanonicalEvent.
 *
 * Comportamento extraído verbatim de:
 *  - uber/routes/webhook.routes.js:verificarAssinaturaUber (linhas 30-107)
 *  - uber.service.js:processarWebhookStatus (linhas 944-1033)
 *  - uber.service.js:processarWebhookCourier (linhas 1038-1132)
 *
 * Diferença chave: aqui só TRADUZIMOS payload → CanonicalEvent.
 * Quem aplica a ação Mapp é o WebhookDispatcher (core), não o adapter.
 * Isso mantém o adapter agnóstico de Mapp.
 *
 * A Uber manda 3 tipos de evento pra mesma URL:
 *   event.delivery_status  → mudança de status
 *   event.courier_update   → posição/dados do entregador (a cada ~20s)
 *   event.refund_request   → reembolso (só logamos)
 * O tipo vem no campo `kind` do payload, com fallback heurístico.
 */

const crypto = require('crypto');
const { CanonicalStatus } = require('../../contracts/CanonicalStatus');
const { nativeToCanonical } = require('./uber.status-map');

// Headers que a Uber pode usar pra assinatura (varia por versão da API)
const SIGNATURE_HEADERS = [
  'x-uber-signature',
  'x-uber-signature-v2',
  'x-postmates-signature',
  'webhook-signature',
  'x-webhook-signature',
];

/**
 * Valida a assinatura HMAC-SHA256 de um webhook Uber.
 *
 * Regras (idênticas ao legado):
 *  - sandbox_mode = true → aceita tudo (retorna true)
 *  - produção sem secret → rejeita (retorna false + motivo)
 *  - produção com secret → valida HMAC contra rawBody
 *
 * @param {import('express').Request} req - precisa ter req.rawBody
 * @param {Object} opts
 * @param {string} [opts.webhookSecret]
 * @param {boolean} [opts.sandboxMode]
 * @returns {{ valid: boolean, motivo: string, sandbox?: boolean }}
 */
function validarAssinaturaUber(req, opts = {}) {
  const { webhookSecret, sandboxMode } = opts;

  // Sandbox aceita tudo
  if (sandboxMode === true) {
    return { valid: true, motivo: 'sandbox_aceita_tudo', sandbox: true };
  }

  // Produção sem secret → rejeita
  if (!webhookSecret) {
    return { valid: false, motivo: 'webhook_secret_nao_configurado' };
  }

  // Procura o header de assinatura (5 variantes possíveis)
  let signature = null;
  for (const h of SIGNATURE_HEADERS) {
    if (req.headers[h]) {
      signature = req.headers[h];
      break;
    }
  }

  if (!signature) {
    return { valid: false, motivo: 'header_assinatura_ausente' };
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return { valid: false, motivo: 'raw_body_nao_capturado' };
  }

  // Calcula HMAC esperado
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  const sigBuf = Buffer.from(String(signature), 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, motivo: 'assinatura_invalida' };
  }

  return { valid: true, motivo: 'assinatura_valida' };
}

/**
 * Detecta o tipo do evento Uber a partir do payload.
 *
 * @param {Object} payload
 * @returns {'delivery_status'|'courier_update'|'refund_request'}
 */
function detectarTipoEvento(payload) {
  const kind = (payload?.kind || payload?.event_type || '').toLowerCase();
  const status = payload?.data?.status;
  const hasCourierLoc = !!(payload?.data?.courier?.location?.lat);

  if (kind.includes('courier_update')) return 'courier_update';
  if (kind.includes('delivery_status')) return 'delivery_status';
  if (kind.includes('refund')) return 'refund_request';

  // Fallback heurístico
  return (hasCourierLoc && !status) ? 'courier_update' : 'delivery_status';
}

/**
 * Converte um payload de webhook Uber em CanonicalEvent.
 *
 * Retorna null se o evento não tem delivery_id (não dá pra localizar a entrega)
 * ou se é refund_request (só logamos, não tem ação).
 *
 * @param {Object} payload - req.body
 * @returns {import('../../contracts/CanonicalTypes').CanonicalEvent | null}
 */
function parsePayloadUber(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const tipo = detectarTipoEvento(payload);
  const deliveryId = payload.data?.id || payload.data?.delivery_id;

  if (!deliveryId) {
    return null; // sem delivery_id não tem como localizar a entrega local
  }

  // refund_request: não tem ação, retornamos evento 'other' só pra log
  if (tipo === 'refund_request') {
    return {
      eventType: 'other',
      externalDeliveryId: deliveryId,
      rawProvider: payload,
    };
  }

  const courier = payload.data?.courier;
  const courierCanonical = courier ? extractCourier(courier) : null;
  const location = courier?.location?.lat && courier?.location?.lng
    ? { lat: courier.location.lat, lng: courier.location.lng }
    : null;

  if (tipo === 'courier_update') {
    return {
      eventType: 'courier_update',
      externalDeliveryId: deliveryId,
      statusNative: payload.data?.status || null,
      statusCanonico: payload.data?.status ? nativeToCanonical(payload.data.status) : null,
      courier: courierCanonical,
      location,
      rawProvider: payload,
    };
  }

  // delivery_status
  const nativeStatus = payload.data?.status;
  return {
    eventType: 'status_change',
    externalDeliveryId: deliveryId,
    statusNative: nativeStatus || null,
    statusCanonico: nativeStatus ? nativeToCanonical(nativeStatus) : null,
    courier: courierCanonical,
    location,
    trackingUrl: payload.data?.tracking_url || null,
    rawProvider: payload,
  };
}

/**
 * Extrai courier canônico do payload Uber.
 * (Mesma lógica do UberAdapter._extractCourier — duplicado aqui pra manter
 * uber.webhook.js independente; ambos pequenos e estáveis.)
 */
function extractCourier(uberCourier) {
  if (!uberCourier || typeof uberCourier !== 'object') return null;
  // Telefone: Uber manda E.164; pode vir em phone_number ou public_phone_info
  const phone = uberCourier.phone_number
    || uberCourier.public_phone_info?.formatted_phone_number
    || null;
  return {
    name: uberCourier.name || null,
    phone,
    plate: uberCourier.vehicle_license_plate || null,
    vehicle: [uberCourier.vehicle_make, uberCourier.vehicle_model].filter(Boolean).join(' ') || null,
    photo: uberCourier.img_href || null,
    rating: uberCourier.rating || null,
    lat: uberCourier.location?.lat || null,
    lng: uberCourier.location?.lng || null,
  };
}

module.exports = {
  validarAssinaturaUber,
  detectarTipoEvento,
  parsePayloadUber,
  extractCourier,
  SIGNATURE_HEADERS,
};
