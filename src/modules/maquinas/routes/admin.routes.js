/**
 * Sub-Router Máquinas — Endpoints admin Tutts
 *
 * Visão global cross-cliente + gestão de liberações de saque.
 * Usado pelo módulo "Controle de Máquinas" na Central.
 */

const express = require('express');

function createMaquinasAdminRoutes(pool, verificarToken) {
  const router = express.Router();

  // Qualquer admin pode operar (decisão do produto)
  const verificarAdmin = (req, res, next) => {
    if (!req.user || !['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    next();
  };

  // GET /api/admin/maquinas/global — visão consolidada (mantido)
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

  // GET /api/admin/maquinas/restricoes — motoboys com máquina em campo + status liberação
  router.get('/admin/maquinas/restricoes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          mm.id            AS movimentacao_id,
          mm.motoboy_codigo,
          mm.motoboy_nome,
          mm.vinculado_central,
          mm.despachada_em,
          m.identificador,
          m.marca,
          m.observacao,
          COALESCE(cs.empresa, cs.nome) AS cliente_nome,
          EXTRACT(EPOCH FROM (NOW() - mm.despachada_em))/60 AS minutos_em_campo,
          lib.id           AS liberacao_id,
          lib.liberado_por_nome,
          lib.created_at   AS liberado_em
        FROM maquinas_movimentacoes mm
        JOIN maquinas m              ON m.id = mm.maquina_id
        JOIN clientes_solicitacao cs ON cs.id = mm.cliente_id
        LEFT JOIN LATERAL (
          SELECT id, liberado_por_nome, created_at
          FROM maquinas_liberacoes
          WHERE movimentacao_id = mm.id AND consumida = false
          ORDER BY created_at DESC LIMIT 1
        ) lib ON true
        WHERE mm.restituida_em IS NULL
        ORDER BY mm.despachada_em ASC
      `);
      const rows = result.rows.map(r => ({
        movimentacao_id: r.movimentacao_id,
        motoboy_codigo: r.motoboy_codigo,
        motoboy_nome: r.motoboy_nome,
        vinculado_central: r.vinculado_central,
        despachada_em: r.despachada_em,
        identificador: r.identificador,
        marca: r.marca,
        observacao: r.observacao,
        cliente_nome: r.cliente_nome,
        minutos_em_campo: r.minutos_em_campo,
        liberado: !!r.liberacao_id,
        liberado_por_nome: r.liberado_por_nome || null,
        liberado_em: r.liberado_em || null,
      }));
      const liberadosHoje = await pool.query(`
        SELECT COUNT(*)::int AS n FROM maquinas_liberacoes
        WHERE created_at::date = CURRENT_DATE
      `);
      res.json({
        restricoes: rows,
        total: rows.length,
        bloqueados: rows.filter(r => !r.liberado).length,
        liberados_hoje: liberadosHoje.rows[0]?.n || 0,
      });
    } catch (err) {
      console.error('❌ [MAQUINAS ADMIN] Erro restricoes:', err.message);
      res.status(500).json({ error: 'Erro ao listar restrições', detalhe: err.message });
    }
  });

  // POST /api/admin/maquinas/restricoes/:movimentacaoId/liberar — libera 1 saque
  router.post('/admin/maquinas/restricoes/:movimentacaoId/liberar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const movimentacaoId = parseInt(req.params.movimentacaoId, 10);
      if (isNaN(movimentacaoId)) return res.status(400).json({ error: 'ID inválido' });

      const mov = await pool.query(
        `SELECT id, motoboy_codigo, motoboy_nome, restituida_em
           FROM maquinas_movimentacoes WHERE id = $1`,
        [movimentacaoId]
      );
      if (mov.rows.length === 0) return res.status(404).json({ error: 'Movimentação não encontrada' });
      if (mov.rows[0].restituida_em) {
        return res.status(409).json({ error: 'Máquina já foi restituída — sem restrição para liberar' });
      }

      const jaLib = await pool.query(
        `SELECT id FROM maquinas_liberacoes
          WHERE movimentacao_id = $1 AND consumida = false LIMIT 1`,
        [movimentacaoId]
      );
      if (jaLib.rows.length > 0) {
        return res.status(409).json({ error: 'Já existe uma liberação ativa para este motoboy' });
      }

      const m = mov.rows[0];
      const lib = await pool.query(
        `INSERT INTO maquinas_liberacoes
           (movimentacao_id, motoboy_codigo, motoboy_nome, liberado_por_id, liberado_por_nome)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [movimentacaoId, m.motoboy_codigo, m.motoboy_nome, req.user.id, req.user.nome]
      );
      console.log(`🔓 [MAQUINAS ADMIN] ${req.user.nome} liberou saque de ${m.motoboy_nome} (mov ${movimentacaoId})`);
      res.status(201).json({
        ok: true,
        liberacao_id: lib.rows[0].id,
        liberado_em: lib.rows[0].created_at,
      });
    } catch (err) {
      console.error('❌ [MAQUINAS ADMIN] Erro liberar:', err.message);
      res.status(500).json({ error: 'Erro ao liberar saque', detalhe: err.message });
    }
  });

  // DELETE /api/admin/maquinas/restricoes/:movimentacaoId/liberar — cancela liberação não usada
  router.delete('/admin/maquinas/restricoes/:movimentacaoId/liberar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const movimentacaoId = parseInt(req.params.movimentacaoId, 10);
      if (isNaN(movimentacaoId)) return res.status(400).json({ error: 'ID inválido' });
      const r = await pool.query(
        `DELETE FROM maquinas_liberacoes
          WHERE movimentacao_id = $1 AND consumida = false
          RETURNING id`,
        [movimentacaoId]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Nenhuma liberação ativa para cancelar' });
      console.log(`↩️ [MAQUINAS ADMIN] ${req.user.nome} cancelou liberação (mov ${movimentacaoId})`);
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ [MAQUINAS ADMIN] Erro cancelar liberação:', err.message);
      res.status(500).json({ error: 'Erro ao cancelar liberação', detalhe: err.message });
    }
  });

  // GET /api/admin/maquinas/liberacoes — histórico de liberações
  router.get('/admin/maquinas/liberacoes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const result = await pool.query(`
        SELECT
          lib.id, lib.motoboy_codigo, lib.motoboy_nome,
          lib.liberado_por_nome, lib.created_at,
          lib.consumida, lib.consumida_em,
          m.identificador, m.marca,
          COALESCE(cs.empresa, cs.nome) AS cliente_nome
        FROM maquinas_liberacoes lib
        JOIN maquinas_movimentacoes mm ON mm.id = lib.movimentacao_id
        JOIN maquinas m                ON m.id = mm.maquina_id
        JOIN clientes_solicitacao cs   ON cs.id = mm.cliente_id
        ORDER BY lib.created_at DESC
        LIMIT $1
      `, [limit]);
      res.json({ liberacoes: result.rows });
    } catch (err) {
      console.error('❌ [MAQUINAS ADMIN] Erro liberacoes:', err.message);
      res.status(500).json({ error: 'Erro ao listar liberações', detalhe: err.message });
    }
  });

  return router;
}

module.exports = { createMaquinasAdminRoutes };
