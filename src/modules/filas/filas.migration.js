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
}

module.exports = { initFilasTables };
