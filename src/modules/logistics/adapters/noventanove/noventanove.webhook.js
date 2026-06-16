/**
 * NINETYNINE ADAPTER — Webhook handling (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 (rev. 2) — alinhado à doc OFICIAL de webhook da
 * 99Entrega (https://entrega-api.99app.com/docs/en/webhook.html). A rev.1
 * lia os campos no nível errado e DESCARTAVA todos os webhooks. Corrigido:
 *
 *  - O payload do webhook tem shape FIXO:
 *      { event, event_id, message, timestamp }
 *    onde `message` é uma STRING JSON (precisa de JSON.parse) — os ids
 *    (order_id / external_order_id / old_order_id / new_order_id) ficam
 *    DENTRO de message, não no nível raiz. A rev.1 procurava no raiz e
 *    sempre achava null → todo webhook virava no-op.
 *  - `DriverCanceled` usa `old_order_id` (não `order_id`) + `new_order_id`.
 *  - O webhook NÃO traz dados do entregador (nem nome) — só ids. Removido o
 *    extrairCourierDeWebhook (era código morto). Identidade/posição do
 *    courier só saem de GET /v2/order/detail (TrackingPoller).
 *  - Assinatura: a doc se contradiz (texto diz Base64, exemplo Python usa
 *    hexdigest). validarAssinatura99 aceita AMBOS — compara contra o digest
 *    em hex E em base64.
 *
 * Os 9 eventos (ver noventanove.status-map):
 *   DriverAccepted, DriverArrived, DriverBeginCharge, DriverCanceled,
 *   BroadcastTimeout, OrderCompleted, OrderClosed, SendBack, SendBackCompleted
 *
 * Doc: https://entrega-api.99app.com/docs/en/webhook.html
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
 * Valida a assinatura HMAC-SHA256 de um webhook da 99Entrega.
 *
 * ⚠️ A doc da 99 se contradiz: a seção 4.1 diz "Base64 encoding", mas o
 * exemplo Python usa `.hexdigest()` (hex). Pra não depender de adivinhação,
 * comparamos a assinatura recebida contra os DOIS formatos (hex e base64).
 *
 * Política (mesma do uber.webhook):
 *  - sandbox_mode = true → aceita tudo (retorna true)
 *  - produção sem secret → rejeita
 *  - produção com secret → valida HMAC-SHA256 (hex OU base64) contra rawBody
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

  // Calcula o HMAC nos dois formatos — a doc da 99 é ambígua quanto a isso.
  const hmac = crypto.createHmac('sha256', webhookSecret).update(rawBody, 'utf8');
  const esperadoHex    = hmac.copy().digest('hex');
  const esperadoBase64 = crypto.createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8').digest('base64');

  const recebida = String(signature);
  if (_comparaSeguro(recebida, esperadoHex) || _comparaSeguro(recebida, esperadoBase64)) {
    return { valid: true, motivo: 'assinatura_valida' };
  }
  return { valid: false, motivo: 'assinatura_invalida' };
}

/**
 * Comparação de strings em tempo constante (timingSafeEqual exige buffers de
 * mesmo tamanho — checa o length antes pra não lançar).
 * @private
 */
function _comparaSeguro(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Extrai e parseia o `message` do webhook da 99Entrega.
 *
 * O webhook tem shape fixo { event, event_id, message, timestamp }, e o
 * `message` é uma STRING JSON. Defensivo: se `message` já vier como objeto
 * (alguns clients/proxies parseiam), usa direto; se vier string, faz parse.
 *
 * @param {Object} payload - req.body do webhook
 * @returns {Object} o conteúdo de message como objeto (ou {} se não der)
 */
function parsearMessage(payload) {
  const msg = payload && payload.message;
  if (msg == null) return {};
  if (typeof msg === 'object') return msg;        // já parseado
  if (typeof msg === 'string') {
    try { return JSON.parse(msg); }
    catch (_) { return {}; }
  }
  return {};
}

/**
 * Extrai o nome do evento do payload do webhook.
 * @param {Object} payload
 * @returns {string|null} ex: 'DriverAccepted'
 */
function extrairNomeEvento(payload) {
  return (payload && (payload.event || payload.event_type)) || null;
}

/**
 * Converte um payload de webhook da 99Entrega em CanonicalEvent.
 *
 * Regras de classificação:
 *  - Sem order_id (em message) → null (não dá pra localizar a entrega local).
 *  - OrderClosed / SendBack → eventType 'other' (informativo, sem ação Mapp).
 *  - DriverCanceled COM new_order_id → 'status_change' DISPATCHED + reatribuição
 *    (usa old_order_id pra localizar, new_order_id pra atualizar a coluna).
 *  - Demais eventos → 'status_change' com o statusCanonico do status-map.
 *
 * @param {Object} payload - req.body do webhook { event, event_id, message, timestamp }
 * @returns {import('../../contracts/CanonicalTypes').CanonicalEvent | null}
 */
function parsePayload99(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const nomeEvento = extrairNomeEvento(payload);
  const msg = parsearMessage(payload);
  const eventoLower = String(nomeEvento || '').toLowerCase();

  // ─── DriverCanceled: ids vêm como old_order_id / new_order_id ───
  if (eventoLower === 'drivercanceled') {
    const oldId = msg.old_order_id != null ? String(msg.old_order_id) : null;
    const newId = msg.new_order_id != null && String(msg.new_order_id).trim()
      ? String(msg.new_order_id) : null;

    if (!oldId) return null;  // sem id antigo não dá pra localizar a entrega

    if (newId && newId !== oldId) {
      // Reatribuição — pedido continua vivo com um id novo.
      return {
        eventType: 'status_change',
        externalDeliveryId: oldId,                  // id ANTIGO — localiza a entrega
        reassignedExternalDeliveryId: newId,        // id NOVO — o Dispatcher atualiza
        statusNative: nomeEvento,
        statusCanonico: CanonicalStatus.DISPATCHED, // volta a "procurando entregador"
        rawProvider: payload,
      };
    }
    // Sem new_order_id → cancelamento de verdade.
    return {
      eventType: 'status_change',
      externalDeliveryId: oldId,
      statusNative: nomeEvento,
      statusCanonico: nativeToCanonical(nomeEvento),
      rawProvider: payload,
    };
  }

  // ─── Demais eventos: order_id está dentro de message ───
  const orderId = msg.order_id != null ? String(msg.order_id) : null;
  if (!orderId) {
    return null;  // sem order_id não dá pra localizar a entrega
  }

  // Eventos informativos (OrderClosed, SendBack): só log, sem ação Mapp.
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

  // Evento sem nome identificável → 'other' só pra log.
  if (!nomeEvento) {
    return {
      eventType: 'other',
      externalDeliveryId: orderId,
      rawProvider: payload,
    };
  }

  // SendBackCompleted = devolucao CONCLUIDA. Grava RETURNED (info clara do
  // inicio ao fim: foi DEVOLVIDO, nao entregue), mas FINALIZA a OS na Mapp
  // (encerra + busca comprovante de devolucao) em vez de reabrir. O campo
  // mappActionStatus diz ao WebhookDispatcher qual acao Mapp usar sem mudar
  // o status_canonico gravado.
  if (eventoLower === 'sendbackcompleted') {
    return {
      eventType: 'status_change',
      externalDeliveryId: orderId,
      statusNative: nomeEvento,
      statusCanonico: CanonicalStatus.RETURNED,
      mappActionStatus: CanonicalStatus.DELIVERED,
      rawProvider: payload,
    };
  }

  // Marco de status normal (demais eventos).
  return {
    eventType: 'status_change',
    externalDeliveryId: orderId,
    statusNative: nomeEvento,
    statusCanonico: nativeToCanonical(nomeEvento),
    rawProvider: payload,
  };
}

/**
 * Detecta o "tipo" do evento — exposto pro WebhookDispatcher logar/rotear.
 * A 99Entrega só manda marcos de status (sem courier_update — não há posição
 * nem dados do entregador no webhook).
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
  parsearMessage,
  extrairNomeEvento,
  parsePayload99,
  detectarTipoEvento,
};
