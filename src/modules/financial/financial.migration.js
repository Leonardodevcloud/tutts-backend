/**
 * MÓDULO FINANCIAL - Migration
 * 5 tabelas: user_financial_data, financial_logs, withdrawal_requests, gratuities, restricted_professionals
 */

async function initFinancialTables(pool) {
    // Tabela de dados financeiros do usuário
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_financial_data (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        cpf VARCHAR(14) NOT NULL,
        pix_key VARCHAR(255) NOT NULL,
        pix_tipo VARCHAR(20) DEFAULT 'cpf',
        terms_accepted BOOLEAN DEFAULT FALSE,
        terms_accepted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela user_financial_data verificada');
    
    // Adicionar coluna pix_tipo se não existir
    await pool.query(`
      ALTER TABLE user_financial_data ADD COLUMN IF NOT EXISTS pix_tipo VARCHAR(20) DEFAULT 'cpf'
    `).catch(() => {});

    // Tabela de logs de alterações financeiras
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_logs (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela financial_logs verificada');

    // Tabela de solicitações de saque
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        cpf VARCHAR(14) NOT NULL,
        pix_key VARCHAR(255) NOT NULL,
        requested_amount DECIMAL(10,2) NOT NULL,
        fee_amount DECIMAL(10,2) DEFAULT 0,
        final_amount DECIMAL(10,2) NOT NULL,
        has_gratuity BOOLEAN DEFAULT FALSE,
        gratuity_id INTEGER,
        status VARCHAR(50) DEFAULT 'aguardando_aprovacao',
        admin_id INTEGER,
        admin_name VARCHAR(255),
        conciliacao_omie BOOLEAN DEFAULT FALSE,
        debito BOOLEAN DEFAULT FALSE,
        approved_at TIMESTAMP,
        saldo_status VARCHAR(20),
        reject_reason VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela withdrawal_requests verificada');

    // Garantir que a coluna admin_name existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS admin_name VARCHAR(255)`);
      console.log('✅ Coluna admin_name verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna reject_reason existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reject_reason TEXT`);
      console.log('✅ Coluna reject_reason verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna debito_at existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS debito_at TIMESTAMP`);
      console.log('✅ Coluna debito_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna debito_plific_at existe (data do débito na Plific)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS debito_plific_at TIMESTAMP`);
      console.log('✅ Coluna debito_plific_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna approved_at existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
      console.log('✅ Coluna approved_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna saldo_status existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS saldo_status VARCHAR(20)`);
      console.log('✅ Coluna saldo_status verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna lancamento_at existe (migração) - data/hora da aprovação
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS lancamento_at TIMESTAMP`);
      console.log('✅ Coluna lancamento_at verificada');
      
      // Preencher retroativamente lancamento_at para registros aprovados que não têm essa data
      const resultado = await pool.query(`
        UPDATE withdrawal_requests 
        SET lancamento_at = COALESCE(approved_at, updated_at, created_at)
        WHERE status IN ('aprovado', 'aprovado_gratuidade') 
        AND lancamento_at IS NULL
      `);
      if (resultado.rowCount > 0) {
        console.log(`✅ lancamento_at preenchido retroativamente para ${resultado.rowCount} registros`);
      }
    } catch (e) {
      // Coluna já existe ou outro erro
      console.log('⚠️ Erro na migração lancamento_at:', e.message);
    }

    // ==================== ÍNDICES PARA PERFORMANCE ====================
    console.log('🔧 Criando índices de performance para withdrawal_requests...');
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_status ON withdrawal_requests(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_user_cod ON withdrawal_requests(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_created_at ON withdrawal_requests(created_at DESC)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_conciliacao ON withdrawal_requests(conciliacao_omie, debito)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdrawal_status_created ON withdrawal_requests(status, created_at DESC)`).catch(() => {});
    
    // Índices para gratuities
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gratuities_user_cod ON gratuities(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gratuities_status ON gratuities(status)`).catch(() => {});
    
    // Índices para restricted_professionals
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_restricted_user_cod ON restricted_professionals(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_restricted_status ON restricted_professionals(status)`).catch(() => {});
    
    console.log('✅ Índices de performance criados/verificados');
    // ==================== FIM ÍNDICES ====================

    try {
      console.log('✅ Coluna endereco_completo verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Tabela de gratuidades
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gratuities (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        quantity INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        value DECIMAL(10,2) NOT NULL,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'ativa',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        expired_at TIMESTAMP
      )
    `);
    console.log('✅ Tabela gratuities verificada');
    
    // Migração: adicionar colunas user_name e created_by em gratuities
    await pool.query(`ALTER TABLE gratuities ADD COLUMN IF NOT EXISTS user_name VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE gratuities ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`).catch(() => {});

    // Tabela de profissionais restritos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS restricted_professionals (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        user_name VARCHAR(255),
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'ativo',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        removed_at TIMESTAMP,
        removed_reason TEXT
      )
    `);
    console.log('✅ Tabela restricted_professionals verificada');

    // Migração: adicionar colunas em restricted_professionals
    await pool.query(`ALTER TABLE restricted_professionals ADD COLUMN IF NOT EXISTS user_name VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE restricted_professionals ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`).catch(() => {});

}

module.exports = { initFinancialTables };
