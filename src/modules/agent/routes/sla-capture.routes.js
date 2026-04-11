/**
 * routes/sla-capture.routes.js
 *
 * Endpoints:
 *   POST /agent/sla-capture/trigger     (público — validado por Origin + token opcional)
 *   GET  /agent/sla-capture/historico   (admin)
 *   GET  /agent/sla-capture/status/:os  (admin)
 *
 * Segurança do trigger:
 *   - Valida Origin/Referer contra tutts.com.br (fonte da extensão)
 *   - Opcionalmente valida SLA_CAPTURE_TOKEN se configurado (header x-sla-token)
 *   - Dedup garantido pelo UNIQUE(os_numero) na tabela
 *   - Rate limit natural: 1 registro por OS nunca processa 2x
 */

'use strict';

const express = require('express');
const { enfileirarCaptura } = require('../sla-capture.service');

// Origens permitidas pro trigger
const ORIGENS_VALIDAS = [
  'https://tutts.com.br',
  'https://www.tutts.com.br',
];

function validarOrigem(req) {
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';

  // Origin explícito bate?
  if (ORIGENS_VALIDAS.includes(origin)) return true;

  // Referer começa com origem válida? (content script pode não mandar Origin)
  return ORIGENS_VALIDAS.some((o) => referer.startsWith(o));
}

function validarToken(req) {
  const tokenEsperado = process.env.SLA_CAPTURE_TOKEN;
  if (!tokenEsperado) return true; // não configurado → validação desativada
  const recebido = req.headers['x-sla-token'] || '';
  return recebido === tokenEsperado;
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    null
  );
}

function createSlaCaptureRoutes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // ────────────────────────────────────────────────────────────────────────
  // POST /agent/sla-capture/trigger   (chamado pela extensão)
  // ────────────────────────────────────────────────────────────────────────
  router.post('/sla-capture/trigger', express.json({ limit: '256kb' }), async (req, res) => {
    // 🔧 DEPRECATED: detector HTTP no backend (sla-detector-worker) assumiu a detecção.
    // Endpoint mantido como no-op pra não quebrar extensões antigas instaladas.
    console.log('[sla-capture/trigger] DEPRECATED no-op:', req.body?.os_numero || '?');
    return res.json({
      sucesso: true,
      deprecated: true,
      skipped: true,
      message: 'Endpoint descontinuado. Detecção agora é automática via backend.',
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET /agent/sla-capture/historico   (admin)
  // ────────────────────────────────────────────────────────────────────────
  router.get('/sla-capture/historico', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const limite = Math.min(parseInt(req.query.limite, 10) || 100, 500);
      const cliente = req.query.cliente_cod;
      const status = req.query.status;

      const where = [];
      const params = [];

      if (cliente) {
        params.push(cliente);
        where.push(`cliente_cod = $${params.length}`);
      }
      if (status) {
        params.push(status);
        where.push(`status = $${params.length}`);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limite);

      const { rows } = await pool.query(
        `
        SELECT id, os_numero, cliente_cod, cod_rastreio, profissional,
               status, tentativas, erro, criado_em, enviado_em, atualizado_em
        FROM sla_capturas
        ${whereSql}
        ORDER BY criado_em DESC
        LIMIT $${params.length}
        `,
        params
      );

      res.json({ total: rows.length, capturas: rows });
    } catch (err) {
      console.error('[sla-capture/historico] erro:', err);
      res.status(500).json({ erro: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET /agent/sla-capture/status/:os   (admin)
  // ────────────────────────────────────────────────────────────────────────
  router.get('/sla-capture/status/:os', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM sla_capturas WHERE os_numero = $1`, [
        req.params.os,
      ]);
      if (rows.length === 0) return res.status(404).json({ erro: 'não encontrada' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  return router;
}

module.exports = { createSlaCaptureRoutes };
