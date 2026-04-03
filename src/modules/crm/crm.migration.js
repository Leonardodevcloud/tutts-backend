/**
 * crm.migration.js
 * Tabelas: crm_leads_capturados + crm_captura_jobs
 */

'use strict';

async function initCrmTables(pool) {
  const client = await pool.connect();
  try {
    // ── Tabela principal: leads capturados via Playwright ──────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_leads_capturados (
        id              SERIAL PRIMARY KEY,
        cod             VARCHAR(20) NOT NULL,
        nome            VARCHAR(255),
        telefones_raw   TEXT,
        celular         VARCHAR(30),
        telefone_fixo   VARCHAR(30),
        telefone_normalizado VARCHAR(20),
        email           VARCHAR(255),
        categoria       VARCHAR(100),
        data_cadastro   DATE,
        cidade          VARCHAR(100),
        estado          VARCHAR(5),
        regiao          VARCHAR(100),
        status_sistema  VARCHAR(20) DEFAULT 'desconhecido',
        status_api      VARCHAR(20),
        api_verificado_em TIMESTAMPTZ,
        capturado_em    TIMESTAMPTZ DEFAULT NOW(),
        job_id          INT,
        UNIQUE(cod)
      );
    `);

    // ── Tabela de jobs (execuções do agente) ──────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_captura_jobs (
        id                   SERIAL PRIMARY KEY,
        tipo                 VARCHAR(20) DEFAULT 'cron',
        status               VARCHAR(20) DEFAULT 'pendente',
        data_inicio          DATE,
        data_fim             DATE,
        total_capturados     INT DEFAULT 0,
        total_novos          INT DEFAULT 0,
        total_ja_existentes  INT DEFAULT 0,
        total_api_verificados INT DEFAULT 0,
        total_ativos         INT DEFAULT 0,
        total_inativos       INT DEFAULT 0,
        erro                 TEXT,
        screenshots          JSONB DEFAULT '[]',
        iniciado_em          TIMESTAMPTZ DEFAULT NOW(),
        concluido_em         TIMESTAMPTZ,
        iniciado_por         VARCHAR(50)
      );
    `);

    // ── Novas colunas (quem_ativou, observacao) ─────────────────
    const alterColumns = [
      "ALTER TABLE crm_leads_capturados ADD COLUMN IF NOT EXISTS quem_ativou VARCHAR(100)",
      "ALTER TABLE crm_leads_capturados ADD COLUMN IF NOT EXISTS observacao TEXT",
      "ALTER TABLE crm_leads_capturados ADD COLUMN IF NOT EXISTS data_ativacao DATE",
    ];
    for (const sql of alterColumns) {
      await client.query(sql).catch(() => {});
    }

    // ── Tabela de nomes de ativadores (dropdown) ──────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_ativadores (
        id    SERIAL PRIMARY KEY,
        nome  VARCHAR(100) NOT NULL UNIQUE
      );
    `);

    // ── Índices ───────────────────────────────────────────────────────
    const indices = [
      'CREATE INDEX IF NOT EXISTS idx_crm_leads_data_cadastro ON crm_leads_capturados(data_cadastro)',
      'CREATE INDEX IF NOT EXISTS idx_crm_leads_status_api ON crm_leads_capturados(status_api)',
      'CREATE INDEX IF NOT EXISTS idx_crm_leads_telefone_norm ON crm_leads_capturados(telefone_normalizado)',
      'CREATE INDEX IF NOT EXISTS idx_crm_leads_regiao ON crm_leads_capturados(regiao)',
      'CREATE INDEX IF NOT EXISTS idx_crm_jobs_status ON crm_captura_jobs(status)',
    ];
    for (const idx of indices) {
      await client.query(idx).catch(() => {});
    }

    console.log('✅ [CRM] Tabelas crm_leads_capturados + crm_captura_jobs prontas');
  } finally {
    client.release();
  }
}

module.exports = initCrmTables;
