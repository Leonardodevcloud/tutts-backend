/**
 * MÓDULO FINANCIAL - Routes
 * 31 endpoints: financial(5), withdrawals(12), gratuities(4), restricted(4), plific(6)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

function createFinancialRouter(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP) {
  const router = express.Router();

  // ==================== SUB-ROUTER: STARK BANK ====================
  const { createStarkRoutes } = require('./routes/stark.routes');
  const starkRouter = createStarkRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES);
  router.use('/', starkRouter);

  // ==================== SUB-ROUTER: ACERTO PROFISSIONAL ====================
  const { createAcertoRoutes } = require('./routes/acerto.routes');
  const acertoRouter = createAcertoRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES);
  router.use('/', acertoRouter);

  // Rate limiter para saques
  const withdrawalCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Limite de solicitações de saque atingido. Tente novamente em 1 hora.' },
    keyGenerator: (req) => {
      if (req.user && req.user.codProfissional) {
        return `withdrawal_${req.user.codProfissional}`;
      }
      return getClientIP(req);
    }
  });

  // ==================== PLIFIC CONFIG ====================

  const PLIFIC_CONFIG = {
    BASE_URL_TESTE: 'https://mototaxionline.com/sem/v1/rotas.php/integracao-plific-saldo-prof',
    BASE_URL_PRODUCAO: 'https://tutts.com.br/sem/v1/rotas.php/integracao-plific-saldo-prof',
    RATE_LIMIT: 10,
    RATE_LIMIT_WINDOW: 1000,
    CACHE_TTL: 1 * 60 * 1000
  };

  const PLIFIC_AMBIENTE = process.env.PLIFIC_AMBIENTE || 'teste';
  const PLIFIC_BASE_URL = PLIFIC_AMBIENTE === 'producao' ? PLIFIC_CONFIG.BASE_URL_PRODUCAO : PLIFIC_CONFIG.BASE_URL_TESTE;
  const PLIFIC_TOKEN = process.env.PLIFIC_TOKEN;

  // 🔒 SECURITY FIX (HIGH-09): Fetch com timeout para evitar conexões penduradas
  async function plificFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  const plificSaldoCache = new Map();
  const PLIFIC_CACHE_MAX_SIZE = 500; // 🔒 SECURITY FIX (MED-04): Limite de tamanho do cache

  const limparCachePlific = () => {
    const agora = Date.now();
    for (const [key, value] of plificSaldoCache.entries()) {
      if (agora - value.timestamp > PLIFIC_CONFIG.CACHE_TTL) {
        plificSaldoCache.delete(key);
      }
    }
    // 🔒 Se ainda passou do limite, remover os mais antigos
    if (plificSaldoCache.size > PLIFIC_CACHE_MAX_SIZE) {
      const entries = [...plificSaldoCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, plificSaldoCache.size - PLIFIC_CACHE_MAX_SIZE);
      for (const [key] of toRemove) plificSaldoCache.delete(key);
    }
  };

  setInterval(limparCachePlific, PLIFIC_CONFIG.CACHE_TTL);

  // ==================== FINANCIAL / WITHDRAWALS / GRATUITIES / RESTRICTED ====================

router.get('/financial/check-terms/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // SEGURANÇA: Apenas o próprio usuário ou admin pode verificar
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT terms_accepted FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    res.json({ 
      hasAccepted: result.rows.length > 0 && result.rows[0].terms_accepted,
      hasData: result.rows.length > 0
    });
  } catch (error) {
    console.error('❌ Erro ao verificar termos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Aceitar termos (protegido - apenas próprio usuário)
router.post('/financial/accept-terms', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.body;
    
    // SEGURANÇA: Apenas o próprio usuário pode aceitar seus termos
    if (req.user.codProfissional !== userCod) {
      console.log(`⚠️ [SEGURANÇA] Tentativa de aceitar termos para outro usuário: ${req.user.codProfissional} -> ${userCod}`);
      return res.status(403).json({ error: 'Você só pode aceitar termos para sua própria conta' });
    }
    
    // Verificar se já existe registro
    const existing = await pool.query(
      'SELECT id FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE user_financial_data SET terms_accepted = true, terms_accepted_at = NOW() WHERE user_cod = $1',
        [userCod]
      );
    } else {
      await pool.query(
        `INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key, terms_accepted, terms_accepted_at) 
         VALUES ($1, '', '', '', true, NOW())`,
        [userCod]
      );
    }

    // Log
    await pool.query(
      'INSERT INTO financial_logs (user_cod, action, new_value) VALUES ($1, $2, $3)',
      [userCod, 'ACEITE_TERMOS', 'Termos aceitos']
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao aceitar termos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter dados financeiros do usuário (PROTEGIDO - dados sensíveis)
router.get('/financial/data/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // CRÍTICO: Dados financeiros são sensíveis (CPF, PIX)
    // Apenas o próprio usuário ou admin podem acessar
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        console.log(`⚠️ [SEGURANÇA] Acesso negado a dados financeiros: ${req.user.codProfissional} tentou acessar ${userCod}`);
        return res.status(403).json({ error: 'Acesso negado aos dados financeiros' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (result.rows.length === 0) {
      return res.json({ data: null });
    }

    // 🔒 SECURITY FIX (CRIT-04): Mascarar dados sensíveis na resposta
    // Admin recebe dados completos para operações, profissional recebe mascarado
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
    const row = result.rows[0];
    
    if (!isAdmin) {
      // Mascarar CPF: ***456**89
      if (row.cpf) row.cpf = '***' + row.cpf.slice(3, 6) + '**' + row.cpf.slice(-2);
      // Mascarar chave Pix
      if (row.pix_key) {
        if (row.pix_tipo === 'email' && row.pix_key.includes('@')) {
          const parts = row.pix_key.split('@');
          row.pix_key = parts[0].slice(0, 3) + '***@' + parts[1];
        } else {
          row.pix_key = row.pix_key.slice(0, 4) + '***' + row.pix_key.slice(-3);
        }
      }
    }

    res.json({ data: row });
  } catch (error) {
    console.error('❌ Erro ao obter dados financeiros:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Salvar/Atualizar dados financeiros (PROTEGIDO)
router.post('/financial/data', verificarToken, async (req, res) => {
  try {
    const { userCod, fullName, cpf, pixKey, pixTipo } = req.body;
    
    // SEGURANÇA: Apenas o próprio usuário pode alterar seus dados financeiros
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        console.log(`⚠️ [SEGURANÇA] Tentativa de alterar dados financeiros de outro usuário: ${req.user.codProfissional} -> ${userCod}`);
        return res.status(403).json({ error: 'Você só pode alterar seus próprios dados financeiros' });
      }
    }
    
    // ==================== VALIDAÇÃO DE INPUTS ====================
    
    // Validar nome (não vazio, sem caracteres especiais perigosos)
    if (!fullName || fullName.trim().length < 3) {
      return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });
    }
    if (fullName.length > 255) {
      return res.status(400).json({ error: 'Nome muito longo (máx 255 caracteres)' });
    }
    // Sanitizar nome - remover caracteres potencialmente perigosos
    const nomeSeguro = fullName.replace(/[<>\"'%;()&+]/g, '').trim();
    
    // Validação completa de CPF
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      return res.status(400).json({ error: 'CPF deve ter 11 dígitos. Verifique se digitou corretamente.' });
    }
    // Verificar se não é CPF com todos dígitos iguais
    if (/^(\d)\1{10}$/.test(cpfLimpo)) {
      return res.status(400).json({ error: 'CPF inválido. Não é permitido CPF com todos os dígitos iguais.' });
    }
    // Validar dígitos verificadores do CPF
    const validarCPF = (cpf) => {
      let soma = 0, resto;
      for (let i = 1; i <= 9; i++) soma += parseInt(cpf.substring(i-1, i)) * (11 - i);
      resto = (soma * 10) % 11;
      if (resto === 10 || resto === 11) resto = 0;
      if (resto !== parseInt(cpf.substring(9, 10))) return false;
      soma = 0;
      for (let i = 1; i <= 10; i++) soma += parseInt(cpf.substring(i-1, i)) * (12 - i);
      resto = (soma * 10) % 11;
      if (resto === 10 || resto === 11) resto = 0;
      if (resto !== parseInt(cpf.substring(10, 11))) return false;
      return true;
    };
    if (!validarCPF(cpfLimpo)) {
      return res.status(400).json({ error: 'CPF inválido. Por favor, verifique se digitou os números corretamente.' });
    }
    
    // Validar chave PIX baseado no tipo
    const tiposPix = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'];
    const tipoPixSeguro = tiposPix.includes(pixTipo) ? pixTipo : 'cpf';
    
    if (!pixKey || pixKey.trim().length === 0) {
      return res.status(400).json({ error: 'Chave PIX é obrigatória' });
    }
    
    const pixKeyLimpo = pixKey.trim();
    if (tipoPixSeguro === 'cpf') {
      const pixCpfLimpo = pixKeyLimpo.replace(/\D/g, '');
      if (pixCpfLimpo.length !== 11) {
        return res.status(400).json({ error: 'Chave PIX CPF deve ter 11 dígitos' });
      }
    } else if (tipoPixSeguro === 'cnpj') {
      const pixCnpjLimpo = pixKeyLimpo.replace(/\D/g, '');
      if (pixCnpjLimpo.length !== 14) {
        return res.status(400).json({ error: 'Chave PIX CNPJ deve ter 14 dígitos' });
      }
    } else if (tipoPixSeguro === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(pixKeyLimpo)) {
        return res.status(400).json({ error: 'Chave PIX Email inválida' });
      }
    } else if (tipoPixSeguro === 'telefone') {
      const telLimpo = pixKeyLimpo.replace(/\D/g, '');
      if (telLimpo.length < 10 || telLimpo.length > 11) {
        return res.status(400).json({ error: 'Chave PIX Telefone inválida' });
      }
    } else if (tipoPixSeguro === 'aleatoria') {
      if (pixKeyLimpo.length !== 32 && pixKeyLimpo.length !== 36) {
        return res.status(400).json({ error: 'Chave PIX aleatória deve ter 32 ou 36 caracteres' });
      }
    }
    
    // ==================== FIM VALIDAÇÃO ====================
    
    // Verificar se já existe
    const existing = await pool.query(
      'SELECT * FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (existing.rows.length > 0) {
      const oldData = existing.rows[0];
      
      await pool.query(
        `UPDATE user_financial_data 
         SET full_name = $1, cpf = $2, pix_key = $3, pix_tipo = $4, updated_at = NOW() 
         WHERE user_cod = $5`,
        [nomeSeguro, cpfLimpo, pixKeyLimpo, tipoPixSeguro, userCod]
      );

      // Log de alterações
      if (oldData.full_name !== nomeSeguro) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_NOME', oldData.full_name, nomeSeguro]
        );
      }
      if (oldData.cpf !== cpfLimpo) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_CPF', '***' + oldData.cpf?.slice(-4), '***' + cpfLimpo.slice(-4)]
        );
      }
      if (oldData.pix_key !== pixKeyLimpo) {
        // 🔒 SECURITY FIX (CRIT-07): Mascarar chave Pix nos logs
        const pixOldMask = oldData.pix_key ? oldData.pix_key.slice(0, 4) + '***' + oldData.pix_key.slice(-3) : '***';
        const pixNewMask = pixKeyLimpo ? pixKeyLimpo.slice(0, 4) + '***' + pixKeyLimpo.slice(-3) : '***';
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_PIX', pixOldMask, pixNewMask]
        );
      }
    } else {
      // 🔒 SECURITY FIX (CRIT-05): Usar dados sanitizados no INSERT (nomeSeguro, cpfLimpo, pixKeyLimpo)
      await pool.query(
        `INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key, pix_tipo, terms_accepted) 
         VALUES ($1, $2, $3, $4, $5, true)`,
        [userCod, nomeSeguro, cpfLimpo, pixKeyLimpo, tipoPixSeguro]
      );

      await pool.query(
        'INSERT INTO financial_logs (user_cod, action, new_value) VALUES ($1, $2, $3)',
        [userCod, 'CADASTRO_DADOS', 'Dados financeiros cadastrados']
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar dados financeiros:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter logs de alterações financeiras (PROTEGIDO)
router.get('/financial/logs/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // SEGURANÇA: Apenas o próprio usuário ou admin podem ver logs
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado aos logs financeiros' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM financial_logs WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao obter logs:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================
// SOLICITAÇÕES DE SAQUE
// ============================================

// ==================== NOVO: Endpoint otimizado - Apenas Pendentes ====================
router.get('/withdrawals/pendentes', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, 
        CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
        r.reason as restriction_reason,
        EXTRACT(EPOCH FROM (NOW() - w.created_at))/3600 as horas_aguardando
      FROM withdrawal_requests w
      LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
      WHERE w.status IN ('pending', 'aguardando_aprovacao', 'aguardando_pagamento_stark')
      ORDER BY w.created_at ASC
    `);
    
    const withdrawals = result.rows.map(w => ({
      ...w,
      isDelayed: parseFloat(w.horas_aguardando) > 1
    }));
    
    console.log(`📋 [withdrawals/pendentes] Retornando ${withdrawals.length} saques pendentes`);
    res.json(withdrawals);
  } catch (error) {
    console.error('❌ Erro ao listar saques pendentes:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== NOVO: Contadores (ultra leve) ====================
router.get('/withdrawals/contadores', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('pending', 'aguardando_aprovacao', 'aguardando_pagamento_stark')) as pendentes,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')) as aprovados,
        COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitados,
        COUNT(*) as total
      FROM withdrawal_requests
    `);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao obter contadores:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== NOVO: Histórico paginado ====================
router.get('/withdrawals/historico', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, user_cod, data_inicio, data_fim } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let whereConditions = [];
    
    if (status) {
      params.push(status);
      whereConditions.push(`w.status = $${params.length}`);
    } else {
      whereConditions.push(`w.status NOT IN ('pending', 'aguardando_aprovacao', 'aguardando_pagamento_stark')`);
    }
    
    if (user_cod) {
      params.push(user_cod);
      whereConditions.push(`w.user_cod = $${params.length}`);
    }
    
    if (data_inicio) {
      params.push(data_inicio);
      whereConditions.push(`w.created_at >= $${params.length}::date`);
    }
    
    if (data_fim) {
      params.push(data_fim);
      whereConditions.push(`w.created_at <= $${params.length}::date + interval '1 day'`);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    const result = await pool.query(`
      SELECT w.*, 
        CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
        r.reason as restriction_reason
      FROM withdrawal_requests w
      LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
      ${whereClause}
      ORDER BY w.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(limit), offset]);
    
    const countResult = await pool.query(`SELECT COUNT(*) as total FROM withdrawal_requests w ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / parseInt(limit));
    
    res.json({
      data: result.rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages, hasNext: parseInt(page) < totalPages, hasPrev: parseInt(page) > 1 }
    });
  } catch (error) {
    console.error('❌ Erro ao listar histórico:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Criar solicitação de saque
router.post('/withdrawals', verificarToken, withdrawalCreateLimiter, async (req, res) => {
  const client = await pool.connect(); // 🔒 SECURITY FIX: Transação atômica para gratuidade
  
  try {
    const { userCod, userName, cpf, pixKey, requestedAmount } = req.body;

    // ==================== 🔒 SECURITY FIX: VALIDAÇÃO DE VALOR ====================
    const valorSaque = parseFloat(requestedAmount);
    if (!requestedAmount || isNaN(valorSaque) || !isFinite(valorSaque)) {
      client.release();
      return res.status(400).json({ error: 'Valor de saque inválido. Informe um número válido.' });
    }
    if (valorSaque <= 0) {
      client.release();
      return res.status(400).json({ error: 'Valor de saque deve ser positivo.' });
    }
    if (valorSaque < 10) {
      client.release();
      return res.status(400).json({ error: 'Valor mínimo de saque é R$ 10,00.' });
    }
    if (valorSaque > 1000) {
      client.release();
      return res.status(400).json({ error: 'Valor máximo de saque é R$ 1.000,00. Para valores maiores, entre em contato com o financeiro.' });
    }
    // Arredondar para 2 casas decimais para evitar problemas de float
    const valorArredondado = Math.round(valorSaque * 100) / 100;
    // ==================== FIM VALIDAÇÃO DE VALOR ====================

    // Validar que o usuário só pode criar saque para si mesmo (exceto admin)
    if (req.user.role !== 'admin' && req.user.role !== 'admin_master' && req.user.role !== 'admin_financeiro') {
      if (req.user.codProfissional !== userCod) {
        console.log(`⚠️ [SEGURANÇA] Tentativa de criar saque para outro usuário: ${req.user.codProfissional} tentou criar para ${userCod}`);
        client.release();
        return res.status(403).json({ error: 'Você só pode criar saques para sua própria conta' });
      }
    }

    // 🔒 SECURITY FIX: Validar campos obrigatórios
    if (!userCod || !userName || !cpf || !pixKey) {
      client.release();
      return res.status(400).json({ error: 'Campos obrigatórios: userCod, userName, cpf, pixKey' });
    }

    // ==================== INÍCIO DA TRANSAÇÃO ====================
    await client.query('BEGIN');

    // Verificar se está restrito
    const restricted = await client.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );
    const isRestricted = restricted.rows.length > 0;

    // 🔒 SECURITY FIX: Verificar gratuidade COM LOCK (FOR UPDATE) para evitar race condition
    const gratuity = await client.query(
      "SELECT * FROM gratuities WHERE user_cod = $1 AND status = 'ativa' AND remaining > 0 ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
      [userCod]
    );
    
    const hasGratuity = gratuity.rows.length > 0;
    let gratuityId = null;
    let feeAmount = valorArredondado * 0.045; // 4.5%
    let finalAmount = valorArredondado - feeAmount;
    // Arredondar valores calculados
    feeAmount = Math.round(feeAmount * 100) / 100;
    finalAmount = Math.round(finalAmount * 100) / 100;

    if (hasGratuity) {
      gratuityId = gratuity.rows[0].id;
      feeAmount = 0;
      finalAmount = valorArredondado;

      // 🔒 SECURITY FIX: Decrementar gratuidade DENTRO da transação
      const newRemaining = gratuity.rows[0].remaining - 1;
      if (newRemaining <= 0) {
        await client.query(
          "UPDATE gratuities SET remaining = 0, status = 'expirada', expired_at = NOW() WHERE id = $1",
          [gratuityId]
        );
      } else {
        await client.query(
          'UPDATE gratuities SET remaining = $1 WHERE id = $2',
          [newRemaining, gratuityId]
        );
      }
    }

    // 🔒 SECURITY FIX: Verificar saque duplicado recente (mesmo profissional, mesmo valor, últimos 5 minutos)
    const saqueDuplicado = await client.query(
      `SELECT id FROM withdrawal_requests 
       WHERE user_cod = $1 AND requested_amount = $2 
       AND created_at > NOW() - INTERVAL '5 minutes'
       AND status NOT IN ('rejeitado', 'cancelado')`,
      [userCod, valorArredondado]
    );
    if (saqueDuplicado.rows.length > 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ 
        error: 'Saque duplicado detectado. Você já solicitou este valor nos últimos 5 minutos.',
        saque_existente_id: saqueDuplicado.rows[0].id
      });
    }

    const result = await client.query(
      `INSERT INTO withdrawal_requests 
       (user_cod, user_name, cpf, pix_key, requested_amount, fee_amount, final_amount, has_gratuity, gratuity_id, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aguardando_aprovacao') 
       RETURNING *`,
      [userCod, userName, cpf, pixKey, valorArredondado, feeAmount, finalAmount, hasGratuity, gratuityId]
    );

    // COMMIT da transação (gratuidade + saque atômicos)
    await client.query('COMMIT');
    client.release();

    const novoSaque = result.rows[0];

    // ==================== AUTO DÉBITO PLIFIC (ao receber solicitação) ====================
    // Tenta debitar automaticamente na Plific. Se OK → aguardando_pagamento_stark.
    // Se falhar → mantém aguardando_aprovacao para admin resolver manualmente.
    try {
      const valorDebito = valorArredondado; // 🔒 Já validado acima
      const idProf = userCod;
      const descricaoDebito = hasGratuity
        ? 'Saque Emergencial - Gratuito'
        : 'Saque emergencial - Prestação de Serviços';
      const dataDebitoFormatada = new Date().toISOString().split('T')[0];

      console.log(`💳 [Auto-Débito] Iniciando para saque #${novoSaque.id} - Prof: ${idProf}, Valor: R$ ${valorDebito}`);

      const responseDebito = await plificFetch(`${PLIFIC_BASE_URL}/lancarDebitoProfissional`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PLIFIC_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          idProf: parseInt(idProf),
          valor: valorDebito,
          descricao: descricaoDebito,
          data: dataDebitoFormatada
        })
      });

      const respostaDebito = await responseDebito.json();

      if (respostaDebito.status === '200' || respostaDebito.status === 200) {
        // ✅ Débito OK → status aguardando_pagamento_stark
        await pool.query(
          `UPDATE withdrawal_requests 
           SET status = 'aguardando_pagamento_stark', 
               debito = true, 
               debito_plific_at = NOW(),
               debito_erro = NULL,
               updated_at = NOW() 
           WHERE id = $1`,
          [novoSaque.id]
        );
        novoSaque.status = 'aguardando_pagamento_stark';
        novoSaque.debito = true;
        novoSaque.debito_plific_at = new Date().toISOString();

        // Limpar cache de saldo do profissional
        const cacheKey = `saldo_${idProf}`;
        plificSaldoCache.delete(cacheKey);

        console.log(`✅ [Auto-Débito] OK para saque #${novoSaque.id} (Prof: ${idProf}) → aguardando_pagamento_stark`);
      } else {
        // ❌ Débito FALHOU → sinalizar na coluna debito + debito_erro
        const erroMsg = respostaDebito.msgUsuario || respostaDebito.dados?.msg || 'Falha no débito Plific';
        await pool.query(
          `UPDATE withdrawal_requests 
           SET debito = false, 
               debito_erro = $1, 
               updated_at = NOW() 
           WHERE id = $2`,
          [erroMsg.substring(0, 500), novoSaque.id]
        );
        novoSaque.debito = false;
        novoSaque.debito_erro = erroMsg;

        console.error(`❌ [Auto-Débito] FALHOU saque #${novoSaque.id} (Prof: ${idProf}): ${erroMsg}`);
      }
    } catch (erroDebito) {
      // ❌ Exceção (timeout, rede, etc) → sinalizar falha
      const erroMsg = (erroDebito.message || 'Erro de conexão com Plific').substring(0, 500);
      await pool.query(
        `UPDATE withdrawal_requests 
         SET debito = false, 
             debito_erro = $1, 
             updated_at = NOW() 
         WHERE id = $2`,
        [erroMsg, novoSaque.id]
      ).catch(e => console.error('❌ Erro ao registrar falha do auto-débito:', e.message));
      novoSaque.debito = false;
      novoSaque.debito_erro = erroMsg;

      console.error(`❌ [Auto-Débito] Exceção saque #${novoSaque.id}: ${erroMsg}`);
    }
    // ==================== FIM AUTO DÉBITO PLIFIC ====================

    // Registrar auditoria
    await registrarAuditoria(req, 'WITHDRAWAL_CREATE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', novoSaque.id, {
      valor: valorArredondado,
      taxa: feeAmount,
      valor_final: finalAmount,
      gratuidade: hasGratuity,
      restrito: isRestricted,
      auto_debito: novoSaque.debito === true ? 'ok' : 'falha',
      status_final: novoSaque.status
    });

    // ==================== NOTIFICAR VIA WEBSOCKET ====================
    if (global.notifyNewWithdrawal) {
      global.notifyNewWithdrawal(novoSaque);
    }

    res.status(201).json({ 
      ...novoSaque, 
      isRestricted 
    });
  } catch (error) {
    // 🔒 SECURITY FIX: Rollback da transação se ainda estiver ativa
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore - pode já ter sido committed */ }
    try { client.release(); } catch (e) { /* ignore - pode já ter sido released */ }
    console.error('❌ Erro ao criar saque:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});
router.get('/withdrawals/user/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // Usuário só pode ver seus próprios saques (exceto admin)
    if (req.user.role !== 'admin' && req.user.role !== 'admin_master' && req.user.role !== 'admin_financeiro') {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    // Adicionar verificação de atraso (mais de 1 hora)
    const now = new Date();
    const withdrawals = result.rows.map(w => {
      const createdAt = new Date(w.created_at);
      const diffMs = now - createdAt;
      const diffHours = diffMs / (1000 * 60 * 60);
      
      return {
        ...w,
        isDelayed: (w.status === 'aguardando_aprovacao' || w.status === 'aguardando_pagamento_stark') && diffHours > 1
      };
    });

    res.json(withdrawals);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar todos os saques (admin financeiro)
router.get('/withdrawals', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status, limit, dataInicio, dataFim, tipoFiltro } = req.query;
    // Com filtro de data: sem limite (retorna tudo do período)
    // Sem filtro de data: máximo 200 para performance
    const comFiltroData = !!(dataInicio && dataFim);
    const limiteFiltro = comFiltroData ? null : Math.min(parseInt(limit) || 200, 200);
    
    let query, params;
    
    // Caso 1: Filtro por data (aba validação) — SEM LIMIT
    if (comFiltroData) {
      const coluna = tipoFiltro === 'lancamento' ? 'w.lancamento_at' 
                   : tipoFiltro === 'debito' ? 'w.debito_plific_at' 
                   : 'w.created_at';
      
      if (status) {
        query = `
          SELECT w.*, 
            CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
            r.reason as restriction_reason
          FROM withdrawal_requests w
          LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
          WHERE w.status = $1 AND ${coluna} >= $2::date AND ${coluna} < ($3::date + INTERVAL '1 day')
          ORDER BY w.created_at DESC
        `;
        params = [status, dataInicio, dataFim];
      } else {
        query = `
          SELECT w.*, 
            CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
            r.reason as restriction_reason
          FROM withdrawal_requests w
          LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
          WHERE ${coluna} >= $1::date AND ${coluna} < ($2::date + INTERVAL '1 day')
          ORDER BY w.created_at DESC
        `;
        params = [dataInicio, dataFim];
      }
    }
    // Caso 2: Filtro por status (sem data)
    else if (status) {
      query = `
        SELECT w.*, 
          CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
          r.reason as restriction_reason
        FROM withdrawal_requests w
        LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
        WHERE w.status = $1
        ORDER BY w.created_at DESC
        LIMIT $2
      `;
      params = [status, limiteFiltro];
    }
    // Caso 3: Sem filtro
    else {
      query = `
        SELECT w.*, 
          CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
          r.reason as restriction_reason
        FROM withdrawal_requests w
        LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
        ORDER BY w.created_at DESC
        LIMIT $1
      `;
      params = [limiteFiltro];
    }

    console.log('📋 Withdrawals query:', { status, dataInicio, dataFim, tipoFiltro, limiteFiltro, comFiltroData });
    const result = await pool.query(query, params);
    console.log(`📋 Withdrawals retornados: ${result.rows.length} (sem limit: ${comFiltroData})`);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar status do saque - COM PROTEÇÃO CONTRA DÉBITO DUPLICADO
router.patch('/withdrawals/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  const client = await pool.connect(); // Usar transação para atomicidade
  
  try {
    const { id } = req.params;
    const { status, adminId, adminName, rejectReason, dataDebito, idempotencyKey } = req.body;
    
    console.log('📅 dataDebito recebido do frontend:', dataDebito);
    console.log('🔑 idempotencyKey:', idempotencyKey);

    // =============== PROTEÇÃO 1: VERIFICAR IDEMPOTÊNCIA ===============
    // Se uma chave de idempotência foi enviada, verificar se já foi processada
    if (idempotencyKey) {
      const idempotenciaExistente = await client.query(
        `SELECT * FROM withdrawal_idempotency WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      
      if (idempotenciaExistente.rows.length > 0) {
        console.log(`⚠️ Requisição duplicada detectada! Key: ${idempotencyKey}`);
        // Retornar a resposta anterior (idempotência)
        return res.status(200).json({
          ...idempotenciaExistente.rows[0].response_data,
          _idempotent: true,
          _message: 'Requisição já processada anteriormente'
        });
      }
    }

    // Iniciar transação
    await client.query('BEGIN');

    // =============== PROTEÇÃO 2: LOCK PARA EVITAR RACE CONDITION ===============
    // Buscar dados do saque COM LOCK (FOR UPDATE)
    const saqueAtual = await client.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    
    if (saqueAtual.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Saque não encontrado' });
    }
    
    const dadosSaque = saqueAtual.rows[0];
    const isAprovado = status === 'aprovado' || status === 'aprovado_gratuidade';

    // =============== PROTEÇÃO 3: VERIFICAR STATUS ANTERIOR ===============
    // Só permitir aprovar se estiver aguardando ou aguardando_pagamento_stark
    if (isAprovado) {
      // Verificar se já está aprovado
      if (dadosSaque.status === 'aprovado' || dadosSaque.status === 'aprovado_gratuidade') {
        console.log(`⚠️ Tentativa de aprovar saque já aprovado! ID: ${id}, Status atual: ${dadosSaque.status}`);
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'Este saque já foi aprovado anteriormente',
          status_atual: dadosSaque.status,
          aprovado_em: dadosSaque.approved_at
        });
      }
      
      // Verificar se já tem débito registrado — MAS permitir se veio do auto-débito (status aguardando_pagamento_stark)
      if (dadosSaque.debito_plific_at && dadosSaque.status !== 'aguardando_pagamento_stark') {
        console.log(`⚠️ Saque já teve débito realizado! ID: ${id}, Débito em: ${dadosSaque.debito_plific_at}`);
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'Débito já foi realizado para este saque',
          debito_em: dadosSaque.debito_plific_at
        });
      }
      
      // Verificar se está em processamento (flag de lock)
      if (dadosSaque.processing_lock) {
        const lockAge = Date.now() - new Date(dadosSaque.processing_lock).getTime();
        // Se o lock tem menos de 60 segundos, rejeitar
        if (lockAge < 60000) {
          console.log(`⚠️ Saque em processamento! ID: ${id}, Lock há: ${lockAge}ms`);
          await client.query('ROLLBACK');
          return res.status(409).json({ 
            error: 'Este saque está sendo processado. Aguarde alguns segundos.',
            processing_since: dadosSaque.processing_lock
          });
        }
        // Se o lock é muito antigo, considerar como falha anterior e continuar
        console.log(`🔓 Lock antigo removido (${lockAge}ms). Continuando processamento.`);
      }
    }

    // =============== PROTEÇÃO 4: MARCAR COMO EM PROCESSAMENTO ===============
    if (isAprovado) {
      await client.query(
        `UPDATE withdrawal_requests SET processing_lock = NOW() WHERE id = $1`,
        [id]
      );
    }

    // Se for aprovação, fazer débito automático na API Plific
    // PULAR se o débito já foi realizado automaticamente na criação do saque
    let debitoRealizado = false;
    if (isAprovado && !dadosSaque.debito) {
      try {
        const valorDebito = parseFloat(dadosSaque.requested_amount);
        const idProf = dadosSaque.user_cod;
        
        // Definir descrição baseado no tipo de aprovação
        const descricaoDebito = status === 'aprovado_gratuidade' 
          ? 'Saque Emergencial - Gratuito'
          : 'Saque emergencial - Prestação de Serviços';
        
        const dataDebitoFormatada = dataDebito ? dataDebito.split('T')[0] : new Date().toISOString().split('T')[0];
        console.log(`💳 Iniciando débito Plific - Prof: ${idProf}, Tipo: ${status}, Data: ${dataDebitoFormatada}`);
        
        const urlDebito = `${PLIFIC_BASE_URL}/lancarDebitoProfissional`;
        const responseDebito = await plificFetch(urlDebito, {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${PLIFIC_TOKEN}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({
            idProf: parseInt(idProf),
            valor: valorDebito,
            descricao: descricaoDebito,
            data: dataDebitoFormatada
          })
        });
        
        const respostaDebito = await responseDebito.json();
        
        if (respostaDebito.status !== '200' && respostaDebito.status !== 200) {
          console.error('❌ Erro ao debitar Plific:', respostaDebito);
          // Remover lock e fazer rollback
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            error: 'Erro ao debitar no Plific', 
            details: respostaDebito.msgUsuario || respostaDebito.dados?.msg || 'Falha no débito'
          });
        }
        
        debitoRealizado = true;
        console.log(`✅ Débito Plific realizado com sucesso - Prof: ${idProf}`);
        
        // Limpar cache do profissional para atualizar saldo
        const cacheKey = `saldo_${idProf}`;
        plificSaldoCache.delete(cacheKey);
        
      } catch (erroDebito) {
        console.error('❌ Exceção ao debitar Plific:', erroDebito);
        await client.query('ROLLBACK');
        return res.status(500).json({ 
          error: 'Erro ao processar débito', 
          details: process.env.NODE_ENV === 'production' ? 'Erro interno' : erroDebito.message 
        });
      }
    } else if (isAprovado && dadosSaque.debito) {
      // Débito já foi realizado automaticamente na criação — pular Plific
      debitoRealizado = true;
      console.log(`✅ [Aprovação] Débito já realizado automaticamente para saque #${id}, pulando Plific`);
    }
    
    // =============== ATUALIZAR REGISTRO NO BANCO ===============
    // Se o débito já foi feito no auto-débito, preservar a data original. Senão usar a nova.
    const debitoPlificAt = isAprovado 
      ? (dadosSaque.debito_plific_at || dataDebito || new Date().toISOString()) 
      : null;
    
    const result = await client.query(
      `UPDATE withdrawal_requests 
       SET status = $1, 
           admin_id = $2, 
           admin_name = $3, 
           reject_reason = $4, 
           approved_at = CASE WHEN $5 THEN NOW() ELSE approved_at END,
           lancamento_at = CASE WHEN $5 THEN NOW() ELSE lancamento_at END,
           debito_plific_at = CASE WHEN $5 THEN $7::timestamp ELSE debito_plific_at END,
           debito = CASE WHEN $5 THEN true ELSE debito END,
           debito_erro = CASE WHEN $5 THEN NULL ELSE debito_erro END,
           processing_lock = NULL,
           updated_at = NOW() 
       WHERE id = $6 
       RETURNING *`,
      [status, adminId, adminName, rejectReason || null, isAprovado, id, debitoPlificAt]
    );

    // =============== PROTEÇÃO 5: SALVAR IDEMPOTÊNCIA ===============
    if (idempotencyKey && result.rows.length > 0) {
      try {
        await client.query(
          `INSERT INTO withdrawal_idempotency (idempotency_key, withdrawal_id, response_data, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [idempotencyKey, id, JSON.stringify(result.rows[0])]
        );
      } catch (idempErr) {
        // Não falhar se a tabela não existir ainda
        console.log('⚠️ Aviso: Não foi possível salvar idempotência:', idempErr.message);
      }
    }

    // Commit da transação
    await client.query('COMMIT');

    // Registrar auditoria
    const saque = result.rows[0];
    await registrarAuditoria(req, `WITHDRAWAL_${status.toUpperCase()}`, AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', id, {
      user_cod: saque.user_cod,
      valor: saque.requested_amount,
      admin: adminName,
      motivo_rejeicao: rejectReason,
      debito_plific: debitoRealizado ? 'realizado' : null,
      idempotency_key: idempotencyKey
    });

    // ==================== NOTIFICAR VIA WEBSOCKET ====================
    if (global.notifyWithdrawalUpdate) {
      global.notifyWithdrawalUpdate(result.rows[0], status);
    }

    res.json(result.rows[0]);
    
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('❌ Erro no rollback:', rollbackErr);
    }
    console.error('❌ Erro ao atualizar saque:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  } finally {
    client.release();
  }
});

// Excluir saque (🔒 SECURITY FIX: Soft delete + proteção de status)
router.delete('/withdrawals/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar dados antes para auditoria e validação
    const saqueAntes = await pool.query('SELECT * FROM withdrawal_requests WHERE id = $1', [id]);

    if (saqueAntes.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    const saque = saqueAntes.rows[0];

    // 🔒 SECURITY FIX: Não permitir exclusão de saques já pagos ou em processamento
    const statusProtegidos = ['pago_stark', 'processando', 'aguardando_pagamento_stark'];
    if (statusProtegidos.includes(saque.status) || saque.stark_status === 'processando' || saque.stark_status === 'pago') {
      return res.status(400).json({ 
        error: 'Não é possível excluir um saque com status: ' + (saque.status || saque.stark_status),
        motivo: 'Saques pagos ou em processamento não podem ser removidos por integridade financeira.'
      });
    }

    // 🔒 SECURITY FIX: Soft delete ao invés de hard delete
    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET status = 'cancelado', 
           admin_name = COALESCE(admin_name, $2),
           reject_reason = COALESCE(reject_reason, 'Excluído pelo admin'),
           updated_at = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [id, req.user.nome || req.user.username || 'Admin']
    );

    // Registrar auditoria
    await registrarAuditoria(req, 'WITHDRAWAL_DELETE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', id, {
      user_cod: saque.user_cod,
      valor: saque.requested_amount,
      status_anterior: saque.status,
      acao: 'soft_delete_cancelado'
    });

    console.log('🗑️ Saque cancelado (soft delete):', id, 'por', req.user.nome || req.user.username);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir saque:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar conciliação/débito
router.patch('/withdrawals/:id/conciliacao', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { conciliacaoOmie, debito } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET conciliacao_omie = COALESCE($1, conciliacao_omie), 
           debito = COALESCE($2, debito),
           updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [conciliacaoOmie, debito, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar conciliação:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar débito com data/hora
router.patch('/withdrawals/:id/debito', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { debito, debitoAt } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET debito = $1, debito_at = $2, updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [debito, debitoAt, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💳 Débito atualizado:', id, debito, debitoAt);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar débito:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar status do saldo
router.patch('/withdrawals/:id/saldo', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { saldoStatus } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET saldo_status = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [saldoStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💰 Saldo status atualizado:', id, saldoStatus);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar saldo:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Dashboard de conciliação (PROTEGIDO - apenas admin financeiro)
router.get('/withdrawals/dashboard/conciliacao', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')) as total_aprovados,
        COUNT(*) FILTER (WHERE conciliacao_omie = true) as total_conciliado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND conciliacao_omie = false) as pendente_conciliacao,
        COUNT(*) FILTER (WHERE debito = true) as total_debitado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND debito = false) as pendente_debito,
        COALESCE(SUM(final_amount) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')), 0) as valor_total_aprovado,
        COALESCE(SUM(final_amount) FILTER (WHERE conciliacao_omie = true), 0) as valor_conciliado,
        COALESCE(SUM(final_amount) FILTER (WHERE debito = true), 0) as valor_debitado
      FROM withdrawal_requests
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao obter dashboard:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================
// GRATUIDADES
// ============================================

// Listar todas as gratuidades
router.get('/gratuities', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM gratuities ORDER BY created_at DESC';
    if (status) {
      query = 'SELECT * FROM gratuities WHERE status = $1 ORDER BY created_at DESC';
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar gratuidades do usuário (PROTEGIDO)
router.get('/gratuities/user/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // SEGURANÇA: Apenas o próprio usuário ou admin podem ver gratuidades
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM gratuities WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Criar gratuidade
router.post('/gratuities', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { userCod, userName, quantity, value, reason, createdBy } = req.body;

    const result = await pool.query(
      `INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, 'ativa', $7) 
       RETURNING *`,
      [userCod, userName || null, quantity, quantity, value, reason || null, createdBy || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar gratuidade:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Deletar gratuidade — 🔒 SECURITY FIX (HIGH-06): Soft delete para preservar trilha de auditoria
router.delete('/gratuities/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar se existe
    const existing = await pool.query('SELECT * FROM gratuities WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Gratuidade não encontrada' });
    }

    // 🔒 Soft delete: marca como removida ao invés de deletar
    const result = await pool.query(
      `UPDATE gratuities SET status = 'removida', expired_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );

    // Registrar auditoria
    await registrarAuditoria(req, 'GRATUIDADE_REMOVIDA', AUDIT_CATEGORIES.FINANCIAL, 'gratuities', id, {
      user_cod: existing.rows[0].user_cod,
      quantidade_original: existing.rows[0].quantity,
      restante: existing.rows[0].remaining,
      removido_por: req.user.nome || req.user.username
    });

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao remover gratuidade:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================
// PROFISSIONAIS RESTRITOS
// ============================================

// Listar todos os restritos
router.get('/restricted', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM restricted_professionals ORDER BY created_at DESC';
    if (status) {
      query = 'SELECT * FROM restricted_professionals WHERE status = $1 ORDER BY created_at DESC';
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar restritos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Verificar se usuário está restrito (🔒 SECURITY FIX: adicionado verificarToken)
router.get('/restricted/check/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    res.json({ 
      isRestricted: result.rows.length > 0,
      restriction: result.rows[0] || null
    });
  } catch (error) {
    console.error('❌ Erro ao verificar restrição:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Adicionar restrição
router.post('/restricted', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { userCod, userName, reason, createdBy } = req.body;

    // Verificar se já existe e está ativo
    const existing = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Profissional já está restrito' });
    }

    // Verificar se existe registro inativo (para reativar)
    const inactive = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status != 'ativo'",
      [userCod]
    );

    let result;
    if (inactive.rows.length > 0) {
      // Reativar registro existente
      result = await pool.query(
        `UPDATE restricted_professionals 
         SET user_name = $2, reason = $3, status = 'ativo', created_by = $4, created_at = NOW(), removed_at = NULL, removed_reason = NULL
         WHERE user_cod = $1
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    } else {
      // Criar novo registro
      result = await pool.query(
        `INSERT INTO restricted_professionals (user_cod, user_name, reason, status, created_by) 
         VALUES ($1, $2, $3, 'ativo', $4) 
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao adicionar restrição:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Remover restrição
router.patch('/restricted/:id/remove', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { removedReason } = req.body;

    const result = await pool.query(
      `UPDATE restricted_professionals 
       SET status = 'removido', removed_at = NOW(), removed_reason = $1 
       WHERE id = $2 
       RETURNING *`,
      [removedReason || 'Restrição suspensa', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao remover restrição:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});



  // ==================== PLIFIC ENDPOINTS ====================

// 🔒 SECURITY FIX (CRIT-01): Permite próprio profissional OU admin/financeiro
router.get('/plific/saldo/:idProf', verificarToken, async (req, res) => {
    try {
        const { idProf } = req.params;

        // Verificar permissão: admin/financeiro consulta qualquer um, profissional só o próprio
        const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
        const isProprio = String(req.user.codProfissional) === String(idProf);
        if (!isAdmin && !isProprio) {
            return res.status(403).json({ error: 'Acesso negado. Você só pode consultar seu próprio saldo.' });
        }

        const forceRefresh = req.query.refresh === 'true';
        
        if (!idProf || isNaN(parseInt(idProf))) {
            return res.status(400).json({ error: 'ID do profissional inválido', details: 'O idProf deve ser um número válido' });
        }

        const cacheKey = `saldo_${idProf}`;
        if (!forceRefresh && plificSaldoCache.has(cacheKey)) {
            const cached = plificSaldoCache.get(cacheKey);
            if (Date.now() - cached.timestamp < PLIFIC_CONFIG.CACHE_TTL) {
                console.log(`📦 Plific: Saldo do profissional ${idProf} retornado do cache`);
                return res.json({ ...cached.data, fromCache: true, cacheAge: Math.round((Date.now() - cached.timestamp) / 1000) });
            }
        }

        const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${idProf}`;
        console.log(`🔍 Plific: Consultando saldo do profissional ${idProf}...`);
        
        const response = await plificFetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.status === '401') {
            console.error('❌ Plific: Token inválido');
            return res.status(401).json({ error: 'Token Plific inválido', details: data.msgUsuario || 'Verifique a configuração do token' });
        }

        if (data.dados && data.dados.status === false) {
            return res.status(404).json({ error: 'Profissional não encontrado', details: data.dados.msg || 'ID não existe na base Plific' });
        }

        // Converter saldo de formato brasileiro (1.000,00) para número
        const profissionalData = data.dados?.profissional || null;
        if (profissionalData && profissionalData.saldo) {
            // Remove pontos de milhar e troca vírgula por ponto
            const saldoStr = String(profissionalData.saldo);
            profissionalData.saldoOriginal = saldoStr;
            profissionalData.saldo = parseFloat(saldoStr.replace(/\./g, '').replace(',', '.')) || 0;
        }
        
        const resultado = {
            success: true,
            profissional: profissionalData,
            ambiente: PLIFIC_AMBIENTE,
            consultadoEm: new Date().toISOString()
        };

        plificSaldoCache.set(cacheKey, { data: resultado, timestamp: Date.now() });
        console.log(`✅ Plific: Saldo do profissional ${idProf} consultado com sucesso`);
        
        await registrarAuditoria(req, 'CONSULTA_SALDO_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_saldo', idProf, { saldo: resultado.profissional?.saldo, ambiente: PLIFIC_AMBIENTE });

        res.json(resultado);
    } catch (error) {
        console.error('❌ Erro ao consultar saldo Plific:', error.message);
        res.status(500).json({ error: 'Erro ao consultar saldo'})   ;
    }
});

// Buscar Saldos em Lote
// 🔒 SECURITY FIX (CRIT-01): Adicionar verificarAdminOuFinanceiro
router.post('/plific/saldos-lote', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Lista de IDs inválida', details: 'Envie um array de IDs no corpo da requisição' });
        }

        if (ids.length > 100) {
            return res.status(400).json({ error: 'Limite excedido', details: 'Máximo de 100 profissionais por requisição' });
        }

        console.log(`🔍 Plific: Consultando saldo de ${ids.length} profissionais em lote...`);

        const resultados = [];
        const BATCH_SIZE = PLIFIC_CONFIG.RATE_LIMIT;
        
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const batch = ids.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (idProf) => {
                const cacheKey = `saldo_${idProf}`;
                if (plificSaldoCache.has(cacheKey)) {
                    const cached = plificSaldoCache.get(cacheKey);
                    if (Date.now() - cached.timestamp < PLIFIC_CONFIG.CACHE_TTL) {
                        return { idProf, ...cached.data.profissional, fromCache: true };
                    }
                }

                try {
                    const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${idProf}`;
                    const response = await plificFetch(url, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
                    });

                    const data = await response.json();

                    if (data.status === '200' && data.dados?.status === true) {
                        plificSaldoCache.set(cacheKey, { data: { profissional: data.dados.profissional }, timestamp: Date.now() });
                        return { idProf, ...data.dados.profissional, fromCache: false };
                    } else {
                        return { idProf, erro: data.dados?.msg || 'Não encontrado', saldo: null };
                    }
                } catch (err) {
                    return { idProf, erro: err.message, saldo: null };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            resultados.push(...batchResults);

            if (i + BATCH_SIZE < ids.length) {
                await new Promise(resolve => setTimeout(resolve, PLIFIC_CONFIG.RATE_LIMIT_WINDOW));
            }
        }

        const sucessos = resultados.filter(r => r.saldo !== null && !r.erro);
        const falhas = resultados.filter(r => r.saldo === null || r.erro);

        console.log(`✅ Plific: Lote concluído - ${sucessos.length} sucesso(s), ${falhas.length} falha(s)`);
        await registrarAuditoria(req, 'CONSULTA_SALDOS_LOTE_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_saldo_lote', null, { total: ids.length, sucessos: sucessos.length, falhas: falhas.length, ambiente: PLIFIC_AMBIENTE });

        res.json({ success: true, total: ids.length, sucessos: sucessos.length, falhas: falhas.length, resultados, ambiente: PLIFIC_AMBIENTE, consultadoEm: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Erro ao consultar saldos em lote Plific:', error.message);
        res.status(500).json({ error: 'Erro ao consultar saldos em lote'})   ;
    }
});

// Lançar Débito
// 🔒 SECURITY FIX (CRIT-01): Adicionar verificarAdminOuFinanceiro — CRÍTICO: débito financeiro
router.post('/plific/lancar-debito', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
        const { idProf, valor, descricao } = req.body;
        
        if (!idProf || isNaN(parseInt(idProf))) {
            return res.status(400).json({ error: 'ID do profissional inválido', details: 'O idProf deve ser um número válido' });
        }
        if (!valor || isNaN(parseFloat(valor)) || parseFloat(valor) <= 0) {
            return res.status(400).json({ error: 'Valor inválido', details: 'O valor deve ser um número positivo' });
        }
        if (!descricao || descricao.trim().length === 0) {
            return res.status(400).json({ error: 'Descrição obrigatória', details: 'Informe uma descrição para o débito' });
        }

        const url = `${PLIFIC_BASE_URL}/lancarDebitoProfissional`;
        console.log(`💳 Plific: Lançando débito de R$ ${valor} para profissional ${idProf}...`);

        const response = await plificFetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ idProf: parseInt(idProf), valor: parseFloat(valor), descricao: descricao.trim() })
        });

        const data = await response.json();

        if (data.status === '401') {
            console.error('❌ Plific: Token inválido ao lançar débito');
            return res.status(401).json({ error: 'Token Plific inválido', details: data.msgUsuario || 'Verifique a configuração do token' });
        }

        if (data.dados?.status === 'erro') {
            console.error('❌ Plific: Erro ao lançar débito:', data.dados.mensagem);
            return res.status(400).json({ error: 'Erro ao lançar débito', details: data.dados.mensagem || 'Erro na validação dos parâmetros', erros: data.dados.erros });
        }

        const cacheKey = `saldo_${idProf}`;
        plificSaldoCache.delete(cacheKey);

        console.log(`✅ Plific: Débito de R$ ${valor} lançado com sucesso para profissional ${idProf}`);
        await registrarAuditoria(req, 'LANCAR_DEBITO_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_debito', idProf, { valor: parseFloat(valor), descricao: descricao.trim(), ambiente: PLIFIC_AMBIENTE });

        res.json({ success: true, mensagem: data.dados?.mensagem || 'Débito lançado com sucesso', ambiente: PLIFIC_AMBIENTE, lancadoEm: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Erro ao lançar débito Plific:', error.message);
        res.status(500).json({ error: 'Erro ao lançar débito'})   ;
    }
});

// Buscar Profissionais para Consulta
// 🔒 SECURITY FIX (CRIT-01): Adicionar verificarAdminOuFinanceiro
router.get('/plific/profissionais', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
        const { regiao, limite } = req.query;
        
        let query = `SELECT DISTINCT s.user_cod as id, s.user_name as nome, s.regiao FROM withdrawal_requests s WHERE s.user_cod IS NOT NULL`;
        const params = [];
        let paramIndex = 1;

        if (regiao) {
            query += ` AND s.regiao = $${paramIndex++}`;
            params.push(regiao);
        }

        query += ` ORDER BY s.user_name ASC`;
        
        if (limite) {
            query += ` LIMIT $${paramIndex}`;
            params.push(parseInt(limite));
        }

        const result = await pool.query(query, params);
        res.json({ success: true, total: result.rows.length, profissionais: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar profissionais:', error.message);
        res.status(500).json({ error: 'Erro ao buscar profissionais'})   ;
    }
});

// Listar todos os profissionais com saldo (do banco local + API Plific)
// 🔒 SECURITY FIX (CRIT-01): Adicionar verificarAdminOuFinanceiro
router.get('/plific/saldos-todos', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
        const { pagina = 1, porPagina = 20 } = req.query;
        const paginaNum = parseInt(pagina);
        const porPaginaNum = Math.min(parseInt(porPagina), 50); // máximo 50 por página
        
        // Buscar todos os profissionais únicos que já fizeram saque
        const queryProfs = `
            SELECT s.user_cod as codigo, MAX(s.user_name) as nome 
            FROM withdrawal_requests s 
            WHERE s.user_cod IS NOT NULL AND s.user_name IS NOT NULL
            GROUP BY s.user_cod
            ORDER BY MAX(s.user_name) ASC
        `;
        const resultProfs = await pool.query(queryProfs);
        const profissionais = resultProfs.rows;
        
        if (profissionais.length === 0) {
            return res.json({ 
                success: true, 
                profissionais: [], 
                total: 0, 
                pagina: paginaNum, 
                porPagina: porPaginaNum, 
                totalPaginas: 0 
            });
        }
        
        // Buscar saldos de todos os profissionais na API Plific
        const resultados = [];
        for (const prof of profissionais) {
            try {
                // Verificar cache primeiro
                const cacheKey = `saldo_${prof.codigo}`;
                if (plificSaldoCache.has(cacheKey)) {
                    const cached = plificSaldoCache.get(cacheKey);
                    if (Date.now() - cached.timestamp < PLIFIC_CONFIG.CACHE_TTL) {
                        const saldoCached = cached.data.profissional?.saldo;
                        const saldoNum = typeof saldoCached === 'string' 
                            ? parseFloat(saldoCached.replace(/\./g, '').replace(',', '.')) || 0
                            : parseFloat(saldoCached || 0);
                        resultados.push({
                            codigo: prof.codigo,
                            nome: prof.nome,
                            saldo: saldoNum,
                            cpf: cached.data.profissional?.cpf || null
                        });
                        continue;
                    }
                }
                
                // Buscar da API
                const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${prof.codigo}`;
                const response = await plificFetch(url, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
                });
                const data = await response.json();
                
                if (data.status === '200' || data.status === 200) {
                    const profData = data.dados?.profissional || null;
                    let saldoNum = 0;
                    if (profData && profData.saldo) {
                        const saldoStr = String(profData.saldo);
                        saldoNum = parseFloat(saldoStr.replace(/\./g, '').replace(',', '.')) || 0;
                    }
                    
                    resultados.push({
                        codigo: prof.codigo,
                        nome: profData?.nome || prof.nome,
                        saldo: saldoNum,
                        cpf: profData?.cpf || null
                    });
                    
                    // Cachear resultado
                    plificSaldoCache.set(cacheKey, { 
                        data: { profissional: { ...profData, saldo: saldoNum } }, 
                        timestamp: Date.now() 
                    });
                }
                
                // Rate limit - pequena pausa entre requisições
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (err) {
                console.error(`Erro ao buscar saldo do prof ${prof.codigo}:`, err.message);
            }
        }
        
        // Ordenar por saldo (maior para menor)
        resultados.sort((a, b) => b.saldo - a.saldo);
        
        // Paginação
        const total = resultados.length;
        const totalPaginas = Math.ceil(total / porPaginaNum);
        const inicio = (paginaNum - 1) * porPaginaNum;
        const fim = inicio + porPaginaNum;
        const profissionaisPaginados = resultados.slice(inicio, fim);
        
        res.json({ 
            success: true, 
            profissionais: profissionaisPaginados, 
            total, 
            pagina: paginaNum, 
            porPagina: porPaginaNum, 
            totalPaginas,
            somaTotal: resultados.reduce((acc, p) => acc + p.saldo, 0)
        });
        
    } catch (error) {
        console.error('❌ Erro ao buscar saldos:', error.message);
        res.status(500).json({ error: 'Erro ao buscar saldos'})   ;
    }
});

// Status da Integração
// 🔒 SECURITY FIX (CRIT-01): Adicionar verificarAdminOuFinanceiro
router.get('/plific/status', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
        const testId = PLIFIC_AMBIENTE === 'teste' ? '8888' : '1';
        const url = `${PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${testId}`;
        
        const startTime = Date.now();
        const response = await plificFetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
        });
        const latency = Date.now() - startTime;

        const data = await response.json();
        const tokenValido = data.status !== '401';
        const apiOnline = response.ok;

        res.json({
            success: true,
            status: { apiOnline, tokenValido, latencia: `${latency}ms`, ambiente: PLIFIC_AMBIENTE, baseUrl: PLIFIC_BASE_URL, cacheSize: plificSaldoCache.size, cacheTTL: `${PLIFIC_CONFIG.CACHE_TTL / 1000}s` }
        });
    } catch (error) {
        res.json({ success: false, status: { apiOnline: false, tokenValido: false, erro: error.message, ambiente: PLIFIC_AMBIENTE } });
    }
});

console.log('✅ Módulo Plific carregado!');

// ==================== FIM INTEGRAÇÃO PLIFIC ====================


console.log('✅ Módulo de Auditoria carregado!');

// =====================================================
// SISTEMA DE SOLICITAÇÃO DE CORRIDAS - INTEGRAÇÃO TUTTS
// =====================================================

  return router;
}

module.exports = { createFinancialRouter };
