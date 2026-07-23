/**
 * MODULO LOGISTICS - Portal do Cliente (loja)
 *
 * Superficie ISOLADA pra loja acompanhar as proprias entregas.
 *
 * REDESPACHO_LOJA_V1 — deixou de ser 100% read-only. A loja ganhou UMA acao
 * de escrita: POST /deliveries/:id/redispatch. Foi decisao consciente do dono,
 * nao descuido. Se for mexer aqui, mantenha as tres travas.
 * A loja NUNCA entra no auth interno: token proprio (PORTAL_JWT_SECRET),
 * escopo 'portal', sem role. Um token de loja nao passa no verificarToken
 * interno (assinado com JWT_SECRET) e vice-versa.
 *
 * 1 login por regra: o token carrega { regra_id } e o /deliveries filtra
 * pela regra EFETIVA da entrega. So enxerga as entregas daquela regra.
 *
 * CLIENTE_MANUAL_PORTAL_V1 — regra efetiva = COALESCE(regra_id_manual, regra_id).
 * regra_id  = qual regra DESPACHOU (null na corrida manual sem match)
 * regra_id_manual = a que um admin ATRIBUIU depois, pela tela de detalhes
 * Atribuiu a corrida a uma loja? Ela passa a aparecer no portal DAQUELA loja.
 * E some do portal da anterior, se havia — a atribuicao manual e a verdade.
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
// PORTAL_MAPA_V1: haversine + ETA estimado.
// PORTAL_MAPA_BACK_V2: reduzirPontos saiu — o front nao desenha mais o
// breadcrumb do GPS. A funcao continua em geo.js caso o tracado volte.
const { haversineKm, estimarEtaMin } = require('../core/geo');
// PORTAL_MAPA_ROTA_V1: rota real por rua (ORS), calculada 1x por OS e cacheada.
const { garantirRotas } = require('../core/rota');
const httpRequest = require('../../../shared/utils/httpRequest');

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
  // ---------------------------------------------------------
  // REDESPACHO_LOJA_V1
  // POST /deliveries/:id/redispatch
  //
  // UNICA acao de escrita da loja. Chama a MESMA funcao do admin
  // (logistics.redespacho.js) — nao ha copia da regra aqui, so autorizacao.
  //
  // Tres travas que o admin nao tem:
  //  1. ESCOPO: so entrega cuja regra EFETIVA e a do token. Sem isso a loja
  //     redespacharia corrida das outras trocando o id na URL.
  //  2. ESTAGIO: a funcao ja barra depois da coleta (409).
  //  3. TETO: REDESPACHO_LOJA_MAX (default 1), separado do teto do admin.
  //     Quem clica aqui nao paga o provedor.
  // ---------------------------------------------------------
  router.post('/deliveries/:id/redispatch', verificarPortalToken, async (req, res) => {
    try {
      const entregaId = parseInt(req.params.id, 10);
      if (!Number.isInteger(entregaId)) return res.status(400).json({ error: 'id invalido' });

      // Trava 1 — escopo. A regra EFETIVA tem que ser a do token.
      // (efetiva = COALESCE(regra_id_manual, regra_id): corrida atribuida na
      //  mao pertence a loja pra quem foi atribuida.)
      const { rows } = await pool.query(
        `SELECT id, codigo_os FROM logistics_deliveries
          WHERE id = $1 AND COALESCE(regra_id_manual, regra_id) = $2`,
        [entregaId, req.portal.regra_id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Entrega nao encontrada' });

      // Trava 3 — teto proprio da loja (o estagio quem barra e a funcao).
      const MAX = parseInt(process.env.REDESPACHO_LOJA_MAX, 10) || 1;
      let usadas = 0;
      try {
        const { rows: ex } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM logistics_os_exclusoes WHERE codigo_os = $1`,
          [rows[0].codigo_os]
        );
        usadas = ex[0] ? ex[0].n : 0;
      } catch (_) { usadas = 0; }
      if (usadas >= MAX) {
        return res.status(429).json({
          error: `Esta corrida ja foi redespachada ${MAX === 1 ? 'uma vez' : MAX + ' vezes'}. Fale com a Central.`,
        });
      }

      const { redespacharEntrega } = require('../logistics.redespacho');
      const r = await redespacharEntrega(pool, entregaId, {
        motivo: 'Redespacho pela loja',
        excluirEntregador: true,
        criadoPor: `loja:${req.portal.login || req.portal.regra_id}`,
      });
      if (!r.ok) return res.status(r.status).json({ error: r.error });

      console.log(`[portal] OS ${rows[0].codigo_os} redespachada pela loja ${req.portal.login || req.portal.regra_id}`);
      res.json({ success: true });
    } catch (err) {
      console.error('[portal] redispatch erro:', err.message);
      res.status(500).json({ error: 'Nao foi possivel redespachar agora.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // [portal-relatorio-v1] GET /portal/relatorio
  // Relatorio da loja: corridas do periodo com duracao, km, valor e prazo.
  //
  // Query: ?de=YYYY-MM-DD&ate=YYYY-MM-DD&status=todos|entregue|cancelado|devolvido
  //        &formato=json|csv
  //
  // VALOR: devolve ld.valor_servico — o que a LOJA paga. Nunca valor_provider
  // nem margem (o mapearPortal continua sem financeiro; aqui e explicito e
  // so este campo).
  //
  // PRAZO: vem do sla_monitor_snapshot (mesma fonte do painel admin).
  // finalizada_em <= deadline -> no prazo. Sem deadline -> "sem dados".
  // ─────────────────────────────────────────────────────────────
  router.get('/relatorio', verificarPortalToken, async (req, res) => {
    try {
      const { de, ate, status, formato } = req.query;

      // Janela: default = ultimos 30 dias
      const hoje = new Date();
      const ateStr = (ate && /^\d{4}-\d{2}-\d{2}$/.test(ate)) ? ate : hoje.toISOString().slice(0, 10);
      const deDefault = new Date(hoje.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const deStr = (de && /^\d{4}-\d{2}-\d{2}$/.test(de)) ? de : deDefault;

      const { rows } = await pool.query(
        `SELECT ld.id, ld.codigo_os, ld.status_canonico, ld.provider_code,
                ld.endereco_coleta, ld.endereco_entrega,
                ld.distancia_km, ld.valor_servico,
                ld.created_at, ld.coletado_at, ld.entregue_at, ld.finalizado_at,
                ld.courier_data,
                sm.deadline, sm.finalizada_em, sm.prazo_min, sm.prazo_origem
           FROM logistics_deliveries ld
           LEFT JOIN LATERAL (
             SELECT deadline, finalizada_em, prazo_min, prazo_origem
               FROM sla_monitor_snapshot
              WHERE os_numero = ld.codigo_os::text
              LIMIT 1
           ) sm ON true
          WHERE COALESCE(ld.regra_id_manual, ld.regra_id) = $1
            AND ld.created_at >= $2::date
            AND ld.created_at <  ($3::date + INTERVAL '1 day')
          ORDER BY ld.id DESC
          LIMIT 2000`,
        [req.portal.regra_id, deStr, ateStr]
      );

      // Consolida por OS (mesma regra do quadro): cada re-despacho cria um
      // registro novo; no relatorio interessa o estado ATUAL da corrida.
      const porOs = new Map();
      for (const r of rows) {
        const atual = porOs.get(r.codigo_os);
        if (!atual || Number(r.id) > Number(atual.id)) porOs.set(r.codigo_os, r);
      }

      const STATUS_ROTULO = {
        DELIVERED: 'Entregue', CANCELED: 'Cancelado', RETURNED: 'Devolvido',
        RETURNING: 'Em devolucao', FAILED: 'Falha', FALLBACK_QUEUE: 'Falha',
      };

      let corridas = Array.from(porOs.values()).map(r => {
        const courier = r.courier_data || {};
        const st = String(r.status_canonico || '').toUpperCase();

        // Duracao: da criacao ate o fim (entregue/finalizado). Minutos.
        const fimTs = r.entregue_at || r.finalizado_at || r.finalizada_em || null;
        let duracaoMin = null;
        if (fimTs && r.created_at) {
          const d = Math.round((new Date(fimTs).getTime() - new Date(r.created_at).getTime()) / 60000);
          if (Number.isFinite(d) && d >= 0 && d <= 43200) duracaoMin = d;
        }

        // Prazo: mesma regra do painel admin (finalizada_em vs deadline).
        let prazo = 'sem_dados';
        const fimPrazo = r.finalizada_em || r.entregue_at || r.finalizado_at;
        if (r.deadline && fimPrazo) {
          prazo = new Date(fimPrazo) <= new Date(r.deadline) ? 'no_prazo' : 'fora';
        }

        return {
          os: r.codigo_os,
          status: STATUS_ROTULO[st] || (st ? st.charAt(0) + st.slice(1).toLowerCase() : '—'),
          status_canonico: st,
          provider: r.provider_code === 'noventanove' ? '99' : (r.provider_code === 'uber' ? 'Uber' : r.provider_code),
          endereco_coleta: r.endereco_coleta,
          endereco_entrega: r.endereco_entrega,
          entregador: courier.name || null,
          km: r.distancia_km != null ? Number(r.distancia_km) : null,
          valor: r.valor_servico != null ? Number(r.valor_servico) : null,
          duracao_min: duracaoMin,
          prazo,
          prazo_min: r.prazo_min != null ? Number(r.prazo_min) : null,
          criado_em: r.created_at,
          entregue_em: fimTs,
        };
      });

      // Filtro por status (rotulo)
      if (status && status !== 'todos') {
        const alvo = String(status).toLowerCase();
        corridas = corridas.filter(c => String(c.status).toLowerCase() === alvo);
      }

      // ── CSV (abre no Excel) ──
      if (String(formato).toLowerCase() === 'csv') {
        const fmtDur = (m) => {
          if (m == null) return '';
          if (m < 60) return m + 'min';
          const h = Math.floor(m / 60), r2 = m % 60;
          return h + 'h' + (r2 > 0 ? ' ' + String(r2).padStart(2, '0') : '');
        };
        const fmtDataHora = (v) => {
          if (!v) return ['', ''];
          const d = new Date(v);
          if (isNaN(d.getTime())) return ['', ''];
          const p = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Bahia', day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          }).formatToParts(d);
          const g = (t) => { const x = p.find(i => i.type === t); return x ? x.value : ''; };
          return [`${g('day')}/${g('month')}/${g('year')}`, `${g('hour')}:${g('minute')}:${g('second')}`];
        };
        const PRAZO_ROTULO = { no_prazo: 'No prazo', fora: 'Fora do prazo', sem_dados: '' };
        const esc = (v) => {
          const s = v == null ? '' : String(v);
          return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const headers = ['OS', 'Status', 'Provedor', 'Coleta', 'Entrega', 'Entregador',
                         'KM', 'Duracao', 'Duracao (min)', 'Prazo', 'Valor (R$)',
                         'Data', 'Hora', 'Data entrega', 'Hora entrega'];
        const linhas = corridas.map(c => {
          const [dC, hC] = fmtDataHora(c.criado_em);
          const [dE, hE] = fmtDataHora(c.entregue_em);
          return [
            c.os, c.status, c.provider, c.endereco_coleta, c.endereco_entrega, c.entregador || '',
            c.km != null ? String(c.km).replace('.', ',') : '',
            fmtDur(c.duracao_min), c.duracao_min != null ? String(c.duracao_min) : '',
            PRAZO_ROTULO[c.prazo] || '',
            c.valor != null ? c.valor.toFixed(2).replace('.', ',') : '',
            dC, hC, dE, hE,
          ].map(esc).join(';');
        });
        const csv = '\uFEFF' + [headers.join(';')].concat(linhas).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="relatorio-${deStr}_a_${ateStr}.csv"`);
        return res.send(csv);
      }

      // ── JSON (tela) ──
      const totais = corridas.reduce((a, c) => {
        a.corridas += 1;
        if (c.km != null) a.km += c.km;
        if (c.valor != null) a.valor += c.valor;
        if (c.prazo === 'no_prazo') a.no_prazo += 1;
        if (c.prazo === 'fora') a.fora += 1;
        return a;
      }, { corridas: 0, km: 0, valor: 0, no_prazo: 0, fora: 0 });
      totais.km = Math.round(totais.km * 10) / 10;
      totais.valor = Math.round(totais.valor * 100) / 100;
      totais.pct_prazo = (totais.no_prazo + totais.fora) > 0
        ? Math.round((10000 * totais.no_prazo) / (totais.no_prazo + totais.fora)) / 100
        : null;

      res.json({ success: true, periodo: { de: deStr, ate: ateStr }, totais, corridas });
    } catch (err) {
      console.error('[portal/relatorio] erro:', err.message);
      res.status(500).json({ error: 'Erro ao gerar relatorio' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // [portal-relatorio-v1] GET /portal/relatorio
  // Relatorio da loja: corridas do periodo com duracao, km, valor e prazo.
  //
  // Query: ?de=YYYY-MM-DD&ate=YYYY-MM-DD&status=todos|entregue|cancelado|devolvido
  //        &formato=json|csv
  //
  // VALOR: devolve ld.valor_servico — o que a LOJA paga. Nunca valor_provider
  // nem margem (o mapearPortal continua sem financeiro; aqui e explicito e
  // so este campo).
  //
  // PRAZO: vem do sla_monitor_snapshot (mesma fonte do painel admin).
  // finalizada_em <= deadline -> no prazo. Sem deadline -> "sem dados".
  // ─────────────────────────────────────────────────────────────
  router.get('/relatorio', verificarPortalToken, async (req, res) => {
    try {
      const { de, ate, status, formato } = req.query;

      // Janela: default = ultimos 30 dias
      const hoje = new Date();
      const ateStr = (ate && /^\d{4}-\d{2}-\d{2}$/.test(ate)) ? ate : hoje.toISOString().slice(0, 10);
      const deDefault = new Date(hoje.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const deStr = (de && /^\d{4}-\d{2}-\d{2}$/.test(de)) ? de : deDefault;

      const { rows } = await pool.query(
        `SELECT ld.id, ld.codigo_os, ld.status_canonico, ld.provider_code,
                ld.endereco_coleta, ld.endereco_entrega,
                ld.distancia_km, ld.valor_servico,
                ld.created_at, ld.coletado_at, ld.entregue_at, ld.finalizado_at,
                ld.courier_data,
                sm.deadline, sm.finalizada_em, sm.prazo_min, sm.prazo_origem
           FROM logistics_deliveries ld
           LEFT JOIN LATERAL (
             SELECT deadline, finalizada_em, prazo_min, prazo_origem
               FROM sla_monitor_snapshot
              WHERE os_numero = ld.codigo_os::text
              LIMIT 1
           ) sm ON true
          WHERE COALESCE(ld.regra_id_manual, ld.regra_id) = $1
            AND ld.created_at >= $2::date
            AND ld.created_at <  ($3::date + INTERVAL '1 day')
          ORDER BY ld.id DESC
          LIMIT 2000`,
        [req.portal.regra_id, deStr, ateStr]
      );

      // Consolida por OS (mesma regra do quadro): cada re-despacho cria um
      // registro novo; no relatorio interessa o estado ATUAL da corrida.
      const porOs = new Map();
      for (const r of rows) {
        const atual = porOs.get(r.codigo_os);
        if (!atual || Number(r.id) > Number(atual.id)) porOs.set(r.codigo_os, r);
      }

      const STATUS_ROTULO = {
        DELIVERED: 'Entregue', CANCELED: 'Cancelado', RETURNED: 'Devolvido',
        RETURNING: 'Em devolucao', FAILED: 'Falha', FALLBACK_QUEUE: 'Falha',
      };

      let corridas = Array.from(porOs.values()).map(r => {
        const courier = r.courier_data || {};
        const st = String(r.status_canonico || '').toUpperCase();

        // Duracao: da criacao ate o fim (entregue/finalizado). Minutos.
        const fimTs = r.entregue_at || r.finalizado_at || r.finalizada_em || null;
        let duracaoMin = null;
        if (fimTs && r.created_at) {
          const d = Math.round((new Date(fimTs).getTime() - new Date(r.created_at).getTime()) / 60000);
          if (Number.isFinite(d) && d >= 0 && d <= 43200) duracaoMin = d;
        }

        // Prazo: mesma regra do painel admin (finalizada_em vs deadline).
        let prazo = 'sem_dados';
        const fimPrazo = r.finalizada_em || r.entregue_at || r.finalizado_at;
        if (r.deadline && fimPrazo) {
          prazo = new Date(fimPrazo) <= new Date(r.deadline) ? 'no_prazo' : 'fora';
        }

        return {
          os: r.codigo_os,
          status: STATUS_ROTULO[st] || (st ? st.charAt(0) + st.slice(1).toLowerCase() : '—'),
          status_canonico: st,
          provider: r.provider_code === 'noventanove' ? '99' : (r.provider_code === 'uber' ? 'Uber' : r.provider_code),
          endereco_coleta: r.endereco_coleta,
          endereco_entrega: r.endereco_entrega,
          entregador: courier.name || null,
          km: r.distancia_km != null ? Number(r.distancia_km) : null,
          valor: r.valor_servico != null ? Number(r.valor_servico) : null,
          duracao_min: duracaoMin,
          prazo,
          prazo_min: r.prazo_min != null ? Number(r.prazo_min) : null,
          criado_em: r.created_at,
          entregue_em: fimTs,
        };
      });

      // Filtro por status (rotulo)
      if (status && status !== 'todos') {
        const alvo = String(status).toLowerCase();
        corridas = corridas.filter(c => String(c.status).toLowerCase() === alvo);
      }

      // ── [portal-relatorio-v2] Excel de verdade (.xlsx) ──
      // Antes era CSV: o Excel convertia a data em numero serial e, como o CSV
      // nao carrega largura de coluna, aparecia "########". Com xlsx a gente
      // define a largura E manda a data como Date com formato dd/mm/aaaa —
      // sai legivel e ainda da pra filtrar/ordenar como data de verdade.
      if (['csv', 'xlsx', 'excel'].includes(String(formato).toLowerCase())) {
        const XLSX = require('xlsx');

        const fmtDurTxt = (m) => {
          if (m == null) return '';
          if (m < 60) return m + 'min';
          const h = Math.floor(m / 60), r2 = m % 60;
          return h + 'h' + (r2 > 0 ? ' ' + String(r2).padStart(2, '0') : '');
        };
        const PRAZO_ROTULO = { no_prazo: 'No prazo', fora: 'Fora do prazo', sem_dados: '' };

        // Date "de parede" pro Excel: o xlsx converte pelo fuso local do
        // servidor (UTC no Railway). Compensamos pra hora sair em Salvador.
        const dataParaExcel = (v) => {
          if (!v) return null;
          const d = new Date(v);
          if (isNaN(d.getTime())) return null;
          try {
            const p = new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/Bahia', year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            }).formatToParts(d);
            const g = (k) => { const x = p.find(i => i.type === k); return x ? Number(x.value) : 0; };
            const hh = g('hour') === 24 ? 0 : g('hour');
            return new Date(g('year'), g('month') - 1, g('day'), hh, g('minute'), g('second'));
          } catch (_) { return d; }
        };

        const linhas = corridas.map(c => ({
          'OS':             c.os,
          'Data/Hora':      dataParaExcel(c.criado_em),
          'Status':         c.status,
          'Provedor':       c.provider,
          'Coleta':         c.endereco_coleta || '',
          'Entrega':        c.endereco_entrega || '',
          'Entregador':     c.entregador || '',
          'KM':             c.km != null ? Number(c.km) : null,
          'Duracao':        fmtDurTxt(c.duracao_min),
          'Duracao (min)':  c.duracao_min != null ? Number(c.duracao_min) : null,
          'Prazo':          PRAZO_ROTULO[c.prazo] || '',
          'Valor (R$)':     c.valor != null ? Number(c.valor) : null,
          'Entregue em':    dataParaExcel(c.entregue_em),
        }));

        const ws = XLSX.utils.json_to_sheet(linhas, { cellDates: true });
        // larguras (o que faltava no CSV — origem do "########")
        ws['!cols'] = [
          { wch: 10 },  // OS
          { wch: 18 },  // Data/Hora
          { wch: 12 },  // Status
          { wch: 9 },   // Provedor
          { wch: 46 },  // Coleta
          { wch: 46 },  // Entrega
          { wch: 28 },  // Entregador
          { wch: 8 },   // KM
          { wch: 10 },  // Duracao
          { wch: 13 },  // Duracao (min)
          { wch: 13 },  // Prazo
          { wch: 12 },  // Valor
          { wch: 18 },  // Entregue em
        ];
        // formato das colunas de data e do valor
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let R = 1; R <= range.e.r; R++) {
          for (const col of [1, 12]) {                       // Data/Hora, Entregue em
            const cel = ws[XLSX.utils.encode_cell({ r: R, c: col })];
            if (cel && cel.t === 'd') cel.z = 'dd/mm/yyyy hh:mm:ss';
          }
          const celV = ws[XLSX.utils.encode_cell({ r: R, c: 11 })];   // Valor
          if (celV && celV.t === 'n') celV.z = '#,##0.00';
        }
        ws['!autofilter'] = { ref: ws['!ref'] };              // filtro no cabecalho

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Corridas');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="relatorio-${deStr}_a_${ateStr}.xlsx"`);
        return res.send(buf);
      }

      // ── JSON (tela) ──
      // [portal-relatorio-v2] Os KPIs somam so o que FATURA: Entregue e
      // Devolvido. Cancelado aparece na tabela (a loja precisa ver) mas fica
      // FORA da conta — senao o total mente (corrida cancelada nao gerou
      // receita nem km rodado).
      const STATUS_FATURAVEIS = ['DELIVERED', 'RETURNED'];
      const somaveis = corridas.filter(c => STATUS_FATURAVEIS.includes(c.status_canonico));
      const totais = somaveis.reduce((a, c) => {
        a.corridas += 1;
        if (c.km != null) a.km += c.km;
        if (c.valor != null) a.valor += c.valor;
        if (c.prazo === 'no_prazo') a.no_prazo += 1;
        if (c.prazo === 'fora') a.fora += 1;
        return a;
      }, { corridas: 0, km: 0, valor: 0, no_prazo: 0, fora: 0 });
      // quantas ficaram de fora (pra tela poder explicar o numero menor)
      totais.nao_faturaveis = corridas.length - somaveis.length;
      totais.km = Math.round(totais.km * 10) / 10;
      totais.valor = Math.round(totais.valor * 100) / 100;
      totais.pct_prazo = (totais.no_prazo + totais.fora) > 0
        ? Math.round((10000 * totais.no_prazo) / (totais.no_prazo + totais.fora)) / 100
        : null;

      res.json({ success: true, periodo: { de: deStr, ate: ateStr }, totais, corridas });
    } catch (err) {
      console.error('[portal/relatorio] erro:', err.message);
      res.status(500).json({ error: 'Erro ao gerar relatorio' });
    }
  });

  router.get('/deliveries', verificarPortalToken, async (req, res) => {
    try {
      const temData = !!(req.query.data && /^\d{4}-\d{2}-\d{2}$/.test(req.query.data));
      const params = [req.portal.regra_id];
      let sql = `
        SELECT ld.*, r.cliente_nome AS cliente_nome_regra,
               sc.cliente_cod AS cliente_cod_rastreio,
               sc.pontos_json AS pontos_rastreio
          FROM logistics_deliveries ld
          LEFT JOIN logistics_dispatch_rules r ON r.id = COALESCE(ld.regra_id_manual, ld.regra_id)
          LEFT JOIN LATERAL (
            SELECT cliente_cod, pontos_json FROM sla_capturas
             WHERE os_numero = ld.codigo_os::text LIMIT 1
          ) sc ON true
         WHERE COALESCE(ld.regra_id_manual, ld.regra_id) = $1`;
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
  // ───────────────────────────────────────────────────────────
  // PORTAL_MAPA_V1
  // GET /portal/mapa  -> tudo que a aba Mapa precisa, em 2 queries.
  //
  // Devolve SO o que esta EM ANDAMENTO: despachada, com entregador, e ainda
  // nao terminal. Entrega terminada nao tem o que acompanhar no mapa.
  //
  // O ETA e CALCULADO aqui (haversine * fator de rua / velocidade media) —
  // nenhum provedor manda ETA ao vivo. E estimativa, e o front rotula como
  // tal ("~11 min").
  // ───────────────────────────────────────────────────────────
  router.get('/mapa', verificarPortalToken, async (req, res) => {
    try {
      // Status pos-coleta: o alvo do motoboy passa a ser a ENTREGA.
      const POS_COLETA = ['PICKED_UP', 'DROPOFF_EN_ROUTE', 'ARRIVED_DROPOFF', 'RETURNING'];

      // "Em andamento" = ja saiu do papel e ainda nao acabou. Lista EXPLICITA
      // (whitelist) em vez de "NOT IN terminais": PENDING/QUOTED sao entregas
      // que nem foram despachadas — nao tem motoboy nem o que mostrar no mapa.
      // RETURNING esta FORA da ORDEM_STATUS do poller, mas e andamento (o
      // motoboy esta voltando com o pacote), entao entra.
      const EM_ANDAMENTO = [
        'DISPATCHED', 'COURIER_ASSIGNED',
        'PICKUP_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP',
        'DROPOFF_EN_ROUTE', 'ARRIVED_DROPOFF', 'RETURNING',
      ];

      const { rows } = await pool.query(
        `SELECT ld.id, ld.codigo_os, ld.status_canonico, ld.status_native,
                ld.coletado_at, ld.atribuido_at, ld.provider_code,
                ld.endereco_coleta, ld.endereco_entrega,
                ld.latitude_coleta, ld.longitude_coleta,
                ld.latitude_entrega, ld.longitude_entrega,
                ld.ultima_lat, ld.ultima_lng,
                ld.distancia_km, ld.distancia_origem,
                ld.rota_json, ld.rota_metros, ld.rota_calculada_at,
                ld.courier_data, ld.pontos, ld.rastreio_token,
                sc.cliente_cod AS cliente_cod_rastreio,
                sc.pontos_json AS pontos_rastreio
           FROM logistics_deliveries ld
           LEFT JOIN LATERAL (
             SELECT cliente_cod, pontos_json FROM sla_capturas
              WHERE os_numero = ld.codigo_os::text LIMIT 1
           ) sc ON true
          WHERE COALESCE(ld.regra_id_manual, ld.regra_id) = $1
            AND ld.status_canonico = ANY($2)
          ORDER BY ld.id DESC
          LIMIT 200`,
        [req.portal.regra_id, EM_ANDAMENTO]
      );

      // PORTAL_MAPA_BACK_V2: a query em logistics_tracking saiu daqui — o
      // front nao desenha mais o breadcrumb do GPS. A posicao AO VIVO do
      // motoboy nao depende disso: vem de ld.ultima_lat/ultima_lng, que o
      // WebhookDispatcher (Uber) e o TrackingPoller (99) mantem atualizados.

      // PORTAL_MAPA_ROTA_V1: rota real por rua, da coleta ate a entrega.
      // Calcula SO as que ainda nao tem (cap por request) e cacheia no banco.
      // Como os dois pontos nao mudam depois do despacho, e ~1 chamada ORS
      // por OS pra sempre — nao por refresh.
      // Se o ORS falhar ou nao estiver configurado, rotasPorId fica vazio e
      // o front cai na linha reta sozinho.
      // PORTAL_MAPA_ROTA_DIAG_V1: garantirRotas agora devolve { rotas, diag }.
      // O diag vai na resposta pra dizer POR QUE a rota esta faltando —
      // a v1 falhava calada quando a ORS_API_KEY nao existia.
      let rotasPorId = {};
      let rotaDiag = null;
      try {
        const rr = await garantirRotas(pool, httpRequest, rows);
        rotasPorId = rr.rotas;
        rotaDiag = rr.diag;
      } catch (eRota) {
        console.error('[logistics/portal] rotas indisponiveis:', eRota.message);
        rotaDiag = { erro: eRota.message };
      }

      const entregas = rows.map(ld => {
        const courier = ld.courier_data || {};
        const coletado = !!ld.coletado_at ||
          POS_COLETA.includes(String(ld.status_canonico || '').toUpperCase());

        const cLat = ld.ultima_lat != null ? Number(ld.ultima_lat) : null;
        const cLng = ld.ultima_lng != null ? Number(ld.ultima_lng) : null;

        // Alvo atual do motoboy: se ainda nao coletou, ele vai pra LOJA.
        const alvo = coletado ? 'entrega' : 'coleta';
        const aLat = coletado ? ld.latitude_entrega : ld.latitude_coleta;
        const aLng = coletado ? ld.longitude_entrega : ld.longitude_coleta;

        const restanteKm = haversineKm(cLat, cLng, aLat, aLng);
        const etaMin = estimarEtaMin(restanteKm);

        // Cliente final + NF: mesma cascata do card (agent primeiro, API depois).
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
          id: ld.id,
          codigo_os: ld.codigo_os,
          status_canonico: ld.status_canonico,
          // mesmo nome de campo que o /deliveries do portal ja usa
          status_uber: ld.status_native || ld.status_canonico,
          provider_code: ld.provider_code || null,
          coletado,
          alvo,
          coleta: {
            lat: ld.latitude_coleta != null ? Number(ld.latitude_coleta) : null,
            lng: ld.longitude_coleta != null ? Number(ld.longitude_coleta) : null,
            endereco: ld.endereco_coleta || null,
          },
          entrega: {
            lat: ld.latitude_entrega != null ? Number(ld.latitude_entrega) : null,
            lng: ld.longitude_entrega != null ? Number(ld.longitude_entrega) : null,
            endereco: ld.endereco_entrega || null,
          },
          courier: (courier.name || cLat != null) ? {
            nome: courier.name || null,
            telefone: courier.phone || null,
            foto: courier.photo || null,
            lat: cLat,
            lng: cLng,
          } : null,
          cliente_final: _cf.cliente_final,
          nota_fiscal: _cf.nota_fiscal,
          // distancia_km e a da corrida inteira (vem do provider ou do
          // fallback haversine). restante_km e do motoboy ate o alvo AGORA.
          distancia_km: ld.distancia_km != null ? Number(ld.distancia_km) : null,
          distancia_origem: ld.distancia_origem || null,
          restante_km: restanteKm != null ? Math.round(restanteKm * 10) / 10 : null,
          eta_min: etaMin,
          eta_fonte: 'estimado',
          rastreio_token: ld.rastreio_token || null,
          // rota real por rua (ORS). null => o front desenha a linha reta.
          rota: rotasPorId[ld.id] || null,
          // distancia REAL de rua da corrida (o summary do ORS)
          rota_km: ld.rota_metros != null ? Math.round(Number(ld.rota_metros) / 100) / 10 : null,
        };
      });

      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        total: entregas.length,
        a_coletar: entregas.filter(e => !e.coletado).length,
        em_entrega: entregas.filter(e => e.coletado).length,
        // Abra o devtools > Network > mapa e olhe este campo pra saber por
        // que uma corrida esta com linha reta em vez de rota.
        rota_diag: rotaDiag,
        entregas,
      });
    } catch (err) {
      console.error('[logistics/portal] GET /mapa erro:', err.message);
      res.status(500).json({ erro: err.message });
    }
  });

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
          WHERE COALESCE(regra_id_manual, regra_id) = $1 AND codigo_os = ANY($2::int[])`,
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
