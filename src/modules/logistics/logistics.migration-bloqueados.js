'use strict';

/**
 * Migration — Ocorrencias + Bloqueio de entregadores (blacklist do Hub)
 * ---------------------------------------------------------------------
 * Cria duas tabelas:
 *
 *  1. logistics_ocorrencias — registro (log) de toda ocorrencia reportada
 *     por um operador contra um entregador numa corrida. Texto livre.
 *     Nunca e apagada — e o historico.
 *
 *  2. logistics_couriers_bloqueados — a BLACKLIST propriamente dita. Um
 *     entregador barrado. O casamento e por telefone (normalizado, so
 *     digitos) OU placa (normalizada, upper sem espaco/traco). Como a
 *     99/Uber nao dao ID fixo, esses dois campos sao a nossa "identidade".
 *     ativo=false = desbloqueado (mantido pra historico, nao deletado).
 *
 * Idempotente: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
 */
async function initLogisticsBloqueadosTables(pool) {
  // ── 1. Log de ocorrencias ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_ocorrencias (
      id               SERIAL PRIMARY KEY,
      codigo_os        INTEGER,
      delivery_id      INTEGER,
      provider_code    VARCHAR(40),
      courier_nome     VARCHAR(255),
      courier_telefone VARCHAR(40),
      courier_placa    VARCHAR(40),
      descricao        TEXT NOT NULL,
      bloqueou         BOOLEAN DEFAULT false,
      reportado_por    VARCHAR(255),
      criado_em        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_log_ocorr_os ON logistics_ocorrencias (codigo_os)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_log_ocorr_tel ON logistics_ocorrencias (courier_telefone)`).catch(() => {});

  // ── 2. Blacklist de entregadores ─────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_couriers_bloqueados (
      id                SERIAL PRIMARY KEY,
      telefone_norm     VARCHAR(40),
      placa_norm        VARCHAR(40),
      nome              VARCHAR(255),
      provider_code     VARCHAR(40),
      motivo            TEXT,
      bloqueado_por     VARCHAR(255),
      ativo             BOOLEAN DEFAULT true,
      reatribuicoes     INTEGER DEFAULT 0,
      ultima_ocorrencia_id INTEGER,
      criado_em         TIMESTAMPTZ DEFAULT NOW(),
      desbloqueado_em   TIMESTAMPTZ,
      desbloqueado_por  VARCHAR(255)
    )
  `);
  // Indices de casamento (telefone/placa) — so entram na busca os ativos,
  // mas o indice cobre a coluna toda (filtro ativo=true fica na query).
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_log_bloq_tel ON logistics_couriers_bloqueados (telefone_norm) WHERE ativo = true`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_log_bloq_placa ON logistics_couriers_bloqueados (placa_norm) WHERE ativo = true`).catch(() => {});

  console.log('✅ [logistics] tabelas de ocorrencias + bloqueados verificadas');
}

module.exports = { initLogisticsBloqueadosTables };
