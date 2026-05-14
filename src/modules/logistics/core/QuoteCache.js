/**
 * MÓDULO LOGISTICS — QuoteCache
 *
 * Cache em memória de cotações pendentes (quote_id válido mas ainda não despachada).
 * Generalização do `_quoteCache` que vivia em uber.service.js — agora keyed por
 * providerCode também, pra suportar múltiplos providers (Uber e 99) cotando a
 * mesma OS sem colisão.
 *
 * Por que existe:
 *  - Cotação da Uber Direct expira em 5min. Pra UI mostrar "cotação obtida"
 *    e o operador decidir despachar minutos depois, precisamos guardar o
 *    quote_id + dados originais (servico, coleta, entrega) em algum lugar
 *    pra reusar sem cotar de novo.
 *  - Pra cotação multi-veículo (motorcycle E car em paralelo), guardamos as
 *    duas e o operador escolhe qual despachar.
 *
 * TTL: 4 minutos e 30 segundos (margem de 30s antes dos 5min do Uber).
 *
 * Cleanup: timer interno limpa entradas expiradas a cada 60s (unref pra não
 * segurar o processo Node).
 *
 * NÃO É THREAD-SAFE entre instâncias do servidor — se houver múltiplas réplicas
 * no Railway, cada uma tem seu cache próprio. Não é problema hoje (1 réplica).
 */

const QUOTE_CACHE_TTL_MS = 4 * 60 * 1000 + 30 * 1000;

class QuoteCache {
  constructor() {
    /** @type {Map<string, {quote, request, expiresAt, cachedAt}>} */
    this._map = new Map();
    this._intervalRef = null;
  }

  /**
   * Inicializa cleanup periódico (chamado pelo singleton).
   * Idempotente — chamar várias vezes não cria múltiplos timers.
   */
  startCleanup() {
    if (this._intervalRef) return;
    this._intervalRef = setInterval(() => this._cleanup(), 60_000);
    if (typeof this._intervalRef.unref === 'function') {
      this._intervalRef.unref();
    }
  }

  /**
   * Constrói a chave do cache.
   *
   * @param {string} providerCode
   * @param {(string|number)} codigoOS
   * @param {string} [vehicleType]
   */
  _key(providerCode, codigoOS, vehicleType) {
    return `${providerCode}:${codigoOS}:${vehicleType || 'auto'}`;
  }

  /**
   * Guarda uma cotação no cache.
   *
   * @param {string} providerCode
   * @param {(string|number)} codigoOS
   * @param {string} vehicleType
   * @param {{quote: import('../contracts/CanonicalTypes').CanonicalQuote,
   *          request: import('../contracts/CanonicalTypes').CanonicalQuoteRequest,
   *          servicoMapp?: Object}} dados
   * @returns {Date} expiresAt
   */
  put(providerCode, codigoOS, vehicleType, dados) {
    const expiresAt = new Date(Date.now() + QUOTE_CACHE_TTL_MS);
    this._map.set(this._key(providerCode, codigoOS, vehicleType), {
      ...dados,
      expiresAt,
      cachedAt: new Date(),
    });
    return expiresAt;
  }

  /**
   * Recupera cotação. Retorna null se expirou ou não existe.
   * Se passar quoteId, valida que bate (proteção contra reuse cruzado).
   *
   * @param {string} providerCode
   * @param {(string|number)} codigoOS
   * @param {string} vehicleType
   * @param {string} [quoteIdValidacao]
   */
  get(providerCode, codigoOS, vehicleType, quoteIdValidacao = null) {
    const entrada = this._map.get(this._key(providerCode, codigoOS, vehicleType));
    if (!entrada) return null;

    if (Date.now() > entrada.expiresAt.getTime()) {
      this._map.delete(this._key(providerCode, codigoOS, vehicleType));
      return null;
    }

    if (quoteIdValidacao && entrada.quote?.quoteId !== quoteIdValidacao) {
      return null;
    }

    return entrada;
  }

  /**
   * Busca por quoteId sem saber providerCode/vehicleType (scan).
   * Usado quando frontend envia só o quoteId.
   *
   * @param {string} quoteId
   */
  getByQuoteId(quoteId) {
    if (!quoteId) return null;
    const agora = Date.now();
    for (const [k, v] of this._map.entries()) {
      if (agora > v.expiresAt.getTime()) {
        this._map.delete(k);
        continue;
      }
      if (v.quote?.quoteId === quoteId) return v;
    }
    return null;
  }

  /**
   * Limpa todas as variantes de uma OS (todos os vehicleTypes).
   * Chamado após despacho bem-sucedido pra liberar memória.
   *
   * @param {(string|number)} codigoOS
   * @param {string} [providerCode] - se omitir, limpa de todos os providers
   */
  clearOS(codigoOS, providerCode = null) {
    const prefix = providerCode
      ? `${providerCode}:${codigoOS}:`
      : `:${codigoOS}:`;
    for (const k of [...this._map.keys()]) {
      if (providerCode) {
        if (k.startsWith(`${providerCode}:${codigoOS}:`)) this._map.delete(k);
      } else {
        if (k.includes(`:${codigoOS}:`)) this._map.delete(k);
      }
    }
  }

  /**
   * Cleanup periódico — remove entradas expiradas.
   * @private
   */
  _cleanup() {
    const agora = Date.now();
    for (const [k, v] of this._map.entries()) {
      if (agora > v.expiresAt.getTime()) this._map.delete(k);
    }
  }

  /**
   * Stats — útil pra debug/admin endpoint.
   */
  stats() {
    return {
      size: this._map.size,
      entries: [...this._map.entries()].map(([k, v]) => ({
        key: k,
        cachedAt: v.cachedAt,
        expiresAt: v.expiresAt,
        valor: v.quote?.valor,
        etaMinutos: v.quote?.etaMinutos,
      })),
    };
  }
}

// ════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════
let _instance = null;

function getQuoteCache() {
  if (!_instance) {
    _instance = new QuoteCache();
    _instance.startCleanup();
  }
  return _instance;
}

module.exports = { QuoteCache, getQuoteCache, QUOTE_CACHE_TTL_MS };
