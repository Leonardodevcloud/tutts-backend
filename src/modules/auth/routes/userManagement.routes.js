/**
 * Sub-Router: User Management (admin, password changes, password recovery)
 */
const express = require('express');
const crypto = require('crypto');
const { hashSenha, verificarSenha } = require('../auth.service');

function createUserManagementRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, loginLimiter) {
  const router = express.Router();

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
    res.status(500).json({ error: 'Erro ao listar usuários: ' + error.message });
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
    res.status(500).json({ error: 'Erro ao resetar senha: ' + error.message });
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
    res.status(500).json({ error: 'Erro ao alterar senha: ' + error.message });
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
    res.status(500).json({ error: 'Erro ao atualizar role: ' + error.message });
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
    res.status(500).json({ error: 'Erro ao deletar usuário: ' + error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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

  return router;
}

module.exports = { createUserManagementRoutes };
