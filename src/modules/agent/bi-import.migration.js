/**
 * bi-import.migration.js
 * Tabela bi_imports — fila de jobs do agente BI Import.
 *
 * Pipeline:
 *  pendente → processando → (sucesso | falhou)
 *
 * Cron 10h diário pega job pendente do dia (origem='cron'),
 *  ou roda quando admin clica "Importar agora" (origem='manual').
 */

'use strict';

async function initBiImportTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bi_imports (
      id              SERIAL PRIMARY KEY,
      data_referencia DATE NOT NULL,                -- dia que será importado (D-1 normalmente)
      origem          VARCHAR(20) NOT NULL DEFAULT 'manual',  -- 'manual' | 'cron'
      status          VARCHAR(20) NOT NULL DEFAULT 'pendente',
      etapa_atual     VARCHAR(50),
      progresso       SMALLINT DEFAULT 0,
      total_linhas    INTEGER,
      linhas_inseridas INTEGER,
      linhas_ignoradas INTEGER,
      erro            TEXT,
      screenshot_path TEXT,
      arquivo_path    TEXT,
      usuario_id      INTEGER,
      usuario_nome    VARCHAR(200),
      criado_em       TIMESTAMP DEFAULT NOW(),
      finalizado_em   TIMESTAMP
    )
  `);

  // CHECK constraint
  try {
    await pool.query(`ALTER TABLE bi_imports DROP CONSTRAINT IF EXISTS bi_imports_status_check`);
    await pool.query(`
      ALTER TABLE bi_imports
      ADD CONSTRAINT bi_imports_status_check
      CHECK (status IN ('pendente', 'processando', 'sucesso', 'falhou'))
    `);
  } catch (err) {
    console.log(`⚠️ Constraint status bi_imports: ${err.message}`);
  }

  // Idempotência do cron: 1 job por dia/origem
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bi_imports_cron_unique
        ON bi_imports(data_referencia, origem)
        WHERE origem = 'cron' AND status IN ('pendente', 'processando', 'sucesso')
    `);
  } catch (err) {
    console.log(`⚠️ Índice unique cron: ${err.message}`);
  }

  for (const idx of [
    'CREATE INDEX IF NOT EXISTS idx_bi_imports_status_criado ON bi_imports(status, criado_em ASC)',
    'CREATE INDEX IF NOT EXISTS idx_bi_imports_data_ref ON bi_imports(data_referencia DESC)',
  ]) {
    try { await pool.query(idx); } catch (err) { console.log(`⚠️ ${err.message}`); }
  }

  console.log('✅ Módulo BI Import — tabela bi_imports verificada/criada');
}

module.exports = initBiImportTables;
