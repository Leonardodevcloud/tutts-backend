/**
 * MÓDULO GERENCIAL - Migrations
 * Tabela de configuração dos grupos de SLA
 */
async function initGerencialTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gerencial_sla_grupos (
      id SERIAL PRIMARY KEY,
      grupo VARCHAR(50) NOT NULL,
      cod_cliente INTEGER NOT NULL,
      centro_custo VARCHAR(255) DEFAULT '',
      nome_display VARCHAR(255),
      criado_por VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(grupo, cod_cliente, centro_custo)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ger_sla_grupo ON gerencial_sla_grupos(grupo)`).catch(function(){});
  console.log('✅ Tabela gerencial_sla_grupos verificada');
}

module.exports = { initGerencialTables };
