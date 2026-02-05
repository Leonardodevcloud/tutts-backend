// ============================================================
// MÓDULO AUDITORIA - MIGRATION (Criação de Tabelas)
// Extraído de server.js (linhas 2728-2758)
// ============================================================

/**
 * Inicializa tabelas do módulo de Auditoria
 * @param {object} pool - Pool de conexão PostgreSQL
 */
async function initAuditTables(pool) {
  try {
    // Tabela de logs de auditoria
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        user_cod VARCHAR(50),
        user_name VARCHAR(255),
        user_role VARCHAR(50),
        action VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        resource VARCHAR(100),
        resource_id VARCHAR(100),
        details JSONB,
        ip_address VARCHAR(50),
        user_agent TEXT,
        status VARCHAR(20) DEFAULT 'success',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Índices para consultas rápidas
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_cod ON audit_logs(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`).catch(() => {});

    console.log('✅ Tabela audit_logs verificada');
  } catch (error) {
    console.error('❌ Erro ao inicializar tabelas de Auditoria:', error);
    throw error;
  }
}

module.exports = initAuditTables;
