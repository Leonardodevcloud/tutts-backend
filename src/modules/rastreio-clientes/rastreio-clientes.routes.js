'use strict';

/**
 * rastreio-clientes.routes.js
 * CRUD config + histórico + reenviar. Todas as rotas exigem admin.
 */

const express = require('express');

function createRastreioClientesRouter(pool, deps = {}) {
  const { verificarToken, verificarAdmin, registrarAuditoria } = deps;
  const router = express.Router();

  const audit = async (req, acao, detalhes) => {
    if (typeof registrarAuditoria === 'function') {
      try {
        await registrarAuditoria(pool, {
          usuario_id: req.user?.id || null,
          usuario_nome: req.user?.nome || req.user?.email || 'admin',
          categoria: 'RASTREIO_CLIENTES',
          acao, detalhes,
        });
      } catch (e) { console.error('[rastreio-clientes] audit:', e.message); }
    }
  };

  // ============ CONFIG ============
  router.get('/config', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM rastreio_clientes_config ORDER BY ativo DESC, cliente_cod'
      );
      res.json({ ok: true, clientes: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  router.post('/config', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cliente_cod, nome_exibicao, ativo, evolution_group_id, termos_filtro, observacoes } = req.body || {};
      if (!cliente_cod || !nome_exibicao || !evolution_group_id) {
        return res.status(400).json({ ok: false, erro: 'campos_obrigatorios' });
      }
      const termos = Array.isArray(termos_filtro) && termos_filtro.length ? termos_filtro : null;
      const { rows } = await pool.query(
        `INSERT INTO rastreio_clientes_config
          (cliente_cod, nome_exibicao, ativo, evolution_group_id, termos_filtro, observacoes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [String(cliente_cod), nome_exibicao, ativo !== false, evolution_group_id, termos, observacoes || null]
      );
      await audit(req, 'criar_cliente', { cliente_cod });
      res.json({ ok: true, cliente: rows[0] });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ ok: false, erro: 'cliente_ja_existe' });
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  router.put('/config/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { nome_exibicao, ativo, evolution_group_id, termos_filtro, observacoes } = req.body || {};
      const termos = Array.isArray(termos_filtro) && termos_filtro.length ? termos_filtro : null;
      const { rows } = await pool.query(
        `UPDATE rastreio_clientes_config
            SET nome_exibicao=$1, ativo=$2, evolution_group_id=$3,
                termos_filtro=$4, observacoes=$5, atualizado_em=NOW()
          WHERE id=$6 RETURNING *`,
        [nome_exibicao, ativo !== false, evolution_group_id, termos, observacoes || null, id]
      );
      if (!rows[0]) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
      await audit(req, 'editar_cliente', { id, cliente_cod: rows[0].cliente_cod });
      res.json({ ok: true, cliente: rows[0] });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  router.delete('/config/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'DELETE FROM rastreio_clientes_config WHERE id=$1 RETURNING cliente_cod',
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
      await audit(req, 'remover_cliente', { id: req.params.id, cliente_cod: rows[0].cliente_cod });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ============ HISTÓRICO ============
  router.get('/historico', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { data, cliente, status } = req.query;
      const where = []; const params = [];
      if (data) { params.push(data); where.push(`(criado_em AT TIME ZONE 'America/Bahia')::date = $${params.length}::date`); }
      else      { where.push(`(criado_em AT TIME ZONE 'America/Bahia')::date = (NOW() AT TIME ZONE 'America/Bahia')::date`); }
      if (cliente) { params.push(String(cliente)); where.push(`cliente_cod = $${params.length}`); }
      if (status)  { params.push(String(status));  where.push(`status = $${params.length}`); }
      const sql = `SELECT id, os_numero, cliente_cod, cod_rastreio, profissional, status,
                          tentativas, erro_msg, criado_em, enviado_em
                     FROM sla_capturas
                    WHERE ${where.join(' AND ')}
                    ORDER BY criado_em DESC LIMIT 500`;
      const { rows } = await pool.query(sql, params);
      res.json({ ok: true, total: rows.length, capturas: rows });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  router.post('/historico/:id/reenviar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE sla_capturas
            SET status='pendente', tentativas=0, erro_msg=NULL
          WHERE id=$1 RETURNING os_numero, cliente_cod`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
      await audit(req, 'reenviar_captura', { id: req.params.id, os_numero: rows[0].os_numero });
      res.json({ ok: true, message: 'Reenfileirado, próximo tick do worker vai processar' });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  return router;
}

module.exports = { createRastreioClientesRouter };
