/**
 * Config Sub-Router: Admin Permissions + Notifications
 */
const express = require('express');

function createAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

router.get('/admin-permissions', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode ver/gerenciar permissões
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Acesso negado a admin-permissions por: ${req.user.codProfissional}`);
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode gerenciar permissões.' });
    }
    
    const result = await pool.query(`
      SELECT u.id, u.cod_profissional, u.full_name, u.role, 
             COALESCE(u.allowed_modules::text, '[]') as allowed_modules,
             COALESCE(u.allowed_tabs::text, '{}') as allowed_tabs,
             u.created_at
      FROM users u
      WHERE u.role IN ('admin', 'admin_financeiro')
      ORDER BY u.full_name
    `);
    
    // Parse JSON strings
    const rows = result.rows.map(row => {
      try {
        row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
        row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
      } catch (e) {
        row.allowed_modules = [];
        row.allowed_tabs = {};
      }
      return row;
    });
    
    res.json(rows);
  } catch (error) {
    console.error('❌ Erro ao listar permissões:', error);
    res.json([]);
  }
});

// Atualizar permissões de um admin (APENAS ADMIN_MASTER)
router.patch('/admin-permissions/:codProfissional', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode alterar permissões
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Tentativa não autorizada de alterar permissões por: ${req.user.codProfissional}`);
      await registrarAuditoria(req, 'PERMISSIONS_CHANGE_DENIED', AUDIT_CATEGORIES.ADMIN, 'users', req.params.codProfissional, {
        motivo: 'Usuário não é admin_master'
      }, 'failed');
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode alterar permissões.' });
    }
    
    const { codProfissional } = req.params;
    const { allowed_modules, allowed_tabs } = req.body;
    
    // Garantir que são objetos válidos
    const modules = Array.isArray(allowed_modules) ? allowed_modules : [];
    const tabs = (allowed_tabs && typeof allowed_tabs === 'object') ? allowed_tabs : {};
    
    const result = await pool.query(`
      UPDATE users 
      SET allowed_modules = $1::jsonb, allowed_tabs = $2::jsonb
      WHERE LOWER(cod_profissional) = LOWER($3)
      RETURNING id, cod_profissional, full_name, role, allowed_modules, allowed_tabs
    `, [JSON.stringify(modules), JSON.stringify(tabs), codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'Usuário não encontrado', success: false });
    }
    
    // Registrar auditoria
    await registrarAuditoria(req, 'PERMISSIONS_CHANGE', AUDIT_CATEGORIES.ADMIN, 'users', result.rows[0].id, {
      cod_profissional: codProfissional,
      modulos: modules,
      alterado_por: req.user.codProfissional
    });
    
    console.log(`🔐 Permissões atualizadas: ${codProfissional} (por ${req.user.codProfissional})`);
    res.json({ message: 'Permissões atualizadas com sucesso', user: result.rows[0], success: true });
  } catch (error) {
    console.error('❌ Erro ao atualizar permissões:', error);
    res.json({ message: 'Erro ao atualizar', success: false, error: error.message });
  }
});

// Obter permissões de um admin específico (ADMIN_MASTER ou próprio usuário)
router.get('/admin-permissions/:codProfissional', verificarToken, async (req, res) => {
  try {
    const { codProfissional } = req.params;
    
    // Permitir acesso apenas para admin_master ou o próprio usuário consultando suas permissões
    if (req.user.role !== 'admin_master' && req.user.codProfissional.toLowerCase() !== codProfissional.toLowerCase()) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const result = await pool.query(`
      SELECT id, cod_profissional, full_name, role, 
             COALESCE(allowed_modules::text, '[]') as allowed_modules,
             COALESCE(allowed_tabs::text, '{}') as allowed_tabs
      FROM users
      WHERE LOWER(cod_profissional) = LOWER($1)
    `, [codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ allowed_modules: [], allowed_tabs: {} });
    }
    
    // Parse JSON strings se necessário
    const row = result.rows[0];
    try {
      row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
      row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
    } catch (e) {
      row.allowed_modules = [];
      row.allowed_tabs = {};
    }
    
    res.json(row);
  } catch (error) {
    console.error('❌ Erro ao buscar permissões:', error);
    res.json({ allowed_modules: [], allowed_tabs: {} });
  }
});

  // ==================== SUBMISSÕES ====================

router.post('/notifications', async (req, res) => {
  try {
    const { message, type, forUser } = req.body;

    const result = await pool.query(
      `INSERT INTO notifications (message, type, for_user, created_at) 
       VALUES ($1, $2, $3, NOW()) 
       RETURNING *`,
      [message, type, forUser]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar notificação:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/notifications/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;

    const result = await pool.query(
      "SELECT * FROM notifications WHERE for_user = $1 OR for_user = 'admin' ORDER BY created_at DESC LIMIT 50",
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar notificações:', error);
    res.status(500).json({ error: error.message });
  }
});

  // ==================== PROMOÇÕES + INDICAÇÕES + NOVATOS + QUIZ ====================


  return router;
}

module.exports = { createAdminRoutes };
