/**
 * NINETYNINE ADAPTER — Parser de payload
 *
 * Traduz objetos canônicos do hub → dialeto da 99 Corp API.
 *
 * Particularidades da 99 (vs Uber):
 *  - Endereço NÃO é JSON-string — são campos planos (from.latitude, from.street, etc)
 *  - from.number é separado do from.street — a 99 quer o número à parte
 *  - Telefone SEM +55 — só DDD+número (ex: "71999998888"), 10-11 dígitos
 *  - receiver.name + receiver.phone são OBRIGATÓRIOS pra categoria delivery99
 *    (e mandamos sempre, mesmo pra delivery-moto99, por segurança)
 *  - employeeID e costCenterID vêm da config (employee técnico fixo + cost center)
 *  - categoryID: delivery-moto99 (moto) ou delivery99 (utilitário)
 *
 * Doc: https://github.com/99Taxis/corp-api-v2-documentation#corridas
 */

const { formatarTelefoneBR, truncarTexto } = require('../../core/AddressParser');

// vehicleType canônico → categoryID da 99
const VEHICLE_TO_CATEGORIA = Object.freeze({
  motorcycle: 'delivery-moto99',
  car:        'delivery99',
  van:        'delivery99',
});
const CATEGORIA_DEFAULT = 'delivery-moto99';

/**
 * Resolve o categoryID da 99 a partir do vehicleType canônico.
 *
 * @param {string} vehicleType
 * @returns {string} categoryID da 99
 */
function resolverCategoria(vehicleType) {
  if (!vehicleType || vehicleType === 'auto') return CATEGORIA_DEFAULT;
  return VEHICLE_TO_CATEGORIA[vehicleType] || CATEGORIA_DEFAULT;
}

/**
 * Tenta extrair o número do logradouro de uma string de endereço.
 * A 99 quer from.number separado. Best-effort: pega o primeiro grupo de
 * dígitos que parece um número de porta (1-6 dígitos isolados).
 * Se não achar, retorna 'S/N'.
 *
 * @param {string} endereco
 * @returns {string}
 */
function extrairNumero(endereco) {
  if (!endereco || typeof endereco !== 'string') return 'S/N';
  // Procura ", 1234" ou " 1234," ou " nº 1234" — número de porta típico
  const m = endereco.match(/(?:^|[,\s])(\d{1,6})(?=[,\s]|$)/);
  return m ? m[1] : 'S/N';
}

/**
 * Monta a query string pra GET /rides/estimate/{employeeId}.
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @returns {string} query string (sem o '?')
 */
function montarQueryEstimate(req) {
  const params = new URLSearchParams({
    fromLat: String(req.pickup.latitude),
    fromLng: String(req.pickup.longitude),
    toLat: String(req.dropoff.latitude),
    toLng: String(req.dropoff.longitude),
  });
  return params.toString();
}

/**
 * Monta o body pra POST /rides (criar corrida/entrega).
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @param {Object} config - logistics_providers.config (employee_id, cost_center_id)
 * @returns {Object} body pronto pra 99
 */
function montarBodyRide(req, config) {
  const categoryID = resolverCategoria(req.vehicleType);

  // Telefones: 99 quer SEM DDI (só DDD+numero)
  const phonePickup = formatarTelefoneBR(req.pickup.phone);
  const phoneDropoff = formatarTelefoneBR(req.dropoff.phone);

  if (!phonePickup) {
    throw new Error('NinetyNineAdapter: telefone de coleta ausente ou inválido (99 exige DDD+número)');
  }
  if (!phoneDropoff) {
    throw new Error('NinetyNineAdapter: telefone de entrega ausente (99 exige receiver.phone pra delivery)');
  }

  const body = {
    employeeID: parseInt(config.employee_id, 10),
    costCenterID: parseInt(config.cost_center_id, 10),
    categoryID,

    from: {
      latitude: parseFloat(req.pickup.latitude),
      longitude: parseFloat(req.pickup.longitude),
      street: truncarTexto(req.pickup.address, 200),
      number: extrairNumero(req.pickup.address),
      reference: truncarTexto(req.pickup.complement, 100) || '',
    },
    to: {
      latitude: parseFloat(req.dropoff.latitude),
      longitude: parseFloat(req.dropoff.longitude),
      street: truncarTexto(req.dropoff.address, 200),
      number: extrairNumero(req.dropoff.address),
      reference: truncarTexto(req.dropoff.complement, 100) || '',
    },

    phoneNumber: phonePickup,  // telefone do "colaborador" = quem solicita = a loja

    // receiver: destinatário da entrega. OBRIGATÓRIO pra delivery99,
    // mandamos sempre (delivery-moto99 também aceita).
    receiver: {
      name: truncarTexto(req.dropoff.name || 'Cliente', 100),
      phone: phoneDropoff,
    },

    notes: truncarTexto(req.itemDescription || `OS ${req.externalRef}`, 128),
  };

  // projectID é opcional — só inclui se configurado
  if (config.project_id) {
    body.projectID = parseInt(config.project_id, 10);
  }

  return body;
}

/**
 * Extrai a melhor categoria da resposta de /rides/estimate.
 * A 99 retorna uma LISTA de categorias; filtramos a que corresponde ao
 * vehicleType pedido. Se não achar exata, pega a primeira de delivery.
 *
 * @param {Array} estimateResponse - array retornado por GET /rides/estimate
 * @param {string} vehicleTypeDesejado
 * @returns {Object|null} { category, estimate } ou null se nenhuma serve
 */
function extrairCategoriaEstimate(estimateResponse, vehicleTypeDesejado) {
  if (!Array.isArray(estimateResponse) || estimateResponse.length === 0) {
    return null;
  }

  const categoriaDesejada = resolverCategoria(vehicleTypeDesejado);

  // Tenta achar a categoria exata
  let match = estimateResponse.find(c => c.category?.id === categoriaDesejada);

  // Fallback: qualquer categoria de delivery
  if (!match) {
    match = estimateResponse.find(c =>
      String(c.category?.id || '').includes('delivery')
    );
  }

  // Último fallback: a primeira da lista
  if (!match) match = estimateResponse[0];

  return match || null;
}

module.exports = {
  resolverCategoria,
  extrairNumero,
  montarQueryEstimate,
  montarBodyRide,
  extrairCategoriaEstimate,
  VEHICLE_TO_CATEGORIA,
  CATEGORIA_DEFAULT,
};
