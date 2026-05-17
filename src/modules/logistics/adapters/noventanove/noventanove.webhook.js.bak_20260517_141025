/**
 * NINETYNINE ADAPTER — Webhook handling (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 — antes este handler validava Basic Auth da "99 Corp
 * API". A 99Entrega assina os webhooks com HMAC-SHA256 (igual à Uber), só que:
 *  - Header: `X-Webhook-Signature`
 *  - Digest em BASE64 (a Uber usa hex)
 *
 * Faz duas coisas:
 *  1. validarAssinatura99(req)     → confere o HMAC-SHA256 do rawBody
 *  2. parsePayload99(payload)      → traduz o evento → CanonicalEvent
 *
 * Os 9 eventos da 99Entrega (ver noventanove.status-map):
 *   DriverAccepted, DriverArrived, DriverBeginCharge, DriverCanceled,
 *   BroadcastTimeout, OrderCompleted, OrderClosed, SendBack, SendBackCompleted
 *
 * PONTOS QUE MUDAM A ARQUITETURA (anotados do README-99-AUTH):
 *
 *  ⚠️ O webhook da 99 NÃO traz posição do entregador. Os 9 eventos são só
 *     marcos de status. lat/lng do entregador só saem de GET /v2/order/detail.
 *     Por isso parsePayload99 nunca devolve `location` — o tracking ao vivo da
 *     99 é por polling, não por webhook.
 *
 *  ⚠️ DriverCanceled pode trazer `new_order_id`: a 99 reatribuiu o pedido a
 *     outro entregador e gerou um id novo. Nesse caso o pedido NÃO está morto —
 *     parsePayload99 devolve eventType 'status_change' com statusCanonico
 *     DISPATCHED e o campo `reassignedExternalDeliveryId`. O WebhookDispatcher
 *     usa esse campo pra atualizar logistics_deliveries.external_delivery_id.
 *
 * A doc da 99Entrega não fixa o shape EXATO do payload do evento. O parser
 * abaixo é defensivo — tenta vários caminhos pros campos. Quando o webhook
 * real chegar no sandbox, conferir e ajustar os caminhos.
 *
 * Doc: https://entrega-api.99app.com/docs/en/
 */

const crypto = require('crypto');
const {
  nativeToCanonical,
  WEBHOOK_EVENTOS_INFORMATIVOS,
} = require('./noventanove.status-map');
const { CanonicalStatus } = require('../../contracts/CanonicalStatus');

// Headers possíveis pra assinatura (req.headers chega sempre lowercase no Node).
const SIGNATURE_HEADERS = [
  'x-webhook-signature',
  'x-99-signature',
  'webhook-signature',
];

/**
 * Valida a assinatura HMAC-SHA256 (base64) de um webhook da 99Entrega.
 *
 * Regras (mesma política do uber.webhook):
 *  - sandbox_mode = true → aceita tudo (retorna true)
 *  - produção sem secret → rejeita
 *  - produção com secret → valida HMAC-SHA256(base64) contra req.rawBody
 *
 * @param {import('express').Request} req - precisa ter req.rawBody
 * @param {Object} opts
 * @param {string}  [opts.webhookSecret] - segredo de assinatura do webhook 99
 * @param {boolean} [opts.sandboxMode]
 * @returns {{ valid: boolean, motivo: string, sandbox?: boolean }}
 */
function validarAssinatura99(req, opts = {}) {
  const { webhookSecret, sandboxMode } = opts;

  // Sandbox aceita tudo
  if (sandboxMode === true) {
    return { valid: true, motivo: 'sandbox_aceita_tudo', sandbox: true };
  }

  // Produção sem secret → rejeita
  if (!webhookSecret) {
    return { valid: false, motivo: 'webhook_secret_nao_configurado' };
  }

  // Procura o header de assinatura
  let signature = null;
  for (const h of SIGNATURE_HEADERS) {
    if (req.headers[h]) { signature = req.headers[h]; break; }
  }
  if (!signature) {
    return { valid: false, motivo: 'header_assinatura_ausente' };
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return { valid: false, motivo: 'raw_body_nao_capturado' };
  }

  // HMAC-SHA256 em BASE64 (a 99Entrega usa base64; a Uber usa hex)
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const sigBuf = Buffer.from(String(signature), 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, motivo: 'assinatura_invalida' };
  }

  return { valid: true, motivo: 'assinatura_valida' };
}

/**
 * Extrai o nome do evento do payload (defensivo — vários caminhos possíveis).
 *
 * @param {Object} payload
 * @returns {string|null} nome do evento (ex: 'DriverAccepted')
 */
function extrairNomeEvento(payload) {
  return (
    payload?.event ||
    payload?.event_type ||
    payload?.type ||
    payload?.notify_type ||
    payload?.data?.event ||
    payload?.data?.event_type ||
    null
  );
}

/**
 * Extrai o order_id do payload (defensivo).
 *
 * @param {Object} payload
 * @returns {string|null}
 */
function extrairOrderId(payload) {
  const id = (
    payload?.order_id ||
    payload?.orderId ||
    payload?.data?.order_id ||
    payload?.data?.orderId ||
    payload?.order?.order_id ||
    payload?.order?.id ||
    payload?.id ||
    null
  );
  return id != null ? String(id) : null;
}

/**
 * Extrai o new_order_id (presente em DriverCanceled quando há reatribuição).
 *
 * @param {Object} payload
 * @returns {string|null}
 */
function extrairNewOrderId(payload) {
  const id = (
    payload?.new_order_id ||
    payload?.newOrderId ||
    payload?.data?.new_order_id ||
    payload?.data?.newOrderId ||
    null
  );
  return id != null ? String(id) : null;
}

/**
 * Extrai courier canônico do payload do webhook (DriverAccepted traz a
 * identidade do entregador). ⚠️ A 99Entrega NÃO manda lat/lng no webhook —
 * por isso este courier nunca tem posição (lat/lng ficam null de propósito).
 *
 * @param {Object} payload
 * @returns {Object|null} courier canônico (sem location)
 */
function extrairCourierDeWebhook(payload) {
  const d =
    payload?.driver_info ||
    payload?.driver ||
    payload?.data?.driver_info ||
    payload?.data?.driver ||
    null;

  if (!d || typeof d !== 'object') return null;

  return {
    name:    d.name || d.driver_name || d.full_name || null,
    phone:   d.phone || d.phone_number || d.mobile || null,
    plate:   d.plate || d.license_plate || d.car_plate || null,
    vehicle: d.vehicle || d.car_model || d.model || null,
    photo:   d.photo || d.avatar || d.img || null,
    rating:  d.rating != null ? d.rating : null,
    lat:     null,  // 99Entrega não envia posição via webhook
    lng:     null,
  };
}

/**
 * Converte um payload de webhook da 99Entrega em CanonicalEvent.
 *
 * Regras de classificação:
 *  - Sem order_id → null (não dá pra localizar a entrega local).
 *  - OrderClosed / SendBack → eventType 'other' (informativo, sem ação Mapp).
 *  - DriverCanceled COM new_order_id → 'status_change' DISPATCHED + reatribuição.
 *  - Demais eventos → 'status_change' com o statusCanonico do status-map.
 *
 * @param {Object} payload - req.body do webhook
 * @returns {import('../../contracts/CanonicalTypes').CanonicalEvent | null}
 */
function parsePayload99(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const nomeEvento = extrairNomeEvento(payload);
  const orderId = extrairOrderId(payload);

  if (!orderId) {
    return null;  // sem order_id não dá pra localizar a entrega
  }

  const courier = extrairCourierDeWebhook(payload);
  const eventoLower = String(nomeEvento || '').toLowerCase();

  // ─── Eventos informativos (OrderClosed, SendBack): só log, sem ação ───
  const ehInformativo = WEBHOOK_EVENTOS_INFORMATIVOS
    .some(ev => ev.toLowerCase() === eventoLower);
  if (ehInformativo) {
    return {
      eventType: 'other',
      externalDeliveryId: orderId,
      statusNative: nomeEvento || null,
      rawProvider: payload,
    };
  }

  // ─── DriverCanceled COM new_order_id: reatribuição, NÃO é cancelamento ───
  if (eventoLower === 'drivercanceled') {
    const newOrderId = extrairNewOrderId(payload);
    if (newOrderId && newOrderId !== orderId) {
      return {
        eventType: 'status_change',
        externalDeliveryId: orderId,                 // id ANTIGO — pra localizar a entrega
        reassignedExternalDeliveryId: newOrderId,    // id NOVO — o WebhookDispatcher atualiza
        statusNative: nomeEvento,
        statusCanonico: CanonicalStatus.DISPATCHED,  // pedido continua vivo
        courier,
        rawProvider: payload,
      };
    }
    // Sem new_order_id → cancelamento de verdade (cai no fluxo padrão abaixo)
  }

  // ─── Demais eventos → status_change padrão ───
  if (!nomeEvento) {
    // Evento sem nome identificável — devolve 'other' só pra log
    return {
      eventType: 'other',
      externalDeliveryId: orderId,
      rawProvider: payload,
    };
  }

  return {
    eventType: 'status_change',
    externalDeliveryId: orderId,
    statusNative: nomeEvento,
    statusCanonico: nativeToCanonical(nomeEvento),
    courier,
    rawProvider: payload,
  };
}

/**
 * Detecta o "tipo" do evento — exposto pro WebhookDispatcher logar/rotear.
 * A 99Entrega só manda marcos de status (sem courier_update separado, porque
 * não há posição no webhook).
 *
 * @param {Object} payload
 * @returns {'status_change'|'other'}
 */
function detectarTipoEvento(payload) {
  const nome = String(extrairNomeEvento(payload) || '').toLowerCase();
  if (!nome) return 'other';
  if (WEBHOOK_EVENTOS_INFORMATIVOS.some(ev => ev.toLowerCase() === nome)) {
    return 'other';
  }
  return 'status_change';
}

module.exports = {
  SIGNATURE_HEADERS,
  validarAssinatura99,
  extrairNomeEvento,
  extrairOrderId,
  extrairNewOrderId,
  extrairCourierDeWebhook,
  parsePayload99,
  detectarTipoEvento,
};
