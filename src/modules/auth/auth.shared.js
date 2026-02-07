/**
 * Auth Shared - Internal helpers (factory for pool access)
 */

function createAuthHelpers(pool) {
const verificarContaBloqueada = async (codProfissional) => {
  try {
    const result = await pool.query(
      `SELECT * FROM blocked_accounts 
       WHERE LOWER(cod_profissional) = LOWER($1) 
       AND blocked_until > NOW()`,
      [codProfissional]
    );
    
    if (result.rows.length > 0) {
      const blocked = result.rows[0];
      const minutosRestantes = Math.ceil((new Date(blocked.blocked_until) - new Date()) / 60000);
      return {
        bloqueada: true,
        motivo: blocked.reason,
        tentativas: blocked.attempts_count,
        minutosRestantes,
        desbloqueioPrevisto: blocked.blocked_until
      };
    }
    
    return { bloqueada: false };
  } catch (error) {
    console.error('❌ Erro ao verificar bloqueio:', error.message);
    return { bloqueada: false }; // Em caso de erro, permitir (fail-open)
  }
};

// Registrar tentativa de login
const registrarTentativaLogin = async (codProfissional, ip, sucesso) => {
  try {
    // Registrar tentativa
    await pool.query(
      `INSERT INTO login_attempts (cod_profissional, ip_address, success) 
       VALUES ($1, $2, $3)`,
      [codProfissional.toLowerCase(), ip, sucesso]
    );
    
    // Se foi sucesso, remover bloqueio (se existir) e limpar tentativas
    if (sucesso) {
      await pool.query(
        `DELETE FROM blocked_accounts WHERE LOWER(cod_profissional) = LOWER($1)`,
        [codProfissional]
      );
      // Limpar tentativas antigas (manter só últimas 24h para auditoria)
      await pool.query(
        `DELETE FROM login_attempts 
         WHERE LOWER(cod_profissional) = LOWER($1) 
         AND created_at < NOW() - INTERVAL '24 hours'`,
        [codProfissional]
      );
      return { bloqueado: false };
    }
    
    // Contar tentativas falhas recentes
    const tentativas = await pool.query(
      `SELECT COUNT(*) as count FROM login_attempts 
       WHERE LOWER(cod_profissional) = LOWER($1) 
       AND success = false 
       AND created_at > NOW() - INTERVAL '${LOGIN_CONFIG.ATTEMPT_WINDOW_MINUTES} minutes'`,
      [codProfissional]
    );
    
    const numTentativas = parseInt(tentativas.rows[0].count);
    
    // Se excedeu limite, bloquear conta
    if (numTentativas >= LOGIN_CONFIG.MAX_ATTEMPTS) {
      const blockedUntil = new Date(Date.now() + LOGIN_CONFIG.BLOCK_DURATION_MINUTES * 60000);
      
      await pool.query(
        `INSERT INTO blocked_accounts (cod_profissional, blocked_until, attempts_count, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cod_profissional) 
         DO UPDATE SET blocked_until = $2, attempts_count = $3, reason = $4`,
        [
          codProfissional.toLowerCase(), 
          blockedUntil, 
          numTentativas,
          `Conta bloqueada após ${numTentativas} tentativas de login falhas`
        ]
      );
      
      securityLogger.securityEvent('ACCOUNT_BLOCKED', {
        codProfissional,
        blockedUntil: blockedUntil.toISOString(),
        attempts: numTentativas
      });
      
      return {
        bloqueado: true,
        tentativas: numTentativas,
        minutosRestantes: LOGIN_CONFIG.BLOCK_DURATION_MINUTES
      };
    }
    
    return {
      bloqueado: false,
      tentativas: numTentativas,
      tentativasRestantes: LOGIN_CONFIG.MAX_ATTEMPTS - numTentativas
    };
  } catch (error) {
    console.error('❌ Erro ao registrar tentativa:', error.message);
    return { bloqueado: false };
  }
};

// Limpar bloqueios expirados (executar periodicamente)
const limparBloqueiosExpirados = async () => {
  try {
    const result = await pool.query(
      `DELETE FROM blocked_accounts WHERE blocked_until < NOW() RETURNING cod_profissional`
    );
    if (result.rows.length > 0) {
      console.log(`🔓 ${result.rows.length} bloqueio(s) expirado(s) removido(s)`);
    }
  } catch (error) {
    console.error('❌ Erro ao limpar bloqueios:', error.message);
  }
};

// Executar limpeza a cada 5 minutos


  // ==================== REFRESH TOKENS ====================

const salvarRefreshToken = async (userId, refreshToken, req) => {
  try {
    // Hash do token para armazenar (não guardar token em texto plano)
    const tokenHash = await bcrypt.hash(refreshToken, 10);
    const ip = getClientIP(req);
    const deviceInfo = req.headers['user-agent']?.substring(0, 255) || 'Unknown';
    
    // Calcular expiração (7 dias)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    
    // Revogar tokens antigos do mesmo dispositivo (limitar a 5 sessões)
    const existingTokens = await pool.query(
      `SELECT id FROM refresh_tokens 
       WHERE user_id = $1 AND revoked = false 
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // Manter no máximo 5 sessões ativas
    if (existingTokens.rows.length >= 5) {
      const tokensToRevoke = existingTokens.rows.slice(4).map(t => t.id);
      if (tokensToRevoke.length > 0) {
        await pool.query(
          `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() 
           WHERE id = ANY($1)`,
          [tokensToRevoke]
        );
      }
    }
    
    // Salvar novo token
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, tokenHash, deviceInfo, ip, expiresAt]
    );
    
    return true;
  } catch (error) {
    console.error('❌ Erro ao salvar refresh token:', error.message);
    return false;
  }
};

// Validar refresh token
const validarRefreshToken = async (refreshToken, userId) => {
  try {
    // Verificar assinatura do token
    const decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    
    if (decoded.type !== 'refresh' || decoded.id !== userId) {
      return { valido: false, erro: 'Token inválido' };
    }
    
    // Buscar tokens não revogados do usuário
    const result = await pool.query(
      `SELECT id, token_hash FROM refresh_tokens 
       WHERE user_id = $1 AND revoked = false AND expires_at > NOW()`,
      [userId]
    );
    
    // Verificar se algum hash bate
    for (const row of result.rows) {
      const match = await bcrypt.compare(refreshToken, row.token_hash);
      if (match) {
        return { valido: true, tokenId: row.id };
      }
    }
    
    return { valido: false, erro: 'Token não encontrado ou revogado' };
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return { valido: false, erro: 'Token expirado' };
    }
    return { valido: false, erro: 'Token inválido' };
  }
};

// Revogar refresh token específico
const revogarRefreshToken = async (tokenId) => {
  try {
    await pool.query(
      `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE id = $1`,
      [tokenId]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao revogar token:', error.message);
    return false;
  }
};

// Revogar todos os refresh tokens de um usuário (logout de todas as sessões)
const revogarTodosTokens = async (userId) => {
  try {
    const result = await pool.query(
      `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() 
       WHERE user_id = $1 AND revoked = false
       RETURNING id`,
      [userId]
    );
    console.log(`🔒 ${result.rows.length} sessão(ões) revogada(s) para user_id: ${userId}`);
    return result.rows.length;
  } catch (error) {
    console.error('❌ Erro ao revogar tokens:', error.message);
    return 0;
  }
};

// Limpar refresh tokens expirados (executar periodicamente)
const limparRefreshTokensExpirados = async () => {
  try {
    const result = await pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW() OR (revoked = true AND revoked_at < NOW() - INTERVAL '7 days')`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 ${result.rowCount} refresh token(s) expirado(s) removido(s)`);
    }
  } catch (error) {
    console.error('❌ Erro ao limpar refresh tokens:', error.message);
  }
};

// Executar limpeza a cada hora

  // ==================== 2FA DB HELPERS ====================

const verifyBackupCode = async (userId, code) => {
  try {
    const result = await pool.query(
      'SELECT backup_codes FROM user_2fa WHERE user_id = $1 AND enabled = true',
      [userId]
    );
    
    if (result.rows.length === 0) return { valid: false };
    
    const backupCodes = result.rows[0].backup_codes || [];
    const codeHash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
    
    const index = backupCodes.findIndex(bc => bc === codeHash);
    if (index === -1) return { valid: false };
    
    // Remover código usado
    backupCodes.splice(index, 1);
    await pool.query(
      'UPDATE user_2fa SET backup_codes = $1, updated_at = NOW() WHERE user_id = $2',
      [backupCodes, userId]
    );
    
    return { valid: true, codesRemaining: backupCodes.length };
  } catch (error) {
    console.error('❌ Erro ao verificar backup code:', error.message);
    return { valid: false };
  }
};

// Verificar se código já foi usado (prevenir replay attacks)
const isCodeUsed = async (userId, code) => {
  try {
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    
    // Limpar códigos antigos (mais de 2 minutos)
    await pool.query(
      'DELETE FROM used_2fa_codes WHERE used_at < NOW() - INTERVAL \'2 minutes\''
    );
    
    // Verificar se código foi usado
    const result = await pool.query(
      'SELECT id FROM used_2fa_codes WHERE user_id = $1 AND code_hash = $2',
      [userId, codeHash]
    );
    
    if (result.rows.length > 0) return true;
    
    // Marcar como usado
    await pool.query(
      'INSERT INTO used_2fa_codes (user_id, code_hash) VALUES ($1, $2)',
      [userId, codeHash]
    );
    
    return false;
  } catch (error) {
    console.error('❌ Erro ao verificar código usado:', error.message);
    return false; // Fail-open para não bloquear usuário
  }
};

// Verificar se usuário tem 2FA habilitado
const has2FAEnabled = async (userId) => {
  try {
    const result = await pool.query(
      'SELECT enabled FROM user_2fa WHERE user_id = $1',
      [userId]
    );
    return result.rows.length > 0 && result.rows[0].enabled === true;
  } catch (error) {
    console.error('❌ Erro ao verificar 2FA:', error.message);
    return false;
  }
};

// Obter secret do usuário (descriptografado)
const getUserTOTPSecret = async (userId) => {
  try {
    const result = await pool.query(
      'SELECT secret_encrypted FROM user_2fa WHERE user_id = $1 AND enabled = true',
      [userId]
    );
    
    if (result.rows.length === 0) return null;
    return decryptSecret(result.rows[0].secret_encrypted);
  } catch (error) {
    console.error('❌ Erro ao obter secret 2FA:', error.message);
    return null;
  }
};

// ==================== FIM FUNÇÕES DE 2FA ====================

  // ==================== TIMERS ====================
  setInterval(limparBloqueiosExpirados, 5 * 60 * 1000);
  setInterval(limparRefreshTokensExpirados, 60 * 60 * 1000);

  // ==================== ENDPOINTS ====================


// Registrar novo usuário

  return {
    verificarContaBloqueada, registrarTentativaLogin, limparBloqueiosExpirados,
    salvarRefreshToken, validarRefreshToken, revogarRefreshToken, revogarTodosTokens,
    limparRefreshTokensExpirados,
    verifyBackupCode, isCodeUsed, has2FAEnabled, getUserTOTPSecret
  };
}

module.exports = { createAuthHelpers };
