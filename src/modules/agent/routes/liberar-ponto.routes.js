/**
 * routes/liberar-ponto.routes.js
 * Endpoints da feature "Liberar Ponto" (Agent RPA novo).
 *
 * Endpoints:
 *   POST /agent/liberar-ponto              — motoboy enfileira liberação da OS
 *   GET  /agent/liberar-ponto/status/:id   — polling pra acompanhar
 *   GET  /agent/liberar-ponto/historico    — admin vê histórico
 *   GET  /agent/liberar-ponto/meu-historico — motoboy vê só o dele
 */

'use strict';

const express = require('express');

function validarEntrada({ os_numero }) {
  const erros = [];
  if (!os_numero || String(os_numero).trim() === '') {
    erros.push('os_numero é obrigatório.');
    return erros;
  }
  const limpo = String(os_numero).trim();
  if (!/^\d+$/.test(limpo)) erros.push('os_numero deve conter apenas dígitos.');
  else if (limpo.length !== 7) erros.push(`Número da OS deve ter exatamente 7 dígitos (recebido: ${limpo.length}).`);
  return erros;
}

function createLiberacaoRoutes(pool) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // ── POST /agent/liberar-ponto — motoboy enfileira liberação ─────────────
  router.post('/liberar-ponto', async (req, res) => {
    const { os_numero } = req.body || {};
    const erros = validarEntrada({ os_numero });
    if (erros.length > 0) return res.status(400).json({ sucesso: false, erros });

    try {
      const usuarioId       = req.user?.id   || null;
      const usuarioNome     = req.user?.nome || req.user?.name || req.user?.email || null;
      const codProfissional = req.user?.codProfissional || req.user?.cod_profissional || null;

      const osLimpa = String(os_numero).trim();

      // Já foi liberada com sucesso?
      const jaLiberada = await pool.query(
        `SELECT id FROM liberacoes_pontos WHERE os_numero = $1 AND status = 'sucesso' LIMIT 1`,
        [osLimpa]
      );
      if (jaLiberada.rows.length > 0) {
        return res.status(409).json({
          sucesso: false,
          erros: [`A OS ${osLimpa} já foi liberada anteriormente. Se ainda há problema, contate o suporte.`],
        });
      }

      // Já tem pendente/processando?
      const emAndamento = await pool.query(
        `SELECT id, status FROM liberacoes_pontos
          WHERE os_numero = $1 AND status IN ('pendente', 'processando')
          LIMIT 1`,
        [osLimpa]
      );
      if (emAndamento.rows.length > 0) {
        return res.status(409).json({
          sucesso: false,
          erros: [`A OS ${osLimpa} já está sendo processada. Aguarde a conclusão.`],
        });
      }

      const { rows } = await pool.query(`
        INSERT INTO liberacoes_pontos (
          os_numero, status, usuario_id, usuario_nome, cod_profissional
        ) VALUES ($1, 'pendente', $2, $3, $4)
        RETURNING id, status, criado_em
      `, [osLimpa, usuarioId, usuarioNome, codProfissional]);

      const reg = rows[0];
      return res.status(201).json({
        id: reg.id,
        status: reg.status,
        mensagem: 'Solicitação recebida, processando...',
      });

    } catch (err) {
      console.error('[agent/liberar-ponto]', err.message);
      return res.status(500).json({ sucesso: false, erro: 'Erro interno ao enfileirar.' });
    }
  });

  // ── GET /agent/liberar-ponto/status/:id — polling motoboy ────────────────
  router.get('/liberar-ponto/status/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const usuarioId = req.user?.id || null;
      // Motoboy só vê os próprios; admin vê tudo
      const isAdmin = req.user?.tipo === 'admin' || req.user?.role === 'admin';

      let q;
      if (isAdmin) {
        q = await pool.query(
          `SELECT id, os_numero, status, etapa_atual, progresso, erro,
                  mensagem_retorno, criado_em, finalizado_em
             FROM liberacoes_pontos WHERE id = $1`,
          [id]
        );
      } else {
        q = await pool.query(
          `SELECT id, os_numero, status, etapa_atual, progresso, erro,
                  mensagem_retorno, criado_em, finalizado_em
             FROM liberacoes_pontos WHERE id = $1 AND usuario_id = $2`,
          [id, usuarioId]
        );
      }

      if (q.rows.length === 0) return res.status(404).json({ erro: 'Não encontrado.' });
      return res.json(q.rows[0]);
    } catch (err) {
      console.error('[agent/liberar-ponto/status]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar status.' });
    }
  });

  // ── GET /agent/liberar-ponto/meu-historico — motoboy vê o seu histórico ──
  router.get('/liberar-ponto/meu-historico', async (req, res) => {
    const usuarioId = req.user?.id || null;
    if (!usuarioId) return res.status(401).json({ erro: 'Não autenticado.' });

    const { page = 1, per_page = 20 } = req.query;
    const limit = Math.min(parseInt(per_page, 10) || 20, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    try {
      const { rows } = await pool.query(`
        SELECT id, os_numero, status, etapa_atual, progresso, erro,
               mensagem_retorno, criado_em, finalizado_em
          FROM liberacoes_pontos
         WHERE usuario_id = $1
         ORDER BY criado_em DESC
         LIMIT $2 OFFSET $3
      `, [usuarioId, limit, offset]);

      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM liberacoes_pontos WHERE usuario_id = $1`,
        [usuarioId]
      );

      return res.json({
        registros: rows,
        total: total.rows[0].total,
        page: parseInt(page, 10),
        per_page: limit,
      });
    } catch (err) {
      console.error('[agent/liberar-ponto/meu-historico]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
  });

  // ── GET /agent/liberar-ponto/historico (admin) ───────────────────────────
  router.get('/liberar-ponto/historico', async (req, res) => {
    const isAdmin = req.user?.tipo === 'admin' || req.user?.role === 'admin';
    if (!isAdmin) return res.status(403).json({ erro: 'Acesso negado.' });

    const { status, os_numero, de, ate, page = 1, per_page = 30 } = req.query;
    const limit = Math.min(parseInt(per_page, 10) || 30, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    const where = [];
    const params = [];
    if (status)    { params.push(status);    where.push(`status = $${params.length}`); }
    if (os_numero) { params.push(`%${os_numero}%`); where.push(`os_numero ILIKE $${params.length}`); }
    if (de)        { params.push(de);        where.push(`criado_em >= $${params.length}`); }
    if (ate)       { params.push(ate);       where.push(`criado_em <= $${params.length}`); }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      params.push(limit, offset);
      const { rows } = await pool.query(`
        SELECT id, os_numero, status, etapa_atual, progresso, erro,
               mensagem_retorno, usuario_nome, cod_profissional,
               criado_em, finalizado_em, screenshot_path
          FROM liberacoes_pontos
         ${whereSQL}
         ORDER BY criado_em DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);

      const totalParams = params.slice(0, params.length - 2);
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM liberacoes_pontos ${whereSQL}`,
        totalParams
      );

      return res.json({
        registros: rows,
        total: total.rows[0].total,
        page: parseInt(page, 10),
        per_page: limit,
      });
    } catch (err) {
      console.error('[agent/liberar-ponto/historico]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
  });

  return router;
}

module.exports = { createLiberacaoRoutes };
