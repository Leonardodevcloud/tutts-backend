/**
 * NINETYNINE ADAPTER — Error Classifier (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 — antes este classificador olhava o formato da "99 Corp
 * API" (`{ errors: [...] }`). A 99Entrega encapsula TUDO em:
 *
 *     { errno, errmsg, data }
 *
 *   - errno === 0  → sucesso
 *   - errno !== 0  → erro; `errmsg` traz a descrição humana
 *
 * Classifica erros da 99Entrega em categorias acionáveis pro Orchestrator
 * decidir retry/fallback/desistir. Mesmo contrato do uber.errors.js.
 *
 * Categorias (iguais ao uber.errors pra o Orchestrator tratar uniforme):
 *   'coverage'    — 99 não cobre / sem entregador (não adianta retry)
 *   'auth'        — OAuth token inválido / client_id-secret errados
 *   'rate_limit'  — muitas requisições (retry com backoff)
 *   'transient'   — erro de rede/5xx (retry 1x)
 *   'validation'  — payload inválido (bug nosso, não-retriable)
 *   'expired'     — estimate_id expirado/já usado (re-cotar)
 *   'unknown'     — desconhecido
 *
 * NOTA: a doc pública da 99Entrega não tabela todos os valores de `errno`.
 * A classificação é feita por: (1) errno conhecido, (2) palavra-chave na
 * errmsg, (3) HTTP status. Conforme novos errno aparecerem no sandbox,
 * adicione-os em ERRNO_MAP.
 */

/**
 * Códigos `errno` conhecidos da 99Entrega → categoria.
 * Lista enxuta — cresce conforme os erros aparecem no sandbox/produção.
 */
const ERRNO_MAP = Object.freeze({
  // (preencher com errno reais conforme observados no sandbox da 99)
});

/**
 * Heurística por palavra-chave na errmsg. A 99Entrega devolve errmsg humana;
 * quando não temos o errno tabelado, inferimos pela mensagem.
 * Ordem importa — a primeira que casar vence.
 */
const ERRMSG_KEYWORDS = Object.freeze([
  { re: /(no\s*(driver|courier)|sem\s*entregador|unavailable|not\s*cover|out\s*of\s*(service|range)|fora\s*de\s*(área|cobertura))/i, category: 'coverage' },
  { re: /(unauthorized|invalid\s*(token|client)|forbidden|access\s*denied|credential)/i, category: 'auth' },
  { re: /(rate\s*limit|too\s*many|limite\s*de\s*requisi)/i, category: 'rate_limit' },
  { re: /(estimate.*(expired|invalid|used|not\s*found)|cotação.*(expir|inváli))/i, category: 'expired' },
  { re: /(invalid|required|missing|malformed|inváli|obrigat|formato)/i, category: 'validation' },
]);

/**
 * Classifica um erro da 99Entrega.
 *
 * @param {Object} resp - objeto do httpRequest (.status, .ok, .json())
 * @param {Object} [bodyData] - data já parseado (envelope { errno, errmsg, data })
 * @returns {{ category: string, code: string, message: string, retriable: boolean, httpStatus: number }}
 */
function classify99Error(resp, bodyData = null) {
  const json = bodyData || (typeof resp?.json === 'function' ? resp.json() : null) || {};
  const httpStatus = resp?.status || 0;

  // Envelope 99Entrega: { errno, errmsg, data }
  const errno = json.errno != null ? json.errno : null;
  const errmsg = json.errmsg || json.error_description || json.error
    || json.message || JSON.stringify(json).slice(0, 200);
  const code = errno != null ? String(errno) : '';

  let category = (errno != null && ERRNO_MAP[errno]) || null;

  // 2. Heurística por palavra-chave na errmsg
  if (!category && errmsg) {
    for (const { re, category: cat } of ERRMSG_KEYWORDS) {
      if (re.test(errmsg)) { category = cat; break; }
    }
  }

  // 3. Fallback por HTTP status
  if (!category) {
    if (httpStatus === 401 || httpStatus === 403) category = 'auth';
    else if (httpStatus === 429) category = 'rate_limit';
    else if (httpStatus === 404) category = 'coverage'; // pedido/rota não encontrada
    else if (httpStatus >= 500 && httpStatus < 600) category = 'transient';
    else if (httpStatus >= 400 && httpStatus < 500) category = 'validation';
    else if (httpStatus === 0) category = 'transient'; // rede/timeout
    else category = 'unknown';
  }

  const retriable = ['auth', 'rate_limit', 'transient', 'expired'].includes(category);

  return { category, code, message: errmsg, retriable, httpStatus };
}

module.exports = {
  ERRNO_MAP,
  ERRMSG_KEYWORDS,
  classify99Error,
};
