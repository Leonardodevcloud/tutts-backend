/**
 * src/config/helmet.js
 * Headers de segurança HTTP
 * 
 * 🔒 SECURITY PATCH V6 - Melhorias:
 * - imgSrc: removido wildcard https: (era muito permissivo)
 * - frameAncestors: 'none' (era 'self')
 * - frameguard: deny (era sameorigin)
 * - HSTS: 2 anos (era 1 ano)
 * - Added: upgradeInsecureRequests, referrerPolicy
 * - Added: crossOriginOpenerPolicy, crossOriginResourcePolicy
 * 
 * NOTA: unsafe-inline/unsafe-eval ainda necessários pelo frontend CDN.
 * Remover quando migrar para build system (Vite/Webpack).
 */

const helmet = require('helmet');

const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",   // TODO: remover com build system
        "'unsafe-eval'",     // TODO: remover com build system
        "https://cdn.tailwindcss.com",
        "https://unpkg.com",
        "https://cdn.sheetjs.com",
        "https://cdnjs.cloudflare.com",
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://unpkg.com",
        "https://cdn.tailwindcss.com",
        "https://fonts.googleapis.com",
      ],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://*.tile.openstreetmap.org",
        "https://api.qrserver.com",
        "https://ui-avatars.com",
      ],
      connectSrc: [
        "'self'",
        "https://tutts-backend-production.up.railway.app",
        "wss://tutts-backend-production.up.railway.app",
        "https://nominatim.openstreetmap.org",
        "https://viacep.com.br",
        "https://api.qrserver.com",
      ],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: [],
    },
    reportOnly: false,
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-site' },
  dnsPrefetchControl: { allow: true },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true,
  },
  ieNoOpen: true,
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

/**
 * Headers adicionais não cobertos pelo Helmet
 */
function additionalSecurityHeaders(req, res, next) {
  // Permissions Policy: restringir APIs do browser
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(self), payment=(), usb=()'
  );

  // Cache control para respostas autenticadas
  if (req.headers.authorization) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }

  next();
}

module.exports = helmetConfig;
module.exports.additionalSecurityHeaders = additionalSecurityHeaders;
