/**
 * MÓDULO BI - Migration
 * Tables: bi_prazos_cliente, bi_faixas_prazo, bi_prazo_padrao,
 *         bi_prazos_prof_cliente, bi_faixas_prazo_prof, bi_prazo_prof_padrao,
 *         bi_entregas, bi_upload_historico, bi_relatorios_ia,
 *         bi_resumo_diario, bi_resumo_cliente, bi_resumo_profissional, bi_resumo_geral
 */

async function initBiTables(pool) {
    // Tabela de configuração de prazos por cliente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazos_cliente (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL, -- 'cliente' ou 'centro_custo'
        codigo VARCHAR(100) NOT NULL, -- Cód. cliente ou nome do centro de custo
        nome VARCHAR(255), -- Nome para exibição
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tipo, codigo)
      )
    `);
    console.log('✅ Tabela bi_prazos_cliente verificada');

    // Tabela de faixas de prazo por cliente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_faixas_prazo (
        id SERIAL PRIMARY KEY,
        prazo_cliente_id INTEGER REFERENCES bi_prazos_cliente(id) ON DELETE CASCADE,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2), -- NULL significa infinito
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_faixas_prazo verificada');

    // Tabela de prazo padrão (para clientes não configurados)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazo_padrao (
        id SERIAL PRIMARY KEY,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2),
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_prazo_padrao verificada');

    // ========== TABELAS PARA PRAZO PROFISSIONAL ==========
    
    // Tabela de prazos profissionais por cliente/centro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazos_prof_cliente (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL, -- 'cliente' ou 'centro_custo'
        codigo VARCHAR(100) NOT NULL,
        nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tipo, codigo)
      )
    `);
    console.log('✅ Tabela bi_prazos_prof_cliente verificada');

    // Faixas de km para prazo profissional por cliente/centro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_faixas_prazo_prof (
        id SERIAL PRIMARY KEY,
        prazo_prof_cliente_id INTEGER REFERENCES bi_prazos_prof_cliente(id) ON DELETE CASCADE,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2),
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_faixas_prazo_prof verificada');

    // Prazo profissional padrão
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_prazo_prof_padrao (
        id SERIAL PRIMARY KEY,
        km_min DECIMAL(10,2) NOT NULL DEFAULT 0,
        km_max DECIMAL(10,2),
        prazo_minutos INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_prazo_prof_padrao verificada');

    // Tabela de entregas (dados importados do Excel)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_entregas (
        id SERIAL PRIMARY KEY,
        os INTEGER NOT NULL,
        ponto INTEGER DEFAULT 1,
        num_pedido VARCHAR(100),
        cod_cliente INTEGER,
        nome_cliente VARCHAR(255),
        empresa VARCHAR(255),
        nome_fantasia VARCHAR(255),
        centro_custo VARCHAR(255),
        cidade_p1 VARCHAR(100),
        endereco TEXT,
        bairro VARCHAR(100),
        cidade VARCHAR(100),
        estado VARCHAR(10),
        cod_prof INTEGER,
        nome_prof VARCHAR(255),
        data_hora TIMESTAMP,
        data_hora_alocado TIMESTAMP,
        data_solicitado DATE,
        hora_solicitado TIME,
        data_chegada DATE,
        hora_chegada TIME,
        data_saida DATE,
        hora_saida TIME,
        categoria VARCHAR(100),
        valor DECIMAL(10,2),
        distancia DECIMAL(10,2),
        valor_prof DECIMAL(10,2),
        finalizado TIMESTAMP,
        execucao_comp VARCHAR(20),
        execucao_espera VARCHAR(20),
        status VARCHAR(50),
        motivo VARCHAR(50),
        ocorrencia VARCHAR(100),
        velocidade_media DECIMAL(10,2),
        data_upload DATE DEFAULT CURRENT_DATE,
        dentro_prazo BOOLEAN,
        prazo_minutos INTEGER,
        tempo_execucao_minutos INTEGER,
        dentro_prazo_prof BOOLEAN,
        prazo_prof_minutos INTEGER,
        tempo_execucao_prof_minutos INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_entregas verificada');

    // Migration: Adicionar coluna ponto se não existir
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS ponto INTEGER DEFAULT 1`).catch(() => {});
    
    // Migration: Adicionar colunas de prazo profissional
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS dentro_prazo_prof BOOLEAN`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS prazo_prof_minutos INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS tempo_execucao_prof_minutos INTEGER`).catch(() => {});
    
    // Migration: Aumentar tamanho de campos VARCHAR que podem ser pequenos demais
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN estado TYPE VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN status TYPE VARCHAR(100)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN motivo TYPE VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN ocorrencia TYPE VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN execucao_comp TYPE VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ALTER COLUMN execucao_espera TYPE VARCHAR(50)`).catch(() => {});
    
    // Índices do BI
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_data ON bi_entregas(data_solicitado)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_cliente ON bi_entregas(cod_cliente)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_centro ON bi_entregas(centro_custo)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_prof ON bi_entregas(cod_prof)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_prazo ON bi_entregas(dentro_prazo)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_os_ponto ON bi_entregas(os, ponto)`).catch(() => {});
    // Índice UNIQUE para UPSERT (ON CONFLICT)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bi_entregas_os_ponto_unique ON bi_entregas(os, ponto)`).catch(() => {});
    
    // Migration: Adicionar coluna tempo_entrega_prof_minutos para T. Entrega Prof
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS tempo_entrega_prof_minutos INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS dentro_prazo_prof BOOLEAN`).catch(() => {});

    // Tabela de histórico de uploads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_upload_historico (
        id SERIAL PRIMARY KEY,
        usuario_id VARCHAR(100),
        usuario_nome VARCHAR(255),
        nome_arquivo VARCHAR(500),
        total_linhas INTEGER,
        linhas_inseridas INTEGER,
        linhas_ignoradas INTEGER,
        os_novas INTEGER,
        os_ignoradas INTEGER,
        data_upload TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_upload_historico verificada');

    // Tabela de histórico de relatórios IA
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_relatorios_ia (
        id SERIAL PRIMARY KEY,
        usuario_id VARCHAR(100),
        usuario_nome VARCHAR(255),
        cod_cliente INTEGER,
        nome_cliente VARCHAR(255),
        centro_custo VARCHAR(255),
        tipo_analise VARCHAR(500),
        data_inicio DATE,
        data_fim DATE,
        metricas JSONB,
        relatorio TEXT,
        filtros JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_relatorios_ia verificada');


    // Colunas de coordenadas para mapa de calor
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_coords ON bi_entregas(latitude, longitude) WHERE latitude IS NOT NULL`).catch(() => {});
    console.log('✅ Colunas latitude/longitude verificadas');

    // ============================================
    // TABELAS DE RESUMO PRÉ-CALCULADAS (OTIMIZAÇÃO)
    // ============================================
    
    // Resumo diário geral
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_diario (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL UNIQUE,
        total_os INTEGER DEFAULT 0,
        total_entregas INTEGER DEFAULT 0,
        entregas_no_prazo INTEGER DEFAULT 0,
        entregas_fora_prazo INTEGER DEFAULT 0,
        taxa_prazo DECIMAL(5,2) DEFAULT 0,
        total_retornos INTEGER DEFAULT 0,
        valor_total DECIMAL(12,2) DEFAULT 0,
        valor_prof DECIMAL(12,2) DEFAULT 0,
        ticket_medio DECIMAL(10,2) DEFAULT 0,
        tempo_medio_entrega DECIMAL(8,2) DEFAULT 0,
        tempo_medio_alocacao DECIMAL(8,2) DEFAULT 0,
        tempo_medio_coleta DECIMAL(8,2) DEFAULT 0,
        total_profissionais INTEGER DEFAULT 0,
        media_ent_profissional DECIMAL(8,2) DEFAULT 0,
        km_total DECIMAL(12,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_resumo_diario verificada');
    
    // Resumo por cliente (por dia)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_cliente (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL,
        cod_cliente INTEGER NOT NULL,
        nome_fantasia VARCHAR(255),
        total_os INTEGER DEFAULT 0,
        total_entregas INTEGER DEFAULT 0,
        entregas_no_prazo INTEGER DEFAULT 0,
        entregas_fora_prazo INTEGER DEFAULT 0,
        taxa_prazo DECIMAL(5,2) DEFAULT 0,
        total_retornos INTEGER DEFAULT 0,
        valor_total DECIMAL(12,2) DEFAULT 0,
        valor_prof DECIMAL(12,2) DEFAULT 0,
        ticket_medio DECIMAL(10,2) DEFAULT 0,
        tempo_medio_entrega DECIMAL(8,2) DEFAULT 0,
        total_profissionais INTEGER DEFAULT 0,
        media_ent_profissional DECIMAL(8,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(data, cod_cliente)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_cliente_data ON bi_resumo_cliente(data)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_cliente_cod ON bi_resumo_cliente(cod_cliente)`).catch(() => {});
    console.log('✅ Tabela bi_resumo_cliente verificada');
    
    // Resumo por profissional (por dia)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_profissional (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL,
        cod_prof INTEGER NOT NULL,
        nome_prof VARCHAR(255),
        total_os INTEGER DEFAULT 0,
        total_entregas INTEGER DEFAULT 0,
        entregas_no_prazo INTEGER DEFAULT 0,
        entregas_fora_prazo INTEGER DEFAULT 0,
        taxa_prazo DECIMAL(5,2) DEFAULT 0,
        valor_total DECIMAL(12,2) DEFAULT 0,
        valor_prof DECIMAL(12,2) DEFAULT 0,
        tempo_medio_entrega DECIMAL(8,2) DEFAULT 0,
        km_total DECIMAL(12,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(data, cod_prof)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_prof_data ON bi_resumo_profissional(data)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_resumo_prof_cod ON bi_resumo_profissional(cod_prof)`).catch(() => {});
    console.log('✅ Tabela bi_resumo_profissional verificada');
    
    // Resumo geral (métricas totais - atualizado a cada upload)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bi_resumo_geral (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(50) NOT NULL UNIQUE,
        valor_json JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_resumo_geral verificada');

    // Índices da loja
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_estoque_status ON loja_estoque(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_produtos_status ON loja_produtos(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_pedidos_user ON loja_pedidos(user_cod)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_pedidos_status ON loja_pedidos(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loja_sugestoes_status ON loja_sugestoes(status)`).catch(() => {});

    // ============================================
}

module.exports = { initBiTables };
