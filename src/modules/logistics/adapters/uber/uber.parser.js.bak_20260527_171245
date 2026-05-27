/**
 * UBER ADAPTER — Parser de payload
 *
 * Traduz objetos canônicos do hub para o dialeto que a Uber Direct espera:
 *   - Endereço: JSON-string em pickup_address/dropoff_address
 *   - Coordenadas: campos de primeiro nível (pickup_latitude, etc), NÃO aninhadas
 *   - Telefone: E.164 obrigatório (+5571999999999)
 *   - Manifest: array com pelo menos 1 item (obrigatório no createDelivery)
 *   - external_id: string livre (Tutts usa 'OS-{codigoOS}')
 *
 * Doc: https://developer.uber.com/docs/deliveries/api-reference
 *
 * Quem usa: UberAdapter.createQuote e UberAdapter.createDelivery.
 *
 * Comportamento extraído verbatim de uber.service.js:227-382 (uberCriarCotacao
 * e uberCriarEntrega). Diferenças:
 *  - Aceita CanonicalAddress como input (não objeto custom)
 *  - Aceita ou números explícitos OU strings que viram float
 *  - manifest_total_value_centavos vem da config (10000 default = R$ 100)
 *  - sandbox_mode controla inclusão de test_specifications.robo_courier
 */

const { parsearEnderecoBrasileiro, formatarTelefoneE164, truncarTexto } =
  require('../../core/AddressParser');

/**
 * Monta o JSON-string que vai em pickup_address / dropoff_address.
 *
 * @param {string} stringEndereco - endereço completo em string única
 * @returns {string} JSON-stringified
 */
function montarEnderecoUber(stringEndereco) {
  return JSON.stringify(parsearEnderecoBrasileiro(stringEndereco));
}

/**
 * Monta body para POST /delivery_quotes
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @returns {Object} body que vai pra Uber Direct
 */
function montarBodyQuote(req) {
  const body = {
    pickup_address: montarEnderecoUber(req.pickup.address),
    dropoff_address: montarEnderecoUber(req.dropoff.address),
  };

  // Coordenadas — recomendado pra Brasil
  if (req.pickup.latitude != null && req.pickup.longitude != null) {
    body.pickup_latitude = parseFloat(req.pickup.latitude);
    body.pickup_longitude = parseFloat(req.pickup.longitude);
  }
  if (req.dropoff.latitude != null && req.dropoff.longitude != null) {
    body.dropoff_latitude = parseFloat(req.dropoff.latitude);
    body.dropoff_longitude = parseFloat(req.dropoff.longitude);
  }

  // Veículo (motorcycle, car, bicycle, scooter, walker, van).
  // Se for 'auto' ou null, NÃO inclui o campo — Uber escolhe o mais barato.
  if (req.vehicleType && req.vehicleType !== 'auto') {
    body.vehicle_type = req.vehicleType;
  }

  return body;
}

/**
 * Monta body para POST /deliveries
 *
 * @param {string} quoteId
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @param {Object} config - logistics_providers.config (manifest_total_value_centavos, telefone_suporte, sandbox_mode)
 * @returns {Object} body completo
 */
function montarBodyDelivery(quoteId, req, config) {
  const telSuporte = formatarTelefoneE164(config.telefone_suporte);

  const pickupPhone = formatarTelefoneE164(req.pickup.phone) || telSuporte;
  const dropoffPhone = formatarTelefoneE164(req.dropoff.phone) || telSuporte;

  if (!pickupPhone || !dropoffPhone) {
    throw new Error('Telefone de coleta/entrega ausente e telefone_suporte não configurado');
  }

  const manifestValueCents = parseInt(config.manifest_total_value_centavos || 10000, 10);
  const manifestItems = [{
    name: truncarTexto(req.itemDescription || 'Encomenda', 100),
    quantity: 1,
    size: 'small',
  }];

  const body = {
    quote_id: quoteId,
    external_id: `OS-${req.externalRef}`,

    pickup_address: montarEnderecoUber(req.pickup.address),
    pickup_name: truncarTexto(req.pickup.name || 'Loja', 100),
    pickup_phone_number: pickupPhone,
    pickup_business_name: truncarTexto(req.pickup.name || 'Loja', 100),
    pickup_notes: truncarTexto(req.pickup.complement, 280),

    dropoff_address: montarEnderecoUber(req.dropoff.address),
    dropoff_name: truncarTexto(req.dropoff.name || 'Cliente', 100),
    dropoff_phone_number: dropoffPhone,
    dropoff_notes: truncarTexto(req.dropoff.complement, 280),

    manifest_items: manifestItems,
    manifest_total_value: manifestValueCents,

    deliverable_action: 'deliverable_action_meet_at_door',
    undeliverable_action: 'return',
  };

  // Coordenadas
  if (req.pickup.latitude != null && req.pickup.longitude != null) {
    body.pickup_latitude = parseFloat(req.pickup.latitude);
    body.pickup_longitude = parseFloat(req.pickup.longitude);
  }
  if (req.dropoff.latitude != null && req.dropoff.longitude != null) {
    body.dropoff_latitude = parseFloat(req.dropoff.latitude);
    body.dropoff_longitude = parseFloat(req.dropoff.longitude);
  }

  // Sandbox: Robo Courier auto pra simular ciclo
  if (config.sandbox_mode === true) {
    body.test_specifications = {
      robo_courier_specification: { mode: 'auto' },
    };
  }

  return body;
}

/**
 * Extrai CanonicalQuoteRequest de um "serviço" da Mapp.
 *
 * O "serviço" tem o shape:
 *   { codigoOS, valorServico, valorProfissional, obs,
 *     endereco: [{ rua, nome, telefone, complemento, latitude, longitude, fone }, ...] }
 *
 * O primeiro endereço é coleta, o último é entrega (pode haver intermediários
 * em rotas multi-ponto, mas para Uber só usamos coleta+entrega final).
 *
 * @param {Object} servico - retorno da Mapp listarServicos
 * @returns {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest}
 */
function servicoMappToCanonicalQuoteRequest(servico) {
  const enderecos = servico.endereco || [];
  if (enderecos.length < 2) {
    throw new Error(`OS ${servico.codigoOS}: menos de 2 endereços, não é possível cotar`);
  }

  const coleta = enderecos[0];
  const entrega = enderecos[enderecos.length - 1];

  return {
    pickup: {
      address: coleta.rua,
      name: coleta.nome || 'Loja',
      phone: coleta.telefone || coleta.fone || null,
      complement: coleta.complemento || null,
      latitude: coleta.latitude != null ? parseFloat(coleta.latitude) : null,
      longitude: coleta.longitude != null ? parseFloat(coleta.longitude) : null,
    },
    dropoff: {
      address: entrega.rua,
      name: entrega.nome || 'Cliente',
      phone: entrega.telefone || entrega.fone || null,
      complement: entrega.complemento || null,
      latitude: entrega.latitude != null ? parseFloat(entrega.latitude) : null,
      longitude: entrega.longitude != null ? parseFloat(entrega.longitude) : null,
    },
    vehicleType: null, // Decidido pelo caller (Orchestrator decide via regra)
    externalRef: servico.codigoOS,
    itemDescription: servico.obs || `OS ${servico.codigoOS}`,
  };
}

module.exports = {
  montarEnderecoUber,
  montarBodyQuote,
  montarBodyDelivery,
  servicoMappToCanonicalQuoteRequest,
};
