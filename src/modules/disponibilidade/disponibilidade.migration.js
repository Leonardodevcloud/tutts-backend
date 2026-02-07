/**
 * MÓDULO DISPONIBILIDADE - Migration
 * 9 tabelas + índices
 */

async function initDisponibilidadeTables(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_regioes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        gestores VARCHAR(255),
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migração: adicionar coluna gestores se não existir
    await pool.query(`ALTER TABLE disponibilidade_regioes ADD COLUMN IF NOT EXISTS gestores VARCHAR(255)`).catch(() => {});
    console.log('✅ Tabela disponibilidade_regioes verificada');

    // Tabela de Lojas de Disponibilidade
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_lojas (
        id SERIAL PRIMARY KEY,
        regiao_id INT NOT NULL REFERENCES disponibilidade_regioes(id) ON DELETE CASCADE,
        codigo VARCHAR(20) NOT NULL,
        nome VARCHAR(200) NOT NULL,
        qtd_titulares INT DEFAULT 0,
        qtd_excedentes INT DEFAULT 0,
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migração: adicionar colunas se não existirem
    await pool.query(`ALTER TABLE disponibilidade_lojas ADD COLUMN IF NOT EXISTS qtd_titulares INT DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_lojas ADD COLUMN IF NOT EXISTS qtd_excedentes INT DEFAULT 0`).catch(() => {});
    console.log('✅ Tabela disponibilidade_lojas verificada');

    // Tabela de Linhas de Disponibilidade (Entregadores)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_linhas (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        status VARCHAR(20) DEFAULT 'A CONFIRMAR',
        observacao TEXT,
        is_excedente BOOLEAN DEFAULT FALSE,
        is_reposicao BOOLEAN DEFAULT FALSE,
        observacao_criada_por VARCHAR(200),
        observacao_criada_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migração: adicionar colunas se não existirem
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS is_excedente BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS is_reposicao BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS observacao_criada_por VARCHAR(200)`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS observacao_criada_em TIMESTAMP`).catch(() => {});
    console.log('✅ Tabela disponibilidade_linhas verificada');
    
    // Tabela de Histórico de Observações (persiste após reset)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_observacoes_historico (
        id SERIAL PRIMARY KEY,
        linha_id INT,
        loja_id INT,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        observacao TEXT NOT NULL,
        criada_por VARCHAR(200),
        criada_em TIMESTAMP,
        data_reset DATE,
        data_planilha DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_obs_hist_data ON disponibilidade_observacoes_historico(data_reset)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_obs_hist_cod ON disponibilidade_observacoes_historico(cod_profissional)`).catch(() => {});
    console.log('✅ Tabela disponibilidade_observacoes_historico verificada');

    // Tabela de Faltosos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_faltosos (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        motivo TEXT NOT NULL,
        data_falta DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_faltosos verificada');

    // Tabela de EM LOJA (registro diário)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_em_loja (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        data_registro DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_em_loja verificada');

    // Tabela de SEM CONTATO (com tracking de dias consecutivos)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_sem_contato (
        id SERIAL PRIMARY KEY,
        loja_id INT NOT NULL REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        cod_profissional VARCHAR(50),
        nome_profissional VARCHAR(200),
        data_registro DATE DEFAULT CURRENT_DATE,
        dias_consecutivos INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_sem_contato verificada');

    // Tabela de Espelho (histórico diário)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_espelho (
        id SERIAL PRIMARY KEY,
        data_registro DATE DEFAULT CURRENT_DATE,
        dados JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_espelho verificada');

    // Tabela de Restrições de Motoboys
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_restricoes (
        id SERIAL PRIMARY KEY,
        cod_profissional VARCHAR(50) NOT NULL,
        nome_profissional VARCHAR(200),
        loja_id INT REFERENCES disponibilidade_lojas(id) ON DELETE CASCADE,
        todas_lojas BOOLEAN DEFAULT false,
        motivo TEXT NOT NULL,
        ativo BOOLEAN DEFAULT true,
        criado_por VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela disponibilidade_restricoes verificada');

    // Índices para performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_lojas_regiao ON disponibilidade_lojas(regiao_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_linhas_loja ON disponibilidade_linhas(loja_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_linhas_cod ON disponibilidade_linhas(cod_profissional)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_espelho_data ON disponibilidade_espelho(data_registro)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_faltosos_data ON disponibilidade_faltosos(data_falta)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_em_loja_data ON disponibilidade_em_loja(data_registro)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_sem_contato_data ON disponibilidade_sem_contato(data_registro)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_sem_contato_cod ON disponibilidade_sem_contato(cod_profissional)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_restricoes_cod ON disponibilidade_restricoes(cod_profissional)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_restricoes_loja ON disponibilidade_restricoes(loja_id)`).catch(() => {});
}

module.exports = { initDisponibilidadeTables };
