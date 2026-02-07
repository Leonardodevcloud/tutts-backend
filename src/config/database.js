/**
 * src/config/database.js
 * Conexão com PostgreSQL e pool management
 */

const { Pool } = require('pg');
const env = require('./env');

const sslConfig = {
  rejectUnauthorized: false,
};

const isLocalhost = env.DATABASE_URL?.includes('localhost');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: isLocalhost ? false : sslConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  application_name: 'tutts-backend',
});

if (!isLocalhost) {
  console.log('🔐 Conexão SSL ativada para o banco de dados');
}

// Test connection
async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ Banco de dados conectado:', res.rows[0].now);
    return true;
  } catch (err) {
    console.error('❌ Falha na conexão com banco de dados:', err.message);
    return false;
  }
}

module.exports = { pool, testConnection };
