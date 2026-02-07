/**
 * Sub-Router: Terms + Financial Data + Logs
 */
const express = require('express');

function createDadosRoutes(pool, verificarToken) {
  const router = express.Router();

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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao obter dados financeiros:', error);
    res.status(500).json({ error: error.message });
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
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_PIX', oldData.pix_key, pixKey]
        );
      }
    } else {
      await pool.query(
        `INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key, pix_tipo, terms_accepted) 
         VALUES ($1, $2, $3, $4, $5, true)`,
        [userCod, fullName, cpf, pixKey, pixTipo || 'cpf']
      );

      await pool.query(
        'INSERT INTO financial_logs (user_cod, action, new_value) VALUES ($1, $2, $3)',
        [userCod, 'CADASTRO_DADOS', 'Dados financeiros cadastrados']
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar dados financeiros:', error);
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SOLICITAÇÕES DE SAQUE
// ============================================

// ==================== NOVO: Endpoint otimizado - Apenas Pendentes ====================

  return router;
}

module.exports = { createDadosRoutes };
