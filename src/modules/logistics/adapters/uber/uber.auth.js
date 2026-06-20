/**
 * MÓDULO LOGISTICS — Uber Adapter — OAuth2
 *
 * Encapsula obtenção e cache de access_token Uber Direct (client_credentials).
 *
 * Fase 1A: extraído de uber.service.js:obterTokenUber (linhas 31-81).
 *
 * Comportamento preservado 100% — só com 1 mudança:
 *  - Tabela de cache: NEW logistics_oauth_tokens (substitui uber_oauth_token)
 *    Como o backfill da Fase 0 já copiou tokens válidos, e a Fase 1A faz o
 *    facade no uber.service.js delegar pra cá, ambas as tabelas vão receber
 *    tokens enquanto a transição acontece. Na Fase 6, dropa uber_oauth_token.
 *
 *  - Credenciais (client_id, client_secret): lê de logistics_providers.config['uber']
 *    com fallback pra uber_config.
 *
 * URL do auth endpoint Uber e scope estão fixos (não vêm de config):
 *  - UBER_AUTH_URL = 'https://login.uber.com/oauth/v2/token'
 *  - UBER_SCOPE    = 'eats.deliveries'
 */

const httpRequest = require('../../../../shared/utils/httpRequest');

// Domínios de auth por ambiente (doc oficial Uber):
//   Produção: auth.uber.com  (pareado com api.uber.com)
//   Sandbox : sandbox-login.uber.com  (pareado com test-api.uber.com)
// IMPORTANTE: NUNCA misturar domínio de token com domínio de API — a Uber
// retorna access_denied / falha de auth quando os ambientes não casam.
const UBER_AUTH_HOST_PROD = 'https://auth.uber.com';
const UBER_AUTH_HOST_SANDBOX = 'https://sandbox-login.uber.com';
const UBER_AUTH_PATH = '/oauth/v2/token';
const UBER_SCOPE = 'eats.deliveries';

/** URL do token endpoint conforme o ambiente. */
function getUberAuthUrl(sandboxMode) {
  return (sandboxMode ? UBER_AUTH_HOST_SANDBOX : UBER_AUTH_HOST_PROD) + UBER_AUTH_PATH;
}

// Última env usada (in-memory) — se o provider alternar sandbox<->prod em
// runtime (reload de config), invalidamos o cache pra não reaproveitar um
// token do outro ambiente (token Uber dura 30 dias).
let _ultimoEnvUber = null;

// Compat: callers antigos que importavam UBER_AUTH_URL continuam funcionando
// (aponta pra produção).
const UBER_AUTH_URL = UBER_AUTH_HOST_PROD + UBER_AUTH_PATH;

/**
 * Busca credenciais Uber em logistics_providers, fallback uber_config.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{client_id: string, client_secret: string}>}
 */
async function _obterCredenciaisUber(pool, sandboxMode = false) {
  let client_id = null;
  let client_secret = null;

  // Tentativa 1: logistics_providers. Em sandbox, prioriza chaves dedicadas
  // (sandbox_client_id / sandbox_client_secret) pra NÃO sobrescrever as
  // credenciais de produção já cadastradas. Se não houver chaves de sandbox,
  // cai nas principais (client_id / client_secret).
  try {
    const { rows } = await pool.query(`
      SELECT config FROM logistics_providers WHERE provider_code = 'uber' LIMIT 1
    `);
    if (rows[0]?.config) {
      const cfg = rows[0].config;
      if (sandboxMode) {
        client_id = cfg.sandbox_client_id || cfg.client_id || null;
        client_secret = cfg.sandbox_client_secret || cfg.client_secret || null;
      } else {
        client_id = cfg.client_id || null;
        client_secret = cfg.client_secret || null;
      }
    }
  } catch (err) {
    console.warn('[uber.auth] logistics_providers indisponível:', err.message);
  }

  // Tentativa 2: fallback uber_config
  if (!client_id || !client_secret) {
    try {
      const { rows } = await pool.query('SELECT client_id, client_secret FROM _legacy_uber_config WHERE id = 1');
      if (rows[0]) {
        client_id = client_id || rows[0].client_id;
        client_secret = client_secret || rows[0].client_secret;
      }
    } catch (err) {
      // Ignora — vai cair no throw abaixo
    }
  }

  if (!client_id || !client_secret) {
    throw new Error('Credenciais Uber Direct não configuradas (nem em logistics_providers nem em uber_config)');
  }

  return { client_id, client_secret };
}

/**
 * Obtém access_token Uber Direct.
 * Estratégia (idêntica ao uber.service.js:obterTokenUber):
 *   1. Procura token cacheado em logistics_oauth_tokens com >2min de validade
 *   2. Se não acha, solicita novo na Uber via client_credentials
 *   3. Salva token e expires_at calculado (expires_in - 60s de margem)
 *   4. Limpa tokens expirados (best-effort)
 *
 * Comportamento preservado:
 *   - Margem de 2min antes de considerar válido
 *   - Margem de 60s descontada do expires_in retornado
 *   - Limpeza de tokens antigos é silenciosa (catch ignorado)
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<string>} access_token
 */
async function obterTokenUber(pool, sandboxMode = false) {
  const env = sandboxMode ? 'sandbox' : 'prod';

  // Se o ambiente mudou em runtime (ex.: ligaram/desligaram sandbox_mode e o
  // provider foi recarregado), invalida o cache: um token de sandbox NÃO vale
  // contra produção e vice-versa (causaria access_denied silencioso).
  if (_ultimoEnvUber && _ultimoEnvUber !== env) {
    console.log(`♻️ [uber.auth] ambiente mudou (${_ultimoEnvUber} -> ${env}) — invalidando cache de token`);
    await pool.query("DELETE FROM logistics_oauth_tokens WHERE provider_code = 'uber'").catch(() => {});
  }
  _ultimoEnvUber = env;

  // 1. Verificar token cacheado no banco
  const { rows } = await pool.query(`
    SELECT access_token, expires_at FROM logistics_oauth_tokens
    WHERE provider_code = 'uber'
      AND expires_at > NOW() + INTERVAL '2 minutes'
    ORDER BY id DESC LIMIT 1
  `);

  if (rows.length > 0) {
    return rows[0].access_token;
  }

  // 2. Solicitar novo token
  const creds = await _obterCredenciaisUber(pool, sandboxMode);

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    grant_type: 'client_credentials',
    scope: UBER_SCOPE,
  }).toString();

  const resp = await httpRequest(getUberAuthUrl(sandboxMode), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = resp.json();

  if (!resp.ok || !data.access_token) {
    console.error(`❌ [Uber] Erro ao obter token OAuth (${env}):`, data);
    throw new Error(`Erro OAuth Uber: ${data.error || 'desconhecido'}`);
  }

  // 3. Salvar no banco (expires_in vem em segundos)
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  await pool.query(`
    INSERT INTO logistics_oauth_tokens (provider_code, access_token, expires_at)
    VALUES ('uber', $1, $2)
  `, [data.access_token, expiresAt]);

  // Limpar tokens antigos
  await pool.query(`
    DELETE FROM logistics_oauth_tokens WHERE provider_code = 'uber' AND expires_at < NOW()
  `).catch(() => {});

  console.log('✅ [Uber] Token OAuth renovado, expira em', data.expires_in, 'seg');
  return data.access_token;
}

module.exports = {
  obterTokenUber,
  getUberAuthUrl,
  UBER_AUTH_URL,
  UBER_AUTH_HOST_PROD,
  UBER_AUTH_HOST_SANDBOX,
  UBER_SCOPE,
};
