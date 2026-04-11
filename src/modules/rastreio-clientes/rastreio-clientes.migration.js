'use strict';

/**
 * rastreio-clientes.migration.js
 * Cria tabela rastreio_clientes_config + seed inicial 814/767.
 */

async function initRastreioClientesTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rastreio_clientes_config (
      id SERIAL PRIMARY KEY,
      cliente_cod VARCHAR(10) UNIQUE NOT NULL,
      nome_exibicao VARCHAR(100) NOT NULL,
      ativo BOOLEAN DEFAULT TRUE,
      evolution_group_id VARCHAR(120) NOT NULL,
      termos_filtro TEXT[],
      observacoes TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rcc_ativo ON rastreio_clientes_config(ativo);`);

  // Seed: insere 814 e 767 se a tabela estiver vazia
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM rastreio_clientes_config');
  if (rows[0].n === 0) {
    const grp814 = process.env.EVOLUTION_GROUP_ID_814 || '';
    const grp767 = process.env.EVOLUTION_GROUP_ID_767 || grp814;
    await pool.query(
      `INSERT INTO rastreio_clientes_config
        (cliente_cod, nome_exibicao, ativo, evolution_group_id, termos_filtro, observacoes)
       VALUES
        ($1,'Cobra Center (814)',TRUE,$2,NULL,'Sem filtro - todas as OS deste cliente'),
        ($3,'Comollati Porto Seco (767)',TRUE,$4,$5,'Filtro discriminativo de endereço')`,
      ['814', grp814, '767', grp767, ['GALBA','NOVAS DE CASTRO','57061-510']]
    );
    console.log('[rastreio-clientes] seed 814/767 inserido');
  }
}

module.exports = initRastreioClientesTables;
