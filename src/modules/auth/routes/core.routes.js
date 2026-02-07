/**
 * Sub-Router: Auth Core (register, login, verify, refresh, logout, sessions, 2FA)
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  gerarToken, gerarRefreshToken, hashSenha, verificarSenha,
  generateTOTPSecret, verifyTOTP, generateTOTPUri, generateBackupCodes
} = require('../auth.service');

function createAuthCoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter, helpers) {
  const router = express.Router();
  const { verificarContaBloqueada, registrarTentativaLogin, salvarRefreshToken, validarRefreshToken, revogarRefreshToken, revogarTodosTokens, verifyBackupCode, isCodeUsed, has2FAEnabled, getUserTOTPSecret } = helpers;

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

  return router;
}

module.exports = { createAuthCoreRoutes };
