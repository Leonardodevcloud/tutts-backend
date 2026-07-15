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
// CLIENTE_FINAL_NF_PORTAL_V1: mesma fonte unica usada no card do admin.
const { extrairClienteFinalENota } = require('../core/ClienteFinalParser');

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
  // CLIENTE_FINAL_NF_PORTAL_V1 + NF_FONTE_AGENT_V1: mesma cascata do admin.
  // Fonte 1 = sla_capturas.pontos_json (o agent le a TELA da Mapp, que tem o
  // "No nota:"). Fonte 2 = pontos da API, que quase nunca traz a nota.
  let _ptsR = ld.pontos_rastreio;
  if (typeof _ptsR === 'string') { try { _ptsR = JSON.parse(_ptsR); } catch (_) { _ptsR = null; } }
  const _ultR = Array.isArray(_ptsR) && _ptsR.length > 0 ? _ptsR[_ptsR.length - 1] : null;

  let _pts = ld.pontos;
  if (typeof _pts === 'string') { try { _pts = JSON.parse(_pts); } catch (_) { _pts = null; } }
  const _ult = Array.isArray(_pts) && _pts.length > 1 ? _pts[_pts.length - 1] : null;

  const _cf = extrairClienteFinalENota({
    texto: (_ultR && (_ultR.textoBruto || _ultR.endereco))
      || (_ult && (_ult.rua || _ult.endereco)) || ld.endereco_entrega || null,
    nome: (_ultR && _ultR.nomeCliente) || (_ult && (_ult.nome || _ult.nomeCliente)) || null,
    nota: (_ultR && _ultR.nota) || (_ult && _ult.nota) || null,
    clienteCod: ld.cliente_cod_rastreio || null,
  });
  return {
    cliente_final:      _cf.cliente_final,
    nota_fiscal:        _cf.nota_fiscal,
    // EXTRAVIADOS_PORTAL_V1: a loja ve SO o selo. extraviado_motivo e
    // extraviado_por sao internos e NUNCA saem daqui.
    extraviado:           !!ld.extraviado_em,
    // FREQUENTE_PORTAL_V1: booleano por entrega. De proposito NAO expomos a
    // lista /frequentes pro portal — ela traz nome+telefone de TODOS os
    // motoboys, e a loja so precisa saber se o SEU entregador e frequente.
    entregador_frequente: !!ld.entregador_frequente,
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
        SELECT ld.*, r.cliente_nome AS cliente_nome_regra,
               sc.cliente_cod AS cliente_cod_rastreio,
               sc.pontos_json AS pontos_rastreio
          FROM logistics_deliveries ld
          LEFT JOIN logistics_dispatch_rules r ON r.id = ld.regra_id
          LEFT JOIN LATERAL (
            SELECT cliente_cod, pontos_json FROM sla_capturas
             WHERE os_numero = ld.codigo_os::text LIMIT 1
          ) sc ON true
         WHERE ld.regra_id = $1`;
      if (temData) {
        sql += ` AND (ld.created_at AT TIME ZONE 'America/Sao_Paulo')::date = $2`;
        params.push(req.query.data);
      } else {
        sql += ` AND (ld.created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;
      }
      sql += ` ORDER BY ld.id DESC LIMIT 1000`;

      const { rows } = await pool.query(sql, params);

      // FREQUENTE_PORTAL_V1: mesma regra do painel admin (> 3 entregas
      // concluidas em 30 dias, telefone nao bloqueado). Uma query so pros
      // telefones que aparecem nesta pagina — nao varre a base inteira.
      try {
        const tels = [...new Set(
          rows.map(r => String((r.courier_data && r.courier_data.phone) || '').replace(/[^0-9]/g, ''))
              .filter(Boolean)
        )];
        if (tels.length > 0) {
          const { rows: fr } = await pool.query(
            `SELECT regexp_replace(COALESCE(courier_data->>'phone',''), '[^0-9]', '', 'g') AS tel
               FROM logistics_deliveries
              WHERE entregue_at IS NOT NULL
                AND entregue_at >= NOW() - INTERVAL '30 days'
                AND regexp_replace(COALESCE(courier_data->>'phone',''), '[^0-9]', '', 'g') = ANY($1::text[])
              GROUP BY 1
             HAVING COUNT(*) > 3`,
            [tels]
          );
          const setFreq = new Set(fr.map(x => x.tel));
          if (setFreq.size > 0) {
            for (const r of rows) {
              const t = String((r.courier_data && r.courier_data.phone) || '').replace(/[^0-9]/g, '');
              if (t && setFreq.has(t)) r.entregador_frequente = true;
            }
          }
        }
      } catch (eFreq) {
        // Best-effort: sem a moldura o painel continua funcionando.
        console.warn('[logistics/portal] frequentes indisponivel:', eFreq.message);
      }

      res.set('Cache-Control', 'no-store');
      res.json({ success: true, total: rows.length, entregas: rows.map(mapearPortal) });
    } catch (e) {
      console.error('[logistics/portal] erro /deliveries:', e.message);
      res.status(500).json({ erro: 'erro_interno' });
    }
  });

  // ---------------------------------------------------------
  // GET /deliveries/tentativas?os=101,102  (PORTAL_CLIENTE_TENTATIVAS_V2)
  //   MESMA trilha do painel admin (Despachado / Re-despachado / Cancelado /
  //   Falha), porem ESCOPADA: so devolve tentativas das OS que pertencem a
  //   regra do token. Le de logistics_events.
  // ---------------------------------------------------------
  router.get('/deliveries/tentativas', verificarPortalToken, async (req, res) => {
    try {
      const osParam = String(req.query.os || '').trim();
      if (!osParam) return res.json({ success: true, porOs: {} });

      const pedidos = osParam
        .split(',')
        .map(s => parseInt(String(s).trim(), 10))
        .filter(n => Number.isInteger(n))
        .slice(0, 200);
      if (pedidos.length === 0) return res.json({ success: true, porOs: {} });

      // Escopo: so as OS dessa regra (evita a loja ler tentativas de outro cliente).
      const { rows: doCliente } = await pool.query(
        `SELECT DISTINCT codigo_os FROM logistics_deliveries
          WHERE regra_id = $1 AND codigo_os = ANY($2::int[])`,
        [req.portal.regra_id, pedidos]
      );
      const codigos = doCliente.map(r => r.codigo_os);
      if (codigos.length === 0) return res.json({ success: true, porOs: {} });

      const TIPOS = ['dispatch_success', 'dispatch_failed', 'error', 'redispatched', 'canceled'];
      const { rows } = await pool.query(
        `SELECT codigo_os, provider_code, event_type, status_native, payload, erro, created_at
           FROM logistics_events
          WHERE codigo_os = ANY($1::int[])
            AND event_type = ANY($2::text[])
          ORDER BY codigo_os ASC, created_at ASC, id ASC`,
        [codigos, TIPOS]
      );

      const courierDoMotivo = (txt) => {
        if (!txt) return null;
        const m = /\(([^)]+)\)/.exec(String(txt));
        return m ? m[1].trim() : null;
      };
      const parsePayload = (p) => {
        if (!p) return {};
        if (typeof p === 'string') { try { return JSON.parse(p); } catch (_) { return {}; } }
        return p;
      };

      const byOs = {};
      for (const r of rows) (byOs[r.codigo_os] = byOs[r.codigo_os] || []).push(r);

      const porOs = {};
      for (const os of Object.keys(byOs)) {
        const evs = byOs[os];
        const passos = [];
        let courierBloqueioPendente = null;

        for (const e of evs) {
          const p = parsePayload(e.payload);
          if (e.event_type === 'redispatched') {
            courierBloqueioPendente = p.courier || null;
            continue;
          }
          if (e.event_type === 'canceled') {
            passos.push({
              tipo: 'canceled',
              provider: e.provider_code || null,
              hora: e.created_at,
              cancelado_por: p.cancelado_por || null,
              courier: courierBloqueioPendente || courierDoMotivo(p.motivo),
              motivo: p.motivo || null,
            });
            courierBloqueioPendente = null;
            continue;
          }
          if (e.event_type === 'error') {
            const errTxt = String(e.erro || (p && p.motivo) || '');
            if (!/createDelivery/i.test(errTxt)) continue;
          }
          passos.push({
            tipo: e.event_type,
            provider: e.provider_code || null,
            hora: e.created_at,
            erro: e.erro || p.motivo || null,
            motivo: p.motivo || null,
          });
        }

        const totalTentativas = passos.filter(x =>
          x.tipo === 'dispatch_success' || x.tipo === 'dispatch_failed' || x.tipo === 'error'
        ).length;

        porOs[os] = { eventos: passos, total_tentativas: totalTentativas };
      }

      res.set('Cache-Control', 'no-store');
      return res.json({ success: true, porOs });
    } catch (e) {
      console.error('[logistics/portal] erro /deliveries/tentativas:', e.message);
      return res.status(500).json({ erro: 'erro_interno' });
    }
  });

  return router;
}

module.exports = { createLogisticsPortalRouter, verificarPortalToken };
