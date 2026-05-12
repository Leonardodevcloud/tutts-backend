/**
 * routes/exemptions.routes.js
 * ─────────────────────────────────────────────────────────────────────────
 * CRUD de isenções de saque + CRUD de motivos pré-definidos.
 *
 * Modelo:
 *   - 1 motoboy = 1 isenção ativa por vez (UNIQUE parcial em ativa=TRUE)
 *   - Isenção é PERMANENTE até admin desativar (sem prazo)
 *   - Motivos pré-definidos por enum, gerenciados em modal separado
 *
 * Aplicação no saque (lógica em financial.routes.js POST /withdrawals):
 *   1. Busca gratuidade disponível (status='ativa', remaining>0, dentro prazo)
 *   2. Se TEM gratuidade → consome gratuidade (mesmo fluxo de hoje)
 *   3. Se NÃO TEM gratuidade → busca isenção ativa
 *   4. Se TEM isenção → aprova como gratuito (fee=0), conta no limite gratuito do mês
 *   5. Senão → fluxo normal (com taxa)
 *
 * Endpoints (todos sob /exemptions, montado em /api):
 *   GET    /exemptions/listar             → listagem paginada
 *   GET    /exemptions/kpis               → 2 KPIs (ativas, total mês)
 *   POST   /exemptions                    → cria isenção
 *   PATCH  /exemptions/:id/desativar      → desativa (soft)
 *   GET    /exemptions/motivos            → lista motivos pré-definidos
 *   POST   /exemptions/motivos            → cria motivo
 *   PATCH  /exemptions/motivos/:id        → edita motivo
 *   DELETE /exemptions/motivos/:id        → soft-delete motivo
 *   GET    /exemptions/user/:userCod      → isenção ativa do motoboy (pro app)
 */

'use strict';

const express = require('express');

function createExemptionsRoutes(
  pool,
  verificarToken,
  verificarAdminOuFinanceiro,
  registrarAuditoria,
  AUDIT_CATEGORIES
) {
  const router = express.Router();

  function normalizar(raw) {
    if (raw == null) return '';
    return String(raw).trim().toUpperCase().slice(0, 120);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GET /listar — paginada
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/listar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { status, createdBy, motivo, busca } = req.query;
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
      const offset = (page - 1) * pageSize;

      const conds = [];
      const params = [];
      let i = 1;

      // status: 'ativa' | 'desativada' | 'todas' (default = todas)
      if (status === 'ativa') {
        conds.push(`ativa = TRUE`);
      } else if (status === 'desativada') {
        conds.push(`ativa = FALSE`);
      }

      if (createdBy) {
        conds.push(`criado_por = $${i++}`);
        params.push(String(createdBy));
      }

      if (motivo) {
        conds.push(`motivo = $${i++}`);
        params.push(normalizar(motivo));
      }

      if (busca) {
        const termo = `%${String(busca).trim()}%`;
        conds.push(`(user_cod ILIKE $${i} OR user_name ILIKE $${i} OR motivo ILIKE $${i})`);
        params.push(termo);
        i++;
      }

      const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM withdrawal_exemptions ${whereSql}`,
        params
      );
      const total = totalResult.rows[0].total;

      const dadosParams = params.slice();
      dadosParams.push(pageSize, offset);

      const { rows } = await pool.query(`
        SELECT
          id, user_cod, user_name, motivo, ativa,
          criado_por, criado_em, desativada_em, desativado_por, observacao,
          -- Quantos saques já foram absorvidos por essa isenção (info útil pro admin)
          (
            SELECT COUNT(*)::int FROM withdrawal_requests w
             WHERE w.user_cod = withdrawal_exemptions.user_cod
               AND w.created_at >= withdrawal_exemptions.criado_em
               AND (withdrawal_exemptions.desativada_em IS NULL OR w.created_at <= withdrawal_exemptions.desativada_em)
               AND w.status IN ('aprovado_gratuidade', 'pago_stark')
               AND w.has_gratuity = TRUE
               AND w.gratuity_id IS NULL  -- isenção (sem gratuity_id) vs gratuidade real
          ) AS usos
        FROM withdrawal_exemptions
        ${whereSql}
        ORDER BY ativa DESC, criado_em DESC
        LIMIT $${i++} OFFSET $${i}
      `, dadosParams);

      res.json({
        dados: rows,
        paginacao: {
          page, pageSize, total,
          totalPaginas: Math.max(Math.ceil(total / pageSize), 1),
        },
      });
    } catch (err) {
      console.error('❌ Erro em /exemptions/listar:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /kpis
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/kpis', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE ativa = TRUE)::int AS ativas,
          COUNT(*) FILTER (
            WHERE criado_em >= DATE_TRUNC('month', NOW())
          )::int AS criadas_mes,
          COUNT(*) FILTER (
            WHERE NOT ativa AND desativada_em >= DATE_TRUNC('month', NOW())
          )::int AS desativadas_mes
        FROM withdrawal_exemptions
      `);
      res.json(rows[0]);
    } catch (err) {
      console.error('❌ Erro em /exemptions/kpis:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST / — cria isenção (com FOR UPDATE pra evitar race em UNIQUE parcial)
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { userCod, userName, observacao } = req.body;
      const motivo = normalizar(req.body && req.body.motivo);

      if (!userCod) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'userCod é obrigatório' });
      }
      if (!motivo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'motivo é obrigatório' });
      }

      // Verifica se o motivo está na lista permitida (pré-definidos ativos)
      const motOK = await client.query(
        `SELECT id FROM exemptions_motivos WHERE motivo = $1 AND ativo = TRUE`,
        [motivo]
      );
      if (motOK.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Motivo não está na lista pré-definida. Cadastre o motivo antes.',
        });
      }

      // Verifica se já existe isenção ativa pra esse user (LOCK pra evitar race)
      const existente = await client.query(
        `SELECT id FROM withdrawal_exemptions WHERE user_cod = $1 AND ativa = TRUE FOR UPDATE`,
        [String(userCod)]
      );
      if (existente.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Esse motoboy já tem uma isenção ativa. Desative a anterior primeiro.',
        });
      }

      const criadoPor = (req.user && (req.user.nome || req.user.username)) || 'admin';

      const { rows } = await client.query(`
        INSERT INTO withdrawal_exemptions
          (user_cod, user_name, motivo, criado_por, observacao)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [
        String(userCod).trim(),
        userName ? String(userName).trim() : null,
        motivo,
        criadoPor,
        observacao ? String(observacao).trim() : null,
      ]);

      await registrarAuditoria(
        req, 'EXEMPTION_CREATE', AUDIT_CATEGORIES.FINANCIAL,
        'withdrawal_exemptions', rows[0].id,
        { user_cod: userCod, motivo }
      );

      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('❌ Erro ao criar isenção:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PATCH /:id/desativar — soft-delete (mantém histórico)
  // ═══════════════════════════════════════════════════════════════════════
  router.patch('/:id/desativar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'id inválido' });

      const desativadoPor = (req.user && (req.user.nome || req.user.username)) || 'admin';

      const { rows } = await pool.query(`
        UPDATE withdrawal_exemptions
           SET ativa = FALSE,
               desativada_em = NOW(),
               desativado_por = $2
         WHERE id = $1
           AND ativa = TRUE
         RETURNING *
      `, [id, desativadoPor]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Isenção não encontrada ou já desativada' });
      }

      await registrarAuditoria(
        req, 'EXEMPTION_DEACTIVATE', AUDIT_CATEGORIES.FINANCIAL,
        'withdrawal_exemptions', id,
        { user_cod: rows[0].user_cod, motivo: rows[0].motivo }
      );

      res.json(rows[0]);
    } catch (err) {
      console.error('❌ Erro ao desativar isenção:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /user/:userCod — isenção ativa pro app do motoboy
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/user/:userCod', verificarToken, async (req, res) => {
    try {
      const { userCod } = req.params;

      // SEGURANÇA: motoboy só vê a própria, admin/financeiro vê de qualquer um
      if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
        if (req.user.codProfissional !== userCod) {
          return res.status(403).json({ error: 'Acesso negado' });
        }
      }

      const { rows } = await pool.query(`
        SELECT id, user_cod, user_name, motivo, ativa, criado_em
          FROM withdrawal_exemptions
         WHERE user_cod = $1 AND ativa = TRUE
         LIMIT 1
      `, [userCod]);

      res.json(rows[0] || null);
    } catch (err) {
      console.error('❌ Erro em /exemptions/user:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD de motivos pré-definidos
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/motivos', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const incluirInativos = req.query.incluirInativos === '1';
      const where = incluirInativos ? '' : 'WHERE m.ativo = TRUE';

      const { rows } = await pool.query(`
        SELECT
          m.id, m.motivo, m.ativo, m.criado_por, m.criado_em, m.atualizado_em,
          COALESCE(uso.total, 0)::int AS contador_uso
        FROM exemptions_motivos m
        LEFT JOIN (
          SELECT motivo, COUNT(*) AS total
            FROM withdrawal_exemptions
           GROUP BY motivo
        ) uso ON uso.motivo = m.motivo
        ${where}
        ORDER BY m.motivo ASC
      `);

      res.json(rows);
    } catch (err) {
      console.error('❌ Erro ao listar motivos de isenção:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  router.post('/motivos', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const motivo = normalizar(req.body && req.body.motivo);
      if (!motivo) return res.status(400).json({ error: 'Motivo é obrigatório' });

      const criadoPor = (req.user && (req.user.nome || req.user.username)) || 'admin';

      const { rows } = await pool.query(`
        INSERT INTO exemptions_motivos (motivo, criado_por)
        VALUES ($1, $2)
        ON CONFLICT (motivo) DO UPDATE
          SET ativo = TRUE, atualizado_em = NOW()
        RETURNING *
      `, [motivo, criadoPor]);

      await registrarAuditoria(
        req, 'EXEMPTION_MOTIVO_CREATE', AUDIT_CATEGORIES.FINANCIAL,
        'exemptions_motivos', rows[0].id, { motivo }
      );

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar motivo de isenção:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  router.patch('/motivos/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const novoMotivo = normalizar(req.body && req.body.motivo);

      if (!id || !novoMotivo) {
        return res.status(400).json({ error: 'id e motivo são obrigatórios' });
      }

      const atual = await pool.query(
        `SELECT motivo FROM exemptions_motivos WHERE id = $1`,
        [id]
      );
      if (atual.rows.length === 0) {
        return res.status(404).json({ error: 'Motivo não encontrado' });
      }

      const motivoAntigo = atual.rows[0].motivo;
      if (motivoAntigo === novoMotivo) return res.json({ ok: true, sem_mudanca: true });

      const conflito = await pool.query(
        `SELECT id FROM exemptions_motivos WHERE motivo = $1 AND id <> $2`,
        [novoMotivo, id]
      );
      if (conflito.rows.length > 0) {
        return res.status(409).json({ error: 'Já existe um motivo com esse nome' });
      }

      // Atualiza tanto o motivo quanto as isenções que o usam (manter
      // consistência referencial soft)
      await pool.query(
        `UPDATE withdrawal_exemptions SET motivo = $1 WHERE motivo = $2`,
        [novoMotivo, motivoAntigo]
      );

      const { rows } = await pool.query(`
        UPDATE exemptions_motivos
           SET motivo = $1, atualizado_em = NOW()
         WHERE id = $2
         RETURNING *
      `, [novoMotivo, id]);

      await registrarAuditoria(
        req, 'EXEMPTION_MOTIVO_UPDATE', AUDIT_CATEGORIES.FINANCIAL,
        'exemptions_motivos', id, { de: motivoAntigo, para: novoMotivo }
      );

      res.json(rows[0]);
    } catch (err) {
      console.error('❌ Erro ao editar motivo de isenção:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  router.delete('/motivos/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'id inválido' });

      const atual = await pool.query(
        `SELECT motivo FROM exemptions_motivos WHERE id = $1`,
        [id]
      );
      if (atual.rows.length === 0) {
        return res.status(404).json({ error: 'Motivo não encontrado' });
      }

      await pool.query(
        `UPDATE exemptions_motivos SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1`,
        [id]
      );

      await registrarAuditoria(
        req, 'EXEMPTION_MOTIVO_DELETE', AUDIT_CATEGORIES.FINANCIAL,
        'exemptions_motivos', id, { motivo: atual.rows[0].motivo }
      );

      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Erro ao remover motivo de isenção:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  return router;
}

module.exports = { createExemptionsRoutes };
