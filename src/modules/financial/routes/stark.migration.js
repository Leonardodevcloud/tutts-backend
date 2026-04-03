/**
 * STARK BANK - Migration
 * Tabelas: stark_lotes, stark_lote_itens, withdrawal_idempotency
 * Colunas adicionais em withdrawal_requests para integração Stark Bank
 */

async function initStarkTables(pool) {
  console.log('🏦 [Stark Migration] Iniciando...');

  // ==================== TABELA: stark_lotes ====================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stark_lotes (
      id SERIAL PRIMARY KEY,
      quantidade INTEGER NOT NULL DEFAULT 0,
      valor_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      saldo_antes DECIMAL(12,2),
      status VARCHAR(30) DEFAULT 'processando',
      erro TEXT,
      executado_por_id INTEGER,
      executado_por_nome VARCHAR(255),
      finalizado_em TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela stark_lotes verificada');

  // ==================== TABELA: stark_lote_itens ====================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stark_lote_itens (
      id SERIAL PRIMARY KEY,
      lote_id INTEGER NOT NULL REFERENCES stark_lotes(id),
      withdrawal_id INTEGER NOT NULL,
      stark_transfer_id VARCHAR(255),
      valor DECIMAL(10,2),
      status VARCHAR(30) DEFAULT 'pendente',
      erro TEXT,
      atualizado_em TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela stark_lote_itens verificada');

  // ==================== TABELA: withdrawal_idempotency ====================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_idempotency (
      id SERIAL PRIMARY KEY,
      idempotency_key VARCHAR(255) UNIQUE NOT NULL,
      withdrawal_id INTEGER NOT NULL,
      response_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela withdrawal_idempotency verificada');

  // ==================== COLUNAS STARK em withdrawal_requests ====================
  const colunas = [
    { nome: 'stark_status', tipo: "VARCHAR(30)" },
    { nome: 'stark_transfer_id', tipo: "VARCHAR(255)" },
    { nome: 'stark_lote_id', tipo: "INTEGER" },
    { nome: 'stark_erro', tipo: "TEXT" },
    { nome: 'stark_pago_em', tipo: "TIMESTAMP" },
    { nome: 'stark_enviado_em', tipo: "TIMESTAMP" },
    { nome: 'processing_lock', tipo: "TIMESTAMP" },
  ];

  for (const col of colunas) {
    await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS ${col.nome} ${col.tipo}`).catch(() => {});
  }
  console.log('✅ Colunas Stark em withdrawal_requests verificadas');

  // ==================== COLUNAS EXTRAS para acerto em stark_lotes ====================
  await pool.query(`ALTER TABLE stark_lotes ADD COLUMN IF NOT EXISTS tipo VARCHAR(30) DEFAULT 'saque'`).catch(() => {});
  console.log('✅ Coluna tipo em stark_lotes verificada');

  // ==================== COLUNAS EXTRAS para acerto em stark_lote_itens ====================
  const colunasAcerto = [
    { nome: 'cod_prof', tipo: "VARCHAR(50)" },
    { nome: 'nome_prof', tipo: "VARCHAR(255)" },
    { nome: 'pix_key', tipo: "VARCHAR(255)" },
    { nome: 'cpf', tipo: "VARCHAR(14)" },
  ];
  for (const col of colunasAcerto) {
    await pool.query(`ALTER TABLE stark_lote_itens ADD COLUMN IF NOT EXISTS ${col.nome} ${col.tipo}`).catch(() => {});
  }
  console.log('✅ Colunas acerto em stark_lote_itens verificadas');

  // ==================== ÍNDICES ====================
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_stark_status ON withdrawal_requests(stark_status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_stark_transfer_id ON withdrawal_requests(stark_transfer_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stark_lote_itens_lote ON stark_lote_itens(lote_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stark_lote_itens_transfer ON stark_lote_itens(stark_transfer_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_idempotency_key ON withdrawal_idempotency(idempotency_key)`).catch(() => {});
  console.log('✅ Índices Stark verificados');

  console.log('🏦 [Stark Migration] Concluída!');
}

module.exports = { initStarkTables };
