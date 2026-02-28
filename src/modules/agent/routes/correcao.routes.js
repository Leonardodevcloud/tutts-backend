/**
 * routes/correcao.routes.js
 * POST /agent/corrigir-endereco
 * GET  /agent/status/:id
 */

'use strict';

const express = require('express');

function validarEntrada({ os_numero, ponto, localizacao_raw }) {
  const erros = [];
  if (!os_numero || String(os_numero).trim() === '')
    erros.push('os_numero é obrigatório.');
  if (!/^\d+$/.test(String(os_numero || '').trim()))
    erros.push('os_numero deve conter apenas dígitos.');
  const pontoNum = parseInt(ponto, 10);
  if (isNaN(pontoNum))
    erros.push('ponto deve ser um número inteiro.');
  else if (pontoNum === 1)
    erros.push('O Ponto 1 nunca pode ser corrigido pelo agente.');
  else if (pontoNum < 2 || pontoNum > 7)
    erros.push('ponto deve ser entre 2 e 7.');
  if (!localizacao_raw || String(localizacao_raw).trim() === '')
    erros.push('localizacao_raw é obrigatório.');
  return erros;
}

function createCorrecaoRoutes(pool) {
  const router = express.Router();

  // POST /agent/corrigir-endereco
  router.post('/corrigir-endereco', async (req, res) => {
    const { os_numero, ponto, localizacao_raw } = req.body || {};

    const erros = validarEntrada({ os_numero, ponto, localizacao_raw });
    if (erros.length > 0) {
      return res.status(400).json({ sucesso: false, erros });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO ajustes_automaticos (os_numero, ponto, localizacao_raw, status)
         VALUES ($1, $2, $3, 'pendente')
         RETURNING id, status, criado_em`,
        [String(os_numero).trim(), parseInt(ponto, 10), String(localizacao_raw).trim()]
      );

      const reg = rows[0];
      return res.status(201).json({
        id:       reg.id,
        status:   reg.status,
        mensagem: 'Solicitação recebida, processando...',
      });
    } catch (err) {
      console.error('[agent/corrigir-endereco]', err.message);
      return res.status(500).json({ sucesso: false, erro: 'Erro interno ao enfileirar.' });
    }
  });

  // GET /agent/status/:id
  router.get('/status/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const { rows } = await pool.query(
        `SELECT id, os_numero, ponto, status, detalhe_erro, criado_em, processado_em
         FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado.' });
      return res.json(rows[0]);
    } catch (err) {
      console.error('[agent/status]', err.message);
      return res.status(500).json({ erro: 'Erro ao consultar status.' });
    }
  });

  return router;
}

module.exports = { createCorrecaoRoutes };
