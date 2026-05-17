/**
 * NINETYNINE ADAPTER — Error Classifier
 *
 * Classifica erros da 99 Corp API em categorias acionáveis pro Orchestrator
 * decidir retry/fallback/desistir. Mesmo contrato do uber.errors.js.
 *
 * A 99 retorna erros de validação com a estrutura:
 *   { errors: [ { code, field, message }, ... ] }   (ex: PUT /webhook 422)
 * E erros gerais com HTTP status. A doc não documenta todos os códigos de
 * erro de corrida, então a classificação é majoritariamente por HTTP status.
 *
 * Categorias (iguais ao uber.errors pra o Orchestrator tratar uniforme):
 *   'coverage'    — 99 não cobre / sem motorista (não adianta retry)
 *   'auth'        — x-api-key inválida (não-retriable — é config errada)
 *   'rate_limit'  — muitas requisições (retry com backoff)
 *   'transient'   — erro de rede/5xx (retry 1x)
 *   'validation'  — payload inválido (bug nosso, não-retriable)
 *   'unknown'     — desconhecido
 */

/**
 * Códigos de erro conhecidos da 99 → categoria.
 * Lista pequena — a doc da 99 documenta poucos códigos nominais
 * (a maioria dos erros de validação de webhook). Cresce conforme aparecem.
 */
const ERROR_CODE_MAP = Object.freeze({
  // Validação de webhook (PUT /webhook 422)
  'required-url':            'validation',
  'invalid-url':             'validation',
  'required-authentication': 'validation',
  'required-username':       'validation',
  'required-password':       'validation',
  'invalid-password':        'validation',
  'required-subscriptions':  'validation',
  'invalid-subscriptions':   'validation',
});

/**
 * Classifica um erro da 99.
 *
 * @param {Object} resp - objeto do httpRequest (com .status, .ok, .json())
 * @param {Object} [bodyData] - data já parseado
 * @returns {{ category, code, message, retriable, httpStatus }}
 */
function classify99Error(resp, bodyData = null) {
  const data = bodyData || (typeof resp?.json === 'function' ? resp.json() : null) || {};
  const httpStatus = resp?.status || 0;

  // A 99 retorna erros de validação em data.errors[] — pega o primeiro código
  let code = '';
  let message = '';
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    code = String(data.errors[0].code || '').toLowerCase();
    message = data.errors.map(e => e.message).filter(Boolean).join('; ');
  } else {
    code = String(data.code || data.error || '').toLowerCase();
    message = data.message || data.error_description || data.error
      || JSON.stringify(data).slice(0, 200);
  }

  let category = ERROR_CODE_MAP[code] || null;

  // Fallback por HTTP status
  if (!category) {
    if (httpStatus === 401 || httpStatus === 403) category = 'auth';
    else if (httpStatus === 429) category = 'rate_limit';
    else if (httpStatus === 422 || (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 404)) category = 'validation';
    else if (httpStatus === 404) category = 'coverage'; // ride não encontrada / sem cobertura
    else if (httpStatus >= 500 && httpStatus < 600) category = 'transient';
    else category = 'unknown';
  }

  const retriable = ['rate_limit', 'transient'].includes(category);

  return { category, code, message, retriable, httpStatus };
}

module.exports = {
  ERROR_CODE_MAP,
  classify99Error,
};
