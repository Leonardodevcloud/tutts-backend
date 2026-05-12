/**
 * routes/gratuidades-motivos.routes.js
 * ─────────────────────────────────────────────────────────────────────────
 * CRUD dos motivos pré-definidos de gratuidades.
 *
 * Endpoints:
 *   GET    /financial/gratuities/motivos          → listar (com contador de uso)
 *   POST   /financial/gratuities/motivos          → criar
 *   PATCH  /financial/gratuities/motivos/:id      → editar motivo (renomeia)
 *   DELETE /financial/gratuities/motivos/:id      → soft-delete (ativo=false)
 *
 * Regras:
 *   - Motivo é sempre normalizado pra UPPERCASE + TRIM antes de gravar.
 *   - UNIQUE constraint na coluna motivo previne duplicatas.
 *   - Soft-delete preserva auditoria de gratuidades antigas que usaram o motivo.
 *   - Auditoria via AUDIT_CATEGORIES.FINANCIAL em todas as mutações.
 */

'use strict';

const express = require('express');

function createGratuidadesMotivosRoutes(
  pool,
  verificarToken,
  verificarAdminOuFinanceiro,
  registrarAuditoria,
  AUDIT_CATEGORIES
) {
  const router = express.Router();

  // Normalização single-source-of-truth
  function normalizarMotivo(raw) {
    if (raw == null) return '';
    return String(raw).trim().toUpperCase().slice(0, 120);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GET — listar motivos com contador de uso
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/motivos', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      // Query param ?incluirInativos=1 retorna também os soft-deleted
      const incluirInativos = req.query.incluirInativos === '1';

      const where = incluirInativos ? '' : 'WHERE m.ativo = TRUE';

      // LEFT JOIN agregado pra contador. UPPER(TRIM(reason)) compara com
      // motivo normalizado — pega usos mesmo de antes da normalização.
      const { rows } = await pool.query(`
        SELECT
          m.id,
          m.motivo,
          m.ativo,
          m.criado_por,
          m.criado_em,
          m.atualizado_em,
          COALESCE(uso.total, 0)::int AS contador_uso
        FROM gratuities_motivos m
        LEFT JOIN (
          SELECT UPPER(TRIM(reason)) AS motivo_norm, COUNT(*) AS total
            FROM gratuities
           WHERE reason IS NOT NULL AND TRIM(reason) <> ''
           GROUP BY UPPER(TRIM(reason))
        ) uso ON uso.motivo_norm = m.motivo
        ${where}
        ORDER BY m.motivo ASC
      `);

      res.json(rows);
    } catch (err) {
      console.error('❌ Erro ao listar motivos:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST — criar motivo
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/motivos', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const motivo = normalizarMotivo(req.body && req.body.motivo);
      if (!motivo) {
        return res.status(400).json({ error: 'Motivo é obrigatório' });
      }

      const criadoPor = (req.user && (req.user.nome || req.user.username)) || 'admin';

      // ON CONFLICT: se já existir, retorna o existente (reativa se estiver inativo)
      const { rows } = await pool.query(`
        INSERT INTO gratuities_motivos (motivo, criado_por)
        VALUES ($1, $2)
        ON CONFLICT (motivo) DO UPDATE
          SET ativo = TRUE,
              atualizado_em = NOW()
        RETURNING id, motivo, ativo, criado_por, criado_em, atualizado_em
      `, [motivo, criadoPor]);

      await registrarAuditoria(
        req, 'GRATUIDADE_MOTIVO_CREATE', AUDIT_CATEGORIES.FINANCIAL,
        'gratuities_motivos', rows[0].id, { motivo }
      );

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar motivo:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PATCH — editar (renomear) motivo
  // ═══════════════════════════════════════════════════════════════════════
  router.patch('/motivos/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const novoMotivo = normalizarMotivo(req.body && req.body.motivo);

      if (!id || !novoMotivo) {
        return res.status(400).json({ error: 'id e motivo são obrigatórios' });
      }

      // Verifica se existe
      const atual = await pool.query(
        `SELECT motivo FROM gratuities_motivos WHERE id = $1`,
        [id]
      );
      if (atual.rows.length === 0) {
        return res.status(404).json({ error: 'Motivo não encontrado' });
      }

      const motivoAntigo = atual.rows[0].motivo;
      if (motivoAntigo === novoMotivo) {
        return res.json({ ok: true, sem_mudanca: true });
      }

      // Conflito com outro registro?
      const conflito = await pool.query(
        `SELECT id FROM gratuities_motivos WHERE motivo = $1 AND id <> $2`,
        [novoMotivo, id]
      );
      if (conflito.rows.length > 0) {
        return res.status(409).json({ error: 'Já existe um motivo com esse nome' });
      }

      const { rows } = await pool.query(`
        UPDATE gratuities_motivos
           SET motivo = $1, atualizado_em = NOW()
         WHERE id = $2
         RETURNING id, motivo, ativo, criado_por, criado_em, atualizado_em
      `, [novoMotivo, id]);

      await registrarAuditoria(
        req, 'GRATUIDADE_MOTIVO_UPDATE', AUDIT_CATEGORIES.FINANCIAL,
        'gratuities_motivos', id, { de: motivoAntigo, para: novoMotivo }
      );

      res.json(rows[0]);
    } catch (err) {
      console.error('❌ Erro ao editar motivo:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE — soft-delete (preserva histórico das gratuidades)
  // ═══════════════════════════════════════════════════════════════════════
  router.delete('/motivos/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const atual = await pool.query(
        `SELECT motivo, ativo FROM gratuities_motivos WHERE id = $1`,
        [id]
      );
      if (atual.rows.length === 0) {
        return res.status(404).json({ error: 'Motivo não encontrado' });
      }

      // Soft-delete: marca ativo=false. A coluna `motivo` permanece intacta
      // pra continuar respondendo no histórico de gratuidades antigas.
      await pool.query(
        `UPDATE gratuities_motivos
            SET ativo = FALSE, atualizado_em = NOW()
          WHERE id = $1`,
        [id]
      );

      await registrarAuditoria(
        req, 'GRATUIDADE_MOTIVO_DELETE', AUDIT_CATEGORIES.FINANCIAL,
        'gratuities_motivos', id, { motivo: atual.rows[0].motivo }
      );

      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Erro ao remover motivo:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  return router;
}

module.exports = { createGratuidadesMotivosRoutes };
