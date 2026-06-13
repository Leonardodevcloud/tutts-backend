/**
 * MÓDULO LOGISTICS — NinetyNineAdapter (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 — antes este adapter mirava a "99 Corp API" (corridas
 * de passageiro, x-api-key, employeeID/costCenterID). A API correta pro
 * Central Tutts é a 99Entrega (delivery): OAuth 2.0 client_credentials,
 * endpoints /v2/order/*, envelope { errno, errmsg, data }.
 *
 * provider_code = 'noventanove' (snake_case, sem dígito inicial — exigência
 * do contrato). display_name = '99Entrega'.
 *
 * Responsabilidades (idênticas ao UberAdapter, mas falando 99Entrega):
 *  - Traduzir CanonicalQuoteRequest → payload 99Entrega (via noventanove.parser)
 *  - Chamar a 99Entrega (OAuth via noventanove.auth)
 *  - Traduzir resposta → CanonicalQuote / CanonicalDelivery
 *  - Mapear status/eventos → CanonicalStatus (via noventanove.status-map)
 *  - Classificar erros (via noventanove.errors)
 *  - Validar assinatura HMAC do webhook + parsear evento (via noventanove.webhook)
 *
 * PARTICULARIDADES vs UberAdapter (anotadas do README-99-AUTH):
 *  - Toda resposta é { errno, errmsg, data } — errno !== 0 é erro mesmo com HTTP 200.
 *  - createQuote: /v2/order/estimate devolve `estimate_id` + `fee` (CENTAVOS).
 *    O estimate_id É reusável — ele liga a cotação ao create (single-use).
 *  - createDelivery: /v2/order/create CONSOME o estimate_id da quote.
 *  - cancelDelivery: /v2/order/cancel exige `reason_id` (enum 410013..410021).
 *  - getDelivery: /v2/order/detail — é a ÚNICA fonte de posição do entregador
 *    (o webhook da 99 não traz lat/lng).
 *  - acknowledgeWebhook: responde 200 { errno: 0 } (convenção do envelope 99).
 */

const httpRequest = require('../../../../shared/utils/httpRequest');
const { LogisticsProviderAdapter } = require('../../contracts/LogisticsProviderAdapter');
const { CanonicalStatus } = require('../../contracts/CanonicalStatus');
const {
  obterToken,
  montarHeaders,
  validarConfig,
  getBaseUrl,
} = require('./noventanove.auth');
const {
  montarBodyEstimate,
  montarBodyCreate,
  montarBodyCancel,
  parseEstimate,
  extrairCourierDeDetail,
} = require('./noventanove.parser');
const { nativeToCanonical } = require('./noventanove.status-map');
const { classify99Error } = require('./noventanove.errors');
const {
  validarAssinatura99,
  parsePayload99,
  detectarTipoEvento,
} = require('./noventanove.webhook');

class NinetyNineAdapter extends LogisticsProviderAdapter {
  // ════════════════════════════════════════════════════════════
  // Identidade
  // ════════════════════════════════════════════════════════════

  get providerCode() {
    return 'noventanove';
  }

  get displayName() {
    return '99Entrega';
  }

  // ════════════════════════════════════════════════════════════
  // Capabilities
  // ════════════════════════════════════════════════════════════

  capabilities() {
    return {
      ...super.capabilities(),
      supportsQuote: true,             // /v2/order/estimate → estimate_id + fee
      supportsCancel: true,            // /v2/order/cancel (com reason_id)
      supportsRedispatch: true,
      // ⚠️ false: o webhook da 99 não traz posição do entregador. O tracking
      // ao vivo da 99 é por POLLING de /v2/order/detail, não por webhook.
      supportsRealtimeTracking: false,
      // ⚠️ false: a 99Entrega NÃO tem evento de "chegou no destino" separado.
      // O ciclo vai direto de DriverBeginCharge (PICKED_UP) para OrderCompleted
      // (DELIVERED) — não há DriverArrivedDropoff. O WebhookDispatcher usa esta
      // flag para chamar informarChegada(ponto 2) automaticamente antes de
      // finalizar o serviço, compensando a ausência desse evento.
      supportsArrivedDropoff: false,
      vehicleTypes: ['motorcycle'],    // 99Entrega é entrega por moto
      coverageRegion: ['BR'],
      webhookAuthScheme: 'hmac-sha256',
      requiresExternalRefAsString: true,  // external_order_id vai como string
      quoteIsReusable: true,           // estimate_id liga cotação→create
      quoteIsRange: false,             // `fee` é valor fechado, não faixa
    };
  }

  // ════════════════════════════════════════════════════════════
  // Helper interno — base URL da 99Entrega
  // ════════════════════════════════════════════════════════════

  get _baseUrl() {
    return getBaseUrl();
  }

  /**
   * Resolve o segredo de assinatura do webhook. Prioriza a coluna top-level
   * webhook_secret; se vazia, usa o client_secret (a 99Entrega assina os
   * webhooks com o secret da app).
   * @private
   */
  _webhookSecret() {
    return this.webhookSecret || this.config.client_secret || null;
  }

  /**
   * Resolve o CEP de um ponto por geocode reverso (Google) a partir de lat/lng.
   * A 99Entrega exige CEP no structured_address; OS de algumas regioes chegam
   * da Mapp sem CEP. Como o hub sempre manda lat/lng, resolvemos aqui.
   * Best-effort: se falhar, devolve null e o fluxo segue como antes.
   * @private
   */
  async _resolverCEPPorCoordenada(lat, lng) {
    const key = process.env.GOOGLE_GEOCODING_API_KEY;
    if (!key || lat == null || lng == null) return null;
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&language=pt-BR`;
      const resp = await httpRequest(url);
      if (!resp.ok) return null;
      const data = resp.json();
      for (const r of (data.results || [])) {
        const comp = (r.address_components || []).find(c => (c.types || []).includes('postal_code'));
        if (comp && comp.long_name) return comp.long_name;
      }
      return null;
    } catch (_e) { return null; }
  }

  /**
   * Garante CEP em pickup e dropoff de um CanonicalQuoteRequest.
   * Usa o CEP que ja veio (req.pickup.cep); se ausente, resolve por geocode.
   * Muta o req in-place. Best-effort.
   * @private
   */
  async _garantirCEP(req) {
    for (const ponto of ['pickup', 'dropoff']) {
      const p = req && req[ponto];
      if (!p) continue;
      const temCep = p.cep && String(p.cep).replace(/\D/g, '').length >= 8;
      if (!temCep && p.latitude != null && p.longitude != null) {
        const cep = await this._resolverCEPPorCoordenada(p.latitude, p.longitude);
        if (cep) {
          p.cep = cep;
          console.log(`📍 [NinetyNineAdapter] CEP do ${ponto} resolvido por geocode: ${cep}`);
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // Health check
  // ════════════════════════════════════════════════════════════

  /**
   * Healthcheck: tenta obter um access_token OAuth. Se conseguir, as
   * credenciais (client_id/client_secret) estão OK.
   */
  async healthCheck() {
    const t0 = Date.now();
    try {
      validarConfig(this.config);
      const token = await obterToken(this.pool);
      return {
        ok: !!token,
        latencyMs: Date.now() - t0,
        msg: 'OAuth client_credentials OK (token obtido)',
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
   * Garante que há token OAuth válido em cache.
   */
  async authenticate() {
    validarConfig(this.config);
    await obterToken(this.pool);  // garante cache
  }

  // ════════════════════════════════════════════════════════════
  // Helper interno — chamada à 99Entrega + tratamento do envelope
  // ════════════════════════════════════════════════════════════

  /**
   * Faz uma chamada à 99Entrega e desencapsula o envelope { errno, errmsg, data }.
   * Lança erro classificado (com .category/.retriable/...) se errno !== 0 ou HTTP !2xx.
   *
   * @param {string} metodo - 'GET' | 'POST'
   * @param {string} path   - ex: '/v2/order/estimate'
   * @param {Object} [body] - body JSON (POST)
   * @param {string} [contexto] - rótulo pra log
   * @returns {Promise<Object>} o `data` do envelope (já desencapsulado)
   * @private
   */
  async _chamar99(metodo, path, body, contexto = 'op') {
    const url = `${this._baseUrl}${path}`;
    const temBody = body !== undefined && body !== null;

    const headers = await montarHeaders(
      this.pool,
      temBody ? { 'Content-Type': 'application/json' } : {}
    );

    const resp = await httpRequest(url, {
      method: metodo,
      headers,
      body: temBody ? JSON.stringify(body) : undefined,
    });

    const json = resp.json() || {};

    // Erro: HTTP !2xx OU envelope com errno !== 0
    if (!resp.ok || json.errno !== 0) {
      const errInfo = classify99Error(resp, json);
      console.error(`❌ [NinetyNineAdapter] ${contexto} falhou (${errInfo.category}/errno=${errInfo.code}):`, errInfo.message);
      const err = new Error(`Erro 99Entrega (${contexto}): ${errInfo.message}`);
      err.category = errInfo.category;
      err.code = errInfo.code;
      err.retriable = errInfo.retriable;
      err.httpStatus = errInfo.httpStatus;
      throw err;
    }

    return json.data || {};
  }

  // ════════════════════════════════════════════════════════════
  // createQuote — POST /v2/order/estimate
  // ════════════════════════════════════════════════════════════

  /**
   * Cota uma entrega na 99Entrega. O /estimate devolve um `estimate_id`
   * (single-use, consumido pelo createDelivery) e o `fee` em centavos.
   *
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalQuote>}
   */
  async createQuote(req) {
    validarConfig(this.config);
    await this._garantirCEP(req);

    const body = montarBodyEstimate(req, this.config);
    const data = await this._chamar99('POST', '/v2/order/estimate', body, 'createQuote');

    const { estimateId, feeReais, etaMinutos, distanciaMetros, expiresAt, raw } = parseEstimate(data);

    console.log(`✅ [NinetyNineAdapter] cotação: estimate_id=${estimateId} | R$${feeReais != null ? feeReais.toFixed(2) : '?'} | ETA ${etaMinutos != null ? etaMinutos + 'min' : 'n/d'}`);

    // distanciaMetros já parseado — converte pra km
    const distanciaKm = distanciaMetros != null ? distanciaMetros / 1000 : null;

    return {
      quoteId: estimateId,
      providerCode: this.providerCode,
      valor: feeReais != null ? feeReais : 0,
      etaMinutos: etaMinutos != null ? etaMinutos : null,
      vehicleType: 'motorcycle',
      distanciaKm,  // km da rota retornado pela 99Entrega
      distanciaMetros,  // 🆕 metros crus da 99 (delivery_distance) p/ rastreabilidade
      expiresAt: expiresAt instanceof Date && !isNaN(expiresAt)
        ? expiresAt
        : new Date(Date.now() + 5 * 60_000),
      rawProvider: raw,
    };
  }

  // ════════════════════════════════════════════════════════════
  // createDelivery — POST /v2/order/create
  // ════════════════════════════════════════════════════════════

  /**
   * Cria o pedido na 99Entrega CONSUMINDO o estimate_id da cotação.
   *
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuote} quote
   * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalDelivery>}
   */
  async createDelivery(quote, req) {
    validarConfig(this.config);

    if (!quote || !quote.quoteId) {
      throw new Error('NinetyNineAdapter: createDelivery exige a quote (estimate_id) — cote antes via createQuote');
    }

    await this._garantirCEP(req);
    const body = montarBodyCreate(quote.quoteId, req, this.config);
    const data = await this._chamar99('POST', '/v2/order/create', body, 'createDelivery');

    // /create devolve o order_id da 99. external_order_id é idempotente:
    // repetir o mesmo retorna o pedido já criado.
    const orderId = data.order_id || data.orderId || data.id || null;
    if (!orderId) {
      const err = new Error('99Entrega criou o pedido mas não retornou order_id');
      err.category = 'unknown';
      throw err;
    }

    const statusNative = data.status || 'finding';  // pedido nasce buscando entregador

    console.log(`✅ [NinetyNineAdapter] pedido criado: order_id=${orderId} | status=${statusNative}`);

    return {
      externalDeliveryId: String(orderId),
      providerCode: this.providerCode,
      statusCanonico: nativeToCanonical(statusNative),
      statusNative,
      trackingUrl: data.tracking_link || null,
      courier: data.driver_info ? extrairCourierDeDetail(data.driver_info) : null,
      rawProvider: data,
    };
  }

  // ════════════════════════════════════════════════════════════
  // cancelDelivery — POST /v2/order/cancel
  // ════════════════════════════════════════════════════════════

  /**
   * Cancela um pedido ativo na 99Entrega. Exige reason_id (config.cancel_reason_id
   * ou o default do parser). ⚠️ A 99 não cancela depois que o entregador já
   * pegou o pacote — nesse caso a chamada retorna erro e devolvemos ok:false.
   *
   * @param {string} externalDeliveryId - order_id da 99
   * @returns {Promise<{ok: boolean, msg?: string}>}
   */
  async cancelDelivery(externalDeliveryId, externalOrderRef, opts = {}) {
    validarConfig(this.config);

    // external_order_id (= codigo_os) e ESTAVEL; order_id muda em reatribuicao.
    const extRef = (externalOrderRef != null && String(externalOrderRef).trim())
      ? String(externalOrderRef).trim() : null;
    const orderId = (externalDeliveryId != null && String(externalDeliveryId).trim())
      ? String(externalDeliveryId).trim() : null;

    // 2026-06 (v2): UMA tentativa por chamada. A 99 rate-limita cancels do mesmo
    // pedido (errno=1001 "cancel too frequently"), entao NAO disparamos varias
    // seguidas aqui — o re-tentar espacado e responsabilidade do caller.
    // reason_id 410018 = "Delivery no longer needed": cancelamento por decisao do
    // operador, valido em qualquer estado PRE-COLETA. (410013 "nenhum entregador
    // aceitou" so vale no finding e causa errno=-1 no waiting.)
    const reason = (opts && opts.reasonId) ? String(opts.reasonId) : '410018';
    const cfg = Object.assign({}, this.config, { cancel_reason_id: reason });
    const usarOrderId = !!(opts && opts.viaOrderId) || !extRef;
    const body = usarOrderId
      ? montarBodyCancel(null, cfg, orderId || extRef)
      : montarBodyCancel(extRef, cfg, null);

    try {
      await this._chamar99('POST', '/v2/order/cancel', body, 'cancelDelivery');
      console.log(`✅ [NinetyNineAdapter] pedido cancelado (reason_id=${body.reason_id}, via=${usarOrderId ? 'order_id' : 'external_order_id'})`);
      return { ok: true };
    } catch (err) {
      // errno=-1 ("tente mais tarde"/sistema) e errno=1001 ("too frequently")
      // sao TRANSITORIOS — o caller deve reagendar com espacamento.
      const m = String(err.message || '');
      const retriable = /errno=-1\b|errno=1001\b|too\s*frequently|tente\s*novamente|try\s*again|erro no sistema/i.test(m)
        || err.retriable === true;
      console.warn(`⚠️ [NinetyNineAdapter] cancel falhou (${err.category || 'erro'}${retriable ? ', transitorio' : ''}): ${err.message}`);
      return { ok: false, msg: err.message, retriable };
    }
  }

  // ════════════════════════════════════════════════════════════
  // getProofOfDelivery — comprovante (fotos) da 99
  // ════════════════════════════════════════════════════════════

  /**
   * 🆕 2026-06: Busca o comprovante de entrega da 99 (fotos do entregador).
   * Ao contrário da Uber (endpoint dedicado), a 99 devolve as fotos no MESMO
   * /v2/order/detail, dentro de verify_info:
   *   - dropoff_verify_imgs   → fotos da ENTREGA (recebedor)
   *   - pickup_verify_imgs    → fotos da COLETA
   *   - return_handover_imgs  → fotos da DEVOLUÇÃO (quando não entregou)
   * São arrays de URLs. Retorna null se não houver foto nenhuma.
   *
   * Mesmo shape do proof da Uber (fotos[] + metadata) pra reaproveitar o
   * visualizador do front e o endpoint /deliveries/:id/comprovante.
   *
   * @param {string} externalDeliveryId - order_id da 99
   * @returns {Promise<Object|null>}
   */
  async getProofOfDelivery(externalDeliveryId) {
    validarConfig(this.config);
    try {
      const path = `/v2/order/detail?order_id=${encodeURIComponent(externalDeliveryId)}`;
      const data = await this._chamar99('GET', path, undefined, 'getProofOfDelivery');
      const vi = (data && data.verify_info) || {};

      const _arr = (x) => Array.isArray(x) ? x.filter(Boolean) : [];
      const fotosEntrega   = _arr(vi.dropoff_verify_imgs);
      const fotosColeta    = _arr(vi.pickup_verify_imgs);
      const fotosDevolucao = _arr(vi.return_handover_imgs);

      const todas = [].concat(fotosEntrega, fotosColeta, fotosDevolucao);
      if (todas.length === 0) {
        // sem foto ainda (ou verificação por foto não habilitada)
        return null;
      }

      console.log(`📸 [NinetyNineAdapter] comprovante: entrega=${fotosEntrega.length} coleta=${fotosColeta.length} devolucao=${fotosDevolucao.length} (order ${externalDeliveryId})`);

      return {
        provider: 'noventanove',
        // 'fotos' = campo canônico que o front/endpoint ja consomem (entrega primeiro)
        fotos: fotosEntrega.length ? fotosEntrega : todas,
        // detalhamento por tipo (pra quem quiser separar)
        fotos_entrega:   fotosEntrega,
        fotos_coleta:    fotosColeta,
        fotos_devolucao: fotosDevolucao,
        assinatura: null,              // a 99 não fornece assinatura digital
        return_res: data.return_res != null ? data.return_res : null,
        capturado_em: new Date().toISOString(),
      };
    } catch (err) {
      console.warn(`⚠️ [NinetyNineAdapter] getProofOfDelivery erro: ${err.message}`);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════
  // getDelivery — GET /v2/order/detail
  // ════════════════════════════════════════════════════════════

  /**
   * Consulta o estado atual do pedido na 99Entrega. É a ÚNICA fonte de posição
   * do entregador (o webhook da 99 não traz lat/lng) — usar este método pro
   * tracking ao vivo (polling) e pro sync manual.
   *
   * @param {string} externalDeliveryId - order_id da 99
   * @returns {Promise<import('../../contracts/CanonicalTypes').CanonicalDelivery>}
   */
  async getDelivery(externalDeliveryId) {
    validarConfig(this.config);

    const path = `/v2/order/detail?order_id=${encodeURIComponent(externalDeliveryId)}`;
    const data = await this._chamar99('GET', path, undefined, 'getDelivery');
    try {
      console.log(`🔎 [99 detail] order=${externalDeliveryId} status=${data && data.status} verify_info=${JSON.stringify((data && data.verify_info) || null)}`);
    } catch (_e) { /* log best-effort */ }

    const statusNative = data.status || null;

    // Códigos de verificação — a 99 os retorna em data.verify_info (doc oficial:
    // verify_info.pickup_verify_code / dropoff_verify_code, 4 dígitos; string
    // vazia quando o código não é exigido). Mantém fallbacks antigos por garantia.
    const _vi = (data && data.verify_info) || {};
    const _pick = _vi.pickup_verify_code  || data.pickup_code  || data.pickup_info?.code  || null;
    const _drop = _vi.dropoff_verify_code || data.dropoff_code || data.dropoff_info?.code || null;
    // 99 devolve "" (string vazia) quando não exige código — normaliza pra null.
    const pickupCode  = (_pick && String(_pick).trim()) ? String(_pick).trim() : null;
    const dropoffCode = (_drop && String(_drop).trim()) ? String(_drop).trim() : null;

    return {
      externalDeliveryId: String(externalDeliveryId),
      providerCode: this.providerCode,
      statusCanonico: statusNative ? nativeToCanonical(statusNative) : CanonicalStatus.DISPATCHED,
      statusNative,
      trackingUrl: data.tracking_link || null,
      courier: data.driver_info ? extrairCourierDeDetail(data.driver_info) : null,
      rawProvider: data,
      pickupCode:  pickupCode  ? String(pickupCode)  : null,
      dropoffCode: dropoffCode ? String(dropoffCode) : null,
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
   * Valida a assinatura HMAC-SHA256 (base64) de um webhook da 99Entrega.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  async validateWebhookSignature(req) {
    const result = validarAssinatura99(req, {
      webhookSecret: this._webhookSecret(),
      sandboxMode: this.sandboxMode,
    });
    if (!result.valid) {
      console.warn(`⚠️ [NinetyNineAdapter] webhook rejeitado: ${result.motivo}`);
    } else if (result.sandbox) {
      console.log('🤖 [NinetyNineAdapter] webhook aceito (sandbox, sem validar assinatura)');
    }
    req._webhookValidation = result;
    return result.valid;
  }

  /**
   * Converte o payload do webhook da 99Entrega em CanonicalEvent.
   */
  parseWebhookEvent(payload) {
    return parsePayload99(payload);
  }

  webhookEventKind(payload) {
    return detectarTipoEvento(payload);
  }

  /**
   * A 99Entrega trabalha com o envelope { errno, errmsg, data } — o ack do
   * webhook segue a mesma convenção: 200 com { errno: 0 }.
   */
  acknowledgeWebhook(res) {
    res.status(200).json({ errno: 0, errmsg: '' });
  }

  // ════════════════════════════════════════════════════════════
  // updateDelivery — atualiza entrega em andamento
  // ════════════════════════════════════════════════════════════

  /**
   * Atualiza dados de um pedido em andamento na 99Entrega.
   * Endpoint: POST /v2/order/update
   * Só funciona enquanto o entregador ainda não coletou (status != delivering).
   *
   * @param {string} externalDeliveryId - order_id da 99
   * @param {Object} updates - { dropoff_info?: { name?, phone?, structured_address?, note? } }
   * @returns {Promise<{ok: boolean, msg?: string}>}
   */
  async updateDelivery(externalDeliveryId, updates) {
    validarConfig(this.config);
    const body = {
      order_id: String(externalDeliveryId),
      ...updates,
    };
    try {
      await this._chamar99('POST', '/v2/order/update', body, 'updateDelivery');
      console.log(`✅ [NinetyNineAdapter] pedido ${externalDeliveryId} atualizado`);
      return { ok: true };
    } catch (err) {
      console.warn(`⚠️ [NinetyNineAdapter] updateDelivery falhou (${err.category}): ${err.message}`);
      return { ok: false, msg: err.message };
    }
  }
}

module.exports = { NinetyNineAdapter };
