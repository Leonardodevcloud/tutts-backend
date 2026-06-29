/**
 * MÓDULO LOGISTICS — StrategySelector
 *
 * Decide QUAL provider usar pra despachar uma OS, conforme a `estrategia` da
 * regra de despacho casada. É o cérebro multi-provider do hub.
 *
 * Até a Fase 3, o Orchestrator pegava sempre `providers_preferidos[0]` — ou
 * seja, o hub era de fato single-provider mesmo tendo 2 adapters. A Fase 4
 * troca essa linha fixa por este seletor.
 *
 * As 4 estratégias (campo logistics_dispatch_rules.estrategia):
 *
 *  'provider_unico'  — usa providers_preferidos[0]. Sem cotação comparativa.
 *                      É o comportamento das Fases 1-3. Com 1 provider na
 *                      lista, as outras estratégias colapsam nisto também.
 *
 *  'melhor_preco'    — cota em TODOS os providers_preferidos, escolhe o de
 *                      menor valor_provider. Empate → menor ETA → ordem da lista.
 *
 *  'melhor_eta'      — cota em todos, escolhe o de menor ETA. Empate → menor
 *                      preço → ordem da lista.
 *
 *  'fallback'        — tenta despachar no providers_preferidos[0]; se falhar
 *                      (erro de cobertura/cotação), tenta o [1], e assim por
 *                      diante. NÃO cota todos antecipadamente — é sequencial.
 *
 * IMPORTANTE: este módulo NÃO despacha. Ele só DECIDE. Quem despacha é o
 * Orchestrator. Pra 'melhor_preco'/'melhor_eta', o selector cota (via
 * Orchestrator.quote) e retorna o vencedor + a cotação já feita (pra reuso).
 * Pra 'fallback', retorna a lista ordenada e o Orchestrator tenta em ordem.
 *
 * Degradação graciosa: com providers_preferidos de 1 elemento só, ou com
 * só 1 adapter ativo, toda estratégia vira efetivamente 'provider_unico'.
 * Isso é proposital — o hub funciona com 1 ou N providers sem código especial.
 */

const ESTRATEGIAS = Object.freeze(['provider_unico', 'melhor_preco', 'melhor_eta', 'fallback']);

class StrategySelector {
  /**
   * @param {Object} deps
   * @param {import('./DispatchOrchestrator').DispatchOrchestrator} deps.orchestrator
   * @param {import('./ProviderRegistry').ProviderRegistry} deps.registry
   * @param {import('./EventLogger').EventLogger} deps.events
   */
  constructor(deps) {
    this.orchestrator = deps.orchestrator;
    this.registry = deps.registry;
    this.events = deps.events;
  }

  /**
   * Filtra a lista de providers_preferidos da regra, mantendo só os que
   * estão ativos no ProviderRegistry. Preserva a ordem original.
   *
   * @param {string[]} providersPreferidos
   * @returns {string[]} subconjunto ativo, na ordem original
   */
  _filtrarAtivos(providersPreferidos) {
    if (!Array.isArray(providersPreferidos) || providersPreferidos.length === 0) {
      // Sem lista → tenta 'uber' como default histórico (Fases 1-3)
      return this.registry.has('uber') ? ['uber'] : [];
    }
    return providersPreferidos.filter(code => this.registry.has(code));
  }

  /**
   * Decide o provider pra uma OS conforme a estratégia da regra.
   *
   * Retorna um objeto "decisão" que o Orchestrator consome:
   *  - { tipo: 'direto', providerCode, vehicleType, quoteReuso? }
   *      → despacha nesse provider. quoteReuso presente em melhor_preco/eta.
   *  - { tipo: 'fallback_chain', chain: [providerCode...], vehicleType }
   *      → tenta em ordem até um aceitar.
   *  - { tipo: 'erro', motivo }
   *      → nenhum provider viável.
   *
   * @param {Object} servico - serviço Mapp já buscado
   * @param {Object} regra - regra casada (tem estrategia, providers_preferidos, vehicle_type_preferido)
   * @param {Object} [opts]
   * @param {string} [opts.eventSource]
   * @returns {Promise<Object>} decisão
   */
  async decidir(servico, regra, opts = {}) {
    const codigoOS = servico.codigoOS;
    const eventSource = opts.eventSource || 'worker';
    const vehicleType = regra.vehicle_type_preferido || null;

    // 🆕 2026-06: OVERRIDE DE TESTE — força um provider no despacho AUTOMÁTICO.
    // Setar LOGISTICS_FORCE_PROVIDER=noventanove (no Railway) faz TODO despacho
    // automático ir pra 99, ignorando a regra/estratégia, mesmo com a Uber ativa.
    // O despacho MANUAL (painel) não passa por aqui — testes na Uber seguem normais.
    // Para voltar ao normal, basta remover/limpar a env var.
    const forcado = String(process.env.LOGISTICS_FORCE_PROVIDER || '').trim().toLowerCase();
    if (forcado) {
      if (this.registry.has(forcado)) {
        console.log(`🔒 [StrategySelector] OS ${codigoOS}: LOGISTICS_FORCE_PROVIDER=${forcado} — forçando provider no automático (ignora regra/estratégia)`);
        this.events.log({
          providerCode: forcado,
          eventType: 'strategy_forced',
          eventSource,
          codigoOS,
          payload: { motivo: 'LOGISTICS_FORCE_PROVIDER', provider_forcado: forcado, regra_id: regra.id },
        }).catch(() => {});
        return { tipo: 'direto', providerCode: forcado, vehicleType };
      }
      console.warn(`⚠️ [StrategySelector] LOGISTICS_FORCE_PROVIDER=${forcado} mas esse provider não está ativo no registry — ignorando override`);
    }

    let estrategia = String(regra.estrategia || 'provider_unico').toLowerCase();
    if (!ESTRATEGIAS.includes(estrategia)) {
      console.warn(`[StrategySelector] estratégia desconhecida "${estrategia}" — usando provider_unico`);
      estrategia = 'provider_unico';
    }

    const ativos = this._filtrarAtivos(regra.providers_preferidos);

    if (ativos.length === 0) {
      return {
        tipo: 'erro',
        motivo: 'nenhum_provider_ativo',
        detalhe: `Regra ${regra.id} tem providers_preferidos=[${(regra.providers_preferidos || []).join(',')}] mas nenhum está ativo no registry`,
      };
    }

    // Degradação graciosa: 1 provider só → provider_unico, seja qual for a estratégia
    if (ativos.length === 1 && estrategia !== 'fallback') {
      if (estrategia !== 'provider_unico') {
        console.log(`[StrategySelector] OS ${codigoOS}: estratégia "${estrategia}" com 1 provider ativo → colapsa em provider_unico (${ativos[0]})`);
      }
      return { tipo: 'direto', providerCode: ativos[0], vehicleType };
    }

    // ─── provider_unico ───
    if (estrategia === 'provider_unico') {
      return { tipo: 'direto', providerCode: ativos[0], vehicleType };
    }

    // ─── fallback ───
    if (estrategia === 'fallback') {
      return { tipo: 'fallback_chain', chain: ativos, vehicleType };
    }

    // ─── melhor_preco / melhor_eta ───
    // Cota em todos os providers ativos, em paralelo, e escolhe o vencedor.
    return await this._decidirPorCotacao(servico, regra, ativos, estrategia, vehicleType, eventSource);
  }

  /**
   * Cota em todos os providers ativos e escolhe o vencedor conforme o critério.
   * @private
   */
  async _decidirPorCotacao(servico, regra, ativos, estrategia, vehicleType, eventSource) {
    const codigoOS = servico.codigoOS;

    console.log(`🔀 [StrategySelector] OS ${codigoOS}: estratégia "${estrategia}", cotando em [${ativos.join(', ')}]...`);

    // Cota em paralelo. Cada cotação pode falhar individualmente.
    const promessas = ativos.map(providerCode =>
      this.orchestrator.quote(codigoOS, {
        providerCode,
        vehicleType,
        servicoMapp: servico,
        eventSource,
      })
        .then(resultado => ({ providerCode, ok: true, resultado }))
        .catch(err => ({ providerCode, ok: false, erro: err.message, categoria: err.category }))
    );

    const cotacoes = await Promise.all(promessas);
    const sucesso = cotacoes.filter(c => c.ok);
    const falhas = cotacoes.filter(c => !c.ok);

    if (falhas.length > 0) {
      console.log(`⚠️ [StrategySelector] OS ${codigoOS}: ${falhas.length} cotação(ões) falharam: ${falhas.map(f => `${f.providerCode}(${f.categoria || 'erro'})`).join(', ')}`);
    }

    if (sucesso.length === 0) {
      return {
        tipo: 'erro',
        motivo: 'todas_cotacoes_falharam',
        detalhe: falhas.map(f => `${f.providerCode}: ${f.erro}`).join('; '),
      };
    }

    // Ordena os que deram certo conforme o critério
    const criterio = estrategia === 'melhor_preco' ? 'preco' : 'eta';
    sucesso.sort((a, b) => this._comparar(a.resultado, b.resultado, criterio, ativos));

    const vencedor = sucesso[0];
    const cotV = vencedor.resultado;

    // Log da decisão comparativa
    const comparativo = sucesso.map(s => ({
      provider: s.providerCode,
      valor: s.resultado.valor_provider,
      eta: s.resultado.cotacao.etaMinutos,
    }));
    console.log(`🏆 [StrategySelector] OS ${codigoOS}: vencedor "${vencedor.providerCode}" (${criterio}) — comparativo:`, JSON.stringify(comparativo));

    this.events.log({
      providerCode: vencedor.providerCode,
      eventType: 'strategy_decided',
      eventSource,
      codigoOS,
      payload: {
        estrategia,
        criterio,
        vencedor: vencedor.providerCode,
        comparativo,
        cotacoes_falhas: falhas.map(f => ({ provider: f.providerCode, categoria: f.categoria })),
      },
    }).catch(() => {});

    return {
      tipo: 'direto',
      providerCode: vencedor.providerCode,
      vehicleType,
      // quoteReuso: a cotação já foi feita, o Orchestrator não precisa cotar de novo
      quoteReuso: { quote: cotV.cotacao, request: cotV.request },
      // metadados pra auditoria
      _comparativo: comparativo,
      _estrategia: estrategia,
    };
  }

  /**
   * Comparador pra ordenação. Retorna <0 se A vence, >0 se B vence.
   * @private
   */
  _comparar(a, b, criterio, ordemLista) {
    if (criterio === 'preco') {
      const dp = (a.valor_provider ?? Infinity) - (b.valor_provider ?? Infinity);
      if (dp !== 0) return dp;
      // empate de preço → menor ETA
      const de = (a.cotacao.etaMinutos ?? Infinity) - (b.cotacao.etaMinutos ?? Infinity);
      if (de !== 0) return de;
    } else {
      // criterio === 'eta'
      const de = (a.cotacao.etaMinutos ?? Infinity) - (b.cotacao.etaMinutos ?? Infinity);
      if (de !== 0) return de;
      // empate de ETA → menor preço
      const dp = (a.valor_provider ?? Infinity) - (b.valor_provider ?? Infinity);
      if (dp !== 0) return dp;
    }
    // empate total → ordem da lista providers_preferidos
    const ia = ordemLista.indexOf(a.cotacao.providerCode);
    const ib = ordemLista.indexOf(b.cotacao.providerCode);
    return ia - ib;
  }
}

module.exports = { StrategySelector, ESTRATEGIAS };
