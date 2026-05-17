/**
 * NINETYNINE ADAPTER — Parser de payload (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 (rev. 2) — alinhado à doc OFICIAL da 99Entrega
 * (https://entrega-api.99app.com/docs/en/api_reference.html). A rev.1 usava
 * nomes de campo convencionais que NÃO batiam com a API real; corrigido:
 *  - `vehicle_type` é OBRIGATÓRIO no estimate e no create. Enum real:
 *    "entrega_moto" (moto) e "entrega_car" (carro) — NÃO "motorcycle"/"car".
 *  - Endereço é `structured_address` (objeto: street/number/neighborhood/
 *    city/state/CEP/country), não uma string `address`. Coordenadas vão em
 *    `location:{lat,lng}` à parte.
 *  - No /create, `package_type`/`package_weight` vão DENTRO de `package_info`.
 *  - `note` (observação visível ao courier) é OBRIGATÓRIO em pickup_info e
 *    dropoff_info no /create.
 *  - `reason_id` do cancel é STRING.
 *  - No /detail, courier traz `vehicle_info.plate_no`/`.color` e `location`.
 *  - O /estimate responde `data.id` (estimate id) + `data.delivery_duration`
 *    (minutos) + `data.fee` (centavos).
 *
 * Endpoints cobertos (base de noventanove.auth.getBaseUrl()):
 *   POST /v2/order/estimate  → cotação. Devolve data.id + data.fee (centavos).
 *   POST /v2/order/create    → cria o pedido. Usa estimate_id (single-use).
 *   POST /v2/order/cancel    → cancela. Exige reason_id (string).
 *   GET  /v2/order/detail    → estado atual + driver_info.location (tracking).
 *
 * Doc: https://entrega-api.99app.com/docs/en/api_reference.html
 */

const {
  formatarTelefoneBR,
  truncarTexto,
  parsearEnderecoBrasileiro,
  DEFAULT_CITY,
  DEFAULT_STATE,
  DEFAULT_COUNTRY,
} = require('../../core/AddressParser');

// ════════════════════════════════════════════════════════════
// Enums e defaults da 99Entrega (doc oficial)
// ════════════════════════════════════════════════════════════

/**
 * Enum de veículo da 99Entrega. A API só aceita estes dois valores.
 * O hub usa 'motorcycle'/'car'/'auto'/'van' no CanonicalQuoteRequest —
 * normalizamos aqui. A 99Entrega faz moto e carro; qualquer coisa que
 * não seja explicitamente carro vira moto (o caso de uso do Tutts é moto).
 */
const VEHICLE_99 = Object.freeze({
  MOTO: 'entrega_moto',
  CAR:  'entrega_car',
});

/** package_type aceitos pela 99Entrega (enum fechado da doc). */
const PACKAGE_TYPES_99 = Object.freeze([
  'groceries', 'food', 'documents', 'apparel', 'medication', 'electronics', 'others',
]);

/** package_weight aceitos pela 99Entrega (enum fechado da doc). */
const PACKAGE_WEIGHTS_99 = Object.freeze(['1kg', '5kg', '10kg', '20kg', '30kg']);

/** Tipo de pacote default quando config.package_type não está setado/é inválido. */
const PACKAGE_TYPE_DEFAULT = 'documents';

/** Peso de pacote default quando config.package_weight não está setado/é inválido. */
const PACKAGE_WEIGHT_DEFAULT = '1kg';

/**
 * reason_id default pra cancelamento (STRING — a doc envia como string).
 * Enum da doc: 410013..410021. 410018 = "Delivery no longer needed" é o
 * motivo genérico mais adequado pra cancelamento iniciado pelo operador.
 * O operador pode sobrescrever via config.cancel_reason_id.
 */
const CANCEL_REASON_ID_DEFAULT = '410018';

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

/**
 * Normaliza o vehicleType canônico do hub pro enum da 99Entrega.
 * @param {string} [vehicleType] - 'motorcycle' | 'car' | 'van' | 'auto'
 * @returns {string} 'entrega_moto' | 'entrega_car'
 */
function resolverVeiculo(vehicleType) {
  return vehicleType === 'car' ? VEHICLE_99.CAR : VEHICLE_99.MOTO;
}

/**
 * Resolve um telefone BR (DDD+número, só dígitos, sem +55) com fallback pro
 * telefone de suporte da config. A 99Entrega exige formato só-dígitos.
 *
 * @param {string} telBruto - telefone vindo da OS (formato livre)
 * @param {string} telSuporte - config.telefone_suporte (fallback)
 * @returns {string|null}
 */
function resolverTelefone(telBruto, telSuporte) {
  const tel = formatarTelefoneBR(telBruto) || formatarTelefoneBR(telSuporte) || null;
  if (!tel) return null;
  // formatarTelefoneBR pode devolver com máscara — a 99 quer só dígitos.
  return String(tel).replace(/\D/g, '') || null;
}

/**
 * Monta o objeto `structured_address` da 99Entrega a partir de um
 * CanonicalAddress do hub (que só tem `address` como string livre).
 *
 * O hub não fornece endereço estruturado — usamos parsearEnderecoBrasileiro
 * (best-effort) pra quebrar a string. A 99Entrega exige street/neighborhood/
 * city/state/CEP/country; `number`/`complement` são opcionais. Como a 99 usa
 * `location` (lat/lng) pra estimar quando fornecida — e o hub SEMPRE manda
 * lat/lng — a precisão do parse de string não é crítica pra cotação.
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalAddress} addr
 * @returns {Object} structured_address
 */
function montarEnderecoEstruturado(addr) {
  const parsed = parsearEnderecoBrasileiro(addr && addr.address);

  // street_address é um array de linhas — junta na primeira linha não-vazia.
  const street = (parsed.street_address && parsed.street_address[0])
    || (addr && addr.address)
    || 'Endereço não informado';

  // Tenta extrair um número solto do começo/fim da rua (best-effort, opcional).
  let number = '';
  const mNum = String(street).match(/(?:^|,\s*|\s)(\d{1,6})(?:\s|,|$)/);
  if (mNum) number = mNum[1];

  const structured = {
    street: truncarTexto(street, 200),
    neighborhood: truncarTexto(parsed.neighborhood || parsed.city || DEFAULT_CITY, 120),
    city: truncarTexto(parsed.city || DEFAULT_CITY, 120),
    state: parsed.state || DEFAULT_STATE,
    CEP: parsed.zip_code || '',
    country: parsed.country || DEFAULT_COUNTRY,
  };
  if (number) structured.number = number;
  if (addr && addr.complement) {
    structured.complement = truncarTexto(addr.complement, 100);
  }
  return structured;
}

/**
 * Monta um objeto pickup_info / dropoff_info pra 99Entrega.
 *
 * No /estimate só precisa de location + structured_address (geográfico).
 * No /create precisa também de name, phone e note (todos obrigatórios).
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalAddress} addr
 * @param {Object} opts
 * @param {string}  opts.nomeDefault - nome usado se addr.name vier vazio
 * @param {string}  opts.telSuporte  - telefone de fallback (config.telefone_suporte)
 * @param {boolean} [opts.incluirContato=false] - se true, inclui name/phone/note (create)
 * @param {string}  [opts.note=''] - conteúdo do campo note (create)
 * @returns {Object} pickup_info / dropoff_info
 */
function montarInfoEndereco(addr, opts) {
  const { nomeDefault, telSuporte, incluirContato = false, note = '' } = opts || {};

  const info = {
    structured_address: montarEnderecoEstruturado(addr),
  };

  // location (lat/lng) — opcional na doc, mas o hub sempre tem; mandar melhora
  // a precisão da estimativa.
  if (addr && addr.latitude != null && addr.longitude != null) {
    info.location = {
      lat: parseFloat(addr.latitude),
      lng: parseFloat(addr.longitude),
    };
  }

  // Contato (name/phone/note) — só no create; o estimate é só geográfico.
  if (incluirContato) {
    info.name = truncarTexto((addr && addr.name) || nomeDefault, 100);
    const tel = resolverTelefone(addr && addr.phone, telSuporte);
    if (tel) info.phone = tel;
    // note é obrigatório no create — nunca pode ir vazio.
    info.note = truncarTexto(note || nomeDefault || '-', 127);
  }

  return info;
}

/**
 * Resolve package_type / package_weight a partir da config, validando contra
 * os enums da 99Entrega. Valor inválido cai no default (a 99 rejeita fora do enum).
 *
 * @param {Object} config - logistics_providers.config
 * @returns {{ package_type: string, package_weight: string }}
 */
function resolverPacote(config) {
  const tipo = config && config.package_type;
  const peso = config && config.package_weight;
  return {
    package_type: PACKAGE_TYPES_99.includes(tipo) ? tipo : PACKAGE_TYPE_DEFAULT,
    package_weight: PACKAGE_WEIGHTS_99.includes(peso) ? peso : PACKAGE_WEIGHT_DEFAULT,
  };
}

// ════════════════════════════════════════════════════════════
// Builders de request body
// ════════════════════════════════════════════════════════════

/**
 * Monta o body pra POST /v2/order/estimate.
 * O estimate é geográfico: vehicle_type + coleta + entrega.
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @param {Object} config - logistics_providers.config
 * @returns {Object} body pronto pra 99Entrega
 */
function montarBodyEstimate(req, config) {
  const telSuporte = (config && config.telefone_suporte) || '';

  return {
    vehicle_type: resolverVeiculo(req.vehicleType),
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
  };
}

/**
 * Monta o body pra POST /v2/order/create.
 *
 * @param {string} estimateId - estimate id devolvido pelo /estimate (single-use)
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
  const osRef = String(req.externalRef);

  // note é obrigatório nos dois lados. Anexa a referência da OS — a doc
  // recomenda incluir o external_order_id no note pro courier.
  const noteBase = truncarTexto(req.itemDescription || `OS ${osRef}`, 100);

  const pickupInfo = montarInfoEndereco(req.pickup, {
    nomeDefault: 'Loja',
    telSuporte,
    incluirContato: true,
    note: `Coleta ${noteBase}`,
  });
  const dropoffInfo = montarInfoEndereco(req.dropoff, {
    nomeDefault: 'Cliente',
    telSuporte,
    incluirContato: true,
    note: `Entrega ${noteBase}`,
  });

  // Telefones são obrigatórios no create da 99Entrega.
  if (!pickupInfo.phone || !dropoffInfo.phone) {
    throw new Error(
      'NinetyNineAdapter: telefone de coleta/entrega ausente e config.telefone_suporte ' +
      'não preenchido — a 99Entrega exige pickup_info.phone e dropoff_info.phone.'
    );
  }

  const body = {
    vehicle_type: resolverVeiculo(req.vehicleType),
    external_order_id: osRef,       // codigo_os da Mapp — idempotente
    estimate_id: String(estimateId),
    pickup_info: pickupInfo,
    dropoff_info: dropoffInfo,
    package_info: {
      package_type: pacote.package_type,
      package_weight: pacote.package_weight,
    },
  };

  // Toggles de código de verificação (config booleana do painel).
  // A doc: default true se não enviado — então enviamos sempre o valor explícito.
  body.need_pickup_code  = (config && config.need_pickup_code === true);
  body.need_dropoff_code = (config && config.need_dropoff_code === true);

  return body;
}

/**
 * Monta o body pra POST /v2/order/cancel.
 * A doc recomenda usar external_order_id (o codigo_os da Mapp).
 *
 * @param {string} externalOrderId - codigo_os da Mapp (recomendado pela doc)
 * @param {Object} config - logistics_providers.config (cancel_reason_id opcional)
 * @param {string} [orderId] - order_id da 99 (fallback se não houver externalOrderId)
 * @returns {Object} body pronto pra 99Entrega
 */
function montarBodyCancel(externalOrderId, config, orderId) {
  // reason_id é STRING na 99Entrega.
  let reasonId = config && config.cancel_reason_id;
  reasonId = reasonId != null && String(reasonId).trim()
    ? String(reasonId).trim()
    : CANCEL_REASON_ID_DEFAULT;

  const body = { reason_id: reasonId };
  // A doc: se ambos vierem, só external_order_id é usado. Mandamos o que tiver.
  if (externalOrderId) body.external_order_id = String(externalOrderId);
  else if (orderId)    body.order_id = String(orderId);
  return body;
}

// ════════════════════════════════════════════════════════════
// Parsers de response
// ════════════════════════════════════════════════════════════

/**
 * Extrai o conteúdo útil de uma resposta /v2/order/estimate.
 * Envelope: { errno, errmsg, data: { id, fee, currency, delivery_distance,
 * delivery_duration, created_time, expires_time } }.
 * O caller (adapter) já validou errno === 0 antes de chamar isto.
 *
 * @param {Object} data - o `data` do envelope (já desencapsulado)
 * @returns {{ estimateId: string, feeReais: (number|null), etaMinutos: (number|null),
 *             distanciaMetros: (number|null), expiresAt: (Date|null), raw: Object }}
 */
function parseEstimate(data) {
  const d = data || {};
  // A doc nomeia o campo como `id` (não `estimate_id`).
  const estimateId = d.id || d.estimate_id || null;
  if (!estimateId) {
    throw new Error('99Entrega: /estimate respondeu sem id de cotação');
  }

  // fee vem em CENTAVOS — fee: 850 = R$ 8,50
  const feeCentavos = d.fee != null ? Number(d.fee) : null;
  const feeReais = feeCentavos != null ? feeCentavos / 100 : null;

  // delivery_duration já vem em MINUTOS na doc.
  const etaMinutos = d.delivery_duration != null ? Number(d.delivery_duration) : null;
  const distanciaMetros = d.delivery_distance != null ? Number(d.delivery_distance) : null;

  // expires_time é timestamp UNIX em segundos.
  const expiresAt = d.expires_time != null
    ? new Date(Number(d.expires_time) * 1000)
    : null;

  return { estimateId: String(estimateId), feeReais, etaMinutos, distanciaMetros, expiresAt, raw: d };
}

/**
 * Extrai dados do entregador do `driver_info` de GET /v2/order/detail.
 * Estrutura real da doc: driver_info { name, phone, avatar,
 * vehicle_info { plate_no, color }, location { lat, lng } }.
 *
 * @param {Object} driverInfo - data.driver_info da resposta de /detail
 * @returns {Object|null} courier canônico
 */
function extrairCourierDeDetail(driverInfo) {
  const d = driverInfo;
  if (!d || typeof d !== 'object') return null;

  const loc = d.location || null;
  const veic = d.vehicle_info || {};

  // location { lat:0, lng:0 } é o "sem posição" da 99 — trata como ausente.
  const lat = loc && loc.lat != null ? Number(loc.lat) : null;
  const lng = loc && loc.lng != null ? Number(loc.lng) : null;
  const temPosicao = lat != null && lng != null && !(lat === 0 && lng === 0);

  return {
    name:    d.name || null,
    phone:   d.phone || null,
    plate:   veic.plate_no || null,
    vehicle: veic.color || null,   // a 99 só dá cor do veículo, não marca/modelo
    photo:   d.avatar || null,
    rating:  null,                 // a 99Entrega não expõe rating do courier
    lat:     temPosicao ? lat : null,
    lng:     temPosicao ? lng : null,
  };
}

module.exports = {
  // enums / constantes
  VEHICLE_99,
  PACKAGE_TYPES_99,
  PACKAGE_WEIGHTS_99,
  PACKAGE_TYPE_DEFAULT,
  PACKAGE_WEIGHT_DEFAULT,
  CANCEL_REASON_ID_DEFAULT,
  // helpers
  resolverVeiculo,
  resolverTelefone,
  montarEnderecoEstruturado,
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
