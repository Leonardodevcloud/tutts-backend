// ============================================================
// MÓDULO AUDITORIA - ROUTES (3 Endpoints)
// Extraído de server.js (linhas 19804-20070)
//
// Endpoints:
//   GET  /api/audit/logs   - Listar logs com filtros e paginação
//   GET  /api/audit/stats  - Estatísticas de auditoria
//   GET  /api/audit/export - Exportar logs (CSV)
//
// Segurança: TODOS exigem verificarToken + verificarAdmin
// ============================================================

const express = require('express');

/**
 * Inicializa rotas do módulo de Auditoria
 * @param {object} pool - Pool de conexão PostgreSQL
 * @param {Function} verificarToken - Middleware de autenticação
 * @param {Function} verificarAdmin - Middleware de verificação de admin
 * @param {Function} registrarAuditoria - Função de registro de auditoria
 * @returns {express.Router}
 */
function initAuditRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ==================== GET /logs ====================
  // Listar logs de auditoria com filtros e paginação
  router.get('/logs', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        category,
        action,
        user_cod,
        status,
        data_inicio,
        data_fim,
        search
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (category) {
        whereClause += ` AND category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
      }

      if (action) {
        whereClause += ` AND action ILIKE $${paramIndex}`;
        params.push(`%${action}%`);
        paramIndex++;
      }

      if (user_cod) {
        whereClause += ` AND user_cod ILIKE $${paramIndex}`;
        params.push(`%${user_cod}%`);
        paramIndex++;
      }

      if (status) {
        whereClause += ` AND status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (data_inicio) {
        whereClause += ` AND created_at >= $${paramIndex}`;
        params.push(data_inicio);
        paramIndex++;
      }

      if (data_fim) {
        whereClause += ` AND created_at <= $${paramIndex}`;
        params.push(data_fim + ' 23:59:59');
        paramIndex++;
      }

      if (search) {
        whereClause += ` AND (user_cod ILIKE $${paramIndex} OR user_name ILIKE $${paramIndex} OR action ILIKE $${paramIndex} OR resource ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      // Contar total
      const countResult = await pool.query(`
        SELECT COUNT(*) as total FROM audit_logs ${whereClause}
      `, params);

      // Buscar logs
      const result = await pool.query(`
        SELECT * FROM audit_logs 
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `, [...params, parseInt(limit), offset]);

      res.json({
        logs: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].total),
          totalPages: Math.ceil(parseInt(countResult.rows[0].total) / parseInt(limit))
        }
      });
    } catch (error) {
      console.error('Erro ao listar logs de auditoria:', error);
      res.status(500).json({ error: 'Erro ao listar logs' });
    }
  });

  // ==================== GET /stats ====================
  // Estatísticas de auditoria
  router.get('/stats', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { dias = 7 } = req.query;

      // Total por categoria
      const categoriaResult = await pool.query(`
        SELECT category, COUNT(*) as total
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
        GROUP BY category
        ORDER BY total DESC
      `);

      // Total por ação
      const acaoResult = await pool.query(`
        SELECT action, COUNT(*) as total
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
        GROUP BY action
        ORDER BY total DESC
        LIMIT 10
      `);

      // Usuários mais ativos
      const usuariosResult = await pool.query(`
        SELECT user_cod, user_name, COUNT(*) as total
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
        AND user_cod IS NOT NULL AND user_cod != 'anonymous'
        GROUP BY user_cod, user_name
        ORDER BY total DESC
        LIMIT 10
      `);

      // Logs por dia
      const porDiaResult = await pool.query(`
        SELECT DATE(created_at) as data, COUNT(*) as total
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
        GROUP BY DATE(created_at)
        ORDER BY data DESC
      `);

      // Falhas de login
      const falhasResult = await pool.query(`
        SELECT COUNT(*) as total
        FROM audit_logs
        WHERE action = 'LOGIN_FAILED'
        AND created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
      `);

      // Total geral no período
      const totalResult = await pool.query(`
        SELECT COUNT(*) as total
        FROM audit_logs
        WHERE created_at >= NOW() - INTERVAL '${parseInt(dias)} days'
      `);

      res.json({
        periodo_dias: parseInt(dias),
        total_acoes: parseInt(totalResult.rows[0].total),
        falhas_login: parseInt(falhasResult.rows[0].total),
        por_categoria: categoriaResult.rows,
        top_acoes: acaoResult.rows,
        usuarios_ativos: usuariosResult.rows,
        por_dia: porDiaResult.rows
      });
    } catch (error) {
      console.error('Erro ao buscar estatísticas:', error);
      res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
  });

  // ==================== GET /export ====================
  // Exportar logs (CSV)
  router.get('/export', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { data_inicio, data_fim, category } = req.query;

      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (data_inicio) {
        whereClause += ` AND created_at >= $${paramIndex}`;
        params.push(data_inicio);
        paramIndex++;
      }

      if (data_fim) {
        whereClause += ` AND created_at <= $${paramIndex}`;
        params.push(data_fim + ' 23:59:59');
        paramIndex++;
      }

      if (category) {
        whereClause += ` AND category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
      }

      const result = await pool.query(`
        SELECT 
          TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI:SS') as data_hora,
          user_cod as usuario,
          user_name as nome,
          user_role as perfil,
          action as acao,
          category as categoria,
          resource as recurso,
          resource_id as recurso_id,
          status,
          ip_address as ip
        FROM audit_logs 
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT 10000
      `, params);

      // Registrar exportação
      await registrarAuditoria(req, 'EXPORT_AUDIT_LOGS', 'admin', 'audit_logs', null, {
        registros: result.rows.length,
        filtros: { data_inicio, data_fim, category }
      });

      // Gerar CSV
      const headers = ['Data/Hora', 'Usuário', 'Nome', 'Perfil', 'Ação', 'Categoria', 'Recurso', 'ID Recurso', 'Status', 'IP'];
      const csvRows = [headers.join(';')];

      for (const row of result.rows) {
        csvRows.push([
          row.data_hora,
          row.usuario,
          row.nome,
          row.perfil,
          row.acao,
          row.categoria,
          row.recurso || '',
          row.recurso_id || '',
          row.status,
          row.ip
        ].join(';'));
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=audit_logs_${new Date().toISOString().split('T')[0]}.csv`);
      res.send('\uFEFF' + csvRows.join('\n')); // BOM para UTF-8
    } catch (error) {
      console.error('Erro ao exportar logs:', error);
      res.status(500).json({ error: 'Erro ao exportar logs' });
    }
  });

  return router;
}

module.exports = initAuditRoutes;
