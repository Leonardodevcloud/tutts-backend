/**
 * MODULO LOGISTICS - Portal do Cliente (loja)
 *
 * Superficie READ-ONLY e ISOLADA pra loja acompanhar as proprias entregas.
 * A loja NUNCA entra no auth interno: token proprio (PORTAL_JWT_SECRET),
 * escopo 'portal', sem role. Um token de loja nao passa no verificarToken
 * interno (assinado com JWT_SECRET) e vice-versa.
 *
 * 1 login por regra: o token carrega { regra_id } e o /deliveries filtra
 * WHERE regra_id = token.regra_id. So enxerga as entregas daquela regra.
 *
 * Endpoints (montados em /api/logistics/portal):
 *   POST /login       -> publico (isento de CSRF via lista em middleware/csrf.js)
 *   GET  /me          -> dados da regra logada (nome do cliente)
 *   GET  /deliveries  -> kanban da loja (mesmo shape do painel interno, SEM valores)
 *
 * Marker: PORTAL_CLIENTE_ROUTES_V1
 */

'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const JWT_SECRET = process.env.JWT_SECRET;
// Segredo proprio do portal. Fallback derivado do JWT_SECRET (mesmo padrao do
// REFRESH_SECRET). Configure PORTAL_JWT_SECRET no Railway pra desacoplar.
const PORTAL_SECRET = process.env.PORTAL_JWT_SECRET || (JWT_SECRET ? JWT_SECRET + '_portal' : null);
const PORTAL_EXPIRES_IN = process.env.PORTAL_JWT_EXPIRES || '12h';

/**
 * Traduz logistics_deliveries -> shape do card, SEM campos financeiros.
 * De proposito NAO devolve valor_servico / valor_provider / valor_profissional /
 * margem. A loja ve status, enderecos, codigos, entregador e telefone.
 */
function mapearPortal(ld) {
  const courier = ld.courier_data || {};
  return {
    id:                 ld.id,
    codigo_os:          ld.codigo_os,
    provider_code:      ld.provider_code,
    status_uber:        ld.status_native || ld.status_canonico,
    status_canonico:    ld.status_canonico,
    eta_minutos:        ld.eta_minutos,
    tracking_url:       ld.tracking_url,
    rastreio_token:     ld.rastreio_token || null,
    endereco_coleta:    ld.endereco_coleta,
    endereco_entrega:   ld.endereco_entrega,
    pontos:             ld.pontos,
    cliente_nome_regra: ld.cliente_nome_regra || null,
    pickup_code:        ld.pickup_code  || null,
    dropoff_code:       ld.dropoff_code || null,
    return_code:        ld.return_code  || null,
    entregador_nome:     courier.name    || null,
    entregador_telefone: courier.phone   || null,
    entregador_veiculo:  courier.vehicle || null,
    entregador_placa:    courier.plate   || null,
    entregador_foto:     courier.photo   || null,
    coletado_at:        ld.coletado_at   || null,
    entregue_at:        ld.entregue_at   || null,
    atribuido_at:       ld.atribuido_at  || null,
    finalizado_at:      ld.finalizado_at || null,
    created_at:         ld.created_at,
    updated_at:         ld.updated_at,
  };
}

/**
 * Middleware: exige token do portal (Bearer). Verifica com PORTAL_SECRET e
 * escopo 'portal'. Popula req.portal = { regra_id, login }.
 */
function verificarPortalToken(req, res, next) {
  try {
    let token = null;
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) token = h.slice(7).trim();
    if (!token) return res.status(401).json({ erro: 'nao_autenticado' });
    if (!PORTAL_SECRET) return res.status(500).json({ erro: 'portal_sem_secret' });

    const dec = jwt.verify(token, PORTAL_SECRET);
    if (!dec || dec.scope !== 'portal' || !dec.regra_id) {
      return res.status(401).json({ erro: 'token_invalido' });
    }
    req.portal = { regra_id: dec.regra_id, login: dec.login || null };
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'token_invalido' });
  }
}

function createLogisticsPortalRouter(pool) {
  const router = express.Router();

  // ---------------------------------------------------------
  // POST /login  (publico)
  // ---------------------------------------------------------
  router.post('/login', async (req, res) => {
    try {
      const login = String((req.body && req.body.login) || '').trim().toLowerCase();
      const senha = String((req.body && req.body.senha) || '');
      if (!login || !senha) return res.status(400).json({ erro: 'faltam_credenciais' });
      if (!PORTAL_SECRET) return res.status(500).json({ erro: 'portal_sem_secret' });

      const { rows } = await pool.query(
        `SELECT id, cliente_nome, portal_senha_hash, portal_ativo
           FROM logistics_dispatch_rules
          WHERE LOWER(portal_login) = $1
          LIMIT 1`,
        [login]
      );
      const r = rows[0];
      // Resposta generica: nao vaza se o login existe / esta ativo / tem senha.
      if (!r || !r.portal_ativo || !r.portal_senha_hash) {
        return res.status(401).json({ erro: 'credenciais_invalidas' });
      }
      const ok = await bcrypt.compare(senha, r.portal_senha_hash);
      if (!ok) return res.status(401).json({ erro: 'credenciais_invalidas' });

      const token = jwt.sign(
        { scope: 'portal', regra_id: r.id, login },
        PORTAL_SECRET,
        { expiresIn: PORTAL_EXPIRES_IN }
      );
      res.json({ success: true, token, cliente_nome: r.cliente_nome });
    } catch (e) {
      console.error('[logistics/portal] erro /login:', e.message);
      res.status(500).json({ erro: 'erro_interno' });
    }
  });

  // ---------------------------------------------------------
  // GET /me
  // ---------------------------------------------------------
  router.get('/me', verificarPortalToken, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, cliente_nome, portal_login
           FROM logistics_dispatch_rules WHERE id = $1`,
        [req.portal.regra_id]
      );
      if (!rows[0]) return res.status(404).json({ erro: 'nao_encontrado' });
      res.json({
        success: true,
        regra_id: rows[0].id,
        cliente_nome: rows[0].cliente_nome,
        login: rows[0].portal_login,
      });
    } catch (e) {
      console.error('[logistics/portal] erro /me:', e.message);
      res.status(500).json({ erro: 'erro_interno' });
    }
  });

  // ---------------------------------------------------------
  // GET /deliveries?data=YYYY-MM-DD
  //   Sem data: dia atual (America/Sao_Paulo). Com data: aquele dia.
  //   Sempre filtrado por regra_id do token. Read-only.
  // ---------------------------------------------------------
  router.get('/deliveries', verificarPortalToken, async (req, res) => {
    try {
      const temData = !!(req.query.data && /^\d{4}-\d{2}-\d{2}$/.test(req.query.data));
      const params = [req.portal.regra_id];
      let sql = `
        SELECT ld.*, r.cliente_nome AS cliente_nome_regra
          FROM logistics_deliveries ld
          LEFT JOIN logistics_dispatch_rules r ON r.id = ld.regra_id
         WHERE ld.regra_id = $1`;
      if (temData) {
        sql += ` AND (ld.created_at AT TIME ZONE 'America/Sao_Paulo')::date = $2`;
        params.push(req.query.data);
      } else {
        sql += ` AND (ld.created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;
      }
      sql += ` ORDER BY ld.id DESC LIMIT 1000`;

      const { rows } = await pool.query(sql, params);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, total: rows.length, entregas: rows.map(mapearPortal) });
    } catch (e) {
      console.error('[logistics/portal] erro /deliveries:', e.message);
      res.status(500).json({ erro: 'erro_interno' });
    }
  });

  return router;
}

module.exports = { createLogisticsPortalRouter, verificarPortalToken };
