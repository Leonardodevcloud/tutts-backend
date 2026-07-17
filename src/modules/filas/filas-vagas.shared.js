/**
 * FILAS - Trava de vagas por dia
 *
 * ── A REGRA (do Tutts, 17/07) ──
 *
 *   "15 pessoas entraram. Elas ficam registradas. Por mais que saiam da fila,
 *    o registro delas na contagem continua."
 *
 * Ou seja: a vaga é queimada no 1º ingresso do dia e NÃO volta quando o motoboy
 * sai. Ele entrou, ele é um dos 15 — pegou corrida, voltou, saiu pra almoçar,
 * foi embora, tanto faz. Só um botão explícito de "liberar vaga" devolve.
 *
 * Isto NÃO é um contador de "quantos estão na fila agora". É um contador de
 * "quantos já entraram hoje". A diferença é o ponto inteiro da funcionalidade —
 * se fosse ocupação atual, o 16º entraria assim que alguém saísse pro almoço.
 *
 * ── NÃO É INVENÇÃO NOVA ──
 *
 * É exatamente o mecanismo que o garantido_registros já usa há meses pra travar
 * o valor no 1º ingresso: UNIQUE(central_id, cod_profissional, data_ref), a
 * linha nasce na entrada e sobrevive à saída. Mesmo padrão, mesma tabela-formato,
 * mesmo comportamento na virada do dia (zera sozinho: data_ref muda).
 *
 * ── QUEM FURA A TRAVA ──
 *
 * Quem está na escala da Diária entra SEMPRE, mesmo com as vagas esgotadas.
 * Motivo: você não paga diária pra alguém ficar de fora. Se 15 avulsos entrarem
 * às 7h numa central com 10 escalados, a trava trancaria justamente as pessoas
 * que já estão sendo pagas — e o admin só descobriria com o motoboy ligando.
 *
 * O escalado OCUPA vaga (aparece na conta), ele só não é BARRADO por ela. Numa
 * central mal configurada isso faz o contador passar do limite (25 de 15). É
 * feio de propósito: significa que o limite está errado pra escala montada, e a
 * tela precisa dizer isso em vez de esconder.
 */
'use strict';

const { dataRefBahia } = require('../../shared/utils/tzBahia');
const { estaNaEscalaDiaria } = require('../diaria/diaria.shared');

/**
 * Confere e ocupa a vaga do dia. Chamado ANTES do INSERT em filas_posicoes.
 *
 * @returns {{ ok:true, ocupou:boolean, ja_tinha:boolean, furou:boolean }}
 *        | {{ ok:false, motivo:'fila_cheia', limite:number, ocupadas:number }}
 */
async function verificarEOcuparVaga(pool, { central_id, cod_profissional, nome_profissional }) {
  if (!central_id || !cod_profissional) return { ok: true, ocupou: false, ja_tinha: false, furou: false };

  const dataRef = dataRefBahia();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── O LOCK ──
    //
    // Sem isto, a trava vaza no ÚNICO momento em que ela importa: no limite.
    // Dois motoboys tocando "entrar" no mesmo instante com 1 vaga livre — os
    // dois leem "14 ocupadas", os dois passam, viram 16.
    //
    // O FOR UPDATE na linha da central serializa as entradas DAQUELA central:
    // o segundo espera o primeiro commitar e aí lê 15. Entradas são raras
    // (algumas por minuto), então segurar a linha por alguns ms não custa nada.
    // Centrais diferentes não se esperam — o lock é por linha, não por tabela.
    const cfgR = await client.query(
      `SELECT vagas_limite FROM filas_centrais WHERE id = $1 FOR UPDATE`,
      [central_id]
    );
    if (cfgR.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: true, ocupou: false, ja_tinha: false, furou: false };
    }

    const limite = Number(cfgR.rows[0].vagas_limite) || 0;
    if (limite <= 0) {
      // 0 = sem trava. É o default, e é como todas as centrais existentes ficam
      // depois da migration: ninguém acorda amanhã com a fila travada porque
      // subiu um deploy.
      await client.query('ROLLBACK');
      return { ok: true, ocupou: false, ja_tinha: false, furou: false };
    }

    // ── Já tem vaga hoje? ──
    //
    // Esta checagem vem ANTES da do limite, e a ordem não é acidental: quem já
    // queimou vaga hoje entra de novo sem consumir outra — a vaga já é dele.
    // Invertido, o cara que volta do almoço seria barrado da própria fila.
    const jaR = await client.query(
      `SELECT id, liberada_em FROM filas_vagas_dia
        WHERE central_id = $1 AND cod_profissional = $2 AND data_ref = $3`,
      [central_id, cod_profissional, dataRef]
    );
    if (jaR.rows.length > 0 && !jaR.rows[0].liberada_em) {
      await client.query('COMMIT');
      return { ok: true, ocupou: false, ja_tinha: true, furou: false };
    }

    // ── Escalado da diária fura a trava ──
    const escalado = await estaNaEscalaDiaria(pool, { central_id, cod_profissional });

    if (!escalado) {
      const ocupR = await client.query(
        `SELECT COUNT(*)::int AS n FROM filas_vagas_dia
          WHERE central_id = $1 AND data_ref = $2 AND liberada_em IS NULL`,
        [central_id, dataRef]
      );
      const ocupadas = ocupR.rows[0].n;
      if (ocupadas >= limite) {
        await client.query('ROLLBACK');
        return { ok: false, motivo: 'fila_cheia', limite, ocupadas };
      }
    }

    // ── Ocupa ──
    //
    // Quem liberou a vaga e voltou: a linha existe com liberada_em preenchido.
    // O ON CONFLICT reabre a MESMA linha (novo ocupada_em, liberada_em zerado)
    // em vez de tentar inserir uma segunda e violar o UNIQUE. Ele pega a próxima
    // vaga livre — que é o que o botão "liberar" prometeu quando foi clicado.
    await client.query(
      `INSERT INTO filas_vagas_dia
         (central_id, cod_profissional, nome_profissional, data_ref, ocupada_em, furou_trava)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (central_id, cod_profissional, data_ref)
       DO UPDATE SET ocupada_em = NOW(), liberada_em = NULL,
                     liberada_por_cod = NULL, liberada_por_nome = NULL,
                     furou_trava = EXCLUDED.furou_trava`,
      [central_id, cod_profissional, nome_profissional || null, dataRef, escalado]
    );

    await client.query('COMMIT');
    return { ok: true, ocupou: true, ja_tinha: false, furou: escalado };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ [filas/vagas]', err.message);
    // ── FALHA ABERTA, DE PROPÓSITO ──
    // Se a trava quebrar (banco fora, coluna faltando, o que for), o motoboy
    // ENTRA. Uma trava com bug barrando gente boa é pior que uma trava que não
    // funciona: o prejuízo é imediato, silencioso e cai em cima de quem só quer
    // trabalhar. Erro fica no log do Railway pra gente ver.
    return { ok: true, ocupou: false, ja_tinha: false, furou: false, erro: err.message };
  } finally {
    client.release();
  }
}

/** Contagem pra tela do admin. */
async function contarVagas(pool, central_id) {
  const dataRef = dataRefBahia();
  const r = await pool.query(
    `SELECT
       (SELECT COALESCE(vagas_limite, 0) FROM filas_centrais WHERE id = $1) AS limite,
       COUNT(*) FILTER (WHERE liberada_em IS NULL)::int AS ocupadas,
       COUNT(*) FILTER (WHERE liberada_em IS NOT NULL)::int AS liberadas
     FROM filas_vagas_dia WHERE central_id = $1 AND data_ref = $2`,
    [central_id, dataRef]
  );
  const row = r.rows[0] || {};
  const limite = Number(row.limite) || 0;
  const ocupadas = Number(row.ocupadas) || 0;
  return {
    limite,
    ocupadas,
    liberadas: Number(row.liberadas) || 0,
    livres: limite > 0 ? Math.max(0, limite - ocupadas) : null,
    estourado: limite > 0 && ocupadas > limite,
    data_ref: dataRef,
  };
}

module.exports = { verificarEOcuparVaga, contarVagas };
