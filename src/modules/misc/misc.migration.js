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

    // ===== TELEMETRIA: foto_crash_logs =====
    // 2026-04: registra eventos de PWA fechando durante processamento de foto
    // (OOM kill em mobile fraco). Frontend marca localStorage.imgUtils.lastStartedAt
    // antes de processar; ao reabrir, se a marca ainda existe e é recente, reporta
    // aqui. Permite descobrir quais aparelhos crasham e ajustar limites.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS foto_crash_logs (
        id SERIAL PRIMARY KEY,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        when_iso TEXT,
        idade_ms BIGINT,
        file_size BIGINT,
        file_type TEXT,
        device_memory NUMERIC,
        user_agent TEXT,
        platform TEXT,
        ip TEXT
      )
    `).catch(() => {});
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_foto_crash_logs_criado_em
      ON foto_crash_logs(criado_em DESC)
    `).catch(() => {});
    console.log('✅ Tabela foto_crash_logs verificada/criada');

    // NOTA: Social e Operacional são inicializados separadamente em server.js
}

module.exports = { initMiscTables };
