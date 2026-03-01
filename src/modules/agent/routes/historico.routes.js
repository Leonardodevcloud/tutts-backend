/**
 * routes/historico.routes.js
 * GET   /agent/historico        (admin)
 * PATCH /agent/validar/:id      (admin)
 * GET   /agent/historico/csv    (admin)
 */

'use strict';

const express = require('express');

function createHistoricoRoutes(pool, verificarAdmin) {
  const router = express.Router();

  // GET /agent/meu-historico (autenticado - motoboy vê só suas solicitações)
  router.get('/meu-historico', async (req, res) => {
    const usuarioId = req.user?.id;
    if (!usuarioId) return res.status(401).json({ erro: 'Não autenticado.' });

    const { page = 1, per_page = 20 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(per_page, 10);

    try {
      const [dataRes, countRes] = await Promise.all([
        pool.query(
          `SELECT id, os_numero, ponto, localizacao_raw, latitude, longitude,
                  endereco_corrigido, status, detalhe_erro, criado_em, processado_em
           FROM ajustes_automaticos
           WHERE usuario_id = $1
           ORDER BY criado_em DESC
           LIMIT $2 OFFSET $3`,
          [usuarioId, parseInt(per_page, 10), offset]
        ),
        pool.query(
          `SELECT COUNT(*) AS total FROM ajustes_automaticos WHERE usuario_id = $1`,
          [usuarioId]
        ),
      ]);

      return res.json({
        registros: dataRes.rows,
        total:     parseInt(countRes.rows[0].total, 10),
        page:      parseInt(page, 10),
        per_page:  parseInt(per_page, 10),
      });
    } catch (err) {
      console.error('[agent/meu-historico]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar histórico.' });
    }
  });

  // GET /agent/meu-historico/:id/foto (autenticado - motoboy vê foto da própria solicitação)
  router.get('/meu-historico/:id/foto', async (req, res) => {
    const usuarioId = req.user?.id;
    if (!usuarioId) return res.status(401).json({ erro: 'Não autenticado.' });

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const { rows } = await pool.query(
        `SELECT foto_fachada FROM ajustes_automaticos WHERE id = $1 AND usuario_id = $2`,
        [id, usuarioId]
      );
      if (rows.length === 0 || !rows[0].foto_fachada) {
        return res.status(404).json({ erro: 'Foto não encontrada.' });
      }
      return res.json({ foto: rows[0].foto_fachada });
    } catch (err) {
      console.error('[agent/meu-historico/foto]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar foto.' });
    }
  });

  // GET /agent/historico (admin)
  router.get('/historico', verificarAdmin, async (req, res) => {
    const { status, os_numero, de, ate, page = 1, per_page = 30 } = req.query;

    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (status)    { conditions.push(`status = $${p++}`);        params.push(status); }
    if (os_numero) { conditions.push(`os_numero ILIKE $${p++}`); params.push(`%${os_numero}%`); }
    if (de)        { conditions.push(`criado_em >= $${p++}`);    params.push(de); }
    if (ate)       { conditions.push(`criado_em <= $${p++}`);    params.push(ate); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page, 10) - 1) * parseInt(per_page, 10);

    try {
      const [dataRes, countRes] = await Promise.all([
        pool.query(
          `SELECT id, os_numero, ponto, status, detalhe_erro,
                  criado_em, processado_em, validado_por, validado_em
           FROM ajustes_automaticos ${where}
           ORDER BY criado_em DESC
           LIMIT $${p} OFFSET $${p + 1}`,
          [...params, parseInt(per_page, 10), offset]
        ),
        pool.query(
          `SELECT COUNT(*) AS total FROM ajustes_automaticos ${where}`,
          params
        ),
      ]);

      return res.json({
        registros: dataRes.rows,
        total:     parseInt(countRes.rows[0].total, 10),
        page:      parseInt(page, 10),
        per_page:  parseInt(per_page, 10),
      });
    } catch (err) {
      console.error('[agent/historico]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar histórico.' });
    }
  });

  // PATCH /agent/validar/:id
  router.patch('/validar/:id', verificarAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    const usuarioNome = req.user?.nome || req.user?.email || req.user?.name || 'Admin';

    try {
      const { rows } = await pool.query(
        `UPDATE ajustes_automaticos
         SET validado_por = $1, validado_em = NOW()
         WHERE id = $2
         RETURNING id, validado_por, validado_em`,
        [usuarioNome, id]
      );
      if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado.' });
      return res.json({ sucesso: true, ...rows[0] });
    } catch (err) {
      console.error('[agent/validar]', err.message);
      return res.status(500).json({ erro: 'Erro ao validar.' });
    }
  });

  // GET /agent/historico/csv
  router.get('/historico/csv', verificarAdmin, async (req, res) => {
    const { status, os_numero, de, ate } = req.query;
    const conditions = [];
    const params     = [];
    let   p          = 1;

    if (status)    { conditions.push(`status = $${p++}`);        params.push(status); }
    if (os_numero) { conditions.push(`os_numero ILIKE $${p++}`); params.push(`%${os_numero}%`); }
    if (de)        { conditions.push(`criado_em >= $${p++}`);    params.push(de); }
    if (ate)       { conditions.push(`criado_em <= $${p++}`);    params.push(ate); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const { rows } = await pool.query(
        `SELECT id, os_numero, ponto, status, detalhe_erro,
                criado_em, processado_em, validado_por, validado_em
         FROM ajustes_automaticos ${where}
         ORDER BY criado_em DESC`,
        params
      );

      const header = 'ID,OS,Ponto,Status,Detalhe Erro,Criado Em,Processado Em,Validado Por,Validado Em';
      const lines  = rows.map(r => [
        r.id, r.os_numero, r.ponto, r.status,
        `"${(r.detalhe_erro || '').replace(/"/g, '""')}"`,
        r.criado_em     ? new Date(r.criado_em).toLocaleString('pt-BR')     : '',
        r.processado_em ? new Date(r.processado_em).toLocaleString('pt-BR') : '',
        r.validado_por  || '',
        r.validado_em   ? new Date(r.validado_em).toLocaleString('pt-BR')   : '',
      ].join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ajustes_automaticos.csv"');
      return res.send('\uFEFF' + [header, ...lines].join('\n'));
    } catch (err) {
      console.error('[agent/historico/csv]', err.message);
      return res.status(500).json({ erro: 'Erro ao exportar CSV.' });
    }
  });

  return router;
}

module.exports = { createHistoricoRoutes };
