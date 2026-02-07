/**
 * src/config/logger.js
 * Sistema de logging estruturado com contextos
 */

const env = require('./env');

const LOG_LEVELS = { ERROR: 'error', WARN: 'warn', INFO: 'info', DEBUG: 'debug', SECURITY: 'security' };

const LOG_CONFIG = {
  level: process.env.LOG_LEVEL || 'info',
  jsonFormat: env.IS_PRODUCTION,
  colorize: !env.IS_PRODUCTION,
};

const COLORS = {
  reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m',
  green: '\x1b[32m', blue: '\x1b[34m', magenta: '\x1b[35m',
};

const LEVEL_COLORS = {
  error: COLORS.red, warn: COLORS.yellow, info: COLORS.green,
  debug: COLORS.blue, security: COLORS.magenta,
};

class Logger {
  constructor(context = 'APP') {
    this.context = context;
  }

  _shouldLog(level) {
    const levels = ['error', 'warn', 'security', 'info', 'debug'];
    return levels.indexOf(level) <= levels.indexOf(LOG_CONFIG.level);
  }

  _format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();

    // Redact sensitive fields
    const safeMeta = { ...meta };
    for (const key of ['password', 'token', 'secret', 'senha']) {
      if (safeMeta[key]) safeMeta[key] = '[REDACTED]';
    }

    if (LOG_CONFIG.jsonFormat) {
      return JSON.stringify({ timestamp, level, context: this.context, message, ...safeMeta });
    }

    const color = LOG_CONFIG.colorize ? (LEVEL_COLORS[level] || '') : '';
    const reset = LOG_CONFIG.colorize ? COLORS.reset : '';
    const metaStr = Object.keys(safeMeta).length > 0 ? ` ${JSON.stringify(safeMeta)}` : '';
    return `${timestamp} ${color}${level.toUpperCase().padEnd(8)}${reset} [${this.context}] ${message}${metaStr}`;
  }

  _log(level, message, meta = {}) {
    if (!this._shouldLog(level)) return;
    const formatted = this._format(level, message, meta);
    if (level === 'error') console.error(formatted);
    else if (level === 'warn') console.warn(formatted);
    else console.log(formatted);
  }

  error(message, meta = {}) { this._log('error', message, meta); }
  warn(message, meta = {}) { this._log('warn', message, meta); }
  info(message, meta = {}) { this._log('info', message, meta); }
  debug(message, meta = {}) { this._log('debug', message, meta); }
  security(message, meta = {}) { this._log('security', `🔐 ${message}`, meta); }

  request(req, res, duration) {
    const meta = {
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.headers['x-forwarded-for'] || req.ip,
    };
    if (req.user) {
      meta.userId = req.user.id;
      meta.userCod = req.user.codProfissional;
    }
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    this._log(level, `${req.method} ${req.originalUrl || req.url} ${res.statusCode}`, meta);
  }
}

// Instâncias pré-configuradas
const logger = new Logger('SERVER');
const authLogger = new Logger('AUTH');
const dbLogger = new Logger('DATABASE');
const apiLogger = new Logger('API');
const securityLogger = new Logger('SECURITY');

module.exports = { Logger, logger, authLogger, dbLogger, apiLogger, securityLogger, LOG_LEVELS };
