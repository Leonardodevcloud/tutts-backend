/**
 * FILAS - Rotas da trava de vagas (admin)
 *
 * Entra como 4º sub-router do filas.routes.js — a trava é da FILA, não da
 * diária. Ela funciona numa central sem diária nenhuma, e por isso não pode
 * morar no módulo da diária.
 *
 * ATENÇÃO AO PREFIXO: este router é montado dentro do initFilasRoutes, que o
 * server.js pendura em '/api/filas' (linha 702). Então os caminhos aqui são
 * RELATIVOS: '/vagas/:id' vira '/api/filas/vagas/:id'.
 *
 * Escrever '/filas/vagas/:id' aqui produziria '/api/filas/filas/vagas/:id' — que
 * nunca responde. Foi exatamente o erro que eu cometi na primeira versão deste
 * arquivo, e que só apareceu quando conferi as rotas do front contra as do back.
 * O módulo da diária NÃO tem esse problema porque ele é montado em '/api' puro.
 */
'use strict';

const express = require('express');
const { contarVagas } = require('../filas-vagas.shared');
const { dataRefBahia } = require('../../../shared/utils/tzBahia');

function createFilasVagasRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ── GET: contagem + quem ocupa ──
  router.get('/vagas/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const centralId = parseInt(req.params.central_id, 10);
      if (!centralId) return res.status(400).json({ erro: 'central_id inválido' });

      const contagem = await contarVagas(pool, centralId);

      // O "está agora" é o que responde, antes de virar chamado, a pergunta
      // "por que o contador diz 12 se só tem 8 na fila?". O LEFT JOIN em
      // filas_posicoes é o que traz isso: a vaga é do dia, a posição é de agora.
      const listaR = await pool.query(
        `SELECT v.id, v.cod_profissional, v.nome_profissional,
                v.ocupada_em, v.liberada_em, v.liberada_por_nome, v.furou_trava,
                p.status AS status_fila, p.posicao,
                (e.cod_profissional IS NOT NULL) AS na_escala
           FROM filas_vagas_dia v
           LEFT JOIN filas_posicoes p
             ON p.central_id = v.central_id
            AND p.cod_profissional = v.cod_profissional
            AND p.status IN ('aguardando', 'em_rota')
           LEFT JOIN diaria_escala e
             ON e.central_id = v.central_id
            AND e.cod_profissional = v.cod_profissional
          WHERE v.central_id = $1 AND v.data_ref = $2
          ORDER BY v.ocupada_em ASC`,
        [centralId, dataRefBahia()]
      );

      return res.json({
        ...contagem,
        ocupantes: listaR.rows.map((r) => ({
          id: r.id,
          cod_profissional: r.cod_profissional,
          nome_profissional: r.nome_profissional,
          ocupada_em: r.ocupada_em,
          liberada_em: r.liberada_em,
          liberada_por_nome: r.liberada_por_nome,
          furou_trava: r.furou_trava,
          na_escala: r.na_escala,
          status_fila: r.status_fila || null,
          posicao: r.posicao || null,
        })),
      });
    } catch (err) {
      console.error('[filas/vagas GET]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar vagas.' });
    }
  });

  // ── PUT: limite ──
  router.put('/vagas/:central_id/limite', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const centralId = parseInt(req.params.central_id, 10);
      let limite = parseInt(req.body.vagas_limite, 10);
      if (!Number.isFinite(limite) || limite < 0) limite = 0;
      if (limite > 999) limite = 999;

      await pool.query(`UPDATE filas_centrais SET vagas_limite = $1 WHERE id = $2`, [limite, centralId]);

      // Baixar o limite NÃO expulsa ninguém que já entrou. A vaga foi dada; o
      // limite novo vale pro próximo. Se expulsasse, um erro de digitação
      // tiraria motoboy da rua no meio do expediente.
      const contagem = await contarVagas(pool, centralId);

      registrarAuditoria(req, 'FILA_VAGAS_LIMITE', 'admin', 'filas_centrais', centralId, {
        vagas_limite: limite,
      }).catch(() => {});

      return res.json({ success: true, ...contagem });
    } catch (err) {
      console.error('[filas/vagas PUT]', err.message);
      return res.status(500).json({ erro: 'Erro ao salvar limite.' });
    }
  });

  // ── POST: liberar vaga ──
  //
  // O único jeito de devolver uma vaga. Sair da fila NÃO devolve — é o ponto
  // inteiro da funcionalidade.
  router.post('/vagas/:id/liberar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ erro: 'id inválido' });

      // Grava QUEM liberou. Botão que causa prejuízo (o motoboy pode ficar de
      // fora) e não deixa rastro é como se descobre problema tarde demais.
      const r = await pool.query(
        `UPDATE filas_vagas_dia
            SET liberada_em = NOW(),
                liberada_por_cod  = $2,
                liberada_por_nome = $3
          WHERE id = $1 AND liberada_em IS NULL
          RETURNING central_id, cod_profissional, nome_profissional`,
        // req.user (nao req.usuario) e codProfissional em camelCase: e o que o
        // resto do projeto usa (145 ocorrencias). Errar aqui nao quebra nada —
        // grava undefined calado, e a auditoria fica dizendo que ninguem liberou.
        [id, req.user?.codProfissional || null, req.user?.nome || 'Admin']
      );
      if (r.rows.length === 0) {
        return res.status(409).json({ erro: 'Essa vaga já estava liberada.' });
      }

      const contagem = await contarVagas(pool, r.rows[0].central_id);

      registrarAuditoria(req, 'FILA_VAGA_LIBERAR', 'admin', 'filas_vagas_dia', id, {
        cod_profissional: r.rows[0].cod_profissional,
        nome_profissional: r.rows[0].nome_profissional,
      }).catch(() => {});

      return res.json({ success: true, ...contagem });
    } catch (err) {
      console.error('[filas/vagas liberar]', err.message);
      return res.status(500).json({ erro: 'Erro ao liberar vaga.' });
    }
  });

  return router;
}

module.exports = { createFilasVagasRoutes };
