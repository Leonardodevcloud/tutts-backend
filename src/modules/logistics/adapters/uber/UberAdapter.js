/**
 * MÓDULO LOGISTICS — UberAdapter
 *
 * Implementação concreta de LogisticsProviderAdapter para Uber Direct.
 *
 * Responsabilidades:
 *  - Traduzir CanonicalQuoteRequest → body Uber Direct (via uber.parser)
 *  - Chamar Uber Direct API (auth via uber.auth)
 *  - Traduzir resposta Uber → CanonicalQuote / CanonicalDelivery
 *  - Mapear status nativo → CanonicalStatus (via uber.status-map)
 *  - Classificar erros para acionabilidade (via uber.errors)
 *
 * O que NÃO faz:
 *  - Persistir em uber_entregas ou logistics_deliveries (responsabilidade do Orchestrator)
 *  - Falar com a Mapp (responsabilidade do MappClient via Orchestrator)
 *  - Validar regras de negócio (responsabilidade do DispatchRuleMatcher)
 *
 * O comportamento HTTP/auth/payload é cópia verbatim de uber.service.js:
 *  - uberCriarCotacao (linhas 227-273) → createQuote
 *  - uberCriarEntrega (linhas 292-382) → createDelivery
 *  - uberCancelarEntrega (linhas 384-399) → cancelDelivery
 *  - uberConsultarEntrega (linhas 401-413) → getDelivery
 *
 * Fase 1B.1: webhook validation + parseWebhookEvent ficam como stubs
 * (implementação real na Fase 1B.2).
 */

const httpRequest = require('../../../../shared/utils/httpRequest');
const { LogisticsProviderAdapter } = require('../../contracts/LogisticsProviderAdapter');
const { CanonicalStatus } = require('../../contracts/CanonicalStatus');
const { obterTokenUber } = require('./uber.auth');
const {
  montarBodyQuote,
  montarBodyDelivery,
} = require('./uber.parser');
const { nativeToCanonical } = require('./uber.status-map');
const { classifyUberError } = require('./uber.errors');
const { validarAssinaturaUber, parsePayloadUber, detectarTipoEvento } = require('./uber.webhook');
const { montarMotivoCancelamentoUber } = require('./uber.cancel');

// Base das APIs por ambiente (doc oficial Uber):
//   Produção: api.uber.com       (pareado com auth.uber.com)
//   Sandbox : test-api.uber.com  (pareado com sandbox-login.uber.com)
const UBER_API_BASE = 'https://api.uber.com/v1/customers';
const UBER_API_BASE_SANDBOX = 'https://test-api.uber.com/v1/customers';

class UberAdapter extends LogisticsProviderAdapter {
  // ════════════════════════════════════════════════════════════
  // Identidade
  // ════════════════════════════════════════════════════════════

  get providerCode() {
    return 'uber';
  }

  get displayName() {
    return 'Uber Direct';
  }

  /**
   * Base da API conforme o ambiente. sandbox_mode=true → test-api.uber.com;
   * caso contrário → api.uber.com. Casado com o domínio de auth (uber.auth).
   */
  get _apiBase() {
    return this.sandboxMode ? UBER_API_BASE_SANDBOX : UBER_API_BASE;
  }

  // ════════════════════════════════════════════════════════════
  // Capabilities
  // ════════════════════════════════════════════════════════════

  capabilities() {
    return {
      ...super.capabilities(),
      supportsQuote: true,
      supportsCancel: true,
      supportsRedispatch: true,
      supportsRealtimeTracking: true,
      vehicleTypes: ['motorcycle', 'car', 'bicycle', 'scooter', 'walker', 'van'],
      coverageRegion: ['BR'],
      webhookAuthScheme: 'hmac-sha256',
      requiresExternalRefAsString: false,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Health check
  // ════════════════════════════════════════════════════════════

  /**
   * Healthcheck: tenta obter um access_token. Se conseguir, a auth está OK
   * e o provider é considerado disponível.
   */
  async healthCheck() {
    const t0 = Date.now();
    try {
      const token = await obterTokenUber(this.pool, this.sandboxMode);
      const latencyMs = Date.now() - t0;
      return {
        ok: !!token,
        latencyMs,
        msg: 'OAuth token obtido com sucesso',
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        msg: err.message,
        errorCode: 'auth_failed',
      };
    }
  }

  // ════════════════════════════════════════════════════════════
  // Authenticate (pre-flight do Orchestrator)
  // ════════════════════════════════════════════════════════════

  /**
   * Chamado pelo Orchestrator antes de createQuote/createDelivery.
   * Para Uber, garante que temos token válido em cache.
   */
  async authenticate() {
    await obterTokenUber(this.pool, this.sandboxMode);  // garante cache
  }

  // ════════════════════════════════════════════════════════════
  // createQuote
  // ════════════════════════════════════════════════════════════

  /**
   * Cria cotação no Uber Direct.
   * Traduz de CanonicalQuoteRequest para o dialeto Uber, chama API,
   * retorna CanonicalQuote.
   *
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalQuote>}
   */
  async createQuote(req) {
    // (req já vem validado pelo Orchestrator via servicoMappToCanonicalQuoteRequest)
    const customerId = this.config.customer_id;
    if (!customerId) {
      throw new Error('UberAdapter: customer_id não configurado em logistics_providers.config');
    }

    const token = await obterTokenUber(this.pool, this.sandboxMode);
    const url = `${this._apiBase}/${customerId}/delivery_quotes`;
    const body = montarBodyQuote(req, this.config);

    const resp = await httpRequest(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = resp.json();

    if (!resp.ok) {
      const errInfo = classifyUberError(resp, data);
      console.error(`❌ [UberAdapter] createQuote falhou (${errInfo.category}/${errInfo.code}):`, errInfo.message);
      console.error('   [UberAdapter] body enviado ao quote:', JSON.stringify(body));
      const err = new Error(`Erro cotação Uber: ${errInfo.message}`);
      err.category = errInfo.category;
      err.code = errInfo.code;
      err.retriable = errInfo.retriable;
      err.httpStatus = errInfo.httpStatus;
      throw err;
    }

    const vehicleType = req.vehicleType && req.vehicleType !== 'auto' ? req.vehicleType : 'auto';

    // Uber retorna distance em metros — convertemos pra km pra precificação
    const distanciaKm = data.distance != null ? Number(data.distance) / 1000 : null;

    console.log(`✅ [UberAdapter] cotação criada: ${data.id} | R$${(data.fee / 100).toFixed(2)} | ETA ${data.duration}min | ${distanciaKm != null ? distanciaKm.toFixed(1)+'km' : 'dist?'} | ${vehicleType}`);

    // CanonicalQuote
    return {
      quoteId: data.id,
      providerCode: this.providerCode,
      valor: data.fee / 100,
      etaMinutos: data.duration,
      vehicleType,
      distanciaKm,  // km da rota retornado pela Uber
      distanciaMetros: data.distance != null ? Number(data.distance) : null,  // 🆕 metros crus
      expiresAt: data.expires ? new Date(data.expires) : new Date(Date.now() + 5 * 60_000),
      rawProvider: data,
    };
  }

  // ════════════════════════════════════════════════════════════
  // createDelivery
  // ════════════════════════════════════════════════════════════

  /**
   * Cria delivery no Uber a partir de uma quote.
   *
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuote} quote
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalDelivery>}
   */
  async createDelivery(quote, req) {
    const customerId = this.config.customer_id;
    if (!customerId) {
      throw new Error('UberAdapter: customer_id não configurado');
    }

    const token = await obterTokenUber(this.pool, this.sandboxMode);
    const url = `${this._apiBase}/${customerId}/deliveries`;

    // montarBodyDelivery agora retorna { body, pickupCode, dropoffCode }
    const { body, pickupCode, dropoffCode } = montarBodyDelivery(quote.quoteId, req, this.config, this.sandboxMode);

    const resp = await httpRequest(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = resp.json();

    if (!resp.ok) {
      const errInfo = classifyUberError(resp, data);
      console.error(`❌ [UberAdapter] createDelivery falhou (${errInfo.category}/${errInfo.code}):`, errInfo.message);
      const err = new Error(`Erro criar entrega Uber: ${errInfo.message}`);
      err.category = errInfo.category;
      err.code = errInfo.code;
      err.retriable = errInfo.retriable;
      err.httpStatus = errInfo.httpStatus;
      throw err;
    }

    console.log(`✅ [UberAdapter] entrega criada: ${data.id} | status=${data.status}`);

    // CanonicalDelivery — inclui códigos de verificação para o Orchestrator salvar
    return {
      externalDeliveryId: data.id,
      providerCode: this.providerCode,
      statusCanonico: nativeToCanonical(data.status),
      statusNative: data.status,
      trackingUrl: data.tracking_url || null,
      courier: data.courier ? this._extractCourier(data.courier) : null,
      rawProvider: data,
      pickupCode:  pickupCode  || null,   // PIN de coleta (gerado por nós)
      dropoffCode: dropoffCode || null,   // PIN de entrega (gerado por nós, se tipo='codigo')
    };
  }

  // ════════════════════════════════════════════════════════════
  // cancelDelivery
  // ════════════════════════════════════════════════════════════

  /**
   * Cancela uma delivery ativa no Uber.
   *
   * ⚠️ CERTIFICAÇÃO: a Uber EXIGE `cancelation_reason` (grafia com 1 L) no corpo,
   * com um dos enums predefinidos. Para 'other', `additional_description` é
   * obrigatório. Sem isso o cancelamento é recusado e o entregador pode continuar
   * atribuído (desalinhamento operacional). O helper montarMotivoCancelamentoUber
   * garante SEMPRE um enum válido (fallback 'other' + descrição).
   *
   * Assinatura em paridade com a 99 (externalOrderRef é aceito mas a Uber cancela
   * pelo delivery_id 'del_...'; o 2º arg fica por compat de chamada).
   *
   * @param {string} externalDeliveryId - delivery_id da Uber (del_...)
   * @param {string} [externalOrderRef] - compat (não usado pela Uber)
   * @param {Object} [opts]
   * @param {string} [opts.cancelationReason] - enum Uber explícito (precedência)
   * @param {string} [opts.motivo] - texto livre do hub (→ heurística ou additional_description)
   * @returns {Promise<{ok: boolean, msg?: string, retriable?: boolean}>}
   */
  async cancelDelivery(externalDeliveryId, externalOrderRef, opts = {}) {
    const customerId = this.config.customer_id;
    if (!customerId) {
      throw new Error('UberAdapter: customer_id não configurado');
    }

    const token = await obterTokenUber(this.pool, this.sandboxMode);
    const url = `${this._apiBase}/${customerId}/deliveries/${externalDeliveryId}/cancel`;

    const { cancelationReason, additionalDescription } = montarMotivoCancelamentoUber({
      reason: opts && opts.cancelationReason,
      motivo: opts && opts.motivo,
    });
    const corpo = { cancelation_reason: cancelationReason };
    if (additionalDescription) corpo.additional_description = additionalDescription;

    const resp = await httpRequest(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
    });

    const data = resp.json();

    if (resp.ok) {
      console.log(`✅ [UberAdapter] delivery ${externalDeliveryId} cancelada (reason=${cancelationReason})`);
      return { ok: true };
    }

    const errInfo = classifyUberError(resp, data);
    console.warn(`⚠️ [UberAdapter] cancel falhou (${errInfo.category}):`, errInfo.message);
    return { ok: false, msg: errInfo.message, retriable: errInfo.retriable };
  }

  // ════════════════════════════════════════════════════════════
  // getDelivery
  // ════════════════════════════════════════════════════════════

  /**
   * Consulta estado atual da delivery no Uber (sync manual quando webhook falha).
   *
   * @param {string} externalDeliveryId
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalDelivery>}
   */
  async getDelivery(externalDeliveryId) {
    const customerId = this.config.customer_id;
    if (!customerId) {
      throw new Error('UberAdapter: customer_id não configurado');
    }

    const token = await obterTokenUber(this.pool, this.sandboxMode);
    const url = `${this._apiBase}/${customerId}/deliveries/${externalDeliveryId}`;

    const resp = await httpRequest(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const data = resp.json();

    if (!resp.ok) {
      const errInfo = classifyUberError(resp, data);
      const err = new Error(`Erro consultar entrega Uber: ${errInfo.message}`);
      err.category = errInfo.category;
      throw err;
    }

    return {
      externalDeliveryId: data.id,
      providerCode: this.providerCode,
      statusCanonico: nativeToCanonical(data.status),
      statusNative: data.status,
      trackingUrl: data.tracking_url || null,
      courier: data.courier ? this._extractCourier(data.courier) : null,
      rawProvider: data,
    };
  }

  // ════════════════════════════════════════════════════════════
  // Status translation
  // ════════════════════════════════════════════════════════════

  nativeToCanonical(nativeStatus) {
    return nativeToCanonical(nativeStatus);
  }

  // ════════════════════════════════════════════════════════════
  // Webhook
  // ════════════════════════════════════════════════════════════

  /**
   * Valida assinatura HMAC-SHA256 do webhook Uber.
   * Sandbox aceita tudo; produção valida contra rawBody.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  async validateWebhookSignature(req) {
    const result = validarAssinaturaUber(req, {
      webhookSecret: this.webhookSecret,
      sandboxMode: this.sandboxMode,
    });
    if (!result.valid) {
      console.warn(`⚠️ [UberAdapter] webhook rejeitado: ${result.motivo}`);
    } else if (result.sandbox) {
      console.log('🤖 [UberAdapter] webhook aceito (sandbox, sem validar assinatura)');
    }
    // Anexa o motivo no req pra o WebhookDispatcher logar
    req._webhookValidation = result;
    return result.valid;
  }

  /**
   * Converte payload bruto do webhook Uber em CanonicalEvent.
   * Retorna null se não há delivery_id ou é evento sem ação.
   *
   * @param {Object} payload - req.body
   * @returns {import('../../contracts/CanonicalTypes').CanonicalEvent | null}
   */
  parseWebhookEvent(payload) {
    return parsePayloadUber(payload);
  }

  /**
   * Tipo do evento (delivery_status | courier_update | refund_request).
   * Exposto pra o WebhookDispatcher poder logar/rotear.
   */
  webhookEventKind(payload) {
    return detectarTipoEvento(payload);
  }

  acknowledgeWebhook(res) {
    // Uber espera 200 com JSON {received: true}
    res.status(200).json({ received: true });
  }

  // ════════════════════════════════════════════════════════════
  // Helpers privados
  // ════════════════════════════════════════════════════════════

  /**
   * Extrai info de courier do payload Uber em formato canônico.
   * Uber retorna { name, phone_number, vehicle_make, vehicle_model, vehicle_license_plate, ... }
   */
  _extractCourier(uberCourier) {
    if (!uberCourier || typeof uberCourier !== 'object') return null;
    return {
      name: uberCourier.name || null,
      phone: uberCourier.phone_number || null,
      plate: uberCourier.vehicle_license_plate || null,
      vehicle: [uberCourier.vehicle_make, uberCourier.vehicle_model].filter(Boolean).join(' ') || null,
      photo: uberCourier.img_href || null,
      rating: uberCourier.rating || null,
      lat: uberCourier.location?.lat || null,
      lng: uberCourier.location?.lng || null,
    };
  }

  // ════════════════════════════════════════════════════════════
  // getProofOfDelivery — comprovante de entrega
  // ════════════════════════════════════════════════════════════

  /**
   * Busca comprovante de entrega da Uber Direct.
   * Disponível após DELIVERED. Retorna objeto com fotos, assinatura e metadata.
   * Endpoint: GET /v1/customers/{customer_id}/deliveries/{id}/proof_of_delivery
   *
   * @param {string} externalDeliveryId
   * @returns {Promise<Object|null>}
   */
  async getProofOfDelivery(externalDeliveryId) {
    const customerId = this.config.customer_id;
    if (!customerId) return null;

    try {
      const token = await obterTokenUber(this.pool, this.sandboxMode);
      const url = `${this._apiBase}/${customerId}/deliveries/${externalDeliveryId}/proof_of_delivery`;
      const resp = await httpRequest(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) {
        console.warn(`⚠️ [UberAdapter] getProofOfDelivery falhou (${resp.status})`);
        return null;
      }
      const data = resp.json();
      console.log(`📸 [UberAdapter] comprovante obtido para entrega ${externalDeliveryId}`);
      return data;
    } catch (err) {
      console.warn(`⚠️ [UberAdapter] getProofOfDelivery erro: ${err.message}`);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════
  // updateDelivery — atualiza entrega em andamento
  // ════════════════════════════════════════════════════════════

  /**
   * Atualiza dados de entrega em andamento na Uber Direct.
   * Endpoint: PATCH /v1/customers/{customer_id}/deliveries/{id}
   * Só funciona antes de pickup_complete (entregador ainda não coletou).
   *
   * @param {string} externalDeliveryId
   * @param {Object} updates - { dropoff_address?, dropoff_name?, dropoff_phone_number?,
   *                             dropoff_notes?, manifest_items?, tip_by_customer? }
   * @returns {Promise<{ok: boolean, msg?: string, data?: Object}>}
   */
  async updateDelivery(externalDeliveryId, updates) {
    const customerId = this.config.customer_id;
    if (!customerId) return { ok: false, msg: 'customer_id não configurado' };

    try {
      const token = await obterTokenUber(this.pool, this.sandboxMode);
      const url = `${this._apiBase}/${customerId}/deliveries/${externalDeliveryId}`;
      const resp = await httpRequest(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });
      const data = resp.json();
      if (!resp.ok) {
        const errInfo = classifyUberError(resp, data);
        console.warn(`⚠️ [UberAdapter] updateDelivery falhou (${errInfo.category}): ${errInfo.message}`);
        return { ok: false, msg: errInfo.message };
      }
      console.log(`✅ [UberAdapter] entrega ${externalDeliveryId} atualizada`);
      return { ok: true, data };
    } catch (err) {
      console.warn(`⚠️ [UberAdapter] updateDelivery erro: ${err.message}`);
      return { ok: false, msg: err.message };
    }
  }
}

module.exports = { UberAdapter };
