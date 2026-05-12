/**
 * routes/gratuidades-v2.routes.js
 * ─────────────────────────────────────────────────────────────────────────
 * Endpoints novos da listagem redesenhada de gratuidades.
 *
 * Endpoints (montados como sub-router em /financial/gratuities):
 *   GET /listar          → listagem paginada com filtros (status, created_by,
 *                          motivo, busca, periodo, page, pageSize)
 *   GET /kpis            → 4 KPIs do cabeçalho (ativas, expiradas_mes,
 *                          valor_ativo, total_mes)
 *   GET /created-by      → distinct dos cadastrantes (alimenta filtro)
 *
 * O endpoint legado GET /gratuities continua existindo no financial.routes.js
 * pra compatibilidade com outros consumidores (Score v2, scripts, etc).
 *
 * Padrões seguidos:
 *   - SQL parameterizado ($1, $2)
 *   - Limite máximo de pageSize=100 pra prevenir abuso
 *   - Filtros opcionais (todos nullable) compostos via condicionais
 *   - COUNT(*) em query separada pra paginação correta
 */

'use strict';

const express = require('express');

function createGratuidadesV2Routes(
  pool,
  verificarToken,
  verificarAdminOuFinanceiro
) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════════════
  // GET /listar — listagem paginada com filtros
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/listar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const {
        status,        // 'ativa' | 'expirada' | 'parcial' | 'removida' | 'todas'
        createdBy,     // nome exato do cadastrante (filtro de igualdade)
        motivo,        // motivo (filtro LIKE, normalizado)
        busca,         // texto livre (cod, nome, motivo)
        periodo,       // 'hoje' | 'semana' | 'mes' | '30d' | null
        dataIni,       // ISO opcional (substitui periodo)
        dataFim,       // ISO opcional
      } = req.query;

      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const pageSize = Math.min(
        Math.max(parseInt(req.query.pageSize, 10) || 20, 1),
        100
      );
      const offset = (page - 1) * pageSize;

      // Construção dinâmica de WHERE
      const conds = [];
      const params = [];
      let i = 1;

      // Status — semântica especial: 'ativa' = ativa com remaining>0,
      // 'parcial' = ativa mas remaining<quantity, 'expirada' = remaining=0
      // ou status='expirada', 'removida' = soft-deleted
      if (status && status !== 'todas') {
        if (status === 'ativa') {
          conds.push(`(status = 'ativa' AND remaining = quantity)`);
        } else if (status === 'parcial') {
          conds.push(`(status = 'ativa' AND remaining > 0 AND remaining < quantity)`);
        } else if (status === 'expirada') {
          conds.push(`(status = 'expirada' OR (status = 'ativa' AND remaining = 0))`);
        } else if (status === 'removida') {
          conds.push(`status = 'removida'`);
        } else {
          conds.push(`status = $${i++}`);
          params.push(status);
        }
      } else {
        // Sem filtro: excluímos 'removida' por default (soft-delete invisível)
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
        conds.push(`(
          user_cod ILIKE $${i} OR
          user_name ILIKE $${i} OR
          reason ILIKE $${i}
        )`);
        params.push(termo);
        i++;
      }

      // Período: aplica em created_at
      let dataInicio = null;
      let dataFimResolvido = null;

      if (dataIni) dataInicio = new Date(dataIni);
      if (dataFim) dataFimResolvido = new Date(dataFim);

      if (!dataInicio && periodo) {
        const agora = new Date();
        if (periodo === 'hoje') {
          dataInicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
        } else if (periodo === 'semana') {
          const d = new Date(agora);
          d.setDate(d.getDate() - 7);
          dataInicio = d;
        } else if (periodo === 'mes') {
          dataInicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
        } else if (periodo === '30d') {
          const d = new Date(agora);
          d.setDate(d.getDate() - 30);
          dataInicio = d;
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

      // Total pra paginação (sem LIMIT/OFFSET) — query separada
      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM gratuities ${whereSql}`,
        params
      );
      const total = totalResult.rows[0].total;

      // Dados paginados (com LIMIT/OFFSET nos params subsequentes)
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
          expired_at,
          -- Status computado pra UI (não confunde com coluna status crua)
          CASE
            WHEN status = 'removida' THEN 'removida'
            WHEN status = 'expirada' THEN 'expirada'
            WHEN remaining = 0 THEN 'expirada'
            WHEN remaining < quantity THEN 'parcial'
            ELSE 'ativa'
          END AS status_ui
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
  // GET /kpis — 4 cards do cabeçalho
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/kpis', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      // Tudo numa query só com FILTER — mais rápido que 4 roundtrips
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'ativa' AND remaining > 0)::int AS ativas,
          COUNT(*) FILTER (
            WHERE created_at >= DATE_TRUNC('month', NOW())
              AND (status = 'expirada' OR (status = 'ativa' AND remaining = 0))
          )::int AS expiradas_mes,
          COALESCE(SUM(value * remaining) FILTER (
            WHERE status = 'ativa' AND remaining > 0
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
  // GET /created-by — distinct dos cadastrantes (alimenta filtro)
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/created-by', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      // Pega os 30 dos últimos 6 meses pra evitar listar gente que não está mais no time
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

  return router;
}

module.exports = { createGratuidadesV2Routes };
