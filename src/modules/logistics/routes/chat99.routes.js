'use strict';

const express = require('express');

/**
 * Rotas do Chat 99 (todas sob /api/logistics).
 *
 *   GET  /chat99/conversas          -> lista de conversas p/ o painel (esquerda)
 *   GET  /chat99/unread-counts      -> { [codigo_os]: nao_lidas }  (badges dos cards)
 *   GET  /chat99/:os                -> conversa + mensagens (thread)
 *   POST /chat99/:os/enviar         -> enfileira msg 'out' (outbox do agente)
 *   POST /chat99/:os/marcar-lidas   -> zera nao_lidas (atendente abriu a thread)
 *   POST /chat99/:os/encerrar       -> status='encerrada'
 *
 * O agente Playwright "chat99" (tutts-agents) é quem popula chat99_mensagens
 * (direcao 'in') e consome as 'out' pendentes. Estas rotas só leem/escrevem o
 * banco — nunca falam com a 99 direto.
 */
function createChat99Routes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  const LIMITE_99 = 140; // limite de caracteres por mensagem imposto pela 99

  const nomeOperador = (req) =>
    (req.user && (req.user.nome || req.user.email || req.user.usuario)) || 'operador';

  // ──────────────────────────────────────────────────────────────────
  // GET /chat99/conversas — lista pro painel. Ordena por atividade recente.
  // Query opcional: ?status=ativa|encerrada|todas (default: ativa)
  // ──────────────────────────────────────────────────────────────────
  router.get('/chat99/conversas', verificarToken, verificarAdmin, async (req, res) => {
    try {
      // Default 'abertas' = mostra ativa + aguardando_aceite (conversa iniciada
      // pelo atendente nasce como aguardando_aceite e precisa aparecer na lista).
      const status = String(req.query.status || 'abertas');
      let where, params;
      if (status === 'todas') { where = ''; params = []; }
      else if (status === 'abertas') { where = "WHERE status <> 'encerrada'"; params = []; }
      else { where = 'WHERE status = $1'; params = [status]; }

      const { rows } = await pool.query(`
        SELECT id, codigo_os, pedido_id_99, motoboy_nome, motoboy_telefone,
               motoboy_foto_url, motoboy_rating, status, ultima_msg_texto,
               ultima_msg_em, nao_lidas, atualizado_em
        FROM chat99_conversas
        ${where}
        ORDER BY (nao_lidas > 0) DESC, ultima_msg_em DESC NULLS LAST, atualizado_em DESC
        LIMIT 200
      `, params);

      res.json({ conversas: rows });
    } catch (err) {
      console.error('[chat99] GET /conversas:', err.message);
      res.status(500).json({ error: 'Falha ao listar conversas.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /chat99/unread-counts — mapa leve { codigo_os: nao_lidas } só das que
  // têm não-lidas > 0. É o que os cards do Kanban pollam pra mostrar o badge.
  // ──────────────────────────────────────────────────────────────────
  router.get('/chat99/unread-counts', verificarToken, verificarAdmin, async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT codigo_os, nao_lidas
        FROM chat99_conversas
        WHERE nao_lidas > 0 AND status = 'ativa'
      `);
      const mapa = {};
      for (const r of rows) mapa[r.codigo_os] = Number(r.nao_lidas) || 0;
      res.json({ unread: mapa });
    } catch (err) {
      console.error('[chat99] GET /unread-counts:', err.message);
      res.status(500).json({ error: 'Falha ao buscar contadores.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /chat99/:os — conversa + mensagens (thread). Busca por OS (=ID externo).
  // ──────────────────────────────────────────────────────────────────
  router.get('/chat99/:os', verificarToken, verificarAdmin, async (req, res) => {
    const codigoOs = String(req.params.os || '').trim();
    if (!codigoOs) return res.status(400).json({ error: 'OS obrigatoria.' });

    try {
      const conv = await pool.query(
        `SELECT * FROM chat99_conversas WHERE codigo_os = $1 LIMIT 1`, [codigoOs]
      );
      if (conv.rows.length === 0) {
        // Ainda sem chat capturado pra essa OS — devolve vazio (o agente cria
        // a conversa quando encontrar o botao Mensagem na 99).
        return res.json({ conversa: null, mensagens: [] });
      }

      const conversa = conv.rows[0];
      const msgs = await pool.query(`
        SELECT id, msg_99_id, direcao, autor, texto, img_url, horario_99, lido,
               status_envio, erro_envio, criado_em, enviado_em
        FROM chat99_mensagens
        WHERE conversa_id = $1
        ORDER BY id ASC
        LIMIT 500
      `, [conversa.id]);

      res.json({ conversa, mensagens: msgs.rows });
    } catch (err) {
      console.error('[chat99] GET /:os:', err.message);
      res.status(500).json({ error: 'Falha ao carregar a conversa.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /chat99/:os/enviar — enfileira mensagem 'out' (o agente envia depois).
  // Body: { texto }
  // Se a conversa ainda nao existe, cria em status 'aguardando_aceite' — assim
  // a mensagem fica na fila e sai quando o motoboy aceitar e o chat abrir.
  // ──────────────────────────────────────────────────────────────────
  router.post('/chat99/:os/enviar', verificarToken, verificarAdmin, async (req, res) => {
    const codigoOs = String(req.params.os || '').trim();
    const texto = String((req.body && req.body.texto) || '').trim();

    if (!codigoOs) return res.status(400).json({ error: 'OS obrigatoria.' });
    if (!texto) return res.status(400).json({ error: 'Mensagem vazia.' });
    if (texto.length > LIMITE_99) {
      return res.status(400).json({ error: `Maximo de ${LIMITE_99} caracteres por mensagem (limite da 99).` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let conv = await client.query(
        `SELECT id FROM chat99_conversas WHERE codigo_os = $1 FOR UPDATE`, [codigoOs]
      );

      let conversaId;
      if (conv.rows.length === 0) {
        const ins = await client.query(`
          INSERT INTO chat99_conversas (codigo_os, status)
          VALUES ($1, 'aguardando_aceite')
          RETURNING id
        `, [codigoOs]);
        conversaId = ins.rows[0].id;
      } else {
        conversaId = conv.rows[0].id;
      }

      const msg = await client.query(`
        INSERT INTO chat99_mensagens (conversa_id, direcao, autor, texto, status_envio)
        VALUES ($1, 'out', 'atendente', $2, 'pendente')
        RETURNING id, criado_em
      `, [conversaId, texto]);

      await client.query(`
        UPDATE chat99_conversas
        SET ultima_msg_texto = $2, ultima_msg_em = now(), atualizado_em = now()
        WHERE id = $1
      `, [conversaId, texto]);

      await client.query('COMMIT');

      if (typeof registrarAuditoria === 'function') {
        registrarAuditoria(req, {
          acao: 'CHAT99_ENVIAR',
          detalhes: `OS ${codigoOs}: ${nomeOperador(req)} enviou ${texto.length} chars`,
        }).catch(() => {});
      }

      res.json({
        ok: true,
        mensagem: { id: msg.rows[0].id, direcao: 'out', autor: 'atendente',
          texto, status_envio: 'pendente', criado_em: msg.rows[0].criado_em },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[chat99] POST /:os/enviar:', err.message);
      res.status(500).json({ error: 'Falha ao enfileirar a mensagem.' });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /chat99/:os/marcar-lidas — zera nao_lidas (atendente abriu a thread).
  // ──────────────────────────────────────────────────────────────────
  router.post('/chat99/:os/marcar-lidas', verificarToken, verificarAdmin, async (req, res) => {
    const codigoOs = String(req.params.os || '').trim();
    if (!codigoOs) return res.status(400).json({ error: 'OS obrigatoria.' });
    try {
      await pool.query(
        `UPDATE chat99_conversas SET nao_lidas = 0, atualizado_em = now() WHERE codigo_os = $1`,
        [codigoOs]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[chat99] POST /:os/marcar-lidas:', err.message);
      res.status(500).json({ error: 'Falha ao marcar como lidas.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /chat99/:os/encerrar — status='encerrada' (some da lista de ativas).
  // ──────────────────────────────────────────────────────────────────
  router.post('/chat99/:os/encerrar', verificarToken, verificarAdmin, async (req, res) => {
    const codigoOs = String(req.params.os || '').trim();
    if (!codigoOs) return res.status(400).json({ error: 'OS obrigatoria.' });
    try {
      await pool.query(
        `UPDATE chat99_conversas SET status = 'encerrada', atualizado_em = now() WHERE codigo_os = $1`,
        [codigoOs]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[chat99] POST /:os/encerrar:', err.message);
      res.status(500).json({ error: 'Falha ao encerrar a conversa.' });
    }
  });

  return router;
}

module.exports = { createChat99Routes };
