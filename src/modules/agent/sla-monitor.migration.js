/**
 * sla-monitor.migration.js
 * Tabelas do SLA Monitor server-side — substitui o cálculo de SLA que a
 * extensão Chrome v8 fazia no browser do operador.
 *
 * FLUXO:
 *   1. sla-detector.agent (cron 2min) coleta OS em execução + km via modal
 *   2. sla-monitor.service faz UPSERT em sla_monitor_snapshot
 *   3. OS que sumiram da tela → em_execucao=false (finalizadas)
 *   4. GET /api/agent/sla-monitor/status calcula status em tempo de leitura
 *      (deadline vs NOW()) e serve pra extensão v9 (thin client) e frontend
 *
 * TABELAS:
 *   sla_monitor_snapshot     — estado atual + histórico de cada OS
 *   sla_monitor_prazos_km    — faixas de km → prazo em minutos (config viva)
 *   sla_monitor_prazos_fixos — prazo fixo por cliente (ex: 767 = 120min)
 */

'use strict';

// Tabela de prazos por km — herdada da extensão SLA Monitor v8 (seed inicial).
// Depois do seed, a fonte da verdade é o BANCO (editável sem deploy).
const SEED_PRAZOS_KM = [
  [0, 10, 60], [10, 15, 75], [15, 20, 90], [20, 25, 105], [25, 30, 120],
  [30, 35, 135], [35, 40, 150], [40, 45, 165], [45, 50, 180], [50, 55, 195],
  [55, 60, 210], [60, 65, 225], [65, 70, 240], [70, 75, 255], [75, 80, 270],
];

// Prazos fixos por cliente — herdado de CLIENTES_PRAZO_FIXO da extensão
const SEED_PRAZOS_FIXOS = [
  ['767', 120],
];

async function initSlaMonitorTables(pool) {
  // ── Snapshot ─────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_monitor_snapshot (
      id                  SERIAL PRIMARY KEY,
      os_numero           VARCHAR(20) NOT NULL UNIQUE,
      cliente_cod         VARCHAR(10),
      cliente_nome        VARCHAR(255),
      cod_profissional    VARCHAR(20),
      nome_profissional   VARCHAR(255),
      cod_rastreio        VARCHAR(64),
      link_rastreio       TEXT,

      horario_inicio_raw  VARCHAR(40),
      horario_inicio      TIMESTAMPTZ,

      distancia_km        NUMERIC(8,2),
      prazo_min           INT,
      prazo_origem        VARCHAR(10),        -- 'fixo' | 'km' | NULL (sem dados)
      deadline            TIMESTAMPTZ,

      retorno             BOOLEAN NOT NULL DEFAULT FALSE,
      retorno_motivo      TEXT,

      em_execucao         BOOLEAN NOT NULL DEFAULT TRUE,
      primeira_vista_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ultima_vista_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalizada_em       TIMESTAMPTZ,
      atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Índice principal: leitura do painel (só OS em execução)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sla_snapshot_em_execucao
    ON sla_monitor_snapshot (em_execucao, deadline)
    WHERE em_execucao = TRUE;
  `);

  // 🆕 2026-07 v2.2: situação da OS na tela do MAP
  //   'em_execucao'      — tem profissional, corrida rodando
  //   'sem_profissional' — aguardando atribuição (relógio do SLA já corre!)
  await pool.query(`
    ALTER TABLE sla_monitor_snapshot
    ADD COLUMN IF NOT EXISTS situacao VARCHAR(20) NOT NULL DEFAULT 'em_execucao';
  `);

  // 🆕 2026-07 v2.3: centro de custo (do bi_entregas, por OS) — clientes
  // multi-centro (767 Comollati, 814 Cobra) são exibidos por centro,
  // espelhando o módulo de performance diária
  await pool.query(`
    ALTER TABLE sla_monitor_snapshot
    ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(255);
  `);

  // Histórico de compliance por cliente (relatórios BI futuros)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sla_snapshot_cliente_criado
    ON sla_monitor_snapshot (cliente_cod, primeira_vista_em DESC);
  `);

  // ── Prazos por km ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_monitor_prazos_km (
      id         SERIAL PRIMARY KEY,
      km_de      NUMERIC(8,2) NOT NULL,
      km_ate     NUMERIC(8,2) NOT NULL,
      prazo_min  INT NOT NULL,
      UNIQUE (km_de, km_ate)
    );
  `);

  // ── Prazos fixos por cliente ─────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_monitor_prazos_fixos (
      id           SERIAL PRIMARY KEY,
      cliente_cod  VARCHAR(10) NOT NULL UNIQUE,
      prazo_min    INT NOT NULL,
      ativo        BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  // ── Seed (só se tabelas vazias — nunca sobrescreve edição manual) ───────
  const { rows: [{ count: countKm }] } =
    await pool.query('SELECT COUNT(*)::int AS count FROM sla_monitor_prazos_km');
  if (countKm === 0) {
    for (const [de, ate, prazo] of SEED_PRAZOS_KM) {
      await pool.query(
        `INSERT INTO sla_monitor_prazos_km (km_de, km_ate, prazo_min)
         VALUES ($1, $2, $3) ON CONFLICT (km_de, km_ate) DO NOTHING`,
        [de, ate, prazo]
      );
    }
    console.log(`✅ sla_monitor_prazos_km: seed com ${SEED_PRAZOS_KM.length} faixas`);
  }

  const { rows: [{ count: countFixo }] } =
    await pool.query('SELECT COUNT(*)::int AS count FROM sla_monitor_prazos_fixos');
  if (countFixo === 0) {
    for (const [cod, prazo] of SEED_PRAZOS_FIXOS) {
      await pool.query(
        `INSERT INTO sla_monitor_prazos_fixos (cliente_cod, prazo_min)
         VALUES ($1, $2) ON CONFLICT (cliente_cod) DO NOTHING`,
        [cod, prazo]
      );
    }
    console.log(`✅ sla_monitor_prazos_fixos: seed com ${SEED_PRAZOS_FIXOS.length} clientes`);
  }

  // 🆕 2026-07 v2.5: mapeamento endereço → centro de custo (mesmo padrão
  // dos filtros do rastreio-clientes: se o texto da linha contém o TERMO,
  // a OS recebe o CENTRO). Caminho primário — determinístico, sem HTTP extra.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_monitor_centros_termos (
      id           SERIAL PRIMARY KEY,
      cliente_cod  VARCHAR(10)  NOT NULL,
      termo        VARCHAR(255) NOT NULL,
      centro_nome  VARCHAR(255) NOT NULL,
      ativo        BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (cliente_cod, termo)
    );
  `);

  console.log('✅ Tabelas sla_monitor_* verificadas/criadas');
}

module.exports = initSlaMonitorTables;
