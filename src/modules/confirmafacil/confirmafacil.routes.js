'use strict';

const express = require('express');
const { getConfirmaFacilAuth }   = require('./confirmafacil.auth');
const { getConfirmaFacilPoller } = require('./confirmafacil.poller');
const AppError = require('../../shared/errors/AppError');

function createConfirmaFacilRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  const auth   = getConfirmaFacilAuth();

  // ── Config principal ──────────────────────────────
  router.get('/config/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, cliente_id, ativo, cf_email, cf_id_cliente, cnpj_transportadora,
               mapa_ocorrencias, polling_ativo, ultimo_polling, criado_em
        FROM confirmafacil_config WHERE cliente_id = $1
      `, [req.params.clienteId]);
      res.json({ config: rows[0] || null });
    } catch (err) { next(err); }
  });

  router.post('/config', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { cliente_id, cf_email, cf_senha, cf_id_cliente, cf_id_produto,
              cnpj_transportadora, mapa_ocorrencias, polling_ativo, ativo } = req.body;

      if (!cliente_id || !cf_email || !cf_senha || !cnpj_transportadora)
        throw new AppError('cliente_id, cf_email, cf_senha e cnpj_transportadora são obrigatórios', 400);

      const { rows } = await pool.query(`
        INSERT INTO confirmafacil_config
          (cliente_id, cf_email, cf_senha, cf_id_cliente, cf_id_produto,
           cnpj_transportadora, mapa_ocorrencias, polling_ativo, ativo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (cliente_id) DO UPDATE SET
          cf_email            = EXCLUDED.cf_email,
          cf_senha            = EXCLUDED.cf_senha,
          cf_id_cliente       = EXCLUDED.cf_id_cliente,
          cf_id_produto       = EXCLUDED.cf_id_produto,
          cnpj_transportadora = EXCLUDED.cnpj_transportadora,
          mapa_ocorrencias    = EXCLUDED.mapa_ocorrencias,
          polling_ativo       = EXCLUDED.polling_ativo,
          ativo               = EXCLUDED.ativo,
          atualizado_em       = NOW()
        RETURNING id, cliente_id, ativo, polling_ativo, cf_email, cnpj_transportadora
      `, [cliente_id, cf_email, cf_senha, cf_id_cliente || 320, cf_id_produto || 1,
          cnpj_transportadora, JSON.stringify(mapa_ocorrencias || {}),
          polling_ativo !== false, ativo !== false]);

      auth.invalidar(cliente_id);
      res.json({ ok: true, config: rows[0] });
    } catch (err) { next(err); }
  });

  // ── Embarcadores ──────────────────────────────────
  router.get('/embarcadores/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT e.* FROM confirmafacil_embarcadores e
        INNER JOIN confirmafacil_config c ON c.id = e.config_id
        WHERE c.cliente_id = $1 ORDER BY e.nome_embarcador
      `, [req.params.clienteId]);
      res.json({ embarcadores: rows });
    } catch (err) { next(err); }
  });

  router.post('/embarcadores', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { cliente_id, cnpj_embarcador, nome_embarcador,
              coleta_rua, coleta_numero, coleta_bairro,
              coleta_cidade, coleta_uf, coleta_cep,
              coleta_lat, coleta_lng, coleta_nome_fantasia, coleta_telefone } = req.body;

      if (!cliente_id || !cnpj_embarcador || !coleta_cidade || !coleta_uf)
        throw new AppError('cliente_id, cnpj_embarcador, coleta_cidade e coleta_uf são obrigatórios', 400);

      // Buscar config_id
      const { rows: cfg } = await pool.query(
        'SELECT id FROM confirmafacil_config WHERE cliente_id = $1', [cliente_id]);
      if (!cfg[0]) throw new AppError('Config CF não encontrada para este cliente', 404);

      const { rows } = await pool.query(`
        INSERT INTO confirmafacil_embarcadores
          (config_id, cnpj_embarcador, nome_embarcador,
           coleta_rua, coleta_numero, coleta_bairro,
           coleta_cidade, coleta_uf, coleta_cep,
           coleta_lat, coleta_lng, coleta_nome_fantasia, coleta_telefone)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (config_id, cnpj_embarcador) DO UPDATE SET
          nome_embarcador     = EXCLUDED.nome_embarcador,
          coleta_rua          = EXCLUDED.coleta_rua,
          coleta_numero       = EXCLUDED.coleta_numero,
          coleta_bairro       = EXCLUDED.coleta_bairro,
          coleta_cidade       = EXCLUDED.coleta_cidade,
          coleta_uf           = EXCLUDED.coleta_uf,
          coleta_cep          = EXCLUDED.coleta_cep,
          coleta_lat          = EXCLUDED.coleta_lat,
          coleta_lng          = EXCLUDED.coleta_lng,
          coleta_nome_fantasia= EXCLUDED.coleta_nome_fantasia,
          coleta_telefone     = EXCLUDED.coleta_telefone
        RETURNING *
      `, [cfg[0].id, cnpj_embarcador, nome_embarcador,
          coleta_rua, coleta_numero, coleta_bairro,
          coleta_cidade, coleta_uf, coleta_cep,
          coleta_lat || null, coleta_lng || null,
          coleta_nome_fantasia, coleta_telefone]);

      res.json({ ok: true, embarcador: rows[0] });
    } catch (err) { next(err); }
  });

  router.delete('/embarcadores/:id', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      await pool.query(
        'UPDATE confirmafacil_embarcadores SET ativo = FALSE WHERE id = $1',
        [req.params.id]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Log e vínculos ────────────────────────────────
  router.get('/log/:solicitacaoId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, numero_nf, id_embarque, status_tutts, cod_ocorrencia,
               tipo, sucesso, erro_msg, criado_em
        FROM confirmafacil_log WHERE solicitacao_id = $1
        ORDER BY criado_em DESC LIMIT 100
      `, [req.params.solicitacaoId]);
      res.json({ logs: rows });
    } catch (err) { next(err); }
  });

  // ── Busca direta no CF (teste — não cria corrida) ────────────
  router.post('/buscar-nfs', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { de, ate, page, size } = req.body;

      // Busca todas as configs ativas
      const { rows: configs } = await pool.query(`
        SELECT cf.*, cs.nome AS cliente_nome
        FROM confirmafacil_config cf
        INNER JOIN clientes_solicitacao cs ON cs.id = cf.cliente_id
        WHERE cf.ativo = TRUE
        LIMIT 10
      `);

      if (configs.length === 0) {
        return res.json({ ok: false, mensagem: 'Nenhum cliente CF configurado ainda' });
      }

      const resultados = [];

      for (const config of configs) {
        try {
          const token = await auth.obterToken(config.cliente_id, config);

          const agora = new Date();
          const inicio = de || (() => {
            const d = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
            return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} 00:00:00`;
          })();
          const fim = ate || (() => {
            return `${agora.getFullYear()}/${String(agora.getMonth()+1).padStart(2,'0')}/${String(agora.getDate()).padStart(2,'0')} 23:59:59`;
          })();

          const filtro = {
            page: page || 0,
            size: size || 20,
            de: inicio,
            ate: fim,
            cnpjTransportadora: [config.cnpj_transportadora],
          };

          const params = new URLSearchParams({ filtroDTO: JSON.stringify(filtro) });
          const httpRequest = require('../../shared/utils/httpRequest');
          const resp = await httpRequest(
            `https://utilities.confirmafacil.com.br/filter/embarque?${params}`,
            { method: 'GET', headers: { Authorization: token, accept: 'application/json' } }
          );

          const data = resp.json();
          resultados.push({
            cliente_id:   config.cliente_id,
            cliente_nome: config.cliente_nome,
            filtro_usado: filtro,
            total:        data.totalCount || data.respostas?.length || 0,
            total_paginas:data.totalPages || 1,
            nfs:          data.respostas || data.content || data || [],
            status_http:  resp.status,
            ok:           resp.ok,
          });
        } catch (err) {
          resultados.push({
            cliente_id:   config.cliente_id,
            cliente_nome: config.cliente_nome,
            ok:           false,
            erro:         err.message,
          });
        }
      }

      res.json({ ok: true, resultados });
    } catch (err) { next(err); }
  });

  // ── NFs recebidas — TODAS os clientes (sem filtro) ────────────
  router.get('/nfs', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          v.id, v.id_embarque, v.solicitacao_id, v.numero_nf, v.serie_nf,
          v.cnpj_embarcador, v.criado_em,
          sc.status,
          sc.tutts_os_numero,
          cs.nome AS cliente_nome
        FROM confirmafacil_vinculos v
        LEFT JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
        LEFT JOIN clientes_solicitacao cs ON cs.id = v.cliente_id
        ORDER BY v.criado_em DESC
        LIMIT 500
      `);
      res.json({ vinculos: rows });
    } catch (err) { next(err); }
  });

  // ── NFs recebidas por cliente ─────────────────────────────────
  router.get('/nfs/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT v.id, v.id_embarque, v.solicitacao_id, v.numero_nf, v.serie_nf,
               v.cnpj_embarcador, v.criado_em,
               sc.status, sc.tutts_os_numero
        FROM confirmafacil_vinculos v
        LEFT JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
        WHERE v.cliente_id = $1
        ORDER BY v.criado_em DESC
        LIMIT 500
      `, [req.params.clienteId]);
      res.json({ vinculos: rows });
    } catch (err) { next(err); }
  });

  // ── Test credenciais ──────────────────────────────
  router.post('/test/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM confirmafacil_config WHERE cliente_id = $1', [req.params.clienteId]);
      if (!rows[0]) throw new AppError('Config não encontrada', 404);

      auth.invalidar(Number(req.params.clienteId));
      const token = await auth.obterToken(Number(req.params.clienteId), rows[0]);
      res.json({ ok: true, mensagem: 'Credenciais válidas', token_obtido: !!token });
    } catch (err) {
      if (err.status) return next(err);
      res.json({ ok: false, mensagem: err.message });
    }
  });

  // ── Polling manual (força um ciclo agora) ─────────
  router.post('/polling/forcar', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const poller = getConfirmaFacilPoller(pool);
      // Roda em background — não aguarda
      poller._ciclo().catch(err => console.error('[CF Poller] forçado erro:', err.message));
      res.json({ ok: true, mensagem: 'Ciclo de polling iniciado em background' });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createConfirmaFacilRouter };
