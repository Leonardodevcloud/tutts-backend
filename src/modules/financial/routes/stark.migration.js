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

  // ==================== MIGRATIONS ACERTO PROFISSIONAL ====================

  // Coluna tipo no lote (saque ou acerto)
  await pool.query(`ALTER TABLE stark_lotes ADD COLUMN IF NOT EXISTS tipo VARCHAR(30) DEFAULT 'saque'`).catch(() => {});

  // Colunas extras em stark_lote_itens para acerto (sem withdrawal_id)
  await pool.query(`ALTER TABLE stark_lote_itens ALTER COLUMN withdrawal_id DROP NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE stark_lote_itens ADD COLUMN IF NOT EXISTS cod_prof VARCHAR(50)`).catch(() => {});
  await pool.query(`ALTER TABLE stark_lote_itens ADD COLUMN IF NOT EXISTS nome_prof VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE stark_lote_itens ADD COLUMN IF NOT EXISTS pix_key VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE stark_lote_itens ADD COLUMN IF NOT EXISTS cpf VARCHAR(20)`).catch(() => {});

  console.log('✅ [Stark Bank] Colunas de acerto profissional verificadas');

  // ==================== TABELA DE VALIDAÇÕES PIX (CACHE DICT) ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pix_validacoes (
      id SERIAL PRIMARY KEY,
      cod_prof VARCHAR(50) NOT NULL,
      pix_key VARCHAR(255) NOT NULL,
      pix_key_normalizada VARCHAR(255),
      pix_tipo VARCHAR(30),
      dict_valido BOOLEAN NOT NULL DEFAULT false,
      dict_nome VARCHAR(255),
      dict_cpf_cnpj VARCHAR(20),
      dict_banco VARCHAR(255),
      dict_tipo_conta VARCHAR(50),
      dict_erro TEXT,
      validado_em TIMESTAMP DEFAULT NOW(),
      validado_por_id INTEGER,
      validado_por_nome VARCHAR(255)
    )
  `);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pix_validacoes_cod_key ON pix_validacoes(cod_prof, pix_key)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pix_validacoes_cod ON pix_validacoes(cod_prof)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pix_validacoes_key ON pix_validacoes(pix_key)`).catch(() => {});

  console.log('✅ [Stark Bank] Tabela pix_validacoes verificada');

  console.log('🏦 [Stark Bank] Migrations concluídas');
}

module.exports = { initStarkTables };
