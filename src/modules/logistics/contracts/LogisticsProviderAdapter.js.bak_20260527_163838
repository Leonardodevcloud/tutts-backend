/**
 * MÓDULO LOGISTICS — LogisticsProviderAdapter
 *
 * Classe base abstrata. Todo adapter de provider logístico (Uber, 99, Lalamove, ...)
 * deve herdar desta classe e implementar os métodos marcados como abstratos.
 *
 * Princípio de design: cada método abstrato lança "not implemented" se a subclasse
 * não substituir. Isso garante feedback em tempo de runtime — não em tempo de "ops,
 * o webhook não chamou meu handler porque eu esqueci de implementar."
 *
 * IMPORTANTE: o adapter NÃO conversa com Mapp. Quem fala Mapp é o core (MappClient).
 * O adapter:
 *  1. Recebe CanonicalQuoteRequest / CanonicalQuote / payload de webhook
 *  2. Traduz para o dialeto do provider
 *  3. Faz a chamada HTTP
 *  4. Traduz a resposta de volta para canônico
 *  5. Retorna ao core
 */

const {
  assertValidQuoteRequest,
} = require('./CanonicalTypes');

class LogisticsProviderAdapter {
  /**
   * @param {Object} deps - Dependências injetadas pelo ProviderRegistry
   * @param {import('pg').Pool} deps.pool - Pool PostgreSQL
   * @param {Object} deps.config - Conteúdo de logistics_providers.config (descriptografado)
   * @param {Object} deps.capabilities - Conteúdo de logistics_providers.capabilities
   * @param {string} [deps.webhookSecret] - Para validação de assinatura
   * @param {boolean} [deps.sandboxMode] - Aciona comportamentos de teste
   */
  constructor(deps) {
    if (new.target === LogisticsProviderAdapter) {
      throw new Error('LogisticsProviderAdapter é abstrata — instancie uma subclasse');
    }
    if (!deps || typeof deps !== 'object') {
      throw new Error(`${this.constructor.name}: deps obrigatório no construtor`);
    }
    if (!deps.pool) {
      throw new Error(`${this.constructor.name}: deps.pool obrigatório`);
    }
    this.pool = deps.pool;
    this.config = deps.config || {};
    this._capabilities = deps.capabilities || {};
    this.webhookSecret = deps.webhookSecret || null;
    this.sandboxMode = !!deps.sandboxMode;
  }

  // ════════════════════════════════════════════════════════════
  // Identidade — abstratos (subclasse DEVE sobrescrever via getter)
  // ════════════════════════════════════════════════════════════

  /**
   * Código único do provider (snake_case, sem dígito inicial).
   * Exemplos: 'uber', 'noventanove', 'lalamove'
   * @returns {string}
   */
  get providerCode() {
    throw new Error(`${this.constructor.name}: getter providerCode() não implementado`);
  }

  /**
   * Nome amigável para UI.
   * Exemplos: 'Uber Direct', '99', 'Lalamove'
   * @returns {string}
   */
  get displayName() {
    throw new Error(`${this.constructor.name}: getter displayName() não implementado`);
  }

  // ════════════════════════════════════════════════════════════
  // Capabilities — pode ser sobrescrito, mas tem default
  // ════════════════════════════════════════════════════════════

  /**
   * Retorna as capabilities do provider. Subclasse pode sobrescrever para
   * customizar; default lê de deps.capabilities + defaults sensatos.
   *
   * @returns {import('./CanonicalTypes').ProviderCapabilities}
   */
  capabilities() {
    return {
      supportsQuote: true,
      supportsCancel: true,
      supportsRedispatch: true,
      supportsRealtimeTracking: true,
      vehicleTypes: ['motorcycle', 'car'],
      coverageRegion: ['BR'],
      webhookAuthScheme: 'none',
      requiresExternalRefAsString: false,
      ...this._capabilities,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Lifecycle
  // ════════════════════════════════════════════════════════════

  /**
   * Healthcheck do provider (auth + ping).
   * Chamado por POST /providers/{code}/test-connection.
   *
   * @returns {Promise<import('./CanonicalTypes').HealthCheckResult>}
   */
  async healthCheck() {
    throw new Error(`${this.constructor.name}: healthCheck() não implementado`);
  }

  /**
   * Garante que o adapter está autenticado. Para OAuth2, faz refresh se necessário.
   * Para API key estática, no-op. Chamado pelo Orchestrator antes de qualquer
   * operação. Cada adapter decide o que fazer aqui.
   *
   * @returns {Promise<void>}
   */
  async authenticate() {
    // Default: no-op (API key estática não precisa de nada)
  }

  // ════════════════════════════════════════════════════════════
  // Operações principais
  // ════════════════════════════════════════════════════════════

  /**
   * Cria uma cotação no provider.
   *
   * @param {import('./CanonicalTypes').CanonicalQuoteRequest} req
   * @returns {Promise<import('./CanonicalTypes').CanonicalQuote>}
   */
  async createQuote(req) {
    assertValidQuoteRequest(req);  // validação comum a todos os adapters
    throw new Error(`${this.constructor.name}: createQuote() não implementado`);
  }

  /**
   * Cria uma delivery no provider a partir de uma cotação.
   *
   * @param {import('./CanonicalTypes').CanonicalQuote} quote
   * @param {import('./CanonicalTypes').CanonicalQuoteRequest} req - Mesmo request da cotação
   * @returns {Promise<import('./CanonicalTypes').CanonicalDelivery>}
   */
  async createDelivery(quote, req) {
    throw new Error(`${this.constructor.name}: createDelivery() não implementado`);
  }

  /**
   * Cancela uma delivery ativa no provider.
   *
   * @param {string} externalDeliveryId
   * @returns {Promise<{ok: boolean, msg?: string}>}
   */
  async cancelDelivery(externalDeliveryId) {
    if (!this.capabilities().supportsCancel) {
      throw new Error(`${this.providerCode}: cancelamento não suportado`);
    }
    throw new Error(`${this.constructor.name}: cancelDelivery() não implementado`);
  }

  /**
   * Consulta o estado atual de uma delivery no provider.
   * Usado para sync manual quando webhook falha.
   *
   * @param {string} externalDeliveryId
   * @returns {Promise<import('./CanonicalTypes').CanonicalDelivery>}
   */
  async getDelivery(externalDeliveryId) {
    throw new Error(`${this.constructor.name}: getDelivery() não implementado`);
  }

  // ════════════════════════════════════════════════════════════
  // Webhook
  // ════════════════════════════════════════════════════════════

  /**
   * Valida a assinatura/auth da requisição de webhook.
   * Cada provider tem seu schema (HMAC, Basic Auth, etc).
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  async validateWebhookSignature(req) {
    throw new Error(`${this.constructor.name}: validateWebhookSignature() não implementado`);
  }

  /**
   * Converte o payload bruto do webhook em um CanonicalEvent.
   * Retorna null se o evento não interessa ao core (ex: ping, heartbeat).
   *
   * @param {Object} payload - req.body do webhook
   * @returns {import('./CanonicalTypes').CanonicalEvent | null}
   */
  parseWebhookEvent(payload) {
    throw new Error(`${this.constructor.name}: parseWebhookEvent() não implementado`);
  }

  /**
   * Envia a resposta HTTP que o provider espera após processar o webhook.
   * Cada provider tem expectativas diferentes:
   *  - Uber: 200 com JSON {received: true}
   *  - 99 v1: 2xx com BODY VAZIO em até 10s (qualquer corpo dispara retry)
   *
   * @param {import('express').Response} res
   */
  acknowledgeWebhook(res) {
    // Default: responde 200 com body vazio (compatível com a maioria dos providers)
    res.status(200).end();
  }

  // ════════════════════════════════════════════════════════════
  // Tradução de status — abstrato
  // ════════════════════════════════════════════════════════════

  /**
   * Traduz um status nativo do provider para CanonicalStatus.
   * Subclasse implementa via mapping table.
   *
   * @param {string} nativeStatus
   * @returns {string} - Valor de CanonicalStatus
   */
  nativeToCanonical(nativeStatus) {
    throw new Error(`${this.constructor.name}: nativeToCanonical() não implementado`);
  }

  // ════════════════════════════════════════════════════════════
  // Helpers de tradução de payload (opcionais — adapter pode usar livremente)
  // ════════════════════════════════════════════════════════════

  /**
   * Formata o externalRef conforme o provider exige.
   * Uber aceita 'OS-123' (string livre); 99 pode preferir só o número.
   *
   * @param {(string|number)} ref
   * @returns {string|number}
   */
  formatExternalRef(ref) {
    if (this.capabilities().requiresExternalRefAsString) {
      return String(ref).startsWith('OS-') ? String(ref) : `OS-${ref}`;
    }
    return ref;
  }
}

module.exports = { LogisticsProviderAdapter };
