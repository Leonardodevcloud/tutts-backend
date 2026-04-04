/**
 * routes/correcao.routes.js
 * POST /agent/corrigir-endereco
 * GET  /agent/status/:id
 * GET  /agent/foto/:id
 */

'use strict';

const express = require('express');
const { validarLocalizacao } = require('../validar-localizacao');

// ── Haversine: distância em km entre dois pontos ────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const RAIO_MAXIMO_KM = 2;

function validarEntrada({ os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada }) {
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

  if (motoboy_lat == null || motoboy_lng == null) {
    erros.push('Localização GPS do motoboy é obrigatória. Ative o GPS e tente novamente.');
  } else {
    const lat = parseFloat(motoboy_lat);
    const lng = parseFloat(motoboy_lng);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      erros.push('Coordenadas GPS do motoboy inválidas.');
    }
  }

  if (!foto_fachada || String(foto_fachada).trim() === '') {
    erros.push('Foto da fachada é obrigatória.');
  }

  return erros;
}

function createCorrecaoRoutes(pool) {
  const router = express.Router();

  // Aumentar limite do body para aceitar foto base64
  router.use(express.json({ limit: '10mb' }));

  // POST /agent/corrigir-endereco
  router.post('/corrigir-endereco', async (req, res) => {
    const { os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada } = req.body || {};

    const erros = validarEntrada({ os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada });
    if (erros.length > 0) {
      return res.status(400).json({ sucesso: false, erros });
    }

    try {
      if (foto_fachada && foto_fachada.length > 7_000_000) {
        return res.status(400).json({ sucesso: false, erros: ['Foto muito grande. Máximo 5MB.'] });
      }

      const usuarioId       = req.user?.id   || null;
      const usuarioNome     = req.user?.nome || req.user?.name || req.user?.email || null;
      const codProfissional = req.user?.codProfissional || req.user?.cod_profissional || null;

      // Validar OS duplicada — bloqueia apenas se já teve sucesso
      const osExistente = await pool.query(
        `SELECT id, status FROM ajustes_automaticos WHERE os_numero = $1 AND status = 'sucesso' LIMIT 1`,
        [String(os_numero).trim()]
      );
      if (osExistente.rows.length > 0) {
        return res.status(409).json({
          sucesso: false,
          erros: ['Essa ordem de serviço já foi corrigida com sucesso anteriormente. Por favor, entre em contato com o suporte.'],
        });
      }

      // ── Validar localização: foto da fachada vs Google Places ──
      let validacaoLoc = null;
      try {
        validacaoLoc = await validarLocalizacao(
          foto_fachada,
          parseFloat(motoboy_lat),
          parseFloat(motoboy_lng)
        );

        if (validacaoLoc && validacaoLoc.foto_rejeitada) {
          // Foto inválida — BLOQUEAR envio
          console.log(`[agent] ❌ Foto rejeitada: ${validacaoLoc.motivo}`);
          return res.status(400).json({
            sucesso: false,
            foto_rejeitada: true,
            motivo_rejeicao: validacaoLoc.motivo,
            erros: [validacaoLoc.motivo],
          });
        }

        if (validacaoLoc && validacaoLoc.valido) {
          console.log(`[agent] ✅ Localização validada: "${validacaoLoc.nome_foto}" → "${validacaoLoc.match_google?.nome || 'N/A'}" (${validacaoLoc.confianca}%)`);
        } else if (validacaoLoc) {
          console.log(`[agent] ⚠️ Localização NÃO validada: ${validacaoLoc.motivo} — prosseguindo com aviso`);
        }
      } catch (valErr) {
        console.error('[agent] ⚠️ Erro validação localização (não-bloqueante):', valErr.message);
      }

      const validacaoJson = validacaoLoc ? JSON.stringify({
        valido: validacaoLoc.valido,
        nome_foto: validacaoLoc.nome_foto,
        match: validacaoLoc.match_google,
        confianca: validacaoLoc.confianca,
        motivo: validacaoLoc.motivo,
        lugares_proximos: validacaoLoc.lugares_proximos,
      }) : null;

      const { rows } = await pool.query(
        `INSERT INTO ajustes_automaticos (os_numero, ponto, localizacao_raw, motoboy_lat, motoboy_lng, foto_fachada, status, usuario_id, usuario_nome, cod_profissional, validacao_localizacao)
         VALUES ($1, $2, $3, $4, $5, $6, 'pendente', $7, $8, $9, $10)
         RETURNING id, status, criado_em`,
        [
          String(os_numero).trim(),
          parseInt(ponto, 10),
          String(localizacao_raw).trim(),
          parseFloat(motoboy_lat),
          parseFloat(motoboy_lng),
          foto_fachada,
          usuarioId,
          usuarioNome,
          codProfissional,
          validacaoJson,
        ]
      );

      const reg = rows[0];

      // 🔔 Notificar admin via WebSocket
      if (typeof global.broadcastToAdmins === 'function') {
        const wsPayload = {
          id: reg.id,
          os_numero: String(os_numero).trim(),
          cod_profissional: codProfissional,
          usuario_nome: usuarioNome,
          validacao: validacaoLoc ? {
            valido: validacaoLoc.valido,
            nome_foto: validacaoLoc.nome_foto,
            match: validacaoLoc.match_google,
            confianca: validacaoLoc.confianca,
            motivo: validacaoLoc.motivo,
          } : null,
        };
        global.broadcastToAdmins('AGENT_VALIDACAO', wsPayload);
      }

      return res.status(201).json({
        id: reg.id,
        status: reg.status,
        mensagem: 'Solicitação recebida, processando...',
        validacao_localizacao: validacaoLoc ? {
          valido: validacaoLoc.valido,
          nome_foto: validacaoLoc.nome_foto,
          match_google: validacaoLoc.match_google,
          confianca: validacaoLoc.confianca,
          motivo: validacaoLoc.motivo,
          alerta: !validacaoLoc.valido,
        } : null,
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

  // GET /agent/foto/:id
  router.get('/foto/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido.' });

    try {
      const { rows } = await pool.query(
        `SELECT foto_fachada FROM ajustes_automaticos WHERE id = $1`,
        [id]
      );
      if (rows.length === 0 || !rows[0].foto_fachada) {
        return res.status(404).json({ erro: 'Foto não encontrada.' });
      }
      return res.json({ foto: rows[0].foto_fachada });
    } catch (err) {
      console.error('[agent/foto]', err.message);
      return res.status(500).json({ erro: 'Erro ao buscar foto.' });
    }
  });


  // Screenshots debug (temporario - acesso via chave)
  const SDIR = '/tmp/screenshots';
  const SKEY = process.env.SCREENSHOT_KEY || 'tutts-debug-2025';

  router.get('/screenshots', async (req, res) => {
    if (req.query.key !== SKEY) return res.status(403).json({ erro: 'Use ?key=CHAVE' });
    try {
      const fs = require('fs');
      const path = require('path');
      if (!fs.existsSync(SDIR)) return res.json({ total: 0, files: [] });
      const files = fs.readdirSync(SDIR).filter(f => f.endsWith('.png')).sort((a, b) => b.localeCompare(a));
      const k = SKEY;
      const html = '<html><head><title>Screenshots</title><style>body{font-family:sans-serif;padding:20px;background:#111;color:#eee}img{max-width:100%;border:1px solid #333;border-radius:8px;margin:8px 0}.c{background:#1a1a2e;padding:12px;border-radius:8px;margin:12px 0}h2{color:#a78bfa;font-size:13px}</style></head><body><h1>Screenshots (' + files.length + ')</h1>' + files.map(function(f){return '<div class=c><h2>' + f + '</h2><img src=/api/agent/screenshots/' + encodeURIComponent(f) + '?key=' + k + ' loading=lazy></div>'}).join('') + '</body></html>';
      res.type('html').send(html);
    } catch(e) { res.status(500).json({erro:e.message}); }
  });

  router.get('/screenshots/:filename', async (req, res) => {
    if (req.query.key !== SKEY) return res.status(403).json({ erro: 'Acesso negado' });
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(SDIR, req.params.filename);
      if (!fs.existsSync(file)) return res.status(404).json({ erro: 'Nao encontrada' });
      res.type('image/png').sendFile(file);
    } catch(e) { res.status(500).json({erro:e.message}); }
  });

  return router;
}

module.exports = { createCorrecaoRoutes, haversineKm, RAIO_MAXIMO_KM };
