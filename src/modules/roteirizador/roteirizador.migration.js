/**
 * MÓDULO ROTEIRIZADOR - Migration
 * Tabelas: usuarios_roteirizador, rotas_historico, enderecos_favoritos, enderecos_geocodificados
 */

async function initRoteirizadorTables(pool) {
  // Tabela de usuários do roteirizador
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios_roteirizador (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      senha_hash VARCHAR(255) NOT NULL,
      telefone VARCHAR(20),
      empresa VARCHAR(255),
      observacoes TEXT,
      ativo BOOLEAN DEFAULT true,
      criado_por VARCHAR(255),
      ultimo_acesso TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela usuarios_roteirizador verificada');

  // Tabela de histórico de rotas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotas_historico (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios_roteirizador(id) ON DELETE CASCADE,
      nome VARCHAR(255),
      origem TEXT,
      destinos JSONB,
      rota_otimizada JSONB,
      distancia_total DECIMAL(10,2),
      tempo_total INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela rotas_historico verificada');

  // Tabela de endereços favoritos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enderecos_favoritos (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios_roteirizador(id) ON DELETE CASCADE,
      endereco TEXT NOT NULL,
      apelido VARCHAR(255),
      latitude DECIMAL(10,7),
      longitude DECIMAL(10,7),
      uso_count INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela enderecos_favoritos verificada');

  // Tabela de cache de geocodificação
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enderecos_geocodificados (
      id SERIAL PRIMARY KEY,
      endereco_busca TEXT NOT NULL,
      endereco_busca_normalizado TEXT,
      endereco_formatado TEXT,
      latitude DECIMAL(10,7),
      longitude DECIMAL(10,7),
      fonte VARCHAR(50),
      acessos INTEGER DEFAULT 1,
      ultimo_acesso TIMESTAMP DEFAULT NOW(),
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela enderecos_geocodificados verificada');
}

module.exports = { initRoteirizadorTables };
