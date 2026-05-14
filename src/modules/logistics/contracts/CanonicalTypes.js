/**
 * MÓDULO LOGISTICS — Canonical Types
 *
 * Definição dos tipos canônicos via JSDoc. Não exporta classes — só typedefs
 * para que adapters e core trabalhem com a mesma estrutura de objetos.
 *
 * Em JS sem TypeScript, esses tipos servem como contrato escrito + autocomplete
 * no VS Code via @type / @param.
 *
 * Uso esperado:
 *   /** @type {import('../contracts/CanonicalTypes').CanonicalQuoteRequest} *\/
 *   const req = { pickup: { ... }, dropoff: { ... }, ... };
 */

// ════════════════════════════════════════════════════════════
// Endereço
// ════════════════════════════════════════════════════════════

/**
 * @typedef {Object} CanonicalAddress
 * @property {string} address - Endereço completo em formato livre (string única)
 * @property {number} [latitude] - Latitude decimal. Recomendado, alguns providers exigem.
 * @property {number} [longitude] - Longitude decimal.
 * @property {string} [name] - Nome do remetente/destinatário ou loja
 * @property {string} [phone] - Telefone (formato livre — adapter normaliza)
 * @property {string} [complement] - Complemento, instruções, pavimento, sala
 */

// ════════════════════════════════════════════════════════════
// Cotação
// ════════════════════════════════════════════════════════════

/**
 * @typedef {Object} CanonicalQuoteRequest
 * @property {CanonicalAddress} pickup - Endereço de coleta
 * @property {CanonicalAddress} dropoff - Endereço de entrega
 * @property {('motorcycle'|'car'|'van'|'auto')} [vehicleType] - 'auto' deixa provider escolher
 * @property {(string|number)} externalRef - codigoOS da Mapp — vínculo com OS original
 * @property {string} [itemDescription] - Descrição do conteúdo (manifest na Uber, notes na 99)
 * @property {number} [itemValueCents] - Valor declarado em centavos
 */

/**
 * @typedef {Object} CanonicalQuote
 * @property {string} quoteId - Identificador no provider (ou sintético para providers sem quote endpoint)
 * @property {string} providerCode - 'uber' | 'noventanove' | ...
 * @property {number} valor - Em R$ (não centavos)
 * @property {number} etaMinutos - Tempo estimado total
 * @property {string} vehicleType - Veículo cotado
 * @property {Date} expiresAt - Quando o quoteId expira no provider
 * @property {Object} rawProvider - Snapshot bruto da resposta do provider
 */

// ════════════════════════════════════════════════════════════
// Entrega
// ════════════════════════════════════════════════════════════

/**
 * @typedef {Object} CanonicalCourier
 * @property {string} name - Nome do entregador
 * @property {string} [phone] - Telefone (formato livre)
 * @property {string} [plate] - Placa do veículo
 * @property {string} [vehicle] - Marca/modelo (ex: "Honda CG 150")
 * @property {string} [photo] - URL da foto
 * @property {(string|number)} [rating] - Avaliação (0-5)
 * @property {number} [lat] - Última latitude conhecida
 * @property {number} [lng] - Última longitude conhecida
 */

/**
 * @typedef {Object} CanonicalDelivery
 * @property {(string|number)} [deliveryId] - ID interno (logistics_deliveries.id) após persistir
 * @property {string} externalDeliveryId - ID no provider (uber_delivery_id, rideID da 99, etc)
 * @property {string} providerCode
 * @property {string} statusCanonico - Valor de CanonicalStatus
 * @property {string} [statusNative] - Status original do provider sem traduzir
 * @property {string} [trackingUrl]
 * @property {CanonicalCourier} [courier]
 * @property {Object} rawProvider - Snapshot bruto da resposta do create
 */

// ════════════════════════════════════════════════════════════
// Evento de webhook
// ════════════════════════════════════════════════════════════

/**
 * @typedef {Object} CanonicalEvent
 * @property {('status_change'|'courier_update'|'refund'|'other')} eventType
 * @property {string} externalDeliveryId - ID no provider que permite localizar a delivery local
 * @property {string} [statusCanonico] - Preenchido quando eventType = 'status_change'
 * @property {string} [statusNative]
 * @property {CanonicalCourier} [courier] - Preenchido quando eventType = 'courier_update' ou status com info nova
 * @property {{lat: number, lng: number}} [location] - Posição atual do entregador
 * @property {Object} rawProvider - SEMPRE preencher com o payload completo
 */

// ════════════════════════════════════════════════════════════
// Capabilities do adapter
// ════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} [supportsQuote=true] - Se false, Orchestrator pula a etapa de quote
 * @property {boolean} [supportsCancel=true]
 * @property {boolean} [supportsRedispatch=true]
 * @property {boolean} [supportsRealtimeTracking=true]
 * @property {string[]} [vehicleTypes=['motorcycle','car']] - Tipos canônicos suportados
 * @property {string[]} [coverageRegion=['BR']] - Códigos de cobertura
 * @property {('hmac-sha256'|'basic'|'bearer'|'none')} webhookAuthScheme
 * @property {boolean} [requiresExternalRefAsString=false] - Se true, codigoOS vira 'OS-{n}'
 * @property {number} [minOrderValueCents] - Valor mínimo aceito pelo provider
 */

// ════════════════════════════════════════════════════════════
// Healthcheck
// ════════════════════════════════════════════════════════════

/**
 * @typedef {Object} HealthCheckResult
 * @property {boolean} ok
 * @property {number} [latencyMs] - Tempo até resposta do provider
 * @property {string} [msg] - Detalhe humano-legível
 * @property {string} [errorCode] - Código técnico (auth_failed, network, rate_limited, etc)
 */

// ════════════════════════════════════════════════════════════
// Helpers que validam shapes em runtime
// ════════════════════════════════════════════════════════════

/**
 * Valida que um objeto tem o shape mínimo de um CanonicalAddress.
 * Lança Error com mensagem clara em caso de problema.
 *
 * @param {unknown} addr
 * @param {string} label - 'pickup' ou 'dropoff' para mensagens de erro
 */
function assertValidAddress(addr, label = 'address') {
  if (!addr || typeof addr !== 'object') {
    throw new Error(`${label}: objeto obrigatório`);
  }
  if (typeof addr.address !== 'string' || addr.address.trim().length < 5) {
    throw new Error(`${label}.address: string com ≥5 chars obrigatória`);
  }
  if (addr.latitude !== undefined && (typeof addr.latitude !== 'number' || isNaN(addr.latitude))) {
    throw new Error(`${label}.latitude: número válido obrigatório quando fornecido`);
  }
  if (addr.longitude !== undefined && (typeof addr.longitude !== 'number' || isNaN(addr.longitude))) {
    throw new Error(`${label}.longitude: número válido obrigatório quando fornecido`);
  }
}

/**
 * @param {CanonicalQuoteRequest} req
 */
function assertValidQuoteRequest(req) {
  if (!req || typeof req !== 'object') {
    throw new Error('CanonicalQuoteRequest: objeto obrigatório');
  }
  assertValidAddress(req.pickup, 'pickup');
  assertValidAddress(req.dropoff, 'dropoff');
  if (req.externalRef === undefined || req.externalRef === null || req.externalRef === '') {
    throw new Error('CanonicalQuoteRequest.externalRef: codigoOS obrigatório');
  }
  if (req.vehicleType && !['motorcycle', 'car', 'van', 'auto'].includes(req.vehicleType)) {
    throw new Error(`CanonicalQuoteRequest.vehicleType: valor inválido '${req.vehicleType}'`);
  }
}

module.exports = {
  assertValidAddress,
  assertValidQuoteRequest,
};
