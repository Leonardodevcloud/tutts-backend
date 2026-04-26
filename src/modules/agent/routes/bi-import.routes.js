/**
 * routes/bi-import.routes.js
 * Endpoints da feature "Import Planilha BI" (Agent RPA novo).
 *
 * Endpoints:
 *   POST /agent/bi-import              — admin enfileira import manual
 *   GET  /agent/bi-import/status/:id   — polling status
 *   GET  /agent/bi-import/historico    — admin lista histórico
 */

'use strict';

const express = require('express');

function createBiImportRoutes(pool) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // Helper: reconhecer admin nos formatos do sistema
  const checarAdmin = (req) => req.user?.tipo === 'admin' ||
    ['admin', 'admin_master', 'admin_financeiro'].includes(req.user?.role);

  // Calcular D-1 em America/Bahia (default quando admin não especifica data)
  const calcularDataD1 = () => {
    const agora = new Date();
    const bahiaMs = agora.getTime() - (3 * 60 * 60 * 1000);
    const bahia = new Date(bahiaMs);
    bahia.setUTCDate(bahia.getUTCDate() - 1);
    return bahia.toISOString().slice(0, 10);
  };

  // ── POST /agent/bi-import — admin enfileira import manual ────────────
  router.post('/bi-import', async (req, res) => {
    if (!checarAdmin(req)) return res.status(403).json({ erro: 'Acesso negado.' });

    const { data_referencia } = req.body || {};
    let dataRef = data_referencia;

    // Validação da data
    if (dataRef) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataRef)) {
        return res.status(400).json({ erros: ['data_referencia deve ser YYYY-MM-DD.'] });
      }
    } else {
      dataRef = calcularDataD1();
    }

    try {
      const usuarioId = req.user?.id || null;
      const usuarioNome = req.user?.nome || req.user?.email || 'Importação manual';

      // Já tem job pendente/processando pra essa data?
      const emAndamento = await pool.query(
        `SELECT id, status FROM bi_imports
          WHERE data_referencia = $1 AND status IN ('pendente', 'processando')
          LIMIT 1`,
        [dataRef]
      );
      if (emAndamento.rows.length > 0) {
        return res.status(409).json({
          erro: `Já existe um job ${emAndamento.rows[0].status} pra ${dataRef}.`,
        });
      }

      const { rows } = await pool.query(`
        INSERT INTO bi_imports (data_referencia, origem, status, usuario_id, usuario_nome)
        VALUES ($1, 'manual', 'pendente', $2, $3)
        RETURNING id, status, criado_em
      `, [dataRef, usuarioId, usuarioNome]);

      const reg = rows[0];
      return res.status(201).json({
        id: reg.id,
        status: reg.status,
        data_referencia: dataRef,
        mensagem: 'Importação enfileirada. O processo demora ~3-5min.',
      });
    } catch (err) {
      console.error('[agent/bi-import]', err.message);
      return res.status(500).json({ erro: 'Erro interno ao enfileirar.' });
    }
  });

  // ── GET /agent/bi-import/status/:id — polling ────────────────────────
  router.get('/bi-import/status/:id', async (req, res) => {
    if (!checarAdmin(req)) return res.status(403).json({ erro: 'Acesso negado.' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const { rows } = await pool.query(`
        SELECT id, data_referencia, origem, status, etapa_atual, progresso,
               total_linhas, linhas_inseridas, linhas_ignoradas, erro,
               usuario_nome, criado_em, finalizado_em
          FROM bi_imports WHERE id = $1
      `, [id]);
      if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado.' });
      return res.json(rows[0]);
    } catch (err) {
      console.error('[agent/bi-import/status]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar status.' });
    }
  });

  // ── GET /agent/bi-import/historico — admin lista ─────────────────────
  router.get('/bi-import/historico', async (req, res) => {
    if (!checarAdmin(req)) return res.status(403).json({ erro: 'Acesso negado.' });

    const { status, origem, data_referencia, page = 1, per_page = 30 } = req.query;
    const limit = Math.min(parseInt(per_page, 10) || 30, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    const where = [];
    const params = [];
    if (status)          { params.push(status);          where.push(`status = $${params.length}`); }
    if (origem)          { params.push(origem);          where.push(`origem = $${params.length}`); }
    if (data_referencia) { params.push(data_referencia); where.push(`data_referencia = $${params.length}`); }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      params.push(limit, offset);
      const { rows } = await pool.query(`
        SELECT id, data_referencia, origem, status, etapa_atual, progresso,
               total_linhas, linhas_inseridas, linhas_ignoradas, erro,
               usuario_nome, criado_em, finalizado_em, screenshot_path
          FROM bi_imports
         ${whereSQL}
         ORDER BY criado_em DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);

      const totalParams = params.slice(0, params.length - 2);
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM bi_imports ${whereSQL}`,
        totalParams
      );

      return res.json({
        registros: rows,
        total: total.rows[0].total,
        page: parseInt(page, 10),
        per_page: limit,
      });
    } catch (err) {
      console.error('[agent/bi-import/historico]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
  });

  return router;
}

module.exports = { createBiImportRoutes };
