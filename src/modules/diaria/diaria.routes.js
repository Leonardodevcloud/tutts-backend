/**
 * MÓDULO DIÁRIA - Rotas
 * Espelha o garantido.routes.js. O que muda: a escala tem HORA por motoboy.
 */
'use strict';

const express = require('express');
const { dataRefBahia } = require('../../shared/utils/tzBahia');

function hhmm(t) { return String(t || '').slice(0, 5); }

// 'HH:MM' ou 'HH:MM:SS' -> 'HH:MM', ou null se for lixo. O TIME do Postgres
// aceita coisas estranhas caladas; melhor recusar aqui.
function horaValida(v) {
  const m = /^(\d{1,2}):(\d{2})(:\d{2})?$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function createDiariaRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ── Config + escala ──
  router.get('/diaria/config/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const centralId = parseInt(req.params.central_id, 10);
      const cfgR = await pool.query(
        `SELECT id, nome, garantido_ativo, diaria_ativa, diaria_valor_padrao,
                diaria_hora_inicio, diaria_hora_fim, diaria_hora_tolerancia
           FROM filas_centrais WHERE id = $1`,
        [centralId]
      );
      if (cfgR.rows.length === 0) return res.status(404).json({ erro: 'Central não encontrada' });
      const c = cfgR.rows[0];

      const escR = await pool.query(
        `SELECT id, cod_profissional, nome_profissional, hora_inicio, hora_fim, valor
           FROM diaria_escala WHERE central_id = $1
          ORDER BY hora_inicio ASC, nome_profissional ASC`,
        [centralId]
      );

      return res.json({
        central_id: c.id,
        central_nome: c.nome,
        // O front precisa saber que o Garantido está ligado pra avisar que
        // ligar a Diária vai desligá-lo. O CHECK do banco recusaria os dois,
        // mas erro de constraint na cara do admin é péssima UX.
        garantido_ativo: !!c.garantido_ativo,
        diaria_ativa: !!c.diaria_ativa,
        diaria_valor_padrao: Number(c.diaria_valor_padrao) || 0,
        diaria_hora_inicio: hhmm(c.diaria_hora_inicio),
        diaria_hora_fim: hhmm(c.diaria_hora_fim),
        diaria_hora_tolerancia: hhmm(c.diaria_hora_tolerancia),
        escala: escR.rows.map((e) => ({
          id: e.id,
          cod_profissional: e.cod_profissional,
          nome_profissional: e.nome_profissional,
          hora_inicio: hhmm(e.hora_inicio),
          hora_fim: hhmm(e.hora_fim),
          valor: e.valor === null ? null : Number(e.valor),
        })),
      });
    } catch (err) {
      console.error('[diaria/config GET]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar config.' });
    }
  });

  router.put('/diaria/config/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const centralId = parseInt(req.params.central_id, 10);
      const { diaria_ativa, diaria_valor_padrao, diaria_hora_inicio, diaria_hora_fim, diaria_hora_tolerancia } = req.body;

      const hi = horaValida(diaria_hora_inicio) || '09:00';
      const hf = horaValida(diaria_hora_fim) || '18:00';
      if (hf <= hi) return res.status(400).json({ erro: 'A hora de fim tem que ser depois da de início.' });
      const tol = diaria_hora_tolerancia ? horaValida(diaria_hora_tolerancia) : null;

      await client.query('BEGIN');

      // ── Ligar a Diária DESLIGA o Garantido ──
      //
      // Não é atalho: é a regra "ou uma ou outra" sendo cumprida em vez de
      // apenas verificada. Se só validasse, o admin levaria um erro de
      // constraint na cara e teria que ir noutra aba desligar o Garantido pra
      // depois voltar. As duas escritas na MESMA transação — nunca existe um
      // instante com os dois ligados, nem se o processo morrer no meio.
      if (diaria_ativa) {
        await client.query(`UPDATE filas_centrais SET garantido_ativo = false WHERE id = $1`, [centralId]);
      }

      await client.query(
        `UPDATE filas_centrais
            SET diaria_ativa = $1, diaria_valor_padrao = $2,
                diaria_hora_inicio = $3, diaria_hora_fim = $4, diaria_hora_tolerancia = $5
          WHERE id = $6`,
        [!!diaria_ativa, Number(diaria_valor_padrao) || 0, hi, hf, tol, centralId]
      );

      await client.query('COMMIT');

      registrarAuditoria(req, 'DIARIA_CONFIG', 'admin', 'filas_centrais', centralId, {
        diaria_ativa: !!diaria_ativa, valor_padrao: diaria_valor_padrao,
        hora_inicio: hi, hora_fim: hf, tolerancia: tol,
        desligou_garantido: !!diaria_ativa,
      }).catch(() => {});

      return res.json({ success: true, desligou_garantido: !!diaria_ativa });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[diaria/config PUT]', err.message);
      return res.status(500).json({ erro: 'Erro ao salvar config.' });
    } finally {
      client.release();
    }
  });

  // ── Escala (só as exceções) ──
  router.post('/diaria/escala', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id, cod_profissional, nome_profissional, hora_inicio, hora_fim, valor } = req.body;
      if (!central_id || !cod_profissional) return res.status(400).json({ erro: 'central_id e cod_profissional são obrigatórios' });

      const hi = horaValida(hora_inicio);
      const hf = horaValida(hora_fim);
      if (!hi || !hf) return res.status(400).json({ erro: 'Horário inválido. Use HH:MM.' });
      if (hf <= hi) return res.status(400).json({ erro: 'A hora de fim tem que ser depois da de início.' });

      // valor vazio = NULL = usa o padrão da central. Não é o mesmo que 0.
      const v = (valor === '' || valor === null || valor === undefined) ? null : Number(valor);
      if (v !== null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ erro: 'Valor inválido.' });

      const r = await pool.query(
        `INSERT INTO diaria_escala (central_id, cod_profissional, nome_profissional, hora_inicio, hora_fim, valor)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (central_id, cod_profissional)
         DO UPDATE SET nome_profissional = EXCLUDED.nome_profissional,
                       hora_inicio = EXCLUDED.hora_inicio,
                       hora_fim = EXCLUDED.hora_fim,
                       valor = EXCLUDED.valor,
                       updated_at = NOW()
         RETURNING id`,
        [central_id, String(cod_profissional).trim(), nome_profissional || null, hi, hf, v]
      );

      registrarAuditoria(req, 'DIARIA_ESCALA_SALVAR', 'admin', 'diaria_escala', r.rows[0].id, {
        central_id, cod_profissional, hora_inicio: hi, hora_fim: hf, valor: v,
      }).catch(() => {});

      // Mudar a escala NÃO mexe no registro de hoje de quem já entrou: o valor
      // travou no ingresso. Vale a partir de amanhã (ou de hoje, pra quem ainda
      // não entrou). O front avisa isso.
      return res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
      console.error('[diaria/escala POST]', err.message);
      return res.status(500).json({ erro: 'Erro ao salvar na escala.' });
    }
  });

  router.delete('/diaria/escala/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const r = await pool.query(`DELETE FROM diaria_escala WHERE id = $1 RETURNING cod_profissional, central_id`, [id]);
      if (r.rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });

      registrarAuditoria(req, 'DIARIA_ESCALA_REMOVER', 'admin', 'diaria_escala', id, r.rows[0]).catch(() => {});
      // Removido da escala, ele volta pro horário/valor padrão da central — não
      // deixa de receber diária. Quem quer que ele não receba, tira ele da fila.
      return res.json({ success: true });
    } catch (err) {
      console.error('[diaria/escala DELETE]', err.message);
      return res.status(500).json({ erro: 'Erro ao remover.' });
    }
  });

  // ── Registros do dia ──
  router.get('/diaria/registros/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const centralId = parseInt(req.params.central_id, 10);
      const data = req.query.data || dataRefBahia();

      const r = await pool.query(
        `SELECT id, cod_profissional, nome_profissional, hora_ingresso,
                hora_inicio_ref, hora_fim_ref, da_escala,
                valor_base, fracao, minutos_atraso, valor_diaria
           FROM diaria_registros
          WHERE central_id = $1 AND data_ref = $2
          ORDER BY hora_ingresso ASC`,
        [centralId, data]
      );

      const total = r.rows.reduce((s, x) => s + Number(x.valor_diaria), 0);

      return res.json({
        data_ref: data,
        total_do_dia: Math.round(total * 100) / 100,
        registros: r.rows.map((x) => ({
          id: x.id,
          cod_profissional: x.cod_profissional,
          nome_profissional: x.nome_profissional,
          hora_ingresso: x.hora_ingresso,
          hora_inicio: hhmm(x.hora_inicio_ref),
          hora_fim: hhmm(x.hora_fim_ref),
          da_escala: x.da_escala,
          valor_base: Number(x.valor_base),
          fracao: Number(x.fracao),
          minutos_atraso: Number(x.minutos_atraso),
          valor_diaria: Number(x.valor_diaria),
        })),
      });
    } catch (err) {
      console.error('[diaria/registros]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar registros.' });
    }
  });

  // ── O motoboy vendo a própria diária ──
  router.get('/diaria/meu', verificarToken, async (req, res) => {
    try {
      const cod = req.user?.codProfissional;
      if (!cod) return res.json({ tem: false });

      const r = await pool.query(
        `SELECT d.valor_diaria, d.valor_base, d.minutos_atraso, d.hora_inicio_ref, d.hora_fim_ref,
                d.da_escala, c.nome AS central_nome
           FROM diaria_registros d
           JOIN filas_centrais c ON c.id = d.central_id
          WHERE d.cod_profissional = $1 AND d.data_ref = $2
          ORDER BY d.hora_ingresso DESC LIMIT 1`,
        [cod, dataRefBahia()]
      );
      if (r.rows.length === 0) return res.json({ tem: false });

      const d = r.rows[0];
      return res.json({
        tem: true,
        central_nome: d.central_nome,
        valor_diaria: Number(d.valor_diaria),
        valor_base: Number(d.valor_base),
        minutos_atraso: Number(d.minutos_atraso),
        hora_inicio: hhmm(d.hora_inicio_ref),
        hora_fim: hhmm(d.hora_fim_ref),
        da_escala: d.da_escala,
      });
    } catch (err) {
      console.error('[diaria/meu]', err.message);
      return res.status(500).json({ erro: 'Erro ao carregar.' });
    }
  });

  return router;
}

module.exports = { createDiariaRouter };
