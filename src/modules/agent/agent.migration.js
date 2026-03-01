/**
 * MÓDULO AGENTE RPA - Migration
 * Table: ajustes_automaticos
 *
 * Fila assíncrona para correção automática de endereços via Playwright.
 * Worker processa um registro por vez a cada 10s.
 */

async function initAgentTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajustes_automaticos (
      id            SERIAL PRIMARY KEY,
      os_numero     VARCHAR(20)    NOT NULL,
      ponto         INTEGER        NOT NULL CHECK (ponto >= 2 AND ponto <= 7),
      localizacao_raw TEXT,
      latitude      DECIMAL(10, 8),
      longitude     DECIMAL(11, 8),
      motoboy_lat   DECIMAL(10, 8),
      motoboy_lng   DECIMAL(11, 8),
      foto_fachada  TEXT,
      status        VARCHAR(20)    NOT NULL DEFAULT 'pendente'
                                   CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro')),
      detalhe_erro  TEXT,
      criado_em     TIMESTAMP      DEFAULT NOW(),
      processado_em TIMESTAMP,
      validado_por  VARCHAR(100),
      validado_em   TIMESTAMP
    )
  `);

  // Adicionar colunas se não existirem (deploy incremental)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE ajustes_automaticos ADD COLUMN IF NOT EXISTS motoboy_lat DECIMAL(10, 8);
      ALTER TABLE ajustes_automaticos ADD COLUMN IF NOT EXISTS motoboy_lng DECIMAL(11, 8);
      ALTER TABLE ajustes_automaticos ADD COLUMN IF NOT EXISTS foto_fachada TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ajustes_status_criado
      ON ajustes_automaticos(status, criado_em ASC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ajustes_os_numero
      ON ajustes_automaticos(os_numero)
  `);

  console.log('✅ Módulo Agente RPA — tabela ajustes_automaticos verificada/criada');
}

module.exports = initAgentTables;
