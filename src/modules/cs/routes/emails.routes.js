/**
 * MÓDULO CS — Sub-router de Emails Enviados
 *
 * 3 endpoints admin + 1 webhook público:
 *   GET  /cs/emails-enviados              — listagem paginada com filtros
 *   GET  /cs/emails-enviados/:id          — detalhe + timeline de eventos
 *   GET  /cs/emails-enviados/:id/html     — HTML do relatório enviado (iframe)
 *   POST /cs/webhook/resend               — público, recebe eventos do Resend
 *
 * O webhook valida assinatura Svix nativamente (sem dependência extra),
 * deduplica por svix-id e atualiza agregados em cs_emails_enviados.
 *
 * IMPORTANTE: a rota /cs/webhook/resend precisa estar em PUBLIC_PATHS
 * (src/middleware/auth.js) para passar pelo verificarToken.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
// Helpers de assinatura Svix
// ─────────────────────────────────────────────────────────────

/**
 * Valida assinatura Svix do webhook do Resend.
 * Headers esperados:
 *   svix-id        — id único do delivery
 *   svix-timestamp — unix timestamp em segundos
 *   svix-signature — "v1,base64sig v1,base64sig2 ..."
 *
 * Retorna true se ao menos uma assinatura bate. Janela de tolerância: 5min.
 */
function verificarAssinaturaSvix(rawBody, headers, secret) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatureHeader = headers['svix-signature'];
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing-headers' };
  }

  // Tolerância de 5 minutos pra clock drift
  const tsNum = parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad-timestamp' };
  const ageSec = Math.abs(Date.now() / 1000 - tsNum);
  if (ageSec > 300) return { ok: false, reason: 'stale-timestamp' };

  // O secret vem com prefixo "whsec_" — extrair só o base64
  const secretRaw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let secretBytes;
  try {
    secretBytes = Buffer.from(secretRaw, 'base64');
  } catch (e) {
    return { ok: false, reason: 'bad-secret' };
  }

  const signedPayload = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(signedPayload)
    .digest('base64');

  // Comparar contra cada assinatura no header (formato "v1,sig v1,sig2")
  const sigs = signatureHeader.split(' ').map((s) => {
    const idx = s.indexOf(',');
    return idx > 0 ? s.slice(idx + 1) : s;
  });

  for (const sig of sigs) {
    try {
      const a = Buffer.from(sig, 'base64');
      const b = Buffer.from(expected, 'base64');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { ok: true };
      }
    } catch (e) {
      // Ignora assinatura malformada e tenta a próxima
    }
  }
  return { ok: false, reason: 'signature-mismatch' };
}

// ─────────────────────────────────────────────────────────────
// Mapeamento dos eventos do Resend → status agregado
// ─────────────────────────────────────────────────────────────

// Prioridade: clicked > opened > complained > bounced > delivered > sent > scheduled
// Quanto maior, mais "avançado" o estado. Comparamos numericamente.
const PRIORIDADE_STATUS = {
  scheduled: 1,
  sent: 2,
  delivered: 3,
  delivery_delayed: 3,
  bounced: 4,
  failed: 4,
  complained: 5,
  opened: 6,
  clicked: 7,
  suppressed: 4,
};

function statusFromTipo(tipo) {
  // tipo vem como "email.opened", "email.clicked" etc
  if (!tipo) return null;
  const sub = tipo.startsWith('email.') ? tipo.slice(6) : tipo;
  return sub;
}

// ─────────────────────────────────────────────────────────────
// Factory do sub-router
// ─────────────────────────────────────────────────────────────

function createEmailsRoutes(pool) {
  const router = express.Router();

  // ============================================================
  // POST /cs/webhook/resend  (PÚBLICO — adicionar a PUBLIC_PATHS)
  // ============================================================
  // Importante: usa express.raw() pra preservar o body bruto que
  // foi assinado. NÃO usar express.json() antes desse handler.
  router.post(
    '/cs/webhook/resend',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      const secret = process.env.RESEND_WEBHOOK_SECRET;
      const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';

      // Headers em lower-case (express normaliza)
      const verif = verificarAssinaturaSvix(rawBody, req.headers, secret);
      if (!verif.ok) {
        console.warn(`[Resend Webhook] Assinatura inválida: ${verif.reason}`);
        // 401 — Resend retenta automaticamente em caso de erro
        return res.status(401).json({ ok: false, error: verif.reason });
      }

      let evento;
      try {
        evento = JSON.parse(rawBody);
      } catch (e) {
        console.warn('[Resend Webhook] Body não é JSON válido');
        return res.status(400).json({ ok: false, error: 'invalid-json' });
      }

      const svixId = req.headers['svix-id'];
      const tipo = evento.type || null;
      const data = evento.data || {};
      const resendEmailId = data.email_id || null;

      try {
        // Buscar o cs_emails_enviados associado (se existir)
        let emailEnviadoId = null;
        if (resendEmailId) {
          const r = await pool.query(
            'SELECT id FROM cs_emails_enviados WHERE resend_email_id = $1 LIMIT 1',
            [resendEmailId]
          );
          if (r.rows.length > 0) emailEnviadoId = r.rows[0].id;
        }

        // INSERT idempotente — ON CONFLICT(svix_id) DO NOTHING
        const ins = await pool.query(
          `INSERT INTO cs_email_eventos
             (email_enviado_id, resend_email_id, svix_id, tipo, payload,
              ip, user_agent, link_clicado, evento_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (svix_id) DO NOTHING
           RETURNING id`,
          [
            emailEnviadoId,
            resendEmailId,
            svixId,
            tipo,
            JSON.stringify(evento),
            data.ip || null,
            data.user_agent || null,
            (data.click && data.click.link) || null,
            evento.created_at ? new Date(evento.created_at) : new Date(),
          ]
        );

        // Se foi inserido (não duplicado) e temos email_enviado_id, atualiza agregados
        if (ins.rows.length > 0 && emailEnviadoId) {
          await atualizarAgregados(pool, emailEnviadoId, tipo);
        }

        // 200 — Resend para de retentar
        return res.status(200).json({ ok: true, deduped: ins.rows.length === 0 });
      } catch (err) {
        console.error('[Resend Webhook] Erro ao processar:', err.message);
        // 500 — Resend retenta. Não vazar detalhes.
        return res.status(500).json({ ok: false });
      }
    }
  );

  // ============================================================
  // GET /cs/emails-enviados — listagem paginada
  // ============================================================
  router.get('/cs/emails-enviados', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = parseInt(req.query.offset, 10) || 0;
      const codCliente = req.query.cod_cliente ? parseInt(req.query.cod_cliente, 10) : null;
      const status = req.query.status || null;
      const tipo = req.query.tipo || null;
      const dias = parseInt(req.query.dias, 10) || 30;

      const where = ['e.created_at >= NOW() - ($1 || \' days\')::interval'];
      const params = [String(dias)];
      let p = 2;

      if (codCliente) {
        where.push(`e.cod_cliente = $${p++}`);
        params.push(codCliente);
      }
      if (status) {
        where.push(`e.status_atual = $${p++}`);
        params.push(status);
      }
      if (tipo) {
        where.push(`e.tipo = $${p++}`);
        params.push(tipo);
      }

      const sqlBase = `FROM cs_emails_enviados e WHERE ${where.join(' AND ')}`;

      const dados = await pool.query(
        `SELECT e.id, e.cod_cliente, e.nome_cliente, e.tipo, e.assunto,
                e.para, e.cc, e.data_inicio, e.data_fim,
                e.resend_email_id, e.status_atual,
                e.ultima_atividade_em, e.total_aberturas, e.total_cliques,
                e.enviado_por_nome, e.created_at,
                e.bounce_msg
           ${sqlBase}
          ORDER BY e.created_at DESC
          LIMIT $${p++} OFFSET $${p++}`,
        [...params, limit, offset]
      );

      const total = await pool.query(
        `SELECT COUNT(*)::int AS total ${sqlBase}`,
        params
      );

      // Agregados pro topo da tela
      const stats = await pool.query(
        `SELECT
           COUNT(*)::int AS enviados,
           COUNT(*) FILTER (WHERE status_atual IN ('delivered','opened','clicked'))::int AS entregues,
           COUNT(*) FILTER (WHERE status_atual IN ('opened','clicked'))::int AS abertos,
           COUNT(*) FILTER (WHERE status_atual = 'clicked')::int AS clicados,
           COUNT(*) FILTER (WHERE status_atual IN ('bounced','complained','failed'))::int AS bounces,
           COALESCE(SUM(total_aberturas), 0)::int AS total_aberturas,
           COALESCE(SUM(total_cliques), 0)::int AS total_cliques
         ${sqlBase}`,
        params
      );

      res.json({
        success: true,
        data: dados.rows,
        total: total.rows[0].total,
        limit,
        offset,
        estatisticas: stats.rows[0],
      });
    } catch (err) {
      console.error('[CS] Erro listar emails enviados:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // GET /cs/emails-enviados/:id — detalhe + timeline
  // ============================================================
  router.get('/cs/emails-enviados/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'id inválido' });

      const email = await pool.query(
        `SELECT id, raio_x_id, cod_cliente, nome_cliente, tipo, assunto,
                para, cc, remetente, data_inicio, data_fim,
                resend_email_id, status_atual, ultima_atividade_em,
                total_aberturas, total_cliques, bounce_msg,
                tags, enviado_por, enviado_por_nome, created_at
           FROM cs_emails_enviados
          WHERE id = $1`,
        [id]
      );
      if (email.rows.length === 0) {
        return res.status(404).json({ error: 'Email não encontrado' });
      }

      const eventos = await pool.query(
        `SELECT id, tipo, payload, ip, user_agent, link_clicado,
                evento_em, created_at
           FROM cs_email_eventos
          WHERE email_enviado_id = $1
          ORDER BY evento_em ASC, id ASC`,
        [id]
      );

      res.json({
        success: true,
        email: email.rows[0],
        eventos: eventos.rows,
      });
    } catch (err) {
      console.error('[CS] Erro detalhe email enviado:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // GET /cs/emails-enviados/:id/html — HTML do email enviado
  // Usado pelo iframe do "Ver relatório" no painel direito
  // ============================================================
  router.get('/cs/emails-enviados/:id/html', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).send('id inválido');

      const r = await pool.query(
        'SELECT html_armazenado, assunto FROM cs_emails_enviados WHERE id = $1',
        [id]
      );
      if (r.rows.length === 0 || !r.rows[0].html_armazenado) {
        return res.status(404).send('HTML não encontrado');
      }

      // CSP restritiva pra iframe — bloqueia scripts e formulários, permite só
      // imagens (inclusive data URIs e CIDs convertidos pra inline)
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src https: data:;"
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(r.rows[0].html_armazenado);
    } catch (err) {
      console.error('[CS] Erro HTML email enviado:', err);
      res.status(500).send('Erro ao carregar HTML');
    }
  });

  return router;
}

// ─────────────────────────────────────────────────────────────
// Atualização de agregados em cs_emails_enviados
// Chamado APÓS insert idempotente do evento
// ─────────────────────────────────────────────────────────────

async function atualizarAgregados(pool, emailEnviadoId, tipo) {
  const sub = statusFromTipo(tipo);
  if (!sub) return;

  // Sempre atualiza ultima_atividade_em
  const updates = ['ultima_atividade_em = NOW()'];
  const params = [];
  let p = 1;

  // Incrementa contadores específicos
  if (sub === 'opened') updates.push('total_aberturas = total_aberturas + 1');
  if (sub === 'clicked') updates.push('total_cliques = total_cliques + 1');

  // Atualiza status_atual SE o novo evento for de prioridade maior ou igual
  // (delivered não sobrescreve opened, opened não sobrescreve clicked, etc)
  const novaPrio = PRIORIDADE_STATUS[sub] || 0;
  if (novaPrio > 0) {
    updates.push(`status_atual = CASE
      WHEN COALESCE(
        (SELECT prio FROM (VALUES
          ${Object.entries(PRIORIDADE_STATUS).map(([k, v]) => `('${k}', ${v})`).join(',')}
        ) AS m(s, prio) WHERE m.s = status_atual), 0) <= $${p}
      THEN $${p + 1}
      ELSE status_atual
    END`);
    params.push(novaPrio, sub);
    p += 2;

    // Se for bounced/failed, salvar mensagem
    if (sub === 'bounced' || sub === 'failed') {
      updates.push(`bounce_msg = $${p++}`);
      params.push('Email não pôde ser entregue');
    }
  }

  params.push(emailEnviadoId);

  await pool.query(
    `UPDATE cs_emails_enviados SET ${updates.join(', ')} WHERE id = $${p}`,
    params
  );
}

module.exports = { createEmailsRoutes };
