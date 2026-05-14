/**
 * UBER ADAPTER — Error Classifier
 *
 * Classifica erros vindos da Uber Direct API em categorias acionáveis,
 * pra que o Orchestrator decida sobre retry/fallback/desistir.
 *
 * Categorias:
 *   - 'coverage'    — Uber não cobre essa região/horário (não adianta retry)
 *   - 'auth'        — OAuth token inválido (retry após refresh)
 *   - 'rate_limit'  — Muitas requisições (retry com backoff)
 *   - 'transient'   — Erro de rede/5xx (retry imediato 1x)
 *   - 'validation'  — Payload inválido (não adianta retry, é bug nosso)
 *   - 'expired'     — Quote expirou (re-cotar)
 *   - 'unknown'     — Categoria desconhecida (loga e desiste)
 */

/**
 * Códigos de erro conhecidos da Uber Direct mapeados pra categoria.
 * Lista construída empiricamente — adicionar conforme aparecerem novos.
 */
const ERROR_CODE_MAP = Object.freeze({
  // Cobertura
  'no_couriers_available':        'coverage',
  'address_undeliverable':        'coverage',
  'pickup_dropoff_too_far':       'coverage',
  'outside_service_hours':        'coverage',
  'address_outside_service_area': 'coverage',

  // Auth
  'unauthorized':                 'auth',
  'invalid_token':                'auth',
  'forbidden':                    'auth',

  // Rate limit
  'rate_limited':                 'rate_limit',

  // Validation (não é retriable)
  'validation_failed':            'validation',
  'invalid_params':               'validation',
  'invalid_address':              'validation',
  'invalid_phone_number':         'validation',
  'manifest_required':            'validation',

  // Quote
  'quote_expired':                'expired',
  'invalid_quote':                'expired',
});

/**
 * Classifica erro Uber a partir do payload de resposta.
 *
 * Estratégia:
 *  1. Se vier `code` ou `kind` no body, consulta tabela
 *  2. Senão, infere por HTTP status
 *  3. Senão, 'unknown'
 *
 * @param {Object} resp - Objeto retornado por httpRequest (com .status, .ok, .json())
 * @param {Object} [bodyData] - data já parseado (se chamador já fez)
 * @returns {{ category: string, code: string, message: string, retriable: boolean }}
 */
function classifyUberError(resp, bodyData = null) {
  const data = bodyData || (typeof resp?.json === 'function' ? resp.json() : null) || {};
  const httpStatus = resp?.status || 0;

  // Tenta extrair código do erro do payload Uber Direct
  const code = String(data.code || data.kind || data.error || '').toLowerCase();
  const message = data.message || data.error_description || JSON.stringify(data).slice(0, 200);

  let category = ERROR_CODE_MAP[code] || null;

  // Fallback por HTTP status quando code não bate
  if (!category) {
    if (httpStatus === 401 || httpStatus === 403) category = 'auth';
    else if (httpStatus === 429) category = 'rate_limit';
    else if (httpStatus >= 500 && httpStatus < 600) category = 'transient';
    else if (httpStatus >= 400 && httpStatus < 500) category = 'validation';
    else category = 'unknown';
  }

  const retriable = ['auth', 'rate_limit', 'transient', 'expired'].includes(category);

  return { category, code, message, retriable, httpStatus };
}

module.exports = {
  ERROR_CODE_MAP,
  classifyUberError,
};
