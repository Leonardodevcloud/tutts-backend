/**
 * sla-capture.migration.js
 * Tabela sla_capturas — fila de OS detectadas pela extensão SLA Monitor
 * pra captura de pontos via Playwright e envio de rastreio no WhatsApp.
 *
 * Fluxo:
 *   1. Extensão detecta OS nova do 814/767 → POST trigger
 *   2. Insere registro status='pendente' (UNIQUE os_numero impede duplicata)
 *   3. Worker poll cada 5s, pega pendente com proximo_retry_em <= NOW()
 *   4. Playwright fetch AJAX modal → parseia pontos → envia Evolution
 *   5. Marca 'enviado' ou re-enfileira com backoff (até 3 tentativas) → 'falhou'
 */

'use strict';

async function initSlaCaptureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_capturas (
      id                SERIAL PRIMARY KEY,
      os_numero         VARCHAR(20) NOT NULL UNIQUE,
      cliente_cod       VARCHAR(10) NOT NULL,
      cod_rastreio      VARCHAR(64),
      link_rastreio     TEXT,
      profissional      VARCHAR(255),
      status            VARCHAR(20) NOT NULL DEFAULT 'pendente',
      tentativas        INT NOT NULL DEFAULT 0,
      erro              TEXT,
      pontos_json       JSONB,
      mensagem_enviada  TEXT,
      origem_ip         VARCHAR(64),
      criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      proximo_retry_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      enviado_em        TIMESTAMPTZ
    );
  `);

  // Índice pra busca do worker
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sla_capturas_pendentes
    ON sla_capturas (status, proximo_retry_em)
    WHERE status IN ('pendente', 'processando');
  `);

  // Índice pra histórico por cliente
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sla_capturas_cliente_criado
    ON sla_capturas (cliente_cod, criado_em DESC);
  `);

  console.log('✅ Tabela sla_capturas verificada/criada');
}

module.exports = initSlaCaptureTables;
