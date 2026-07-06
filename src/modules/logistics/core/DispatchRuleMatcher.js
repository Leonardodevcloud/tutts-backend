/**
 * MÓDULO LOGISTICS — DispatchRuleMatcher
 *
 * Decide se uma OS deve ser despachada pra algum provider e qual regra casa.
 *
 * Substitui a função verificarRegras() que vivia em src/modules/uber/index.js
 * (linhas 267-344), generalizada pra falar em "regras de despacho" em vez de
 * "regras Uber". Comportamento idêntico ao legado quando há só uma regra
 * casando — diferença começa na Fase 4 quando entram estratégias multi-provider.
 *
 * COMO MATCHA UMA OS:
 *  1. Carrega regras ativas de logistics_dispatch_rules
 *  2. Para cada regra, tenta casar o ENDEREÇO DE COLETA com:
 *      - regra.cliente_identificador (≥4 chars, substring)
 *      - regra.trecho_endereco (≥5 chars, substring)
 *  3. Se casou, valida:
 *      - horário (horario_inicio/fim)
 *      - valor mínimo/máximo
 *      - regiões permitidas (substring em coleta OU entrega)
 *
 * RETORNO:
 *   { despachar: true, regra: {...}, motivo: 'ok' }
 *   { despachar: false, motivo: 'sem_regras_cadastradas' | 'endereco_coleta_vazio' |
 *     'nenhuma_regra_casou' | 'fora_horario' | 'valor_abaixo_minimo' |
 *     'valor_acima_maximo' | 'regiao' }
 *
 * IMPORTANTE: A regra retornada tem `providers_preferidos` como array.
 * Na Fase 1, o Orchestrator sempre usa providers_preferidos[0] (e na prática
 * todos eles vão ser ['uber'] porque foi assim que a Fase 0 backfillou).
 * Na Fase 4, o array vira ordenação de fallback ou input pra estratégia melhor_preço.
 */

/**
 * 2026-07: normaliza endereco pra comparacao ROBUSTA de regra de despacho.
 * Remove acentos, expande abreviacoes de logradouro (r.->rua, av.->avenida, etc),
 * troca pontuacao por espaco e colapsa espacos. Aplicado nos DOIS lados (endereco
 * da OS e trecho da regra) antes do .includes(), pra que
 * "r. jose carneiro,970 a" case com "RUA JOSE TAVARES CARNEIRO, 970 A".
 */
function normalizarEnderecoParaMatch(texto) {
  if (!texto) return '';
  let s = String(texto).toLowerCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos
  s = s                                                     // expande abreviacoes
    .replace(/\br\.?\s/g, 'rua ')
    .replace(/\bav\.?\s/g, 'avenida ')
    .replace(/\btv\.?\s/g, 'travessa ')
    .replace(/\bpc\.?\s/g, 'praca ')
    .replace(/\bpca\.?\s/g, 'praca ')
    .replace(/\bal\.?\s/g, 'alameda ')
    .replace(/\brod\.?\s/g, 'rodovia ')
    .replace(/\bestr\.?\s/g, 'estrada ');
  s = s.replace(/[.,;:\-\/()]+/g, ' ').replace(/\s+/g, ' ').trim(); // pontuacao -> espaco
  return s;
}

class DispatchRuleMatcher {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Tenta casar uma OS com uma regra de despacho.
   *
   * @param {Object} servico - Serviço da Mapp (com codigoOS, endereco[], valorServico, etc)
   * @returns {Promise<{despachar: boolean, motivo: string, regra?: Object}>}
   */
  async match(servico) {
    if (!servico || !servico.codigoOS) {
      return { despachar: false, motivo: 'servico_invalido' };
    }

    const regras = await this._carregarRegrasAtivas();

    if (regras.length === 0) {
      return { despachar: false, motivo: 'sem_regras_cadastradas' };
    }

    const enderecoColeta = normalizarEnderecoParaMatch(servico.endereco?.[0]?.rua || '');
    const enderecoEntrega = normalizarEnderecoParaMatch(servico.endereco?.[1]?.rua || '');

    if (!enderecoColeta) {
      return { despachar: false, motivo: 'endereco_coleta_vazio' };
    }

    // Match: trecho do endereço ou identificador alternativo aparecem como
    // substring no endereço de coleta. Comportamento idêntico ao legado.
    let regraCasada = null;
    for (const regra of regras) {
      const trechoEnd = normalizarEnderecoParaMatch(regra.trecho_endereco || regra.cliente_nome || '');
      const trechoIdent = normalizarEnderecoParaMatch(regra.cliente_identificador || '');

      if (trechoIdent && trechoIdent.length >= 4 && enderecoColeta.includes(trechoIdent)) {
        regraCasada = regra;
        break;
      }
      if (trechoEnd && trechoEnd.length >= 5 && enderecoColeta.includes(trechoEnd)) {
        regraCasada = regra;
        break;
      }
    }

    if (!regraCasada) {
      return { despachar: false, motivo: 'nenhuma_regra_casou' };
    }

    // Validar horário
    if (regraCasada.horario_inicio && regraCasada.horario_fim) {
      const agora = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false });
      const inicio = String(regraCasada.horario_inicio).slice(0, 5);
      const fim = String(regraCasada.horario_fim).slice(0, 5);
      if (agora < inicio || agora > fim) {
        console.log(`🕐 [DispatchRuleMatcher] OS ${servico.codigoOS} fora do horário ${inicio}-${fim}`);
        return { despachar: false, motivo: 'fora_horario', regra: regraCasada };
      }
    }

    // Validar valor
    const valorServico = parseFloat(servico.valorServico) || 0;
    if (regraCasada.valor_minimo && valorServico < parseFloat(regraCasada.valor_minimo)) {
      return { despachar: false, motivo: 'valor_abaixo_minimo', regra: regraCasada };
    }
    if (regraCasada.valor_maximo && valorServico > parseFloat(regraCasada.valor_maximo)) {
      return { despachar: false, motivo: 'valor_acima_maximo', regra: regraCasada };
    }

    // Validar região (se definida)
    if (Array.isArray(regraCasada.regioes_permitidas) && regraCasada.regioes_permitidas.length > 0) {
      const casouRegiao = regraCasada.regioes_permitidas.some(reg => {
        const r = normalizarEnderecoParaMatch(reg || '');
        if (!r) return false;
        return enderecoColeta.includes(r) || enderecoEntrega.includes(r);
      });
      if (!casouRegiao) {
        console.log(`🗺️ [DispatchRuleMatcher] OS ${servico.codigoOS} fora das regiões da regra "${regraCasada.cliente_nome}"`);
        return { despachar: false, motivo: 'regiao', regra: regraCasada };
      }
    }

    console.log(`✅ [DispatchRuleMatcher] OS ${servico.codigoOS} casou com "${regraCasada.cliente_nome}" (id=${regraCasada.id}, providers=[${(regraCasada.providers_preferidos || []).join(',')}])`);
    return { despachar: true, motivo: 'ok', regra: regraCasada };
  }

  /**
   * Carrega regras ativas de logistics_dispatch_rules com fallback duplo.
   *
   * Estratégia (durante migração):
   *  1. Tenta logistics_dispatch_rules — fonte canônica
   *  2. Se a tabela retorna 0 (não deveria, mas defensivo), fallback uber_regras_cliente
   *     com providers_preferidos = ['uber'] sintetizado em runtime
   *
   * @returns {Promise<Object[]>}
   */
  async _carregarRegrasAtivas() {
    try {
      const { rows } = await this.pool.query(`
        SELECT * FROM logistics_dispatch_rules
        WHERE ativo = true
        ORDER BY id ASC
      `);
      if (rows.length > 0) return rows;
    } catch (err) {
      console.warn('[DispatchRuleMatcher] logistics_dispatch_rules indisponível:', err.message);
    }

    // Fallback: uber_regras_cliente (legado). Sintetiza providers_preferidos=['uber']
    // pra que o Orchestrator continue funcionando independente da fonte.
    try {
      const { rows } = await this.pool.query(`
        SELECT * FROM _legacy_uber_regras_cliente
        WHERE ativo = true AND usar_uber = true
        ORDER BY id ASC
      `);
      return rows.map(r => ({
        ...r,
        providers_preferidos: ['uber'],
        estrategia: 'provider_unico',
      }));
    } catch (err) {
      console.error('[DispatchRuleMatcher] erro ao carregar regras legacy:', err.message);
      return [];
    }
  }
}

// ════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════
let _instance = null;

function getDispatchRuleMatcher(pool) {
  if (!_instance) {
    if (!pool) throw new Error('DispatchRuleMatcher: pool obrigatório na primeira chamada');
    _instance = new DispatchRuleMatcher(pool);
  }
  return _instance;
}

module.exports = { DispatchRuleMatcher, getDispatchRuleMatcher };
