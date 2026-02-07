/**
 * src/middleware/auth.js
 * Middlewares de autenticação e autorização
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');

// Verificar token JWT (obrigatório)
const verificarToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

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
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

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
  const userCod = req.params.cod_prof || req.params.userCod || req.body.user_cod;
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (['admin', 'admin_master'].includes(req.user.role) || req.user.codProfissional === userCod) {
    next();
  } else {
    return res.status(403).json({ error: 'Acesso negado' });
  }
};

module.exports = {
  verificarToken,
  verificarTokenOpcional,
  verificarAdmin,
  verificarAdminOuFinanceiro,
  verificarProprioOuAdmin,
};
