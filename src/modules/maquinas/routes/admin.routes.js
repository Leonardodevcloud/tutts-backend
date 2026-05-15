/**
 * Sub-Router Máquinas — Endpoints admin Tutts
 *
 * Apenas leitura/auditoria global (cross-cliente).
 * Mutações ficam no escopo do cliente (cliente.routes.js).
 */

const express = require('express');

function createMaquinasAdminRoutes(pool, verificarToken) {
  const router = express.Router();

  // Helper inline pra verificar admin (segue padrão do server.js)
  const verificarAdmin = (req, res, next) => {
    if (!req.user || !['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    next();
  };

  // GET /api/admin/maquinas/global — visão consolidada
  router.get('/admin/maquinas/global', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const [totais, emCampo] = await Promise.all([
        pool.query(`
          SELECT
            cs.id AS cliente_id,
            COALESCE(cs.empresa, cs.nome) AS cliente_nome,
            COUNT(m.id) AS total_maquinas,
            COUNT(CASE WHEN m.ativa THEN 1 END) AS ativas
          FROM clientes_solicitacao cs
          LEFT JOIN maquinas m ON m.cliente_id = cs.id
          GROUP BY cs.id, cs.empresa, cs.nome
          HAVING COUNT(m.id) > 0
          ORDER BY total_maquinas DESC
        `),
        pool.query(`
          SELECT
            mm.id, mm.cliente_id,
            COALESCE(cs.empresa, cs.nome) AS cliente_nome,
            m.identificador, m.marca,
            mm.motoboy_codigo, mm.motoboy_nome,
            mm.despachada_em,
            EXTRACT(EPOCH FROM (NOW() - mm.despachada_em))/60 AS minutos_em_campo
          FROM maquinas_movimentacoes mm
          JOIN maquinas m ON m.id = mm.maquina_id
          JOIN clientes_solicitacao cs ON cs.id = mm.cliente_id
          WHERE mm.restituida_em IS NULL
          ORDER BY mm.despachada_em ASC
        `),
      ]);
      res.json({
        por_cliente: totais.rows,
        em_campo: emCampo.rows,
        total_em_campo: emCampo.rows.length,
      });
    } catch (err) {
      console.error('❌ [MAQUINAS ADMIN] Erro global:', err.message);
      res.status(500).json({ error: 'Erro ao listar máquinas global', detalhe: err.message });
    }
  });

  return router;
}

module.exports = { createMaquinasAdminRoutes };
