/**
 * routes/gratuidades-v2.routes.js
 * ─────────────────────────────────────────────────────────────────────────
 * Endpoints novos da listagem redesenhada de gratuidades.
 *
 * Semântica de status (revisada na v3):
 *
 *   ATIVA      → status='ativa' AND remaining > 0 AND expires_at > NOW()
 *   UTILIZADA  → remaining = 0  (consumida pelo motoboy)
 *   EXPIRADA   → status='ativa' AND remaining > 0 AND expires_at <= NOW()
 *                OR status = 'expirada_prazo'
 *   REMOVIDA   → status = 'removida' (soft-delete pelo admin)
 *
 * O legado tinha `status='expirada'` quando remaining chegava a 0. Mantemos
 * compatibilidade: esse status legado é tratado como UTILIZADA na UI.
 *
 * Endpoints:
 *   GET /listar          → paginada com filtros
 *   GET /kpis            → 4 cards
 *   GET /created-by      → distinct dos cadastrantes
 */

'use strict';

const express = require('express');

function createGratuidadesV2Routes(
  pool,
  verificarToken,
  verificarAdminOuFinanceiro
) {
  const router = express.Router();

  // SQL helper — CASE que computa status_ui (string da semântica acima).
  // Usado em SELECT e WHERE.
  const STATUS_UI_EXPR = `
    CASE
      WHEN status = 'removida' THEN 'removida'
      WHEN status = 'expirada_prazo' THEN 'expirada'
      WHEN remaining = 0 THEN 'utilizada'
      WHEN status = 'expirada' THEN 'utilizada'
      WHEN expires_at IS NOT NULL AND expires_at < NOW() THEN 'expirada'
      ELSE 'ativa'
    END
  `;

  // ═══════════════════════════════════════════════════════════════════════
  // GET /listar — listagem paginada
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/listar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const {
        status,        // 'ativa' | 'utilizada' | 'expirada' | 'removida' | 'todas'
        createdBy,
        motivo,
        busca,
        periodo,
        dataIni,
        dataFim,
      } = req.query;

      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const pageSize = Math.min(
        Math.max(parseInt(req.query.pageSize, 10) || 20, 1),
        100
      );
      const offset = (page - 1) * pageSize;

      const conds = [];
      const params = [];
      let i = 1;

      // Filtro de status usa o status_ui (CASE) — assim batemos exatamente
      // com o que o usuário vê na tela
      if (status && status !== 'todas') {
        conds.push(`(${STATUS_UI_EXPR}) = $${i++}`);
        params.push(String(status));
      } else {
        // Default: excluir removidas
        conds.push(`status <> 'removida'`);
      }

      if (createdBy) {
        conds.push(`created_by = $${i++}`);
        params.push(String(createdBy));
      }

      if (motivo) {
        conds.push(`UPPER(TRIM(reason)) = $${i++}`);
        params.push(String(motivo).trim().toUpperCase());
      }

      if (busca) {
        const termo = `%${String(busca).trim()}%`;
        conds.push(`(user_cod ILIKE $${i} OR user_name ILIKE $${i} OR reason ILIKE $${i})`);
        params.push(termo);
        i++;
      }

      // Período
      let dataInicio = null;
      let dataFimResolvido = null;
      if (dataIni) dataInicio = new Date(dataIni);
      if (dataFim) dataFimResolvido = new Date(dataFim);
      if (!dataInicio && periodo) {
        const agora = new Date();
        if (periodo === 'hoje') {
          dataInicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
        } else if (periodo === 'semana') {
          const d = new Date(agora); d.setDate(d.getDate() - 7); dataInicio = d;
        } else if (periodo === 'mes') {
          dataInicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
        } else if (periodo === '30d') {
          const d = new Date(agora); d.setDate(d.getDate() - 30); dataInicio = d;
        }
      }
      if (dataInicio) {
        conds.push(`created_at >= $${i++}`);
        params.push(dataInicio.toISOString());
      }
      if (dataFimResolvido) {
        conds.push(`created_at <= $${i++}`);
        params.push(dataFimResolvido.toISOString());
      }

      const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM gratuities ${whereSql}`,
        params
      );
      const total = totalResult.rows[0].total;

      const dadosParams = params.slice();
      dadosParams.push(pageSize, offset);

      const { rows } = await pool.query(`
        SELECT
          id,
          user_cod,
          user_name,
          quantity,
          remaining,
          value,
          reason,
          status,
          created_by,
          created_at,
          expires_at,
          expired_at,
          -- Dias restantes até expirar (negativo se já passou)
          CASE
            WHEN expires_at IS NULL THEN NULL
            ELSE EXTRACT(DAY FROM (expires_at - NOW()))::int
          END AS dias_para_expirar,
          (${STATUS_UI_EXPR}) AS status_ui
        FROM gratuities
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${i++} OFFSET $${i}
      `, dadosParams);

      res.json({
        dados: rows,
        paginacao: {
          page,
          pageSize,
          total,
          totalPaginas: Math.max(Math.ceil(total / pageSize), 1),
        },
      });
    } catch (err) {
      console.error('❌ Erro em /gratuities/listar:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /kpis — 4 cards do cabeçalho (com semântica nova)
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/kpis', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      // ATIVA  = ativa, remaining > 0, dentro do prazo
      // UTILIZADA = remaining=0 (consumida) — neste mês
      // EXPIRADA = passou prazo sem usar — neste mês
      // valor_ativo = soma value*remaining das ATIVAS
      // total_mes = soma value*quantity das criadas neste mês
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE status = 'ativa'
              AND remaining > 0
              AND (expires_at IS NULL OR expires_at > NOW())
          )::int AS ativas,
          COUNT(*) FILTER (
            WHERE created_at >= DATE_TRUNC('month', NOW())
              AND (remaining = 0 OR status = 'expirada')
              AND status <> 'expirada_prazo'
              AND status <> 'removida'
          )::int AS utilizadas_mes,
          COUNT(*) FILTER (
            WHERE created_at >= DATE_TRUNC('month', NOW())
              AND (
                status = 'expirada_prazo'
                OR (status = 'ativa' AND remaining > 0 AND expires_at IS NOT NULL AND expires_at < NOW())
              )
          )::int AS expiradas_mes,
          COALESCE(SUM(value * remaining) FILTER (
            WHERE status = 'ativa'
              AND remaining > 0
              AND (expires_at IS NULL OR expires_at > NOW())
          ), 0)::numeric AS valor_ativo,
          COALESCE(SUM(value * quantity) FILTER (
            WHERE created_at >= DATE_TRUNC('month', NOW())
              AND status <> 'removida'
          ), 0)::numeric AS total_mes
        FROM gratuities
      `);

      res.json(rows[0]);
    } catch (err) {
      console.error('❌ Erro em /gratuities/kpis:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /created-by
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/created-by', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT created_by
          FROM gratuities
         WHERE created_by IS NOT NULL
           AND TRIM(created_by) <> ''
           AND created_at >= NOW() - INTERVAL '6 months'
         ORDER BY created_by ASC
         LIMIT 50
      `);
      res.json(rows.map(r => r.created_by));
    } catch (err) {
      console.error('❌ Erro em /gratuities/created-by:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /lookup-user/:cod — busca rápida de motoboy por código
  // ═══════════════════════════════════════════════════════════════════════
  // 2026-05 v3: substitui o lookup antigo via `A.find()` que dependia do
  // array `submissions` carregado no app.js. Esse era enviesado (só pegava
  // motoboys com submissão recente). Agora vai direto na tabela users.
  //
  // Endpoint específico (vs reusar GET /users que é admin-only) — financeiro
  // precisa cadastrar gratuidade sem ser admin master.
  router.get('/lookup-user/:cod', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const cod = String(req.params.cod || '').trim();
      if (cod.length < 1) {
        return res.json(null);
      }
      const { rows } = await pool.query(`
        SELECT cod_profissional, full_name, role
          FROM users
         WHERE LOWER(cod_profissional) = LOWER($1)
         LIMIT 1
      `, [cod]);
      if (rows.length === 0) {
        return res.json(null);
      }
      res.json({
        codProfissional: rows[0].cod_profissional,
        fullName: rows[0].full_name,
        role: rows[0].role,
      });
    } catch (err) {
      console.error('❌ Erro em /gratuities/lookup-user:', err);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  return router;
}

module.exports = { createGratuidadesV2Routes };
