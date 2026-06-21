/**
 * MÓDULO LOGISTICS — Shared
 *
 * Constantes e helpers usados em múltiplas camadas do hub (core, routes, adapters).
 * NÃO deve conter lógica de negócio nem chamadas HTTP.
 */

// ════════════════════════════════════════════════════════════
// Eventos WebSocket (broadcast pro frontend)
// ════════════════════════════════════════════════════════════
// Substituem os antigos UBER_LOCATION_UPDATE, UBER_STATUS_UPDATE, etc.
// Cada evento carrega { providerCode } no payload pra UI saber qual badge mostrar.

const LOGISTICS_WS_EVENTS = Object.freeze({
  LOCATION_UPDATE: 'LOGISTICS_LOCATION_UPDATE',
  STATUS_UPDATE:   'LOGISTICS_STATUS_UPDATE',
  COURIER_INFO:    'LOGISTICS_COURIER_INFO',
  DELIVERY_CREATED:'LOGISTICS_DELIVERY_CREATED',
  DELIVERY_ERROR:  'LOGISTICS_DELIVERY_ERROR',
});

// ════════════════════════════════════════════════════════════
// Estratégias de despacho válidas
// ════════════════════════════════════════════════════════════

const DISPATCH_STRATEGIES = Object.freeze({
  PROVIDER_UNICO: 'provider_unico',
  FALLBACK:       'fallback',
  MELHOR_PRECO:   'melhor_preco',
  MELHOR_ETA:     'melhor_eta',
});

const DISPATCH_STRATEGY_VALUES = Object.values(DISPATCH_STRATEGIES);

function isValidStrategy(s) {
  return DISPATCH_STRATEGY_VALUES.includes(s);
}

// ════════════════════════════════════════════════════════════
// Tipos de veículo canônicos
// ════════════════════════════════════════════════════════════

const VEHICLE_TYPES = Object.freeze({
  MOTORCYCLE: 'motorcycle',
  CAR:        'car',
  VAN:        'van',
  AUTO:       'auto',  // 'provider escolhe o mais barato disponível'
});

const VEHICLE_TYPE_VALUES = Object.values(VEHICLE_TYPES);

function isValidVehicleType(v) {
  return VEHICLE_TYPE_VALUES.includes(v);
}

// ════════════════════════════════════════════════════════════
// Defaults
// ════════════════════════════════════════════════════════════

const DEFAULTS = Object.freeze({
  WORKER_POLLING_INTERVAL_SEC: 30,
  WORKER_JANELA_MIN: 30,
  TIMEOUT_SEM_ENTREGADOR_MIN: 10,
  QUOTE_CACHE_TTL_MS: 4 * 60 * 1000 + 30 * 1000,  // 4:30 — quote Uber expira em 5min
});

// ════════════════════════════════════════════════════════════
// Helper: detector de máscara em segredos (reusa lógica do uber/admin.routes.js)
// ════════════════════════════════════════════════════════════
// Identifica strings que são SÓ caracteres mascarados (bolinhas, asteriscos, traços)
// pra ignorar tentativas de salvar placeholder por cima de credencial boa.

function ehMascara(v) {
  if (typeof v !== 'string') return false;
  return /^[•·●○*–\-\u2022\u00b7]+$/.test(v.trim());
}

function valorSecretoValido(v) {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'string') return false;
  if (v.trim() === '') return false;
  if (ehMascara(v)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Paridade entre provedores (99 / Uber). Centralizado aqui pra os
// adapters nunca divergirem nestes processos.
// ─────────────────────────────────────────────────────────────
const AVISO_ENTREGADOR_DEFAULT = 'Transporte de pecas automotivas. Antes de aceitar, veja se possui as ferramentas para coletar.';

function resolverAvisoEntregador(config) {
  if (config && typeof config.aviso_entregador === 'string' && config.aviso_entregador.trim()) {
    return config.aviso_entregador.trim();
  }
  return AVISO_ENTREGADOR_DEFAULT;
}

// Numeracao da OS exibida ao motoboy: so os 4 ultimos digitos (igual nos dois
// provedores). A referencia INTEIRA continua indo nos campos de idempotencia.
function osUltimos4(externalRef) {
  const s = String(externalRef == null ? '' : externalRef);
  return s.length > 4 ? s.slice(-4) : s;
}

module.exports = {
  LOGISTICS_WS_EVENTS,
  DISPATCH_STRATEGIES,
  DISPATCH_STRATEGY_VALUES,
  isValidStrategy,
  VEHICLE_TYPES,
  VEHICLE_TYPE_VALUES,
  isValidVehicleType,
  DEFAULTS,
  ehMascara,
  valorSecretoValido,
  AVISO_ENTREGADOR_DEFAULT,
  resolverAvisoEntregador,
  osUltimos4,
};
