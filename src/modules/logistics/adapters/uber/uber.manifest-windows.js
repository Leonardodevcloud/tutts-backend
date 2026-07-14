/**
 * UBER ADAPTER — Delivery Windows + Manifest extras (Gold Standard)
 *
 * Campos REQUIRED do Create Delivery que a Uber valida na certificacao:
 *   - delivery windows: pickup/dropoff ready_dt e deadline_dt (ISO-8601 UTC)
 *   - manifest_reference, external_store_id
 *   - manifest_items: weight (g) e dimensions (cm)
 *
 * REGRAS DAS JANELAS (doc Uber — se violar, o Create falha):
 *   pickup_deadline_dt  >= pickup_ready_dt + 10min  E  >= agora + 20min
 *   dropoff_ready_dt    <= pickup_deadline_dt
 *   dropoff_deadline_dt >= dropoff_ready_dt + 20min  E  >= pickup_deadline_dt
 *
 * Tudo configuravel via logistics_providers.config (offsets em minutos), com
 * defaults sensatos para entrega on-demand. Aplicamos CLAMP nos minimos para
 * NUNCA gerar janela invalida, mesmo que os offsets configurados sejam ruins.
 */

const MIN = 60 * 1000;

function _int(config, chave, def) {
  const v = parseInt(config && config[chave], 10);
  return Number.isFinite(v) ? v : def;
}

/**
 * Monta as 4 janelas em ISO-8601 UTC, com clamp pras regras da Uber.
 * @param {Object} config - logistics_providers.config
 * @param {number} [agora] - epoch ms (injetavel p/ teste)
 * @returns {{pickup_ready_dt,pickup_deadline_dt,dropoff_ready_dt,dropoff_deadline_dt}}
 */
function montarJanelasUber(config, agora = Date.now()) {
  // offsets configuraveis (minutos a partir de agora)
  let pickupReady     = agora + _int(config, 'uber_pickup_ready_offset_min', 0) * MIN;
  let pickupDeadline  = agora + _int(config, 'uber_pickup_deadline_offset_min', 30) * MIN;
  let dropoffReady    = agora + _int(config, 'uber_dropoff_ready_offset_min', 0) * MIN;
  let dropoffDeadline = agora + _int(config, 'uber_dropoff_deadline_offset_min', 120) * MIN;

  // pickup_ready nao pode ser no passado
  if (pickupReady < agora) pickupReady = agora;

  // pickup_deadline >= pickup_ready + 10min  E  >= agora + 20min
  pickupDeadline = Math.max(pickupDeadline, pickupReady + 10 * MIN, agora + 20 * MIN);

  // dropoff_ready <= pickup_deadline (e nao no passado)
  if (dropoffReady < agora) dropoffReady = agora;
  dropoffReady = Math.min(dropoffReady, pickupDeadline);

  // dropoff_deadline >= dropoff_ready + 20min  E  >= pickup_deadline
  dropoffDeadline = Math.max(dropoffDeadline, dropoffReady + 20 * MIN, pickupDeadline);

  return {
    pickup_ready_dt:     new Date(pickupReady).toISOString(),
    pickup_deadline_dt:  new Date(pickupDeadline).toISOString(),
    dropoff_ready_dt:    new Date(dropoffReady).toISOString(),
    dropoff_deadline_dt: new Date(dropoffDeadline).toISOString(),
  };
}

/**
 * Item do manifest com weight (g) e dimensions (cm) — REQUIRED na certificacao.
 * @param {string} nome
 * @param {Object} config
 */
function montarManifestItem(nome, config, priceCents) {
  return {
    name: nome,
    quantity: 1,
    // 🔧 2026-06 (Uber cert): price (centavos) obrigatório. Com 1 item,
    // price = manifest_total_value, então Σ(price×quantity) = manifest_total_value.
    price: parseInt(priceCents != null ? priceCents : ((config && config.manifest_total_value_centavos) || 10000), 10),
    // 🔧 2026-07 (Uber cert item 5): enviar APENAS weight + dimensions (nao size
    // junto). A Uber rejeita size e dimensions no mesmo item. Optamos por
    // dimensions + weight (mais preciso e ja configuravel por provider).
    weight: _int(config, 'uber_item_weight_g', 1000),       // gramas
    dimensions: {
      length: _int(config, 'uber_item_length_cm', 20),       // cm
      height: _int(config, 'uber_item_height_cm', 20),       // cm
      depth:  _int(config, 'uber_item_depth_cm', 20),        // cm
    },
  };
}

/**
 * external_store_id — DEVE ser unico por endereco de retirada/loja.
 * Precedencia:
 *   1) config.uber_external_store_id_fixo (se o parceiro quiser fixar um)
 *   2) derivado do pickup: CEP de coleta + slug do nome da loja (estavel/unico)
 *   3) fallback 'loja-default'
 * @param {Object} req - CanonicalQuoteRequest
 * @param {Object} config
 */
function montarExternalStoreId(req, config) {
  if (config && config.uber_external_store_id_fixo) {
    return String(config.uber_external_store_id_fixo).slice(0, 128);
  }
  // 🔧 2026-07 (Uber): store_id ESTAVEL por loja fisica = CEP da coleta (so digitos).
  // Escolha do parceiro: 100% consistente (mesma loja = mesmo id, tenha ou nao cliente
  // vinculado). O _garantirCEP do UberAdapter resolve o CEP por geocode quando a OS nao
  // traz, entao ate loja sem CEP no cadastro fica com id estavel.
  const p = (req && req.pickup) || {};
  const cepDigits = p.cep ? String(p.cep).replace(/\D/g, '') : '';
  if (cepDigits) {
    return cepDigits.slice(0, 128);
  }
  return 'loja-default';
}

module.exports = {
  montarJanelasUber,
  montarManifestItem,
  montarExternalStoreId,
};
