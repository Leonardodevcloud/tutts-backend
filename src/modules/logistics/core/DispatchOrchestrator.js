/**
 * MÓDULO LOGISTICS — DispatchOrchestrator
 *
 * Cérebro do hub: decide, cota, despacha, cancela.
 *
 * Responsabilidades:
 *  - Recebe pedidos de cotação/despacho do worker, do endpoint REST ou do teste manual
 *  - Aplica DispatchRuleMatcher para casar regra
 *  - Aplica validação de margem (R$ + %)
 *  - Decide provider via providers_preferidos (Fase 1B.1: usa só [0], primeiro da lista)
 *  - Reserva OS na Mapp (mappAlterarStatus 0 → 1)
 *  - Cria registro em logistics_deliveries (tabela primária do hub)
 *  - Chama UberAdapter.createQuote + createDelivery
 *  - Atualiza registro com quote_id, valor, delivery_id, tracking_url
 *  - Em caso de erro: marca status='erro' + libera OS na Mapp
 *  - Cancelamento: chama adapter.cancelDelivery + atualiza registro + reabre Mapp
 *
 * O que NÃO faz:
 *  - Falar HTTP com Uber (responsabilidade do UberAdapter)
 *  - Validar HMAC de webhook (responsabilidade do WebhookDispatcher — Fase 1B.2)
 *
 * 🆕 2026-05 Fase 5 — DUAL-WRITE:
 *  - dispatch()/cancel() escrevem direto em logistics_deliveries (Fase 6)
 *    (fonte de verdade pra UI/painel). NADA do comportamento legado muda.
 *  - ADICIONALMENTE espelha o registro em logistics_deliveries (tabela
 *    canônica). É best-effort: se o espelho falhar, loga e segue — o
 *    despacho NÃO é afetado. Quando a paridade for validada, uma fase
 *    futura inverte a leitura pra logistics_deliveries e remove o legado.
 *
 * Comportamento extraído de:
 *  - uber.service.js:cotarParaUber (linhas 668-719) → quote()
 *  - uber.service.js:cotarMultiplosVeiculos (linhas 739-811) → quoteMultiple()
 *  - uber.service.js:despacharParaUber (linhas 813-938) → dispatch()
 *  - uber.service.js:cancelarERedespacharEntrega (linhas 473-590) → redispatch()
 *  - uber.service.js:verificarTimeouts (linhas 1137-1173) → verifyTimeouts()
 */

const { getProviderRegistry } = require('./ProviderRegistry');
const { getEventLogger, EventType, EventSource } = require('./EventLogger');
const { getMappClient } = require('./MappClient');
const { getQuoteCache } = require('./QuoteCache');
const { getDispatchRuleMatcher } = require('./DispatchRuleMatcher');
const { lerConfigGlobal } = require('../routes/config-global.routes');
const { enviarCodigoColeta, enviarCodigoEntrega, normalizarTelefone } = require('../logistics.whatsapp');
const { servicoMappToCanonicalQuoteRequest } = require('../adapters/uber/uber.parser');
const { resolverDestinoViaPonte } = require('./PonteRastreioCliente');

// Status terminais (status_native) — não devem ser re-despachados
const STATUS_TERMINAL = ['cancelado', 'canceled', 'delivered', 'fallback_fila'];

// ═════════════════════════════════════════════════════════════
// 2026-06: helpers de precificacao por distancia. Estavam REFERENCIADOS no
// bloco 6c (linhas ~439/457/458) mas NUNCA foram implementados/importados — o
// try/catch best-effort engolia o ReferenceError em TODA corrida, entao o
// preco por km nunca era aplicado. node --check nao pega (e runtime).
// ═════════════════════════════════════════════════════════════

/**
 * Distancia em km entre dois pontos (Haversine). Fallback quando o provider
 * nao devolve distancia na cotacao. Retorna null se algum ponto for invalido.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  // Number(null)===0 e Number('')===0 (finitos!) — rejeita explicitamente antes,
  // senao coordenada ausente viraria 0 e calcularia uma distancia lixo.
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || v === '')) return null;
  const a1 = Number(lat1), o1 = Number(lon1), a2 = Number(lat2), o2 = Number(lon2);
  if (![a1, o1, a2, o2].every((n) => Number.isFinite(n))) return null;
  const R = 6371; // raio da Terra em km
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(a2 - a1);
  const dLon = rad(o2 - o1);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Preco por distancia: o valor fixo cobre ate `kmBase` km; o que exceder e
 * cobrado a `valorKmAdicional` por km. Retorna null se a tabela nao tiver
 * valor fixo (ai o caller mantem o valor original / so atualiza o custo).
 * @param {number} distKm
 * @param {{valorFixo:number, kmBase:number, valorKmAdicional:number}|null} tabela
 * @returns {number|null} valor em R$ (2 casas) ou null
 */
function calcularPrecoDistancia(distKm, tabela) {
  if (!tabela || tabela.valorFixo == null || !Number.isFinite(Number(tabela.valorFixo))) {
    return null;
  }
  const d = Number(distKm);
  if (!Number.isFinite(d) || d < 0) return null;
  const base = Number.isFinite(Number(tabela.kmBase)) ? Number(tabela.kmBase) : 0;
  const adic = Number.isFinite(Number(tabela.valorKmAdicional)) ? Number(tabela.valorKmAdicional) : 0;
  const excedenteKm = Math.max(0, d - base);
  const total = Number(tabela.valorFixo) + (excedenteKm * adic);
  return Math.round(total * 100) / 100;
}

class DispatchOrchestrator {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
    this.registry = getProviderRegistry(pool);
    this.events = getEventLogger(pool);
    this.mapp = getMappClient(pool);
    this.cache = getQuoteCache();
    this.matcher = getDispatchRuleMatcher(pool);
    // Fase 4: seletor de estratégia multi-provider. Instanciado lazy (depois
    // que `this` está completo) pra o selector poder receber o orchestrator.
    this._strategySelector = null;
  }

  /**
   * StrategySelector lazy-inicializado (Fase 4).
   * Lazy porque o selector recebe `this` (o orchestrator) — não dá pra
   * instanciar no meio do constructor sem `this` estar pronto.
   */
  get strategySelector() {
    if (!this._strategySelector) {
      const { StrategySelector } = require('./StrategySelector');
      this._strategySelector = new StrategySelector({
        orchestrator: this,
        registry: this.registry,
        events: this.events,
      });
    }
    return this._strategySelector;
  }

  // ════════════════════════════════════════════════════════════
  // QUOTE — cota um provider sem despachar
  // ════════════════════════════════════════════════════════════

  /**
   * Cota uma OS num provider específico.
   *
   * @param {number|string} codigoOS
   * @param {Object} opts
   * @param {string} [opts.providerCode='uber'] - default Uber na Fase 1
   * @param {string} [opts.vehicleType] - 'motorcycle' | 'car' | etc
   * @param {Object} [opts.servicoMapp] - se já tem o serviço, evita re-fetch
   * @returns {Promise<{
   *   cotacao: import('../contracts/CanonicalTypes').CanonicalQuote,
   *   request: import('../contracts/CanonicalTypes').CanonicalQuoteRequest,
   *   valor_cliente: number,
   *   valor_profissional: number,
   *   margem: number,
   *   margem_pct: number,
   *   servicoMapp: Object
   * }>}
   */
  async quote(codigoOS, opts = {}) {
    const providerCode = opts.providerCode || 'uber';
    const vehicleType = opts.vehicleType || null;

    const adapter = this._getAdapterOrThrow(providerCode);

    // Pega o serviço Mapp (se ainda não tem)
    const servico = opts.servicoMapp || await this._buscarServicoMapp(codigoOS);
    if (!servico) {
      throw new Error(`OS ${codigoOS} não encontrada na Mapp ou já despachada`);
    }

    // Traduz pra canônico
    const request = servicoMappToCanonicalQuoteRequest(servico);
    request.vehicleType = vehicleType || request.vehicleType;

    // Cota no adapter
    const quote = await adapter.createQuote(request);

    // Calcula margem
    const valorCliente = parseFloat(servico.valorServico) || 0;
    const valorProfissional = parseFloat(servico.valorProfissional) || 0;
    const valorProvider = parseFloat(quote.valor) || 0;
    const margem = valorCliente - valorProvider;
    const margem_pct = valorCliente > 0 ? (margem / valorCliente) * 100 : 0;

    // Cacheia
    this.cache.put(providerCode, codigoOS, vehicleType || 'auto', {
      quote,
      request,
      servicoMapp: servico,
    });

    // Audita
    this.events.log({
      providerCode,
      eventType: EventType.QUOTE_CREATED,
      eventSource: opts.eventSource || EventSource.API,
      codigoOS,
      payload: {
        quote_id: quote.quoteId,
        valor: valorProvider,
        eta_minutos: quote.etaMinutos,
        vehicle_type: quote.vehicleType,
        valor_cliente: valorCliente,
        margem,
        margem_pct,
      },
    });

    console.log(`💰 [Orchestrator] cotação OS ${codigoOS} (${providerCode}/${quote.vehicleType}): cliente=R$${valorCliente.toFixed(2)} provider=R$${valorProvider.toFixed(2)} margem=R$${margem.toFixed(2)} (${margem_pct.toFixed(1)}%)`);

    return {
      cotacao: quote,
      request,
      valor_cliente: valorCliente,
      valor_profissional: valorProfissional,
      valor_provider: valorProvider,
      margem,
      margem_pct,
      servicoMapp: servico,
    };
  }

  /**
   * Cota em paralelo em múltiplos veículos (mantém compatibilidade com modal).
   *
   * @param {number|string} codigoOS
   * @param {Object} opts
   * @param {string} [opts.providerCode='uber']
   * @param {string[]} [opts.vehicleTypes=['motorcycle', 'car']]
   * @returns {Promise<Array<{vehicle_type, available, ...}>>}
   */
  async quoteMultiple(codigoOS, opts = {}) {
    const providerCode = opts.providerCode || 'uber';
    const vehicleTypes = opts.vehicleTypes || ['motorcycle', 'car'];

    // Busca servico UMA vez
    const servico = await this._buscarServicoMapp(codigoOS);
    if (!servico) {
      throw new Error(`OS ${codigoOS} não encontrada na Mapp ou já despachada`);
    }

    const promessas = vehicleTypes.map(vt =>
      this.quote(codigoOS, { providerCode, vehicleType: vt, servicoMapp: servico })
    );
    const resultados = await Promise.allSettled(promessas);

    return resultados.map((r, i) => {
      const vt = vehicleTypes[i];
      if (r.status === 'fulfilled') {
        const d = r.value;
        return {
          vehicle_type: vt,
          available: true,
          quote_id: d.cotacao.quoteId,
          valor_uber: d.valor_provider,        // backward compat com frontend que espera valor_uber
          valor_provider: d.valor_provider,
          valor_cliente: d.valor_cliente,
          valor_profissional: d.valor_profissional,
          margem: d.margem,
          margem_pct: d.margem_pct,
          eta_minutos: d.cotacao.etaMinutos,
          expires_at: d.cotacao.expiresAt,
          endereco_coleta: d.servicoMapp.endereco[0]?.rua,
          endereco_entrega: d.servicoMapp.endereco[d.servicoMapp.endereco.length - 1]?.rua,
          nome_coleta: d.servicoMapp.endereco[0]?.nome || '',
          nome_entrega: d.servicoMapp.endereco[d.servicoMapp.endereco.length - 1]?.nome || '',
          distancia_km: d.cotacao.distanciaKm != null ? d.cotacao.distanciaKm : null,
          observacao: (d.servicoMapp.endereco && d.servicoMapp.endereco[d.servicoMapp.endereco.length - 1] && (d.servicoMapp.endereco[d.servicoMapp.endereco.length - 1].obs || d.servicoMapp.endereco[d.servicoMapp.endereco.length - 1].observacao)) || d.servicoMapp.obs || '',
          telefone_entrega: d.servicoMapp.endereco[d.servicoMapp.endereco.length - 1]?.telefone
            || d.servicoMapp.endereco[d.servicoMapp.endereco.length - 1]?.fone || '',
        };
      } else {
        const errMsg = r.reason?.message || String(r.reason);
        return { vehicle_type: vt, available: false, error: errMsg };
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // DISPATCH — pipeline completo (cotação + criar entrega + persistir)
  // ════════════════════════════════════════════════════════════

  /**
   * Pipeline completo de despacho.
   * Reusa quote pré-cotada se houver (do cache via quoteId ou via opts.quote).
   *
   * @param {Object} servico - Serviço Mapp
   * @param {Object} opts
   * @param {string} [opts.providerCode='uber']
   * @param {string} [opts.vehicleType]
   * @param {number} [opts.regraId]
   * @param {Object} [opts.quoteReuso] - { quote: CanonicalQuote, request: CanonicalQuoteRequest }
   * @param {string} [opts.eventSource='worker']
   * @returns {Promise<Object|null>} registro de logistics_deliveries criado, ou null se OS já estava ativa
   */
  async dispatch(servico, opts = {}) {
    const providerCode = opts.providerCode || 'uber';
    const codigoOS = servico.codigoOS;
    const regraId = opts.regraId || null;
    const eventSource = opts.eventSource || EventSource.WORKER;

    const adapter = this._getAdapterOrThrow(providerCode);

    const enderecos = servico.endereco || [];
    if (enderecos.length < 2) {
      throw new Error(`OS ${codigoOS}: menos de 2 endereços, não é possível despachar`);
    }

    // 1. Verificar idempotência — não despachar OS que já tem entrega ativa
    const { rows: existente } = await this.pool.query(
      `SELECT id, status_native FROM logistics_deliveries
       WHERE codigo_os = $1
         AND status_canonico NOT IN ('CANCELED','DELIVERED')
         AND COALESCE(status_native,'') NOT IN ('cancelado','canceled','delivered','fallback_fila')`,
      [codigoOS]
    );
    if (existente.length > 0) {
      console.log(`⚠️ [Orchestrator] OS ${codigoOS} já tem entrega ativa (id=${existente[0].id}, status=${existente[0].status_native})`);
      return null;
    }

    // 2. Reservar na Mapp (status 0 → 1)
    const respReserva = await this.mapp.alterarStatus(codigoOS, 1);
    if (!this.mapp.respostaOK(respReserva)) {
      console.warn(`⚠️ [Orchestrator] Não foi possível reservar OS ${codigoOS}: ${respReserva?.msgUsuario}`);
      this.events.log({
        providerCode,
        eventType: EventType.DISPATCH_FAILED,
        eventSource,
        codigoOS,
        erro: `Reserva Mapp falhou: ${respReserva?.msgUsuario || 'resposta inválida'}`,
        processado: false,
      });
      return null;
    }
    console.log(`✅ [Orchestrator] OS ${codigoOS} reservada na Mapp (status 0 → 1)`);

    // 3. Inserir registro inicial em logistics_deliveries (status: aguardando_cotacao / PENDING)
    const coleta = enderecos[0];
    const entrega = enderecos[enderecos.length - 1];
    const { rows: [registro] } = await this.pool.query(`
      INSERT INTO logistics_deliveries (
        codigo_os, provider_code, status_canonico, status_native,
        valor_servico, valor_profissional,
        valor_servico_mapp_original, valor_profissional_mapp_original,
        endereco_coleta, endereco_entrega,
        latitude_coleta, longitude_coleta,
        latitude_entrega, longitude_entrega,
        obs, pontos, regra_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `, [
      codigoOS, providerCode, 'PENDING', 'aguardando_cotacao',
      servico.valorServico, servico.valorProfissional,
      servico.valorServico, servico.valorProfissional,
      coleta.rua, entrega.rua,
      coleta.latitude || null, coleta.longitude || null,
      entrega.latitude || null, entrega.longitude || null,
      servico.obs, JSON.stringify(enderecos), regraId,
    ]);

    try {
      // 4. Quote — usa pré-cotada se vier, senão cota
      let quote, request;
      if (opts.quoteReuso) {
        quote = opts.quoteReuso.quote;
        request = opts.quoteReuso.request;
        console.log(`♻️ [Orchestrator] OS ${codigoOS}: reusando quote ${quote.quoteId}`);
      } else {
        const cotResult = await this.quote(codigoOS, {
          providerCode,
          vehicleType: opts.vehicleType,
          servicoMapp: servico,
          eventSource,
        });
        quote = cotResult.cotacao;
        request = cotResult.request;
      }

      // Override de nome do remetente/cliente final (digitados no modal de
      // despacho). Vira pickup_info.name / dropoff_info.name na 99/Uber.
      if (request && request.pickup && opts.nomeRemetente && String(opts.nomeRemetente).trim()) {
        request.pickup.name = String(opts.nomeRemetente).trim().slice(0, 100);
      }
      if (request && request.dropoff && opts.nomeCliente && String(opts.nomeCliente).trim()) {
        request.dropoff.name = String(opts.nomeCliente).trim().slice(0, 100);
      }

      // Ponte rastreio-cliente: nome + telefone do CORPO da OS.
      // Quando os dados do cliente final nao vem em campo estruturado (ficam
      // soltos no corpo), usa o que o RPA do rastreio-cliente extraiu.
      // Prioridade: manual (modal) -> estruturado (entrega.nome) -> ponte.
      // O nome e resolvido AQUI porque vai pro dropoff.name da 99.
      const _ponte = await resolverDestinoViaPonte(this.pool, codigoOS);
      if (request && request.dropoff
          && !(opts.nomeCliente && String(opts.nomeCliente).trim())
          && !String((entrega && entrega.nome) || '').trim()
          && _ponte.nome) {
        request.dropoff.name = String(_ponte.nome).trim().slice(0, 100);
      }

      await this.pool.query(`
        UPDATE logistics_deliveries
        SET external_quote_id = $1, valor_provider = $2, eta_minutos = $3,
            status_canonico = 'PENDING', status_native = 'cotacao_recebida', updated_at = NOW()
        WHERE id = $4
      `, [quote.quoteId, quote.valor, quote.etaMinutos, registro.id]);

      // 5. Criar delivery no provider
      const delivery = await adapter.createDelivery(quote, request);

      // 6. Atualiza com delivery_id + tracking_url
      await this.pool.query(`
        UPDATE logistics_deliveries
        SET external_delivery_id = $1, status_canonico = 'DISPATCHED', status_native = 'enviado_uber',
            tracking_url = $2, vehicle_type = $3, updated_at = NOW()
        WHERE id = $4
      `, [delivery.externalDeliveryId, delivery.trackingUrl || null,
          opts.vehicleType || quote.vehicleType || null, registro.id]);

      // 6a-bis. Salva telefone do destinatario SEMPRE (nao so quando ha codigo).
      //     Prioriza o telefone editado no modal de despacho (opts.telefoneEntrega);
      //     senao usa o do ultimo ponto da OS. Necessario pro 99Entrega: o codigo
      //     (e o WhatsApp) so chegam depois via TrackingPoller, que le telefone_entrega
      //     do registro — se ficar NULL, o WhatsApp nunca e enviado.
      {
        const _telManual = opts.telefoneEntrega ? normalizarTelefone(opts.telefoneEntrega) : null;
        const _telOS = normalizarTelefone(
          enderecos[enderecos.length - 1]?.telefone ||
          enderecos[enderecos.length - 1]?.fone || null
        );
        const _telDestino = _telManual || _telOS || _ponte.telefone;
        if (_telDestino) {
          await this.pool.query(
            'UPDATE logistics_deliveries SET telefone_entrega = $1, updated_at = NOW() WHERE id = $2',
            [_telDestino, registro.id]
          ).catch(err => console.warn(`⚠️ [Orchestrator] erro salvando telefone_entrega OS ${codigoOS}:`, err.message));
        }
      }

      // 6b. Salva códigos de verificação (gerados pelo adapter) + dispara WhatsApp.
      //     Executa em best-effort — falha não aborta o despacho.
      const _pickupCode  = delivery.pickupCode  || null;
      const _dropoffCode = delivery.dropoffCode || null;

      if (_pickupCode || _dropoffCode) {
        // Salva códigos + telefone do destinatário num único UPDATE
        const _telEntregaParaSalvar = normalizarTelefone(
          enderecos[enderecos.length - 1]?.telefone ||
          enderecos[enderecos.length - 1]?.fone || null
        );
        this.pool.query(
          'UPDATE logistics_deliveries SET pickup_code = $1, dropoff_code = $2, telefone_entrega = COALESCE(telefone_entrega, $3), updated_at = NOW() WHERE id = $4',
          [_pickupCode, _dropoffCode, _telEntregaParaSalvar, registro.id]
        ).catch(err => console.warn(`⚠️ [Orchestrator] Erro ao salvar códigos OS ${codigoOS}:`, err.message));

        // Envia WhatsApp do código de COLETA pro remetente (loja)
        // Telefone da coleta vem do primeiro ponto da OS
        if (_pickupCode) {
          const _telColeta = normalizarTelefone(enderecos[0]?.telefone || enderecos[0]?.fone || null);
          if (_telColeta) {
            enviarCodigoColeta(_telColeta, {
              codigoOS,
              codigo: _pickupCode,
              providerNome: providerCode === 'uber' ? 'Uber Direct' : '99Entrega',
            }).catch(() => {});
          }
        }

        // Envia WhatsApp do código de ENTREGA pro destinatário
        if (_dropoffCode) {
          const _telRegistro = await this.pool.query(
            'SELECT telefone_entrega FROM logistics_deliveries WHERE id = $1',
            [registro.id]
          ).then(r => r.rows[0]?.telefone_entrega || null).catch(() => null);

          const _telFinal = _telRegistro || normalizarTelefone(enderecos[enderecos.length - 1]?.telefone || enderecos[enderecos.length - 1]?.fone);
          if (_telFinal) {
            enviarCodigoEntrega(_telFinal, {
              codigoOS,
              codigo: _dropoffCode,
              providerNome: providerCode === 'uber' ? 'Uber Direct' : '99Entrega',
              nomeDestinatario: enderecos[enderecos.length - 1]?.nome || '',
            }).then(r => {
              if (r.enviado) {
                this.pool.query(
                  'UPDATE logistics_deliveries SET codigo_wpp_enviado = TRUE, updated_at = NOW() WHERE id = $1',
                  [registro.id]
                ).catch(() => {});
              }
            }).catch(() => {});
          } else {
            console.warn(`⚠️ [Orchestrator] OS ${codigoOS}: dropoff_code gerado mas sem telefone do destinatário para enviar WhatsApp`);
          }
        }
      }

      // 6c. Precificação por distância — calcula valorServico com base na tabela.
      //     Resolve: regra do cliente → config global → sem precificação.
      //     Distância: provider quote (mais preciso) → haversine (fallback).
      //     Best-effort: falha não aborta o despacho.
      try {
        const _veioDoProvider = quote.distanciaKm != null && quote.distanciaKm > 0;
        const _distKm = _veioDoProvider
          ? quote.distanciaKm
          : haversineKm(
              coleta.latitude, coleta.longitude,
              entrega.latitude, entrega.longitude
            );
        // 🆕 rastro: de onde veio a distancia + metros crus do provider
        const _distOrigem = _veioDoProvider ? 'provider' : 'haversine';
        const _distMetros = _veioDoProvider && quote.distanciaMetros != null
          ? Math.round(Number(quote.distanciaMetros))
          : null;

        if (_distKm != null && _distKm > 0) {
          await this.pool.query(
            'UPDATE logistics_deliveries SET distancia_km = $1, distancia_origem = $2, distancia_metros = $3, updated_at = NOW() WHERE id = $4',
            [Math.round(_distKm * 100) / 100, _distOrigem, _distMetros, registro.id]
          );
          console.log(`📏 [Orchestrator] OS ${codigoOS}: distancia ${_distKm.toFixed(2)}km (origem=${_distOrigem}${_distMetros != null ? ', ' + _distMetros + 'm' : ''})`);

          const _valorProvider2 = parseFloat(quote.valor) || 0;
          const { tabela: _tabPreco, origem: _origemPreco } = await this._resolverTabelaPreco(opts.regra || null);
          const _novoValorServico = calcularPrecoDistancia(_distKm, _tabPreco);

          // Toggle POR REGRA: cada cliente liga/desliga "alterar valor na Mapp"
          // na sua regra de despacho. Default = ativo (regra sem a flag = mantem).
          // Como "sem regra = sem despacho automatico", a regra sempre existe aqui.
          const _alterarMapp = !(opts.regra && opts.regra.alterar_valor_mapp_ativo === false);

          if (_novoValorServico != null) {
            console.log(`💰 [Orchestrator] OS ${codigoOS}: preço por km [${_origemPreco}] — ${_distKm.toFixed(1)}km → cliente=R$${_novoValorServico.toFixed(2)} provider=R$${_valorProvider2.toFixed(2)}`);
            await this.pool.query(
              'UPDATE logistics_deliveries SET valor_servico = $1, updated_at = NOW() WHERE id = $2',
              [_novoValorServico, registro.id]
            );
            if (_alterarMapp) {
              this.mapp.alterarValores(codigoOS, _novoValorServico, _valorProvider2 || null).catch(e =>
                console.warn(`⚠️ [Orchestrator] alterarValores preço OS ${codigoOS}: ${e.message}`)
              );
            } else {
              console.log(`⏸️ [Orchestrator] OS ${codigoOS}: muda valor na Mapp DESATIVADO (toggle) — Mapp inalterado`);
            }
          } else if (_valorProvider2 > 0) {
            // Sem tabela de preço — só atualiza o custo do provider
            if (_alterarMapp) {
              this.mapp.alterarValores(codigoOS, null, _valorProvider2).catch(e =>
                console.warn(`⚠️ [Orchestrator] alterarValores custo OS ${codigoOS}: ${e.message}`)
              );
            }
          }
        }
      } catch (_errPreco) {
        console.warn(`⚠️ [Orchestrator] precificação por km (best-effort) OS ${codigoOS}: ${_errPreco.message}`);
      }

      // 7. Limpa cache de cotações dessa OS
      this.cache.clearOS(codigoOS, providerCode);

      // 8. Audita sucesso
      this.events.log({
        providerCode,
        eventType: EventType.DISPATCH_SUCCESS,
        eventSource,
        codigoOS,
        deliveryId: registro.id,
        externalDeliveryId: delivery.externalDeliveryId,
        statusCanonico: delivery.statusCanonico,
        statusNative: delivery.statusNative,
        payload: {
          quote_id: quote.quoteId,
          valor: quote.valor,
          eta_minutos: quote.etaMinutos,
          tracking_url: delivery.trackingUrl,
        },
      });

      console.log(`✅ [Orchestrator] OS ${codigoOS} despachada → ${providerCode} delivery_id=${delivery.externalDeliveryId}`);

      // 9. 🆕 Fase 6 — logistics_deliveries é a tabela PRIMÁRIA. Não há mais
      // espelho/dual-write: o registro já foi escrito direto na canônica.
      // Retorna o registro canônico + aliases legados (uber_*) por compat.
      return {
        ...registro,
        provider_code:    providerCode,
        external_delivery_id: delivery.externalDeliveryId,
        external_quote_id:    quote.quoteId,
        status_canonico:  'DISPATCHED',
        status_native:    'enviado_uber',
        tracking_url:     delivery.trackingUrl,
        valor_provider:   quote.valor,
        eta_minutos:      quote.etaMinutos,
        // aliases legados — callers antigos que liam uber_*/status_uber
        uber_delivery_id: delivery.externalDeliveryId,
        uber_quote_id:    quote.quoteId,
        valor_uber:       quote.valor,
        status_uber:      'enviado_uber',
        cotacao:          quote,
      };

    } catch (erro) {
      console.error(`❌ [Orchestrator] Erro ao despachar OS ${codigoOS}:`, erro.message);

      await this.pool.query(`
        UPDATE logistics_deliveries
        SET status_canonico = 'FAILED', status_native = 'erro',
            erro_ultimo = $1, tentativas = tentativas + 1, updated_at = NOW()
        WHERE id = $2
      `, [erro.message, registro.id]);

      // Reabre na Mapp pra fila interna
      await this.mapp.alterarStatus(codigoOS, 0).catch(e =>
        console.error(`❌ [Orchestrator] Falha ao reabrir OS ${codigoOS} na Mapp:`, e.message)
      );

      this.events.logError(providerCode, erro, {
        eventSource,
        codigoOS,
        deliveryId: registro.id,
        payload: { erro_categoria: erro.category, http_status: erro.httpStatus },
      });

      return null;
    }
  }

  // 🆕 Fase 6 — o dual-write/espelho foi removido: logistics_deliveries
  // virou a tabela PRIMÁRIA do hub (escrita direta em dispatch/cancel).

  // ════════════════════════════════════════════════════════════
  // CANCEL — cancela entrega ativa
  // ════════════════════════════════════════════════════════════

  /**
   * Cancela uma entrega ativa.
   *
   * @param {number} entregaId - id em logistics_deliveries
   * @param {Object} opts
   * @param {string} [opts.motivo='Cancelado pelo operador']
   * @param {string} [opts.canceladoPor='operador']
   * @param {boolean} [opts.reabrirMapp=true] - se true, libera OS pra fila Mapp
   */
  async cancel(entregaId, opts = {}) {
    const motivo = opts.motivo || 'Cancelado pelo operador';
    const canceladoPor = opts.canceladoPor || 'operador';
    const reabrirMapp = opts.reabrirMapp !== false;

    const { rows } = await this.pool.query('SELECT * FROM logistics_deliveries WHERE id = $1', [entregaId]);
    if (rows.length === 0) {
      throw new Error(`Entrega id=${entregaId} não encontrada`);
    }
    const entrega = rows[0];

    if (['CANCELED','DELIVERED'].includes(entrega.status_canonico)
        || STATUS_TERMINAL.includes(entrega.status_native)) {
      throw new Error(`Entrega já está em estado terminal: ${entrega.status_native || entrega.status_canonico}`);
    }

    // Cancela no provider (se já foi enviada). Captura o resultado: a 99 pode
    // RECUSAR o cancelamento (ex.: corrida ja aceita/em rota) e ainda assim
    // cancelamos localmente — mas precisamos SINALIZAR isso pro operador, senao
    // o pedido fica vivo na 99 sem ninguem saber.
    const externalId = entrega.external_delivery_id;
    let providerCancelado = true;   // true tambem quando nao havia nada a cancelar
    let providerCancelMsg = null;
    if (externalId) {
      const providerCode = entrega.provider_code || 'uber';
      const adapter = this._getAdapterOrThrow(providerCode);
      try {
        // 🆕 passa o codigo_os (external_order_id ESTAVEL da 99) como 2o arg.
        // A doc da 99: order_id MUDA se a corrida e reatribuida a outro
        // entregador; external_order_id (= codigo_os) nunca muda. Cancelar pelo
        // external_order_id evita falha quando houve reatribuicao.
        const rc = await adapter.cancelDelivery(externalId, entrega.codigo_os);
        if (rc && rc.ok === false) {
          providerCancelado = false;
          providerCancelMsg = rc.msg || 'provider recusou o cancelamento';
          // 2026-06: erro transitorio da 99 (errno=-1 "tente mais tarde" ou
          // errno=1001 "too frequently") -> reagenda o cancel em background,
          // espacado (acima do rate limit). Nao bloqueia a resposta ao operador.
          if (rc.retriable) {
            this._agendarRetryCancel99(adapter, entregaId, externalId, entrega.codigo_os);
          }
        }
      } catch (err) {
        providerCancelado = false;
        providerCancelMsg = err.message;
      }
      if (!providerCancelado) {
        console.warn(`⚠️ [Orchestrator] Cancelamento no provider ${providerCode} NAO confirmado (OS ${entrega.codigo_os}): ${providerCancelMsg}`);
      }
    }

    // Atualiza registro
    await this.pool.query(`
      UPDATE logistics_deliveries
      SET status_canonico = 'CANCELED', status_native = 'cancelado',
          cancelado_por = $1, cancelado_motivo = $2, updated_at = NOW()
      WHERE id = $3
    `, [canceladoPor, motivo, entregaId]);

    // Reabre Mapp se solicitado
    if (reabrirMapp) {
      await this.mapp.alterarStatus(entrega.codigo_os, 0).catch(e =>
        console.error(`⚠️ [Orchestrator] Falha ao reabrir OS ${entrega.codigo_os} na Mapp:`, e.message)
      );
    }

    this.events.log({
      providerCode: entrega.provider_code || 'uber',
      eventType: EventType.CANCELED,
      eventSource: opts.eventSource || EventSource.ADMIN,
      codigoOS: entrega.codigo_os,
      deliveryId: entregaId,
      externalDeliveryId: externalId,
      payload: { motivo, cancelado_por: canceladoPor, reabriu_mapp: reabrirMapp },
    });

    return { ok: true, entregaId, providerCancelado, providerCancelMsg };
  }

  /**
   * 2026-06: re-tentativa ESPACADA do cancelamento na 99 quando a 1a falhou com
   * erro transitorio (errno=-1 "tente mais tarde" / errno=1001 "cancel too
   * frequently"). Espacamento bem acima da janela do rate limit da 99.
   * Fire-and-forget (nao bloqueia a resposta). Dedupe por entregaId.
   */
  _agendarRetryCancel99(adapter, entregaId, externalId, codigoOS, tentativa = 1) {
    const ATRASOS_MS = [20000, 60000, 150000]; // 20s, 60s, 150s
    if (!this._retryCancel99) this._retryCancel99 = new Set();
    if (tentativa === 1) {
      if (this._retryCancel99.has(entregaId)) return; // ja tem cadeia rodando
      this._retryCancel99.add(entregaId);
    }
    if (tentativa > ATRASOS_MS.length) {
      this._retryCancel99.delete(entregaId);
      console.warn(`⚠️ [Orchestrator] retry de cancelamento 99 esgotado (OS ${codigoOS}) — pedido pode seguir vivo na 99; verifique manualmente`);
      return;
    }
    setTimeout(async () => {
      try {
        // Se a entrega ja nao consta cancelada localmente, aborta (alguem mexeu).
        const { rows } = await this.pool.query(
          'SELECT status_canonico FROM logistics_deliveries WHERE id = $1', [entregaId]
        );
        if (!rows.length || rows[0].status_canonico !== 'CANCELED') {
          this._retryCancel99.delete(entregaId);
          return;
        }
        const rc = await adapter.cancelDelivery(externalId, codigoOS);
        if (rc && rc.ok) {
          this._retryCancel99.delete(entregaId);
          console.log(`✅ [Orchestrator] cancelamento 99 confirmado no retry ${tentativa} (OS ${codigoOS})`);
          return;
        }
        if (rc && rc.retriable) {
          this._agendarRetryCancel99(adapter, entregaId, externalId, codigoOS, tentativa + 1);
        } else {
          this._retryCancel99.delete(entregaId);
          console.warn(`⚠️ [Orchestrator] retry ${tentativa} cancel 99 (OS ${codigoOS}) falhou (nao-retriable): ${rc && rc.msg}`);
        }
      } catch (e) {
        console.warn(`⚠️ [Orchestrator] erro no retry ${tentativa} cancel 99 (OS ${codigoOS}): ${e.message}`);
        this._agendarRetryCancel99(adapter, entregaId, externalId, codigoOS, tentativa + 1);
      }
    }, ATRASOS_MS[tentativa - 1]);
  }

  // ════════════════════════════════════════════════════════════
  // DECISION HELPER — pipeline completo a partir de um codigoOS
  // ════════════════════════════════════════════════════════════

  /**
   * Resolve qual guardrail de margem aplicar no despacho AUTOMÁTICO.
   *
   * Semântica (decidida com o Tutts):
   *  - A regra do cliente é DEFAULT-override: se a regra define margem
   *    própria (R$ ou %), ela MANDA — o global é ignorado pra essa OS.
   *  - Se a regra NÃO define margem nenhuma, cai no GUARDRAIL GLOBAL
   *    (logistics_config_global), desde que ele esteja ativo.
   *  - Se nem a regra nem o global definem nada → sem guardrail (despacha).
   *
   * @param {Object} regra - logistics_dispatch_rules casada
   * @returns {Promise<{ absMin: (number|null), pctMin: (number|null),
   *                      origem: ('regra'|'global'|'nenhum') }>}
   */
  async _resolverGuardrailMargem(regra) {
    const regraAbs = regra && regra.margem_minima_aceita != null
      ? parseFloat(regra.margem_minima_aceita) : null;
    const regraPct = regra && regra.margem_pct_minima != null
      ? parseFloat(regra.margem_pct_minima) : null;

    // A regra definiu margem própria → override total, global ignorado.
    if (regraAbs != null || regraPct != null) {
      return { absMin: regraAbs, pctMin: regraPct, origem: 'regra' };
    }

    // Regra sem margem → tenta o guardrail global.
    try {
      const cfg = await lerConfigGlobal(this.pool);
      if (cfg && cfg.margem_global_ativa) {
        const gAbs = cfg.margem_global_minima_rs != null
          ? parseFloat(cfg.margem_global_minima_rs) : null;
        const gPct = cfg.margem_global_minima_pct != null
          ? parseFloat(cfg.margem_global_minima_pct) : null;
        if (gAbs != null || gPct != null) {
          return { absMin: gAbs, pctMin: gPct, origem: 'global' };
        }
      }
    } catch (err) {
      // Falha ao ler config global não pode travar despacho — loga e segue
      // sem guardrail (fail-open: o despacho não fica refém da config).
      console.error('⚠️ [Orchestrator] erro ao ler guardrail global:', err.message);
    }

    return { absMin: null, pctMin: null, origem: 'nenhum' };
  }

  /**
   * 2026-06: resolve a tabela de preco por distancia. Mesma logica do
   * _resolverGuardrailMargem: regra do cliente (override) -> config global
   * (se tabela_preco_ativa) -> nenhuma. Campos: preco_valor_fixo /
   * preco_km_base / preco_valor_km_adicional (iguais nas duas tabelas).
   * @param {object|null} regra - logistics_dispatch_rules
   * @returns {Promise<{tabela: {valorFixo:number,kmBase:number,valorKmAdicional:number}|null, origem: string}>}
   */
  async _resolverTabelaPreco(regra) {
    // 1) Regra do cliente definiu tabela propria -> override total.
    if (regra && regra.preco_valor_fixo != null) {
      return {
        tabela: {
          valorFixo: parseFloat(regra.preco_valor_fixo),
          kmBase: regra.preco_km_base != null ? parseFloat(regra.preco_km_base) : 0,
          valorKmAdicional: regra.preco_valor_km_adicional != null ? parseFloat(regra.preco_valor_km_adicional) : 0,
        },
        origem: 'regra',
      };
    }

    // 2) Sem tabela na regra -> tenta a config global (se ativa).
    try {
      const cfg = await lerConfigGlobal(this.pool);
      if (cfg && cfg.tabela_preco_ativa && cfg.preco_valor_fixo != null) {
        return {
          tabela: {
            valorFixo: parseFloat(cfg.preco_valor_fixo),
            kmBase: cfg.preco_km_base != null ? parseFloat(cfg.preco_km_base) : 0,
            valorKmAdicional: cfg.preco_valor_km_adicional != null ? parseFloat(cfg.preco_valor_km_adicional) : 0,
          },
          origem: 'global',
        };
      }
    } catch (err) {
      // fail-open: nao trava o despacho por causa da config de preco
      console.error('⚠️ [Orchestrator] erro ao ler tabela de preco global:', err.message);
    }

    return { tabela: null, origem: 'nenhum' };
  }

  /**
   * Pipeline completo orientado por codigoOS:
   *  1. Busca servico Mapp
   *  2. Casa regra via DispatchRuleMatcher
   *  3. Valida margem (regra do cliente OU guardrail global)
   *  4. Cota
   *  5. Despacha
   *
   * Usado pelo endpoint de teste e (na Fase 1C) pelo PollingWorker.
   *
   * @param {number|string} codigoOS
   * @param {Object} [opts]
   * @param {string} [opts.eventSource='api']
   * @returns {Promise<{decision: string, regra?: object, registro?: object, erro?: string}>}
   */
  async tryDispatchByOS(codigoOS, opts = {}) {
    const eventSource = opts.eventSource || EventSource.API;

    const servico = await this._buscarServicoMapp(codigoOS);
    if (!servico) {
      return { decision: 'os_nao_encontrada', erro: `OS ${codigoOS} não está na Mapp` };
    }

    // 1. Match de regra
    const decisao = await this.matcher.match(servico);
    if (!decisao.despachar) {
      this.events.log({
        providerCode: 'none',
        eventType: EventType.DISPATCH_REJECTED_BY_RULE,
        eventSource,
        codigoOS,
        payload: { motivo: decisao.motivo, regra_id: decisao.regra?.id },
      });
      return { decision: `rejeitado_${decisao.motivo}`, regra: decisao.regra || null };
    }

    const regra = decisao.regra;
    const vehicleType = regra.vehicle_type_preferido || null;

    // ─── Fase 4: decisão de provider via StrategySelector ───
    // Antes (Fases 1-3): providerCode = regra.providers_preferidos[0] (fixo).
    // Agora: o selector decide conforme regra.estrategia (provider_unico,
    // melhor_preco, melhor_eta, fallback).
    const escolha = await this.strategySelector.decidir(servico, regra, { eventSource });

    if (escolha.tipo === 'erro') {
      console.warn(`⚠️ [Orchestrator] OS ${codigoOS}: selector não achou provider viável (${escolha.motivo})`);
      this.events.log({
        providerCode: 'none',
        eventType: EventType.DISPATCH_FAILED,
        eventSource,
        codigoOS,
        erro: `Estratégia falhou: ${escolha.motivo} — ${escolha.detalhe || ''}`,
        processado: false,
      }).catch(() => {});
      return { decision: `rejeitado_estrategia_${escolha.motivo}`, regra };
    }

    // ─── fallback_chain: tenta cada provider em ordem até um aceitar ───
    if (escolha.tipo === 'fallback_chain') {
      return await this._dispatchComFallback(codigoOS, servico, regra, escolha.chain, vehicleType, eventSource);
    }

    // ─── direto: um provider escolhido (provider_unico, melhor_preco, melhor_eta) ───
    const providerCode = escolha.providerCode;
    // melhor_preco/melhor_eta já cotaram — reusa a cotação do selector
    let quoteReuso = escolha.quoteReuso || null;

    // 2. Validação de margem — guardrail da regra do cliente OU o global.
    //    A regra é default-override: se ela define margem, manda; senão,
    //    cai no guardrail global (se ativo). _resolverGuardrailMargem decide.
    const guardrail = await this._resolverGuardrailMargem(regra);
    const exigeMargemAbs = guardrail.absMin != null;
    const exigeMargemPct = guardrail.pctMin != null;

    if (exigeMargemAbs || exigeMargemPct) {
      let cotResult;

      // Se o selector já cotou (melhor_preco/eta), reusa pra validar margem.
      // Senão (provider_unico), cota agora.
      if (quoteReuso && quoteReuso.quote) {
        const valorCliente = parseFloat(servico.valorServico) || 0;
        const valorProvider = parseFloat(quoteReuso.quote.valor) || 0;
        const margem = valorCliente - valorProvider;
        cotResult = {
          cotacao: quoteReuso.quote,
          request: quoteReuso.request,
          margem,
          margem_pct: valorCliente > 0 ? (margem / valorCliente) * 100 : 0,
        };
      } else {
        try {
          cotResult = await this.quote(codigoOS, {
            providerCode,
            vehicleType,
            servicoMapp: servico,
            eventSource,
          });
        } catch (err) {
          return { decision: 'cotacao_falhou', regra, erro: err.message };
        }
      }

      const margemAbsMin = guardrail.absMin;
      const margemPctMin = guardrail.pctMin;

      if (exigeMargemAbs && cotResult.margem < margemAbsMin) {
        console.log(`💸 [Orchestrator] OS ${codigoOS} REJEITADA margem abs (R$${cotResult.margem.toFixed(2)} < ${margemAbsMin}) [guardrail: ${guardrail.origem}]`);
        this.events.log({
          providerCode,
          eventType: EventType.DISPATCH_REJECTED_BY_MARGIN,
          eventSource,
          codigoOS,
          payload: { tipo: 'absoluta', valor: cotResult.margem, minimo: margemAbsMin, guardrail: guardrail.origem },
        });
        return { decision: 'rejeitado_margem_absoluta', regra, margem: cotResult.margem, guardrail: guardrail.origem };
      }
      if (exigeMargemPct && cotResult.margem_pct < margemPctMin) {
        console.log(`💸 [Orchestrator] OS ${codigoOS} REJEITADA margem pct (${cotResult.margem_pct.toFixed(1)}% < ${margemPctMin}%) [guardrail: ${guardrail.origem}]`);
        this.events.log({
          providerCode,
          eventType: EventType.DISPATCH_REJECTED_BY_MARGIN,
          eventSource,
          codigoOS,
          payload: { tipo: 'percentual', valor: cotResult.margem_pct, minimo: margemPctMin, guardrail: guardrail.origem },
        });
        return { decision: 'rejeitado_margem_percentual', regra, margem_pct: cotResult.margem_pct, guardrail: guardrail.origem };
      }

      quoteReuso = { quote: cotResult.cotacao, request: cotResult.request };
    }

    // 3. Despacha
    const registro = await this.dispatch(servico, {
      providerCode,
      vehicleType,
      regraId: regra.id,
      quoteReuso,
      eventSource,
    });

    if (!registro) {
      return { decision: 'despacho_falhou_ou_duplicado', regra };
    }

    return { decision: 'despachado', regra, registro, providerCode, estrategia: escolha._estrategia || regra.estrategia };
  }

  /**
   * Despacha tentando uma cadeia de providers em ordem (estratégia 'fallback').
   * Tenta o primeiro; se falhar (cotação ou despacho), tenta o próximo.
   * Para no primeiro que conseguir.
   *
   * @private
   * @param {number|string} codigoOS
   * @param {Object} servico - serviço Mapp
   * @param {Object} regra
   * @param {string[]} chain - providers ativos em ordem de preferência
   * @param {string|null} vehicleType
   * @param {string} eventSource
   * @returns {Promise<Object>} decisão final
   */
  async _dispatchComFallback(codigoOS, servico, regra, chain, vehicleType, eventSource) {
    const tentativas = [];

    for (let i = 0; i < chain.length; i++) {
      const providerCode = chain[i];
      const ehUltimo = i === chain.length - 1;

      console.log(`🔄 [Orchestrator] OS ${codigoOS}: fallback tentativa ${i + 1}/${chain.length} — ${providerCode}`);

      try {
        // Valida margem — guardrail da regra OU global (mesma resolução do
        // caminho direto, pra a estratégia fallback não ignorar o global).
        let quoteReuso = null;
        const guardrail = await this._resolverGuardrailMargem(regra);
        const exigeMargem = guardrail.absMin != null || guardrail.pctMin != null;

        if (exigeMargem) {
          const cotResult = await this.quote(codigoOS, {
            providerCode, vehicleType, servicoMapp: servico, eventSource,
          });
          const margemAbsMin = guardrail.absMin != null ? guardrail.absMin : -Infinity;
          const margemPctMin = guardrail.pctMin != null ? guardrail.pctMin : -Infinity;

          if (cotResult.margem < margemAbsMin || cotResult.margem_pct < margemPctMin) {
            tentativas.push({ providerCode, resultado: 'rejeitado_margem' });
            console.log(`💸 [Orchestrator] OS ${codigoOS}: ${providerCode} rejeitado por margem [guardrail: ${guardrail.origem}] — próximo da cadeia`);
            continue; // tenta o próximo
          }
          quoteReuso = { quote: cotResult.cotacao, request: cotResult.request };
        }

        const registro = await this.dispatch(servico, {
          providerCode, vehicleType, regraId: regra.id, quoteReuso, eventSource,
        });

        if (registro) {
          console.log(`✅ [Orchestrator] OS ${codigoOS}: fallback teve sucesso no ${providerCode} (tentativa ${i + 1})`);
          this.events.log({
            providerCode,
            eventType: 'strategy_decided',
            eventSource,
            codigoOS,
            payload: { estrategia: 'fallback', vencedor: providerCode, tentativa: i + 1, tentativas_anteriores: tentativas },
          }).catch(() => {});
          return { decision: 'despachado', regra, registro, providerCode, estrategia: 'fallback' };
        }

        // dispatch retornou null (OS já ativa, etc) — não adianta tentar outro
        tentativas.push({ providerCode, resultado: 'despacho_null' });
        return { decision: 'despacho_falhou_ou_duplicado', regra, tentativas };

      } catch (err) {
        tentativas.push({ providerCode, resultado: 'erro', erro: err.message, categoria: err.category });
        console.warn(`⚠️ [Orchestrator] OS ${codigoOS}: ${providerCode} falhou (${err.category || 'erro'}) — ${ehUltimo ? 'fim da cadeia' : 'próximo'}`);
        // continua o loop pro próximo da cadeia
      }
    }

    // Todos da cadeia falharam
    console.error(`❌ [Orchestrator] OS ${codigoOS}: fallback esgotou a cadeia [${chain.join(', ')}] sem sucesso`);
    this.events.log({
      providerCode: 'none',
      eventType: EventType.DISPATCH_FAILED,
      eventSource,
      codigoOS,
      erro: `Fallback esgotou cadeia: ${JSON.stringify(tentativas)}`,
      processado: false,
    }).catch(() => {});
    return { decision: 'rejeitado_fallback_esgotado', regra, tentativas };
  }

  // ════════════════════════════════════════════════════════════
  // VERIFY TIMEOUTS — promove entregas presas a fallback_fila
  // ════════════════════════════════════════════════════════════

  /**
   * Verifica timeouts de entregas sem entregador atribuído.
   * Espelho de uber.service.js:verificarTimeouts (linhas 1137-1173).
   *
   * Regra: se entrega está em status='enviado_uber' (sem courier ainda) há mais
   * de timeout_sem_entregador_min, marca como 'fallback_fila' e reabre na Mapp.
   *
   * @returns {Promise<number>} quantidade promovida pra fallback
   */
  async verifyTimeouts() {
    // Lê timeout da config do provider (logistics_providers)
    let timeoutMin = 10;
    try {
      const { rows } = await this.pool.query(`
        SELECT (config->>'timeout_sem_entregador_min')::int AS t
        FROM logistics_providers WHERE provider_code = 'uber'
      `);
      if (rows[0]?.t) timeoutMin = rows[0].t;
    } catch (e) { /* default 10 */ }

    const { rows: presas } = await this.pool.query(`
      SELECT id, codigo_os, provider_code, external_delivery_id,
             EXTRACT(EPOCH FROM (NOW() - updated_at))/60 AS idade_min
      FROM logistics_deliveries
      WHERE status_native = 'enviado_uber'
        AND external_delivery_id IS NOT NULL
        AND updated_at < NOW() - ($1 || ' minutes')::interval
    `, [timeoutMin]);

    if (presas.length === 0) return 0;

    let promovidas = 0;
    for (const e of presas) {
      try {
        // Cancela no provider (best effort)
        const adapter = this.registry.get(e.provider_code || 'uber');
        if (adapter && e.external_delivery_id) {
          await adapter.cancelDelivery(e.external_delivery_id).catch(() => {});
        }

        // Marca como fallback_fila
        await this.pool.query(`
          UPDATE logistics_deliveries
          SET status_native = 'fallback_fila', status_canonico = 'FAILED',
              cancelado_motivo = $1, updated_at = NOW()
          WHERE id = $2
        `, [`Timeout ${timeoutMin}min sem entregador`, e.id]);

        // Reabre na Mapp
        await this.mapp.alterarStatus(e.codigo_os, 0).catch(() => {});

        this.events.log({
          providerCode: 'uber',
          eventType: EventType.TIMEOUT_FALLBACK,
          eventSource: EventSource.WORKER,
          codigoOS: e.codigo_os,
          deliveryId: e.id,
          externalDeliveryId: e.uber_delivery_id,
          payload: { idade_minutos: parseFloat(e.idade_min).toFixed(1), timeout_min: timeoutMin },
        });

        promovidas++;
        console.log(`⏰ [Orchestrator] OS ${e.codigo_os} promovida pra fallback_fila (${parseFloat(e.idade_min).toFixed(1)}min)`);
      } catch (err) {
        console.error(`❌ [Orchestrator] Erro ao promover entrega ${e.id}:`, err.message);
      }
    }
    return promovidas;
  }

  // (verifyColetaTimeoutsERedespacha + _alertarColetaTimeout removidos a pedido)

  // ════════════════════════════════════════════════════════════
  // Helpers privados
  // ════════════════════════════════════════════════════════════

  _getAdapterOrThrow(providerCode) {
    const adapter = this.registry.get(providerCode);
    if (!adapter) {
      throw new Error(`Provider '${providerCode}' não está ativo no ProviderRegistry`);
    }
    return adapter;
  }

  async _buscarServicoMapp(codigoOS) {
    const servicos = await this.mapp.listarServicos(0, 0);
    return servicos.find(s => Number(s.codigoOS) === Number(codigoOS));
  }

  /**
   * ALERTAS DE MONITORAMENTO -> grupo (EVOLUTION_GROUP_ID).
   * Avisa quando uma corrida esta SEM entregador (DISPATCHED, sem courier) ha:
   *   - > 10 min -> aviso (1x)
   *   - > 15 min -> escalada urgente (1x)
   * Dedup por nivel via colunas alerta_10_em / alerta_15_em (nao reenvia).
   * @returns {Promise<number>} alertas enviados
   */
  async verificarAlertasMonitoramento() {
    const { rows } = await this.pool.query(`
      SELECT d.id, d.codigo_os, d.provider_code, d.endereco_coleta,
             d.alerta_10_em, d.alerta_15_em,
             FLOOR(EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 60) AS idade_min,
             r.cliente_nome
      FROM logistics_deliveries d
      LEFT JOIN logistics_dispatch_rules r ON r.id = d.regra_id
      WHERE d.status_canonico = 'DISPATCHED'
        AND d.atribuido_at IS NULL
        AND d.coletado_at IS NULL
        AND (
          (d.created_at < NOW() - INTERVAL '10 minutes' AND d.alerta_10_em IS NULL)
          OR
          (d.created_at < NOW() - INTERVAL '15 minutes' AND d.alerta_15_em IS NULL)
        )
    `);

    if (rows.length === 0) return 0;

    let enviados = 0;
    for (const d of rows) {
      const minutos = parseInt(d.idade_min, 10) || 0;
      try {
        if (minutos >= 15 && !d.alerta_15_em) {
          await this._enviarMonitoramento(this._msgMonitoramento(15, d, minutos));
          await this.pool.query(
            'UPDATE logistics_deliveries SET alerta_15_em = NOW(), alerta_10_em = COALESCE(alerta_10_em, NOW()) WHERE id = $1',
            [d.id]
          );
          enviados++;
        } else if (minutos >= 10 && !d.alerta_10_em) {
          await this._enviarMonitoramento(this._msgMonitoramento(10, d, minutos));
          await this.pool.query(
            'UPDATE logistics_deliveries SET alerta_10_em = NOW() WHERE id = $1',
            [d.id]
          );
          enviados++;
        }
      } catch (err) {
        console.error(`[Orchestrator] Falha ao alertar monitoramento OS ${d.codigo_os}:`, err.message);
      }
    }
    return enviados;
  }

  _msgMonitoramento(nivel, d, minutos) {
    const cliente = d.cliente_nome || '—';
    const coleta = d.endereco_coleta || '—';
    const provMap = { noventanove: '99', uber: 'Uber' };
    const prov = provMap[d.provider_code] || d.provider_code || '—';
    if (nivel === 15) {
      return [
        '🚨 *MONITORAMENTO — 15 MIN SEM ENTREGADOR*', '',
        `🧾 *OS:* ${d.codigo_os}`,
        `⏱️ *Há:* ${minutos} min sem ninguém aceitar`,
        `🏪 *Cliente:* ${cliente}`,
        `📍 *Coleta:* ${coleta}`,
        `🛵 *Provedor:* ${prov}`, '',
        '❗ Corrida segue sem entregador — pode precisar de ação manual.',
      ].join('\n');
    }
    return [
      '⚠️ *MONITORAMENTO — PROCURANDO ENTREGADOR*', '',
      `🧾 *OS:* ${d.codigo_os}`,
      `⏱️ *Há:* ${minutos} min procurando`,
      `🏪 *Cliente:* ${cliente}`,
      `📍 *Coleta:* ${coleta}`,
      `🛵 *Provedor:* ${prov}`, '',
      '🔎 Nenhum entregador aceitou ainda.',
    ].join('\n');
  }

  async _enviarMonitoramento(texto) {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.EVOLUTION_API_KEY;
    const instancia = process.env.EVOLUTION_INSTANCE;
    const grupoId = process.env.EVOLUTION_GROUP_ID;
    if (!baseUrl || !apiKey || !instancia || !grupoId) {
      console.warn('[Orchestrator] Monitoramento: Evolution/EVOLUTION_GROUP_ID nao configurado - alerta nao enviado');
      return false;
    }
    const response = await fetch(`${baseUrl}/message/sendText/${instancia}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body: JSON.stringify({ number: grupoId, text: texto }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Evolution API erro ${response.status}: ${JSON.stringify(data)}`);
    }
    return true;
  }
}

// ════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════
let _instance = null;

function getDispatchOrchestrator(pool) {
  if (!_instance) {
    if (!pool) throw new Error('DispatchOrchestrator: pool obrigatório na primeira chamada');
    _instance = new DispatchOrchestrator(pool);
  }
  return _instance;
}

module.exports = { DispatchOrchestrator, getDispatchOrchestrator };
