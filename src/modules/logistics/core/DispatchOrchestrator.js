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
 *  - Cria registro em uber_entregas (Opção A: escrita no legado, mantém UI/painel)
 *  - Chama UberAdapter.createQuote + createDelivery
 *  - Atualiza registro com quote_id, valor, delivery_id, tracking_url
 *  - Em caso de erro: marca status='erro' + libera OS na Mapp
 *  - Cancelamento: chama adapter.cancelDelivery + atualiza registro + reabre Mapp
 *
 * O que NÃO faz:
 *  - Falar HTTP com Uber (responsabilidade do UberAdapter)
 *  - Validar HMAC de webhook (responsabilidade do WebhookDispatcher — Fase 1B.2)
 *  - Escrever em logistics_deliveries (Fase 2)
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
const { servicoMappToCanonicalQuoteRequest } = require('../adapters/uber/uber.parser');

// Status terminais em uber_entregas (não devem ser re-despachados)
const STATUS_TERMINAL = ['cancelado', 'canceled', 'delivered', 'fallback_fila'];

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
   * @returns {Promise<Object|null>} registro de uber_entregas criado, ou null se OS já estava ativa
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
      `SELECT id, status_uber FROM uber_entregas
       WHERE codigo_os = $1 AND status_uber NOT IN ('cancelado','canceled','delivered','fallback_fila')`,
      [codigoOS]
    );
    if (existente.length > 0) {
      console.log(`⚠️ [Orchestrator] OS ${codigoOS} já tem entrega ativa (id=${existente[0].id}, status=${existente[0].status_uber})`);
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

    // 3. Inserir registro inicial em uber_entregas (status: aguardando_cotacao)
    const coleta = enderecos[0];
    const entrega = enderecos[enderecos.length - 1];
    const { rows: [registro] } = await this.pool.query(`
      INSERT INTO uber_entregas (
        codigo_os, status_uber, valor_servico, valor_profissional,
        endereco_coleta, endereco_entrega,
        latitude_coleta, longitude_coleta,
        latitude_entrega, longitude_entrega,
        obs, pontos, regra_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      codigoOS, 'aguardando_cotacao',
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

      await this.pool.query(`
        UPDATE uber_entregas
        SET uber_quote_id = $1, valor_uber = $2, eta_minutos = $3, status_uber = $4, updated_at = NOW()
        WHERE id = $5
      `, [quote.quoteId, quote.valor, quote.etaMinutos, 'cotacao_recebida', registro.id]);

      // 5. Criar delivery no provider
      const delivery = await adapter.createDelivery(quote, request);

      // 6. Atualiza com delivery_id + tracking_url
      await this.pool.query(`
        UPDATE uber_entregas
        SET uber_delivery_id = $1, status_uber = $2, tracking_url = $3, updated_at = NOW()
        WHERE id = $4
      `, [delivery.externalDeliveryId, 'enviado_uber', delivery.trackingUrl || null, registro.id]);

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

      return {
        ...registro,
        uber_delivery_id: delivery.externalDeliveryId,
        tracking_url: delivery.trackingUrl,
        cotacao: quote,
      };

    } catch (erro) {
      console.error(`❌ [Orchestrator] Erro ao despachar OS ${codigoOS}:`, erro.message);

      await this.pool.query(`
        UPDATE uber_entregas
        SET status_uber = $1, erro_ultimo = $2, tentativas = tentativas + 1, updated_at = NOW()
        WHERE id = $3
      `, ['erro', erro.message, registro.id]);

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

  // ════════════════════════════════════════════════════════════
  // CANCEL — cancela entrega ativa
  // ════════════════════════════════════════════════════════════

  /**
   * Cancela uma entrega ativa.
   *
   * @param {number} entregaId - id em uber_entregas
   * @param {Object} opts
   * @param {string} [opts.motivo='Cancelado pelo operador']
   * @param {string} [opts.canceladoPor='operador']
   * @param {boolean} [opts.reabrirMapp=true] - se true, libera OS pra fila Mapp
   */
  async cancel(entregaId, opts = {}) {
    const motivo = opts.motivo || 'Cancelado pelo operador';
    const canceladoPor = opts.canceladoPor || 'operador';
    const reabrirMapp = opts.reabrirMapp !== false;

    const { rows } = await this.pool.query('SELECT * FROM uber_entregas WHERE id = $1', [entregaId]);
    if (rows.length === 0) {
      throw new Error(`Entrega id=${entregaId} não encontrada`);
    }
    const entrega = rows[0];

    if (STATUS_TERMINAL.includes(entrega.status_uber)) {
      throw new Error(`Entrega já está em estado terminal: ${entrega.status_uber}`);
    }

    // Cancela no provider (se já foi enviada)
    if (entrega.uber_delivery_id) {
      const providerCode = 'uber'; // Fase 1: hardcoded; Fase 2+ ler de entrega.provider_code
      const adapter = this._getAdapterOrThrow(providerCode);
      try {
        await adapter.cancelDelivery(entrega.uber_delivery_id);
      } catch (err) {
        console.warn(`⚠️ [Orchestrator] Cancelamento no provider falhou (seguindo):`, err.message);
      }
    }

    // Atualiza registro
    await this.pool.query(`
      UPDATE uber_entregas
      SET status_uber = 'cancelado',
          cancelado_por = $1,
          cancelado_motivo = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [canceladoPor, motivo, entregaId]);

    // Reabre Mapp se solicitado
    if (reabrirMapp) {
      await this.mapp.alterarStatus(entrega.codigo_os, 0).catch(e =>
        console.error(`⚠️ [Orchestrator] Falha ao reabrir OS ${entrega.codigo_os} na Mapp:`, e.message)
      );
    }

    this.events.log({
      providerCode: 'uber',
      eventType: EventType.CANCELED,
      eventSource: opts.eventSource || EventSource.ADMIN,
      codigoOS: entrega.codigo_os,
      deliveryId: entregaId,
      externalDeliveryId: entrega.uber_delivery_id,
      payload: { motivo, cancelado_por: canceladoPor, reabriu_mapp: reabrirMapp },
    });

    return { ok: true, entregaId };
  }

  // ════════════════════════════════════════════════════════════
  // DECISION HELPER — pipeline completo a partir de um codigoOS
  // ════════════════════════════════════════════════════════════

  /**
   * Pipeline completo orientado por codigoOS:
   *  1. Busca servico Mapp
   *  2. Casa regra via DispatchRuleMatcher
   *  3. Valida margem (R$ + %)
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
    const providerCode = regra.providers_preferidos?.[0] || 'uber';
    const vehicleType = regra.vehicle_type_preferido || null;

    // 2. Validação de margem (se a regra exige)
    const exigeMargemAbs = regra.margem_minima_aceita != null;
    const exigeMargemPct = regra.margem_pct_minima != null;
    let quoteReuso = null;

    if (exigeMargemAbs || exigeMargemPct) {
      let cotResult;
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

      const margemAbsMin = parseFloat(regra.margem_minima_aceita);
      const margemPctMin = parseFloat(regra.margem_pct_minima);

      if (exigeMargemAbs && cotResult.margem < margemAbsMin) {
        console.log(`💸 [Orchestrator] OS ${codigoOS} REJEITADA margem abs (R$${cotResult.margem.toFixed(2)} < ${margemAbsMin})`);
        this.events.log({
          providerCode,
          eventType: EventType.DISPATCH_REJECTED_BY_MARGIN,
          eventSource,
          codigoOS,
          payload: { tipo: 'absoluta', valor: cotResult.margem, minimo: margemAbsMin },
        });
        return { decision: 'rejeitado_margem_absoluta', regra, margem: cotResult.margem };
      }
      if (exigeMargemPct && cotResult.margem_pct < margemPctMin) {
        console.log(`💸 [Orchestrator] OS ${codigoOS} REJEITADA margem pct (${cotResult.margem_pct.toFixed(1)}% < ${margemPctMin}%)`);
        this.events.log({
          providerCode,
          eventType: EventType.DISPATCH_REJECTED_BY_MARGIN,
          eventSource,
          codigoOS,
          payload: { tipo: 'percentual', valor: cotResult.margem_pct, minimo: margemPctMin },
        });
        return { decision: 'rejeitado_margem_percentual', regra, margem_pct: cotResult.margem_pct };
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

    return { decision: 'despachado', regra, registro };
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
    // Lê timeout da config (logistics_providers primeiro, fallback uber_config)
    let timeoutMin = 10;
    try {
      const { rows } = await this.pool.query(`
        SELECT (config->>'timeout_sem_entregador_min')::int AS t
        FROM logistics_providers WHERE provider_code = 'uber'
      `);
      if (rows[0]?.t) timeoutMin = rows[0].t;
    } catch (e) {
      try {
        const { rows } = await this.pool.query(`SELECT timeout_sem_entregador_min FROM uber_config WHERE id=1`);
        timeoutMin = rows[0]?.timeout_sem_entregador_min || 10;
      } catch (e2) {/* default 10 */}
    }

    const { rows: presas } = await this.pool.query(`
      SELECT id, codigo_os, uber_delivery_id, EXTRACT(EPOCH FROM (NOW() - updated_at))/60 AS idade_min
      FROM uber_entregas
      WHERE status_uber = 'enviado_uber'
        AND uber_delivery_id IS NOT NULL
        AND updated_at < NOW() - ($1 || ' minutes')::interval
    `, [timeoutMin]);

    if (presas.length === 0) return 0;

    let promovidas = 0;
    for (const e of presas) {
      try {
        // Cancela no provider (best effort)
        const adapter = this.registry.get('uber');
        if (adapter && e.uber_delivery_id) {
          await adapter.cancelDelivery(e.uber_delivery_id).catch(() => {});
        }

        // Marca como fallback_fila
        await this.pool.query(`
          UPDATE uber_entregas
          SET status_uber = 'fallback_fila',
              cancelado_motivo = $1,
              updated_at = NOW()
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
