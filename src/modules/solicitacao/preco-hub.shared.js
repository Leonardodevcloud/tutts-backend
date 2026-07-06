'use strict';

/**
 * preco-hub.shared.js  (2026-07)
 * ---------------------------------------------------------------------------
 * Fonte UNICA da precificacao por distancia do Hub Logistico.
 *
 * Mesma formula usada no dispatch (DispatchOrchestrator.calcularPrecoDistancia):
 *
 *     valor = valor_fixo + max(0, km - km_base) * valor_km_adicional
 *
 * A tabela de preco agora tambem pode viver POR CLIENTE, na coluna JSONB
 * clientes_solicitacao.preco_hub, no formato:
 *
 *     { "ativo": true, "valor_fixo": 11.90, "km_base": 2.0, "valor_km_adicional": 1.90 }
 *
 * Precedencia (decisao 2026-07): CLIENTE sempre manda. Se o cliente tem tabela
 * propria ATIVA, ela e usada e ignora regra/global. Sem tabela ativa, cai no
 * valor gravado no dispatch (valor_servico).
 * ---------------------------------------------------------------------------
 */

/**
 * Normaliza o JSONB preco_hub do cliente para o shape interno.
 * @param {object|string|null} precoHub - conteudo de clientes_solicitacao.preco_hub
 * @returns {{valorFixo:number, kmBase:number, valorKmAdicional:number}|null}
 */
function normalizarTabelaCliente(precoHub) {
  if (!precoHub) return null;
  let obj = precoHub;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (_e) { return null; }
  }
  if (typeof obj !== 'object') return null;
  if (obj.ativo === false) return null;
  const vf = Number(obj.valor_fixo);
  if (!Number.isFinite(vf)) return null;
  return {
    valorFixo: vf,
    kmBase: Number.isFinite(Number(obj.km_base)) ? Number(obj.km_base) : 0,
    valorKmAdicional: Number.isFinite(Number(obj.valor_km_adicional)) ? Number(obj.valor_km_adicional) : 0,
  };
}

/**
 * Calcula o valor por distancia. Identica ao dispatch.
 * @param {number} distKm
 * @param {{valorFixo:number, kmBase:number, valorKmAdicional:number}|null} tabela
 * @returns {number|null} valor em R$ (2 casas) ou null se sem tabela/distancia
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

/**
 * Resolve o valor de UMA corrida on-read (para relatorio).
 * CLIENTE sempre manda: se ha tabela do cliente ATIVA e distancia valida,
 * recalcula. Senao, usa o valor gravado no dispatch.
 * @param {object} args
 * @param {number|null} args.distanciaKm
 * @param {object|string|null} args.precoHub - clientes_solicitacao.preco_hub
 * @param {number|null} args.valorGravado - logistics_deliveries.valor_servico
 * @returns {{valor:number|null, origem:'cliente'|'gravado'|'indefinido'}}
 */
function resolverValorCorrida({ distanciaKm, precoHub, valorGravado }) {
  const tab = normalizarTabelaCliente(precoHub);
  if (tab) {
    const v = calcularPrecoDistancia(distanciaKm, tab);
    if (v != null) return { valor: v, origem: 'cliente' };
  }
  if (valorGravado != null && Number.isFinite(Number(valorGravado))) {
    return { valor: Math.round(Number(valorGravado) * 100) / 100, origem: 'gravado' };
  }
  return { valor: null, origem: 'indefinido' };
}

/**
 * Classifica o canal da corrida em binario: 'tutts' (frota propria) ou 'hub'
 * (marketplace 99/Uber). Qualquer provider que nao seja 'tutts'/vazio = hub.
 * @param {string|null} provider - provider_usado / provider_code
 * @returns {'tutts'|'hub'}
 */
function classificarCanal(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === '' || p === 'tutts') return 'tutts';
  return 'hub';
}

/**
 * Extrai um numero de km de uma string livre (ex: "5,4 km", "5.4", "5400 m").
 * @param {string|number|null} v
 * @returns {number|null}
 */
function parseKm(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  const ehMetros = /\bm\b/.test(s) && !/km/.test(s);
  const m = s.match(/-?[\d.,]+/);
  if (!m) return null;
  let num = m[0];
  // Com virgula -> formato pt-BR: ponto e milhar, virgula e decimal.
  // So com ponto -> ponto e decimal (km quase nunca usa milhar).
  if (num.includes(',')) num = num.replace(/\./g, '').replace(',', '.');
  let n = parseFloat(num);
  if (!Number.isFinite(n)) return null;
  if (ehMetros) n = n / 1000;
  return Math.round(n * 100) / 100;
}

/** Formata numero como R$ pt-BR (string). Aceita null. */
function formatarBRL(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Escapa um campo para CSV (RFC 4180). */
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Monta um CSV a partir de headers + linhas.
 * @param {string[]} headers
 * @param {Array<Array<any>>} linhas
 * @returns {string} CSV com separador ';' (compativel com Excel pt-BR) + BOM
 */
function montarCSV(headers, linhas) {
  const sep = ';';
  const head = headers.map(csvEscape).join(sep);
  const body = (linhas || []).map(row => row.map(csvEscape).join(sep)).join('\n');
  // BOM UTF-8 pra Excel abrir acentos corretamente
  return '\uFEFF' + head + '\n' + body + '\n';
}

module.exports = {
  normalizarTabelaCliente,
  calcularPrecoDistancia,
  resolverValorCorrida,
  classificarCanal,
  parseKm,
  formatarBRL,
  montarCSV,
};
