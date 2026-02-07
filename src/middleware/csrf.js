/**
 * src/middleware/csrf.js
 * Proteção CSRF via Double Submit Cookie
 * 
 * Como funciona:
 *   1. Login: servidor gera token CSRF e seta como cookie legível pelo JS
 *   2. Frontend: lê o cookie e envia como header X-CSRF-Token em toda mutação
 *   3. Middleware: compara header vs cookie — se não batem, bloqueia
 * 
 * Por que funciona:
 *   Atacante em outro domínio NÃO consegue ler nossos cookies (Same-Origin Policy)
 *   Então não consegue construir o header X-CSRF-Token correto
 */

const crypto = require('crypto');

const CSRF_COOKIE_NAME = 'tutts_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Gera token CSRF criptograficamente seguro
 */
function gerarCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Seta o cookie CSRF (legível pelo JS — NÃO httpOnly)
 */
function setCsrfCookie(res, token) {
  const IS_PRODUCTION = process.env.NODE_ENV === 'production';
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,        // JS PRECISA ler este cookie
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'none' : 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000, // 24h
  });
}

/**
 * Limpa o cookie CSRF
 */
function clearCsrfCookie(res) {
  const IS_PRODUCTION = process.env.NODE_ENV === 'production';
  res.clearCookie(CSRF_COOKIE_NAME, {
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'none' : 'lax',
    path: '/',
  });
}

/**
 * Middleware: valida CSRF em mutações (POST, PUT, DELETE, PATCH)
 * GETs e OPTIONs passam livre (são idempotentes)
 */
function verificarCsrf(req, res, next) {
  // Métodos seguros não precisam de CSRF
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Rotas de login/register não têm CSRF ainda (token é setado no login)
  const rotasExcluidas = [
    '/api/users/login',
    '/api/users/register',
    '/api/users/2fa/authenticate',
    '/api/password-recovery',
    '/api/webhook',
    '/api/solicitacao/webhook',
  ];

  if (rotasExcluidas.some(rota => req.path.startsWith(rota))) {
    return next();
  }

  const cookieToken = req.cookies && req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: 'Token CSRF ausente' });
  }

  // Comparação timing-safe para evitar timing attacks
  try {
    const cookieBuf = Buffer.from(cookieToken, 'utf8');
    const headerBuf = Buffer.from(headerToken, 'utf8');

    if (cookieBuf.length !== headerBuf.length || !crypto.timingSafeEqual(cookieBuf, headerBuf)) {
      return res.status(403).json({ error: 'Token CSRF inválido' });
    }
  } catch (err) {
    return res.status(403).json({ error: 'Token CSRF inválido' });
  }

  next();
}

module.exports = {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  gerarCsrfToken,
  setCsrfCookie,
  clearCsrfCookie,
  verificarCsrf,
};
