/**
 * MÓDULO AUTH - Migration
 * 6 tabelas: password_recovery, login_attempts, blocked_accounts,
 *            refresh_tokens, user_2fa, used_2fa_codes
 */

async function initAuthTables(pool) {

  // ==================== PASSWORD RECOVERY ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_recovery (
      id SERIAL PRIMARY KEY,
      user_cod VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      status VARCHAR(20) DEFAULT 'pendente',
      new_password VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP,
      resolved_by VARCHAR(255)
    )
  `);
  console.log('✅ Tabela password_recovery verificada');

  // ==================== CONTROLE DE LOGIN ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      cod_profissional VARCHAR(50) NOT NULL,
      ip_address VARCHAR(50),
      success BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_cod ON login_attempts(cod_profissional)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_accounts (
      id SERIAL PRIMARY KEY,
      cod_profissional VARCHAR(50) UNIQUE NOT NULL,
      blocked_until TIMESTAMP NOT NULL,
      reason VARCHAR(255) DEFAULT 'Muitas tentativas de login falhas',
      attempts_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocked_accounts_cod ON blocked_accounts(cod_profissional)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocked_accounts_until ON blocked_accounts(blocked_until)`);

  console.log('✅ Tabelas de controle de login verificadas');

  // ==================== REFRESH TOKENS ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(255) NOT NULL,
      device_info VARCHAR(255),
      ip_address VARCHAR(50),
      expires_at TIMESTAMP NOT NULL,
      revoked BOOLEAN DEFAULT FALSE,
      revoked_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at)`);

  console.log('✅ Tabela refresh_tokens verificada');

  // ==================== 2FA ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_2fa (
      id SERIAL PRIMARY KEY,
      user_id INT UNIQUE NOT NULL,
      secret_encrypted VARCHAR(255) NOT NULL,
      enabled BOOLEAN DEFAULT FALSE,
      backup_codes TEXT[],
      verified_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_2fa_user ON user_2fa(user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS used_2fa_codes (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      used_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_used_2fa_user ON used_2fa_codes(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_used_2fa_used_at ON used_2fa_codes(used_at)`);

  console.log('✅ Tabelas de 2FA verificadas');
}

module.exports = { initAuthTables };
