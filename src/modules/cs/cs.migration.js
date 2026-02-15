/**
 * MÓDULO SUCESSO DO CLIENTE (CS) - Migration
 * Tables: cs_clientes, cs_interacoes, cs_ocorrencias, cs_raio_x_historico
 *
 * Integra com: bi_entregas, bi_resumo_cliente (módulo BI)
 * Acesso: admins/gestores apenas
 */

async function initCsTables(pool) {
  // ========== FICHA DO CLIENTE ==========
  // Dados complementares ao bi_entregas (que já tem cod_cliente + nome_fantasia)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_clientes (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL UNIQUE,
      nome_fantasia VARCHAR(255),
      razao_social VARCHAR(255),
      cnpj VARCHAR(20),
      telefone VARCHAR(30),
      email VARCHAR(255),
      endereco TEXT,
      cidade VARCHAR(100),
      estado VARCHAR(10),
      responsavel_nome VARCHAR(255),
      responsavel_telefone VARCHAR(30),
      responsavel_email VARCHAR(255),
      segmento VARCHAR(100) DEFAULT 'autopeças',
      porte VARCHAR(30) DEFAULT 'médio',
      data_inicio_parceria DATE,
      observacoes TEXT,
      tags JSONB DEFAULT '[]',
      health_score INTEGER DEFAULT 50,
      status VARCHAR(30) DEFAULT 'ativo',
      created_by VARCHAR(50),
      updated_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Índices
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_clientes_cod ON cs_clientes(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_clientes_status ON cs_clientes(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_clientes_health ON cs_clientes(health_score)`).catch(() => {});

  // Migração: adicionar centro_custo para suportar múltiplos centros por cod_cliente
  await pool.query(`ALTER TABLE cs_clientes ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(255) DEFAULT NULL`).catch(() => {});
  
  // Remover QUALQUER constraint/index unique que impeça múltiplas linhas por cod_cliente
  try {
    // Buscar nome real da constraint unique em cod_cliente
    const constraints = await pool.query(`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'cs_clientes' 
        AND con.contype = 'u'
    `);
    for (const c of constraints.rows) {
      console.log(`🔧 Removendo constraint: ${c.conname}`);
      await pool.query(`ALTER TABLE cs_clientes DROP CONSTRAINT IF EXISTS "${c.conname}"`).catch(() => {});
    }
    
    // Buscar unique indexes
    const indexes = await pool.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'cs_clientes' AND indexdef LIKE '%UNIQUE%'
        AND indexname != 'idx_cs_clientes_cod_cc'
    `);
    for (const idx of indexes.rows) {
      console.log(`🔧 Removendo index: ${idx.indexname}`);
      await pool.query(`DROP INDEX IF EXISTS "${idx.indexname}"`).catch(() => {});
    }
  } catch (e) { console.warn('⚠️ Limpeza constraints:', e.message); }

  // Criar novo unique index (cod_cliente + centro_custo)
  await pool.query(`DROP INDEX IF EXISTS idx_cs_clientes_cod_cc`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX idx_cs_clientes_cod_cc ON cs_clientes(cod_cliente, COALESCE(centro_custo, ''))`).catch(e => {
    console.log('⚠️ Unique index centro_custo:', e.message);
  });
  
  console.log('✅ Tabela cs_clientes verificada');

  // ========== INTERAÇÕES (TIMELINE) ==========
  // Visitas, reuniões, ligações, pós-venda, anotações
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_interacoes (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL,
      tipo VARCHAR(30) NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      data_interacao TIMESTAMP NOT NULL DEFAULT NOW(),
      duracao_minutos INTEGER,
      participantes JSONB DEFAULT '[]',
      resultado VARCHAR(50),
      proxima_acao TEXT,
      data_proxima_acao DATE,
      anexos JSONB DEFAULT '[]',
      tags JSONB DEFAULT '[]',
      criado_por VARCHAR(50) NOT NULL,
      criado_por_nome VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_interacoes_cliente ON cs_interacoes(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_interacoes_tipo ON cs_interacoes(tipo)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_interacoes_data ON cs_interacoes(data_interacao DESC)`).catch(() => {});
  console.log('✅ Tabela cs_interacoes verificada');

  // ========== OCORRÊNCIAS ==========
  // Problemas, reclamações, incidentes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_ocorrencias (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      tipo VARCHAR(50) NOT NULL,
      severidade VARCHAR(20) NOT NULL DEFAULT 'media',
      status VARCHAR(30) NOT NULL DEFAULT 'aberta',
      responsavel_cod VARCHAR(50),
      responsavel_nome VARCHAR(255),
      data_abertura TIMESTAMP DEFAULT NOW(),
      data_resolucao TIMESTAMP,
      resolucao TEXT,
      impacto_operacional TEXT,
      tags JSONB DEFAULT '[]',
      criado_por VARCHAR(50) NOT NULL,
      criado_por_nome VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_cliente ON cs_ocorrencias(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_status ON cs_ocorrencias(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_sev ON cs_ocorrencias(severidade)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_ocorrencias_data ON cs_ocorrencias(data_abertura DESC)`).catch(() => {});
  console.log('✅ Tabela cs_ocorrencias verificada');

  // ========== HISTÓRICO RAIO-X IA ==========
  // Análises inteligentes geradas pelo Gemini
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_raio_x_historico (
      id SERIAL PRIMARY KEY,
      cod_cliente INTEGER NOT NULL,
      nome_cliente VARCHAR(255),
      data_inicio DATE NOT NULL,
      data_fim DATE NOT NULL,
      metricas_snapshot JSONB,
      benchmark_snapshot JSONB,
      analise_texto TEXT,
      tipo_analise VARCHAR(50) DEFAULT 'completo',
      score_saude INTEGER,
      alertas JSONB DEFAULT '[]',
      recomendacoes JSONB DEFAULT '[]',
      gerado_por VARCHAR(50),
      gerado_por_nome VARCHAR(255),
      tokens_utilizados INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_raio_x_cliente ON cs_raio_x_historico(cod_cliente)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cs_raio_x_data ON cs_raio_x_historico(created_at DESC)`).catch(() => {});
  console.log('✅ Tabela cs_raio_x_historico verificada');

  console.log('✅ Módulo Sucesso do Cliente — todas as tabelas verificadas');
}

module.exports = initCsTables;
