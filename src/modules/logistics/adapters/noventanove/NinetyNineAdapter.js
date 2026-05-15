/**
 * MÓDULO LOGISTICS — NinetyNineAdapter
 *
 * Implementação concreta de LogisticsProviderAdapter para a 99 Corp API v2.
 *
 * provider_code = 'noventanove' (snake_case, sem dígito inicial — exigência
 * do contrato). display_name = '99' (o que aparece pro usuário).
 *
 * Responsabilidades (idênticas ao UberAdapter, mas falando 99):
 *  - Traduzir CanonicalQuoteRequest → payload 99 (via noventanove.parser)
 *  - Chamar a 99 Corp API (auth via x-api-key — noventanove.auth)
 *  - Traduzir resposta 99 → CanonicalQuote / CanonicalDelivery
 *  - Mapear status → CanonicalStatus (via noventanove.status-map)
 *  - Classificar erros (via noventanove.errors)
 *  - Validar Basic Auth de webhook + parsear evento (via noventanove.webhook)
 *
 * PARTICULARIDADES vs UberAdapter:
 *  - createQuote: a 99 não tem quote reusável. /rides/estimate é só informativo
 *    (faixa de preço lowerFare/upperFare). O quoteId retornado é sintético
 *    (não vai pra lugar nenhum) — serve só pra UI mostrar preço/ETA.
 *  - createDelivery: NÃO usa o quoteId. Cria a corrida do zero via POST /rides.
 *    O parâmetro `quote` é aceito (contrato) mas ignorado.
 *  - acknowledgeWebhook: responde 200 com CORPO VAZIO (a 99 exige isso).
 *  - getDelivery: usa GET /rides/{id}, que tem running.status (UPPER_SNAKE).
 *
 * Pré-requisitos de conta (em logistics_providers.config):
 *   api_key        — x-api-key da conta 99
 *   employee_id    — colaborador técnico fixo (pra cotar e criar corrida)
 *   cost_center_id — centro de custo (POST /rides exige)
 *   project_id     — opcional
 *   webhook_username / webhook_password — Basic Auth do webhook
 */

const httpRequest = require('../../../../shared/utils/httpRequest');
const { LogisticsProviderAdapter } = require('../../contracts/LogisticsProviderAdapter');
const { CanonicalStatus } = require('../../contracts/CanonicalStatus');
const { getBaseUrl, montarHeaders, validarConfig } = require('./noventanove.auth');
const {
  montarQueryEstimate,
  montarBodyRide,
  extrairCategoriaEstimate,
  resolverCategoria,
} = require('./noventanove.parser');
const { nativeToCanonical } = require('./noventanove.status-map');
const { classify99Error } = require('./noventanove.errors');
const { validarBasicAuth, parsePayload99, detectarTipoEvento } = require('./noventanove.webhook');

class NinetyNineAdapter extends LogisticsProviderAdapter {
  // ════════════════════════════════════════════════════════════
  // Identidade
  // ════════════════════════════════════════════════════════════

  get providerCode() {
    return 'noventanove';
  }

  get displayName() {
    return '99';
  }

  // ════════════════════════════════════════════════════════════
  // Capabilities
  // ════════════════════════════════════════════════════════════

  capabilities() {
    return {
      ...super.capabilities(),
      supportsQuote: true,            // /rides/estimate (faixa de preço, informativo)
      supportsCancel: true,           // DELETE /rides/{id}
      supportsRedispatch: true,
      supportsRealtimeTracking: true, // subscription ride-driver-location
      vehicleTypes: ['motorcycle', 'car', 'van'],
      coverageRegion: ['BR'],
      webhookAuthScheme: 'basic-auth',
      requiresExternalRefAsString: false,
      // Particularidades que o Orchestrator pode querer saber:
      quoteIsReusable: false,         // a 99 NÃO tem quote_id reusável
      quoteIsRange: true,             // retorna lowerFare/upperFare, não valor fechado
    };
  }

  // ════════════════════════════════════════════════════════════
  // Helper interno — base URL conforme sandbox
  // ════════════════════════════════════════════════════════════

  get _baseUrl() {
    return getBaseUrl(this.sandboxMode);
  }

  // ════════════════════════════════════════════════════════════
  // Health check
  // ════════════════════════════════════════════════════════════

  /**
   * Healthcheck: GET /companies. Se voltar 200, a x-api-key é válida.
   */
  async healthCheck() {
    const t0 = Date.now();
    try {
      if (!this.config.api_key) {
        return { ok: false, latencyMs: 0, msg: 'api_key não configurada', errorCode: 'no_api_key' };
      }
      const resp = await httpRequest(`${this._baseUrl}/companies`, {
        method: 'GET',
        headers: montarHeaders(this.config),
      });
      const latencyMs = Date.now() - t0;
      if (resp.ok) {
        return { ok: true, latencyMs, msg: 'x-api-key válida (GET /companies OK)' };
      }
      const errInfo = classify99Error(resp);
      return { ok: false, latencyMs, msg: errInfo.message, errorCode: errInfo.category };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, msg: err.message, errorCode: 'network' };
    }
  }

  // ════════════════════════════════════════════════════════════
  // Authenticate (pre-flight) — pra 99 é só validar que a config existe
  // ════════════════════════════════════════════════════════════

  async authenticate() {
    // 99 não tem token a renovar — só confirma que a api_key está lá.
    if (!this.config.api_key) {
      throw new Error('NinetyNineAdapter: api_key não configurada');
    }
  }

  // ════════════════════════════════════════════════════════════
  // createQuote — GET /rides/estimate/{employeeId}
  // ════════════════════════════════════════════════════════════

  /**
   * "Cota" via /rides/estimate. ATENÇÃO: a 99 não tem quote reusável.
   * Isto é INFORMATIVO — retorna faixa de preço (lowerFare/upperFare) e ETA.
   * O quoteId retornado é sintético (não é usado no createDelivery).
   *
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalQuote>}
   */
  async createQuote(req) {
    validarConfig(this.config, { exigirEmployee: true, exigirCostCenter: false });

    const employeeId = this.config.employee_id;
    const query = montarQueryEstimate(req);
    const url = `${this._baseUrl}/rides/estimate/${employeeId}?${query}`;

    const resp = await httpRequest(url, {
      method: 'GET',
      headers: montarHeaders(this.config),
    });

    const data = resp.json();

    if (!resp.ok) {
      const errInfo = classify99Error(resp, data);
      console.error(`❌ [NinetyNineAdapter] createQuote falhou (${errInfo.category}/${errInfo.code}):`, errInfo.message);
      const err = new Error(`Erro cotação 99: ${errInfo.message}`);
      err.category = errInfo.category;
      err.code = errInfo.code;
      err.retriable = errInfo.retriable;
      err.httpStatus = errInfo.httpStatus;
      throw err;
    }

    // data é uma LISTA de categorias — extrai a que corresponde ao vehicleType
    const match = extrairCategoriaEstimate(data, req.vehicleType);
    if (!match) {
      const err = new Error('99 não retornou categoria de delivery disponível para esse trajeto');
      err.category = 'coverage';
      err.retriable = false;
      throw err;
    }

    // valor: usamos lowerFare (piso da faixa — conservador)
    const lowerFare = match.estimate?.lowerFare ?? null;
    const upperFare = match.estimate?.upperFare ?? null;
    const etaMinutos = match.category?.eta ?? null;
    const categoryId = match.category?.id || resolverCategoria(req.vehicleType);

    console.log(`✅ [NinetyNineAdapter] estimativa: ${categoryId} | R$${lowerFare}-${upperFare} | ETA ${etaMinutos}min`);

    // quoteId SINTÉTICO — a 99 não tem quote real. Formato reconhecível.
    const quoteIdSintetico = `99-estimate-${req.externalRef}-${Date.now()}`;

    return {
      quoteId: quoteIdSintetico,
      providerCode: this.providerCode,
      valor: lowerFare,                    // piso da faixa
      valorMax: upperFare,                 // teto (extra, fora do contrato mínimo)
      etaMinutos,
      vehicleType: req.vehicleType || 'motorcycle',
      expiresAt: new Date(Date.now() + 5 * 60_000),  // a 99 não dá expiração — usamos 5min nominal
      rawProvider: { categoria: match, faixa: { lowerFare, upperFare } },
    };
  }

  // ════════════════════════════════════════════════════════════
  // createDelivery — POST /rides
  // ════════════════════════════════════════════════════════════

  /**
   * Cria a corrida/entrega via POST /rides.
   * IMPORTANTE: o parâmetro `quote` é ACEITO (contrato) mas IGNORADO — a 99
   * não usa quote_id. A corrida é criada do zero a partir do `req`.
   *
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuote} quote - ignorado
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalDelivery>}
   */
  async createDelivery(quote, req) {
    validarConfig(this.config, { exigirEmployee: true, exigirCostCenter: true });

    const url = `${this._baseUrl}/rides`;
    const body = montarBodyRide(req, this.config);

    const resp = await httpRequest(url, {
      method: 'POST',
      headers: montarHeaders(this.config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

    const data = resp.json();

    if (!resp.ok) {
      const errInfo = classify99Error(resp, data);
      console.error(`❌ [NinetyNineAdapter] createDelivery falhou (${errInfo.category}/${errInfo.code}):`, errInfo.message);
      const err = new Error(`Erro criar corrida 99: ${errInfo.message}`);
      err.category = errInfo.category;
      err.code = errInfo.code;
      err.retriable = errInfo.retriable;
      err.httpStatus = errInfo.httpStatus;
      throw err;
    }

    // POST /rides retorna { rideID, smsStartedSent, smsDriverCanceledSent }
    const rideId = data.rideID || data.rideId;
    if (!rideId) {
      const err = new Error('99 criou a corrida mas não retornou rideID');
      err.category = 'unknown';
      throw err;
    }

    console.log(`✅ [NinetyNineAdapter] corrida criada: rideID=${rideId}`);

    return {
      externalDeliveryId: String(rideId),
      providerCode: this.providerCode,
      // POST /rides não retorna status — corrida nasce em "finding" (buscando motorista)
      statusCanonico: CanonicalStatus.DISPATCHED,
      statusNative: 'finding',
      trackingUrl: null,    // a 99 não fornece tracking URL pública
      courier: null,        // courier vem depois, via webhook
      rawProvider: data,
    };
  }

  // ════════════════════════════════════════════════════════════
  // cancelDelivery — DELETE /rides/{id}
  // ════════════════════════════════════════════════════════════

  async cancelDelivery(externalDeliveryId) {
    if (!this.config.api_key) {
      throw new Error('NinetyNineAdapter: api_key não configurada');
    }

    const url = `${this._baseUrl}/rides/${externalDeliveryId}`;
    const resp = await httpRequest(url, {
      method: 'DELETE',
      headers: montarHeaders(this.config),
    });

    if (resp.ok) {
      console.log(`✅ [NinetyNineAdapter] corrida ${externalDeliveryId} cancelada`);
      return { ok: true };
    }

    const data = resp.json();
    const errInfo = classify99Error(resp, data);
    console.warn(`⚠️ [NinetyNineAdapter] cancel falhou (${errInfo.category}):`, errInfo.message);
    return { ok: false, msg: errInfo.message };
  }

  // ════════════════════════════════════════════════════════════
  // getDelivery — GET /rides/{id}
  // ════════════════════════════════════════════════════════════

  async getDelivery(externalDeliveryId) {
    if (!this.config.api_key) {
      throw new Error('NinetyNineAdapter: api_key não configurada');
    }

    const url = `${this._baseUrl}/rides/${externalDeliveryId}`;
    const resp = await httpRequest(url, {
      method: 'GET',
      headers: montarHeaders(this.config),
    });

    const data = resp.json();

    if (!resp.ok) {
      const errInfo = classify99Error(resp, data);
      const err = new Error(`Erro consultar corrida 99: ${errInfo.message}`);
      err.category = errInfo.category;
      throw err;
    }

    // GET /rides/{id} retorna { status, running: { driver, ... } }
    // O `status` aqui é UPPER_SNAKE (running.status) — o status-map cobre os dois.
    const nativeStatus = data.status || data.running?.status || null;
    const driver = data.running?.driver || null;

    return {
      externalDeliveryId: String(externalDeliveryId),
      providerCode: this.providerCode,
      statusCanonico: nativeStatus ? nativeToCanonical(nativeStatus) : CanonicalStatus.DISPATCHED,
      statusNative: nativeStatus,
      trackingUrl: null,
      courier: driver ? this._extractCourierFromRide(driver) : null,
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
   * Valida o Basic Auth de um webhook da 99.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  async validateWebhookSignature(req) {
    const result = validarBasicAuth(req, {
      webhookUsername: this.config.webhook_username,
      webhookPassword: this.config.webhook_password,
      sandboxMode: this.sandboxMode,
    });
    if (!result.valid) {
      console.warn(`⚠️ [NinetyNineAdapter] webhook rejeitado: ${result.motivo}`);
    } else if (result.sandbox) {
      console.log('🤖 [NinetyNineAdapter] webhook aceito (sandbox, sem validar Basic Auth)');
    }
    req._webhookValidation = result;
    return result.valid;
  }

  /**
   * Converte payload do webhook da 99 em CanonicalEvent.
   */
  parseWebhookEvent(payload) {
    return parsePayload99(payload);
  }

  webhookEventKind(payload) {
    return detectarTipoEvento(payload);
  }

  /**
   * A 99 EXIGE corpo vazio + status 2xx em até 10s.
   * Diferente da Uber, que espera JSON { received: true }.
   */
  acknowledgeWebhook(res) {
    res.status(200).end();   // .end() sem argumento = corpo VAZIO
  }

  // ════════════════════════════════════════════════════════════
  // Helpers privados
  // ════════════════════════════════════════════════════════════

  /**
   * Extrai courier canônico do objeto `running.driver` de GET /rides.
   * (O webhook usa o extractCourier de noventanove.webhook; este é pro getDelivery.)
   */
  _extractCourierFromRide(driver) {
    if (!driver || typeof driver !== 'object') return null;
    const pos = driver.position || null;
    return {
      name: driver.fullName || null,
      phone: driver.phoneNumber || null,
      plate: driver.carPlate || null,
      vehicle: driver.carModel || null,
      photo: driver.img || null,
      rating: driver.rating || null,
      lat: pos?.latitude ?? null,
      lng: pos?.longitude ?? null,
    };
  }
}

module.exports = { NinetyNineAdapter };
