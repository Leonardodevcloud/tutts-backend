/**
 * STARK BANK - Migration
 * Novas tabelas: stark_lotes, stark_lote_itens
 * Novas colunas em withdrawal_requests: stark_status, stark_transfer_id, stark_lote_id, stark_enviado_em, stark_pago_em, stark_erro
 */

async function initStarkTables(pool) {
  console.log('🏦 [Stark Bank] Iniciando migrations...');

  // ==================== COLUNAS EM WITHDRAWAL_REQUESTS ====================

  // Status do pagamento na Stark Bank
  await pool.query(`
    ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS stark_status VARCHAR(30)
  `).catch(() => {});

  // ID da transfer criada na Stark Bank
  await pool.query(`
    ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS stark_transfer_id VARCHAR(100)
  `).catch(() => {});

  // ID do lote ao qual este saque pertence
  await pool.query(`
    ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS stark_lote_id INTEGER
  `).catch(() => {});

  // Quando o pagamento foi enviado para a Stark Bank
  await pool.query(`
    ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS stark_enviado_em TIMESTAMP
  `).catch(() => {});

  // Quando o pagamento foi confirmado pela Stark Bank
  await pool.query(`
    ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS stark_pago_em TIMESTAMP
  `).catch(() => {});

  // Mensagem de erro da Stark Bank (se houver)
  await pool.query(`
    ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS stark_erro TEXT
  `).catch(() => {});

  console.log('✅ [Stark Bank] Colunas em withdrawal_requests verificadas');

  // ==================== TABELA DE LOTES ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stark_lotes (
      id SERIAL PRIMARY KEY,
      quantidade INTEGER NOT NULL DEFAULT 0,
      valor_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      saldo_antes DECIMAL(12,2),
      status VARCHAR(30) NOT NULL DEFAULT 'pendente',
      erro TEXT,
      executado_por_id INTEGER,
      executado_por_nome VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      finalizado_em TIMESTAMP
    )
  `);
  console.log('✅ [Stark Bank] Tabela stark_lotes verificada');

  // ==================== TABELA DE ITENS DO LOTE ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stark_lote_itens (
      id SERIAL PRIMARY KEY,
      lote_id INTEGER NOT NULL REFERENCES stark_lotes(id),
      withdrawal_id INTEGER NOT NULL REFERENCES withdrawal_requests(id),
      stark_transfer_id VARCHAR(100),
      valor DECIMAL(10,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pendente',
      erro TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP
    )
  `);
  console.log('✅ [Stark Bank] Tabela stark_lote_itens verificada');

  // ==================== ÍNDICES ====================

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_stark_status ON withdrawal_requests(stark_status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_stark_transfer ON withdrawal_requests(stark_transfer_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_stark_lote ON withdrawal_requests(stark_lote_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stark_lote_itens_lote ON stark_lote_itens(lote_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stark_lote_itens_transfer ON stark_lote_itens(stark_transfer_id)`).catch(() => {});

  console.log('✅ [Stark Bank] Índices verificados');
  console.log('🏦 [Stark Bank] Migrations concluídas');
}

module.exports = { initStarkTables };
