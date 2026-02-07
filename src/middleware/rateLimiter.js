/**
 * src/middleware/rateLimiter.js
 * Rate limiting configurado para proxy (Railway/Vercel)
 */

const rateLimit = require('express-rate-limit');

// Extrair IP real de forma segura (anti-spoofing)
const getClientIP = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (forwardedFor) {
    const ips = forwardedFor.split(',').map(ip => ip.trim());
    const publicIP = ips.find(ip => {
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return false;
      if (ip.startsWith('127.') || ip === 'localhost' || ip === '::1') return false;
      return true;
    });
    if (publicIP) return publicIP;
  }

  return req.ip || req.connection?.remoteAddress || 'unknown';
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/api/health',
  keyGenerator: (req) => getClientIP(req),
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 500,
  message: { error: 'Muitas requisições. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/api/health' || req.path.startsWith('/api/relatorios-diarios/'),
  keyGenerator: (req) => getClientIP(req),
});

const createAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas contas criadas. Tente novamente em 1 hora.' },
  keyGenerator: (req) => getClientIP(req),
});

module.exports = { getClientIP, loginLimiter, apiLimiter, createAccountLimiter };
