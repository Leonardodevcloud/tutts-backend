/**
 * MÓDULO OPERACIONAL - Migration
 * Tabelas: avisos, avisos_visualizacoes, operacoes, operacoes_faixas_km, incentivos_operacionais
 */

async function initOperacionalTables(pool) {
  // ==================== AVISOS ====================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS avisos (
      id SERIAL PRIMARY KEY,
      titulo VARCHAR(255) NOT NULL,
      regioes TEXT[] DEFAULT '{}',
      todas_regioes BOOLEAN DEFAULT false,
      data_inicio TIMESTAMP NOT NULL,
      data_fim TIMESTAMP NOT NULL,
      recorrencia_tipo VARCHAR(50) DEFAULT 'uma_vez',
      recorrencia_intervalo INTEGER DEFAULT 0,
      imagem_url TEXT,
      ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_by VARCHAR(255)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS avisos_visualizacoes (
      id SERIAL PRIMARY KEY,
      aviso_id INTEGER REFERENCES avisos(id) ON DELETE CASCADE,
      user_cod VARCHAR(50) NOT NULL,
      visualizado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE(aviso_id, user_cod)
    )
  `);
  console.log('✅ Tabelas avisos verificadas');

  // ==================== OPERAÇÕES ====================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operacoes (
      id SERIAL PRIMARY KEY,
      regiao VARCHAR(100) NOT NULL,
      nome_cliente VARCHAR(255) NOT NULL,
      endereco TEXT NOT NULL,
      modelo VARCHAR(50) NOT NULL,
      quantidade_motos INTEGER NOT NULL DEFAULT 1,
      obrigatoriedade_bau BOOLEAN DEFAULT FALSE,
      possui_garantido BOOLEAN DEFAULT FALSE,
      valor_garantido DECIMAL(10,2) DEFAULT 0,
      data_inicio DATE NOT NULL,
      observacoes TEXT,
      status VARCHAR(50) DEFAULT 'ativo',
      criado_por VARCHAR(100),
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela operacoes verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS operacoes_faixas_km (
      id SERIAL PRIMARY KEY,
      operacao_id INTEGER NOT NULL REFERENCES operacoes(id) ON DELETE CASCADE,
      km_inicio INTEGER NOT NULL,
      km_fim INTEGER NOT NULL,
      valor_motoboy DECIMAL(10,2) NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela operacoes_faixas_km verificada');

  // ==================== INCENTIVOS OPERACIONAIS ====================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incentivos_operacionais (
      id SERIAL PRIMARY KEY,
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      tipo VARCHAR(50) DEFAULT 'promocao',
      operacoes TEXT[],
      todas_operacoes BOOLEAN DEFAULT FALSE,
      data_inicio DATE NOT NULL,
      data_fim DATE NOT NULL,
      hora_inicio TIME,
      hora_fim TIME,
      valor VARCHAR(100),
      valor_incentivo DECIMAL(10,2),
      clientes_vinculados INTEGER[],
      condicoes TEXT,
      status VARCHAR(20) DEFAULT 'ativo',
      cor VARCHAR(20) DEFAULT '#0d9488',
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Migrations para adicionar novos campos
  await pool.query(`ALTER TABLE incentivos_operacionais ADD COLUMN IF NOT EXISTS hora_inicio TIME`).catch(() => {});
  await pool.query(`ALTER TABLE incentivos_operacionais ADD COLUMN IF NOT EXISTS hora_fim TIME`).catch(() => {});
  await pool.query(`ALTER TABLE incentivos_operacionais ADD COLUMN IF NOT EXISTS valor_incentivo DECIMAL(10,2)`).catch(() => {});
  await pool.query(`ALTER TABLE incentivos_operacionais ADD COLUMN IF NOT EXISTS clientes_vinculados INTEGER[]`).catch(() => {});
  console.log('✅ Tabela incentivos_operacionais verificada');
}

module.exports = { initOperacionalTables };
