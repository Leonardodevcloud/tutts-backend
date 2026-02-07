/**
 * src/middleware/requestLogger.js
 * Log de cada request HTTP
 */

const { apiLogger } = require('../config/logger');
const env = require('../config/env');

const requestLogger = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Skip health checks em produção
    if (env.IS_PRODUCTION && (req.path === '/health' || req.path === '/api/health')) {
      return;
    }

    apiLogger.request(req, res, duration);
  });

  next();
};

module.exports = requestLogger;
