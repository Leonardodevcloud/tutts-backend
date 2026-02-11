/**
 * src/config/database.js
 * Conexão com PostgreSQL e pool management
 */

const { Pool } = require('pg');
const env = require('./env');

// 🔒 SECURITY: SSL config
// Neon PostgreSQL uses valid Let's Encrypt certificates
// Set DB_SSL_REJECT_UNAUTHORIZED=false only if connection fails
const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

const sslConfig = { rejectUnauthorized };
const isLocalhost = env.DATABASE_URL?.includes('localhost');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: isLocalhost ? false : sslConfig,
  max: 20,                      // ⚡ 20 conexões — suporta picos de login sem starvation
  idleTimeoutMillis: 30000,     // 30s — evita reconexões frequentes ao Neon
  connectionTimeoutMillis: 15000, // ⚡ 15s — mais tolerante a cold-starts do Neon
  statement_timeout: 30000,     // ⚡ Kill queries > 30s (evita queries infinitas)
  application_name: 'tutts-backend',
});

// 🕐 Forçar timezone Brasil em cada conexão
pool.on('connect', (client) => {
  client.query("SET timezone = 'America/Sao_Paulo'");
});

if (!isLocalhost) {
  console.log(`🔐 Conexão SSL ativada (rejectUnauthorized: ${rejectUnauthorized})`);
}

// Test connection
async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ Banco de dados conectado:', res.rows[0].now);
    return true;
  } catch (err) {
    console.error('❌ Falha na conexão com banco de dados:', err.message);
    if (rejectUnauthorized && err.message.includes('certificate')) {
      console.error('💡 Se o erro é de certificado, configure DB_SSL_REJECT_UNAUTHORIZED=false como variável de ambiente');
    }
    return false;
  }
}

module.exports = { pool, testConnection };
