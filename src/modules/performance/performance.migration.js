/**
 * MÓDULO PERFORMANCE DIÁRIA - Migration
 * Tabelas: performance_snapshots, performance_jobs
 */

async function initPerformanceTables(pool) {
  // Snapshots de SLA — cada execução do Playwright grava aqui
  await pool.query(`
    CREATE TABLE IF NOT EXISTS performance_snapshots (
      id            SERIAL PRIMARY KEY,
      job_id        INTEGER,                      -- referência ao job que gerou
      data_inicio   DATE NOT NULL,
      data_fim      DATE NOT NULL,
      cod_cliente   INTEGER,
      centro_custo  VARCHAR(255),
      total_os      INTEGER NOT NULL DEFAULT 0,
      no_prazo      INTEGER NOT NULL DEFAULT 0,
      fora_prazo    INTEGER NOT NULL DEFAULT 0,
      sem_dados     INTEGER NOT NULL DEFAULT 0,
      pct_no_prazo  DECIMAL(5,2),
      registros     JSONB NOT NULL DEFAULT '[]',  -- array com cada OS calculada
      criado_em     TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela performance_snapshots verificada');

  // Jobs de execução — rastreia cada rodada do playwright
  await pool.query(`
    CREATE TABLE IF NOT EXISTS performance_jobs (
      id            SERIAL PRIMARY KEY,
      status        VARCHAR(20) NOT NULL DEFAULT 'pendente',
      -- pendente | executando | concluido | erro
      data_inicio   DATE NOT NULL,
      data_fim      DATE NOT NULL,
      cod_cliente   INTEGER,
      centro_custo  VARCHAR(255),
      iniciado_em   TIMESTAMP DEFAULT NOW(),
      concluido_em  TIMESTAMP,
      erro          TEXT,
      total_os      INTEGER,
      origem        VARCHAR(20) DEFAULT 'cron'   -- 'cron' | 'manual'
    )
  `);
  console.log('✅ Tabela performance_jobs verificada');

  // Índices
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_perf_snapshots_data
      ON performance_snapshots(data_inicio, data_fim);
    CREATE INDEX IF NOT EXISTS idx_perf_snapshots_cliente
      ON performance_snapshots(cod_cliente);
    CREATE INDEX IF NOT EXISTS idx_perf_jobs_status
      ON performance_jobs(status);
  `);
  console.log('✅ Índices performance verificados');
}

module.exports = initPerformanceTables;
