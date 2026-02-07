/**
 * MÓDULO AUTH - Routes
 * 24 endpoints: register, login, verify-token, refresh-token, logout,
 *               sessions(2), 2fa(6), users CRUD(5), password-recovery(4), setor(1)
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {
  LOGIN_CONFIG, REFRESH_SECRET,
  gerarToken, gerarRefreshToken, hashSenha, verificarSenha,
  encryptSecret, decryptSecret,
  generateTOTPSecret, verifyTOTP, generateTOTPUri, generateBackupCodes
} = require('./auth.service');

function createAuthRouter(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter) {
  const router = express.Router();
  const JWT_SECRET = process.env.JWT_SECRET;

  const handleError = (res, error, contexto, statusCode = 500) => {
    console.error(`❌ ${contexto}:`, error.message || error);
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
    const mensagemCliente = isProduction 
      ? 'Erro interno do servidor' 
      : `${contexto}: ${error.message || 'Erro desconhecido'}`;
    return res.status(statusCode).json({ 
      error: mensagemCliente,
      ref: Date.now().toString(36)
    });
  };

  const authLogger = { info: (...args) => console.log('🔐 [AUTH]', ...args) };
  const securityLogger = { securityEvent: (event, data) => console.log('🛡️ [SECURITY]', event, JSON.stringify(data)) };

  const validarSenhaForte = (senha) => {
    if (!senha || typeof senha !== 'string') {
      return { valido: false, erro: 'Senha é obrigatória' };
    }
    if (senha.length < 8) {
      return { valido: false, erro: 'Senha deve ter pelo menos 8 caracteres' };
    }
    if (!/[a-z]/.test(senha)) {
      return { valido: false, erro: 'Senha deve conter pelo menos uma letra minúscula' };
    }
    if (!/[A-Z]/.test(senha)) {
      return { valido: false, erro: 'Senha deve conter pelo menos uma letra maiúscula' };
    }
    if (!/[0-9]/.test(senha)) {
      return { valido: false, erro: 'Senha deve conter pelo menos um número' };
    }
    const senhasComuns = ['12345678', 'password', 'senha123', 'Senha123', 'Tutts123', 'Admin123'];
    if (senhasComuns.some(s => senha.toLowerCase() === s.toLowerCase())) {
      return { valido: false, erro: 'Senha muito comum. Escolha uma senha mais segura' };
    }
    return { valido: true };
  };

  // ==================== CONTROLE DE BLOQUEIO ====================

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
router.post('/users/register', createAccountLimiter, async (req, res) => {
  try {
    const { codProfissional, password, fullName, role } = req.body;

    // Validação de input
    if (!codProfissional || !password || !fullName) {
      return res.status(400).json({ error: 'Código profissional, senha e nome são obrigatórios' });
    }

    // Validar senha forte
    const validacaoSenha = validarSenhaForte(password);
    if (!validacaoSenha.valido) {
      return res.status(400).json({ error: validacaoSenha.erro });
    }

    console.log('📝 Tentando registrar:', { codProfissional, fullName, role });

    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (existingUser.rows.length > 0) {
      console.log('⚠️ Código profissional já existe');
      return res.status(400).json({ error: 'Código profissional já cadastrado' });
    }

    // role pode ser 'user', 'admin' ou 'admin_financeiro'
    const validRoles = ['user', 'admin', 'admin_financeiro'];
    const userRole = validRoles.includes(role) ? role : 'user';
    
    // Hash da senha
    const hashedPassword = await hashSenha(password);
    
    const result = await pool.query(
      `INSERT INTO users (cod_profissional, password, full_name, role, created_at) 
       VALUES ($1, $2, $3, $4, NOW()) 
       RETURNING id, cod_profissional, full_name, role, created_at`,
      [codProfissional, hashedPassword, fullName, userRole]
    );

    console.log('✅ Usuário registrado:', result.rows[0]);
    
    // Gerar token JWT para o novo usuário
    const token = gerarToken(result.rows[0]);
    
    res.status(201).json({
      ...result.rows[0],
      token
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao registrar usuário');
  }
});

// Login com rate limiting e bloqueio de conta
router.post('/users/login', loginLimiter, async (req, res) => {
  try {
    const { codProfissional, password } = req.body;

    if (!codProfissional || !password) {
      return res.status(400).json({ error: 'Código profissional e senha são obrigatórios' });
    }

    const clientIP = getClientIP(req);
    console.log('🔐 Tentando login:', codProfissional);

    // SEGURANÇA: Verificar se conta está bloqueada
    const bloqueio = await verificarContaBloqueada(codProfissional);
    if (bloqueio.bloqueada) {
      securityLogger.securityEvent('LOGIN_BLOCKED', {
        codProfissional,
        minutosRestantes: bloqueio.minutosRestantes,
        ip: clientIP
      });
      await registrarAuditoria(req, 'LOGIN_BLOCKED', AUDIT_CATEGORIES.AUTH, 'users', codProfissional, {
        motivo: bloqueio.motivo,
        minutosRestantes: bloqueio.minutosRestantes
      }, 'blocked');
      return res.status(429).json({ 
        error: `Conta temporariamente bloqueada. Tente novamente em ${bloqueio.minutosRestantes} minuto(s).`,
        bloqueada: true,
        minutosRestantes: bloqueio.minutosRestantes
      });
    }

    // Buscar usuário no banco
    const result = await pool.query(
      'SELECT id, cod_profissional, full_name, role, password, setor_id, COALESCE(allowed_modules, \'[]\') as allowed_modules, COALESCE(allowed_tabs, \'{}\') as allowed_tabs FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (result.rows.length === 0) {
      console.log('❌ Usuário não encontrado');
      // Registrar tentativa falha mesmo para usuário inexistente (previne enumeração)
      const tentativa = await registrarTentativaLogin(codProfissional, clientIP, false);
      if (tentativa.bloqueado) {
        return res.status(429).json({
          error: `Conta bloqueada por ${tentativa.minutosRestantes} minuto(s) devido a muitas tentativas falhas.`,
          bloqueada: true,
          minutosRestantes: tentativa.minutosRestantes
        });
      }
      return res.status(401).json({ 
        error: 'Credenciais inválidas',
        tentativasRestantes: tentativa.tentativasRestantes
      });
    }

    const user = result.rows[0];
    
    // Verificar senha com bcrypt
    // Suporte para senhas antigas (texto plano) e novas (hash)
    let senhaValida = false;
    
    if (user.password.startsWith('$2')) {
      // Senha já está em hash bcrypt
      senhaValida = await verificarSenha(password, user.password);
    } else {
      // Senha antiga em texto plano - comparar diretamente
      senhaValida = (user.password === password);
      
      // Se senha antiga válida, atualizar para bcrypt
      if (senhaValida) {
        const hashedPassword = await hashSenha(password);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
        console.log('🔄 Senha migrada para bcrypt:', user.cod_profissional);
      }
    }

    if (!senhaValida) {
      console.log('❌ Senha inválida');
      // Registrar tentativa de login falha e verificar bloqueio
      const tentativa = await registrarTentativaLogin(codProfissional, clientIP, false);
      await registrarAuditoria(req, 'LOGIN_FAILED', AUDIT_CATEGORIES.AUTH, 'users', codProfissional, { 
        motivo: 'Senha inválida',
        tentativas: tentativa.tentativas 
      }, 'failed');
      
      if (tentativa.bloqueado) {
        return res.status(429).json({
          error: `Conta bloqueada por ${tentativa.minutosRestantes} minuto(s) devido a muitas tentativas falhas.`,
          bloqueada: true,
          minutosRestantes: tentativa.minutosRestantes
        });
      }
      
      return res.status(401).json({ 
        error: 'Credenciais inválidas',
        tentativasRestantes: tentativa.tentativasRestantes
      });
    }

    // Login bem-sucedido - verificar se tem 2FA
    const tem2FA = await has2FAEnabled(user.id);
    
    if (tem2FA) {
      // Se tem 2FA, não completar login ainda - retornar status pendente
      authLogger.info('2FA requerido', { codProfissional: user.cod_profissional });
      
      // Gerar token temporário para completar 2FA (curta duração)
      const tempToken = jwt.sign(
        { id: user.id, codProfissional: user.cod_profissional, pending2FA: true },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      
      return res.json({
        requires2FA: true,
        tempToken,
        message: 'Verificação de dois fatores necessária'
      });
    }
    
    // Sem 2FA - login normal
    await registrarTentativaLogin(codProfissional, clientIP, true);

    // Remover senha do objeto antes de enviar
    delete user.password;

    // Gerar token JWT
    const token = gerarToken(user);

    // Registrar login bem-sucedido
    req.user = { id: user.id, codProfissional: user.cod_profissional, nome: user.full_name, role: user.role };
    await registrarAuditoria(req, 'LOGIN_SUCCESS', AUDIT_CATEGORIES.AUTH, 'users', user.id, { role: user.role });

    authLogger.info('Login bem-sucedido', { codProfissional: user.cod_profissional, role: user.role });
    
    // Gerar refresh token e salvar
    const refreshToken = gerarRefreshToken(user);
    await salvarRefreshToken(user.id, refreshToken, req);
    
    res.json({
      ...user,
      token,
      refreshToken,
      expiresIn: 3600 // 1 hora em segundos
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao fazer login');
  }
});

// Endpoint para verificar token
router.get('/users/verify-token', verificarToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Endpoint para renovar token usando refresh token
router.post('/users/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token é obrigatório' });
    }
    
    // Decodificar refresh token para pegar userId
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Refresh token expirado', expired: true });
      }
      return res.status(401).json({ error: 'Refresh token inválido' });
    }
    
    // Validar refresh token no banco
    const validacao = await validarRefreshToken(refreshToken, decoded.id);
    if (!validacao.valido) {
      return res.status(401).json({ error: validacao.erro });
    }
    
    // Buscar dados atualizados do usuário
    const result = await pool.query(
      `SELECT id, cod_profissional, full_name, role, setor_id, 
              COALESCE(allowed_modules, '[]') as allowed_modules, 
              COALESCE(allowed_tabs, '{}') as allowed_tabs 
       FROM users WHERE id = $1`,
      [decoded.id]
    );
    
    if (result.rows.length === 0) {
      // Revogar token se usuário não existe mais
      await revogarRefreshToken(validacao.tokenId);
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }
    
    const user = result.rows[0];
    
    // Gerar novo access token
    const newToken = gerarToken(user);
    
    // Opcionalmente, rotacionar refresh token (mais seguro)
    // const newRefreshToken = gerarRefreshToken(user);
    // await revogarRefreshToken(validacao.tokenId);
    // await salvarRefreshToken(user.id, newRefreshToken, req);
    
    console.log('🔄 Token renovado para:', user.cod_profissional);
    
    res.json({ 
      token: newToken,
      // refreshToken: newRefreshToken, // Descomente se rotacionar
      expiresIn: 3600,
      user: {
        id: user.id,
        cod_profissional: user.cod_profissional,
        full_name: user.full_name,
        role: user.role,
        setor_id: user.setor_id,
        allowed_modules: user.allowed_modules,
        allowed_tabs: user.allowed_tabs
      }
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao renovar token');
  }
});

// Endpoint para logout (revogar refresh token)
router.post('/users/logout', verificarToken, async (req, res) => {
  try {
    const { refreshToken, allDevices } = req.body;
    
    if (allDevices) {
      // Revogar todas as sessões
      const count = await revogarTodosTokens(req.user.id);
      await registrarAuditoria(req, 'LOGOUT_ALL', AUDIT_CATEGORIES.AUTH, 'users', req.user.id, {
        sessoes_revogadas: count
      });
      return res.json({ message: `Logout realizado em ${count} dispositivo(s)` });
    }
    
    if (refreshToken) {
      // Revogar apenas esta sessão
      const validacao = await validarRefreshToken(refreshToken, req.user.id);
      if (validacao.valido) {
        await revogarRefreshToken(validacao.tokenId);
      }
    }
    
    await registrarAuditoria(req, 'LOGOUT', AUDIT_CATEGORIES.AUTH, 'users', req.user.id);
    res.json({ message: 'Logout realizado com sucesso' });
  } catch (error) {
    return handleError(res, error, 'Erro ao fazer logout');
  }
});

// Endpoint para listar sessões ativas
router.get('/users/sessions', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, device_info, ip_address, created_at, expires_at
       FROM refresh_tokens 
       WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    
    res.json(result.rows.map(r => ({
      id: r.id,
      device: r.device_info,
      ip: r.ip_address,
      createdAt: r.created_at,
      expiresAt: r.expires_at
    })));
  } catch (error) {
    return handleError(res, error, 'Erro ao listar sessões');
  }
});

// Endpoint para revogar sessão específica
router.delete('/users/sessions/:id', verificarToken, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    
    // Verificar se a sessão pertence ao usuário
    const result = await pool.query(
      `SELECT id FROM refresh_tokens WHERE id = $1 AND user_id = $2 AND revoked = false`,
      [sessionId, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    await revogarRefreshToken(sessionId);
    await registrarAuditoria(req, 'SESSION_REVOKED', AUDIT_CATEGORIES.AUTH, 'refresh_tokens', sessionId);
    
    res.json({ message: 'Sessão revogada com sucesso' });
  } catch (error) {
    return handleError(res, error, 'Erro ao revogar sessão');
  }
});

// ==================== ENDPOINTS DE 2FA ====================

// Verificar se 2FA está habilitado para o usuário atual
router.get('/users/2fa/status', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT enabled, verified_at, array_length(backup_codes, 1) as backup_codes_remaining 
       FROM user_2fa WHERE user_id = $1`,
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.json({ enabled: false, configured: false });
    }
    
    const { enabled, verified_at, backup_codes_remaining } = result.rows[0];
    res.json({
      enabled,
      configured: true,
      verifiedAt: verified_at,
      backupCodesRemaining: backup_codes_remaining || 0
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao verificar status 2FA');
  }
});

// Iniciar configuração de 2FA (gerar secret e QR code)
router.post('/users/2fa/setup', verificarToken, async (req, res) => {
  try {
    // Verificar se já tem 2FA configurado e habilitado
    const existing = await pool.query(
      'SELECT enabled FROM user_2fa WHERE user_id = $1',
      [req.user.id]
    );
    
    if (existing.rows.length > 0 && existing.rows[0].enabled) {
      return res.status(400).json({ error: '2FA já está habilitado. Desabilite primeiro para reconfigurar.' });
    }
    
    // Gerar novo secret
    const secret = generateTOTPSecret();
    const secretEncrypted = encryptSecret(secret);
    
    // Gerar URI para QR code
    const uri = generateTOTPUri(secret, req.user.codProfissional, req.user.nome);
    
    // Salvar ou atualizar (não habilitado ainda)
    await pool.query(`
      INSERT INTO user_2fa (user_id, secret_encrypted, enabled)
      VALUES ($1, $2, false)
      ON CONFLICT (user_id) 
      DO UPDATE SET secret_encrypted = $2, enabled = false, updated_at = NOW()
    `, [req.user.id, secretEncrypted]);
    
    await registrarAuditoria(req, '2FA_SETUP_STARTED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    res.json({
      secret, // Mostrar para usuário digitar manualmente se preferir
      qrCodeUri: uri, // Para gerar QR code no frontend
      message: 'Escaneie o QR code com Google Authenticator ou outro app TOTP'
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao configurar 2FA');
  }
});

// Verificar e ativar 2FA (após escanear QR code)
router.post('/users/2fa/verify', verificarToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Código de 6 dígitos é obrigatório' });
    }
    
    // Buscar secret não verificado
    const result = await pool.query(
      'SELECT secret_encrypted FROM user_2fa WHERE user_id = $1 AND enabled = false',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Inicie a configuração do 2FA primeiro' });
    }
    
    // Descriptografar e verificar
    const secret = decryptSecret(result.rows[0].secret_encrypted);
    const isValid = verifyTOTP(secret, code);
    
    if (!isValid) {
      return res.status(400).json({ error: 'Código inválido. Tente novamente.' });
    }
    
    // Gerar códigos de backup
    const backupCodes = generateBackupCodes();
    const backupCodesHashed = backupCodes.map(c => 
      crypto.createHash('sha256').update(c).digest('hex')
    );
    
    // Ativar 2FA
    await pool.query(`
      UPDATE user_2fa 
      SET enabled = true, verified_at = NOW(), backup_codes = $1, updated_at = NOW()
      WHERE user_id = $2
    `, [backupCodesHashed, req.user.id]);
    
    await registrarAuditoria(req, '2FA_ENABLED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    securityLogger.securityEvent('2FA_ENABLED', { codProfissional: req.user.codProfissional });
    
    res.json({
      success: true,
      message: '2FA ativado com sucesso!',
      backupCodes, // Mostrar apenas UMA vez ao usuário
      warning: 'SALVE esses códigos de backup em local seguro. Eles não serão mostrados novamente!'
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao verificar 2FA');
  }
});

// Completar login com 2FA
router.post('/users/2fa/authenticate', async (req, res) => {
  try {
    const { tempToken, code, isBackupCode } = req.body;
    
    if (!tempToken || !code) {
      return res.status(400).json({ error: 'Token temporário e código são obrigatórios' });
    }
    
    // Verificar token temporário
    let decoded;
    try {
      decoded = jwt.verify(tempToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    
    if (!decoded.pending2FA) {
      return res.status(400).json({ error: 'Token inválido para 2FA' });
    }
    
    const userId = decoded.id;
    
    // Verificar se código já foi usado (replay attack)
    if (!isBackupCode && await isCodeUsed(userId, code)) {
      return res.status(400).json({ error: 'Código já utilizado. Aguarde o próximo código.' });
    }
    
    let isValid = false;
    let backupCodesRemaining = null;
    
    if (isBackupCode) {
      // Verificar código de backup
      const backupResult = await verifyBackupCode(userId, code);
      isValid = backupResult.valid;
      backupCodesRemaining = backupResult.codesRemaining;
    } else {
      // Verificar código TOTP
      const secret = await getUserTOTPSecret(userId);
      if (secret) {
        isValid = verifyTOTP(secret, code);
      }
    }
    
    if (!isValid) {
      await registrarAuditoria({ user: decoded }, '2FA_FAILED', AUDIT_CATEGORIES.AUTH, 'users', userId, {
        isBackupCode
      }, 'failed');
      return res.status(401).json({ error: 'Código inválido' });
    }
    
    // 2FA válido - completar login
    const userResult = await pool.query(
      `SELECT id, cod_profissional, full_name, role, setor_id, 
              COALESCE(allowed_modules, '[]') as allowed_modules, 
              COALESCE(allowed_tabs, '{}') as allowed_tabs 
       FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const user = userResult.rows[0];
    
    // Gerar tokens
    const token = gerarToken(user);
    const refreshToken = gerarRefreshToken(user);
    await salvarRefreshToken(user.id, refreshToken, req);
    
    await registrarAuditoria({ user }, 'LOGIN_2FA_SUCCESS', AUDIT_CATEGORIES.AUTH, 'users', user.id, {
      isBackupCode
    });
    
    authLogger.info('Login 2FA bem-sucedido', { codProfissional: user.cod_profissional, isBackupCode });
    
    const response = {
      ...user,
      token,
      refreshToken,
      expiresIn: 3600
    };
    
    // Avisar se restam poucos códigos de backup
    if (backupCodesRemaining !== null && backupCodesRemaining <= 2) {
      response.warning = `Atenção: Você tem apenas ${backupCodesRemaining} código(s) de backup restante(s). Considere gerar novos.`;
    }
    
    res.json(response);
  } catch (error) {
    return handleError(res, error, 'Erro na autenticação 2FA');
  }
});

// Desabilitar 2FA (requer senha atual)
router.post('/users/2fa/disable', verificarToken, async (req, res) => {
  try {
    const { password, code } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: 'Senha atual é obrigatória' });
    }
    
    // Verificar senha
    const userResult = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const senhaValida = await verificarSenha(password, userResult.rows[0].password);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    
    // Verificar código 2FA atual (se fornecido)
    if (code) {
      const secret = await getUserTOTPSecret(req.user.id);
      if (secret && !verifyTOTP(secret, code)) {
        return res.status(401).json({ error: 'Código 2FA incorreto' });
      }
    }
    
    // Desabilitar 2FA
    await pool.query(
      'DELETE FROM user_2fa WHERE user_id = $1',
      [req.user.id]
    );
    
    await registrarAuditoria(req, '2FA_DISABLED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    securityLogger.securityEvent('2FA_DISABLED', { codProfissional: req.user.codProfissional });
    
    res.json({ success: true, message: '2FA desabilitado com sucesso' });
  } catch (error) {
    return handleError(res, error, 'Erro ao desabilitar 2FA');
  }
});

// Regenerar códigos de backup
router.post('/users/2fa/backup-codes/regenerate', verificarToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Código 2FA atual é obrigatório' });
    }
    
    // Verificar se 2FA está habilitado
    const secret = await getUserTOTPSecret(req.user.id);
    if (!secret) {
      return res.status(400).json({ error: '2FA não está habilitado' });
    }
    
    // Verificar código atual
    if (!verifyTOTP(secret, code)) {
      return res.status(401).json({ error: 'Código 2FA incorreto' });
    }
    
    // Gerar novos códigos de backup
    const backupCodes = generateBackupCodes();
    const backupCodesHashed = backupCodes.map(c => 
      crypto.createHash('sha256').update(c).digest('hex')
    );
    
    await pool.query(
      'UPDATE user_2fa SET backup_codes = $1, updated_at = NOW() WHERE user_id = $2',
      [backupCodesHashed, req.user.id]
    );
    
    await registrarAuditoria(req, '2FA_BACKUP_CODES_REGENERATED', AUDIT_CATEGORIES.AUTH, 'user_2fa', req.user.id);
    
    res.json({
      success: true,
      backupCodes,
      warning: 'SALVE esses códigos de backup em local seguro. Os códigos anteriores foram invalidados!'
    });
  } catch (error) {
    return handleError(res, error, 'Erro ao regenerar códigos de backup');
  }
});

// ==================== FIM ENDPOINTS DE 2FA ====================

// Listar todos os usuários (APENAS ADMIN - protegido)
router.get('/users', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.cod_profissional, u.full_name, u.role, u.setor_id, u.created_at,
        s.nome as setor_nome, s.cor as setor_cor
      FROM users u
      LEFT JOIN setores s ON u.setor_id = s.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// Resetar senha
router.post('/users/reset-password', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { codProfissional, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
    }

    // Hash da nova senha
    const hashedPassword = await hashSenha(newPassword);

    const result = await pool.query(
      'UPDATE users SET password = $1 WHERE LOWER(cod_profissional) = LOWER($2) RETURNING id, cod_profissional, full_name',
      [hashedPassword, codProfissional]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    console.log(`🔐 Senha resetada para: ${codProfissional} por ${req.user.codProfissional}`);
    res.json({ message: 'Senha alterada com sucesso', user: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao resetar senha:', error);
    res.status(500).json({ error: 'Erro ao resetar senha' });
  }
});

// Alterar própria senha
router.post('/users/change-password', verificarToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
    }

    // Buscar usuário atual
    const userResult = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Verificar senha atual
    const senhaAtualValida = await verificarSenha(currentPassword, userResult.rows[0].password);
    if (!senhaAtualValida) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }

    // Hash da nova senha
    const hashedPassword = await hashSenha(newPassword);

    await pool.query(
      'UPDATE users SET password = $1 WHERE id = $2',
      [hashedPassword, req.user.id]
    );

    console.log(`🔐 Senha alterada pelo próprio usuário: ${req.user.codProfissional}`);
    res.json({ message: 'Senha alterada com sucesso' });
  } catch (error) {
    console.error('❌ Erro ao alterar senha:', error);
    res.status(500).json({ error: 'Erro ao alterar senha' });
  }
});

// Atualizar role do usuário (Admin Master APENAS)
// SEGURANÇA: Apenas admin_master pode alterar roles
router.patch('/users/:codProfissional/role', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode alterar roles
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Tentativa não autorizada de alterar role por: ${req.user.codProfissional} (${req.user.role})`);
      await registrarAuditoria(req, 'ROLE_CHANGE_DENIED', AUDIT_CATEGORIES.ADMIN, 'users', req.params.codProfissional, {
        tentativa_role: req.body.role,
        motivo: 'Usuário não é admin_master'
      }, 'failed');
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode alterar roles.' });
    }
    
    const { codProfissional } = req.params;
    const { role } = req.body;
    
    // Validar roles permitidos
    const rolesPermitidos = ['user', 'admin', 'admin_financeiro', 'admin_master'];
    if (!rolesPermitidos.includes(role)) {
      return res.status(400).json({ error: 'Role inválido' });
    }
    
    // Não permitir rebaixar a si mesmo de admin_master
    if (req.user.codProfissional === codProfissional && role !== 'admin_master') {
      return res.status(400).json({ error: 'Você não pode rebaixar seu próprio role de Admin Master' });
    }
    
    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE LOWER(cod_profissional) = LOWER($2) RETURNING id, cod_profissional, full_name, role',
      [role, codProfissional]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Registrar auditoria
    await registrarAuditoria(req, 'ROLE_CHANGE', AUDIT_CATEGORIES.ADMIN, 'users', result.rows[0].id, {
      cod_profissional: codProfissional,
      novo_role: role,
      alterado_por: req.user.codProfissional
    });
    
    console.log(`👑 Role atualizado: ${codProfissional} -> ${role} (por ${req.user.codProfissional})`);
    res.json({ message: 'Role atualizado com sucesso', user: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao atualizar role:', error);
    res.status(500).json({ error: 'Erro ao atualizar role' });
  }
});


// Deletar usuário (APENAS ADMIN_MASTER)
router.delete('/users/:codProfissional', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode deletar usuários
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Tentativa não autorizada de deletar usuário por: ${req.user.codProfissional}`);
      await registrarAuditoria(req, 'USER_DELETE_DENIED', AUDIT_CATEGORIES.USER, 'users', req.params.codProfissional, {
        motivo: 'Usuário não é admin_master'
      }, 'failed');
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode deletar usuários.' });
    }
    
    const { codProfissional } = req.params;
    
    // Não permitir deletar a si mesmo
    if (req.user.codProfissional.toLowerCase() === codProfissional.toLowerCase()) {
      return res.status(400).json({ error: 'Você não pode deletar sua própria conta' });
    }
    
    const deletedData = {
      user: null,
      submissions: 0,
      withdrawals: 0,
      gratuities: 0,
      indicacoes: 0,
      inscricoesNovatos: 0,
      quizRespostas: 0
    };
    
    // Função auxiliar para deletar de uma tabela (ignora se tabela não existe)
    const safeDelete = async (query, params) => {
      try {
        const result = await pool.query(query, params);
        return result.rowCount || 0;
      } catch (err) {
        // Ignora erro se tabela não existe
        if (err.code === '42P01') return 0; // undefined_table
        throw err;
      }
    };
    
    // 1. Deletar submissões (solicitações de saque)
    deletedData.submissions = await safeDelete(
      'DELETE FROM submissions WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 2. Deletar saques (withdrawals)
    deletedData.withdrawals = await safeDelete(
      'DELETE FROM withdrawal_requests WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 3. Deletar gratuidades
    deletedData.gratuities = await safeDelete(
      'DELETE FROM gratuities WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 4. Deletar indicações (onde é o indicador)
    deletedData.indicacoes = await safeDelete(
      'DELETE FROM indicacoes WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 5. Deletar inscrições em promoções novatos
    deletedData.inscricoesNovatos = await safeDelete(
      'DELETE FROM inscricoes_novatos WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 6. Deletar respostas do quiz de procedimentos
    deletedData.quizRespostas = await safeDelete(
      'DELETE FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 7. Por fim, deletar o usuário
    const userResult = await pool.query(
      'DELETE FROM users WHERE LOWER(cod_profissional) = LOWER($1) RETURNING *',
      [codProfissional]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    deletedData.user = userResult.rows[0];
    
    // Registrar auditoria
    await registrarAuditoria(req, 'USER_DELETE', AUDIT_CATEGORIES.USER, 'users', codProfissional, {
      nome: deletedData.user.full_name,
      role: deletedData.user.role,
      dados_excluidos: {
        submissions: deletedData.submissions,
        withdrawals: deletedData.withdrawals,
        gratuities: deletedData.gratuities,
        indicacoes: deletedData.indicacoes
      }
    });
    
    console.log(`🗑️ Usuário ${codProfissional} e todos os dados associados foram excluídos:`, deletedData);
    
    res.json({ 
      message: 'Usuário e todos os dados associados excluídos com sucesso', 
      deleted: deletedData 
    });
    
  } catch (error) {
    console.error('❌ Erro ao deletar usuário:', error);
    res.status(500).json({ error: 'Erro ao deletar usuário' });
  }
});

  // ==================== RECUPERAÇÃO DE SENHA ====================


// Solicitar recuperação de senha (público - com rate limit)
router.post('/password-recovery', loginLimiter, async (req, res) => {
  try {
    const { cod, name } = req.body;

    console.log('🔐 Solicitação de recuperação:', { cod, name });

    // Verificar se usuário existe
    const userResult = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [cod]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Código profissional não encontrado' });
    }

    const user = userResult.rows[0];

    // Verificar se o nome confere (para segurança)
    if (user.full_name.toLowerCase().trim() !== name.toLowerCase().trim()) {
      return res.status(400).json({ error: 'Nome não confere com o cadastro' });
    }

    // Verificar se já existe solicitação pendente
    const existingRequest = await pool.query(
      "SELECT * FROM password_recovery WHERE LOWER(user_cod) = LOWER($1) AND status = 'pendente'",
      [cod]
    );

    if (existingRequest.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma solicitação pendente para este código' });
    }

    // Criar solicitação
    const result = await pool.query(
      `INSERT INTO password_recovery (user_cod, user_name, status, created_at) 
       VALUES ($1, $2, 'pendente', NOW()) 
       RETURNING *`,
      [cod, name]
    );

    console.log('✅ Solicitação de recuperação criada:', result.rows[0]);
    res.status(201).json({ success: true, message: 'Solicitação enviada com sucesso' });
  } catch (error) {
    console.error('❌ Erro na recuperação de senha:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar solicitações de recuperação (APENAS ADMIN)
router.get('/password-recovery', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, user_cod, user_name, status, created_at, resolved_at, resolved_by FROM password_recovery ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar recuperações:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Resetar senha (APENAS ADMIN - com hash de senha)
router.patch('/password-recovery/:id/reset', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    console.log('🔐 Resetando senha, ID:', id, 'por:', req.user.codProfissional);

    // Validar senha
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
    }

    // Buscar solicitação
    const requestResult = await pool.query(
      'SELECT * FROM password_recovery WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }

    const request = requestResult.rows[0];

    // CRÍTICO: Fazer hash da senha antes de salvar!
    const hashedPassword = await hashSenha(newPassword);

    // Atualizar senha do usuário COM HASH
    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE LOWER(cod_profissional) = LOWER($2)',
      [hashedPassword, request.user_cod]
    );

    // Marcar solicitação como resolvida (NÃO salvar a senha em texto plano!)
    const result = await pool.query(
      `UPDATE password_recovery 
       SET status = 'resolvido', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING id, user_cod, user_name, status, resolved_at, resolved_by`,
      [req.user.nome || req.user.codProfissional, id]
    );

    // Registrar auditoria
    await registrarAuditoria(req, 'PASSWORD_RESET', AUDIT_CATEGORIES.AUTH, 'users', request.user_cod, {
      solicitacao_id: id,
      admin: req.user.codProfissional
    });

    console.log('✅ Senha resetada com sucesso por:', req.user.codProfissional);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao resetar senha:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Cancelar solicitação (APENAS ADMIN)
router.delete('/password-recovery/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM password_recovery WHERE id = $1 RETURNING id, user_cod, user_name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }

    // Registrar auditoria
    await registrarAuditoria(req, 'PASSWORD_RECOVERY_DELETE', AUDIT_CATEGORIES.AUTH, 'password_recovery', id, {
      user_cod: result.rows[0].user_cod,
      admin: req.user.codProfissional
    });

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar solicitação:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});


  // ==================== SETOR DO USUÁRIO ====================

router.patch('/users/:codProfissional/setor', async (req, res) => {
  try {
    const { codProfissional } = req.params;
    const { setor_id } = req.body;
    
    const result = await pool.query(`
      UPDATE users 
      SET setor_id = $1, updated_at = NOW()
      WHERE LOWER(cod_profissional) = LOWER($2)
      RETURNING id, cod_profissional, full_name, setor_id
    `, [setor_id || null, codProfissional]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar setor do usuário:', err);
    res.status(500).json({ error: 'Erro ao atualizar setor' });
  }
});


  return router;
}

module.exports = { createAuthRouter };
