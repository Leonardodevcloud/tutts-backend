'use strict';

/**
 * clientes-bloqueados.migration.js (2026-07)
 * ─────────────────────────────────────────────────────────────
 * Clientes cujas corridas NAO sofrem ajuste de localizacao.
 * Quando o agente le o Ponto 1 da OS e o texto bate com um cliente
 * ativo desta lista, a correcao e BARRADA (status 'bloqueado_cliente').
 *
 * Tabelas:
 *   - clientes_bloqueados_ajuste : lista (nome_loja + endereco)
 *   - ajuste_bloqueio_config     : single-row com o numero de suporte (WhatsApp)
 *
 * Também estende ajustes_automaticos:
 *   - coluna bloqueio_loja
 *   - status 'bloqueado_cliente' no CHECK
 */
async function initClientesBloqueadosTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes_bloqueados_ajuste (
      id         SERIAL PRIMARY KEY,
      nome_loja  VARCHAR(255) NOT NULL,
      endereco   TEXT         NOT NULL,
      ativo      BOOLEAN      NOT NULL DEFAULT true,
      criado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      criado_por VARCHAR(255)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_clientes_bloqueados_ativo ON clientes_bloqueados_ajuste(ativo)`
  ).catch(() => {});

  // Config single-row: numero de suporte (WhatsApp) — editavel pelo admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajuste_bloqueio_config (
      id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      numero_suporte VARCHAR(30)
    )
  `);
  await pool.query(`
    INSERT INTO ajuste_bloqueio_config (id, numero_suporte)
    VALUES (1, '557189260372')
    ON CONFLICT (id) DO NOTHING
  `).catch(() => {});

  // ajustes_automaticos: coluna + novo status
  await pool.query(
    `ALTER TABLE ajustes_automaticos ADD COLUMN IF NOT EXISTS bloqueio_loja VARCHAR(255)`
  ).catch(() => {});

  try {
    await pool.query(`ALTER TABLE ajustes_automaticos DROP CONSTRAINT IF EXISTS ajustes_automaticos_status_check`);
    await pool.query(`
      ALTER TABLE ajustes_automaticos
      ADD CONSTRAINT ajustes_automaticos_status_check
      CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro', 'falhou', 'bloqueado_cliente'))
    `);
  } catch (e) {
    console.log(`⚠️ Constraint status (bloqueado_cliente): ${e.message}`);
  }

  console.log('✅ Tabelas clientes_bloqueados_ajuste / ajuste_bloqueio_config verificadas');
}

module.exports = initClientesBloqueadosTables;
