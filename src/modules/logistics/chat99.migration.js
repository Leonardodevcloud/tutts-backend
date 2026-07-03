/**
 * MÓDULO LOGISTICS — Chat 99 (migration)
 *
 * Cria as duas tabelas do chat com o motoboy da 99Entrega. O chat da 99 NÃO
 * tem API — só existe na plataforma web (entrega.99app.com). O agente Playwright
 * "chat99" (tutts-agents) espelha as mensagens pra cá e envia as nossas de volta.
 *
 * Identificador da corrida: codigo_os == "ID do pedido externo" na tela da 99.
 *
 * Tabelas:
 *   chat99_conversas  — 1 linha por corrida com chat ativo (dados do motoboy +
 *                       resumo da última mensagem + contador de não-lidas)
 *   chat99_mensagens  — cada bolha do chat. direcao 'in' (motoboy) / 'out' (nós).
 *                       As 'out' pendentes funcionam como OUTBOX que o agente drena.
 *
 * Dedup: msg_99_id guarda o "msg_<id>" que a própria 99 põe na classe da bolha
 * (ex: content__msg msg_65561). É a chave natural — ON CONFLICT DO NOTHING evita
 * duplicar mensagem já capturada, sem depender de hash de texto.
 *
 * Idempotente: CREATE TABLE / INDEX IF NOT EXISTS. Seguro rodar N vezes.
 */

'use strict';

async function initChat99Tables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat99_conversas (
      id               SERIAL PRIMARY KEY,
      codigo_os        TEXT NOT NULL UNIQUE,
      pedido_id_99     TEXT,
      motoboy_nome     TEXT,
      motoboy_telefone TEXT,
      motoboy_foto_url TEXT,
      motoboy_rating   TEXT,
      status           TEXT NOT NULL DEFAULT 'ativa',
      ultima_msg_texto TEXT,
      ultima_msg_em    TIMESTAMPTZ,
      nao_lidas        INTEGER NOT NULL DEFAULT 0,
      ultima_varredura TIMESTAMPTZ,
      criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat99_mensagens (
      id           SERIAL PRIMARY KEY,
      conversa_id  INTEGER NOT NULL REFERENCES chat99_conversas(id) ON DELETE CASCADE,
      msg_99_id    TEXT,
      direcao      TEXT NOT NULL,
      autor        TEXT,
      texto        TEXT,
      img_url      TEXT,
      horario_99   TEXT,
      lido         BOOLEAN NOT NULL DEFAULT false,
      status_envio TEXT NOT NULL DEFAULT 'recebida',
      erro_envio   TEXT,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
      enviado_em   TIMESTAMPTZ
    );
  `);

  // Dedup das mensagens capturadas do motoboy (in): a chave é o msg_<id> da 99.
  // WHERE msg_99_id IS NOT NULL porque as 'out' pendentes ainda não têm id da 99.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_chat99_msg_dedup
    ON chat99_mensagens (conversa_id, msg_99_id)
    WHERE msg_99_id IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_chat99_msg_conversa
    ON chat99_mensagens (conversa_id, id);
  `);

  // Fila de saída (outbox) que o agente drena: out + pendente.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_chat99_msg_outbox
    ON chat99_mensagens (status_envio)
    WHERE direcao = 'out' AND status_envio = 'pendente';
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_chat99_conversas_status
    ON chat99_conversas (status);
  `);

  console.log('✅ [logistics] tabelas chat99 (conversas + mensagens) prontas');
}

module.exports = { initChat99Tables };
