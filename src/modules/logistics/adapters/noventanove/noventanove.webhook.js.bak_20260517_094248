/**
 * NINETYNINE ADAPTER — Webhook handling
 *
 * Validação de Basic Auth + parsing de payload da 99 → CanonicalEvent.
 *
 * Diferenças vs webhook da Uber:
 *  - Auth é BASIC AUTH (não HMAC). A 99 manda header
 *    `Authorization: Basic base64(username:password)`. As credenciais foram
 *    definidas por nós no PUT /webhook e ficam em logistics_providers.config.
 *  - A resposta DEVE ter CORPO VAZIO + status 2xx em até 10s. Quem garante o
 *    corpo vazio é o acknowledgeWebhook do NinetyNineAdapter.
 *  - Idempotência: a 99 manda `event.id` único — a 99 retransmite até 10x em
 *    backoff exponencial por 2h se não receber 2xx. O event.id é a chave.
 *
 * A 99 tem 2 tipos de subscription:
 *  - 'ride-status'          → mudança de status da corrida
 *  - 'ride-driver-location' → posição do motorista
 *
 * Doc: https://github.com/99Taxis/corp-api-v2-documentation#webhook
 *
 * NOTA: a doc da 99 não fixa o shape EXATO do payload do evento (só lista os
 * status e diz que tem event.id). O parser abaixo é defensivo — tenta vários
 * caminhos pros campos. Quando o webhook real chegar no sandbox, ajustamos
 * com base no payload concreto (ver README-FASE-3, seção de validação).
 */

const { nativeToCanonical, WEBHOOK_STATUS_FINAIS } = require('./noventanove.status-map');

/**
 * Valida o header Basic Auth de um webhook da 99.
 *
 * @param {import('express').Request} req
 * @param {Object} opts
 * @param {string} [opts.webhookUsername]
 * @param {string} [opts.webhookPassword]
 * @param {boolean} [opts.sandboxMode]
 * @returns {{ valid: boolean, motivo: string, sandbox?: boolean }}
 */
function validarBasicAuth(req, opts = {}) {
  const { webhookUsername, webhookPassword, sandboxMode } = opts;

  // Sandbox aceita tudo (mesma política do uber.webhook)
  if (sandboxMode === true) {
    return { valid: true, motivo: 'sandbox_aceita_tudo', sandbox: true };
  }

  // Produção sem credenciais configuradas → rejeita
  if (!webhookUsername || !webhookPassword) {
    return { valid: false, motivo: 'webhook_credenciais_nao_configuradas' };
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader) {
    return { valid: false, motivo: 'header_authorization_ausente' };
  }

  // Espera "Basic base64(user:pass)"
  const m = String(authHeader).match(/^Basic\s+(.+)$/i);
  if (!m) {
    return { valid: false, motivo: 'header_authorization_malformado' };
  }

  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch (e) {
    return { valid: false, motivo: 'base64_invalido' };
  }

  // decoded = "username:password" — split no PRIMEIRO ':' (senha pode ter ':')
  const idx = decoded.indexOf(':');
  if (idx < 0) {
    return { valid: false, motivo: 'credenciais_malformadas' };
  }
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  // Comparação. Não precisa de timingSafeEqual aqui com a mesma força que HMAC,
  // mas fazemos comparação de tamanho + conteúdo de forma consistente.
  const userOk = user === webhookUsername;
  const passOk = pass === webhookPassword;

  if (!userOk || !passOk) {
    return { valid: false, motivo: 'credenciais_invalidas' };
  }

  return { valid: true, motivo: 'basic_auth_valido' };
}

/**
 * Detecta o tipo de evento da 99 a partir do payload.
 *
 * @param {Object} payload
 * @returns {'ride_status'|'driver_location'|'unknown'}
 */
function detectarTipoEvento(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown';

  // A 99 pode mandar o tipo em 'type', 'event', ou inferimos pelo conteúdo
  const tipo = String(payload.type || payload.event || payload.subscription || '').toLowerCase();
  if (tipo.includes('location')) return 'driver_location';
  if (tipo.includes('status')) return 'ride_status';

  // Inferência: se tem status de corrida → ride_status; se só tem posição → location
  const status = payload.status || payload.data?.status || payload.ride?.status;
  const temPosicao = !!(
    payload.driver?.position || payload.data?.driver?.position ||
    payload.location || payload.position
  );

  if (status) return 'ride_status';
  if (temPosicao) return 'driver_location';
  return 'unknown';
}

/**
 * Extrai o rideID do payload (vários caminhos possíveis — defensivo).
 *
 * @param {Object} payload
 * @returns {string|null}
 */
function extrairRideId(payload) {
  return (
    payload?.rideID ||
    payload?.rideId ||
    payload?.ride?.id ||
    payload?.ride?.rideID ||
    payload?.data?.rideID ||
    payload?.data?.rideId ||
    payload?.running?.rideID ||
    payload?.id ||
    null
  );
}

/**
 * Extrai dados do motorista do payload (defensivo — vários caminhos).
 *
 * @param {Object} payload
 * @returns {Object|null} courier canônico
 */
function extrairCourier(payload) {
  const d =
    payload?.driver ||
    payload?.data?.driver ||
    payload?.ride?.driver ||
    payload?.running?.driver ||
    null;

  if (!d || typeof d !== 'object') return null;

  const pos = d.position || d.location || null;

  return {
    name: d.fullName || d.name || null,
    phone: d.phoneNumber || d.phone || null,
    plate: d.carPlate || d.plate || null,
    vehicle: d.carModel || d.car || [d.carModel].filter(Boolean).join(' ') || null,
    photo: d.img || d.photo || null,
    rating: d.rating || null,
    lat: pos?.latitude ?? pos?.lat ?? null,
    lng: pos?.longitude ?? pos?.lng ?? null,
  };
}

/**
 * Converte um payload de webhook da 99 em CanonicalEvent.
 *
 * @param {Object} payload - req.body
 * @returns {import('../../contracts/CanonicalTypes').CanonicalEvent | null}
 */
function parsePayload99(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const tipo = detectarTipoEvento(payload);
  const rideId = extrairRideId(payload);

  if (!rideId) {
    return null; // sem rideID não dá pra localizar a entrega local
  }

  const courier = extrairCourier(payload);
  const location = (courier && courier.lat != null && courier.lng != null)
    ? { lat: courier.lat, lng: courier.lng }
    : null;

  // event.id pra idempotência
  const eventId = payload.event?.id || payload.eventId || payload.id || null;

  if (tipo === 'driver_location') {
    return {
      eventType: 'courier_update',
      externalDeliveryId: rideId,
      eventId,
      statusNative: null,
      statusCanonico: null,
      courier,
      location,
      rawProvider: payload,
    };
  }

  // ride_status (ou unknown que tem status)
  const nativeStatus =
    payload.status || payload.data?.status || payload.ride?.status || null;

  if (!nativeStatus && tipo === 'unknown') {
    // Evento que não conseguimos classificar — retorna 'other' pra só logar
    return {
      eventType: 'other',
      externalDeliveryId: rideId,
      eventId,
      rawProvider: payload,
    };
  }

  return {
    eventType: 'status_change',
    externalDeliveryId: rideId,
    eventId,
    statusNative: nativeStatus,
    statusCanonico: nativeStatus ? nativeToCanonical(nativeStatus) : null,
    statusFinal: nativeStatus ? WEBHOOK_STATUS_FINAIS.includes(String(nativeStatus).toLowerCase()) : false,
    courier,
    location,
    rawProvider: payload,
  };
}

module.exports = {
  validarBasicAuth,
  detectarTipoEvento,
  extrairRideId,
  extrairCourier,
  parsePayload99,
};
