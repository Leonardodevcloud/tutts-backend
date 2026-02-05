/**
 * MÓDULO LOJA - Migration
 * Tabelas: loja_estoque, loja_estoque_tamanhos, loja_estoque_movimentacoes,
 *          loja_produtos, loja_pedidos, loja_sugestoes
 */

async function initLojaTables(pool) {
  // Tabela de estoque da loja
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loja_estoque (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      marca VARCHAR(255),
      valor DECIMAL(10,2) NOT NULL,
      quantidade INTEGER DEFAULT 0,
      tem_tamanho BOOLEAN DEFAULT FALSE,
      imagem_url TEXT,
      status VARCHAR(20) DEFAULT 'ativo',
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela loja_estoque verificada');

  // Tabela de tamanhos do estoque
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loja_estoque_tamanhos (
      id SERIAL PRIMARY KEY,
      estoque_id INTEGER REFERENCES loja_estoque(id) ON DELETE CASCADE,
      tamanho VARCHAR(20) NOT NULL,
      quantidade INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela loja_estoque_tamanhos verificada');

  // Tabela de produtos à venda
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loja_produtos (
      id SERIAL PRIMARY KEY,
      estoque_id INTEGER REFERENCES loja_estoque(id),
      nome VARCHAR(255) NOT NULL,
      descricao TEXT,
      marca VARCHAR(255),
      valor DECIMAL(10,2) NOT NULL,
      imagem_url TEXT,
      parcelas_config JSONB DEFAULT '[]',
      abatimento_avista DECIMAL(5,2) DEFAULT 0,
      abatimento_2semanas DECIMAL(5,2) DEFAULT 0,
      abatimento_3semanas DECIMAL(5,2) DEFAULT 0,
      abatimento_4semanas DECIMAL(5,2) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'ativo',
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela loja_produtos verificada');

  // Migração: adicionar coluna parcelas_config se não existir
  try {
    await pool.query(`ALTER TABLE loja_produtos ADD COLUMN IF NOT EXISTS parcelas_config JSONB DEFAULT '[]'`);
    console.log('✅ Coluna parcelas_config verificada');
  } catch (e) {}

  // Tabela de pedidos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loja_pedidos (
      id SERIAL PRIMARY KEY,
      produto_id INTEGER REFERENCES loja_produtos(id),
      user_cod VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      produto_nome VARCHAR(255) NOT NULL,
      tamanho VARCHAR(20),
      marca VARCHAR(255),
      valor_original DECIMAL(10,2) NOT NULL,
      tipo_abatimento VARCHAR(50) NOT NULL,
      valor_abatimento DECIMAL(10,2) DEFAULT 0,
      valor_final DECIMAL(10,2) NOT NULL,
      parcelas INTEGER DEFAULT 1,
      valor_parcela DECIMAL(10,2),
      status VARCHAR(20) DEFAULT 'pendente',
      admin_id VARCHAR(255),
      admin_name VARCHAR(255),
      observacao TEXT,
      debito_lancado BOOLEAN DEFAULT FALSE,
      debito_lancado_em TIMESTAMP,
      debito_lancado_por VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela loja_pedidos verificada');

  // Adicionar colunas que podem não existir
  await pool.query(`ALTER TABLE loja_pedidos ADD COLUMN IF NOT EXISTS debito_lancado BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE loja_pedidos ADD COLUMN IF NOT EXISTS debito_lancado_em TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE loja_pedidos ADD COLUMN IF NOT EXISTS debito_lancado_por VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE loja_estoque ADD COLUMN IF NOT EXISTS tipo_tamanho VARCHAR(20) DEFAULT 'letras'`).catch(() => {});

  // Tabela de movimentações de estoque (entradas e saídas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loja_estoque_movimentacoes (
      id SERIAL PRIMARY KEY,
      estoque_id INTEGER REFERENCES loja_estoque(id) ON DELETE CASCADE,
      tipo VARCHAR(20) NOT NULL,
      quantidade INTEGER NOT NULL,
      tamanho VARCHAR(20),
      motivo TEXT,
      pedido_id INTEGER REFERENCES loja_pedidos(id),
      user_name VARCHAR(255),
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela loja_estoque_movimentacoes verificada');

  // Tabela de sugestões de produtos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loja_sugestoes (
      id SERIAL PRIMARY KEY,
      user_cod VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      sugestao TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pendente',
      resposta TEXT,
      respondido_por VARCHAR(255),
      respondido_em TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela loja_sugestoes verificada');
}

module.exports = { initLojaTables };
