/**
 * MÓDULO GARANTIDO - Migration
 * - Colunas de config no filas_centrais (por central, idempotente).
 * - Tabela garantido_valores_especiais (valor base custom por motoboy/central).
 * - Tabela garantido_registros (1 linha por motoboy/central/dia — trava no 1º ingresso).
 */

async function initGarantidoTables(pool) {
  // Config por central (na própria filas_centrais — serve fila tradicional E auto)
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS garantido_ativo        BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS garantido_valor_padrao NUMERIC(10,2) DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS garantido_hora_inicio  TIME DEFAULT '08:00'`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS garantido_hora_fim     TIME DEFAULT '17:00'`).catch(() => {});
  console.log('✅ Colunas de garantido em filas_centrais verificadas');

  // Valores especiais por motoboy (sobrepõem o valor padrão da central)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS garantido_valores_especiais (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      valor NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, cod_profissional)
    )
  `);
  console.log('✅ Tabela garantido_valores_especiais verificada');

  // Registro diário — trava no 1º ingresso do dia. Retorno de rota não altera.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS garantido_registros (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      data_ref DATE NOT NULL,
      hora_ingresso TIMESTAMP DEFAULT NOW(),
      valor_base NUMERIC(10,2) NOT NULL DEFAULT 0,
      fracao NUMERIC(7,5) NOT NULL DEFAULT 1,
      minutos_atraso INTEGER NOT NULL DEFAULT 0,
      valor_garantido NUMERIC(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, cod_profissional, data_ref)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_garantido_registros_central_data ON garantido_registros(central_id, data_ref)`).catch(() => {});
  console.log('✅ Tabela garantido_registros verificada');
}

module.exports = { initGarantidoTables };
