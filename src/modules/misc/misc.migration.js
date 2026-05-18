/**
 * MÓDULO MISC - Migration
 * Tables: foto_crash_logs
 * (Sistema de setores removido — 2026-05. A tabela `relatorios_diarios`
 *  é criada em misc.routes.js; não há mais segmentação por setor.)
 */

async function initMiscTables(pool) {
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
