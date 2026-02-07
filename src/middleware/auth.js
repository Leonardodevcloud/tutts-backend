/**
 * src/middleware/auth.js
 * Middlewares de autenticação e autorização
 * 
 * Prioridade de leitura do token:
 *   1. Cookie HttpOnly 'tutts_access' (mais seguro)
 *   2. Header Authorization: Bearer <token> (compatibilidade)
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { ACCESS_COOKIE_NAME } = require('../config/cookies');

/**
 * Extrai o token JWT da request
 * Prioridade: cookie > header
 */
function extractToken(req) {
  // 1. Cookie HttpOnly (mais seguro)
  if (req.cookies && req.cookies[ACCESS_COOKIE_NAME]) {
    return req.cookies[ACCESS_COOKIE_NAME];
  }
  // 2. Header Authorization (fallback / compatibilidade)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  return null;
}

// Verificar token JWT (obrigatório)
const verificarToken = (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    req.user = jwt.verify(token, env.JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', expired: true });
    }
    return res.status(403).json({ error: 'Token inválido' });
  }
};

// Verificar token JWT (opcional - não bloqueia, mas adiciona user se tiver)
const verificarTokenOpcional = (req, res, next) => {
  const token = extractToken(req);

  if (token) {
    try {
      req.user = jwt.verify(token, env.JWT_SECRET);
    } catch (err) {
      // Token inválido, mas não bloqueia
    }
  }
  next();
};

// Verificar se é admin
const verificarAdmin = (req, res, next) => {
  if (!req.user || !['admin', 'admin_master'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado. Requer permissão de administrador.' });
  }
  next();
};

// Verificar se é admin ou financeiro
const verificarAdminOuFinanceiro = (req, res, next) => {
  if (!req.user || !['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado. Requer permissão de admin ou financeiro.' });
  }
  next();
};

// Verificar se é o próprio usuário ou admin
const verificarProprioOuAdmin = (req, res, next) => {
  const targetCod = req.params.codProfissional || req.body.codProfissional;
  if (
    req.user &&
    (req.user.codProfissional === targetCod || ['admin', 'admin_master'].includes(req.user.role))
  ) {
    return next();
  }
  return res.status(403).json({ error: 'Acesso negado.' });
};

module.exports = {
  verificarToken,
  verificarTokenOpcional,
  verificarAdmin,
  verificarAdminOuFinanceiro,
  verificarProprioOuAdmin,
  extractToken,
};
