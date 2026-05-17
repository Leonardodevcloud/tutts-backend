/**
 * NINETYNINE ADAPTER — Auth (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 — antes este adapter mirava a "99 Corp API" (x-api-key
 * estática). A API correta pro Central Tutts é a 99Entrega (delivery), que usa
 * OAuth 2.0 client_credentials — igual à Uber Direct.
 *
 * Doc: https://entrega-api.99app.com/docs/en/authentication.html
 *
 * Fluxo:
 *  - POST client_id + client_secret + grant_type=client_credentials + scope
 *    em https://entrega.99app.com/entrega-openplatform/oauth/v2/token
 *  - resposta traz data.access_token + data.expires_in (segundos, ~7200)
 *  - token vai no header Authorization: Bearer <token>
 *
 * Cache: logistics_oauth_tokens (provider_code='noventanove'), mesmo padrão
 * do uber.auth.js — margem de 2min pra reuso, 60s descontados do expires_in.
 */

const httpRequest = require('../../../../shared/utils/httpRequest');

// Base da API 99Entrega (produção e sandbox compartilham o mesmo host;
// o ambiente é definido pela credencial registrada no portal da 99).
const NOVENTANOVE_BASE_URL = 'https://entrega.99app.com/entrega-openplatform';
const NOVENTANOVE_AUTH_URL = `${NOVENTANOVE_BASE_URL}/oauth/v2/token`;
const NOVENTANOVE_SCOPE = 'entrega.order';

/**
 * Retorna a base URL da API 99Entrega.
 * @returns {string}
 */
function getBaseUrl() {
  return NOVENTANOVE_BASE_URL;
}

/**
 * Busca credenciais da 99Entrega em logistics_providers.config['noventanove'].
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{client_id: string, client_secret: string}>}
 */
async function _obterCredenciais(pool) {
  let client_id = null;
  let client_secret = null;

  try {
    const { rows } = await pool.query(`
      SELECT config FROM logistics_providers WHERE provider_code = 'noventanove' LIMIT 1
    `);
    if (rows[0]?.config) {
      client_id = rows[0].config.client_id || null;
      client_secret = rows[0].config.client_secret || null;
    }
  } catch (err) {
    console.warn('[noventanove.auth] logistics_providers indisponível:', err.message);
  }

  if (!client_id || !client_secret) {
    throw new Error(
      'NinetyNineAdapter: credenciais não configuradas. Preencha client_id e ' +
      'client_secret em logistics_providers.config (aba Provedores → 99).'
    );
  }

  return { client_id, client_secret };
}

/**
 * Obtém access_token da 99Entrega (OAuth client_credentials).
 * Estratégia idêntica ao uber.auth.js:
 *   1. Procura token cacheado em logistics_oauth_tokens com >2min de validade
 *   2. Se não acha, solicita novo na 99 via client_credentials
 *   3. Salva token + expires_at (expires_in - 60s de margem)
 *   4. Limpa tokens expirados (best-effort)
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<string>} access_token
 */
async function obterToken(pool) {
  // 1. Token cacheado
  const { rows } = await pool.query(`
    SELECT access_token, expires_at FROM logistics_oauth_tokens
    WHERE provider_code = 'noventanove'
      AND expires_at > NOW() + INTERVAL '2 minutes'
    ORDER BY id DESC LIMIT 1
  `);
  if (rows.length > 0) {
    return rows[0].access_token;
  }

  // 2. Novo token
  const creds = await _obterCredenciais(pool);

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    grant_type: 'client_credentials',
    scope: NOVENTANOVE_SCOPE,
  }).toString();

  const resp = await httpRequest(NOVENTANOVE_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = resp.json();

  // A 99Entrega encapsula tudo em { errno, errmsg, data }
  if (!resp.ok || json.errno !== 0 || !json.data?.access_token) {
    console.error('❌ [99Entrega] Erro ao obter token OAuth:', json);
    throw new Error(`Erro OAuth 99Entrega: ${json.errmsg || json.error || 'desconhecido'}`);
  }

  const data = json.data;

  // 3. Salvar (expires_in em segundos, margem de 60s)
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  await pool.query(`
    INSERT INTO logistics_oauth_tokens (provider_code, access_token, scope, expires_at)
    VALUES ('noventanove', $1, $2, $3)
  `, [data.access_token, data.scope || NOVENTANOVE_SCOPE, expiresAt]);

  // 4. Limpeza best-effort
  await pool.query(`
    DELETE FROM logistics_oauth_tokens WHERE provider_code = 'noventanove' AND expires_at < NOW()
  `).catch(() => {});

  console.log('✅ [99Entrega] Token OAuth renovado, expira em', data.expires_in, 'seg');
  return data.access_token;
}

/**
 * Monta os headers de autenticação pra uma request à 99Entrega.
 *
 * @param {import('pg').Pool} pool
 * @param {Object} [extras] - headers adicionais (ex: Content-Type)
 * @returns {Promise<Object>} headers prontos pro httpRequest
 */
async function montarHeaders(pool, extras = {}) {
  const token = await obterToken(pool);
  return {
    Authorization: `Bearer ${token}`,
    ...extras,
  };
}

/**
 * Validação rápida da config. Lança erro descritivo se faltar credencial.
 * @param {Object} config - logistics_providers.config do provider 'noventanove'
 */
function validarConfig(config) {
  const faltando = [];
  if (!config || !config.client_id) faltando.push('client_id');
  if (!config || !config.client_secret) faltando.push('client_secret');
  if (faltando.length > 0) {
    throw new Error(
      `NinetyNineAdapter: config incompleta — faltando: ${faltando.join(', ')}. ` +
      `Preencha na aba Provedores → 99.`
    );
  }
}

module.exports = {
  obterToken,
  montarHeaders,
  validarConfig,
  getBaseUrl,
  NOVENTANOVE_BASE_URL,
  NOVENTANOVE_AUTH_URL,
  NOVENTANOVE_SCOPE,
};
