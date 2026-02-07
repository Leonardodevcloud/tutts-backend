/**
 * src/config/env.js
 * Validação e centralização de variáveis de ambiente
 */

require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error(`❌ ERRO CRÍTICO: Variáveis obrigatórias não configuradas: ${missing.join(', ')}`);
  process.exit(1);
}

const env = {
  // Server
  PORT: parseInt(process.env.PORT) || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PRODUCTION: process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production',

  // Database
  DATABASE_URL: process.env.DATABASE_URL,

  // Auth
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: '1h',
  REFRESH_TOKEN_EXPIRES_IN: '7d',
  // 🔒 SECURITY: Separate secret for refresh tokens
  // If REFRESH_SECRET env var exists, use it; otherwise derive from JWT_SECRET (backward compatible)
  REFRESH_SECRET: process.env.REFRESH_SECRET || (process.env.JWT_SECRET + '_REFRESH_v2_' + (process.env.JWT_SECRET || '').slice(-8)),
  BCRYPT_ROUNDS: 10,

  // Tutts API tokens
  TUTTS_TOKENS: {
    GRAVAR: process.env.TUTTS_TOKEN_GRAVAR,
    STATUS: process.env.TUTTS_TOKEN_STATUS,
    PROFISSIONAIS: process.env.TUTTS_TOKEN_PROFISSIONAIS,
    CANCELAR: process.env.TUTTS_TOKEN_CANCELAR,
  },

  // External APIs
  ORS_API_KEY: process.env.ORS_API_KEY,

  // Plific
  PLIFIC_AMBIENTE: process.env.PLIFIC_AMBIENTE,
  PLIFIC_TOKEN: process.env.PLIFIC_TOKEN,

  // Version
  SERVER_VERSION: '2026-02-07-SECURITY-PATCH-V6',
};

// Warnings (não bloqueiam)
const tuttsNaoConfigurados = Object.entries(env.TUTTS_TOKENS)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (tuttsNaoConfigurados.length > 0) {
  console.warn(`⚠️ Tokens Tutts não configurados: ${tuttsNaoConfigurados.join(', ')}`);
}

if (!env.ORS_API_KEY) {
  console.warn('⚠️ ORS_API_KEY não configurada - Roteirizador não funcionará');
}

if (!process.env.REFRESH_SECRET) {
  console.warn('⚠️ REFRESH_SECRET não configurado - usando derivação do JWT_SECRET. Configure REFRESH_SECRET como variável separada para maior segurança.');
}

module.exports = env;
