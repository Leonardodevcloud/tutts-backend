'use strict';

/**
 * routes/clientes-bloqueados.routes.js (2026-07)
 * CRUD dos clientes bloqueados para ajuste + numero de suporte.
 *
 * Auth: /api/agent ja aplica verificarToken globalmente (server.js).
 *   - Listagem/CRUD: admin
 *   - GET suporte  : qualquer usuario autenticado (motoboy precisa pro botao)
 */

const express = require('express');

function createClientesBloqueadosRoutes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();
  const admin = verificarAdmin || ((req, res, next) => next());

  // Lista (admin)
  router.get('/clientes-bloqueados', admin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, nome_loja, endereco, ativo, criado_em, criado_por
           FROM clientes_bloqueados_ajuste
          ORDER BY ativo DESC, nome_loja ASC`
      );
      return res.json({ ok: true, clientes: rows });
    } catch (err) {
      console.error('[clientes-bloqueados/list]', err.message);
      return res.status(500).json({ ok: false, erro: 'Erro ao listar.' });
    }
  });

  // Cria (admin)
  router.post('/clientes-bloqueados', admin, async (req, res) => {
    const { nome_loja, endereco } = req.body || {};
    if (!nome_loja || String(nome_loja).trim() === '')
      return res.status(400).json({ ok: false, erro: 'Nome da loja é obrigatório.' });
    if (!endereco || String(endereco).trim() === '')
      return res.status(400).json({ ok: false, erro: 'Endereço é obrigatório.' });

    try {
      const criadoPor = req.user?.nome || req.user?.name || req.user?.email || null;
      const { rows } = await pool.query(
        `INSERT INTO clientes_bloqueados_ajuste (nome_loja, endereco, criado_por)
         VALUES ($1, $2, $3)
         RETURNING id, nome_loja, endereco, ativo, criado_em, criado_por`,
        [String(nome_loja).trim(), String(endereco).trim(), criadoPor]
      );
      return res.status(201).json({ ok: true, cliente: rows[0] });
    } catch (err) {
      console.error('[clientes-bloqueados/create]', err.message);
      return res.status(500).json({ ok: false, erro: 'Erro ao cadastrar.' });
    }
  });

  // Edita / ativa-desativa (admin)
  router.put('/clientes-bloqueados/:id', admin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, erro: 'ID inválido.' });

    const { nome_loja, endereco, ativo } = req.body || {};
    const sets = [];
    const params = [];
    if (nome_loja !== undefined) { sets.push(`nome_loja = $${params.length + 1}`); params.push(String(nome_loja).trim()); }
    if (endereco !== undefined) { sets.push(`endereco = $${params.length + 1}`); params.push(String(endereco).trim()); }
    if (ativo !== undefined) { sets.push(`ativo = $${params.length + 1}`); params.push(!!ativo); }
    if (sets.length === 0) return res.status(400).json({ ok: false, erro: 'Nada para atualizar.' });

    params.push(id);
    try {
      const { rows } = await pool.query(
        `UPDATE clientes_bloqueados_ajuste SET ${sets.join(', ')}
          WHERE id = $${params.length}
        RETURNING id, nome_loja, endereco, ativo, criado_em, criado_por`,
        params
      );
      if (rows.length === 0) return res.status(404).json({ ok: false, erro: 'Não encontrado.' });
      return res.json({ ok: true, cliente: rows[0] });
    } catch (err) {
      console.error('[clientes-bloqueados/update]', err.message);
      return res.status(500).json({ ok: false, erro: 'Erro ao atualizar.' });
    }
  });

  // Exclui (admin)
  router.delete('/clientes-bloqueados/:id', admin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, erro: 'ID inválido.' });
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM clientes_bloqueados_ajuste WHERE id = $1`, [id]
      );
      if (rowCount === 0) return res.status(404).json({ ok: false, erro: 'Não encontrado.' });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[clientes-bloqueados/delete]', err.message);
      return res.status(500).json({ ok: false, erro: 'Erro ao excluir.' });
    }
  });

  // Número de suporte — GET (qualquer autenticado) / PUT (admin)
  router.get('/clientes-bloqueados-suporte', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT numero_suporte FROM ajuste_bloqueio_config WHERE id = 1`);
      return res.json({ ok: true, numero_suporte: rows[0]?.numero_suporte || null });
    } catch (err) {
      console.error('[clientes-bloqueados/suporte-get]', err.message);
      return res.status(500).json({ ok: false, erro: 'Erro ao consultar.' });
    }
  });

  router.put('/clientes-bloqueados-suporte', admin, async (req, res) => {
    const { numero_suporte } = req.body || {};
    const num = String(numero_suporte || '').replace(/\D/g, '');
    if (num.length < 10) return res.status(400).json({ ok: false, erro: 'Número de suporte inválido.' });
    try {
      await pool.query(
        `INSERT INTO ajuste_bloqueio_config (id, numero_suporte) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET numero_suporte = EXCLUDED.numero_suporte`,
        [num]
      );
      return res.json({ ok: true, numero_suporte: num });
    } catch (err) {
      console.error('[clientes-bloqueados/suporte-put]', err.message);
      return res.status(500).json({ ok: false, erro: 'Erro ao salvar.' });
    }
  });

  return router;
}

module.exports = { createClientesBloqueadosRoutes };
