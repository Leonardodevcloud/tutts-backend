/**
 * MÓDULO MISC - Migration
 * Tables: setores, relatorios_diarios, relatorios_visualizacoes
 */

async function initMiscTables(pool) {
    // ===== SISTEMA DE SETORES =====
    // Tabela de setores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS setores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        descricao TEXT,
        cor VARCHAR(20) DEFAULT '#6366f1',
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela setores criada');
    
    // Adicionar coluna setor_id na tabela users
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS setor_id INTEGER REFERENCES setores(id)`).catch(() => {});
    console.log('✅ Coluna setor_id adicionada à tabela users');
    
    // Adicionar coluna setores_destino na tabela relatorios_diarios
    await pool.query(`ALTER TABLE relatorios_diarios ADD COLUMN IF NOT EXISTS setores_destino INTEGER[] DEFAULT '{}'`).catch(() => {});
    await pool.query(`ALTER TABLE relatorios_diarios ADD COLUMN IF NOT EXISTS para_todos BOOLEAN DEFAULT true`).catch(() => {});
    console.log('✅ Colunas setores_destino e para_todos adicionadas à tabela relatorios_diarios');

    // ==================== MÓDULO SOCIAL (EXTRAÍDO) ====================
    await initSocialTables(pool);

    // ==================== MÓDULO OPERACIONAL (EXTRAÍDO) ====================
    await initOperacionalTables(pool);
}

module.exports = { initMiscTables };
