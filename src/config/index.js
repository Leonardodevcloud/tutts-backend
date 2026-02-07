/**
 * src/config/index.js
 * Barrel export for all config
 */

const env = require('./env');
const { pool, testConnection } = require('./database');
const { Logger, logger, authLogger, dbLogger, apiLogger, securityLogger } = require('./logger');
const { setupCors } = require('./cors');
const helmetConfig = require('./helmet');
const { setupWebSocket, registerGlobals } = require('./websocket');

module.exports = {
  env, pool, testConnection,
  Logger, logger, authLogger, dbLogger, apiLogger, securityLogger,
  setupCors, helmetConfig,
  setupWebSocket, registerGlobals,
};
