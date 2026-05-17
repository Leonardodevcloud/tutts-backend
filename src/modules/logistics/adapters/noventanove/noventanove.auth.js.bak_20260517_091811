/**
 * NINETYNINE ADAPTER — Auth
 *
 * A 99 Corp API usa autenticação simples: header `x-api-key` estático.
 * NÃO tem OAuth, NÃO tem token que expira, NÃO precisa de company-id no header
 * (a v2 resolve a empresa pelo próprio token).
 *
 * Doc: https://github.com/99Taxis/corp-api-v2-documentation#autenticação
 *
 * Por isso este módulo é bem mais simples que o uber.auth.js — não há cache
 * de token, não há renovação. Só monta os headers e a base URL.
 *
 * Base URLs:
 *  - Produção: https://api-corp.99app.com/v2
 *  - Sandbox:  https://sandbox-api-corp.99app.com/v1   (ATENÇÃO: sandbox é v1)
 */

const BASE_URL_PRODUCAO = 'https://api-corp.99app.com/v2';
const BASE_URL_SANDBOX = 'https://sandbox-api-corp.99app.com/v1';

/**
 * Retorna a base URL conforme o modo (sandbox ou produção).
 *
 * @param {boolean} sandboxMode
 * @returns {string}
 */
function getBaseUrl(sandboxMode) {
  return sandboxMode ? BASE_URL_SANDBOX : BASE_URL_PRODUCAO;
}

/**
 * Monta os headers de autenticação pra uma request à 99 Corp API.
 *
 * @param {Object} config - logistics_providers.config do provider 'noventanove'
 * @param {string} config.api_key - a x-api-key da conta 99
 * @param {Object} [extras] - headers adicionais (ex: Content-Type)
 * @returns {Object} headers prontos pro httpRequest
 */
function montarHeaders(config, extras = {}) {
  if (!config || !config.api_key) {
    throw new Error('NinetyNineAdapter: api_key não configurada em logistics_providers.config');
  }
  return {
    'x-api-key': config.api_key,
    ...extras,
  };
}

/**
 * Validação rápida de que a config tem o mínimo pra operar.
 * Lança erro descritivo se faltar algo — melhor falhar cedo com mensagem clara
 * do que dar 401 genérico lá na frente.
 *
 * @param {Object} config
 * @param {Object} [opts]
 * @param {boolean} [opts.exigirEmployee=true] - createQuote/createDelivery precisam
 * @param {boolean} [opts.exigirCostCenter=true] - createDelivery precisa
 */
function validarConfig(config, opts = {}) {
  const { exigirEmployee = true, exigirCostCenter = true } = opts;
  const faltando = [];

  if (!config || !config.api_key) faltando.push('api_key');
  if (exigirEmployee && !config?.employee_id) faltando.push('employee_id');
  if (exigirCostCenter && !config?.cost_center_id) faltando.push('cost_center_id');

  if (faltando.length > 0) {
    throw new Error(
      `NinetyNineAdapter: config incompleta — faltando: ${faltando.join(', ')}. ` +
      `Rode os curls de descoberta (ver README-FASE-3) e preencha logistics_providers.config.`
    );
  }
}

module.exports = {
  getBaseUrl,
  montarHeaders,
  validarConfig,
  BASE_URL_PRODUCAO,
  BASE_URL_SANDBOX,
};
