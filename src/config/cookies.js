/**
 * src/config/cookies.js
 * Configuração centralizada de cookies HttpOnly para JWT
 * 
 * 🔧 FIX: maxAge do access cookie alinhado com JWT_EXPIRES_IN (8h)
 *    Antes: 1h → cookie expirava mas JWT era válido por 8h → sessão caía
 */

const env = require('./env');

const IS_PRODUCTION = env.IS_PRODUCTION;

// Configuração base de segurança
const COOKIE_BASE = {
  httpOnly: true,                          // JS não consegue ler
  secure: IS_PRODUCTION,                   // HTTPS only em produção
  sameSite: IS_PRODUCTION ? 'none' : 'lax', // 'none' para cross-site (frontend/backend em domínios diferentes)
  path: '/',
};

// Access token cookie (8 horas — DEVE coincidir com JWT_EXPIRES_IN em auth.service.js)
const ACCESS_COOKIE_NAME = 'tutts_access';
const ACCESS_COOKIE_OPTIONS = {
  ...COOKIE_BASE,
  maxAge: 8 * 60 * 60 * 1000, // 🔧 FIX: 8h em ms (era 1h — causava logout prematuro)
};

// Refresh token cookie (7 dias)
const REFRESH_COOKIE_NAME = 'tutts_refresh';
const REFRESH_COOKIE_OPTIONS = {
  ...COOKIE_BASE,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7d em ms
  path: '/api/users',               // Refresh só precisa ir para rotas de auth
};

/**
 * Define os cookies de autenticação na resposta
 */
function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, ACCESS_COOKIE_OPTIONS);
  if (refreshToken) {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
  }
}

/**
 * Limpa os cookies de autenticação
 */
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE_NAME, { ...COOKIE_BASE, path: '/' });
  res.clearCookie(REFRESH_COOKIE_NAME, { ...COOKIE_BASE, path: '/api/users' });
}

module.exports = {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
  setAuthCookies,
  clearAuthCookies,
};
