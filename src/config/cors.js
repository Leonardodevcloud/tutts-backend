/**
 * src/config/cors.js
 * Configuração CORS centralizada
 */

const env = require('./env');

const allowedOrigins = [
  'https://www.centraltutts.online',
  'https://centraltutts.online',
  'https://tutts-frontend.vercel.app',
  'https://tutts-frontend-git-main.vercel.app',
  ...(env.IS_PRODUCTION ? [] : [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3001',
  ]),
];

console.log(`🔒 CORS configurado para ${env.IS_PRODUCTION ? 'PRODUÇÃO' : 'DESENVOLVIMENTO'} - ${allowedOrigins.length} origens permitidas`);

function isOriginAllowed(origin) {
  if (!origin) return false;
  // 🔒 SECURITY FIX: Pattern restrito para deploys no Vercel
  // Aceita: tutts-frontend.vercel.app, tutts-frontend-XXXX.vercel.app, tutts-frontend-git-XXXX-YYYY.vercel.app
  if (/^https:\/\/tutts-frontend(-[a-z0-9-]+)*\.vercel\.app$/.test(origin)) return true;
  return allowedOrigins.includes(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    const publicPaths = ['/health', '/api/health', '/api/version'];
    if (publicPaths.some(p => req.path.startsWith(p))) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, Pragma, X-CSRF-Token, X-WS-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
}

function setupCors(app) {
  // Preflight MUST come first
  app.options('*', (req, res) => {
    setCorsHeaders(req, res);
    return res.status(200).end();
  });

  // CORS for ALL requests
  app.use((req, res, next) => {
    setCorsHeaders(req, res);
    next();
  });
}

module.exports = { setupCors, setCorsHeaders, isOriginAllowed };
