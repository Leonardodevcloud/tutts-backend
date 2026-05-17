/**
 * NINETYNINE ADAPTER — Parser de payload (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 — antes este parser falava a "99 Corp API" (corridas,
 * categoryID, employeeID, costCenterID). A 99Entrega (delivery) é outra API:
 * OAuth, endpoints /v2/order/*, envelope { errno, errmsg, data }.
 *
 * Traduz objetos canônicos do hub → dialeto da 99Entrega e parseia as
 * respostas de volta.
 *
 * Endpoints cobertos (base de noventanove.auth.getBaseUrl()):
 *   POST /v2/order/estimate  → cotação. Devolve estimate_id + fee (centavos).
 *   POST /v2/order/create    → cria o pedido. Usa estimate_id (single-use).
 *   POST /v2/order/cancel    → cancela. Exige reason_id.
 *   GET  /v2/order/detail    → estado atual + driver_info.location (tracking).
 *
 * Particularidades da 99Entrega (anotadas do README-99-AUTH / doc):
 *  - `fee` vem em CENTAVOS — `fee: 8` = R$ 0,08. Dividir por 100.
 *  - `estimate_id` liga a cotação ao pedido — cada um serve pra UM create.
 *  - `external_order_id` = codigo_os da Mapp. Idempotente: repetir o mesmo
 *    retorna o pedido já criado.
 *  - `package_type` / `package_weight` são OBRIGATÓRIOS no create. A Mapp não
 *    tem essa info → default configurável (config.package_type / .package_weight).
 *  - Telefones: BR sem +55 (DDD+número). A OS da Mapp nem sempre traz →
 *    fallback config.telefone_suporte (mesma estratégia do uber.parser).
 *  - `need_pickup_code` / `need_dropoff_code`: códigos de verificação,
 *    configuráveis no painel (config booleano).
 *
 * Sobre os NOMES de campo dentro de pickup_info/dropoff_info (lat/lng/address/
 * name/phone): seguem a convenção da Open Platform da 99Entrega. Os campos
 * citados nominalmente no README (`pickup_info`, `dropoff_info`, `phone`,
 * `package_type`, `package_weight`, `need_pickup_code`, `need_dropoff_code`,
 * `external_order_id`, `estimate_id`) estão garantidos; lat/lng/address/name
 * são os nomes convencionais — se o sandbox acusar divergência, é só ajustar
 * montarInfoEndereco() (ponto único de verdade).
 *
 * Doc: https://entrega-api.99app.com/docs/en/
 */

const { formatarTelefoneBR, truncarTexto } = require('../../core/AddressParser');

// ════════════════════════════════════════════════════════════
// Defaults configuráveis (decisões de negócio do README)
// ════════════════════════════════════════════════════════════

/** Tipo de pacote default quando config.package_type não está setado. */
const PACKAGE_TYPE_DEFAULT = 'documents';

/** Peso de pacote default quando config.package_weight não está setado. */
const PACKAGE_WEIGHT_DEFAULT = '1kg';

/**
 * reason_id default pra cancelamento. A 99Entrega aceita o enum 410013..410021.
 * 410013 é o motivo mais genérico ("cancelado pelo solicitante"). O operador
 * pode sobrescrever via config.cancel_reason_id sem precisar de deploy.
 *
 * ⚠️ Confirme o id exato do motivo desejado na doc da 99Entrega — os ids do
 * enum mudam de significado; este é só um default seguro.
 */
const CANCEL_REASON_ID_DEFAULT = 410013;

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

/**
 * Resolve um telefone BR (DDD+número, sem +55) com fallback pro telefone de
 * suporte da config — mesma estratégia do uber.parser.
 *
 * @param {string} telBruto - telefone vindo da OS (formato livre)
 * @param {string} telSuporte - config.telefone_suporte (fallback)
 * @returns {string|null}
 */
function resolverTelefone(telBruto, telSuporte) {
  return formatarTelefoneBR(telBruto) || formatarTelefoneBR(telSuporte) || null;
}

/**
 * Monta um objeto pickup_info / dropoff_info pra 99Entrega.
 *
 * PONTO ÚNICO DE VERDADE dos nomes de campo de endereço — se o sandbox da 99
 * acusar divergência de schema, ajuste só aqui.
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalAddress} addr
 * @param {Object} opts
 * @param {string}  opts.nomeDefault - nome usado se addr.name vier vazio
 * @param {string}  opts.telSuporte  - telefone de fallback (config.telefone_suporte)
 * @param {boolean} [opts.incluirContato=false] - se true, inclui name/phone/need_code (create)
 * @param {boolean} [opts.needCode=false] - valor do need_pickup_code/need_dropoff_code
 * @returns {Object} pickup_info / dropoff_info
 */
function montarInfoEndereco(addr, opts) {
  const { nomeDefault, telSuporte, incluirContato = false, needCode = false } = opts || {};

  const info = {
    lat: addr.latitude != null ? parseFloat(addr.latitude) : null,
    lng: addr.longitude != null ? parseFloat(addr.longitude) : null,
    address: truncarTexto(addr.address, 200) || '',
  };

  if (addr.complement) {
    info.address_detail = truncarTexto(addr.complement, 100);
  }

  // Contato (name/phone/need_code) — só no create; o estimate é só geográfico.
  if (incluirContato) {
    info.name = truncarTexto(addr.name || nomeDefault, 100);
    const tel = resolverTelefone(addr.phone, telSuporte);
    if (tel) info.phone = tel;
    info.need_code = !!needCode;
  }

  return info;
}

/**
 * Resolve package_type / package_weight a partir da config (com defaults).
 *
 * @param {Object} config - logistics_providers.config
 * @returns {{ package_type: string, package_weight: string }}
 */
function resolverPacote(config) {
  return {
    package_type: (config && config.package_type) || PACKAGE_TYPE_DEFAULT,
    package_weight: (config && config.package_weight) || PACKAGE_WEIGHT_DEFAULT,
  };
}

// ════════════════════════════════════════════════════════════
// Builders de request body
// ════════════════════════════════════════════════════════════

/**
 * Monta o body pra POST /v2/order/estimate.
 * O estimate é geográfico — só precisa de coleta, entrega e dados do pacote.
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @param {Object} config - logistics_providers.config
 * @returns {Object} body pronto pra 99Entrega
 */
function montarBodyEstimate(req, config) {
  const telSuporte = (config && config.telefone_suporte) || '';
  const pacote = resolverPacote(config);

  return {
    pickup_info: montarInfoEndereco(req.pickup, {
      nomeDefault: 'Loja',
      telSuporte,
      incluirContato: false,
    }),
    dropoff_info: montarInfoEndereco(req.dropoff, {
      nomeDefault: 'Cliente',
      telSuporte,
      incluirContato: false,
    }),
    package_type: pacote.package_type,
    package_weight: pacote.package_weight,
  };
}

/**
 * Monta o body pra POST /v2/order/create.
 *
 * @param {string} estimateId - estimate_id devolvido pelo /estimate (single-use)
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @param {Object} config - logistics_providers.config
 * @returns {Object} body pronto pra 99Entrega
 */
function montarBodyCreate(estimateId, req, config) {
  if (!estimateId) {
    throw new Error('NinetyNineAdapter: estimate_id ausente — /create da 99Entrega exige a cotação prévia');
  }

  const telSuporte = (config && config.telefone_suporte) || '';
  const pacote = resolverPacote(config);

  // Toggles de código de verificação (decisão de negócio — config booleana)
  const needPickup  = config && config.need_pickup_code === true;
  const needDropoff = config && config.need_dropoff_code === true;

  const pickupInfo = montarInfoEndereco(req.pickup, {
    nomeDefault: 'Loja',
    telSuporte,
    incluirContato: true,
    needCode: needPickup,
  });
  const dropoffInfo = montarInfoEndereco(req.dropoff, {
    nomeDefault: 'Cliente',
    telSuporte,
    incluirContato: true,
    needCode: needDropoff,
  });

  // Telefones são obrigatórios no create da 99Entrega.
  if (!pickupInfo.phone || !dropoffInfo.phone) {
    throw new Error(
      'NinetyNineAdapter: telefone de coleta/entrega ausente e config.telefone_suporte ' +
      'não preenchido — a 99Entrega exige pickup_info.phone e dropoff_info.phone.'
    );
  }

  return {
    estimate_id: String(estimateId),
    external_order_id: String(req.externalRef),  // codigo_os da Mapp — idempotente
    pickup_info: pickupInfo,
    dropoff_info: dropoffInfo,
    package_type: pacote.package_type,
    package_weight: pacote.package_weight,
    remark: truncarTexto(req.itemDescription || `OS ${req.externalRef}`, 200),
  };
}

/**
 * Monta o body pra POST /v2/order/cancel.
 *
 * @param {string} orderId - order_id da 99 (external_delivery_id do hub)
 * @param {Object} config - logistics_providers.config (cancel_reason_id opcional)
 * @returns {Object} body pronto pra 99Entrega
 */
function montarBodyCancel(orderId, config) {
  const reasonId = parseInt((config && config.cancel_reason_id), 10) || CANCEL_REASON_ID_DEFAULT;
  return {
    order_id: String(orderId),
    reason_id: reasonId,
  };
}

// ════════════════════════════════════════════════════════════
// Parsers de response
// ════════════════════════════════════════════════════════════

/**
 * Extrai o conteúdo útil de uma resposta /v2/order/estimate.
 * A 99Entrega devolve { errno, errmsg, data: { estimate_id, fee, ... } }.
 * O caller (adapter) já validou errno === 0 antes de chamar isto.
 *
 * @param {Object} data - o `data` do envelope (já desencapsulado)
 * @returns {{ estimateId: string, feeReais: number, etaMinutos: (number|null), raw: Object }}
 */
function parseEstimate(data) {
  const d = data || {};
  const estimateId = d.estimate_id || d.estimateId || null;
  if (!estimateId) {
    throw new Error('99Entrega: /estimate respondeu sem estimate_id');
  }

  // fee vem em CENTAVOS — fee: 850 = R$ 8,50
  const feeCentavos = d.fee != null ? Number(d.fee) : null;
  const feeReais = feeCentavos != null ? feeCentavos / 100 : null;

  // ETA — a 99 pode devolver em segundos ou minutos, em campos variados.
  // Defensivo: tenta os caminhos conhecidos, normaliza pra minutos.
  let etaMinutos = null;
  if (d.eta_minutes != null) etaMinutos = Number(d.eta_minutes);
  else if (d.eta != null) etaMinutos = Number(d.eta);
  else if (d.duration != null) etaMinutos = Math.round(Number(d.duration) / 60); // segundos→min
  else if (d.estimate_time != null) etaMinutos = Number(d.estimate_time);

  return { estimateId: String(estimateId), feeReais, etaMinutos, raw: d };
}

/**
 * Extrai dados do entregador do `driver_info` de GET /v2/order/detail.
 * Retorna courier canônico. A 99Entrega traz a posição SÓ no order/detail
 * (o webhook NÃO traz lat/lng).
 *
 * @param {Object} driverInfo - data.driver_info da resposta de /detail
 * @returns {Object|null} courier canônico
 */
function extrairCourierDeDetail(driverInfo) {
  const d = driverInfo;
  if (!d || typeof d !== 'object') return null;

  const loc = d.location || d.position || null;

  return {
    name:    d.name || d.driver_name || d.full_name || null,
    phone:   d.phone || d.phone_number || d.mobile || null,
    plate:   d.plate || d.license_plate || d.car_plate || null,
    vehicle: d.vehicle || d.car_model || d.model || null,
    photo:   d.photo || d.avatar || d.img || null,
    rating:  d.rating != null ? d.rating : null,
    lat:     loc ? (loc.lat != null ? loc.lat : loc.latitude) : null,
    lng:     loc ? (loc.lng != null ? loc.lng : loc.longitude) : null,
  };
}

module.exports = {
  // constantes / defaults
  PACKAGE_TYPE_DEFAULT,
  PACKAGE_WEIGHT_DEFAULT,
  CANCEL_REASON_ID_DEFAULT,
  // helpers
  resolverTelefone,
  montarInfoEndereco,
  resolverPacote,
  // builders
  montarBodyEstimate,
  montarBodyCreate,
  montarBodyCancel,
  // parsers
  parseEstimate,
  extrairCourierDeDetail,
};
