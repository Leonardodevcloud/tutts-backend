/**
 * MÓDULO FILAS - Migration
 * Tabelas: filas_centrais, filas_vinculos, filas_posicoes, filas_historico, filas_notificacoes
 */

async function initFilasTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_centrais (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      endereco TEXT,
      latitude DECIMAL(10,7),
      longitude DECIMAL(10,7),
      raio_metros INTEGER DEFAULT 900,
      ativa BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_centrais verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_vinculos (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) UNIQUE NOT NULL,
      nome_profissional VARCHAR(255),
      ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_vinculos verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_posicoes (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      status VARCHAR(20) DEFAULT 'aguardando',
      posicao INTEGER,
      entrada_fila_at TIMESTAMP DEFAULT NOW(),
      saida_rota_at TIMESTAMP,
      retorno_at TIMESTAMP,
      latitude_checkin DECIMAL(10,7),
      longitude_checkin DECIMAL(10,7),
      corrida_unica BOOLEAN DEFAULT false,
      posicao_original INTEGER,
      motivo_posicao VARCHAR(50),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_posicoes verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_historico (
      id SERIAL PRIMARY KEY,
      central_id INTEGER,
      central_nome VARCHAR(255),
      cod_profissional VARCHAR(50),
      nome_profissional VARCHAR(255),
      acao VARCHAR(50),
      tempo_espera_minutos INTEGER,
      tempo_rota_minutos INTEGER,
      observacao TEXT,
      admin_cod VARCHAR(50),
      admin_nome VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_historico verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_notificacoes (
      id SERIAL PRIMARY KEY,
      cod_profissional VARCHAR(50) UNIQUE NOT NULL,
      tipo VARCHAR(50),
      mensagem TEXT,
      dados JSONB,
      lida BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_notificacoes verificada');

  // 🔧 Coluna notas_liberadas para despacho gradativo
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS notas_liberadas INTEGER DEFAULT 0`).catch(() => {});
  console.log('✅ Coluna notas_liberadas verificada');

  // 🗺️ Bairros: coluna na posição + tabela de config
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS bairros JSONB DEFAULT '[]'`).catch(() => {});
  console.log('✅ Coluna bairros verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_bairros_config (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      nome VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, nome)
    )
  `);
  console.log('✅ Tabela filas_bairros_config verificada');

  // ==================== V2 ====================

  // ⏱️ Timestamp da primeira nota liberada (cronômetro admin)
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS primeira_nota_at TIMESTAMP`).catch(() => {});
  console.log('✅ Coluna primeira_nota_at verificada');

  // 🚫 Tabela de penalidades por saída voluntária
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_penalidades (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      saidas_hoje INTEGER DEFAULT 0,
      bloqueado_ate TIMESTAMP,
      anulado_por VARCHAR(50),
      anulado_em TIMESTAMP,
      data_ref DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_filas_penalidades_unico 
      ON filas_penalidades (cod_profissional, central_id, data_ref)
  `).catch(() => {});
  console.log('✅ Tabela filas_penalidades verificada');

  // 🗺️ Regiões de rotas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_regioes (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      nome VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, nome)
    )
  `);
  console.log('✅ Tabela filas_regioes verificada');

  // FK regiao_id nos bairros
  await pool.query(`ALTER TABLE filas_bairros_config ADD COLUMN IF NOT EXISTS regiao_id INTEGER REFERENCES filas_regioes(id) ON DELETE SET NULL`).catch(() => {});
  console.log('✅ Coluna regiao_id em filas_bairros_config verificada');
}

module.exports = { initFilasTables };
