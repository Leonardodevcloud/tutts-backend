const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const dns = require('dns');
require('dotenv').config();

// Forçar DNS para IPv4
dns.setDefaultResultOrder('ipv4first');

const app = express();
const port = process.env.PORT || 3001;

// Validar DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.error('❌ ERRO: DATABASE_URL não está configurada!');
  console.error('Configure a variável de ambiente DATABASE_URL no Render.');
  process.exit(1);
}

console.log('🔄 Conectando ao banco de dados...');
console.log('URL:', process.env.DATABASE_URL.substring(0, 30) + '...');

// Configuração do banco de dados
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Testar conexão e criar tabelas
pool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    console.error('❌ Erro ao conectar no banco:', err.message);
  } else {
    console.log('✅ Banco de dados conectado!', res.rows[0].now);
    // Criar tabelas necessárias
    await createTables();
  }
});

// Função para criar todas as tabelas necessárias
async function createTables() {
  try {
    // Tabela de dados financeiros do usuário
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_financial_data (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        cpf VARCHAR(14) NOT NULL,
        pix_key VARCHAR(255) NOT NULL,
        pix_tipo VARCHAR(20) DEFAULT 'cpf',
        terms_accepted BOOLEAN DEFAULT FALSE,
        terms_accepted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela user_financial_data verificada');
    
    // Adicionar coluna pix_tipo se não existir
    await pool.query(`
      ALTER TABLE user_financial_data ADD COLUMN IF NOT EXISTS pix_tipo VARCHAR(20) DEFAULT 'cpf'
    `).catch(() => {});

    // Tabela de logs de alterações financeiras
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financial_logs (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela financial_logs verificada');

    // Tabela de solicitações de saque
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        cpf VARCHAR(14) NOT NULL,
        pix_key VARCHAR(255) NOT NULL,
        requested_amount DECIMAL(10,2) NOT NULL,
        fee_amount DECIMAL(10,2) DEFAULT 0,
        final_amount DECIMAL(10,2) NOT NULL,
        has_gratuity BOOLEAN DEFAULT FALSE,
        gratuity_id INTEGER,
        status VARCHAR(50) DEFAULT 'aguardando_aprovacao',
        admin_id INTEGER,
        admin_name VARCHAR(255),
        conciliacao_omie BOOLEAN DEFAULT FALSE,
        debito BOOLEAN DEFAULT FALSE,
        approved_at TIMESTAMP,
        saldo_status VARCHAR(20),
        reject_reason VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela withdrawal_requests verificada');

    // Garantir que a coluna admin_name existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS admin_name VARCHAR(255)`);
      console.log('✅ Coluna admin_name verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna reject_reason existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reject_reason TEXT`);
      console.log('✅ Coluna reject_reason verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna debito_at existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS debito_at TIMESTAMP`);
      console.log('✅ Coluna debito_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna approved_at existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
      console.log('✅ Coluna approved_at verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Garantir que a coluna saldo_status existe (migração)
    try {
      await pool.query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS saldo_status VARCHAR(20)`);
      console.log('✅ Coluna saldo_status verificada');
    } catch (e) {
      // Coluna já existe ou outro erro
    }

    // Tabela de gratuidades
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gratuities (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        quantity INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        value DECIMAL(10,2) NOT NULL,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'ativa',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        expired_at TIMESTAMP
      )
    `);
    console.log('✅ Tabela gratuities verificada');
    
    // Migração: adicionar colunas user_name e created_by em gratuities
    await pool.query(`ALTER TABLE gratuities ADD COLUMN IF NOT EXISTS user_name VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE gratuities ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`).catch(() => {});

    // Tabela de profissionais restritos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS restricted_professionals (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        user_name VARCHAR(255),
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'ativo',
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        removed_at TIMESTAMP,
        removed_reason TEXT
      )
    `);
    console.log('✅ Tabela restricted_professionals verificada');

    // Migração: adicionar colunas em restricted_professionals
    await pool.query(`ALTER TABLE restricted_professionals ADD COLUMN IF NOT EXISTS user_name VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE restricted_professionals ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`).catch(() => {});

    // Tabela de solicitações de recuperação de senha
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_recovery (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        new_password VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP,
        resolved_by VARCHAR(255)
      )
    `);
    console.log('✅ Tabela password_recovery verificada');

    // Tabela de promoções de indicação
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promocoes_indicacao (
        id SERIAL PRIMARY KEY,
        regiao VARCHAR(255) NOT NULL,
        valor_bonus DECIMAL(10,2) NOT NULL,
        detalhes TEXT,
        status VARCHAR(20) DEFAULT 'ativa',
        created_at TIMESTAMP DEFAULT NOW(),
        created_by VARCHAR(255),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela promocoes_indicacao verificada');

    // Migração: adicionar coluna detalhes se não existir
    try {
      await pool.query(`ALTER TABLE promocoes_indicacao ADD COLUMN IF NOT EXISTS detalhes TEXT`);
      console.log('✅ Coluna detalhes verificada');
    } catch (e) {
      // Coluna já existe
    }

    // Tabela de indicações dos usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS indicacoes (
        id SERIAL PRIMARY KEY,
        promocao_id INTEGER REFERENCES promocoes_indicacao(id),
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        indicado_nome VARCHAR(255) NOT NULL,
        indicado_cpf VARCHAR(14),
        indicado_contato VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        valor_bonus DECIMAL(10,2),
        regiao VARCHAR(255),
        motivo_rejeicao TEXT,
        credito_lancado BOOLEAN DEFAULT FALSE,
        lancado_por VARCHAR(255),
        lancado_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        resolved_at TIMESTAMP,
        resolved_by VARCHAR(255),
        link_token VARCHAR(100)
      )
    `);
    console.log('✅ Tabela indicacoes verificada');

    // Nova tabela: Links de indicação (tokens únicos por usuário)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS indicacao_links (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        token VARCHAR(100) UNIQUE NOT NULL,
        promocao_id INTEGER,
        regiao VARCHAR(255),
        valor_bonus DECIMAL(10,2),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela indicacao_links verificada');

    // Migração: adicionar colunas de promoção na tabela indicacao_links
    try {
      await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS promocao_id INTEGER`);
      await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS regiao VARCHAR(255)`);
      await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS valor_bonus DECIMAL(10,2)`);
    } catch (e) {}

    // Migração: adicionar coluna link_token se não existir
    try {
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS link_token VARCHAR(100)`);
    } catch (e) {}

    // Migração: adicionar colunas de crédito lançado se não existirem
    try {
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS credito_lancado BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS lancado_por VARCHAR(255)`);
      await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS lancado_at TIMESTAMP`);
      console.log('✅ Colunas de crédito verificadas');
    } catch (e) {
      // Colunas já existem
    }

    // Tabela de promoções para novatos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promocoes_novatos (
        id SERIAL PRIMARY KEY,
        regiao VARCHAR(255) NOT NULL,
        cliente VARCHAR(255) NOT NULL,
        valor_bonus DECIMAL(10,2) NOT NULL,
        detalhes TEXT,
        status VARCHAR(20) DEFAULT 'ativa',
        created_at TIMESTAMP DEFAULT NOW(),
        created_by VARCHAR(255),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela promocoes_novatos verificada');

    // Tabela de inscrições dos novatos nas promoções
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inscricoes_novatos (
        id SERIAL PRIMARY KEY,
        promocao_id INTEGER REFERENCES promocoes_novatos(id),
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        valor_bonus DECIMAL(10,2),
        regiao VARCHAR(255),
        cliente VARCHAR(255),
        motivo_rejeicao TEXT,
        credito_lancado BOOLEAN DEFAULT FALSE,
        lancado_por VARCHAR(255),
        lancado_at TIMESTAMP,
        debito BOOLEAN DEFAULT FALSE,
        debitado_por VARCHAR(255),
        debitado_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        resolved_at TIMESTAMP,
        resolved_by VARCHAR(255)
      )
    `);
    console.log('✅ Tabela inscricoes_novatos verificada');

    // Migração: adicionar colunas de débito se não existirem
    try {
      await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debito BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debitado_por VARCHAR(255)`);
      await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debitado_at TIMESTAMP`);
      console.log('✅ Colunas de débito verificadas');
    } catch (e) {
      // Colunas já existem
    }

    // Tabela de configuração do Quiz de Procedimentos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_procedimentos_config (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(500) DEFAULT 'Acerte os procedimentos e ganhe saque gratuito de R$ 500,00',
        imagem1 TEXT,
        imagem2 TEXT,
        imagem3 TEXT,
        imagem4 TEXT,
        pergunta1 TEXT,
        resposta1 BOOLEAN,
        pergunta2 TEXT,
        resposta2 BOOLEAN,
        pergunta3 TEXT,
        resposta3 BOOLEAN,
        pergunta4 TEXT,
        resposta4 BOOLEAN,
        pergunta5 TEXT,
        resposta5 BOOLEAN,
        valor_gratuidade DECIMAL(10,2) DEFAULT 500.00,
        ativo BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela quiz_procedimentos_config verificada');

    // Tabela de respostas do quiz (para controlar quem já respondeu)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_procedimentos_respostas (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL UNIQUE,
        user_name VARCHAR(255),
        acertos INTEGER,
        passou BOOLEAN,
        gratuidade_criada BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela quiz_procedimentos_respostas verificada');

    // Tabela de Horários de Atendimento
    await pool.query(`
      CREATE TABLE IF NOT EXISTS horarios_atendimento (
        id SERIAL PRIMARY KEY,
        dia_semana INT NOT NULL, -- 0=Domingo, 1=Segunda... 6=Sábado
        hora_inicio TIME,
        hora_fim TIME,
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela horarios_atendimento verificada');

    // Tabela de Horários Especiais (feriados, datas específicas)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS horarios_especiais (
        id SERIAL PRIMARY KEY,
        data DATE NOT NULL UNIQUE,
        descricao VARCHAR(255),
        hora_inicio TIME,
        hora_fim TIME,
        fechado BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela horarios_especiais verificada');

    // Tabela de Avisos do Financeiro
    await pool.query(`
      CREATE TABLE IF NOT EXISTS avisos_financeiro (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(255) NOT NULL,
        mensagem TEXT NOT NULL,
        tipo VARCHAR(50) DEFAULT 'info', -- info, warning, error, success
        ativo BOOLEAN DEFAULT true,
        exibir_fora_horario BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela avisos_financeiro verificada');

    // Inserir horários padrão se tabela estiver vazia
    const horariosExistentes = await pool.query('SELECT COUNT(*) FROM horarios_atendimento');
    if (parseInt(horariosExistentes.rows[0].count) === 0) {
      // Segunda a Sexta: 09:00 às 18:00
      for (let dia = 1; dia <= 5; dia++) {
        await pool.query(
          'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
          [dia, '09:00', '18:00', true]
        );
      }
      // Sábado: 08:00 às 12:00
      await pool.query(
        'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
        [6, '08:00', '12:00', true]
      );
      // Domingo: Fechado
      await pool.query(
        'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
        [0, null, null, false]
      );
      console.log('✅ Horários padrão inseridos');
    }

    // ============================================
    // TABELAS DE DISPONIBILIDADE
    // ============================================
    
    // Tabela de Regiões de Disponibilidade
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

    // ============================================
    // TABELAS DA LOJA
    // ============================================

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

    // ========== MÓDULO BI ==========
    
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
    // TABELAS TO-DO
    // ============================================
    
    // Tabela de Grupos de TO-DO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_grupos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        descricao TEXT,
        icone VARCHAR(50) DEFAULT '📋',
        cor VARCHAR(20) DEFAULT '#7c3aed',
        tipo VARCHAR(20) DEFAULT 'compartilhado',
        criado_por VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        visivel_para JSONB DEFAULT '[]',
        ordem INT DEFAULT 0,
        ativo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_grupos verificada');

    // Tabela principal de Tarefas TO-DO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_tarefas (
        id SERIAL PRIMARY KEY,
        grupo_id INT REFERENCES todo_grupos(id) ON DELETE CASCADE,
        titulo VARCHAR(500) NOT NULL,
        descricao TEXT,
        status VARCHAR(30) DEFAULT 'pendente',
        prioridade VARCHAR(20) DEFAULT 'media',
        data_prazo TIMESTAMP,
        data_conclusao TIMESTAMP,
        recorrente BOOLEAN DEFAULT FALSE,
        tipo_recorrencia VARCHAR(20),
        intervalo_recorrencia INT DEFAULT 1,
        proxima_recorrencia TIMESTAMP,
        tipo VARCHAR(20) DEFAULT 'compartilhado',
        criado_por VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        criado_por_foto TEXT,
        responsaveis JSONB DEFAULT '[]',
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        concluido_por VARCHAR(50),
        concluido_por_nome VARCHAR(255)
      )
    `);
    // Adicionar colunas se não existirem
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS criado_por_foto TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS intervalo_recorrencia INT DEFAULT 1`).catch(() => {});
    console.log('✅ Tabela todo_tarefas verificada');

    // Tabela de Anexos das Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_anexos (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        nome_arquivo VARCHAR(500) NOT NULL,
        tipo_arquivo VARCHAR(100),
        tamanho INT,
        url TEXT NOT NULL,
        enviado_por VARCHAR(50),
        enviado_por_nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_anexos verificada');

    // Tabela de Comentários nas Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_comentarios (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        texto TEXT NOT NULL,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_comentarios verificada');

    // Tabela de Histórico/Log de Ações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_historico (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        acao VARCHAR(100) NOT NULL,
        descricao TEXT,
        user_cod VARCHAR(50),
        user_name VARCHAR(255),
        dados_anteriores JSONB,
        dados_novos JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_historico verificada');

    // Índices do TO-DO
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_grupo ON todo_tarefas(grupo_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_status ON todo_tarefas(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_criador ON todo_tarefas(criado_por)`).catch(() => {});

    // ============================================
    // NOVAS TABELAS TO-DO - MELHORIAS
    // ============================================

    // Tabela de Subtarefas/Checklist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_subtarefas (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        titulo VARCHAR(500) NOT NULL,
        concluida BOOLEAN DEFAULT FALSE,
        ordem INT DEFAULT 0,
        concluida_por VARCHAR(50),
        concluida_por_nome VARCHAR(255),
        concluida_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_subtarefas verificada');

    // Tabela de Time Tracking (registro de tempo)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_time_tracking (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        inicio TIMESTAMP NOT NULL,
        fim TIMESTAMP,
        duracao_segundos INT,
        descricao TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_time_tracking verificada');

    // Tabela de Dependências entre Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_dependencias (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        depende_de INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        tipo VARCHAR(30) DEFAULT 'finish_to_start',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tarefa_id, depende_de)
      )
    `);
    console.log('✅ Tabela todo_dependencias verificada');

    // Tabela de Templates de Tarefas Recorrentes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_templates (
        id SERIAL PRIMARY KEY,
        grupo_id INT REFERENCES todo_grupos(id) ON DELETE SET NULL,
        nome VARCHAR(255) NOT NULL,
        titulo_tarefa VARCHAR(500) NOT NULL,
        descricao TEXT,
        prioridade VARCHAR(20) DEFAULT 'media',
        checklist JSONB DEFAULT '[]',
        tempo_estimado_minutos INT,
        criado_por VARCHAR(50),
        criado_por_nome VARCHAR(255),
        ativo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_templates verificada');

    // Migração: adicionar novas colunas na tabela todo_tarefas
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS coluna_kanban VARCHAR(30) DEFAULT 'todo'`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS tempo_estimado_minutos INT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS tempo_gasto_segundos INT DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_ativo BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_inicio TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_user_cod VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS template_id INT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS cor VARCHAR(20)`).catch(() => {});
    console.log('✅ Colunas adicionais todo_tarefas verificadas');

    // Índices adicionais
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_subtarefas_tarefa ON todo_subtarefas(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_time_tarefa ON todo_time_tracking(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_kanban ON todo_tarefas(coluna_kanban)`).catch(() => {});

    // ============================================
    // TABELA DE PERMISSÕES DE ADMIN
    // ============================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_permissions (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) NOT NULL UNIQUE,
        user_name VARCHAR(255),
        modules JSONB DEFAULT '[]',
        tabs JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela admin_permissions verificada');

    // Adicionar coluna modules e tabs à tabela users (para admins)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_modules JSONB DEFAULT '[]'`).catch(() => {});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_tabs JSONB DEFAULT '{}'`).catch(() => {});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`).catch(() => {});
    console.log('✅ Colunas de permissões adicionadas à tabela users');
    
    // ===== SISTEMA DE SETORES =====
    // Tabela de setores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS setores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        descricao TEXT,
        cor VARCHAR(20) DEFAULT '#6366f1',
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela setores criada');
    
    // Adicionar coluna setor_id na tabela users
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS setor_id INTEGER REFERENCES setores(id)`).catch(() => {});
    console.log('✅ Coluna setor_id adicionada à tabela users');
    
    // Adicionar coluna setores_destino na tabela relatorios_diarios
    await pool.query(`ALTER TABLE relatorios_diarios ADD COLUMN IF NOT EXISTS setores_destino INTEGER[] DEFAULT '{}'`).catch(() => {});
    await pool.query(`ALTER TABLE relatorios_diarios ADD COLUMN IF NOT EXISTS para_todos BOOLEAN DEFAULT true`).catch(() => {});
    console.log('✅ Colunas setores_destino e para_todos adicionadas à tabela relatorios_diarios');

    // ==================== MÓDULO SOCIAL ====================
    // Tabela de perfis sociais (foto e nome de exibição)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_profiles (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        profile_photo TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_profiles verificada/criada');

    // Tabela de status online dos usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_status (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        is_online BOOLEAN DEFAULT false,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_status verificada/criada');

    // Tabela de mensagens e reações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_messages (
        id SERIAL PRIMARY KEY,
        from_user_cod VARCHAR(50) NOT NULL,
        from_user_name VARCHAR(255),
        to_user_cod VARCHAR(50) NOT NULL,
        message_type VARCHAR(20) DEFAULT 'message',
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_messages verificada/criada');
    // ==================== FIM MÓDULO SOCIAL ====================

    // ==================== MÓDULO AVISOS ====================
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
    // ==================== FIM MÓDULO AVISOS ====================

    // ==================== MÓDULO OPERAÇÕES ====================
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
    // ==================== FIM MÓDULO OPERAÇÕES ====================

    console.log('✅ Todas as tabelas verificadas/criadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error.message);
  }
}

// ============================================
// FUNÇÃO PARA ATUALIZAR RESUMOS PRÉ-CALCULADOS
// ============================================
async function atualizarResumos(datasAfetadas = null) {
  try {
    console.log('📊 Iniciando atualização dos resumos pré-calculados...');
    const inicio = Date.now();
    
    // Construir filtro de datas se especificado
    let filtroData = '';
    const params = [];
    if (datasAfetadas && datasAfetadas.length > 0) {
      filtroData = 'AND data_solicitado = ANY($1::date[])';
      params.push(datasAfetadas);
      console.log(`📊 Atualizando resumos para ${datasAfetadas.length} data(s)...`);
    } else {
      console.log('📊 Atualizando TODOS os resumos...');
    }
    
    // 1. RESUMO DIÁRIO - Uma única query
    await pool.query(`
      INSERT INTO bi_resumo_diario (
        data, total_os, total_entregas, entregas_no_prazo, entregas_fora_prazo,
        taxa_prazo, total_retornos, valor_total, valor_prof, ticket_medio,
        tempo_medio_entrega, tempo_medio_alocacao, tempo_medio_coleta,
        total_profissionais, media_ent_profissional, km_total, updated_at
      )
      SELECT 
        data_solicitado,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_execucao_minutos END), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_entrega_prof_minutos END), 2),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END),
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / 
              NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 2),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0),
        NOW()
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL ${filtroData}
      GROUP BY data_solicitado
      ON CONFLICT (data) DO UPDATE SET
        total_os = EXCLUDED.total_os,
        total_entregas = EXCLUDED.total_entregas,
        entregas_no_prazo = EXCLUDED.entregas_no_prazo,
        entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
        taxa_prazo = EXCLUDED.taxa_prazo,
        total_retornos = EXCLUDED.total_retornos,
        valor_total = EXCLUDED.valor_total,
        valor_prof = EXCLUDED.valor_prof,
        ticket_medio = EXCLUDED.ticket_medio,
        tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
        tempo_medio_alocacao = EXCLUDED.tempo_medio_alocacao,
        tempo_medio_coleta = EXCLUDED.tempo_medio_coleta,
        total_profissionais = EXCLUDED.total_profissionais,
        media_ent_profissional = EXCLUDED.media_ent_profissional,
        km_total = EXCLUDED.km_total,
        updated_at = NOW()
    `, params);
    console.log('📊 Resumo diário atualizado');
    
    // 2. RESUMO POR CLIENTE - Uma única query
    await pool.query(`
      INSERT INTO bi_resumo_cliente (
        data, cod_cliente, nome_fantasia, total_os, total_entregas,
        entregas_no_prazo, entregas_fora_prazo, taxa_prazo, total_retornos,
        valor_total, valor_prof, ticket_medio, tempo_medio_entrega,
        total_profissionais, media_ent_profissional, updated_at
      )
      SELECT 
        data_solicitado,
        cod_cliente,
        MAX(nome_fantasia),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END),
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / 
              NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 2),
        NOW()
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL AND cod_cliente IS NOT NULL ${filtroData}
      GROUP BY data_solicitado, cod_cliente
      ON CONFLICT (data, cod_cliente) DO UPDATE SET
        nome_fantasia = EXCLUDED.nome_fantasia,
        total_os = EXCLUDED.total_os,
        total_entregas = EXCLUDED.total_entregas,
        entregas_no_prazo = EXCLUDED.entregas_no_prazo,
        entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
        taxa_prazo = EXCLUDED.taxa_prazo,
        total_retornos = EXCLUDED.total_retornos,
        valor_total = EXCLUDED.valor_total,
        valor_prof = EXCLUDED.valor_prof,
        ticket_medio = EXCLUDED.ticket_medio,
        tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
        total_profissionais = EXCLUDED.total_profissionais,
        media_ent_profissional = EXCLUDED.media_ent_profissional,
        updated_at = NOW()
    `, params);
    console.log('📊 Resumo por cliente atualizado');
    
    // 3. RESUMO POR PROFISSIONAL - Uma única query
    await pool.query(`
      INSERT INTO bi_resumo_profissional (
        data, cod_prof, nome_prof, total_os, total_entregas,
        entregas_no_prazo, entregas_fora_prazo, taxa_prazo,
        valor_total, valor_prof, tempo_medio_entrega, km_total, updated_at
      )
      SELECT 
        data_solicitado,
        cod_prof,
        MAX(nome_prof),
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0),
        NOW()
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL AND cod_prof IS NOT NULL ${filtroData}
      GROUP BY data_solicitado, cod_prof
      ON CONFLICT (data, cod_prof) DO UPDATE SET
        nome_prof = EXCLUDED.nome_prof,
        total_os = EXCLUDED.total_os,
        total_entregas = EXCLUDED.total_entregas,
        entregas_no_prazo = EXCLUDED.entregas_no_prazo,
        entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
        taxa_prazo = EXCLUDED.taxa_prazo,
        valor_total = EXCLUDED.valor_total,
        valor_prof = EXCLUDED.valor_prof,
        tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
        km_total = EXCLUDED.km_total,
        updated_at = NOW()
    `, params);
    console.log('📊 Resumo por profissional atualizado');
    
    const tempo = ((Date.now() - inicio) / 1000).toFixed(2);
    console.log(`✅ Resumos atualizados em ${tempo}s`);
    
    return { success: true, tempo };
  } catch (error) {
    console.error('❌ Erro ao atualizar resumos:', error);
    return { success: false, error: error.message };
  }
}

// Middlewares - CORS configurado (DEVE SER O PRIMEIRO!)
// Lista de origens permitidas
const allowedOrigins = [
  'https://www.centraltutts.online',
  'https://centraltutts.online',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

// Função para setar headers CORS
const setCorsHeaders = (req, res) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || origin.includes('centraltutts'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, Pragma');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
};

// Responder imediatamente a requisições OPTIONS (preflight) - ANTES de tudo
app.options('*', (req, res) => {
  setCorsHeaders(req, res);
  return res.status(200).end();
});

// CORS para todas requisições
app.use((req, res, next) => {
  setCorsHeaders(req, res);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check (raiz e /api/health)
app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', message: 'API funcionando' });
});

// ============================================
// USUÁRIOS (existente)
// ============================================

// Registrar novo usuário
app.post('/api/users/register', async (req, res) => {
  try {
    const { codProfissional, password, fullName, role } = req.body;

    console.log('📝 Tentando registrar:', { codProfissional, fullName, role });

    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (existingUser.rows.length > 0) {
      console.log('⚠️ Código profissional já existe');
      return res.status(400).json({ error: 'Código profissional já cadastrado' });
    }

    // role pode ser 'user', 'admin' ou 'admin_financeiro'
    const validRoles = ['user', 'admin', 'admin_financeiro'];
    const userRole = validRoles.includes(role) ? role : 'user';
    
    const result = await pool.query(
      `INSERT INTO users (cod_profissional, password, full_name, role, created_at) 
       VALUES ($1, $2, $3, $4, NOW()) 
       RETURNING id, cod_profissional, full_name, role, created_at`,
      [codProfissional, password, fullName, userRole]
    );

    console.log('✅ Usuário registrado:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao registrar usuário:', error);
    res.status(500).json({ error: 'Erro ao registrar usuário: ' + error.message });
  }
});

// Login
app.post('/api/users/login', async (req, res) => {
  try {
    const { codProfissional, password } = req.body;

    console.log('🔐 Tentando login:', codProfissional);

    // Admin hardcoded
    if (codProfissional.toLowerCase() === 'admin' && password === 'admin123') {
      console.log('✅ Login admin');
      return res.json({
        id: 0,
        cod_profissional: 'admin',
        full_name: 'Administrador',
        role: 'admin'
      });
    }

    // Admin financeiro hardcoded
    if (codProfissional.toLowerCase() === 'financeiro' && password === 'fin123') {
      console.log('✅ Login admin financeiro');
      return res.json({
        id: -1,
        cod_profissional: 'financeiro',
        full_name: 'Admin Financeiro',
        role: 'admin_financeiro'
      });
    }

    const result = await pool.query(
      'SELECT id, cod_profissional, full_name, role, password, setor_id, COALESCE(allowed_modules, \'[]\') as allowed_modules, COALESCE(allowed_tabs, \'{}\') as allowed_tabs FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (result.rows.length === 0 || result.rows[0].password !== password) {
      console.log('❌ Credenciais inválidas');
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = result.rows[0];
    delete user.password;

    console.log('✅ Login bem-sucedido:', user.cod_profissional);
    res.json(user);
  } catch (error) {
    console.error('❌ Erro ao fazer login:', error);
    res.status(500).json({ error: 'Erro ao fazer login: ' + error.message });
  }
});

// Listar todos os usuários
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.cod_profissional, u.full_name, u.role, u.setor_id, u.created_at,
        s.nome as setor_nome, s.cor as setor_cor
      FROM users u
      LEFT JOIN setores s ON u.setor_id = s.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários: ' + error.message });
  }
});

// Resetar senha
app.post('/api/users/reset-password', async (req, res) => {
  try {
    const { codProfissional, newPassword } = req.body;

    const result = await pool.query(
      'UPDATE users SET password = $1 WHERE LOWER(cod_profissional) = LOWER($2) RETURNING id, cod_profissional, full_name',
      [newPassword, codProfissional]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({ message: 'Senha alterada com sucesso', user: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao resetar senha:', error);
    res.status(500).json({ error: 'Erro ao resetar senha: ' + error.message });
  }
});

// Atualizar role do usuário (Admin Master)
app.patch('/api/users/:codProfissional/role', async (req, res) => {
  try {
    const { codProfissional } = req.params;
    const { role } = req.body;
    
    // Validar roles permitidos
    const rolesPermitidos = ['user', 'admin', 'admin_financeiro', 'admin_master'];
    if (!rolesPermitidos.includes(role)) {
      return res.status(400).json({ error: 'Role inválido' });
    }
    
    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE LOWER(cod_profissional) = LOWER($2) RETURNING id, cod_profissional, full_name, role',
      [role, codProfissional]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    console.log(`👑 Role atualizado: ${codProfissional} -> ${role}`);
    res.json({ message: 'Role atualizado com sucesso', user: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao atualizar role:', error);
    res.status(500).json({ error: 'Erro ao atualizar role: ' + error.message });
  }
});

// ============================================
// ENDPOINTS DE PERMISSÕES DE ADMIN
// ============================================

// Listar todos os admins com permissões
app.get('/api/admin-permissions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.cod_profissional, u.full_name, u.role, 
             COALESCE(u.allowed_modules::text, '[]') as allowed_modules,
             COALESCE(u.allowed_tabs::text, '{}') as allowed_tabs,
             u.created_at
      FROM users u
      WHERE u.role IN ('admin', 'admin_financeiro')
      ORDER BY u.full_name
    `);
    
    // Parse JSON strings
    const rows = result.rows.map(row => {
      try {
        row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
        row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
      } catch (e) {
        row.allowed_modules = [];
        row.allowed_tabs = {};
      }
      return row;
    });
    
    res.json(rows);
  } catch (error) {
    console.error('❌ Erro ao listar permissões:', error);
    res.json([]);
  }
});

// Atualizar permissões de um admin
app.patch('/api/admin-permissions/:codProfissional', async (req, res) => {
  try {
    const { codProfissional } = req.params;
    const { allowed_modules, allowed_tabs } = req.body;
    
    // Garantir que são objetos válidos
    const modules = Array.isArray(allowed_modules) ? allowed_modules : [];
    const tabs = (allowed_tabs && typeof allowed_tabs === 'object') ? allowed_tabs : {};
    
    const result = await pool.query(`
      UPDATE users 
      SET allowed_modules = $1::jsonb, allowed_tabs = $2::jsonb
      WHERE LOWER(cod_profissional) = LOWER($3)
      RETURNING id, cod_profissional, full_name, role, allowed_modules, allowed_tabs
    `, [JSON.stringify(modules), JSON.stringify(tabs), codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'Usuário não encontrado', success: false });
    }
    
    console.log(`🔐 Permissões atualizadas: ${codProfissional}`);
    res.json({ message: 'Permissões atualizadas com sucesso', user: result.rows[0], success: true });
  } catch (error) {
    console.error('❌ Erro ao atualizar permissões:', error);
    res.json({ message: 'Erro ao atualizar', success: false, error: error.message });
  }
});

// Obter permissões de um admin específico
app.get('/api/admin-permissions/:codProfissional', async (req, res) => {
  try {
    const { codProfissional } = req.params;
    
    const result = await pool.query(`
      SELECT id, cod_profissional, full_name, role, 
             COALESCE(allowed_modules::text, '[]') as allowed_modules,
             COALESCE(allowed_tabs::text, '{}') as allowed_tabs
      FROM users
      WHERE LOWER(cod_profissional) = LOWER($1)
    `, [codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ allowed_modules: [], allowed_tabs: {} });
    }
    
    // Parse JSON strings se necessário
    const row = result.rows[0];
    try {
      row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
      row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
    } catch (e) {
      row.allowed_modules = [];
      row.allowed_tabs = {};
    }
    
    res.json(row);
  } catch (error) {
    console.error('❌ Erro ao buscar permissões:', error);
    res.json({ allowed_modules: [], allowed_tabs: {} });
  }
});

// Deletar usuário
app.delete('/api/users/:codProfissional', async (req, res) => {
  try {
    const { codProfissional } = req.params;
    
    const deletedData = {
      user: null,
      submissions: 0,
      withdrawals: 0,
      gratuities: 0,
      indicacoes: 0,
      inscricoesNovatos: 0,
      quizRespostas: 0
    };
    
    // Função auxiliar para deletar de uma tabela (ignora se tabela não existe)
    const safeDelete = async (query, params) => {
      try {
        const result = await pool.query(query, params);
        return result.rowCount || 0;
      } catch (err) {
        // Ignora erro se tabela não existe
        if (err.code === '42P01') return 0; // undefined_table
        throw err;
      }
    };
    
    // 1. Deletar submissões (solicitações de saque)
    deletedData.submissions = await safeDelete(
      'DELETE FROM submissions WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 2. Deletar saques (withdrawals)
    deletedData.withdrawals = await safeDelete(
      'DELETE FROM withdrawal_requests WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 3. Deletar gratuidades
    deletedData.gratuities = await safeDelete(
      'DELETE FROM gratuities WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 4. Deletar indicações (onde é o indicador)
    deletedData.indicacoes = await safeDelete(
      'DELETE FROM indicacoes WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 5. Deletar inscrições em promoções novatos
    deletedData.inscricoesNovatos = await safeDelete(
      'DELETE FROM inscricoes_novatos WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 6. Deletar respostas do quiz de procedimentos
    deletedData.quizRespostas = await safeDelete(
      'DELETE FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [codProfissional]
    );
    
    // 7. Por fim, deletar o usuário
    const userResult = await pool.query(
      'DELETE FROM users WHERE LOWER(cod_profissional) = LOWER($1) RETURNING *',
      [codProfissional]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    deletedData.user = userResult.rows[0];
    
    console.log(`🗑️ Usuário ${codProfissional} e todos os dados associados foram excluídos:`, deletedData);
    
    res.json({ 
      message: 'Usuário e todos os dados associados excluídos com sucesso', 
      deleted: deletedData 
    });
    
  } catch (error) {
    console.error('❌ Erro ao deletar usuário:', error);
    res.status(500).json({ error: 'Erro ao deletar usuário: ' + error.message });
  }
});

// ============================================
// SUBMISSÕES (existente)
// ============================================

app.post('/api/submissions', async (req, res) => {
  try {
    const { ordemServico, motivo, userId, userCod, userName, imagemComprovante, imagens, coordenadas } = req.body;

    const result = await pool.query(
      `INSERT INTO submissions 
       (ordem_servico, motivo, status, user_id, user_cod, user_name, 
        imagem_comprovante, imagens, coordenadas, created_at) 
       VALUES ($1, $2, 'pendente', $3, $4, $5, $6, $7, $8, NOW()) 
       RETURNING *`,
      [ordemServico, motivo, userId, userCod, userName, imagemComprovante, imagens, coordenadas]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar submissão:', error);
    res.status(500).json({ error: 'Erro ao criar submissão: ' + error.message });
  }
});

app.get('/api/submissions', async (req, res) => {
  try {
    const { userId, userCod } = req.query;

    let query = `
      SELECT 
        id, ordem_servico, motivo, status, 
        user_id, user_cod, user_name,
        CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
        LENGTH(imagem_comprovante) as tamanho_imagem,
        coordenadas, observacao,
        validated_by, validated_by_name,
        created_at, updated_at
      FROM submissions 
      ORDER BY created_at DESC
    `;
    let params = [];

    if (userId && userId !== '0') {
      query = `
        SELECT 
          id, ordem_servico, motivo, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
          LENGTH(imagem_comprovante) as tamanho_imagem,
          coordenadas, observacao,
          validated_by, validated_by_name,
          created_at, updated_at
        FROM submissions 
        WHERE user_cod = $1 
        ORDER BY created_at DESC
      `;
      params = [userCod];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar submissões:', error);
    res.status(500).json({ error: 'Erro ao listar submissões: ' + error.message });
  }
});

app.get('/api/submissions/:id/imagem', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT imagem_comprovante FROM submissions WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    res.json({ imagem: result.rows[0].imagem_comprovante });
  } catch (error) {
    console.error('❌ Erro ao buscar imagem:', error);
    res.status(500).json({ error: 'Erro ao buscar imagem: ' + error.message });
  }
});

app.patch('/api/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, observacao, validatedBy, validatedByName } = req.body;

    const result = await pool.query(
      `UPDATE submissions 
       SET status = $1, 
           observacao = $2, 
           validated_by = $3, 
           validated_by_name = $4, 
           updated_at = NOW() 
       WHERE id = $5 
       RETURNING *`,
      [status, observacao || '', validatedBy || null, validatedByName || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar submissão:', error);
    res.status(500).json({ error: 'Erro ao atualizar submissão: ' + error.message });
  }
});

app.delete('/api/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM submissions WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    res.json({ message: 'Submissão excluída com sucesso', deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar submissão:', error);
    res.status(500).json({ error: 'Erro ao deletar submissão: ' + error.message });
  }
});

// ============================================
// DADOS FINANCEIROS DO USUÁRIO
// ============================================

// Verificar se usuário aceitou termos
app.get('/api/financial/check-terms/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      'SELECT terms_accepted FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    res.json({ 
      hasAccepted: result.rows.length > 0 && result.rows[0].terms_accepted,
      hasData: result.rows.length > 0
    });
  } catch (error) {
    console.error('❌ Erro ao verificar termos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aceitar termos
app.post('/api/financial/accept-terms', async (req, res) => {
  try {
    const { userCod } = req.body;
    
    // Verificar se já existe registro
    const existing = await pool.query(
      'SELECT id FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE user_financial_data SET terms_accepted = true, terms_accepted_at = NOW() WHERE user_cod = $1',
        [userCod]
      );
    } else {
      await pool.query(
        `INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key, terms_accepted, terms_accepted_at) 
         VALUES ($1, '', '', '', true, NOW())`,
        [userCod]
      );
    }

    // Log
    await pool.query(
      'INSERT INTO financial_logs (user_cod, action, new_value) VALUES ($1, $2, $3)',
      [userCod, 'ACEITE_TERMOS', 'Termos aceitos']
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao aceitar termos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter dados financeiros do usuário
app.get('/api/financial/data/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (result.rows.length === 0) {
      return res.json({ data: null });
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao obter dados financeiros:', error);
    res.status(500).json({ error: error.message });
  }
});

// Salvar/Atualizar dados financeiros
app.post('/api/financial/data', async (req, res) => {
  try {
    const { userCod, fullName, cpf, pixKey, pixTipo } = req.body;
    
    // Verificar se já existe
    const existing = await pool.query(
      'SELECT * FROM user_financial_data WHERE user_cod = $1',
      [userCod]
    );

    if (existing.rows.length > 0) {
      const oldData = existing.rows[0];
      
      await pool.query(
        `UPDATE user_financial_data 
         SET full_name = $1, cpf = $2, pix_key = $3, pix_tipo = $4, updated_at = NOW() 
         WHERE user_cod = $5`,
        [fullName, cpf, pixKey, pixTipo || 'cpf', userCod]
      );

      // Log de alterações
      if (oldData.full_name !== fullName) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_NOME', oldData.full_name, fullName]
        );
      }
      if (oldData.cpf !== cpf) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_CPF', oldData.cpf, cpf]
        );
      }
      if (oldData.pix_key !== pixKey) {
        await pool.query(
          'INSERT INTO financial_logs (user_cod, action, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [userCod, 'ALTERACAO_PIX', oldData.pix_key, pixKey]
        );
      }
    } else {
      await pool.query(
        `INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key, pix_tipo, terms_accepted) 
         VALUES ($1, $2, $3, $4, $5, true)`,
        [userCod, fullName, cpf, pixKey, pixTipo || 'cpf']
      );

      await pool.query(
        'INSERT INTO financial_logs (user_cod, action, new_value) VALUES ($1, $2, $3)',
        [userCod, 'CADASTRO_DADOS', 'Dados financeiros cadastrados']
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar dados financeiros:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter logs de alterações
app.get('/api/financial/logs/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM financial_logs WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao obter logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HORÁRIOS DE ATENDIMENTO E AVISOS
// ============================================

// GET /api/horarios - Listar todos os horários de atendimento
app.get('/api/horarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM horarios_atendimento ORDER BY dia_semana');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários:', err);
    res.status(500).json({ error: 'Erro ao listar horários' });
  }
});

// PUT /api/horarios/:id - Atualizar horário de um dia
app.put('/api/horarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { hora_inicio, hora_fim, ativo } = req.body;
    
    const result = await pool.query(
      `UPDATE horarios_atendimento 
       SET hora_inicio = $1, hora_fim = $2, ativo = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [hora_inicio || null, hora_fim || null, ativo, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar horário:', err);
    res.status(500).json({ error: 'Erro ao atualizar horário' });
  }
});

// GET /api/horarios/especiais - Listar horários especiais
app.get('/api/horarios/especiais', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data >= CURRENT_DATE ORDER BY data'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários especiais:', err);
    res.status(500).json({ error: 'Erro ao listar horários especiais' });
  }
});

// POST /api/horarios/especiais - Criar horário especial
app.post('/api/horarios/especiais', async (req, res) => {
  try {
    const { data, descricao, hora_inicio, hora_fim, fechado } = req.body;
    
    const result = await pool.query(
      `INSERT INTO horarios_especiais (data, descricao, hora_inicio, hora_fim, fechado)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (data) DO UPDATE SET 
         descricao = $2, hora_inicio = $3, hora_fim = $4, fechado = $5
       RETURNING *`,
      [data, descricao, fechado ? null : hora_inicio, fechado ? null : hora_fim, fechado]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar horário especial:', err);
    res.status(500).json({ error: 'Erro ao criar horário especial' });
  }
});

// DELETE /api/horarios/especiais/:id - Remover horário especial
app.delete('/api/horarios/especiais/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM horarios_especiais WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover horário especial:', err);
    res.status(500).json({ error: 'Erro ao remover horário especial' });
  }
});

// GET /api/horarios/verificar - Verificar se está dentro do horário de atendimento
app.get('/api/horarios/verificar', async (req, res) => {
  try {
    const agora = new Date();
    // Ajustar para horário de Brasília (GMT-3)
    const brasiliaOffset = -3 * 60; // minutos
    const localOffset = agora.getTimezoneOffset(); // minutos
    const brasilia = new Date(agora.getTime() + (localOffset + brasiliaOffset) * 60000);
    
    const diaSemana = brasilia.getDay(); // 0=Domingo, 1=Segunda...
    const horaAtual = brasilia.toTimeString().slice(0, 5); // "HH:MM"
    const dataHoje = brasilia.toISOString().split('T')[0]; // "YYYY-MM-DD"
    
    // Verificar se há horário especial para hoje
    const especial = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data = $1',
      [dataHoje]
    );
    
    let dentroHorario = false;
    let horarioInfo = null;
    
    if (especial.rows.length > 0) {
      // Usar horário especial
      const esp = especial.rows[0];
      if (esp.fechado) {
        dentroHorario = false;
        horarioInfo = { tipo: 'especial', descricao: esp.descricao, fechado: true };
      } else {
        dentroHorario = horaAtual >= esp.hora_inicio && horaAtual <= esp.hora_fim;
        horarioInfo = { 
          tipo: 'especial', 
          descricao: esp.descricao, 
          inicio: esp.hora_inicio, 
          fim: esp.hora_fim 
        };
      }
    } else {
      // Usar horário normal do dia
      const normal = await pool.query(
        'SELECT * FROM horarios_atendimento WHERE dia_semana = $1',
        [diaSemana]
      );
      
      if (normal.rows.length > 0) {
        const hor = normal.rows[0];
        if (!hor.ativo || !hor.hora_inicio || !hor.hora_fim) {
          dentroHorario = false;
          horarioInfo = { tipo: 'normal', fechado: true, diaSemana };
        } else {
          dentroHorario = horaAtual >= hor.hora_inicio && horaAtual <= hor.hora_fim;
          horarioInfo = { 
            tipo: 'normal', 
            inicio: hor.hora_inicio, 
            fim: hor.hora_fim, 
            diaSemana 
          };
        }
      }
    }
    
    // Buscar próximo horário de atendimento
    let proximoHorario = null;
    if (!dentroHorario) {
      // Buscar próximo dia com atendimento
      for (let i = 0; i <= 7; i++) {
        const proximaData = new Date(brasilia);
        proximaData.setDate(proximaData.getDate() + i);
        const proximoDia = proximaData.getDay();
        const proximaDataStr = proximaData.toISOString().split('T')[0];
        
        // Verificar especial
        const espProx = await pool.query(
          'SELECT * FROM horarios_especiais WHERE data = $1 AND fechado = false',
          [proximaDataStr]
        );
        
        if (espProx.rows.length > 0) {
          const esp = espProx.rows[0];
          if (i === 0 && horaAtual < esp.hora_inicio) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          } else if (i > 0) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          }
        } else {
          // Verificar normal
          const norProx = await pool.query(
            'SELECT * FROM horarios_atendimento WHERE dia_semana = $1 AND ativo = true',
            [proximoDia]
          );
          
          if (norProx.rows.length > 0 && norProx.rows[0].hora_inicio) {
            const nor = norProx.rows[0];
            if (i === 0 && horaAtual < nor.hora_inicio) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            } else if (i > 0) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            }
          }
        }
      }
    }
    
    res.json({
      dentroHorario,
      horarioInfo,
      proximoHorario,
      horaAtual,
      dataHoje
    });
  } catch (err) {
    console.error('❌ Erro ao verificar horário:', err);
    res.status(500).json({ error: 'Erro ao verificar horário' });
  }
});

// GET /api/avisos - Listar avisos do financeiro
app.get('/api/avisos', async (req, res) => {
  try {
    const { ativos } = req.query;
    let query = 'SELECT * FROM avisos_financeiro';
    if (ativos === 'true') {
      query += ' WHERE ativo = true';
    }
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar avisos:', err);
    res.status(500).json({ error: 'Erro ao listar avisos' });
  }
});

// POST /api/avisos - Criar aviso
app.post('/api/avisos', async (req, res) => {
  try {
    const { titulo, mensagem, tipo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `INSERT INTO avisos_financeiro (titulo, mensagem, tipo, exibir_fora_horario)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [titulo, mensagem, tipo || 'info', exibir_fora_horario || false]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar aviso:', err);
    res.status(500).json({ error: 'Erro ao criar aviso' });
  }
});

// PUT /api/avisos/:id - Atualizar aviso
app.put('/api/avisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, mensagem, tipo, ativo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `UPDATE avisos_financeiro 
       SET titulo = $1, mensagem = $2, tipo = $3, ativo = $4, exibir_fora_horario = $5, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [titulo, mensagem, tipo, ativo, exibir_fora_horario, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar aviso:', err);
    res.status(500).json({ error: 'Erro ao atualizar aviso' });
  }
});

// DELETE /api/avisos/:id - Remover aviso
app.delete('/api/avisos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM avisos_financeiro WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover aviso:', err);
    res.status(500).json({ error: 'Erro ao remover aviso' });
  }
});

// ============================================
// SOLICITAÇÕES DE SAQUE
// ============================================

// Criar solicitação de saque
app.post('/api/withdrawals', async (req, res) => {
  try {
    const { userCod, userName, cpf, pixKey, requestedAmount } = req.body;

    // Verificar se está restrito
    const restricted = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );
    const isRestricted = restricted.rows.length > 0;

    // Verificar gratuidade ativa
    const gratuity = await pool.query(
      "SELECT * FROM gratuities WHERE user_cod = $1 AND status = 'ativa' AND remaining > 0 ORDER BY created_at ASC LIMIT 1",
      [userCod]
    );
    
    const hasGratuity = gratuity.rows.length > 0;
    let gratuityId = null;
    let feeAmount = requestedAmount * 0.045; // 4.5%
    let finalAmount = requestedAmount - feeAmount;

    if (hasGratuity) {
      gratuityId = gratuity.rows[0].id;
      feeAmount = 0;
      finalAmount = requestedAmount;

      // Decrementar gratuidade
      const newRemaining = gratuity.rows[0].remaining - 1;
      if (newRemaining <= 0) {
        await pool.query(
          "UPDATE gratuities SET remaining = 0, status = 'expirada', expired_at = NOW() WHERE id = $1",
          [gratuityId]
        );
      } else {
        await pool.query(
          'UPDATE gratuities SET remaining = $1 WHERE id = $2',
          [newRemaining, gratuityId]
        );
      }
    }

    const result = await pool.query(
      `INSERT INTO withdrawal_requests 
       (user_cod, user_name, cpf, pix_key, requested_amount, fee_amount, final_amount, has_gratuity, gratuity_id, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aguardando_aprovacao') 
       RETURNING *`,
      [userCod, userName, cpf, pixKey, requestedAmount, feeAmount, finalAmount, hasGratuity, gratuityId]
    );

    res.status(201).json({ 
      ...result.rows[0], 
      isRestricted 
    });
  } catch (error) {
    console.error('❌ Erro ao criar saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar saques do usuário
app.get('/api/withdrawals/user/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    // Adicionar verificação de atraso (mais de 1 hora)
    const now = new Date();
    const withdrawals = result.rows.map(w => {
      const createdAt = new Date(w.created_at);
      const diffMs = now - createdAt;
      const diffHours = diffMs / (1000 * 60 * 60);
      
      return {
        ...w,
        isDelayed: w.status === 'aguardando_aprovacao' && diffHours > 1
      };
    });

    res.json(withdrawals);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar todos os saques (admin financeiro)
app.get('/api/withdrawals', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT w.*, 
        CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
        r.reason as restriction_reason
      FROM withdrawal_requests w
      LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
      ORDER BY w.created_at DESC
    `;
    
    if (status) {
      query = `
        SELECT w.*, 
          CASE WHEN r.id IS NOT NULL THEN true ELSE false END as is_restricted,
          r.reason as restriction_reason
        FROM withdrawal_requests w
        LEFT JOIN restricted_professionals r ON w.user_cod = r.user_cod AND r.status = 'ativo'
        WHERE w.status = $1
        ORDER BY w.created_at DESC
      `;
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar status do saque
app.patch('/api/withdrawals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminId, adminName, rejectReason } = req.body;

    // Se status for aprovado ou aprovado_gratuidade, salvar a data de aprovação
    const isAprovado = status === 'aprovado' || status === 'aprovado_gratuidade';
    
    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET status = $1, admin_id = $2, admin_name = $3, reject_reason = $4, 
           approved_at = CASE WHEN $5 THEN NOW() ELSE approved_at END,
           updated_at = NOW() 
       WHERE id = $6 
       RETURNING *`,
      [status, adminId, adminName, rejectReason || null, isAprovado, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Excluir saque
app.delete('/api/withdrawals/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM withdrawal_requests WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('🗑️ Saque excluído:', id);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar conciliação/débito
app.patch('/api/withdrawals/:id/conciliacao', async (req, res) => {
  try {
    const { id } = req.params;
    const { conciliacaoOmie, debito } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET conciliacao_omie = COALESCE($1, conciliacao_omie), 
           debito = COALESCE($2, debito),
           updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [conciliacaoOmie, debito, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar conciliação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar débito com data/hora
app.patch('/api/withdrawals/:id/debito', async (req, res) => {
  try {
    const { id } = req.params;
    const { debito, debitoAt } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET debito = $1, debito_at = $2, updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [debito, debitoAt, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💳 Débito atualizado:', id, debito, debitoAt);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar débito:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar status do saldo
app.patch('/api/withdrawals/:id/saldo', async (req, res) => {
  try {
    const { id } = req.params;
    const { saldoStatus } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET saldo_status = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [saldoStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💰 Saldo status atualizado:', id, saldoStatus);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar saldo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard de conciliação
app.get('/api/withdrawals/dashboard/conciliacao', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')) as total_aprovados,
        COUNT(*) FILTER (WHERE conciliacao_omie = true) as total_conciliado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND conciliacao_omie = false) as pendente_conciliacao,
        COUNT(*) FILTER (WHERE debito = true) as total_debitado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND debito = false) as pendente_debito,
        COALESCE(SUM(final_amount) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')), 0) as valor_total_aprovado,
        COALESCE(SUM(final_amount) FILTER (WHERE conciliacao_omie = true), 0) as valor_conciliado,
        COALESCE(SUM(final_amount) FILTER (WHERE debito = true), 0) as valor_debitado
      FROM withdrawal_requests
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao obter dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GRATUIDADES
// ============================================

// Listar todas as gratuidades
app.get('/api/gratuities', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM gratuities ORDER BY created_at DESC';
    if (status) {
      query = 'SELECT * FROM gratuities WHERE status = $1 ORDER BY created_at DESC';
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar gratuidades do usuário
app.get('/api/gratuities/user/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM gratuities WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar gratuidade
app.post('/api/gratuities', async (req, res) => {
  try {
    const { userCod, userName, quantity, value, reason, createdBy } = req.body;

    const result = await pool.query(
      `INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, 'ativa', $7) 
       RETURNING *`,
      [userCod, userName || null, quantity, quantity, value, reason || null, createdBy || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar gratuidade:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar gratuidade
app.delete('/api/gratuities/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM gratuities WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gratuidade não encontrada' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao deletar gratuidade:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROFISSIONAIS RESTRITOS
// ============================================

// Listar todos os restritos
app.get('/api/restricted', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM restricted_professionals ORDER BY created_at DESC';
    if (status) {
      query = 'SELECT * FROM restricted_professionals WHERE status = $1 ORDER BY created_at DESC';
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar restritos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar se usuário está restrito
app.get('/api/restricted/check/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    res.json({ 
      isRestricted: result.rows.length > 0,
      restriction: result.rows[0] || null
    });
  } catch (error) {
    console.error('❌ Erro ao verificar restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// Adicionar restrição
app.post('/api/restricted', async (req, res) => {
  try {
    const { userCod, userName, reason, createdBy } = req.body;

    // Verificar se já existe e está ativo
    const existing = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Profissional já está restrito' });
    }

    // Verificar se existe registro inativo (para reativar)
    const inactive = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status != 'ativo'",
      [userCod]
    );

    let result;
    if (inactive.rows.length > 0) {
      // Reativar registro existente
      result = await pool.query(
        `UPDATE restricted_professionals 
         SET user_name = $2, reason = $3, status = 'ativo', created_by = $4, created_at = NOW(), removed_at = NULL, removed_reason = NULL
         WHERE user_cod = $1
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    } else {
      // Criar novo registro
      result = await pool.query(
        `INSERT INTO restricted_professionals (user_cod, user_name, reason, status, created_by) 
         VALUES ($1, $2, $3, 'ativo', $4) 
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao adicionar restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remover restrição
app.patch('/api/restricted/:id/remove', async (req, res) => {
  try {
    const { id } = req.params;
    const { removedReason } = req.body;

    const result = await pool.query(
      `UPDATE restricted_professionals 
       SET status = 'removido', removed_at = NOW(), removed_reason = $1 
       WHERE id = $2 
       RETURNING *`,
      [removedReason || 'Restrição suspensa', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao remover restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NOTIFICAÇÕES (existente)
// ============================================

app.post('/api/notifications', async (req, res) => {
  try {
    const { message, type, forUser } = req.body;

    const result = await pool.query(
      `INSERT INTO notifications (message, type, for_user, created_at) 
       VALUES ($1, $2, $3, NOW()) 
       RETURNING *`,
      [message, type, forUser]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar notificação:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/notifications/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;

    const result = await pool.query(
      "SELECT * FROM notifications WHERE for_user = $1 OR for_user = 'admin' ORDER BY created_at DESC LIMIT 50",
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar notificações:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// RECUPERAÇÃO DE SENHA
// ============================================

// Solicitar recuperação de senha
app.post('/api/password-recovery', async (req, res) => {
  try {
    const { cod, name } = req.body;

    console.log('🔐 Solicitação de recuperação:', { cod, name });

    // Verificar se usuário existe
    const userResult = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [cod]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Código profissional não encontrado' });
    }

    const user = userResult.rows[0];

    // Verificar se o nome confere (para segurança)
    if (user.full_name.toLowerCase().trim() !== name.toLowerCase().trim()) {
      return res.status(400).json({ error: 'Nome não confere com o cadastro' });
    }

    // Verificar se já existe solicitação pendente
    const existingRequest = await pool.query(
      "SELECT * FROM password_recovery WHERE LOWER(user_cod) = LOWER($1) AND status = 'pendente'",
      [cod]
    );

    if (existingRequest.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma solicitação pendente para este código' });
    }

    // Criar solicitação
    const result = await pool.query(
      `INSERT INTO password_recovery (user_cod, user_name, status, created_at) 
       VALUES ($1, $2, 'pendente', NOW()) 
       RETURNING *`,
      [cod, name]
    );

    console.log('✅ Solicitação de recuperação criada:', result.rows[0]);
    res.status(201).json({ success: true, message: 'Solicitação enviada com sucesso' });
  } catch (error) {
    console.error('❌ Erro na recuperação de senha:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar solicitações de recuperação (admin)
app.get('/api/password-recovery', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM password_recovery ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar recuperações:', error);
    res.status(500).json({ error: error.message });
  }
});

// Resetar senha (admin)
app.patch('/api/password-recovery/:id/reset', async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword, adminName } = req.body;

    console.log('🔐 Resetando senha, ID:', id);

    // Buscar solicitação
    const requestResult = await pool.query(
      'SELECT * FROM password_recovery WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }

    const request = requestResult.rows[0];

    // Atualizar senha do usuário
    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE LOWER(cod_profissional) = LOWER($2)',
      [newPassword, request.user_cod]
    );

    // Marcar solicitação como resolvida
    const result = await pool.query(
      `UPDATE password_recovery 
       SET status = 'resolvido', new_password = $1, resolved_at = NOW(), resolved_by = $2 
       WHERE id = $3 
       RETURNING *`,
      [newPassword, adminName, id]
    );

    console.log('✅ Senha resetada com sucesso');
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao resetar senha:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancelar solicitação (admin)
app.delete('/api/password-recovery/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM password_recovery WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar solicitação:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROMOÇÕES DE INDICAÇÃO
// ============================================

// Listar promoções
app.get('/api/promocoes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promocoes_indicacao ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar promoções ativas (para usuário)
app.get('/api/promocoes/ativas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promocoes_indicacao WHERE status = 'ativa' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções ativas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar promoção
app.post('/api/promocoes', async (req, res) => {
  try {
    const { regiao, valor_bonus, detalhes, created_by } = req.body;

    console.log('📣 Criando promoção:', { regiao, valor_bonus, detalhes });

    const result = await pool.query(
      `INSERT INTO promocoes_indicacao (regiao, valor_bonus, detalhes, status, created_by, created_at) 
       VALUES ($1, $2, $3, 'ativa', $4, NOW()) 
       RETURNING *`,
      [regiao, valor_bonus, detalhes || null, created_by]
    );

    console.log('✅ Promoção criada:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar promoção (status ou dados completos)
app.patch('/api/promocoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, regiao, valor_bonus, detalhes } = req.body;

    let result;
    
    // Se só veio status, atualiza só o status
    if (status && !regiao && !valor_bonus) {
      result = await pool.query(
        'UPDATE promocoes_indicacao SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      // Atualização completa
      result = await pool.query(
        'UPDATE promocoes_indicacao SET regiao = COALESCE($1, regiao), valor_bonus = COALESCE($2, valor_bonus), detalhes = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
        [regiao, valor_bonus, detalhes, id]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promoção não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// Excluir promoção
app.delete('/api/promocoes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM promocoes_indicacao WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promoção não encontrada' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INDICAÇÕES
// ============================================

// Listar todas as indicações (admin)
app.get('/api/indicacoes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM indicacoes ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar indicações do usuário
app.get('/api/indicacoes/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações do usuário:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar indicação
app.post('/api/indicacoes', async (req, res) => {
  try {
    const { promocao_id, user_cod, user_name, indicado_nome, indicado_cpf, indicado_contato, valor_bonus, regiao } = req.body;

    console.log('👥 Criando indicação:', { user_cod, indicado_nome });

    // Calcular data de expiração (30 dias)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const result = await pool.query(
      `INSERT INTO indicacoes (promocao_id, user_cod, user_name, indicado_nome, indicado_cpf, indicado_contato, valor_bonus, regiao, status, created_at, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW(), $9) 
       RETURNING *`,
      [promocao_id, user_cod, user_name, indicado_nome, indicado_cpf || null, indicado_contato, valor_bonus, regiao, expiresAt]
    );

    console.log('✅ Indicação criada:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aprovar indicação
app.patch('/api/indicacoes/:id/aprovar', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'aprovada', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING *`,
      [resolved_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('✅ Indicação aprovada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao aprovar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rejeitar indicação
app.patch('/api/indicacoes/:id/rejeitar', async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo_rejeicao, resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'rejeitada', motivo_rejeicao = $1, resolved_at = NOW(), resolved_by = $2 
       WHERE id = $3 
       RETURNING *`,
      [motivo_rejeicao, resolved_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('❌ Indicação rejeitada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao rejeitar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar crédito lançado
app.patch('/api/indicacoes/:id/credito', async (req, res) => {
  try {
    const { id } = req.params;
    const { credito_lancado, lancado_por } = req.body;

    console.log('💰 Atualizando crédito:', { id, credito_lancado, lancado_por });

    const result = await pool.query(
      `UPDATE indicacoes 
       SET credito_lancado = $1, lancado_por = $2, lancado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [credito_lancado, credito_lancado ? lancado_por : null, credito_lancado ? new Date() : null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('✅ Crédito atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar crédito:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar e expirar indicações antigas (pode ser chamado periodicamente)
app.post('/api/indicacoes/verificar-expiradas', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'expirada' 
       WHERE status = 'pendente' AND expires_at < NOW() 
       RETURNING *`
    );

    console.log(`⏰ ${result.rows.length} indicações expiradas`);
    res.json({ expiradas: result.rows.length, indicacoes: result.rows });
  } catch (error) {
    console.error('❌ Erro ao verificar expiradas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NOVO SISTEMA DE LINKS DE INDICAÇÃO
// ============================================

// Gerar token único
const gerarTokenIndicacao = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

// Gerar ou obter link de indicação do usuário
app.post('/api/indicacao-link/gerar', async (req, res) => {
  try {
    const { user_cod, user_name, promocao_id, regiao, valor_bonus } = req.body;
    
    if (!user_cod || !user_name) {
      return res.status(400).json({ error: 'user_cod e user_name são obrigatórios' });
    }
    
    // Gerar novo token único (sempre gera um novo para cada promoção)
    let token = gerarTokenIndicacao();
    let tentativas = 0;
    while (tentativas < 10) {
      const existe = await pool.query('SELECT id FROM indicacao_links WHERE token = $1', [token]);
      if (existe.rows.length === 0) break;
      token = gerarTokenIndicacao();
      tentativas++;
    }
    
    // Criar novo link com dados da promoção
    const result = await pool.query(
      `INSERT INTO indicacao_links (user_cod, user_name, token, promocao_id, regiao, valor_bonus) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user_cod, user_name, token, promocao_id || null, regiao || null, valor_bonus || null]
    );
    
    console.log('✅ Link de indicação gerado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao gerar link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter link existente do usuário
app.get('/api/indicacao-link/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacao_links WHERE LOWER(user_cod) = LOWER($1) AND active = TRUE',
      [userCod]
    );
    res.json(result.rows[0] || null);
  } catch (error) {
    console.error('❌ Erro ao buscar link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Validar token (público - para página de cadastro)
app.get('/api/indicacao-link/validar/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      'SELECT user_cod, user_name FROM indicacao_links WHERE token = $1 AND active = TRUE',
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }
    
    res.json({ valido: true, indicador: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao validar token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cadastrar indicado via link (público)
app.post('/api/indicacao-link/cadastrar', async (req, res) => {
  try {
    const { token, nome, telefone } = req.body;
    
    if (!token || !nome || !telefone) {
      return res.status(400).json({ error: 'Token, nome e telefone são obrigatórios' });
    }
    
    // Validar token e pegar dados da promoção
    const linkResult = await pool.query(
      'SELECT * FROM indicacao_links WHERE token = $1 AND active = TRUE',
      [token]
    );
    
    if (linkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }
    
    const link = linkResult.rows[0];
    
    // Verificar se este telefone já foi indicado por este usuário
    const jaIndicado = await pool.query(
      `SELECT id FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) AND indicado_contato = $2`,
      [link.user_cod, telefone]
    );
    
    if (jaIndicado.rows.length > 0) {
      return res.status(400).json({ error: 'Este telefone já foi indicado anteriormente' });
    }
    
    // Criar indicação com dados da promoção
    const result = await pool.query(
      `INSERT INTO indicacoes (user_cod, user_name, indicado_nome, indicado_contato, link_token, promocao_id, regiao, valor_bonus, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW()) RETURNING *`,
      [link.user_cod, link.user_name, nome, telefone, token, link.promocao_id, link.regiao, link.valor_bonus]
    );
    
    console.log('✅ Indicação via link cadastrada:', result.rows[0]);
    res.json({ success: true, indicacao: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao cadastrar indicado:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar indicações recebidas via link (para admin)
app.get('/api/indicacao-link/indicacoes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM indicacoes WHERE link_token IS NOT NULL ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações via link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Estatísticas de indicações por usuário
app.get('/api/indicacao-link/estatisticas/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'pendente' THEN 1 END) as pendentes,
        COUNT(CASE WHEN status = 'aprovada' THEN 1 END) as aprovadas,
        COUNT(CASE WHEN status = 'rejeitada' THEN 1 END) as rejeitadas
       FROM indicacoes 
       WHERE LOWER(user_cod) = LOWER($1) AND link_token IS NOT NULL`,
      [userCod]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROMOÇÕES NOVATOS
// ============================================

// Listar todas as promoções de novatos
app.get('/api/promocoes-novatos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promocoes_novatos ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar promoções ativas (para usuários)
app.get('/api/promocoes-novatos/ativas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promocoes_novatos WHERE status = 'ativa' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções ativas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar nova promoção novatos
app.post('/api/promocoes-novatos', async (req, res) => {
  try {
    const { regiao, cliente, valor_bonus, detalhes, created_by } = req.body;

    const result = await pool.query(
      `INSERT INTO promocoes_novatos (regiao, cliente, valor_bonus, detalhes, status, created_by, created_at) 
       VALUES ($1, $2, $3, $4, 'ativa', $5, NOW()) 
       RETURNING *`,
      [regiao, cliente, valor_bonus, detalhes || null, created_by || 'Admin']
    );

    console.log('✅ Promoção novatos criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar promoção novatos (status ou dados)
app.patch('/api/promocoes-novatos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, regiao, cliente, valor_bonus, detalhes } = req.body;

    let result;
    if (status && !regiao) {
      // Apenas atualizar status
      result = await pool.query(
        'UPDATE promocoes_novatos SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      // Atualizar todos os campos
      result = await pool.query(
        'UPDATE promocoes_novatos SET regiao = COALESCE($1, regiao), cliente = COALESCE($2, cliente), valor_bonus = COALESCE($3, valor_bonus), detalhes = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
        [regiao, cliente, valor_bonus, detalhes, id]
      );
    }

    console.log('✅ Promoção novatos atualizada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar promoção novatos
app.delete('/api/promocoes-novatos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se tem inscrições pendentes
    const inscricoes = await pool.query(
      "SELECT COUNT(*) FROM inscricoes_novatos WHERE promocao_id = $1 AND status = 'pendente'",
      [id]
    );
    
    if (parseInt(inscricoes.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Não é possível deletar promoção com inscrições pendentes' });
    }

    const result = await pool.query(
      'DELETE FROM promocoes_novatos WHERE id = $1 RETURNING *',
      [id]
    );

    console.log('🗑️ Promoção novatos deletada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao deletar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INSCRIÇÕES NOVATOS
// ============================================

// Listar todas as inscrições (admin)
app.get('/api/inscricoes-novatos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM inscricoes_novatos ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar inscrições novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar inscrições de um usuário
app.get('/api/inscricoes-novatos/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar inscrições do usuário:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar inscrição novatos (usuário se inscreve)
app.post('/api/inscricoes-novatos', async (req, res) => {
  try {
    const { promocao_id, user_cod, user_name, valor_bonus, regiao, cliente } = req.body;

    // Verificar se já está inscrito nesta promoção
    const existing = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE promocao_id = $1 AND LOWER(user_cod) = LOWER($2)',
      [promocao_id, user_cod]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Você já está inscrito nesta promoção' });
    }

    // Criar inscrição com expiração em 10 dias
    const result = await pool.query(
      `INSERT INTO inscricoes_novatos (promocao_id, user_cod, user_name, valor_bonus, regiao, cliente, status, created_at, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW(), NOW() + INTERVAL '10 days') 
       RETURNING *`,
      [promocao_id, user_cod, user_name, valor_bonus, regiao, cliente]
    );

    console.log('✅ Inscrição novatos criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aprovar inscrição novatos
app.patch('/api/inscricoes-novatos/:id/aprovar', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'aprovada', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING *`,
      [resolved_by || 'Admin', id]
    );

    console.log('✅ Inscrição novatos aprovada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao aprovar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rejeitar inscrição novatos
app.patch('/api/inscricoes-novatos/:id/rejeitar', async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo_rejeicao, resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'rejeitada', motivo_rejeicao = $1, resolved_at = NOW(), resolved_by = $2 
       WHERE id = $3 
       RETURNING *`,
      [motivo_rejeicao, resolved_by || 'Admin', id]
    );

    console.log('❌ Inscrição novatos rejeitada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao rejeitar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar crédito lançado para inscrição novatos
app.patch('/api/inscricoes-novatos/:id/credito', async (req, res) => {
  try {
    const { id } = req.params;
    const { credito_lancado, lancado_por } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET credito_lancado = $1, lancado_por = $2, lancado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [credito_lancado, lancado_por, credito_lancado ? new Date() : null, id]
    );

    console.log('💰 Crédito novatos atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar crédito novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar e expirar inscrições novatos antigas (chamado periodicamente)
app.post('/api/inscricoes-novatos/verificar-expiradas', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'expirada' 
       WHERE status = 'pendente' AND expires_at < NOW() 
       RETURNING *`
    );

    console.log(`⏰ ${result.rows.length} inscrições novatos expiradas`);
    res.json({ expiradas: result.rows.length, inscricoes: result.rows });
  } catch (error) {
    console.error('❌ Erro ao verificar expiradas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar débito para inscrição novatos
app.patch('/api/inscricoes-novatos/:id/debito', async (req, res) => {
  try {
    const { id } = req.params;
    const { debito, debitado_por } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET debito = $1, debitado_por = $2, debitado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [debito, debitado_por, debito ? new Date() : null, id]
    );

    console.log('💳 Débito novatos atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar débito novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// QUIZ DE PROCEDIMENTOS (Promoção Novato)
// ============================================

// Obter configuração do quiz
app.get('/api/quiz-procedimentos/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) {
      // Retorna config padrão vazia
      return res.json({
        titulo: 'Acerte os procedimentos e ganhe saque gratuito de R$ 500,00',
        imagens: [null, null, null, null],
        perguntas: [
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true }
        ],
        valor_gratuidade: 500.00,
        ativo: false
      });
    }
    const config = result.rows[0];
    res.json({
      id: config.id,
      titulo: config.titulo,
      imagens: [config.imagem1, config.imagem2, config.imagem3, config.imagem4],
      perguntas: [
        { texto: config.pergunta1, resposta: config.resposta1 },
        { texto: config.pergunta2, resposta: config.resposta2 },
        { texto: config.pergunta3, resposta: config.resposta3 },
        { texto: config.pergunta4, resposta: config.resposta4 },
        { texto: config.pergunta5, resposta: config.resposta5 }
      ],
      valor_gratuidade: parseFloat(config.valor_gratuidade),
      ativo: config.ativo
    });
  } catch (error) {
    console.error('❌ Erro ao obter config quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Salvar configuração do quiz
app.post('/api/quiz-procedimentos/config', async (req, res) => {
  try {
    const { titulo, imagens, perguntas, valor_gratuidade, ativo } = req.body;
    
    // Verificar se já existe config
    const existing = await pool.query('SELECT id FROM quiz_procedimentos_config LIMIT 1');
    
    if (existing.rows.length > 0) {
      // Atualizar
      await pool.query(
        `UPDATE quiz_procedimentos_config SET 
          titulo = $1,
          imagem1 = $2, imagem2 = $3, imagem3 = $4, imagem4 = $5,
          pergunta1 = $6, resposta1 = $7,
          pergunta2 = $8, resposta2 = $9,
          pergunta3 = $10, resposta3 = $11,
          pergunta4 = $12, resposta4 = $13,
          pergunta5 = $14, resposta5 = $15,
          valor_gratuidade = $16, ativo = $17, updated_at = NOW()
        WHERE id = $18`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo,
          existing.rows[0].id
        ]
      );
    } else {
      // Inserir
      await pool.query(
        `INSERT INTO quiz_procedimentos_config 
          (titulo, imagem1, imagem2, imagem3, imagem4, 
           pergunta1, resposta1, pergunta2, resposta2, pergunta3, resposta3,
           pergunta4, resposta4, pergunta5, resposta5, valor_gratuidade, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo
        ]
      );
    }
    
    console.log('✅ Config quiz salva');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar config quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar se usuário já respondeu o quiz
app.get('/api/quiz-procedimentos/verificar/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [userCod]
    );
    res.json({ 
      ja_respondeu: result.rows.length > 0,
      dados: result.rows[0] || null
    });
  } catch (error) {
    console.error('❌ Erro ao verificar quiz:', error);
    res.json({ ja_respondeu: false });
  }
});

// Responder o quiz
app.post('/api/quiz-procedimentos/responder', async (req, res) => {
  try {
    const { user_cod, user_name, respostas } = req.body;
    
    // Verificar se já respondeu
    const existing = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [user_cod]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Você já respondeu este quiz' });
    }
    
    // Buscar config para verificar respostas corretas
    const configResult = await pool.query('SELECT * FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1');
    if (configResult.rows.length === 0) {
      return res.status(400).json({ error: 'Quiz não configurado' });
    }
    
    const config = configResult.rows[0];
    const respostasCorretas = [
      config.resposta1, config.resposta2, config.resposta3, config.resposta4, config.resposta5
    ];
    
    // Contar acertos
    let acertos = 0;
    for (let i = 0; i < 5; i++) {
      if (respostas[i] === respostasCorretas[i]) acertos++;
    }
    
    const passou = acertos === 5;
    
    // Registrar resposta
    await pool.query(
      `INSERT INTO quiz_procedimentos_respostas (user_cod, user_name, acertos, passou, gratuidade_criada)
       VALUES ($1, $2, $3, $4, $5)`,
      [user_cod, user_name, acertos, passou, passou]
    );
    
    // Se passou, criar gratuidade automaticamente
    if (passou) {
      await pool.query(
        `INSERT INTO gratuities (user_cod, quantity, remaining, value, reason, status, created_at)
         VALUES ($1, 1, 1, $2, 'Promoção Novato', 'ativa', NOW())`,
        [user_cod, config.valor_gratuidade]
      );
      console.log(`🎉 Gratuidade criada para ${user_name} (${user_cod}): R$ ${config.valor_gratuidade}`);
    }
    
    res.json({ 
      success: true, 
      acertos, 
      passou,
      valor_gratuidade: passou ? parseFloat(config.valor_gratuidade) : 0
    });
  } catch (error) {
    console.error('❌ Erro ao responder quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar quem respondeu o quiz (admin)
app.get('/api/quiz-procedimentos/respostas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar respostas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DISPONIBILIDADE - ROTAS
// ============================================

// GET /api/disponibilidade - Lista todas as regiões, lojas e linhas
app.get('/api/disponibilidade', async (req, res) => {
  try {
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    res.json({
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar disponibilidade:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// POST /api/disponibilidade/regioes - Criar região
app.post('/api/disponibilidade/regioes', async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
    
    const result = await pool.query(
      'INSERT INTO disponibilidade_regioes (nome) VALUES ($1) RETURNING *',
      [nome.toUpperCase().trim()]
    );
    console.log('✅ Região criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Região já existe' });
    }
    console.error('❌ Erro ao criar região:', err);
    res.status(500).json({ error: 'Erro ao criar região' });
  }
});

// PUT /api/disponibilidade/regioes/:id - Atualizar região
app.put('/api/disponibilidade/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, gestores, ordem } = req.body;
    
    const result = await pool.query(
      `UPDATE disponibilidade_regioes 
       SET nome = COALESCE($1, nome), gestores = COALESCE($2, gestores), ordem = COALESCE($3, ordem), updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [nome ? nome.toUpperCase().trim() : null, gestores !== undefined ? gestores : null, ordem, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// DELETE /api/disponibilidade/regioes/:id - Deletar região
app.delete('/api/disponibilidade/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_regioes WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    console.log('🗑️ Região deletada:', result.rows[0]);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar região:', err);
    res.status(500).json({ error: 'Erro ao deletar região' });
  }
});

// POST /api/disponibilidade/lojas - Criar loja com linhas
app.post('/api/disponibilidade/lojas', async (req, res) => {
  try {
    const { regiao_id, codigo, nome, qtd_titulares, qtd_excedentes } = req.body;
    
    if (!regiao_id || !codigo || !nome) {
      return res.status(400).json({ error: 'Campos obrigatórios: regiao_id, codigo, nome' });
    }
    
    // Verificar se região existe
    const regiaoCheck = await pool.query('SELECT id FROM disponibilidade_regioes WHERE id = $1', [regiao_id]);
    if (regiaoCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Região não encontrada' });
    }
    
    const titulares = Math.min(parseInt(qtd_titulares) || 0, 50);
    const excedentes = Math.min(parseInt(qtd_excedentes) || 0, 50);
    
    // Criar loja
    const lojaResult = await pool.query(
      'INSERT INTO disponibilidade_lojas (regiao_id, codigo, nome, qtd_titulares, qtd_excedentes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [regiao_id, codigo.trim(), nome.toUpperCase().trim(), titulares, excedentes]
    );
    const loja = lojaResult.rows[0];
    
    // Criar linhas vazias
    const linhas = [];
    
    // Criar linhas de titulares
    for (let i = 0; i < titulares; i++) {
      const linhaResult = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja.id, 'A CONFIRMAR', false]
      );
      linhas.push(linhaResult.rows[0]);
    }
    
    // Criar linhas de excedentes
    for (let i = 0; i < excedentes; i++) {
      const linhaResult = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja.id, 'A CONFIRMAR', true]
      );
      linhas.push(linhaResult.rows[0]);
    }
    
    console.log('✅ Loja criada:', loja.nome, 'com', titulares, 'titulares e', excedentes, 'excedentes');
    res.json({ loja, linhas });
  } catch (err) {
    console.error('❌ Erro ao criar loja:', err);
    res.status(500).json({ error: 'Erro ao criar loja' });
  }
});

// PUT /api/disponibilidade/lojas/:id - Atualizar loja
app.put('/api/disponibilidade/lojas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { codigo, nome, qtd_titulares, qtd_excedentes, ordem } = req.body;
    
    const result = await pool.query(
      `UPDATE disponibilidade_lojas 
       SET codigo = COALESCE($1, codigo), 
           nome = COALESCE($2, nome), 
           qtd_titulares = COALESCE($3, qtd_titulares),
           qtd_excedentes = COALESCE($4, qtd_excedentes),
           ordem = COALESCE($5, ordem), 
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [codigo, nome ? nome.toUpperCase().trim() : null, qtd_titulares, qtd_excedentes, ordem, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Loja não encontrada' });
    }
    console.log('✅ Loja atualizada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar loja:', err);
    res.status(500).json({ error: 'Erro ao atualizar loja' });
  }
});

// DELETE /api/disponibilidade/lojas/:id - Deletar loja
app.delete('/api/disponibilidade/lojas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_lojas WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Loja não encontrada' });
    }
    console.log('🗑️ Loja deletada:', result.rows[0]);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar loja:', err);
    res.status(500).json({ error: 'Erro ao deletar loja' });
  }
});

// POST /api/disponibilidade/linhas - Adicionar linhas a uma loja
app.post('/api/disponibilidade/linhas', async (req, res) => {
  try {
    const { loja_id, quantidade, is_excedente } = req.body;
    
    if (!loja_id) {
      return res.status(400).json({ error: 'loja_id é obrigatório' });
    }
    
    // Verificar se loja existe
    const lojaCheck = await pool.query('SELECT id FROM disponibilidade_lojas WHERE id = $1', [loja_id]);
    if (lojaCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Loja não encontrada' });
    }
    
    const qtd = Math.min(parseInt(quantidade) || 1, 50);
    const excedente = is_excedente === true;
    const linhas = [];
    
    for (let i = 0; i < qtd; i++) {
      const result = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja_id, 'A CONFIRMAR', excedente]
      );
      linhas.push(result.rows[0]);
    }
    
    console.log('✅', qtd, excedente ? 'excedente(s)' : 'titular(es)', 'adicionado(s) à loja', loja_id);
    res.json(linhas);
  } catch (err) {
    console.error('❌ Erro ao criar linhas:', err);
    res.status(500).json({ error: 'Erro ao criar linhas' });
  }
});

// PUT /api/disponibilidade/linhas/:id - Atualizar linha
app.put('/api/disponibilidade/linhas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { cod_profissional, nome_profissional, status, observacao, observacao_usuario } = req.body;
    
    // Validar status - incluindo SEM CONTATO e A CAMINHO
    const statusValidos = ['A CONFIRMAR', 'CONFIRMADO', 'A CAMINHO', 'EM LOJA', 'FALTANDO', 'SEM CONTATO'];
    const statusFinal = statusValidos.includes(status) ? status : 'A CONFIRMAR';
    
    // Buscar linha atual para verificar se observação mudou
    const linhaAtual = await pool.query('SELECT observacao FROM disponibilidade_linhas WHERE id = $1', [id]);
    const obsAtual = linhaAtual.rows[0]?.observacao || '';
    const obsNova = observacao || '';
    
    // Se observação foi adicionada ou modificada, registrar quem e quando
    let observacaoCriadaPor = null;
    let observacaoCriadaEm = null;
    
    if (obsNova && obsNova !== obsAtual) {
      // Observação foi modificada ou criada - registrar metadados
      observacaoCriadaPor = observacao_usuario || 'Sistema';
      observacaoCriadaEm = new Date();
    } else if (obsNova) {
      // Observação não mudou - manter os metadados existentes
      const metadados = await pool.query(
        'SELECT observacao_criada_por, observacao_criada_em FROM disponibilidade_linhas WHERE id = $1',
        [id]
      );
      if (metadados.rows.length > 0) {
        observacaoCriadaPor = metadados.rows[0].observacao_criada_por;
        observacaoCriadaEm = metadados.rows[0].observacao_criada_em;
      }
    }
    // Se observação foi removida (obsNova vazio), os metadados ficam null
    
    const result = await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = $1, 
           nome_profissional = $2, 
           status = $3, 
           observacao = $4,
           observacao_criada_por = $5,
           observacao_criada_em = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [
        cod_profissional || null, 
        nome_profissional || null, 
        statusFinal, 
        observacao || null,
        observacaoCriadaPor,
        observacaoCriadaEm,
        id
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar linha:', err);
    res.status(500).json({ error: 'Erro ao atualizar linha' });
  }
});

// DELETE /api/disponibilidade/linhas/:id - Deletar linha
app.delete('/api/disponibilidade/linhas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_linhas WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada' });
    }
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar linha:', err);
    res.status(500).json({ error: 'Erro ao deletar linha' });
  }
});

// DELETE /api/disponibilidade/limpar-linhas - Limpa todas as linhas (mantém estrutura)
app.delete('/api/disponibilidade/limpar-linhas', async (req, res) => {
  try {
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = NULL, nome_profissional = NULL, status = 'A CONFIRMAR', observacao = NULL, updated_at = CURRENT_TIMESTAMP`
    );
    console.log('🧹 Todas as linhas de disponibilidade foram resetadas');
    res.json({ success: true, message: 'Todas as linhas foram resetadas' });
  } catch (err) {
    console.error('❌ Erro ao limpar linhas:', err);
    res.status(500).json({ error: 'Erro ao limpar linhas' });
  }
});

// ============================================
// FALTOSOS
// ============================================

// POST /api/disponibilidade/faltosos - Registrar faltoso
app.post('/api/disponibilidade/faltosos', async (req, res) => {
  try {
    const { loja_id, cod_profissional, nome_profissional, motivo, data_falta } = req.body;
    
    if (!loja_id || !motivo) {
      return res.status(400).json({ error: 'Campos obrigatórios: loja_id, motivo' });
    }
    
    // Usar data_falta enviada ou data atual
    const dataFalta = data_falta || new Date().toISOString().split('T')[0];
    
    const result = await pool.query(
      `INSERT INTO disponibilidade_faltosos (loja_id, cod_profissional, nome_profissional, motivo, data_falta)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [loja_id, cod_profissional || null, nome_profissional || null, motivo, dataFalta]
    );
    
    console.log('⚠️ Faltoso registrado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao registrar faltoso:', err);
    res.status(500).json({ error: 'Erro ao registrar faltoso' });
  }
});

// GET /api/disponibilidade/faltosos - Listar faltosos com filtros
app.get('/api/disponibilidade/faltosos', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id } = req.query;
    
    let query = `
      SELECT f.*, l.codigo as loja_codigo, l.nome as loja_nome, r.nome as regiao_nome
      FROM disponibilidade_faltosos f
      JOIN disponibilidade_lojas l ON f.loja_id = l.id
      JOIN disponibilidade_regioes r ON l.regiao_id = r.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND f.data_falta >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND f.data_falta <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND f.loja_id = $${params.length}`;
    }
    
    query += ' ORDER BY f.data_falta DESC, f.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar faltosos:', err);
    res.status(500).json({ error: 'Erro ao listar faltosos' });
  }
});

// DELETE /api/disponibilidade/faltosos/:id - Excluir registro de falta
app.delete('/api/disponibilidade/faltosos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM disponibilidade_faltosos WHERE id = $1', [id]);
    console.log('🗑️ Falta excluída:', id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir falta:', err);
    res.status(500).json({ error: 'Erro ao excluir falta' });
  }
});

// POST /api/disponibilidade/linha-reposicao - Criar linha de reposição
app.post('/api/disponibilidade/linha-reposicao', async (req, res) => {
  try {
    const { loja_id, after_linha_id } = req.body;
    
    if (!loja_id) {
      return res.status(400).json({ error: 'loja_id é obrigatório' });
    }
    
    const result = await pool.query(
      `INSERT INTO disponibilidade_linhas (loja_id, status, is_reposicao)
       VALUES ($1, 'A CONFIRMAR', true) RETURNING *`,
      [loja_id]
    );
    
    console.log('🔄 Linha de reposição criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar linha de reposição:', err);
    res.status(500).json({ error: 'Erro ao criar linha de reposição' });
  }
});

// GET /api/disponibilidade/em-loja - Listar registros de motoboys EM LOJA
app.get('/api/disponibilidade/em-loja', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id } = req.query;
    
    let query = `
      SELECT e.*, l.nome as loja_nome
      FROM disponibilidade_em_loja e
      LEFT JOIN disponibilidade_lojas l ON e.loja_id = l.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND e.data_registro >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND e.data_registro <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND e.loja_id = $${params.length}`;
    }
    
    query += ' ORDER BY e.data_registro DESC, e.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar em loja:', err);
    res.status(500).json({ error: 'Erro ao listar em loja' });
  }
});

// GET /api/disponibilidade/sem-contato - Listar registros de motoboys SEM CONTATO
app.get('/api/disponibilidade/sem-contato', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id, apenas_risco } = req.query;
    
    let query = `
      SELECT s.*, l.nome as loja_nome
      FROM disponibilidade_sem_contato s
      LEFT JOIN disponibilidade_lojas l ON s.loja_id = l.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND s.data_registro >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND s.data_registro <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND s.loja_id = $${params.length}`;
    }
    if (apenas_risco === 'true') {
      // Apenas motoboys com 2+ dias (risco de remoção)
      query += ` AND s.dias_consecutivos >= 2`;
    }
    
    query += ' ORDER BY s.dias_consecutivos DESC, s.data_registro DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar sem contato:', err);
    res.status(500).json({ error: 'Erro ao listar sem contato' });
  }
});

// GET /api/disponibilidade/ranking-em-loja - Ranking de motoboys que mais trabalharam
app.get('/api/disponibilidade/ranking-em-loja', async (req, res) => {
  try {
    const { dias = 30 } = req.query;
    
    const result = await pool.query(`
      SELECT 
        cod_profissional,
        nome_profissional,
        COUNT(*) as total_dias,
        MAX(data_registro) as ultimo_dia
      FROM disponibilidade_em_loja
      WHERE data_registro >= CURRENT_DATE - $1::int
      AND cod_profissional IS NOT NULL
      GROUP BY cod_profissional, nome_profissional
      ORDER BY total_dias DESC
      LIMIT 20
    `, [dias]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking em loja:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking em loja' });
  }
});

// GET /api/disponibilidade/motoboys - Listar todos os motoboys com histórico completo
app.get('/api/disponibilidade/motoboys', async (req, res) => {
  try {
    const { loja_id, busca, dias = 30 } = req.query;
    
    // 1. Buscar todos os motoboys únicos das linhas (atuais e históricos)
    let motoboyQuery = `
      SELECT DISTINCT 
        cod_profissional,
        nome_profissional,
        loja_id
      FROM disponibilidade_linhas
      WHERE cod_profissional IS NOT NULL AND cod_profissional != ''
    `;
    
    const params = [];
    
    if (loja_id) {
      params.push(loja_id);
      motoboyQuery += ` AND loja_id = $${params.length}`;
    }
    
    if (busca) {
      params.push(`%${busca}%`);
      motoboyQuery += ` AND (cod_profissional ILIKE $${params.length} OR nome_profissional ILIKE $${params.length})`;
    }
    
    const motoboysResult = await pool.query(motoboyQuery, params);
    
    // 2. Para cada motoboy, buscar estatísticas
    const motoboys = [];
    
    for (const mb of motoboysResult.rows) {
      // Buscar contagem de EM LOJA
      const emLojaResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_registro) as ultima_vez
        FROM disponibilidade_em_loja
        WHERE cod_profissional = $1
        AND data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar contagem de SEM CONTATO
      const semContatoResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_registro) as ultima_vez, MAX(dias_consecutivos) as max_dias
        FROM disponibilidade_sem_contato
        WHERE cod_profissional = $1
        AND data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar contagem de FALTAS
      const faltasResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_falta) as ultima_falta
        FROM disponibilidade_faltosos
        WHERE cod_profissional = $1
        AND data_falta >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar lojas onde rodou
      const lojasResult = await pool.query(`
        SELECT DISTINCT l.id, l.nome, l.codigo
        FROM disponibilidade_em_loja el
        JOIN disponibilidade_lojas l ON el.loja_id = l.id
        WHERE el.cod_profissional = $1
        AND el.data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar info da loja atual
      const lojaAtualResult = await pool.query(`
        SELECT l.id, l.nome, l.codigo, r.nome as regiao_nome
        FROM disponibilidade_lojas l
        LEFT JOIN disponibilidade_regioes r ON l.regiao_id = r.id
        WHERE l.id = $1
      `, [mb.loja_id]);
      
      // Buscar status atual
      const statusAtualResult = await pool.query(`
        SELECT status, observacao
        FROM disponibilidade_linhas
        WHERE cod_profissional = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `, [mb.cod_profissional]);
      
      motoboys.push({
        cod: mb.cod_profissional,
        nome: mb.nome_profissional,
        loja_id: mb.loja_id,
        loja_atual: lojaAtualResult.rows[0] || null,
        status_atual: statusAtualResult.rows[0]?.status || 'A CONFIRMAR',
        observacao: statusAtualResult.rows[0]?.observacao || null,
        estatisticas: {
          em_loja: {
            total: parseInt(emLojaResult.rows[0]?.total) || 0,
            ultima_vez: emLojaResult.rows[0]?.ultima_vez || null
          },
          sem_contato: {
            total: parseInt(semContatoResult.rows[0]?.total) || 0,
            ultima_vez: semContatoResult.rows[0]?.ultima_vez || null,
            max_dias_consecutivos: parseInt(semContatoResult.rows[0]?.max_dias) || 0
          },
          faltas: {
            total: parseInt(faltasResult.rows[0]?.total) || 0,
            ultima_falta: faltasResult.rows[0]?.ultima_falta || null
          }
        },
        lojas_rodou: lojasResult.rows
      });
    }
    
    // Ordenar por nome
    motoboys.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    
    res.json({
      total: motoboys.length,
      periodo_dias: parseInt(dias),
      motoboys
    });
  } catch (err) {
    console.error('❌ Erro ao buscar motoboys:', err);
    res.status(500).json({ error: 'Erro ao buscar motoboys' });
  }
});

// ============================================
// RESTRIÇÕES DE MOTOBOYS
// ============================================

// GET /api/disponibilidade/restricoes - Listar todas as restrições
app.get('/api/disponibilidade/restricoes', async (req, res) => {
  try {
    const { ativo = 'true' } = req.query;
    
    let query = `
      SELECT r.*, l.nome as loja_nome, l.codigo as loja_codigo
      FROM disponibilidade_restricoes r
      LEFT JOIN disponibilidade_lojas l ON r.loja_id = l.id
    `;
    
    if (ativo === 'true') {
      query += ' WHERE r.ativo = true';
    }
    
    query += ' ORDER BY r.created_at DESC';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar restrições:', err);
    res.status(500).json({ error: 'Erro ao buscar restrições' });
  }
});

// GET /api/disponibilidade/restricoes/verificar - Verificar se um motoboy está restrito em uma loja
app.get('/api/disponibilidade/restricoes/verificar', async (req, res) => {
  try {
    const { cod_profissional, loja_id } = req.query;
    
    if (!cod_profissional) {
      return res.json({ restrito: false });
    }
    
    // Verifica se está restrito em TODAS as lojas ou na loja específica
    const result = await pool.query(`
      SELECT r.*, l.nome as loja_nome, l.codigo as loja_codigo
      FROM disponibilidade_restricoes r
      LEFT JOIN disponibilidade_lojas l ON r.loja_id = l.id
      WHERE r.cod_profissional = $1 
      AND r.ativo = true
      AND (r.todas_lojas = true OR r.loja_id = $2)
      LIMIT 1
    `, [cod_profissional, loja_id || null]);
    
    if (result.rows.length > 0) {
      const restricao = result.rows[0];
      res.json({
        restrito: true,
        motivo: restricao.motivo,
        todas_lojas: restricao.todas_lojas,
        loja_nome: restricao.loja_nome,
        loja_codigo: restricao.loja_codigo,
        criado_em: restricao.created_at
      });
    } else {
      res.json({ restrito: false });
    }
  } catch (err) {
    console.error('❌ Erro ao verificar restrição:', err);
    res.status(500).json({ error: 'Erro ao verificar restrição' });
  }
});

// POST /api/disponibilidade/restricoes - Criar nova restrição
app.post('/api/disponibilidade/restricoes', async (req, res) => {
  try {
    const { cod_profissional, nome_profissional, loja_id, todas_lojas, motivo, criado_por } = req.body;
    
    if (!cod_profissional || !motivo) {
      return res.status(400).json({ error: 'Código e motivo são obrigatórios' });
    }
    
    // Verificar se já existe restrição ativa para este motoboy nesta loja
    const existente = await pool.query(`
      SELECT id FROM disponibilidade_restricoes 
      WHERE cod_profissional = $1 
      AND ativo = true
      AND (todas_lojas = true OR loja_id = $2 OR $3 = true)
    `, [cod_profissional, loja_id || null, todas_lojas || false]);
    
    if (existente.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma restrição ativa para este motoboy nesta loja' });
    }
    
    const result = await pool.query(`
      INSERT INTO disponibilidade_restricoes 
      (cod_profissional, nome_profissional, loja_id, todas_lojas, motivo, criado_por)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      cod_profissional,
      nome_profissional || null,
      todas_lojas ? null : (loja_id || null),
      todas_lojas || false,
      motivo,
      criado_por || null
    ]);
    
    console.log(`🚫 Nova restrição criada: ${cod_profissional} - ${nome_profissional}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar restrição:', err);
    res.status(500).json({ error: 'Erro ao criar restrição' });
  }
});

// PUT /api/disponibilidade/restricoes/:id - Atualizar restrição
app.put('/api/disponibilidade/restricoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { loja_id, todas_lojas, motivo, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE disponibilidade_restricoes 
      SET loja_id = $1, todas_lojas = $2, motivo = $3, ativo = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [
      todas_lojas ? null : (loja_id || null),
      todas_lojas || false,
      motivo,
      ativo !== undefined ? ativo : true,
      id
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar restrição:', err);
    res.status(500).json({ error: 'Erro ao atualizar restrição' });
  }
});

// DELETE /api/disponibilidade/restricoes/:id - Remover restrição (desativar)
app.delete('/api/disponibilidade/restricoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Ao invés de deletar, desativa
    const result = await pool.query(`
      UPDATE disponibilidade_restricoes 
      SET ativo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }
    
    console.log(`✅ Restrição ${id} desativada`);
    res.json({ success: true, message: 'Restrição removida' });
  } catch (err) {
    console.error('❌ Erro ao remover restrição:', err);
    res.status(500).json({ error: 'Erro ao remover restrição' });
  }
});

// ============================================
// ESPELHO (Histórico)
// ============================================

// POST /api/disponibilidade/espelho - Salvar snapshot antes do reset
app.post('/api/disponibilidade/espelho', async (req, res) => {
  try {
    // Buscar todos os dados atuais
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      salvo_em: new Date().toISOString()
    };
    
    // Verificar se já existe espelho para hoje
    const hoje = new Date().toISOString().split('T')[0];
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [hoje]
    );
    
    if (existing.rows.length > 0) {
      // Atualizar o existente
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1 WHERE data_registro = $2',
        [JSON.stringify(dados), hoje]
      );
    } else {
      // Criar novo
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [hoje, JSON.stringify(dados)]
      );
    }
    
    console.log('📸 Espelho salvo para', hoje);
    res.json({ success: true, data: hoje });
  } catch (err) {
    console.error('❌ Erro ao salvar espelho:', err);
    res.status(500).json({ error: 'Erro ao salvar espelho' });
  }
});

// GET /api/disponibilidade/espelho - Listar datas disponíveis
app.get('/api/disponibilidade/espelho', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, data_registro, created_at FROM disponibilidade_espelho ORDER BY data_registro DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar espelhos:', err);
    res.status(500).json({ error: 'Erro ao listar espelhos' });
  }
});

// GET /api/disponibilidade/espelho/:data - Buscar espelho por data
app.get('/api/disponibilidade/espelho/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const result = await pool.query(
      'SELECT * FROM disponibilidade_espelho WHERE data_registro = $1',
      [data]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Espelho não encontrado para esta data' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar espelho:', err);
    res.status(500).json({ error: 'Erro ao buscar espelho' });
  }
});

// DELETE /api/disponibilidade/espelho/:id - Excluir espelho por ID
app.delete('/api/disponibilidade/espelho/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_espelho WHERE id = $1 RETURNING data_registro', [id]);
    if (result.rows.length > 0) {
      console.log('🗑️ Espelho excluído:', result.rows[0].data_registro);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir espelho:', err);
    res.status(500).json({ error: 'Erro ao excluir espelho' });
  }
});

// PATCH /api/disponibilidade/faltosos/corrigir-datas - Corrigir datas erradas
app.patch('/api/disponibilidade/faltosos/corrigir-datas', async (req, res) => {
  try {
    const { data_errada, data_correta } = req.body;
    const result = await pool.query(
      'UPDATE disponibilidade_faltosos SET data_falta = $1 WHERE data_falta = $2 RETURNING *',
      [data_correta, data_errada]
    );
    console.log(`📅 Datas corrigidas: ${data_errada} → ${data_correta} (${result.rowCount} registros)`);
    res.json({ success: true, corrigidos: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao corrigir datas:', err);
    res.status(500).json({ error: 'Erro ao corrigir datas' });
  }
});

// PATCH /api/disponibilidade/espelho/corrigir-data - Corrigir data do espelho
app.patch('/api/disponibilidade/espelho/corrigir-data', async (req, res) => {
  try {
    const { data_errada, data_correta } = req.body;
    const result = await pool.query(
      'UPDATE disponibilidade_espelho SET data_registro = $1 WHERE data_registro = $2 RETURNING *',
      [data_correta, data_errada]
    );
    console.log(`📅 Data do espelho corrigida: ${data_errada} → ${data_correta} (${result.rowCount} registros)`);
    res.json({ success: true, corrigidos: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao corrigir data do espelho:', err);
    res.status(500).json({ error: 'Erro ao corrigir data do espelho' });
  }
});

// POST /api/disponibilidade/resetar - Resetar status (com salvamento de espelho)
app.post('/api/disponibilidade/resetar', async (req, res) => {
  try {
    // Pegar a data da planilha (enviada pelo frontend) ou usar hoje
    const { data_planilha } = req.body || {};
    const dataEspelho = data_planilha || new Date().toISOString().split('T')[0];
    
    // 1. Salvar espelho antes de resetar
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      data_planilha: dataEspelho,
      salvo_em: new Date().toISOString()
    };
    
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [dataEspelho]
    );
    
    let espelhoSalvo = false;
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1, created_at = CURRENT_TIMESTAMP WHERE data_registro = $2',
        [JSON.stringify(dados), dataEspelho]
      );
      espelhoSalvo = true;
    } else {
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [dataEspelho, JSON.stringify(dados)]
      );
      espelhoSalvo = true;
    }
    console.log('📸 Espelho salvo antes do reset:', dataEspelho, '- Linhas:', linhas.rows.length);
    
    // 1.5. SALVAR OBSERVAÇÕES NO HISTÓRICO antes de resetar
    const linhasComObs = linhas.rows.filter(l => l.observacao && l.observacao.trim() !== '');
    let observacoesSalvas = 0;
    
    for (const linha of linhasComObs) {
      await pool.query(
        `INSERT INTO disponibilidade_observacoes_historico 
         (linha_id, loja_id, cod_profissional, nome_profissional, observacao, criada_por, criada_em, data_reset, data_planilha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)`,
        [
          linha.id,
          linha.loja_id,
          linha.cod_profissional,
          linha.nome_profissional,
          linha.observacao,
          linha.observacao_criada_por,
          linha.observacao_criada_em,
          dataEspelho
        ]
      );
      observacoesSalvas++;
    }
    console.log('📝 Observações salvas no histórico:', observacoesSalvas);
    
    // 2. REGISTRAR MOTOBOYS "EM LOJA" antes de resetar
    const emLojaLinhas = linhas.rows.filter(l => l.status === 'EM LOJA' && l.cod_profissional);
    for (const linha of emLojaLinhas) {
      await pool.query(
        `INSERT INTO disponibilidade_em_loja (loja_id, cod_profissional, nome_profissional, data_registro)
         VALUES ($1, $2, $3, $4)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho]
      );
    }
    console.log('🏪 Motoboys EM LOJA registrados:', emLojaLinhas.length);
    
    // 3. REGISTRAR MOTOBOYS "SEM CONTATO" e verificar dias consecutivos
    const semContatoLinhas = linhas.rows.filter(l => l.status === 'SEM CONTATO' && l.cod_profissional);
    const removidos = [];
    
    for (const linha of semContatoLinhas) {
      // Verificar se já tem registro recente (ontem ou antes)
      const ultimoRegistro = await pool.query(
        `SELECT * FROM disponibilidade_sem_contato 
         WHERE cod_profissional = $1 AND loja_id = $2
         ORDER BY data_registro DESC LIMIT 1`,
        [linha.cod_profissional, linha.loja_id]
      );
      
      let diasConsecutivos = 1;
      
      if (ultimoRegistro.rows.length > 0) {
        const ultimaData = new Date(ultimoRegistro.rows[0].data_registro);
        const dataAtual = new Date(dataEspelho);
        const diffDias = Math.floor((dataAtual - ultimaData) / (1000 * 60 * 60 * 24));
        
        // Se o último registro foi ontem (ou há 1 dia), incrementa contador
        if (diffDias === 1) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos + 1;
        }
        // Se foi no mesmo dia, mantém o mesmo contador
        else if (diffDias === 0) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos;
        }
        // Se foi há mais de 1 dia, reseta contador
      }
      
      // Inserir novo registro
      await pool.query(
        `INSERT INTO disponibilidade_sem_contato (loja_id, cod_profissional, nome_profissional, data_registro, dias_consecutivos)
         VALUES ($1, $2, $3, $4, $5)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho, diasConsecutivos]
      );
      
      // AUTO-REMOÇÃO: Se chegou a 3 dias consecutivos, remove da planilha
      if (diasConsecutivos >= 3) {
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = NULL, nome_profissional = NULL, status = 'A CONFIRMAR', observacao = NULL
           WHERE id = $1`,
          [linha.id]
        );
        removidos.push({
          cod: linha.cod_profissional,
          nome: linha.nome_profissional,
          dias: diasConsecutivos
        });
        console.log('🚫 Auto-removido por 3 dias SEM CONTATO:', linha.cod_profissional, linha.nome_profissional);
      }
    }
    console.log('📵 Motoboys SEM CONTATO registrados:', semContatoLinhas.length, '- Removidos:', removidos.length);
    
    // 4. Processar linhas de reposição
    // Regra: Se há excedente vazio disponível, migra o usuário para lá. Senão, reposição vira nova linha excedente.
    
    // Buscar todas as linhas de reposição que têm usuário preenchido
    const reposicoesPreenchidas = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND cod_profissional IS NOT NULL AND cod_profissional != ''`
    );
    
    // Buscar todas as linhas de reposição vazias
    const reposicoesVazias = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND (cod_profissional IS NULL OR cod_profissional = '')`
    );
    
    console.log('📊 Reposições preenchidas:', reposicoesPreenchidas.rows.length);
    console.log('📊 Reposições vazias:', reposicoesVazias.rows.length);
    
    // Para cada reposição preenchida, tentar migrar para excedente vazio da mesma loja
    for (const reposicao of reposicoesPreenchidas.rows) {
      // Buscar excedente vazio na mesma loja
      const excedenteVazio = await pool.query(
        `SELECT id FROM disponibilidade_linhas 
         WHERE loja_id = $1 AND is_excedente = true 
         AND (cod_profissional IS NULL OR cod_profissional = '')
         LIMIT 1`,
        [reposicao.loja_id]
      );
      
      if (excedenteVazio.rows.length > 0) {
        // Migrar usuário para o excedente vazio
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = $1, nome_profissional = $2
           WHERE id = $3`,
          [reposicao.cod_profissional, reposicao.nome_profissional, excedenteVazio.rows[0].id]
        );
        // Deletar a linha de reposição (já migrou o usuário)
        await pool.query('DELETE FROM disponibilidade_linhas WHERE id = $1', [reposicao.id]);
        console.log('✅ Usuário migrado de reposição para excedente vazio:', reposicao.cod_profissional);
      } else {
        // Não há excedente vazio, converter reposição em nova linha excedente (mantém o usuário)
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET is_excedente = true, is_reposicao = false 
           WHERE id = $1`,
          [reposicao.id]
        );
        console.log('✅ Reposição convertida em excedente adicional:', reposicao.cod_profissional);
      }
    }
    
    // Deletar reposições vazias (não precisam virar excedente)
    await pool.query(
      `DELETE FROM disponibilidade_linhas WHERE is_reposicao = true`
    );
    console.log('🗑️ Reposições vazias removidas');
    
    // 5. Resetar APENAS status (MANTER observações, cod e nome!)
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET status = 'A CONFIRMAR', 
           updated_at = CURRENT_TIMESTAMP`
    );
    
    console.log('🔄 Status resetado com sucesso (códigos e nomes mantidos)');
    res.json({ 
      success: true, 
      espelho_data: dataEspelho, 
      espelho_salvo: espelhoSalvo,
      em_loja_registrados: emLojaLinhas.length,
      sem_contato_registrados: semContatoLinhas.length,
      removidos_por_sem_contato: removidos
    });
  } catch (err) {
    console.error('❌ Erro ao resetar:', err);
    res.status(500).json({ error: 'Erro ao resetar status' });
  }
});

// ============================================
// HISTÓRICO DE OBSERVAÇÕES
// ============================================

// GET /api/disponibilidade/observacoes-historico - Listar histórico de observações com filtros
app.get('/api/disponibilidade/observacoes-historico', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_profissional, loja_id, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM disponibilidade_observacoes_historico WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      query += ` AND data_reset >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    
    if (data_fim) {
      query += ` AND data_reset <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    if (cod_profissional) {
      query += ` AND cod_profissional = $${paramIndex}`;
      params.push(cod_profissional);
      paramIndex++;
    }
    
    if (loja_id) {
      query += ` AND loja_id = $${paramIndex}`;
      params.push(loja_id);
      paramIndex++;
    }
    
    query += ` ORDER BY data_reset DESC, created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico de observações:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico de observações' });
  }
});

// GET /api/disponibilidade/observacoes-historico/datas - Listar datas disponíveis no histórico
app.get('/api/disponibilidade/observacoes-historico/datas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT data_reset, data_planilha, COUNT(*) as total_observacoes
      FROM disponibilidade_observacoes_historico
      GROUP BY data_reset, data_planilha
      ORDER BY data_reset DESC
      LIMIT 30
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar datas do histórico:', err);
    res.status(500).json({ error: 'Erro ao buscar datas do histórico' });
  }
});

// ============================================
// RELATÓRIOS E HISTÓRICO
// ============================================

// GET /api/disponibilidade/relatorios/metricas - Métricas dos últimos 7 espelhos salvos
app.get('/api/disponibilidade/relatorios/metricas', async (req, res) => {
  try {
    // Buscar os últimos 7 espelhos salvos (independente da data)
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Processar métricas por dia
    const metricas = [];
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      const totalTitulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let percOperacao = 0;
      if (totalTitulares > 0) {
        percOperacao = Math.min((emLoja / totalTitulares) * 100, 100);
      }
      
      metricas.push({
        data: espelho.data_registro,
        totalTitulares,
        emLoja,
        faltando,
        semContato,
        percOperacao: parseFloat(percOperacao.toFixed(1))
      });
    }
    
    res.json(metricas);
  } catch (err) {
    console.error('❌ Erro ao buscar métricas:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-lojas - Ranking de lojas por % EM LOJA
app.get('/api/disponibilidade/relatorios/ranking-lojas', async (req, res) => {
  try {
    // Buscar últimos 7 espelhos
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Buscar lojas para ter os nomes
    const lojasResult = await pool.query(`
      SELECT l.*, r.nome as regiao_nome 
      FROM disponibilidade_lojas l
      LEFT JOIN disponibilidade_regioes r ON l.regiao_id = r.id
    `);
    const lojasInfo = {};
    lojasResult.rows.forEach(l => {
      lojasInfo[l.id] = { nome: l.nome, regiao: l.regiao_nome };
    });
    
    // Agrupar dados por loja
    const lojasMap = {};
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      // Agrupar linhas por loja
      const linhasPorLoja = {};
      linhas.forEach(linha => {
        if (!linha.loja_id) return;
        if (!linhasPorLoja[linha.loja_id]) {
          linhasPorLoja[linha.loja_id] = [];
        }
        linhasPorLoja[linha.loja_id].push(linha);
      });
      
      // Calcular métricas por loja neste dia
      Object.entries(linhasPorLoja).forEach(([lojaId, linhasLoja]) => {
        if (!lojasMap[lojaId]) {
          lojasMap[lojaId] = {
            loja_id: lojaId,
            loja_nome: lojasInfo[lojaId]?.nome || 'Desconhecida',
            regiao_nome: lojasInfo[lojaId]?.regiao || '',
            dias: []
          };
        }
        
        const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
        const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
        // % baseado em EM LOJA vs TITULARES, limitado a 100%
        const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
        
        lojasMap[lojaId].dias.push(perc);
      });
    }
    
    // Calcular média por loja
    const ranking = Object.values(lojasMap).map(loja => {
      const mediaPerc = loja.dias.length > 0 
        ? (loja.dias.reduce((a, b) => a + b, 0) / loja.dias.length).toFixed(1)
        : 0;
      return {
        loja_id: loja.loja_id,
        loja_nome: loja.loja_nome,
        regiao_nome: loja.regiao_nome,
        mediaPerc: parseFloat(mediaPerc),
        diasAnalisados: loja.dias.length
      };
    });
    
    // Ordenar por média (melhores primeiro)
    ranking.sort((a, b) => b.mediaPerc - a.mediaPerc);
    
    res.json(ranking);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking lojas:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-faltosos - Ranking de entregadores que mais faltam
app.get('/api/disponibilidade/relatorios/ranking-faltosos', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltosos do período
    const faltosos = await pool.query(`
      SELECT f.*, l.nome as loja_nome
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      ORDER BY f.data_falta DESC
    `);
    
    // Agrupar por profissional
    const profissionaisMap = {};
    faltosos.rows.forEach(falta => {
      const key = falta.cod_profissional || falta.nome_profissional;
      if (!key) return;
      
      if (!profissionaisMap[key]) {
        profissionaisMap[key] = {
          cod: falta.cod_profissional,
          nome: falta.nome_profissional,
          loja_nome: falta.loja_nome,
          totalFaltas: 0,
          motivos: [],
          ultimaFalta: falta.data_falta
        };
      }
      profissionaisMap[key].totalFaltas++;
      if (falta.motivo && !profissionaisMap[key].motivos.includes(falta.motivo)) {
        profissionaisMap[key].motivos.push(falta.motivo);
      }
    });
    
    // Converter para array e ordenar
    const ranking = Object.values(profissionaisMap);
    ranking.sort((a, b) => b.totalFaltas - a.totalFaltas);
    
    res.json(ranking.slice(0, 20)); // Top 20
  } catch (err) {
    console.error('❌ Erro ao buscar ranking faltosos:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/comparativo - Comparar últimos 3 espelhos salvos
app.get('/api/disponibilidade/relatorios/comparativo', async (req, res) => {
  try {
    // Buscar os 3 últimos espelhos salvos (ordenados por data_registro DESC)
    const espelhosResult = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 3
    `);
    
    // Função para calcular métricas com lógica correta de %
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const calcularMetricas = (linhas, dataRegistro) => {
      if (!linhas || linhas.length === 0) {
        return null;
      }
      
      const titulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let perc = 0;
      if (titulares > 0) {
        perc = Math.min((emLoja / titulares) * 100, 100);
      }
      
      return { 
        titulares, 
        emLoja,
        faltando, 
        semContato, 
        perc: parseFloat(perc.toFixed(1)),
        data: dataRegistro
      };
    };
    
    // Extrair linhas do espelho (campo dados é JSON)
    const extrairLinhasEspelho = (espelho) => {
      if (!espelho) return [];
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      return dados?.linhas || [];
    };
    
    // Formatar data para exibição
    const formatarData = (data) => {
      if (!data) return '';
      const d = new Date(data);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    };
    
    const espelhos = espelhosResult.rows;
    
    // Mais recente = "HOJE" (ou último salvo)
    // Segundo = "ONTEM" (ou penúltimo salvo)  
    // Terceiro = "ANTERIOR" (ou antepenúltimo salvo)
    const resultado = {
      hoje: espelhos[0] ? calcularMetricas(extrairLinhasEspelho(espelhos[0]), espelhos[0].data_registro) : null,
      ontem: espelhos[1] ? calcularMetricas(extrairLinhasEspelho(espelhos[1]), espelhos[1].data_registro) : null,
      semanaPassada: espelhos[2] ? calcularMetricas(extrairLinhasEspelho(espelhos[2]), espelhos[2].data_registro) : null,
      // Labels dinâmicos baseados nas datas reais
      labels: {
        hoje: espelhos[0] ? formatarData(espelhos[0].data_registro) : 'MAIS RECENTE',
        ontem: espelhos[1] ? formatarData(espelhos[1].data_registro) : 'ANTERIOR',
        semanaPassada: espelhos[2] ? formatarData(espelhos[2].data_registro) : '3º ANTERIOR'
      }
    };
    
    res.json(resultado);
  } catch (err) {
    console.error('❌ Erro ao buscar comparativo:', err);
    res.status(500).json({ error: 'Erro ao buscar comparativo' });
  }
});

// GET /api/disponibilidade/relatorios/heatmap - Heatmap de faltas por dia da semana e loja
app.get('/api/disponibilidade/relatorios/heatmap', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltas com dia da semana
    const faltas = await pool.query(`
      SELECT 
        f.loja_id,
        l.nome as loja_nome,
        EXTRACT(DOW FROM f.data_falta) as dia_semana,
        COUNT(*) as total_faltas
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      GROUP BY f.loja_id, l.nome, EXTRACT(DOW FROM f.data_falta)
      ORDER BY l.nome, dia_semana
    `);
    
    // Organizar em formato de heatmap
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const lojasMap = {};
    
    faltas.rows.forEach(row => {
      if (!lojasMap[row.loja_id]) {
        lojasMap[row.loja_id] = {
          loja_nome: row.loja_nome,
          dias: [0, 0, 0, 0, 0, 0, 0]
        };
      }
      lojasMap[row.loja_id].dias[parseInt(row.dia_semana)] = parseInt(row.total_faltas);
    });
    
    res.json({
      diasSemana,
      lojas: Object.values(lojasMap)
    });
  } catch (err) {
    console.error('❌ Erro ao buscar heatmap:', err);
    res.status(500).json({ error: 'Erro ao buscar heatmap' });
  }
});

// ============================================
// LINK PÚBLICO (SOMENTE LEITURA)
// ============================================

// GET /api/disponibilidade/publico - Retorna página HTML com panorama somente leitura
app.get('/api/disponibilidade/publico', async (req, res) => {
  try {
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas');
    
    // Calcular dados de cada loja
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const lojasComDados = lojas.rows.map(loja => {
      const linhasLoja = linhas.rows.filter(l => l.loja_id === loja.id);
      const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const aCaminho = linhasLoja.filter(l => l.status === 'A CAMINHO').length;
      const confirmado = linhasLoja.filter(l => l.status === 'CONFIRMADO').length;
      const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
      const semContato = linhasLoja.filter(l => l.status === 'SEM CONTATO').length;
      const emOperacao = aCaminho + confirmado + emLoja;
      const falta = Math.max(0, titulares - emOperacao);
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
      const regiao = regioes.rows.find(r => r.id === loja.regiao_id);
      return { ...loja, titulares, aCaminho, confirmado, emLoja, semContato, emOperacao, falta, perc, regiao };
    });
    
    // Totais
    let totalGeral = { aCaminho: 0, confirmado: 0, emLoja: 0, titulares: 0, falta: 0, semContato: 0, emOperacao: 0 };
    lojasComDados.forEach(l => {
      totalGeral.aCaminho += l.aCaminho;
      totalGeral.confirmado += l.confirmado;
      totalGeral.emLoja += l.emLoja;
      totalGeral.titulares += l.titulares;
      totalGeral.falta += l.falta;
      totalGeral.semContato += l.semContato;
      totalGeral.emOperacao += l.emOperacao;
    });
    // % geral baseado em EM LOJA vs TITULARES, limitado a 100%
    const percGeral = totalGeral.titulares > 0 ? Math.min((totalGeral.emLoja / totalGeral.titulares) * 100, 100) : 0;
    
    // Gerar HTML - Design Clean
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panorama - Disponibilidade</title>
  <meta http-equiv="refresh" content="120">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 12px; }
    .header { background: white; padding: 16px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header h1 { font-size: 15px; color: #1e293b; font-weight: 600; }
    .header .info { font-size: 11px; color: #64748b; margin-top: 4px; }
    .badge { padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 12px; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-yellow { background: #fef3c7; color: #a16207; }
    .badge-red { background: #fee2e2; color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #f8fafc; color: #475569; padding: 8px 6px; text-align: center; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
    th.lojas { text-align: left; }
    td { padding: 4px 6px; border: 1px solid #e2e8f0; text-align: center; }
    td.loja { text-align: left; background: #fafafa; font-weight: 500; }
    tr.regiao td { background: #e2e8f0; font-weight: 700; text-align: center; color: #1e293b; }
    tr.total td { background: #f8fafc; font-weight: 700; border-top: 2px solid #cbd5e1; }
    tr.critico { background: #fef2f2; }
    tr.critico td.loja { background: #fef2f2; }
    .num-zero { color: #cbd5e1; }
    .num-acaminho { color: #ea580c; }
    .num-confirmado { color: #16a34a; }
    .num-emloja { color: #2563eb; font-weight: 700; }
    .num-ideal { color: #64748b; }
    .num-falta { color: #dc2626; font-weight: 600; }
    .num-semcontato { color: #d97706; }
    .perc { font-weight: 700; }
    .perc-ok { background: #bbf7d0; color: #15803d; }
    .perc-warn { background: #fde68a; color: #a16207; }
    .perc-danger { background: #fecaca; color: #b91c1c; }
    .perc-neutral { background: #f1f5f9; color: #475569; }
    .footer { margin-top: 12px; text-align: center; font-size: 10px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>📊 PANORAMA DIÁRIO OPERACIONAL</h1>
      <div class="info">Atualizado: ${new Date().toLocaleString('pt-BR')} | Auto-refresh: 2min</div>
    </div>
    <div>
      <span class="badge ${percGeral >= 100 ? 'badge-green' : percGeral >= 80 ? 'badge-yellow' : 'badge-red'}">
        ${percGeral.toFixed(0)}% GERAL
      </span>
      ${totalGeral.falta > 0 ? `<span class="badge badge-red" style="margin-left:5px">⚠️ FALTAM ${totalGeral.falta}</span>` : ''}
    </div>
  </div>
  
  <table>
    <thead>
      <tr>
        <th class="lojas">LOJAS</th>
        <th>A CAMINHO</th>
        <th>CONFIR.</th>
        <th>EM LOJA</th>
        <th>IDEAL</th>
        <th>FALTA</th>
        <th>S/ CONTATO</th>
        <th>%</th>
      </tr>
    </thead>
    <tbody>`;
    
    // Renderizar por região
    regioes.rows.forEach(regiao => {
      const lojasReg = lojasComDados.filter(l => l.regiao_id === regiao.id);
      if (lojasReg.length === 0) return;
      
      // Header região
      html += `<tr class="regiao"><td colspan="8">${regiao.nome}${regiao.gestores ? ` (${regiao.gestores})` : ''}</td></tr>`;
      
      // Lojas
      lojasReg.forEach(loja => {
        const critico = loja.perc < 50 ? 'critico' : '';
        const percClass = loja.perc >= 100 ? 'perc-ok' : loja.perc >= 80 ? 'perc-neutral' : loja.perc >= 50 ? 'perc-warn' : 'perc-danger';
        html += `<tr class="${critico}">
          <td class="loja">${loja.perc < 50 ? '🔴 ' : ''}${loja.nome}</td>
          <td class="${loja.aCaminho > 0 ? 'num-acaminho' : 'num-zero'}">${loja.aCaminho}</td>
          <td class="${loja.confirmado > 0 ? 'num-confirmado' : 'num-zero'}">${loja.confirmado}</td>
          <td class="${loja.emLoja > 0 ? 'num-emloja' : 'num-zero'}">${loja.emLoja}</td>
          <td class="num-ideal">${loja.titulares}</td>
          <td class="${loja.falta > 0 ? 'num-falta' : 'num-zero'}">${loja.falta > 0 ? -loja.falta : 0}</td>
          <td class="${loja.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${loja.semContato}</td>
          <td class="perc ${percClass}">${loja.perc.toFixed(0)}%</td>
        </tr>`;
      });
    });
    
    // Total geral
    const totalPercClass = percGeral >= 100 ? 'perc-ok' : percGeral >= 80 ? 'perc-neutral' : percGeral >= 50 ? 'perc-warn' : 'perc-danger';
    html += `<tr class="total">
      <td style="text-align:left;color:#1e293b">TOTAL GERAL</td>
      <td class="num-acaminho">${totalGeral.aCaminho}</td>
      <td class="num-confirmado">${totalGeral.confirmado}</td>
      <td class="num-emloja">${totalGeral.emLoja}</td>
      <td class="num-ideal">${totalGeral.titulares}</td>
      <td class="${totalGeral.falta > 0 ? 'num-falta' : 'num-zero'}">${totalGeral.falta > 0 ? -totalGeral.falta : 0}</td>
      <td class="${totalGeral.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${totalGeral.semContato}</td>
      <td class="perc ${totalPercClass}" style="font-weight:800">${percGeral.toFixed(0)}%</td>
    </tr>`;
    
    html += `</tbody></table>
  <div class="footer">
    Esta página atualiza automaticamente a cada 2 minutos | Sistema Tutts
  </div>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('❌ Erro ao gerar página pública:', err);
    res.status(500).send('Erro ao gerar página');
  }
});

// ============================================
// LOJA - ENDPOINTS
// ============================================

// === ESTOQUE ===

// GET - Listar estoque
app.get('/api/loja/estoque', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, 
        COALESCE(json_agg(
          json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
        ) FILTER (WHERE t.id IS NOT NULL), '[]') as tamanhos
      FROM loja_estoque e
      LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar estoque:', err);
    res.status(500).json({ error: 'Erro ao listar estoque' });
  }
});

// POST - Adicionar item ao estoque
app.post('/api/loja/estoque', async (req, res) => {
  try {
    const { nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, tamanhos, imagem_url, created_by } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_estoque (nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, imagem_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [nome, marca, valor, quantidade || 0, tem_tamanho || false, tipo_tamanho || 'letras', imagem_url, created_by]
    );
    
    const estoqueId = result.rows[0].id;
    
    // Se tem tamanhos, inserir na tabela de tamanhos
    if (tem_tamanho && tamanhos && tamanhos.length > 0) {
      for (const t of tamanhos) {
        await pool.query(
          `INSERT INTO loja_estoque_tamanhos (estoque_id, tamanho, quantidade) VALUES ($1, $2, $3)`,
          [estoqueId, t.tamanho, t.quantidade || 0]
        );
      }
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar estoque:', err);
    res.status(500).json({ error: 'Erro ao adicionar estoque' });
  }
});

// PUT - Atualizar item do estoque
app.put('/api/loja/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, tamanhos, imagem_url, status } = req.body;
    
    const result = await pool.query(
      `UPDATE loja_estoque SET nome=$1, marca=$2, valor=$3, quantidade=$4, tem_tamanho=$5, tipo_tamanho=$6, imagem_url=$7, status=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho || 'letras', imagem_url, status || 'ativo', id]
    );
    
    // Atualizar tamanhos
    if (tem_tamanho) {
      // Remover tamanhos antigos
      await pool.query(`DELETE FROM loja_estoque_tamanhos WHERE estoque_id = $1`, [id]);
      
      // Inserir novos
      if (tamanhos && tamanhos.length > 0) {
        for (const t of tamanhos) {
          await pool.query(
            `INSERT INTO loja_estoque_tamanhos (estoque_id, tamanho, quantidade) VALUES ($1, $2, $3)`,
            [id, t.tamanho, t.quantidade || 0]
          );
        }
      }
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar estoque:', err);
    res.status(500).json({ error: 'Erro ao atualizar estoque' });
  }
});

// DELETE - Remover item do estoque
app.delete('/api/loja/estoque/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_estoque WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover estoque:', err);
    res.status(500).json({ error: 'Erro ao remover estoque' });
  }
});

// === PRODUTOS À VENDA ===

// GET - Listar produtos
app.get('/api/loja/produtos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, e.tem_tamanho,
        COALESCE(json_agg(
          json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
        ) FILTER (WHERE t.id IS NOT NULL), '[]') as tamanhos
      FROM loja_produtos p
      LEFT JOIN loja_estoque e ON e.id = p.estoque_id
      LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
      GROUP BY p.id, e.tem_tamanho
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar produtos:', err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

// GET - Produtos ativos (para usuário)
app.get('/api/loja/produtos/ativos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, e.tem_tamanho, e.quantidade as estoque_total,
        COALESCE(json_agg(
          json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
        ) FILTER (WHERE t.id IS NOT NULL AND t.quantidade > 0), '[]') as tamanhos
      FROM loja_produtos p
      LEFT JOIN loja_estoque e ON e.id = p.estoque_id
      LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
      WHERE p.status = 'ativo'
      GROUP BY p.id, e.tem_tamanho, e.quantidade
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar produtos ativos:', err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

// POST - Adicionar produto à venda
app.post('/api/loja/produtos', async (req, res) => {
  try {
    const { estoque_id, nome, descricao, marca, valor, imagem_url, parcelas_config, created_by } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_produtos (estoque_id, nome, descricao, marca, valor, imagem_url, parcelas_config, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [estoque_id, nome, descricao, marca, valor, imagem_url, JSON.stringify(parcelas_config || []), created_by]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar produto:', err);
    res.status(500).json({ error: 'Erro ao adicionar produto' });
  }
});

// PUT - Atualizar produto
app.put('/api/loja/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, marca, valor, imagem_url, parcelas_config, status } = req.body;
    
    const result = await pool.query(
      `UPDATE loja_produtos SET nome=$1, descricao=$2, marca=$3, valor=$4, imagem_url=$5, parcelas_config=$6, status=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [nome, descricao, marca, valor, imagem_url, JSON.stringify(parcelas_config || []), status, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar produto:', err);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// DELETE - Remover produto
app.delete('/api/loja/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_produtos WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover produto:', err);
    res.status(500).json({ error: 'Erro ao remover produto' });
  }
});

// === PEDIDOS ===

// GET - Listar todos os pedidos (admin)
app.get('/api/loja/pedidos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM loja_pedidos ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// GET - Pedidos do usuário
app.get('/api/loja/pedidos/user/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      `SELECT * FROM loja_pedidos WHERE user_cod = $1 ORDER BY created_at DESC`,
      [userCod]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar pedidos do usuário:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// POST - Criar pedido
app.post('/api/loja/pedidos', async (req, res) => {
  try {
    const { produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_pedidos (produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

// PATCH - Atualizar status do pedido
app.patch('/api/loja/pedidos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_id, admin_name, observacao, debito_lancado, debito_lancado_em, debito_lancado_por } = req.body;
    
    let result;
    
    // Se for atualização de débito lançado
    if (debito_lancado !== undefined) {
      result = await pool.query(
        `UPDATE loja_pedidos SET debito_lancado=$1, debito_lancado_em=$2, debito_lancado_por=$3, updated_at=NOW()
         WHERE id=$4 RETURNING *`,
        [debito_lancado, debito_lancado_em, debito_lancado_por, id]
      );
    } else {
      // Atualização de status
      result = await pool.query(
        `UPDATE loja_pedidos SET status=$1, admin_id=$2, admin_name=$3, observacao=$4, updated_at=NOW()
         WHERE id=$5 RETURNING *`,
        [status, admin_id, admin_name, observacao, id]
      );
      
      // Se aprovado, decrementar estoque
      if (status === 'aprovado') {
        const pedido = result.rows[0];
        if (pedido.tamanho) {
          // Decrementar do tamanho específico
          await pool.query(`
            UPDATE loja_estoque_tamanhos 
            SET quantidade = quantidade - 1 
            WHERE estoque_id = (SELECT estoque_id FROM loja_produtos WHERE id = $1) 
            AND tamanho = $2 AND quantidade > 0
          `, [pedido.produto_id, pedido.tamanho]);
        } else {
          // Decrementar do estoque geral
          await pool.query(`
            UPDATE loja_estoque 
            SET quantidade = quantidade - 1 
            WHERE id = (SELECT estoque_id FROM loja_produtos WHERE id = $1) 
            AND quantidade > 0
          `, [pedido.produto_id]);
        }
      }
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar pedido:', err);
    res.status(500).json({ error: 'Erro ao atualizar pedido' });
  }
});

// DELETE - Remover pedido
app.delete('/api/loja/pedidos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_pedidos WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover pedido:', err);
    res.status(500).json({ error: 'Erro ao remover pedido' });
  }
});

// ==================== MOVIMENTAÇÕES DE ESTOQUE ====================

// GET - Listar movimentações de um item
app.get('/api/loja/estoque/:id/movimentacoes', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM loja_estoque_movimentacoes WHERE estoque_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar movimentações:', err);
    res.status(500).json({ error: 'Erro ao listar movimentações' });
  }
});

// GET - Listar todas movimentações
app.get('/api/loja/movimentacoes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, e.nome as produto_nome, e.marca
      FROM loja_estoque_movimentacoes m
      LEFT JOIN loja_estoque e ON m.estoque_id = e.id
      ORDER BY m.created_at DESC
      LIMIT 500
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar movimentações:', err);
    res.status(500).json({ error: 'Erro ao listar movimentações' });
  }
});

// POST - Registrar entrada de estoque
app.post('/api/loja/estoque/:id/entrada', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantidade, tamanho, motivo, created_by } = req.body;
    
    // Registrar movimentação
    await pool.query(
      `INSERT INTO loja_estoque_movimentacoes (estoque_id, tipo, quantidade, tamanho, motivo, created_by)
       VALUES ($1, 'entrada', $2, $3, $4, $5)`,
      [id, quantidade, tamanho || null, motivo || 'Entrada manual', created_by]
    );
    
    // Atualizar quantidade
    if (tamanho) {
      await pool.query(
        `UPDATE loja_estoque_tamanhos SET quantidade = quantidade + $1 WHERE estoque_id = $2 AND tamanho = $3`,
        [quantidade, id, tamanho]
      );
    } else {
      await pool.query(
        `UPDATE loja_estoque SET quantidade = quantidade + $1 WHERE id = $2`,
        [quantidade, id]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao registrar entrada:', err);
    res.status(500).json({ error: 'Erro ao registrar entrada' });
  }
});

// POST - Registrar saída de estoque
app.post('/api/loja/estoque/:id/saida', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantidade, tamanho, motivo, created_by } = req.body;
    
    // Registrar movimentação
    await pool.query(
      `INSERT INTO loja_estoque_movimentacoes (estoque_id, tipo, quantidade, tamanho, motivo, created_by)
       VALUES ($1, 'saida', $2, $3, $4, $5)`,
      [id, quantidade, tamanho || null, motivo || 'Saída manual', created_by]
    );
    
    // Atualizar quantidade
    if (tamanho) {
      await pool.query(
        `UPDATE loja_estoque_tamanhos SET quantidade = GREATEST(0, quantidade - $1) WHERE estoque_id = $2 AND tamanho = $3`,
        [quantidade, id, tamanho]
      );
    } else {
      await pool.query(
        `UPDATE loja_estoque SET quantidade = GREATEST(0, quantidade - $1) WHERE id = $2`,
        [quantidade, id]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao registrar saída:', err);
    res.status(500).json({ error: 'Erro ao registrar saída' });
  }
});

// ==================== SUGESTÕES DE PRODUTOS ====================

// GET - Listar todas sugestões (admin)
app.get('/api/loja/sugestoes', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM loja_sugestoes ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar sugestões:', err);
    res.status(500).json({ error: 'Erro ao listar sugestões' });
  }
});

// GET - Listar sugestões do usuário
app.get('/api/loja/sugestoes/user/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      `SELECT * FROM loja_sugestoes WHERE user_cod = $1 ORDER BY created_at DESC`,
      [userCod]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar sugestões:', err);
    res.status(500).json({ error: 'Erro ao listar sugestões' });
  }
});

// POST - Criar sugestão
app.post('/api/loja/sugestoes', async (req, res) => {
  try {
    const { user_cod, user_name, sugestao } = req.body;
    
    const result = await pool.query(
      `INSERT INTO loja_sugestoes (user_cod, user_name, sugestao) VALUES ($1, $2, $3) RETURNING *`,
      [user_cod, user_name, sugestao]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar sugestão:', err);
    res.status(500).json({ error: 'Erro ao criar sugestão' });
  }
});

// PATCH - Responder sugestão (admin)
app.patch('/api/loja/sugestoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resposta, respondido_por } = req.body;
    
    const result = await pool.query(
      `UPDATE loja_sugestoes SET status=$1, resposta=$2, respondido_por=$3, respondido_em=NOW() WHERE id=$4 RETURNING *`,
      [status, resposta, respondido_por, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao responder sugestão:', err);
    res.status(500).json({ error: 'Erro ao responder sugestão' });
  }
});

// DELETE - Remover sugestão
app.delete('/api/loja/sugestoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM loja_sugestoes WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover sugestão:', err);
    res.status(500).json({ error: 'Erro ao remover sugestão' });
  }
});

// ==================== MÓDULO BI ====================

// Listar todos os clientes/centros de custo configurados
app.get('/api/bi/prazos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.*, 
        COALESCE(json_agg(
          json_build_object('id', fp.id, 'km_min', fp.km_min, 'km_max', fp.km_max, 'prazo_minutos', fp.prazo_minutos)
          ORDER BY fp.km_min
        ) FILTER (WHERE fp.id IS NOT NULL), '[]') as faixas
      FROM bi_prazos_cliente pc
      LEFT JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
      GROUP BY pc.id
      ORDER BY pc.tipo, pc.nome
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar prazos:', err);
    res.status(500).json({ error: 'Erro ao listar prazos' });
  }
});

// Buscar prazo padrão
app.get('/api/bi/prazo-padrao', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar prazo padrão:', err);
    res.status(500).json({ error: 'Erro ao buscar prazo padrão' });
  }
});

// Salvar prazo padrão
app.post('/api/bi/prazo-padrao', async (req, res) => {
  try {
    const { faixas } = req.body;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_prazo_padrao`);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_prazo_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo padrão:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo padrão' });
  }
});

// Criar/Atualizar configuração de prazo para cliente/centro
app.post('/api/bi/prazos', async (req, res) => {
  try {
    const { tipo, codigo, nome, faixas } = req.body;
    
    // Inserir ou atualizar cliente
    const result = await pool.query(`
      INSERT INTO bi_prazos_cliente (tipo, codigo, nome, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tipo, codigo) DO UPDATE SET nome = $3, updated_at = NOW()
      RETURNING id
    `, [tipo, codigo, nome]);
    
    const clienteId = result.rows[0].id;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_faixas_prazo WHERE prazo_cliente_id = $1`, [clienteId]);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_faixas_prazo (prazo_cliente_id, km_min, km_max, prazo_minutos) VALUES ($1, $2, $3, $4)`,
        [clienteId, faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true, id: clienteId });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo' });
  }
});

// Remover configuração de prazo
app.delete('/api/bi/prazos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_prazos_cliente WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover prazo:', err);
    res.status(500).json({ error: 'Erro ao remover prazo' });
  }
});

// ========== ROTAS DE PRAZO PROFISSIONAL ==========

// Listar prazos profissionais
app.get('/api/bi/prazos-prof', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.id, pc.tipo, pc.codigo, pc.nome,
        json_agg(
          json_build_object('id', fp.id, 'km_min', fp.km_min, 'km_max', fp.km_max, 'prazo_minutos', fp.prazo_minutos)
        ) as faixas
      FROM bi_prazos_prof_cliente pc
      LEFT JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      GROUP BY pc.id
      ORDER BY pc.tipo, pc.nome
    `);
    res.json({ success: true, prazos: result.rows });
  } catch (err) {
    console.error('❌ Erro ao listar prazos profissionais:', err);
    res.status(500).json({ error: 'Erro ao listar prazos profissionais' });
  }
});

// Buscar prazo profissional padrão
app.get('/api/bi/prazo-prof-padrao', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar prazo prof padrão:', err);
    res.status(500).json({ error: 'Erro ao buscar prazo prof padrão' });
  }
});

// Salvar prazo profissional padrão
app.post('/api/bi/prazo-prof-padrao', async (req, res) => {
  try {
    const { faixas } = req.body;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_prazo_prof_padrao`);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_prazo_prof_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo prof padrão:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo prof padrão' });
  }
});

// Criar/Atualizar configuração de prazo profissional para cliente/centro
app.post('/api/bi/prazos-prof', async (req, res) => {
  try {
    const { tipo, codigo, nome, faixas } = req.body;
    
    // Inserir ou atualizar cliente
    const result = await pool.query(`
      INSERT INTO bi_prazos_prof_cliente (tipo, codigo, nome)
      VALUES ($1, $2, $3)
      ON CONFLICT (tipo, codigo) DO UPDATE SET nome = $3
      RETURNING id
    `, [tipo, codigo, nome]);
    
    const clienteId = result.rows[0].id;
    
    // Limpar faixas anteriores
    await pool.query(`DELETE FROM bi_faixas_prazo_prof WHERE prazo_prof_cliente_id = $1`, [clienteId]);
    
    // Inserir novas faixas
    for (const faixa of faixas) {
      await pool.query(
        `INSERT INTO bi_faixas_prazo_prof (prazo_prof_cliente_id, km_min, km_max, prazo_minutos) VALUES ($1, $2, $3, $4)`,
        [clienteId, faixa.km_min, faixa.km_max, faixa.prazo_minutos]
      );
    }
    
    res.json({ success: true, id: clienteId });
  } catch (err) {
    console.error('❌ Erro ao salvar prazo profissional:', err);
    res.status(500).json({ error: 'Erro ao salvar prazo profissional' });
  }
});

// Remover configuração de prazo profissional
app.delete('/api/bi/prazos-prof/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_prazos_prof_cliente WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover prazo profissional:', err);
    res.status(500).json({ error: 'Erro ao remover prazo profissional' });
  }
});

// Recalcular prazos profissionais de todas as entregas
app.post('/api/bi/entregas/recalcular-prazo-prof', async (req, res) => {
  try {
    // Buscar configurações de prazo profissional
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_prof_cliente pc
      JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
    `);
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
    
    console.log(`🔄 Recalculando Prazo Prof - Prazos cliente: ${prazosCliente.rows.length}, Prazo padrão: ${prazoPadrao.rows.length} faixas`);
    
    // Buscar todas as entregas com data_hora_alocado
    const entregas = await pool.query(`
      SELECT id, cod_cliente, centro_custo, distancia, data_hora_alocado, finalizado 
      FROM bi_entregas 
      WHERE data_hora_alocado IS NOT NULL
    `);
    console.log(`🔄 Total de entregas com alocação: ${entregas.rows.length}`);
    
    // Função para encontrar prazo profissional
    const encontrarPrazoProf = (codCliente, centroCusto, distancia) => {
      // Primeiro busca configuração específica
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Usa prazo padrão profissional
      if (prazoPadrao.rows.length > 0) {
        for (const faixa of prazoPadrao.rows) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Fallback: 60 minutos para qualquer distância
      return 60;
    };
    
    // Calcular tempo de execução profissional (alocado -> finalizado)
    const calcularTempoExecucaoProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      const inicio = new Date(dataHoraAlocado);
      const fim = new Date(finalizado);
      if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    let atualizados = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    let semPrazoCount = 0;
    
    for (const e of entregas.rows) {
      const distancia = parseFloat(e.distancia) || 0;
      const prazoMinutos = encontrarPrazoProf(e.cod_cliente, e.centro_custo, distancia);
      const tempoExecucao = calcularTempoExecucaoProf(e.data_hora_alocado, e.finalizado);
      const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
      
      if (dentroPrazo === true) dentroPrazoCount++;
      else if (dentroPrazo === false) foraPrazoCount++;
      else semPrazoCount++;
      
      // Log para debug (primeiras 5)
      if (atualizados < 5) {
        console.log(`🔄 ID ${e.id}: dist=${distancia}km, alocado=${e.data_hora_alocado}, finalizado=${e.finalizado}, prazo=${prazoMinutos}min, tempo=${tempoExecucao}min, dentro=${dentroPrazo}`);
      }
      
      await pool.query(`
        UPDATE bi_entregas SET dentro_prazo_prof = $1, prazo_prof_minutos = $2, tempo_execucao_prof_minutos = $3 WHERE id = $4
      `, [dentroPrazo, prazoMinutos, tempoExecucao, e.id]);
      atualizados++;
    }
    
    console.log(`✅ Prazo Prof Recalculado: ${atualizados} entregas`);
    console.log(`   ✅ Dentro: ${dentroPrazoCount} | ❌ Fora: ${foraPrazoCount} | ⚠️ Sem dados: ${semPrazoCount}`);
    res.json({ success: true, atualizados, dentroPrazo: dentroPrazoCount, foraPrazo: foraPrazoCount, semDados: semPrazoCount });
  } catch (err) {
    console.error('❌ Erro ao recalcular prazo prof:', err);
    res.status(500).json({ error: 'Erro ao recalcular prazo profissional' });
  }
});

// DIAGNÓSTICO - verificar dados do BI
// Endpoint para inicializar prazos com valores do DAX
app.post('/api/bi/inicializar-prazos-dax', async (req, res) => {
  try {
    // Tabela de prazos baseada no DAX_Prazo_Cliente
    const faixasPadrao = [
      { km_min: 0, km_max: 10, prazo_segundos: 3600 },
      { km_min: 10, km_max: 15, prazo_segundos: 4500 },
      { km_min: 15, km_max: 20, prazo_segundos: 5400 },
      { km_min: 20, km_max: 25, prazo_segundos: 6300 },
      { km_min: 25, km_max: 30, prazo_segundos: 7200 },
      { km_min: 30, km_max: 35, prazo_segundos: 8100 },
      { km_min: 35, km_max: 40, prazo_segundos: 9000 },
      { km_min: 40, km_max: 45, prazo_segundos: 9900 },
      { km_min: 45, km_max: 50, prazo_segundos: 10800 },
      { km_min: 50, km_max: 55, prazo_segundos: 11700 },
      { km_min: 55, km_max: 60, prazo_segundos: 12600 },
      { km_min: 60, km_max: 65, prazo_segundos: 13500 },
      { km_min: 65, km_max: 70, prazo_segundos: 14400 },
      { km_min: 70, km_max: 75, prazo_segundos: 15300 },
      { km_min: 75, km_max: 80, prazo_segundos: 16200 },
      { km_min: 80, km_max: 85, prazo_segundos: 17100 },
      { km_min: 85, km_max: 90, prazo_segundos: 18000 },
      { km_min: 90, km_max: 95, prazo_segundos: 18900 },
      { km_min: 95, km_max: 100, prazo_segundos: 19800 },
      // Acima de 100km = Fora do Prazo (prazo impossível de cumprir)
      { km_min: 100, km_max: null, prazo_segundos: 0 }
    ];
    
    // Limpar tabela de prazo padrão
    await pool.query(`DELETE FROM bi_prazo_padrao`);
    
    // Inserir faixas padrão (convertendo segundos para minutos)
    for (const faixa of faixasPadrao) {
      await pool.query(
        `INSERT INTO bi_prazo_padrao (km_min, km_max, prazo_minutos) VALUES ($1, $2, $3)`,
        [faixa.km_min, faixa.km_max, faixa.prazo_segundos / 60]
      );
    }
    
    // Recalcular prazo para todos os registros
    const totalAtualizados = await pool.query(`
      WITH prazo_calc AS (
        SELECT 
          e.id,
          CASE 
            -- Faixas padrão baseadas na distância
            WHEN e.distancia <= 10 THEN 60
            WHEN e.distancia <= 15 THEN 75
            WHEN e.distancia <= 20 THEN 90
            WHEN e.distancia <= 25 THEN 105
            WHEN e.distancia <= 30 THEN 120
            WHEN e.distancia <= 35 THEN 135
            WHEN e.distancia <= 40 THEN 150
            WHEN e.distancia <= 45 THEN 165
            WHEN e.distancia <= 50 THEN 180
            WHEN e.distancia <= 55 THEN 195
            WHEN e.distancia <= 60 THEN 210
            WHEN e.distancia <= 65 THEN 225
            WHEN e.distancia <= 70 THEN 240
            WHEN e.distancia <= 75 THEN 255
            WHEN e.distancia <= 80 THEN 270
            WHEN e.distancia <= 85 THEN 285
            WHEN e.distancia <= 90 THEN 300
            WHEN e.distancia <= 95 THEN 315
            WHEN e.distancia <= 100 THEN 330
            ELSE 0 -- Acima de 100km = sempre fora do prazo
          END as prazo_calculado
        FROM bi_entregas e
        WHERE e.distancia IS NOT NULL
      )
      UPDATE bi_entregas e
      SET prazo_minutos = pc.prazo_calculado,
          dentro_prazo = CASE 
            WHEN pc.prazo_calculado = 0 THEN false
            WHEN e.tempo_execucao_minutos IS NOT NULL AND e.tempo_execucao_minutos <= pc.prazo_calculado THEN true
            WHEN e.tempo_execucao_minutos IS NOT NULL AND e.tempo_execucao_minutos > pc.prazo_calculado THEN false
            ELSE NULL
          END
      FROM prazo_calc pc
      WHERE e.id = pc.id
    `);
    
    res.json({
      success: true,
      message: 'Prazos inicializados com valores do DAX',
      faixasPadrao: faixasPadrao.length,
      registrosAtualizados: totalAtualizados.rowCount
    });
  } catch (error) {
    console.error('Erro ao inicializar prazos DAX:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bi/diagnostico', async (req, res) => {
  try {
    // Versão do código para verificar deploy
    const versao = '2025-12-27-v11-fix-coleta-ponto';
    
    // Verificar prazo padrão
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    
    // Verificar entregas
    const entregas = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas`);
    const amostra = await pool.query(`SELECT id, os, ponto, cod_cliente, centro_custo, distancia, data_hora, data_hora_alocado, finalizado, execucao_comp, dentro_prazo, prazo_minutos, tempo_execucao_minutos FROM bi_entregas LIMIT 5`);
    
    // Verificar quantos têm prazo calculado
    const comPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo IS NOT NULL`);
    const dentroPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = true`);
    const foraPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = false`);
    
    // === NOVO: Diagnóstico de Alocação e Pontos ===
    const distribuicaoPontos = await pool.query(`
      SELECT COALESCE(ponto, 1) as ponto, COUNT(*) as total 
      FROM bi_entregas 
      GROUP BY COALESCE(ponto, 1) 
      ORDER BY ponto
    `);
    
    const comAlocado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE data_hora_alocado IS NOT NULL`);
    const comFinalizado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE finalizado IS NOT NULL`);
    const ponto1ComAlocado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE COALESCE(ponto, 1) = 1 AND data_hora_alocado IS NOT NULL`);
    const ponto2PlusComFinalizado = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL`);
    
    // Amostra de cálculo de tempo
    const amostraTempos = await pool.query(`
      SELECT 
        os, ponto, cod_cliente,
        data_hora,
        data_hora_alocado,
        finalizado,
        CASE WHEN COALESCE(ponto, 1) = 1 AND data_hora_alocado IS NOT NULL AND data_hora IS NOT NULL
          THEN EXTRACT(EPOCH FROM (data_hora_alocado - data_hora)) / 60
          ELSE NULL
        END as tempo_alocacao_min,
        CASE WHEN COALESCE(ponto, 1) >= 2 AND finalizado IS NOT NULL AND data_hora IS NOT NULL
          THEN EXTRACT(EPOCH FROM (finalizado - data_hora)) / 60
          ELSE NULL
        END as tempo_entrega_min
      FROM bi_entregas
      WHERE data_hora IS NOT NULL
      LIMIT 10
    `);
    
    // Verificar centros de custo
    const comCentroCusto = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != ''`);
    const centrosUnicos = await pool.query(`SELECT DISTINCT centro_custo, cod_cliente FROM bi_entregas WHERE centro_custo IS NOT NULL AND centro_custo != '' LIMIT 20`);
    
    // Verificar motivos (retornos)
    const comMotivo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE motivo IS NOT NULL AND motivo != ''`);
    const motivosErro = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE LOWER(motivo) LIKE '%erro%'`);
    const motivosUnicos = await pool.query(`SELECT DISTINCT motivo, COUNT(*) as qtd FROM bi_entregas WHERE motivo IS NOT NULL AND motivo != '' GROUP BY motivo ORDER BY qtd DESC LIMIT 20`);
    const amostraErros = await pool.query(`SELECT os, ponto, cod_cliente, motivo FROM bi_entregas WHERE LOWER(motivo) LIKE '%erro%' LIMIT 10`);
    
    // Verificar ocorrências (nova regra de retornos)
    const comOcorrencia = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != ''`);
    const ocorrenciasRetorno = await pool.query(`
      SELECT COUNT(*) as total FROM bi_entregas 
      WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' 
         OR LOWER(ocorrencia) LIKE '%clienteaus%'
         OR LOWER(ocorrencia) LIKE '%cliente ausente%'
         OR LOWER(ocorrencia) LIKE '%loja fechada%'
         OR LOWER(ocorrencia) LIKE '%produto incorreto%'
    `);
    const ocorrenciasUnicas = await pool.query(`SELECT DISTINCT ocorrencia, COUNT(*) as qtd FROM bi_entregas WHERE ocorrencia IS NOT NULL AND ocorrencia != '' GROUP BY ocorrencia ORDER BY qtd DESC LIMIT 30`);
    
    res.json({
      versao: versao,
      totalEntregas: entregas.rows[0].total,
      // Diagnóstico de tempos
      diagnosticoTempos: {
        distribuicaoPontos: distribuicaoPontos.rows,
        comDataHoraAlocado: comAlocado.rows[0].total,
        comFinalizado: comFinalizado.rows[0].total,
        ponto1ComAlocado: ponto1ComAlocado.rows[0].total,
        ponto2PlusComFinalizado: ponto2PlusComFinalizado.rows[0].total,
        amostraTempos: amostraTempos.rows
      },
      // Prazo
      comPrazoCalculado: comPrazo.rows[0].total,
      dentroPrazo: dentroPrazo.rows[0].total,
      foraPrazo: foraPrazo.rows[0].total,
      prazoPadrao: prazoPadrao.rows,
      // Centro de custo
      comCentroCusto: comCentroCusto.rows[0].total,
      centrosUnicos: centrosUnicos.rows,
      // Motivos e Ocorrências
      comMotivo: comMotivo.rows[0].total,
      motivosComErro: motivosErro.rows[0].total,
      motivosUnicos: motivosUnicos.rows,
      amostraErros: amostraErros.rows,
      comOcorrencia: comOcorrencia.rows[0].total,
      ocorrenciasRetorno: ocorrenciasRetorno.rows[0].total,
      ocorrenciasUnicas: ocorrenciasUnicas.rows,
      amostraEntregas: amostra.rows
    });
  } catch (err) {
    console.error('❌ Erro no diagnóstico:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload de entregas (recebe JSON do Excel processado no frontend)
app.post('/api/bi/entregas/upload', async (req, res) => {
  try {
    const { entregas, data_referencia, usuario_id, usuario_nome, nome_arquivo } = req.body;
    
    console.log(`📤 Upload BI: Recebendo ${entregas?.length || 0} entregas`);
    console.log(`👤 Usuário: ${usuario_nome || 'não informado'} (${usuario_id || 'sem id'})`);
    console.log(`📁 Arquivo: ${nome_arquivo || 'não informado'}`);
    
    if (!entregas || entregas.length === 0) {
      return res.status(400).json({ error: 'Nenhuma entrega recebida' });
    }
    
    // ============================================
    // PASSO 1: Extrair todas as OS únicas do Excel
    // ============================================
    const osDoExcel = [...new Set(entregas.map(e => parseInt(e.os)).filter(os => os && !isNaN(os)))];
    console.log(`📋 Total de OS únicas no Excel: ${osDoExcel.length}`);
    
    if (osDoExcel.length === 0) {
      return res.status(400).json({ error: 'Nenhuma OS válida encontrada no arquivo' });
    }
    
    // ============================================
    // PASSO 2: Verificar quais OS já existem no banco
    // ============================================
    const osExistentesQuery = await pool.query(`
      SELECT DISTINCT os FROM bi_entregas WHERE os = ANY($1::int[])
    `, [osDoExcel]);
    
    const osExistentes = new Set(osExistentesQuery.rows.map(r => r.os));
    console.log(`🔍 OS que já existem no banco: ${osExistentes.size}`);
    
    // ============================================
    // PASSO 3: Filtrar apenas entregas com OS novas
    // ============================================
    const entregasNovas = entregas.filter(e => {
      const os = parseInt(e.os);
      return os && !isNaN(os) && !osExistentes.has(os);
    });
    
    const osIgnoradas = osDoExcel.filter(os => osExistentes.has(os));
    console.log(`✅ Entregas novas para inserir: ${entregasNovas.length}`);
    console.log(`⏭️ Linhas ignoradas (OS já existe): ${entregas.length - entregasNovas.length}`);
    
    if (entregasNovas.length === 0) {
      // Registrar tentativa no histórico mesmo sem inserir nada
      await pool.query(`
        INSERT INTO bi_upload_historico (usuario_id, usuario_nome, nome_arquivo, total_linhas, linhas_inseridas, linhas_ignoradas, data_upload)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [usuario_id, usuario_nome, nome_arquivo, entregas.length, 0, entregas.length]);
      
      return res.json({ 
        success: true, 
        inseridos: 0, 
        ignorados: entregas.length,
        os_ignoradas: osIgnoradas.length,
        message: 'Todas as OS já existem no banco de dados'
      });
    }
    
    // ============================================
    // PASSO 4: Buscar configurações de prazo
    // ============================================
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_cliente pc
      JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
    `).catch(() => ({ rows: [] }));
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`).catch(() => ({ rows: [] }));
    
    // Função para encontrar prazo baseado na distância - REGRAS DAX
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      // Primeiro tenta buscar do banco (configurações personalizadas)
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração personalizada, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Se não tem configuração personalizada, usa regras DAX padrão
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 120;
      if (distancia <= 35) return 135;
      if (distancia <= 40) return 150;
      if (distancia <= 45) return 165;
      if (distancia <= 50) return 180;
      if (distancia <= 55) return 195;
      if (distancia <= 60) return 210;
      if (distancia <= 65) return 225;
      if (distancia <= 70) return 240;
      if (distancia <= 75) return 255;
      if (distancia <= 80) return 270;
      if (distancia <= 85) return 285;
      if (distancia <= 90) return 300;
      if (distancia <= 95) return 315;
      if (distancia <= 100) return 330;
      
      // Acima de 100km = sempre fora do prazo (prazo 0)
      return 0;
    };
    
    // Funções auxiliares de parsing
    const parseDataHora = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        return new Date(excelEpoch.getTime() + valor * 86400000);
      }
      if (typeof valor === 'string') {
        const regex = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
        const match = valor.match(regex);
        if (match) {
          const [_, dia, mes, ano, hora, min, seg] = match;
          return new Date(ano, mes - 1, dia, hora, min, seg || 0);
        }
        const d = new Date(valor);
        if (!isNaN(d.getTime())) return d;
      }
      return null;
    };
    
    const calcularTempoExecucao = (execucaoComp, dataHora, finalizado) => {
      if (execucaoComp !== null && execucaoComp !== undefined && execucaoComp !== '') {
        if (typeof execucaoComp === 'number') {
          return Math.round(execucaoComp * 24 * 60);
        }
        if (typeof execucaoComp === 'string' && execucaoComp.includes(':')) {
          const partes = execucaoComp.split(':');
          if (partes.length >= 2) {
            return (parseInt(partes[0]) || 0) * 60 + (parseInt(partes[1]) || 0);
          }
        }
      }
      if (dataHora && finalizado && typeof dataHora === 'number' && typeof finalizado === 'number') {
        const diff = finalizado - dataHora;
        if (diff >= 0) {
          return Math.round(diff * 24 * 60);
        }
      }
      return null;
    };
    
    // Função para calcular T. Entrega Prof a partir de Data/Hora Alocado até Finalizado
    const calcularTempoEntregaProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      const inicio = parseDataHora(dataHoraAlocado);
      const fim = parseDataHora(finalizado);
      if (!inicio || !fim) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    // Buscar configurações de prazo profissional
    let prazosProfCliente = [];
    let prazoProfPadrao = [];
    try {
      const prazosProf = await pool.query(`
        SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
        FROM bi_prazos_prof_cliente pc
        JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      `);
      prazosProfCliente = prazosProf.rows;
      
      const prazoProfPadraoResult = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
      prazoProfPadrao = prazoProfPadraoResult.rows;
    } catch (err) {
      console.log('⚠️ Tabelas de prazo profissional não encontradas, usando fallback');
    }
    
    // Função para encontrar prazo profissional
    const encontrarPrazoProf = (codCliente, centroCusto, distancia) => {
      // Primeiro busca configuração específica
      let faixas = prazosProfCliente.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosProfCliente.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Usa prazo padrão profissional
      if (prazoProfPadrao.length > 0) {
        for (const faixa of prazoProfPadrao) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Fallback: 60 minutos para qualquer distância
      return 60;
    };
    
    const parseData = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        const date = new Date(excelEpoch.getTime() + valor * 86400000);
        return date.toISOString().split('T')[0];
      }
      if (typeof valor === 'string' && valor.includes('/')) {
        const partes = valor.split(/[\s\/]/);
        if (partes.length >= 3) {
          return `${partes[2]}-${partes[1].padStart(2,'0')}-${partes[0].padStart(2,'0')}`;
        }
      }
      return valor;
    };
    
    const parseTimestamp = (valor) => {
      const d = parseDataHora(valor);
      return d ? d.toISOString() : null;
    };
    
    const parseNum = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') return valor;
      const str = String(valor).replace(',', '.').replace(/[^\d.-]/g, '');
      const num = parseFloat(str);
      return isNaN(num) ? null : num;
    };
    
    // Função para parsear hora (HH:MM:SS ou HH:MM)
    const parseHora = (valor) => {
      if (!valor) return null;
      try {
        // Se for string no formato HH:MM:SS ou HH:MM
        if (typeof valor === 'string') {
          const match = valor.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
          if (match) {
            const h = match[1].padStart(2, '0');
            const m = match[2].padStart(2, '0');
            const s = match[3] ? match[3].padStart(2, '0') : '00';
            return `${h}:${m}:${s}`;
          }
        }
        // Se for número decimal do Excel (fração do dia)
        if (typeof valor === 'number' && valor < 1) {
          const totalSeconds = Math.round(valor * 24 * 60 * 60);
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const seconds = totalSeconds % 60;
          return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return null;
      } catch {
        return null;
      }
    };
    
    const truncar = (str, max) => str ? String(str).substring(0, max) : null;
    
    // ============================================
    // PASSO 5: Processar e inserir entregas novas
    // ============================================
    let inseridos = 0;
    let erros = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    
    const BATCH_SIZE = 500;
    const totalBatches = Math.ceil(entregasNovas.length / BATCH_SIZE);
    
    console.log(`📦 Processando ${entregasNovas.length} linhas novas em ${totalBatches} lotes`);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, entregasNovas.length);
      const batch = entregasNovas.slice(start, end);
      
      const dadosLote = [];
      
      for (const e of batch) {
        try {
          const os = parseInt(e.os);
          if (!os) continue;
          
          const distancia = parseNum(e.distancia) || 0;
          const prazoMinutos = encontrarPrazo(e.cod_cliente, e.centro_custo, distancia);
          const tempoExecucao = calcularTempoExecucao(e.execucao_comp, e.data_hora, e.finalizado);
          const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
          
          // Calcular Prazo Profissional: Data/Hora Alocado → Finalizado
          const prazoMinutosProf = encontrarPrazoProf(e.cod_cliente, e.centro_custo, distancia);
          const tempoEntregaProf = calcularTempoEntregaProf(e.data_hora_alocado, e.finalizado);
          const dentroPrazoProf = (prazoMinutosProf !== null && tempoEntregaProf !== null) ? tempoEntregaProf <= prazoMinutosProf : null;
          
          if (dentroPrazo === true) dentroPrazoCount++;
          if (dentroPrazo === false) foraPrazoCount++;
          
          // Extrair ponto - primeiro tenta campo direto, depois extrai do endereço
          let ponto = parseInt(e.ponto || e.Ponto || e.seq || e.Seq || e.sequencia || e.Sequencia || e.pt || e.Pt || 0) || 0;
          const enderecoStr = e.endereco || e['Endereço'] || e.Endereco || '';
          if (ponto === 0 && enderecoStr) {
            const matchPonto = String(enderecoStr).match(/^Ponto\s*(\d+)/i);
            if (matchPonto) ponto = parseInt(matchPonto[1]) || 1;
          }
          if (ponto === 0) ponto = 1;
          
          dadosLote.push({
            os,
            ponto,
            num_pedido: truncar(e.num_pedido || e['Num Pedido'] || e['Num pedido'] || e['num pedido'], 100),
            cod_cliente: parseInt(e.cod_cliente || e['Cod Cliente'] || e['Cod cliente'] || e['cod cliente'] || e['Cód Cliente'] || e['Cód. cliente']) || null,
            nome_cliente: truncar(e.nome_cliente || e['Nome cliente'] || e['Nome Cliente'], 255),
            empresa: truncar(e.empresa || e.Empresa, 255),
            nome_fantasia: truncar(e.nome_fantasia || e['Nome Fantasia'] || e['Nome fantasia'], 255),
            centro_custo: truncar(e.centro_custo || e['Centro Custo'] || e['Centro custo'] || e['centro custo'] || e['Centro de Custo'] || e['Centro de custo'] || e.CentroCusto, 255),
            cidade_p1: truncar(e.cidade_p1 || e['Cidade P1'] || e['Cidade p1'], 100),
            endereco: enderecoStr || null,
            bairro: truncar(e.bairro, 100),
            cidade: truncar(e.cidade, 100),
            estado: truncar(e.estado, 50),
            cod_prof: parseInt(e.cod_prof) || null,
            nome_prof: truncar(e.nome_prof, 255),
            data_hora: parseTimestamp(e.data_hora),
            data_hora_alocado: parseTimestamp(e.data_hora_alocado || e['Data/Hora Alocado'] || e['Data Hora Alocado'] || e['DataHoraAlocado']),
            finalizado: parseTimestamp(e.finalizado),
            data_solicitado: parseData(e.data_solicitado) || parseData(e.data_hora),
            data_chegada: parseData(e.data_chegada || e['Data Chegada'] || e['Data chegada']),
            hora_chegada: parseHora(e.hora_chegada || e['Hora Chegada'] || e['Hora chegada']),
            data_saida: parseData(e.data_saida || e['Data Saida'] || e['Data Saída'] || e['Data saida']),
            hora_saida: parseHora(e.hora_saida || e['Hora Saida'] || e['Hora Saída'] || e['Hora saida']),
            categoria: truncar(e.categoria, 100),
            valor: parseNum(e.valor),
            distancia: distancia,
            valor_prof: parseNum(e.valor_prof),
            execucao_comp: truncar(e.execucao_comp ? String(e.execucao_comp) : null, 50),
            execucao_espera: truncar(e.execucao_espera ? String(e.execucao_espera) : null, 50),
            status: truncar(e.status, 100),
            motivo: truncar(e.motivo, 255),
            ocorrencia: truncar(e.ocorrencia, 255),
            velocidade_media: parseNum(e.velocidade_media),
            dentro_prazo: dentroPrazo,
            prazo_minutos: prazoMinutos,
            tempo_execucao_minutos: tempoExecucao,
            tempo_entrega_prof_minutos: tempoEntregaProf,
            dentro_prazo_prof: dentroPrazoProf,
            data_upload: data_referencia || new Date().toISOString().split('T')[0],
            latitude: parseNum(e.latitude || e.Latitude || e.lat || e.Lat || e.LAT || e.LATITUDE),
            longitude: parseNum(e.longitude || e.Longitude || e.lng || e.Lng || e.LNG || e.LONGITUDE || e.long || e.Long)
          });
        } catch (err) {
          erros++;
        }
      }
      
      // Inserir lote
      if (dadosLote.length > 0) {
        for (const d of dadosLote) {
          try {
            await pool.query(`
              INSERT INTO bi_entregas (
                os, ponto, num_pedido, cod_cliente, nome_cliente, empresa,
                nome_fantasia, centro_custo, cidade_p1, endereco,
                bairro, cidade, estado, cod_prof, nome_prof,
                data_hora, data_hora_alocado, finalizado, data_solicitado,
                data_chegada, hora_chegada, data_saida, hora_saida,
                categoria, valor, distancia, valor_prof,
                execucao_comp, execucao_espera, status, motivo, ocorrencia, velocidade_media,
                dentro_prazo, prazo_minutos, tempo_execucao_minutos, 
                tempo_entrega_prof_minutos, dentro_prazo_prof,
                data_upload, latitude, longitude
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
            `, [
              d.os, d.ponto, d.num_pedido, d.cod_cliente, d.nome_cliente, d.empresa,
              d.nome_fantasia, d.centro_custo, d.cidade_p1, d.endereco,
              d.bairro, d.cidade, d.estado, d.cod_prof, d.nome_prof,
              d.data_hora, d.data_hora_alocado, d.finalizado, d.data_solicitado,
              d.data_chegada, d.hora_chegada, d.data_saida, d.hora_saida,
              d.categoria, d.valor, d.distancia, d.valor_prof,
              d.execucao_comp, d.execucao_espera, d.status, d.motivo, d.ocorrencia, d.velocidade_media,
              d.dentro_prazo, d.prazo_minutos, d.tempo_execucao_minutos,
              d.tempo_entrega_prof_minutos, d.dentro_prazo_prof,
              d.data_upload, d.latitude, d.longitude
            ]);
            inseridos++;
          } catch (singleErr) {
            erros++;
          }
        }
      }
    }
    
    // ============================================
    // PASSO 6: Registrar no histórico de uploads
    // ============================================
    const linhasIgnoradas = entregas.length - entregasNovas.length;
    
    await pool.query(`
      INSERT INTO bi_upload_historico (usuario_id, usuario_nome, nome_arquivo, total_linhas, linhas_inseridas, linhas_ignoradas, os_novas, os_ignoradas, data_upload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      usuario_id, 
      usuario_nome, 
      nome_arquivo, 
      entregas.length, 
      inseridos, 
      linhasIgnoradas,
      osDoExcel.length - osIgnoradas.length,
      osIgnoradas.length
    ]);
    
    console.log(`✅ Upload concluído: ${inseridos} inseridos, ${linhasIgnoradas} ignorados (OS duplicada), ${erros} erros`);
    console.log(`📊 Dentro do prazo: ${dentroPrazoCount}, Fora do prazo: ${foraPrazoCount}`);
    
    // ============================================
    // PASSO 7: Atualizar resumos pré-calculados
    // ============================================
    // Extrair datas únicas das entregas inseridas para atualizar apenas essas datas
    const datasAfetadas = [...new Set(entregasNovas.map(e => e.data_solicitado).filter(d => d))];
    console.log(`📊 Atualizando resumos para ${datasAfetadas.length} data(s)...`);
    
    // Atualizar resumos em background (não bloqueia a resposta)
    atualizarResumos(datasAfetadas).then(resultado => {
      console.log('📊 Resumos atualizados:', resultado);
    }).catch(err => {
      console.error('❌ Erro ao atualizar resumos:', err);
    });
    
    res.json({
      success: true,
      inseridos,
      ignorados: linhasIgnoradas,
      erros,
      os_novas: osDoExcel.length - osIgnoradas.length,
      os_ignoradas: osIgnoradas.length,
      dentro_prazo: dentroPrazoCount,
      fora_prazo: foraPrazoCount
    });
  } catch (err) {
    console.error('❌ Erro no upload:', err);
    res.status(500).json({ error: 'Erro ao fazer upload: ' + err.message });
  }
});

// Recalcular prazos de todas as entregas
app.post('/api/bi/entregas/recalcular', async (req, res) => {
  try {
    // Buscar configurações de prazo
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_cliente pc
      JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
    `);
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    
    console.log(`🔄 Recalculando - Prazos cliente: ${prazosCliente.rows.length}, Prazo padrão: ${prazoPadrao.rows.length} faixas`);
    if (prazoPadrao.rows.length > 0) {
      console.log(`🔄 Faixas padrão:`, prazoPadrao.rows.map(f => `${f.km_min}-${f.km_max || '∞'}km=${f.prazo_minutos}min`).join(', '));
    } else {
      console.log(`⚠️ ATENÇÃO: Nenhum prazo padrão configurado! Configure na aba Prazos.`);
    }
    
    // Buscar todas as entregas
    const entregas = await pool.query(`SELECT id, cod_cliente, centro_custo, distancia, data_hora, finalizado, execucao_comp FROM bi_entregas`);
    console.log(`🔄 Total de entregas: ${entregas.rows.length}`);
    
    // Função para encontrar prazo - REGRAS DAX
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      // Primeiro tenta buscar do banco (configurações personalizadas)
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // Se tem configuração personalizada, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // Regras DAX padrão
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 120;
      if (distancia <= 35) return 135;
      if (distancia <= 40) return 150;
      if (distancia <= 45) return 165;
      if (distancia <= 50) return 180;
      if (distancia <= 55) return 195;
      if (distancia <= 60) return 210;
      if (distancia <= 65) return 225;
      if (distancia <= 70) return 240;
      if (distancia <= 75) return 255;
      if (distancia <= 80) return 270;
      if (distancia <= 85) return 285;
      if (distancia <= 90) return 300;
      if (distancia <= 95) return 315;
      if (distancia <= 100) return 330;
      
      // Acima de 100km = sempre fora do prazo
      return 0;
    };
    
    // Calcular tempo em minutos
    const calcularTempoExecucao = (execucaoComp, dataHora, finalizado) => {
      // Se tiver execucao_comp como string HH:MM:SS
      if (execucaoComp && typeof execucaoComp === 'string' && execucaoComp.includes(':')) {
        const partes = execucaoComp.split(':');
        if (partes.length >= 2) {
          return (parseInt(partes[0]) || 0) * 60 + (parseInt(partes[1]) || 0);
        }
      }
      
      // Calcular a partir dos timestamps
      if (!dataHora || !finalizado) return null;
      const inicio = new Date(dataHora);
      const fim = new Date(finalizado);
      if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return null;
      const diffMs = fim.getTime() - inicio.getTime();
      if (diffMs < 0) return null;
      return Math.round(diffMs / 60000); // ms para minutos
    };
    
    let atualizados = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    let semPrazoCount = 0;
    
    for (const e of entregas.rows) {
      const distancia = parseFloat(e.distancia) || 0;
      const prazoMinutos = encontrarPrazo(e.cod_cliente, e.centro_custo, distancia);
      const tempoExecucao = calcularTempoExecucao(e.execucao_comp, e.data_hora, e.finalizado);
      const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
      
      if (dentroPrazo === true) dentroPrazoCount++;
      else if (dentroPrazo === false) foraPrazoCount++;
      else semPrazoCount++;
      
      // Log para debug (primeiras 5)
      if (atualizados < 5) {
        console.log(`🔄 ID ${e.id}: dist=${distancia}km, execComp="${e.execucao_comp}", data_hora=${e.data_hora}, finalizado=${e.finalizado}, prazo=${prazoMinutos}min, tempo=${tempoExecucao}min, dentro=${dentroPrazo}`);
      }
      
      await pool.query(`
        UPDATE bi_entregas SET dentro_prazo = $1, prazo_minutos = $2, tempo_execucao_minutos = $3 WHERE id = $4
      `, [dentroPrazo, prazoMinutos, tempoExecucao, e.id]);
      atualizados++;
    }
    
    console.log(`✅ Recalculado: ${atualizados} entregas`);
    console.log(`   ✅ Dentro: ${dentroPrazoCount} | ❌ Fora: ${foraPrazoCount} | ⚠️ Sem dados: ${semPrazoCount}`);
    res.json({ success: true, atualizados, dentroPrazo: dentroPrazoCount, foraPrazo: foraPrazoCount, semDados: semPrazoCount });
  } catch (err) {
    console.error('❌ Erro ao recalcular:', err);
    res.status(500).json({ error: 'Erro ao recalcular' });
  }
});

// Atualizar resumos pré-calculados (forçar recálculo)
app.post('/api/bi/atualizar-resumos', async (req, res) => {
  try {
    console.log('📊 Forçando atualização de resumos...');
    const resultado = await atualizarResumos();
    res.json(resultado);
  } catch (err) {
    console.error('❌ Erro ao atualizar resumos:', err);
    res.status(500).json({ error: 'Erro ao atualizar resumos: ' + err.message });
  }
});

// Obter métricas do dashboard usando resumos pré-calculados (OTIMIZADO)
app.get('/api/bi/dashboard-rapido', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Usar resumo diário para métricas gerais
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    // Se tem filtro de cliente, usar bi_resumo_cliente
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        // Buscar métricas por cliente
        const clienteQuery = await pool.query(`
          SELECT 
            SUM(total_os) as total_os,
            SUM(total_entregas) as total_entregas,
            SUM(entregas_no_prazo) as entregas_no_prazo,
            SUM(entregas_fora_prazo) as entregas_fora_prazo,
            ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 2) as taxa_prazo,
            SUM(total_retornos) as total_retornos,
            SUM(valor_total) as valor_total,
            SUM(valor_prof) as valor_prof,
            ROUND(SUM(valor_total)::numeric / NULLIF(SUM(total_entregas), 0), 2) as ticket_medio,
            ROUND(AVG(tempo_medio_entrega), 2) as tempo_medio_entrega,
            SUM(total_profissionais) as total_profissionais
          FROM bi_resumo_cliente
          ${whereClause} AND cod_cliente = ANY($${paramIndex}::int[])
        `, [...params, clientes]);
        
        return res.json({
          metricas: clienteQuery.rows[0] || {},
          fonte: 'resumo_cliente'
        });
      }
    }
    
    // Sem filtro de cliente, usar resumo diário
    const diarioQuery = await pool.query(`
      SELECT 
        SUM(total_os) as total_os,
        SUM(total_entregas) as total_entregas,
        SUM(entregas_no_prazo) as entregas_no_prazo,
        SUM(entregas_fora_prazo) as entregas_fora_prazo,
        ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 2) as taxa_prazo,
        SUM(total_retornos) as total_retornos,
        SUM(valor_total) as valor_total,
        SUM(valor_prof) as valor_prof,
        ROUND(SUM(valor_total)::numeric / NULLIF(SUM(total_entregas), 0), 2) as ticket_medio,
        ROUND(AVG(tempo_medio_entrega), 2) as tempo_medio_entrega,
        ROUND(AVG(tempo_medio_alocacao), 2) as tempo_medio_alocacao,
        ROUND(AVG(tempo_medio_coleta), 2) as tempo_medio_coleta,
        SUM(total_profissionais) as total_profissionais,
        ROUND(AVG(media_ent_profissional), 2) as media_ent_profissional,
        SUM(km_total) as km_total
      FROM bi_resumo_diario
      ${whereClause}
    `, params);
    
    res.json({
      metricas: diarioQuery.rows[0] || {},
      fonte: 'resumo_diario'
    });
  } catch (err) {
    console.error('❌ Erro dashboard rápido:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// ============================================
// RELATÓRIO IA COM GEMINI
// ============================================
app.get('/api/bi/relatorio-ia', async (req, res) => {
  try {
    const { data_inicio, data_fim, prompt_custom } = req.query;
    // Suportar múltiplos tipos
    const tipos = req.query.tipo ? (Array.isArray(req.query.tipo) ? req.query.tipo : [req.query.tipo]) : ['performance'];
    const cod_cliente = req.query.cod_cliente ? (Array.isArray(req.query.cod_cliente) ? req.query.cod_cliente : [req.query.cod_cliente]) : [];
    const centro_custo = req.query.centro_custo ? (Array.isArray(req.query.centro_custo) ? req.query.centro_custo : [req.query.centro_custo]) : [];
    
    console.log(`🤖 Gerando relatório IA: tipos=${tipos.join(', ')}, período=${data_inicio} a ${data_fim}`);
    
    // Verificar se tem API key do Gemini
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(400).json({ error: 'API Key do Gemini não configurada. Adicione GEMINI_API_KEY nas variáveis de ambiente.' });
    }
    
    // Construir filtro WHERE
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente.length > 0) {
      whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
      params.push(cod_cliente.map(c => parseInt(c)));
      paramIndex++;
    }
    if (centro_custo.length > 0) {
      whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
      params.push(centro_custo);
      paramIndex++;
    }
    
    // 1. Buscar métricas gerais (EXPANDIDO)
    const metricasQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2) as taxa_prazo,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2) as tempo_medio_entrega,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_execucao_minutos END), 2) as tempo_medio_alocacao,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_entrega_prof_minutos END), 2) as tempo_medio_coleta,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_profissionais,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_cliente END) as total_clientes,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 2) as km_medio,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END) as total_retornos,
        MIN(data_solicitado) as data_inicio_real,
        MAX(data_solicitado) as data_fim_real
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    const metricas = metricasQuery.rows[0];
    
    // 2. Buscar dados por dia
    const porDiaQuery = await pool.query(`
      SELECT 
        data_solicitado as data,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // 3. Buscar top clientes (com mais dados)
    const topClientesQuery = await pool.query(`
      SELECT 
        nome_fantasia as cliente,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 1) as km_medio,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END) as retornos
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_fantasia
      ORDER BY COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) DESC
      LIMIT 10
    `, params);
    
    // 4. Buscar top profissionais (com mais dados)
    const topProfsQuery = await pool.query(`
      SELECT 
        nome_prof as profissional,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_recebido
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_prof
      ORDER BY COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) DESC
      LIMIT 10
    `, params);
    
    // 5. Buscar piores profissionais (taxa baixa)
    const pioresProfsQuery = await pool.query(`
      SELECT 
        nome_prof as profissional,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_prof
      HAVING COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) >= 10
      ORDER BY ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) ASC
      LIMIT 5
    `, params);
    
    // 6. Buscar distribuição por dia da semana
    const porDiaSemanaQuery = await pool.query(`
      SELECT 
        EXTRACT(DOW FROM data_solicitado) as dia_semana,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio
      FROM bi_entregas
      ${whereClause}
      GROUP BY EXTRACT(DOW FROM data_solicitado)
      ORDER BY EXTRACT(DOW FROM data_solicitado)
    `, params);
    
    // 7. Buscar distribuição por hora do dia (usando data_hora que é TIMESTAMP)
    let porHoraQuery = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM data_hora) as hora,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo
      FROM bi_entregas
      ${whereClause} AND data_hora IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM data_hora)
      HAVING COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) > 0
      ORDER BY EXTRACT(HOUR FROM data_hora)
    `, params);
    
    console.log('📊 Dados por hora (data_hora):', porHoraQuery.rows.length, 'registros');
    
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const dadosDiaSemana = porDiaSemanaQuery.rows.map(r => ({
      dia: diasSemana[parseInt(r.dia_semana)],
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa_prazo) || 0,
      tempo_medio: parseFloat(r.tempo_medio) || 0
    }));
    
    const dadosPorHora = porHoraQuery.rows.map(r => ({
      hora: parseInt(r.hora),
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa_prazo) || 0
    })).sort((a, b) => a.hora - b.hora);
    
    // Calcular horário de pico
    const horarioPico = dadosPorHora.length > 0 
      ? dadosPorHora.reduce((max, h) => h.entregas > max.entregas ? h : max, dadosPorHora[0])
      : null;
    
    // Calcular total de entregas para % do pico
    const totalEntregasHora = dadosPorHora.reduce((sum, h) => sum + h.entregas, 0);
    
    // Identificar janela de pico (3 horas consecutivas com maior volume)
    let melhorJanela = { inicio: 0, fim: 0, entregas: 0 };
    for (let i = 0; i < dadosPorHora.length - 2; i++) {
      const somaJanela = dadosPorHora[i].entregas + (dadosPorHora[i+1]?.entregas || 0) + (dadosPorHora[i+2]?.entregas || 0);
      if (somaJanela > melhorJanela.entregas) {
        melhorJanela = { 
          inicio: dadosPorHora[i].hora, 
          fim: dadosPorHora[i+2]?.hora || dadosPorHora[i].hora, 
          entregas: somaJanela 
        };
      }
    }
    
    // Calcular variações e tendências
    const evolucaoDiaria = porDiaQuery.rows.slice(-14).map(r => ({
      data: r.data,
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa) || 0,
      valor: parseFloat(r.valor) || 0,
      profissionais: parseInt(r.profissionais) || 0
    }));
    
    // Calcular tendência (comparar primeira metade com segunda metade)
    const metade = Math.floor(evolucaoDiaria.length / 2);
    const primeiraParte = evolucaoDiaria.slice(0, metade);
    const segundaParte = evolucaoDiaria.slice(metade);
    const mediaPrimeira = primeiraParte.length > 0 ? primeiraParte.reduce((a, b) => a + b.taxa_prazo, 0) / primeiraParte.length : 0;
    const mediaSegunda = segundaParte.length > 0 ? segundaParte.reduce((a, b) => a + b.taxa_prazo, 0) / segundaParte.length : 0;
    const tendencia = mediaSegunda - mediaPrimeira;
    
    // Montar contexto para a IA (EXPANDIDO)
    const contexto = {
      periodo: { inicio: data_inicio || metricas.data_inicio_real, fim: data_fim || metricas.data_fim_real },
      metricas_gerais: {
        total_os: parseInt(metricas.total_os) || 0,
        total_entregas: parseInt(metricas.total_entregas) || 0,
        taxa_prazo: parseFloat(metricas.taxa_prazo) || 0,
        entregas_no_prazo: parseInt(metricas.entregas_no_prazo) || 0,
        entregas_fora_prazo: parseInt(metricas.entregas_fora_prazo) || 0,
        total_retornos: parseInt(metricas.total_retornos) || 0,
        valor_total: parseFloat(metricas.valor_total) || 0,
        valor_profissionais: parseFloat(metricas.valor_prof) || 0,
        lucro_bruto: (parseFloat(metricas.valor_total) || 0) - (parseFloat(metricas.valor_prof) || 0),
        margem_percentual: parseFloat(metricas.valor_total) > 0 ? (((parseFloat(metricas.valor_total) - parseFloat(metricas.valor_prof)) / parseFloat(metricas.valor_total)) * 100).toFixed(1) : 0,
        tempo_medio_entrega: parseFloat(metricas.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(metricas.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(metricas.tempo_medio_coleta) || 0,
        km_total: parseFloat(metricas.km_total) || 0,
        km_medio: parseFloat(metricas.km_medio) || 0,
        total_profissionais: parseInt(metricas.total_profissionais) || 0,
        total_clientes: parseInt(metricas.total_clientes) || 0,
        total_dias_periodo: porDiaQuery.rows.length || 1,
        media_entregas_por_dia: porDiaQuery.rows.length > 0 ? (parseInt(metricas.total_entregas) / porDiaQuery.rows.length).toFixed(1) : 0,
        profissionais_ideais_por_dia: porDiaQuery.rows.length > 0 ? Math.ceil((parseInt(metricas.total_entregas) / porDiaQuery.rows.length) / 10) : 0,
        media_entregas_por_profissional: parseInt(metricas.total_profissionais) > 0 ? (parseInt(metricas.total_entregas) / parseInt(metricas.total_profissionais)).toFixed(1) : 0,
        ticket_medio: parseInt(metricas.total_entregas) > 0 ? (parseFloat(metricas.valor_total) / parseInt(metricas.total_entregas)).toFixed(2) : 0
      },
      tendencia: {
        variacao_taxa: tendencia.toFixed(1),
        direcao: tendencia > 1 ? 'MELHORANDO' : tendencia < -1 ? 'PIORANDO' : 'ESTÁVEL'
      },
      evolucao_diaria: evolucaoDiaria,
      top_clientes: topClientesQuery.rows.map(r => ({
        cliente: r.cliente,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        valor: parseFloat(r.valor) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0,
        km_medio: parseFloat(r.km_medio) || 0,
        retornos: parseInt(r.retornos) || 0
      })),
      top_profissionais: topProfsQuery.rows.map(r => ({
        profissional: r.profissional,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0,
        km_total: parseFloat(r.km_total) || 0,
        valor_recebido: parseFloat(r.valor_recebido) || 0
      })),
      piores_profissionais: pioresProfsQuery.rows.map(r => ({
        profissional: r.profissional,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0
      })),
      distribuicao_dia_semana: dadosDiaSemana,
      distribuicao_hora: dadosPorHora,
      horario_pico: horarioPico ? {
        hora: horarioPico.hora,
        entregas_total_periodo: horarioPico.entregas,
        entregas_media_dia: (horarioPico.entregas / (porDiaQuery.rows.length || 1)).toFixed(1),
        percentual: totalEntregasHora > 0 ? ((horarioPico.entregas / totalEntregasHora) * 100).toFixed(1) : 0,
        profissionais_necessarios: Math.ceil(horarioPico.entregas / (porDiaQuery.rows.length || 1) / 10)
      } : null,
      janela_pico: {
        inicio: melhorJanela.inicio,
        fim: melhorJanela.fim,
        entregas_total_periodo: melhorJanela.entregas,
        entregas_media_dia: (melhorJanela.entregas / (porDiaQuery.rows.length || 1)).toFixed(1),
        percentual: totalEntregasHora > 0 ? ((melhorJanela.entregas / totalEntregasHora) * 100).toFixed(1) : 0,
        profissionais_necessarios: Math.ceil(melhorJanela.entregas / (porDiaQuery.rows.length || 1) / 10)
      }
    };
    
    // Definir prompt base por tipo
    const promptsBase = {
      performance: `## 📈 PERFORMANCE GERAL
Analise a performance da operação de forma DIRETA:
- Taxa de prazo atual vs benchmark (85%+ é bom)
- Tempo médio de entrega (adequado ou não)
- Pontos fortes (máx 3)
- Pontos fracos (máx 3)
- **NOTA GERAL: X/10**`,
      
      tendencias: `## 📉 TENDÊNCIAS E PREDIÇÃO

**1️⃣ COMPORTAMENTO DA DEMANDA**
- Tendência: 📈 CRESCIMENTO | 📉 QUEDA | ➡️ ESTÁVEL
- Variação no período: +X% ou -X%
- Se queda acentuada (>15%): 🔴 ALERTA - Retração de X%

**2️⃣ SAZONALIDADE E PICOS**
| Ranking | Dia da Semana | Volume | % do Total |
|---------|---------------|--------|------------|
| 🥇 | [dia] | X ent | X% |
| 🥈 | [dia] | X ent | X% |
| 🥉 | [dia] | X ent | X% |

**Horário de Pico:** XX:00 às XX:00
- Volume no pico: X entregas
- % das entregas concentradas no pico: X%

**3️⃣ DIMENSIONAMENTO PREDITIVO PARA O PICO**
- Entregas no horário de pico: X
- Meta por profissional: 10 entregas
- **👥 Profissionais necessários no pico: X motoboys**
- Cálculo: (Entregas no pico ÷ 10 = X profissionais)

**4️⃣ INSIGHTS ESTRATÉGICOS**
Conclusão sobre a saúde da operação:
- Status geral: 🟢 SAUDÁVEL | 🟡 ATENÇÃO | 🔴 CRÍTICO
- Principais pontos de atenção para o próximo período
- Recomendação de ação (1-2 frases)`,
      
      alertas: `## ⚠️ ALERTAS URGENTES
Liste APENAS problemas críticos:
🔴 CRÍTICO: [problema] → [ação]
🟡 ATENÇÃO: [problema] → [ação]
🟢 MONITORAR: [problema] → [ação]
Máximo 5 alertas.`,
      
      gestao_profissionais: `## 👥 GESTÃO DE PROFISSIONAIS

**1️⃣ EQUILÍBRIO DE CARGA (Meta: 10 entregas/profissional/DIA)**
Use os dados de "MÉTRICAS DE DIMENSIONAMENTO" para calcular:
- Média de entregas por dia: [valor do contexto]
- Profissionais ideais por dia: (Média entregas/dia ÷ 10)
- Status da operação:
  - ✅ ADEQUADO: se profissionais atuais ≈ profissionais ideais
  - ⚠️ SUBDIMENSIONADO: se precisam de MAIS motoboys (poucos profissionais para muita demanda)
  - 🔴 SUPERDIMENSIONADO: se há motoboys DEMAIS para a demanda

**Apresente:**
| Métrica | Valor |
|---------|-------|
| Entregas/dia (média) | X |
| Profissionais ideais/dia | X (cálculo: entregas÷10) |
| Status | ✅/⚠️/🔴 |
| Recomendação | [ação se necessário] |

**2️⃣ ANÁLISE DE ROTATIVIDADE (CHURN)**
- Total de profissionais distintos que trabalharam no período: X
- Profissionais necessários por dia: X
- Proporção: (distintos ÷ necessários/dia)
- Status:
  - ✅ NORMAL: proporção < 2x
  - ⚠️ ALTA ROTATIVIDADE: proporção entre 2x e 4x
  - 🔴 ROTATIVIDADE CRÍTICA: proporção > 4x
- Se alta rotatividade: explicar impacto e recomendar ação

**3️⃣ DISPARIDADE DE CARGA/REMUNERAÇÃO**
Identificar OUTLIERS (profissionais com volume muito diferente da média):
| Profissional | Entregas | Desvio da Média | Status |
Sinalize com ⚠️ quem está >50% acima ou abaixo da média do grupo.

**4️⃣ RANKING DE PERFORMANCE (por % de entregas no prazo)**
🏆 **TOP 3 - Melhores Taxas de Prazo:**
🥇 [nome] - [X]% no prazo - [X] entregas
🥈 [nome] - [X]% no prazo - [X] entregas
🥉 [nome] - [X]% no prazo - [X] entregas

⚠️ **DETRATORES - Piores Taxas de Prazo:**
1. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]
2. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]
3. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]

**Se TODOS estiverem com baixa performance (<85% no prazo), emita:**
🔴 **ALERTA: BAIXA PERFORMANCE GERAL DA EQUIPE**
- Taxa média de prazo: X%
- Meta: 85%
- Ação recomendada: [sugestão]`,
      
      personalizado: prompt_custom ? `## ✨ ANÁLISE PERSONALIZADA\n${prompt_custom}` : null
    };
    
    // Combinar prompts dos tipos selecionados
    const promptsCombinados = tipos
      .map(t => promptsBase[t])
      .filter(p => p !== null)
      .join('\n\n');
    
    const tiposLabel = tipos.map(t => {
      const labels = {performance: 'Performance', tendencias: 'Tendências', alertas: 'Alertas', gestao_profissionais: 'Gestão de Profissionais', personalizado: 'Personalizado'};
      return labels[t] || t;
    }).join(', ');
    
    const promptCompleto = `Você é um analista de operações de delivery. Seja DIRETO e VISUAL. Use emojis, tabelas e formatação para facilitar a leitura. Evite textos longos.

📊 **DADOS DA OPERAÇÃO** (${contexto.periodo.inicio} a ${contexto.periodo.fim})

📦 **RESUMO GERAL**
| Métrica | Valor |
|---------|-------|
| Total Entregas | ${contexto.metricas_gerais.total_entregas.toLocaleString()} |
| ✅ No Prazo | ${contexto.metricas_gerais.entregas_no_prazo.toLocaleString()} (${contexto.metricas_gerais.taxa_prazo}%) |
| ❌ Fora Prazo | ${contexto.metricas_gerais.entregas_fora_prazo.toLocaleString()} |
| 🔄 Retornos | ${contexto.metricas_gerais.total_retornos.toLocaleString()} |
| ⏱️ Tempo Médio | ${contexto.metricas_gerais.tempo_medio_entrega} min |
| 🚗 KM Médio | ${contexto.metricas_gerais.km_medio} km |
| 👥 Profissionais | ${contexto.metricas_gerais.total_profissionais} |
| 🏢 Clientes | ${contexto.metricas_gerais.total_clientes} |

📊 **MÉTRICAS DE DIMENSIONAMENTO**
| Métrica | Valor |
|---------|-------|
| Total de dias no período | ${contexto.metricas_gerais.total_dias_periodo} dias |
| Média de entregas/dia | ${contexto.metricas_gerais.media_entregas_por_dia} ent/dia |
| Meta por profissional | 10 ent/dia |
| **👥 Profissionais ideais/dia** | ${contexto.metricas_gerais.profissionais_ideais_por_dia} motoboys |
| Profissionais distintos no período | ${contexto.metricas_gerais.total_profissionais} |

💵 **FINANCEIRO**
| Métrica | Valor |
|---------|-------|
| Faturamento | R$ ${contexto.metricas_gerais.valor_total.toLocaleString('pt-BR')} |
| Custo Profissionais | R$ ${contexto.metricas_gerais.valor_profissionais.toLocaleString('pt-BR')} |
| Lucro Bruto | R$ ${contexto.metricas_gerais.lucro_bruto.toLocaleString('pt-BR')} |
| Margem | ${contexto.metricas_gerais.margem_percentual}% |
| Ticket Médio | R$ ${contexto.metricas_gerais.ticket_medio} |
| Média/Profissional | ${contexto.metricas_gerais.media_entregas_por_profissional} entregas |

📈 **TENDÊNCIA:** ${contexto.tendencia.direcao} (${contexto.tendencia.variacao_taxa > 0 ? '+' : ''}${contexto.tendencia.variacao_taxa}%)

📅 **EVOLUÇÃO DIÁRIA (últimos ${contexto.evolucao_diaria.length} dias)**
${contexto.evolucao_diaria.map(d => `${d.data}: ${d.entregas} ent | ${d.taxa_prazo}% ✓ | R$${d.valor.toLocaleString('pt-BR')}`).join('\n')}

🏢 **TOP CLIENTES**
${contexto.top_clientes.map((c, i) => `${i+1}. ${c.cliente}: ${c.entregas} ent | ${c.taxa_prazo}% | R$${c.valor.toLocaleString('pt-BR')} | ${c.tempo_medio}min | ${c.retornos} ret`).join('\n')}

👤 **TOP PROFISSIONAIS**
${contexto.top_profissionais.map((p, i) => `${i+1}. ${p.profissional}: ${p.entregas} ent | ${p.taxa_prazo}% | ${p.tempo_medio}min | ${p.km_total.toLocaleString()}km | R$${p.valor_recebido.toLocaleString('pt-BR')}`).join('\n')}

⚠️ **PROFISSIONAIS COM BAIXA PERFORMANCE** (mín 10 entregas)
${contexto.piores_profissionais.map((p, i) => `${i+1}. ${p.profissional}: ${p.taxa_prazo}% prazo | ${p.tempo_medio}min | ${p.entregas} ent`).join('\n')}

📆 **POR DIA DA SEMANA**
${contexto.distribuicao_dia_semana.map(d => `${d.dia}: ${d.entregas} ent | ${d.taxa_prazo}% | ${d.tempo_medio}min`).join('\n')}

⏰ **DISTRIBUIÇÃO POR HORÁRIO**
${contexto.distribuicao_hora.filter(h => h.entregas > 0).map(h => `${h.hora}h: ${h.entregas} ent | ${h.taxa_prazo}%`).join('\n')}

🔥 **HORÁRIO DE PICO (hora com maior volume)**
${contexto.horario_pico ? `- Hora: ${contexto.horario_pico.hora}h
- Total no período: ${contexto.horario_pico.entregas_total_periodo} entregas
- **Média por dia: ${contexto.horario_pico.entregas_media_dia} entregas/dia**
- % do total: ${contexto.horario_pico.percentual}%
- **👥 Profissionais necessários: ${contexto.horario_pico.profissionais_necessarios} motoboys**
- Cálculo: ${contexto.horario_pico.entregas_media_dia} entregas/dia ÷ 10 = ${contexto.horario_pico.profissionais_necessarios} profissionais` : '- Sem dados de horário disponíveis'}

🔥 **JANELA DE PICO (3 horas consecutivas com maior volume)**
${contexto.janela_pico ? `- Janela: ${contexto.janela_pico.inicio}h às ${contexto.janela_pico.fim + 1}h
- Total no período: ${contexto.janela_pico.entregas_total_periodo} entregas
- **Média por dia: ${contexto.janela_pico.entregas_media_dia} entregas/dia**
- % do total: ${contexto.janela_pico.percentual}%
- **👥 Profissionais necessários: ${contexto.janela_pico.profissionais_necessarios} motoboys**
- Cálculo: ${contexto.janela_pico.entregas_media_dia} entregas/dia ÷ 10 = ${contexto.janela_pico.profissionais_necessarios} profissionais` : '- Sem dados disponíveis'}

---
🎯 **SUAS TAREFAS:**
${promptsCombinados}

---
📝 **REGRAS DE FORMATAÇÃO:**
- Seja DIRETO, sem enrolação
- Use emojis para facilitar leitura
- Use tabelas quando possível
- Bullets curtos, máximo 1 linha
- Destaque números importantes em **negrito**
- Para rankings use 🥇🥈🥉
- Para status use ✅❌⚠️🔴🟡🟢
- Evite explicações longas, vá direto ao ponto
${tipos.length > 1 ? '- Faça TODAS as análises solicitadas, separadas por seção' : ''}`;

    console.log('🤖 Chamando API Gemini...');
    
    // Chamar API do Gemini - aumentar tokens para múltiplas análises
    const maxTokens = tipos.length > 1 ? 4096 : 2048;
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptCompleto }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: maxTokens
        }
      })
    });
    
    const geminiData = await geminiResponse.json();
    
    if (geminiData.error) {
      console.error('❌ Erro Gemini:', geminiData.error);
      return res.status(500).json({ error: 'Erro na API Gemini: ' + geminiData.error.message });
    }
    
    const relatorio = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'Não foi possível gerar o relatório.';
    
    console.log('✅ Relatório IA gerado com sucesso');
    
    res.json({
      success: true,
      tipo_analise: tiposLabel,
      tipos_selecionados: tipos,
      periodo: contexto.periodo,
      metricas: contexto.metricas_gerais,
      relatorio
    });
    
  } catch (err) {
    console.error('❌ Erro ao gerar relatório IA:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório: ' + err.message });
  }
});

// Atualizar data_hora_alocado em massa (para registros existentes)
app.post('/api/bi/entregas/atualizar-alocado', async (req, res) => {
  try {
    const { entregas } = req.body;
    
    if (!entregas || !Array.isArray(entregas)) {
      return res.status(400).json({ error: 'Array de entregas é obrigatório' });
    }
    
    console.log(`📊 Atualizando data_hora_alocado para ${entregas.length} registros...`);
    
    // Função para parsear timestamp
    const parseTimestamp = (val) => {
      if (!val) return null;
      try {
        // Tenta diferentes formatos
        if (typeof val === 'string') {
          // Formato DD/MM/YYYY HH:MM:SS
          const match = val.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):?(\d{2})?/);
          if (match) {
            return new Date(match[3], match[2] - 1, match[1], match[4], match[5], match[6] || 0);
          }
          // Formato ISO
          const d = new Date(val);
          if (!isNaN(d.getTime())) return d;
        }
        // Excel serial number
        if (typeof val === 'number') {
          const excelDate = new Date((val - 25569) * 86400 * 1000);
          if (!isNaN(excelDate.getTime())) return excelDate;
        }
        return null;
      } catch {
        return null;
      }
    };
    
    let atualizados = 0;
    let erros = 0;
    
    for (const e of entregas) {
      const os = parseInt(e.os);
      const ponto = parseInt(e.ponto) || 1;
      const dataHoraAlocado = parseTimestamp(e.data_hora_alocado || e['Data/Hora Alocado']);
      
      if (!os || !dataHoraAlocado) {
        erros++;
        continue;
      }
      
      try {
        const result = await pool.query(`
          UPDATE bi_entregas 
          SET data_hora_alocado = $1 
          WHERE os = $2 AND COALESCE(ponto, 1) = $3 AND data_hora_alocado IS NULL
        `, [dataHoraAlocado, os, ponto]);
        
        if (result.rowCount > 0) atualizados++;
      } catch (err) {
        erros++;
      }
    }
    
    console.log(`✅ Atualização concluída: ${atualizados} atualizados, ${erros} erros`);
    res.json({ success: true, atualizados, erros });
  } catch (err) {
    console.error('❌ Erro ao atualizar data_hora_alocado:', err);
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

// Dashboard BI - Métricas gerais COMPLETO
app.get('/api/bi/dashboard', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, status_retorno, cidade } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      where += ` AND data_solicitado >= $${paramIndex++}`;
      params.push(data_inicio);
    }
    if (data_fim) {
      where += ` AND data_solicitado <= $${paramIndex++}`;
      params.push(data_fim);
    }
    if (cod_cliente) {
      where += ` AND cod_cliente = $${paramIndex++}`;
      params.push(cod_cliente);
    }
    if (centro_custo) {
      where += ` AND centro_custo = $${paramIndex++}`;
      params.push(centro_custo);
    }
    if (cod_prof) {
      where += ` AND cod_prof = $${paramIndex++}`;
      params.push(cod_prof);
    }
    if (categoria) {
      where += ` AND categoria ILIKE $${paramIndex++}`;
      params.push(`%${categoria}%`);
    }
    if (status_prazo === 'dentro') {
      where += ` AND dentro_prazo = true`;
    } else if (status_prazo === 'fora') {
      where += ` AND dentro_prazo = false`;
    }
    // Filtro de prazo profissional
    const status_prazo_prof = req.query.status_prazo_prof;
    if (status_prazo_prof === 'dentro') {
      where += ` AND dentro_prazo_prof = true`;
    } else if (status_prazo_prof === 'fora') {
      where += ` AND dentro_prazo_prof = false`;
    }
    if (cidade) {
      where += ` AND cidade = $${paramIndex++}`;
      params.push(cidade);
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Métricas gerais completas
    const metricas = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo IS NULL) as sem_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = true) as dentro_prazo_prof,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = false) as fora_prazo_prof,
        COUNT(*) FILTER (WHERE dentro_prazo_prof IS NULL) as sem_prazo_prof,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo_prof = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo_prof IS NOT NULL), 0), 2) as taxa_dentro_prof,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo_prof = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo_prof IS NOT NULL), 0), 2) as taxa_fora_prof,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
        ROUND(AVG(tempo_execucao_prof_minutos)::numeric, 2) as tempo_medio_prof,
        ROUND(AVG(distancia)::numeric, 2) as distancia_media,
        ROUND(SUM(distancia)::numeric, 2) as distancia_total,
        ROUND(SUM(valor)::numeric, 2) as valor_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_profissional,
        ROUND(SUM(valor)::numeric - COALESCE(SUM(valor_prof)::numeric, 0), 2) as faturamento,
        ROUND(AVG(valor)::numeric, 2) as ticket_medio,
        COUNT(DISTINCT cod_prof) as total_entregadores,
        COUNT(DISTINCT cod_cliente) as total_clientes,
        ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 2) as media_entregas_entregador,
        COUNT(*) FILTER (WHERE ocorrencia = 'Retorno') as retornos
      FROM bi_entregas ${where}
    `, params);
    
    // Entregas por dia
    const porDia = await pool.query(`
      SELECT 
        data_solicitado as data,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo
      FROM bi_entregas ${where}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // Por centro de custo
    const porCentro = await pool.query(`
      SELECT 
        centro_custo,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo
      FROM bi_entregas ${where}
      GROUP BY centro_custo
      ORDER BY total DESC
      LIMIT 20
    `, params);
    
    // Ranking profissionais
    const ranking = await pool.query(`
      SELECT 
        cod_prof,
        nome_prof,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio
      FROM bi_entregas ${where}
      GROUP BY cod_prof, nome_prof
      ORDER BY total DESC
      LIMIT 20
    `, params);
    
    // Por categoria
    const porCategoria = await pool.query(`
      SELECT 
        categoria,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo
      FROM bi_entregas ${where}
      GROUP BY categoria
      ORDER BY total DESC
    `, params);
    
    res.json({
      metricas: metricas.rows[0],
      porDia: porDia.rows,
      porCentro: porCentro.rows,
      ranking: ranking.rows,
      porCategoria: porCategoria.rows
    });
  } catch (err) {
    console.error('❌ Erro no dashboard:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// Dashboard BI COMPLETO - Retorna todas as métricas de uma vez
// Dashboard BI COMPLETO - Retorna todas as métricas de uma vez
app.get('/api/bi/dashboard-completo', async (req, res) => {
  try {
    let { data_inicio, data_fim, cod_prof, categoria, status_prazo, status_prazo_prof, status_retorno, cidade, clientes_sem_filtro_cc } = req.query;
    // Suporte a múltiplos clientes e centros de custo
    let cod_cliente = req.query.cod_cliente;
    let centro_custo = req.query.centro_custo;
    
    // Converter para array se necessário
    if (cod_cliente && !Array.isArray(cod_cliente)) cod_cliente = [cod_cliente];
    if (centro_custo && !Array.isArray(centro_custo)) centro_custo = [centro_custo];
    
    // Clientes que não devem ter filtro de centro de custo (mostrar todos CC)
    let clientesSemFiltroCC = [];
    if (clientes_sem_filtro_cc) {
      clientesSemFiltroCC = clientes_sem_filtro_cc.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }
    
    console.log('📊 Dashboard-completo:', { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, status_retorno, clientesSemFiltroCC });
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // Converter datas ISO para YYYY-MM-DD
    if (data_inicio) { 
      const dataIni = data_inicio.includes('T') ? data_inicio.split('T')[0] : data_inicio;
      where += ` AND data_solicitado >= $${paramIndex++}`; 
      params.push(dataIni); 
    }
    if (data_fim) { 
      const dataFim = data_fim.includes('T') ? data_fim.split('T')[0] : data_fim;
      where += ` AND data_solicitado <= $${paramIndex++}`; 
      params.push(dataFim); 
    }
    // Múltiplos clientes
    if (cod_cliente && cod_cliente.length > 0) { 
      where += ` AND cod_cliente = ANY($${paramIndex++}::int[])`; 
      params.push(cod_cliente.map(c => parseInt(c))); 
    }
    // Múltiplos centros de custo - COM exceção para clientes sem filtro
    if (centro_custo && centro_custo.length > 0) {
      if (clientesSemFiltroCC.length > 0) {
        // Filtrar por CC OU ser um cliente sem filtro de CC
        where += ` AND (centro_custo = ANY($${paramIndex++}::text[]) OR cod_cliente = ANY($${paramIndex++}::int[]))`;
        params.push(centro_custo);
        params.push(clientesSemFiltroCC);
      } else {
        where += ` AND centro_custo = ANY($${paramIndex++}::text[])`; 
        params.push(centro_custo); 
      }
    }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    // Filtro de prazo profissional
    if (status_prazo_prof === 'dentro') { where += ` AND dentro_prazo_prof = true`; }
    else if (status_prazo_prof === 'fora') { where += ` AND dentro_prazo_prof = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    console.log('📊 WHERE:', where, 'Params:', params);
    
    // Buscar regras de contagem
    const regrasContagem = await pool.query('SELECT cod_cliente FROM bi_regras_contagem');
    const clientesComRegra = new Set(regrasContagem.rows.map(r => String(r.cod_cliente)));
    console.log('📊 Clientes COM regra de contagem:', [...clientesComRegra]);
    console.log('📊 Total de clientes com regra:', clientesComRegra.size);
    
    // Buscar máscaras
    const mascaras = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mapMascaras = {};
    mascaras.rows.forEach(m => { mapMascaras[String(m.cod_cliente)] = m.mascara; });
    
    // ============================================
    // BUSCAR CONFIGURAÇÕES DE PRAZO PROFISSIONAL
    // ============================================
    let prazosProfCliente = [];
    let prazoProfPadrao = [];
    try {
      const prazosProfQuery = await pool.query(`
        SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
        FROM bi_prazos_prof_cliente pc
        JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      `);
      prazosProfCliente = prazosProfQuery.rows;
      
      const prazoProfPadraoQuery = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
      prazoProfPadrao = prazoProfPadraoQuery.rows;
      
      console.log('📊 Prazos Prof carregados:', { 
        especificos: prazosProfCliente.length, 
        padrao: prazoProfPadrao.length,
        faixasPadrao: prazoProfPadrao.map(f => `${f.km_min}-${f.km_max || '∞'}km=${f.prazo_minutos}min`).join(', ')
      });
    } catch (err) {
      console.log('⚠️ Tabelas de prazo profissional não encontradas, usando fallback hardcoded');
    }
    
    // Função para encontrar prazo profissional baseado no cliente/centro e distância
    const encontrarPrazoProfissional = (codCliente, centroCusto, distancia) => {
      // 1. Primeiro busca configuração específica por cliente
      let faixas = prazosProfCliente.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      
      // 2. Se não achou, busca por centro de custo
      if (faixas.length === 0 && centroCusto) {
        faixas = prazosProfCliente.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // 3. Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
        // Se não encontrou faixa adequada nas específicas, continua para o padrão
      }
      
      // 4. Usa prazo padrão profissional do banco
      if (prazoProfPadrao.length > 0) {
        for (const faixa of prazoProfPadrao) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // 5. Fallback hardcoded (se nada configurado no banco)
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 135;
      if (distancia <= 35) return 150;
      if (distancia <= 40) return 165;
      if (distancia <= 45) return 180;
      if (distancia <= 50) return 195;
      if (distancia <= 55) return 210;
      if (distancia <= 60) return 225;
      if (distancia <= 65) return 240;
      if (distancia <= 70) return 255;
      if (distancia <= 75) return 270;
      if (distancia <= 80) return 285;
      return 300;
    };
    
    // ============================================
    // BUSCAR TODOS OS CLIENTES EXISTENTES NO SISTEMA
    // ============================================
    const todosClientesQuery = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_cliente 
      FROM bi_entregas 
      WHERE cod_cliente IS NOT NULL
      ORDER BY cod_cliente
    `);
    const todosClientes = todosClientesQuery.rows;
    console.log('📊 Total de clientes no sistema:', todosClientes.length);
    
    // ============================================
    // QUERY SQL PARA TEMPOS MÉDIOS 
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposQuery = await pool.query(`
      SELECT 
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
    `, params);
    
    const temposSQL = temposQuery.rows[0] || {};
    console.log('📊 Tempos calculados via SQL:', temposSQL);
    
    // Buscar todos os dados filtrados
    const dadosQuery = await pool.query(`
      SELECT os, COALESCE(ponto, 1) as ponto, cod_cliente, nome_cliente, 
        cod_prof, nome_prof, dentro_prazo, tempo_execucao_minutos,
        tempo_entrega_prof_minutos, dentro_prazo_prof,
        valor, valor_prof, distancia, ocorrencia, centro_custo, motivo, finalizado,
        data_hora, data_hora_alocado, data_chegada, hora_chegada
      FROM bi_entregas ${where}
    `, params);
    
    const dados = dadosQuery.rows;
    console.log('📊 Total registros retornados:', dados.length);
    
    // Debug: contar quantos têm data_hora_alocado
    const comAlocado = dados.filter(d => d.data_hora_alocado).length;
    const ponto1 = dados.filter(d => parseInt(d.ponto) === 1).length;
    const comAlocadoPonto1 = dados.filter(d => d.data_hora_alocado && parseInt(d.ponto) === 1).length;
    console.log('📊 Debug Alocação: comAlocado=' + comAlocado + ', ponto1=' + ponto1 + ', comAlocadoPonto1=' + comAlocadoPonto1);
    
    // ============================================
    // FUNÇÃO: Calcular tempo de alocação seguindo regra do BI (DAX)
    // Regra: Se solicitado após 17h E alocação no dia seguinte,
    //        início da contagem = 08:00 do dia da alocação
    // ============================================
    const calcularTempoAlocacao = (dataHora, dataHoraAlocado, ponto) => {
      // Ignora: Ponto != 1 OU dados inválidos
      if (!dataHora || !dataHoraAlocado) return null;
      const pontoNum = parseInt(ponto) || 1; // COALESCE(ponto, 1)
      if (pontoNum !== 1) return null;
      
      const solicitado = new Date(dataHora);
      const alocado = new Date(dataHoraAlocado);
      
      // Ignora se alocado < solicitado (dados invertidos)
      if (alocado < solicitado) return null;
      
      // Hora da solicitação
      const horaSolicitado = solicitado.getHours();
      
      // Verifica se foi solicitado após 17h
      const depoisDas17 = horaSolicitado >= 17;
      
      // Verifica se a alocação foi no dia seguinte
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem;
      
      if (depoisDas17 && !mesmaData) {
        // Se solicitado após 17h E alocação no dia seguinte,
        // início = 08:00 do dia da alocação
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      } else {
        // Caso contrário, início = data/hora solicitado
        inicioContagem = solicitado;
      }
      
      // Calcula diferença em minutos
      const difMs = alocado - inicioContagem;
      const difMinutos = difMs / (1000 * 60);
      
      // Retorna null se negativo ou inválido
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    
    // ============================================
    // FUNÇÃO: Calcular tempo de entrega (Ponto <> 1: Solicitado -> Chegada)
    // Usa data_chegada + hora_chegada (como o Power BI), com fallback para finalizado
    // Regra: Se não é mesma data, início = 08:00 do dia da chegada
    // ============================================
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null; // Apenas pontos de entrega (<> 1)
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      // DEBUG: Log primeiro registro para ver estrutura dos dados
      if (!calcularTempoEntrega.logged) {
        console.log('📊 DEBUG calcularTempoEntrega - Exemplo de row:', {
          ponto: row.ponto,
          data_hora: row.data_hora,
          data_chegada: row.data_chegada,
          hora_chegada: row.hora_chegada,
          finalizado: row.finalizado,
          tipo_data_chegada: typeof row.data_chegada,
          tipo_hora_chegada: typeof row.hora_chegada
        });
        calcularTempoEntrega.logged = true;
      }
      
      // Verificar se temos data_chegada + hora_chegada válidos
      if (row.data_chegada && row.hora_chegada) {
        try {
          // data_chegada pode ser Date ou string
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {
          console.log('📊 DEBUG calcularTempoEntrega - Erro:', e.message);
        }
      }
      
      // Fallback: usar finalizado se válido E >= solicitado
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      // Verifica se é mesma data
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        // Se não é mesma data, início = 08:00 do dia da chegada
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    calcularTempoEntrega.logged = false;
    
    // ============================================
    // FUNÇÃO: Calcular tempo de coleta (Ponto = 1: Alocado -> Saída)
    // Conforme DAX_MedColetaSegundos: usa Alocado como início
    // Regra: Se depois das 17h E não mesma data, início = 08:00 do dia da saída
    // ============================================
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null; // Apenas ponto 1 (coleta)
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      // Verificar se temos data_chegada + hora_chegada válidos
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {
          // Ignorar erro de parsing
        }
      }
      
      // Fallback: usar finalizado se válido E >= alocado
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      // Verifica hora da alocação (se depois das 17h)
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        // Se alocado após 17h E saída no dia seguinte, início = 08:00 do dia da saída
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    
    // ============================================
    // FUNÇÃO: Calcular T. Entrega Prof (Alocado -> Finalizado da OS)
    // Este é o tempo que o profissional leva desde que é alocado até finalizar
    // Regra: Se dias diferentes, início = 08:00 do dia do finalizado
    // NOTA: Os dados vêm em horário de Brasília, tratamos como strings para evitar problemas de timezone
    // ============================================
    const calcularTempoEntregaProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      
      // Extrair data e hora como strings para evitar problemas de timezone
      // Aceita formatos: "2025-12-01T18:12:19" ou "2025-12-01 18:12:19"
      const parseDateTime = (str) => {
        if (!str) return null;
        const s = String(str);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      const alocado = parseDateTime(dataHoraAlocado);
      const fim = parseDateTime(finalizado);
      
      if (!alocado || !fim) return null;
      
      const mesmaData = alocado.dataStr === fim.dataStr;
      
      let inicioMinutos, fimMinutos;
      
      // Fim sempre é a hora real do fim
      fimMinutos = fim.hora * 60 + fim.min + fim.seg / 60;
      
      if (!mesmaData) {
        // Dias diferentes - começa às 8h do dia do fim
        inicioMinutos = 8 * 60; // 8:00 = 480 minutos
      } else {
        inicioMinutos = alocado.hora * 60 + alocado.min + alocado.seg / 60;
      }
      
      const difMinutos = fimMinutos - inicioMinutos;
      
      // Se negativo, algo está errado
      if (difMinutos < 0) return null;
      
      return difMinutos;
    };
    
    // LÓGICA DE CONTAGEM:
    // Cliente SEM regra: 1 OS = 1 entrega (conta OS únicas)
    // Cliente COM regra: conta pontos > 1 (cada ponto de entrega conta, exclui coleta)
    
    // Agrupar por cliente/OS
    const osPorCliente = {};
    dados.forEach(row => {
      const codStr = String(row.cod_cliente);
      const os = row.os;
      if (!osPorCliente[codStr]) osPorCliente[codStr] = {};
      if (!osPorCliente[codStr][os]) osPorCliente[codStr][os] = [];
      osPorCliente[codStr][os].push(row);
    });
    
    // Log de debug por cliente
    Object.keys(osPorCliente).forEach(codCliente => {
      const totalOS = Object.keys(osPorCliente[codCliente]).length;
      const temRegra = clientesComRegra.has(codCliente);
      console.log(`📊 Cliente ${codCliente}: ${totalOS} OS distintas, tem regra: ${temRegra}`);
    });
    
    // Função para calcular entregas de uma OS
    // REGRA UNIVERSAL: conta apenas pontos >= 2 (ponto 1 é coleta, não conta)
    const calcularEntregasOS = (linhasOS) => {
      const entregasCount = linhasOS.filter(l => {
        const pontoNum = parseInt(l.ponto) || 1;
        return pontoNum >= 2;
      }).length;
      
      // Se não encontrou pontos >= 2, usa fallback: linhas - 1
      if (entregasCount === 0 && linhasOS.length > 1) {
        return linhasOS.length - 1;
      }
      
      // Mínimo 1 entrega se só tem 1 linha
      return entregasCount > 0 ? entregasCount : 1;
    };
    
    // Calcular métricas gerais - usando a lógica por OS
    let totalOS = new Set();
    let totalEntregas = 0, dentroPrazo = 0, foraPrazo = 0, semPrazo = 0;
    let dentroPrazoProf = 0, foraPrazoProf = 0; // Prazo Prof (baseado em Alocado -> Finalizado)
    let somaValor = 0, somaValorProf = 0;
    let somaTempoEntrega = 0, countTempoEntrega = 0; // Tempo de entrega (Ponto >= 2)
    let somaTempoAlocacao = 0, countTempoAlocacao = 0; // Tempo de alocação (Ponto = 1)
    let somaTempoColeta = 0, countTempoColeta = 0; // Tempo de coleta (Ponto = 1)
    let somaTempoEntregaProf = 0, countTempoEntregaProf = 0; // T. Entrega Prof (Alocado -> Finalizado)
    let profissionais = new Set();
    let totalRetornos = 0;
    let ultimaEntrega = null;
    
    // Função para verificar se é retorno baseado na Ocorrência
    const isRetorno = (ocorrencia) => {
      if (!ocorrencia) return false;
      const oc = ocorrencia.toLowerCase().trim();
      return oc.includes('cliente fechado') || 
             oc.includes('clienteaus') ||
             oc.includes('cliente ausente') ||
             oc.includes('loja fechada') ||
             oc.includes('produto incorreto');
    };
    
    // Processar por cliente/OS
    Object.keys(osPorCliente).forEach(codCliente => {
      const osDoCliente = osPorCliente[codCliente];
      
      Object.keys(osDoCliente).forEach(os => {
        const linhasOS = osDoCliente[os];
        totalOS.add(os);
        
        // Contar entregas desta OS (pontos >= 2)
        const entregasOS = calcularEntregasOS(linhasOS);
        totalEntregas += entregasOS;
        
        // Contagem de profissionais e RETORNOS (em todas as linhas)
        linhasOS.forEach((row) => {
          profissionais.add(row.cod_prof);
          
          // RETORNO = ocorrência indica problema (conta em TODAS as linhas)
          if (isRetorno(row.ocorrencia)) {
            totalRetornos++;
          }
          
          // Última entrega
          if (row.finalizado) {
            const dataFin = new Date(row.finalizado);
            if (!ultimaEntrega || dataFin > ultimaEntrega) {
              ultimaEntrega = dataFin;
            }
          }
          
          // Calcular tempo de alocação (apenas para Ponto 1)
          const tempoAloc = calcularTempoAlocacao(row.data_hora, row.data_hora_alocado, row.ponto);
          if (tempoAloc !== null) {
            somaTempoAlocacao += tempoAloc;
            countTempoAlocacao++;
          }
          
          // Calcular tempo de entrega (apenas para Ponto <> 1)
          const tempoEnt = calcularTempoEntrega(row);
          if (tempoEnt !== null) {
            somaTempoEntrega += tempoEnt;
            countTempoEntrega++;
          }
          
          // Calcular tempo de coleta (apenas para Ponto = 1)
          const tempoCol = calcularTempoColeta(row);
          if (tempoCol !== null) {
            somaTempoColeta += tempoCol;
            countTempoColeta++;
          }
        });
        
        // REGRA UNIVERSAL: métricas apenas das linhas com ponto >= 2 (entregas)
        const linhasEntrega = linhasOS.filter(l => parseInt(l.ponto) >= 2);
        
        // Para prazo: processa todas as linhas de entrega
        const processarPrazo = (l) => {
          if (l.dentro_prazo === true) dentroPrazo++;
          else if (l.dentro_prazo === false) foraPrazo++;
          else semPrazo++; // null ou undefined
        };
        
        // ===== CALCULAR T. ENTREGA PROF E PRAZO PROF POR ENTREGA =====
        // Para cada linha de entrega (ponto >= 2), calcular o tempo prof
        // T. Entrega Prof = data_hora_alocado (ponto 1) → finalizado (desta entrega)
        // Com regra: se dias diferentes, começa às 8h do dia do finalizado
        const primeiroReg = linhasOS[0]; // Ponto 1 - tem o data_hora_alocado
        
        // Função para extrair data/hora (aceita string ou objeto Date)
        const parseDateTime = (valor) => {
          if (!valor) return null;
          
          // Se for objeto Date
          if (valor instanceof Date) {
            return {
              dataStr: valor.toISOString().split('T')[0],
              hora: valor.getHours(),
              min: valor.getMinutes(),
              seg: valor.getSeconds()
            };
          }
          
          // Se for string
          const s = String(valor);
          const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
          if (!match) return null;
          return {
            dataStr: match[1] + '-' + match[2] + '-' + match[3],
            hora: parseInt(match[4]),
            min: parseInt(match[5]),
            seg: parseInt(match[6])
          };
        };
        
        const alocadoStr = primeiroReg?.data_hora_alocado;
        const alocado = parseDateTime(alocadoStr);
        
        // Determinar quais linhas processar para Prazo Prof
        // Se tem linhas com ponto >= 2, usa elas. Senão, usa todas exceto a primeira (coleta)
        const linhasParaPrazoProf = linhasEntrega.length > 0 
          ? linhasEntrega 
          : (linhasOS.length > 1 ? linhasOS.slice(1) : linhasOS);
        
        // Processar CADA ENTREGA para o Prazo Prof
        linhasParaPrazoProf.forEach((entrega) => {
          const finalizadoStr = entrega.finalizado;
          const finalizado = parseDateTime(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            
            let inicioMinutos, fimMinutos;
            
            // Fim sempre é a hora real do finalizado
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            
            if (!mesmaData) {
              // Dias diferentes - começa às 8h do dia do finalizado
              inicioMinutos = 8 * 60; // 8:00 = 480 minutos
            } else {
              inicioMinutos = alocado.hora * 60 + alocado.min + alocado.seg / 60;
            }
            
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              somaTempoEntregaProf += tempoEntProf;
              countTempoEntregaProf++;
              
              // Prazo Prof: calcular baseado no CLIENTE/CENTRO e DISTÂNCIA desta entrega
              const distanciaEntrega = parseFloat(entrega.distancia) || 0;
              const codClienteEntrega = entrega.cod_cliente;
              const centroCustoEntrega = entrega.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              
              // Log de debug (primeiras 5 entregas)
              if (countTempoEntregaProf <= 5) {
                console.log(`📊 DEBUG Prazo Prof - OS ${entrega.os}: dist=${distanciaEntrega.toFixed(1)}km, tempo=${tempoEntProf.toFixed(0)}min, prazo=${prazoMinutos}min, ${tempoEntProf <= prazoMinutos ? '✅ DENTRO' : '❌ FORA'}`);
              }
              
              if (tempoEntProf <= prazoMinutos) {
                dentroPrazoProf++;
              } else {
                foraPrazoProf++;
              }
            } else {
              // Tempo negativo = dados inconsistentes = fora do prazo
              foraPrazoProf++;
            }
          } else {
            // Sem dados de alocado ou finalizado = conta como fora do prazo
            foraPrazoProf++;
          }
        });
        // ===== FIM CALCULAR T. ENTREGA PROF =====
        
        // Para VALORES: soma apenas 1x por OS (pega a linha com maior ponto, que tem o valor da OS)
        const linhaValor = linhasOS.reduce((maior, atual) => {
          const pontoAtual = parseInt(atual.ponto) || 0;
          const pontoMaior = parseInt(maior?.ponto) || 0;
          return pontoAtual > pontoMaior ? atual : maior;
        }, linhasOS[0]);
        
        somaValor += parseFloat(linhaValor?.valor) || 0;
        somaValorProf += parseFloat(linhaValor?.valor_prof) || 0;
        
        if (linhasEntrega.length > 0) {
          linhasEntrega.forEach(processarPrazo);
        } else if (linhasOS.length > 1) {
          linhasOS.slice(1).forEach(processarPrazo);
        } else {
          processarPrazo(linhasOS[0]);
        }
      });
    });
    
    // Função para formatar tempo em HH:MM:SS (igual ao Acompanhamento)
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0 || isNaN(minutos)) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    // USAR TEMPOS DA QUERY SQL (igual ao Acompanhamento)
    // Frontend espera minutos como número, ele mesmo formata para HH:MM:SS
    // DEBUG: Log dos tempos para verificar
    console.log('📊 DEBUG Tempos SQL:', {
      tempo_medio_entrega: temposSQL.tempo_medio_entrega,
      tempo_medio_alocacao: temposSQL.tempo_medio_alocacao,
      tempo_medio_coleta: temposSQL.tempo_medio_coleta
    });
    
    // Se SQL não retornar tempos válidos, usar os cálculos JS como fallback
    const tempoMedioEntrega = parseFloat(temposSQL.tempo_medio_entrega) || 
      (countTempoEntrega > 0 ? somaTempoEntrega / countTempoEntrega : 0);
    const tempoMedioAlocacao = parseFloat(temposSQL.tempo_medio_alocacao) || 
      (countTempoAlocacao > 0 ? somaTempoAlocacao / countTempoAlocacao : 0);
    const tempoMedioColeta = parseFloat(temposSQL.tempo_medio_coleta) || 
      (countTempoColeta > 0 ? somaTempoColeta / countTempoColeta : 0);
    
    console.log('📊 DEBUG Tempos Finais (minutos):', {
      tempo_medio: tempoMedioEntrega,
      tempo_medio_alocacao: tempoMedioAlocacao,
      tempo_medio_coleta: tempoMedioColeta,
      countTempoEntrega,
      countTempoAlocacao,
      countTempoColeta
    });
    
    // Calcular tempo médio de entrega do profissional
    const tempoMedioEntregaProf = countTempoEntregaProf > 0 
      ? somaTempoEntregaProf / countTempoEntregaProf 
      : 0;
    
    console.log('📊 DEBUG T. Entrega Prof:', {
      tempo_medio_entrega_prof: tempoMedioEntregaProf,
      dentro_prazo_prof: dentroPrazoProf,
      fora_prazo_prof: foraPrazoProf,
      countTempoEntregaProf,
      totalEntregas,
      diferenca: totalEntregas - (dentroPrazoProf + foraPrazoProf)
    });
    
    const metricas = {
      total_os: totalOS.size,
      total_entregas: totalEntregas,
      dentro_prazo: dentroPrazo,
      fora_prazo: foraPrazo,
      sem_prazo: semPrazo,
      dentro_prazo_prof: dentroPrazoProf,
      fora_prazo_prof: foraPrazoProf,
      tempo_medio: tempoMedioEntrega,
      tempo_medio_alocacao: tempoMedioAlocacao,
      tempo_medio_coleta: tempoMedioColeta,
      tempo_medio_entrega_prof: tempoMedioEntregaProf,
      valor_total: somaValor.toFixed(2),
      valor_prof_total: somaValorProf.toFixed(2),
      ticket_medio: totalEntregas > 0 ? (somaValor / totalEntregas).toFixed(2) : 0,
      total_profissionais: profissionais.size,
      media_entregas_por_prof: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      total_retornos: totalRetornos,
      incentivo: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      ultima_entrega: ultimaEntrega ? ultimaEntrega.toISOString() : null
    };
    
    // ============================================
    // QUERY SQL PARA TEMPOS POR CLIENTE
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposPorClienteQuery = await pool.query(`
      SELECT 
        cod_cliente,
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
      GROUP BY cod_cliente
    `, params);
    
    // Criar mapa de tempos por cliente
    const temposPorClienteMap = {};
    temposPorClienteQuery.rows.forEach(row => {
      temposPorClienteMap[row.cod_cliente] = {
        tempo_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_coleta: parseFloat(row.tempo_medio_coleta) || 0
      };
    });
    
    // Agrupar por cliente - usando mesma lógica
    const porClienteMap = {};
    Object.keys(osPorCliente).forEach(codCliente => {
      const osDoCliente = osPorCliente[codCliente];
      
      if (!porClienteMap[codCliente]) {
        const primeiraLinha = Object.values(osDoCliente)[0][0];
        porClienteMap[codCliente] = {
          cod_cliente: primeiraLinha.cod_cliente,
          nome_cliente: primeiraLinha.nome_cliente,
          nome_display: mapMascaras[codCliente] || primeiraLinha.nome_cliente,
          tem_mascara: !!mapMascaras[codCliente],
          os_set: new Set(),
          profissionais_set: new Set(),
          centros_custo_map: {}, // Mapa de centros de custo com dados
          total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0,
          dentro_prazo_prof: 0, fora_prazo_prof: 0, // Novo: prazo profissional
          soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0, soma_dist: 0,
          soma_tempo_alocacao: 0, count_tempo_alocacao: 0, // Novo: tempo de alocação
          total_retornos: 0, ultima_entrega: null
        };
      }
      
      const c = porClienteMap[codCliente];
      
      // Função para verificar se é retorno baseado na Ocorrência
      const isRetornoCliente = (ocorrencia) => {
        if (!ocorrencia) return false;
        const oc = ocorrencia.toLowerCase().trim();
        return oc.includes('cliente fechado') || 
               oc.includes('clienteaus') ||
               oc.includes('cliente ausente') ||
               oc.includes('loja fechada') ||
               oc.includes('produto incorreto');
      };
      
      // Função para extrair data/hora (para cálculo do prazo prof)
      const parseDateTimeCliente = (valor) => {
        if (!valor) return null;
        if (valor instanceof Date) {
          return {
            dataStr: valor.toISOString().split('T')[0],
            hora: valor.getHours(),
            min: valor.getMinutes(),
            seg: valor.getSeconds()
          };
        }
        const s = String(valor);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      Object.keys(osDoCliente).forEach(os => {
        const linhasOS = osDoCliente[os];
        c.os_set.add(os);
        
        // Pegar data_hora_alocado do ponto 1 para cálculo do prazo prof
        const primeiroReg = linhasOS[0];
        const alocadoStr = primeiroReg?.data_hora_alocado;
        const alocado = parseDateTimeCliente(alocadoStr);
        
        // Coletar profissionais, última entrega e RETORNOS (em todas as linhas)
        linhasOS.forEach(l => {
          c.profissionais_set.add(l.cod_prof);
          
          // RETORNO = ocorrência indica problema (conta em TODAS as linhas)
          if (isRetornoCliente(l.ocorrencia)) {
            c.total_retornos++;
          }
          
          if (l.finalizado) {
            const dataFin = new Date(l.finalizado);
            if (!c.ultima_entrega || dataFin > c.ultima_entrega) {
              c.ultima_entrega = dataFin;
            }
          }
          
          // Calcular tempo de alocação por cliente (apenas para Ponto 1)
          const tempoAlocCliente = calcularTempoAlocacao(l.data_hora, l.data_hora_alocado, l.ponto);
          if (tempoAlocCliente !== null) {
            c.soma_tempo_alocacao += tempoAlocCliente;
            c.count_tempo_alocacao++;
          }
        });
        
        const entregasOS = calcularEntregasOS(linhasOS);
        c.total_entregas += entregasOS;
        
        // REGRA UNIVERSAL: métricas apenas das entregas (ponto >= 2)
        const linhasEntrega = linhasOS.filter(l => parseInt(l.ponto) >= 2);
        const linhasParaProcessar = linhasEntrega.length > 0 ? linhasEntrega : 
          (linhasOS.length > 1 ? linhasOS.slice(1) : linhasOS);
        
        // Para VALORES: soma apenas 1x por OS (pega a linha com maior ponto)
        const linhaValor = linhasOS.reduce((maior, atual) => {
          const pontoAtual = parseInt(atual.ponto) || 0;
          const pontoMaior = parseInt(maior?.ponto) || 0;
          return pontoAtual > pontoMaior ? atual : maior;
        }, linhasOS[0]);
        
        c.soma_valor += parseFloat(linhaValor?.valor) || 0;
        c.soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
        c.soma_dist += parseFloat(linhaValor?.distancia) || 0;
        
        // Centro de custo para valores - pega do linhaValor
        const ccValor = linhaValor?.centro_custo || 'Sem Centro';
        if (!c.centros_custo_map[ccValor]) {
          c.centros_custo_map[ccValor] = {
            centro_custo: ccValor,
            os_set: new Set(),
            total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
            dentro_prazo_prof: 0, fora_prazo_prof: 0, // Novo: prazo prof por centro
            soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0
          };
        }
        c.centros_custo_map[ccValor].soma_valor += parseFloat(linhaValor?.valor) || 0;
        c.centros_custo_map[ccValor].soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
        c.centros_custo_map[ccValor].os_set.add(os);
        
        linhasParaProcessar.forEach(l => {
          // Métricas do cliente total (prazo e tempo)
          if (l.dentro_prazo === true) c.dentro_prazo++;
          else if (l.dentro_prazo === false) c.fora_prazo++;
          else c.sem_prazo++;
          
          // ===== CALCULAR PRAZO PROF POR CLIENTE =====
          const finalizadoStr = l.finalizado;
          const finalizado = parseDateTimeCliente(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(l.distancia) || 0;
              const codClienteEntrega = l.cod_cliente;
              const centroCustoEntrega = l.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              if (tempoEntProf <= prazoMinutos) {
                c.dentro_prazo_prof++;
              } else {
                c.fora_prazo_prof++;
              }
            } else {
              c.fora_prazo_prof++;
            }
          } else {
            c.fora_prazo_prof++;
          }
          // ===== FIM PRAZO PROF =====
          
          // Usar cálculo manual de tempo de entrega (conforme DAX)
          const tempoEntCalc = calcularTempoEntrega(l);
          if (tempoEntCalc !== null) {
            c.soma_tempo += tempoEntCalc;
            c.count_tempo++;
          }
          
          // Agrupar por centro de custo (prazo e entregas)
          const cc = l.centro_custo || 'Sem Centro';
          if (!c.centros_custo_map[cc]) {
            c.centros_custo_map[cc] = {
              centro_custo: cc,
              os_set: new Set(),
              total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
              dentro_prazo_prof: 0, fora_prazo_prof: 0,
              soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0
            };
          }
          const ccData = c.centros_custo_map[cc];
          ccData.total_entregas++;
          if (l.dentro_prazo === true) ccData.dentro_prazo++;
          else if (l.dentro_prazo === false) ccData.fora_prazo++;
          else ccData.sem_prazo++;
          
          // Prazo prof por centro de custo
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(l.distancia) || 0;
              const codClienteEntrega = l.cod_cliente;
              const centroCustoEntrega = l.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              if (tempoEntProf <= prazoMinutos) {
                ccData.dentro_prazo_prof++;
              } else {
                ccData.fora_prazo_prof++;
              }
            } else {
              ccData.fora_prazo_prof++;
            }
          } else {
            ccData.fora_prazo_prof++;
          }
          
          if (tempoEntCalc !== null) {
            ccData.soma_tempo += tempoEntCalc;
            ccData.count_tempo++;
          }
        });
        
        // Contar retornos por centro de custo (em TODAS as linhas da OS)
        linhasOS.forEach(l => {
          const cc = l.centro_custo || 'Sem Centro';
          if (c.centros_custo_map[cc] && isRetornoCliente(l.ocorrencia)) {
            c.centros_custo_map[cc].total_retornos++;
          }
        });
      });
    });
    
    const porCliente = Object.values(porClienteMap).map(c => {
      // Usar tempos da query SQL, com fallback para cálculos JS
      // Frontend espera minutos como número, ele mesmo formata
      const temposCliente = temposPorClienteMap[c.cod_cliente] || {};
      
      // Fallback: usar cálculos JS se SQL não retornar
      const tempoMedioCliente = temposCliente.tempo_entrega || 
        (c.count_tempo > 0 ? c.soma_tempo / c.count_tempo : 0);
      const tempoAlocacaoCliente = temposCliente.tempo_alocacao || 0;
      
      // Converter centros_custo_map em array com dados
      const centros_custo_dados = Object.values(c.centros_custo_map).map(cc => ({
        centro_custo: cc.centro_custo,
        total_os: cc.os_set.size,
        total_entregas: cc.total_entregas,
        total_retornos: cc.total_retornos,
        dentro_prazo: cc.dentro_prazo,
        fora_prazo: cc.fora_prazo,
        sem_prazo: cc.sem_prazo,
        dentro_prazo_prof: cc.dentro_prazo_prof || 0,
        fora_prazo_prof: cc.fora_prazo_prof || 0,
        tempo_medio: cc.count_tempo > 0 ? cc.soma_tempo / cc.count_tempo : 0,
        valor_total: cc.soma_valor.toFixed(2),
        valor_prof: cc.soma_valor_prof.toFixed(2)
      })).sort((a, b) => b.total_entregas - a.total_entregas);
      
      const totalProfs = c.profissionais_set.size;
      const ticketMedio = c.total_entregas > 0 ? (c.soma_valor / c.total_entregas) : 0;
      const incentivo = totalProfs > 0 ? (c.total_entregas / totalProfs) : 0;
      
      return {
        cod_cliente: c.cod_cliente, nome_cliente: c.nome_cliente,
        nome_display: c.nome_display, tem_mascara: c.tem_mascara,
        total_os: c.os_set.size, total_entregas: c.total_entregas,
        centros_custo: centros_custo_dados,
        dentro_prazo: c.dentro_prazo, fora_prazo: c.fora_prazo, sem_prazo: c.sem_prazo,
        dentro_prazo_prof: c.dentro_prazo_prof, fora_prazo_prof: c.fora_prazo_prof,
        tempo_medio: tempoMedioCliente,
        tempo_medio_alocacao: tempoAlocacaoCliente,
        valor_total: c.soma_valor.toFixed(2), valor_prof: c.soma_valor_prof.toFixed(2),
        distancia_total: c.soma_dist ? c.soma_dist.toFixed(2) : "0.00",
        ticket_medio: ticketMedio.toFixed(2),
        total_profissionais: totalProfs,
        entregas_por_prof: incentivo.toFixed(2),
        incentivo: incentivo.toFixed(2),
        total_retornos: c.total_retornos,
        retornos: c.total_retornos,
        ultima_entrega: c.ultima_entrega ? c.ultima_entrega.toISOString() : null
      };
    });
    
    // ============================================
    // ADICIONAR CLIENTES QUE NÃO TÊM ENTREGAS NO PERÍODO
    // (apenas se não houver filtro de cliente específico)
    // ============================================
    if (!cod_cliente || cod_cliente.length === 0) {
      const clientesComDados = new Set(porCliente.map(c => String(c.cod_cliente)));
      
      todosClientes.forEach(tc => {
        const codCli = String(tc.cod_cliente);
        if (!clientesComDados.has(codCli)) {
          porCliente.push({
            cod_cliente: tc.cod_cliente,
            nome_cliente: tc.nome_cliente,
            nome_display: mapMascaras[codCli] || tc.nome_cliente,
            tem_mascara: !!mapMascaras[codCli],
            total_os: 0,
            total_entregas: 0,
            centros_custo: [],
            dentro_prazo: 0,
            fora_prazo: 0,
            sem_prazo: 0,
            tempo_medio: null,
            tempo_medio_alocacao: "0.00",
            valor_total: "0.00",
            valor_prof: "0.00",
            distancia_total: "0.00",
            ticket_medio: "0.00",
            total_profissionais: 0,
            entregas_por_prof: "0.00",
            incentivo: "0.00",
            total_retornos: 0,
            retornos: 0,
            dentro_prazo_prof: 0,
            fora_prazo_prof: 0,
            ultima_entrega: null
          });
        }
      });
    }
    
    // Ordenar por total de entregas (decrescente)
    porCliente.sort((a, b) => b.total_entregas - a.total_entregas);
    
    // Log centros de custo encontrados
    console.log('📁 CENTROS DE CUSTO POR CLIENTE:');
    porCliente.slice(0, 10).forEach(c => {
      console.log(`   - ${c.cod_cliente}: ${c.centros_custo?.length || 0} centros`);
    });
    
    // Log resultado por cliente
    console.log('📊 RESULTADO POR CLIENTE (total:', porCliente.length, '):');
    porCliente.slice(0, 5).forEach(c => {
      const temRegra = clientesComRegra.has(String(c.cod_cliente));
      console.log(`   - ${c.cod_cliente} (${c.nome_display}): ${c.total_os} OS, ${c.total_entregas} entregas, regra: ${temRegra}`);
    });
    console.log('📊 TOTAL GERAL: ', metricas.total_os, 'OS,', metricas.total_entregas, 'entregas');
    
    // Agrupar por profissional - também precisa respeitar a regra
    const porProfMap = {};
    
    // Agrupar por profissional/OS para aplicar regra corretamente
    const osPorProf = {};
    dados.forEach(row => {
      const codProf = String(row.cod_prof);
      const codCliente = String(row.cod_cliente);
      const os = row.os;
      const chave = `${codProf}-${os}`;
      
      if (!osPorProf[codProf]) osPorProf[codProf] = {};
      if (!osPorProf[codProf][os]) osPorProf[codProf][os] = { codCliente, linhas: [] };
      osPorProf[codProf][os].linhas.push(row);
    });
    
    // ============================================
    // QUERY SQL PARA TEMPOS POR PROFISSIONAL
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposPorProfQuery = await pool.query(`
      SELECT 
        cod_prof,
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
      GROUP BY cod_prof
    `, params);
    
    // Criar mapa de tempos por profissional
    const temposPorProfMap = {};
    temposPorProfQuery.rows.forEach(row => {
      temposPorProfMap[row.cod_prof] = {
        tempo_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_coleta: parseFloat(row.tempo_medio_coleta) || 0
      };
    });
    
    Object.keys(osPorProf).forEach(codProf => {
      const osDoProf = osPorProf[codProf];
      
      if (!porProfMap[codProf]) {
        const primeiraLinha = Object.values(osDoProf)[0].linhas[0];
        porProfMap[codProf] = {
          cod_prof: primeiraLinha.cod_prof,
          nome_prof: primeiraLinha.nome_prof,
          total_entregas: 0, dentro_prazo: 0, fora_prazo: 0,
          dentro_prazo_prof: 0, fora_prazo_prof: 0,
          soma_tempo: 0, count_tempo: 0, 
          soma_tempo_alocacao: 0, count_tempo_alocacao: 0,
          soma_tempo_coleta: 0, count_tempo_coleta: 0,
          soma_dist: 0, soma_valor_prof: 0, retornos: 0
        };
      }
      
      const p = porProfMap[codProf];
      
      // Função para verificar se é retorno baseado na Ocorrência
      const isRetornoProf = (ocorrencia) => {
        if (!ocorrencia) return false;
        const oc = ocorrencia.toLowerCase().trim();
        return oc.includes('cliente fechado') || 
               oc.includes('clienteaus') ||
               oc.includes('cliente ausente') ||
               oc.includes('loja fechada') ||
               oc.includes('produto incorreto');
      };
      
      // Função para parsear data/hora
      const parseDateTimeProf = (valor) => {
        if (!valor) return null;
        if (valor instanceof Date) {
          return {
            dataStr: valor.toISOString().split('T')[0],
            hora: valor.getHours(),
            min: valor.getMinutes(),
            seg: valor.getSeconds()
          };
        }
        const s = String(valor);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      Object.keys(osDoProf).forEach(os => {
        const { codCliente, linhas } = osDoProf[os];
        const entregasOS = calcularEntregasOS(linhas);
        p.total_entregas += entregasOS;
        
        // Contagem de retornos (ocorrência indica problema) - TODAS as linhas
        linhas.forEach(l => {
          if (isRetornoProf(l.ocorrencia)) p.retornos++;
        });
        
        // Separar linhas por tipo
        const linhaPonto1 = linhas.find(l => parseInt(l.ponto) === 1);
        const linhasEntrega = linhas.filter(l => parseInt(l.ponto) >= 2);
        
        // Tempo de alocação e coleta (do ponto 1)
        if (linhaPonto1) {
          const tempoAloc = calcularTempoAlocacao(linhaPonto1.data_hora, linhaPonto1.data_hora_alocado, 1);
          if (tempoAloc !== null) {
            p.soma_tempo_alocacao += tempoAloc;
            p.count_tempo_alocacao++;
          }
          
          const tempoCol = calcularTempoColeta(linhaPonto1);
          if (tempoCol !== null) {
            p.soma_tempo_coleta += tempoCol;
            p.count_tempo_coleta++;
          }
        }
        
        // Pegar data_hora_alocado do ponto 1 para cálculo do prazo prof
        const alocadoStr = linhaPonto1?.data_hora_alocado;
        const alocado = parseDateTimeProf(alocadoStr);
        
        // Função para calcular prazo prof de uma entrega
        const calcularPrazoProfEntrega = (entrega) => {
          const finalizadoStr = entrega.finalizado;
          const finalizado = parseDateTimeProf(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(entrega.distancia) || 0;
              const codClienteEntrega = entrega.cod_cliente;
              const centroCustoEntrega = entrega.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              
              if (tempoEntProf <= prazoMinutos) {
                p.dentro_prazo_prof++;
              } else {
                p.fora_prazo_prof++;
              }
            } else {
              p.fora_prazo_prof++;
            }
          } else {
            p.fora_prazo_prof++;
          }
        };
        
        // Métricas das entregas (ponto >= 2)
        if (linhasEntrega.length > 0) {
          linhasEntrega.forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            
            // Tempo de entrega
            const tempoEnt = calcularTempoEntrega(l);
            if (tempoEnt !== null) {
              p.soma_tempo += tempoEnt;
              p.count_tempo++;
            }
            
            // Prazo profissional
            calcularPrazoProfEntrega(l);
          });
        } else if (linhas.length > 1) {
          linhas.slice(1).forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            
            const tempoEnt = calcularTempoEntrega(l);
            if (tempoEnt !== null) {
              p.soma_tempo += tempoEnt;
              p.count_tempo++;
            }
            
            // Prazo profissional
            calcularPrazoProfEntrega(l);
          });
        } else {
          const l = linhas[0];
          if (l.dentro_prazo === true) p.dentro_prazo++;
          else if (l.dentro_prazo === false) p.fora_prazo++;
          p.soma_dist += parseFloat(l.distancia) || 0;
          p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
          
          const tempoEnt = calcularTempoEntrega(l);
          if (tempoEnt !== null) {
            p.soma_tempo += tempoEnt;
            p.count_tempo++;
          }
          
          // Prazo profissional
          calcularPrazoProfEntrega(l);
        }
      });
    });
    
    const porProfissional = Object.values(porProfMap).map(p => {
      // Usar tempos da query SQL, com fallback para cálculos JS
      // Frontend espera minutos como número, ele mesmo formata
      const temposProf = temposPorProfMap[p.cod_prof] || {};
      
      // Fallback: usar cálculos JS se SQL não retornar
      const tempoMedioProf = temposProf.tempo_entrega || 
        (p.count_tempo > 0 ? p.soma_tempo / p.count_tempo : 0);
      const tempoAlocadoProf = temposProf.tempo_alocacao || 
        (p.count_tempo_alocacao > 0 ? p.soma_tempo_alocacao / p.count_tempo_alocacao : 0);
      const tempoColetaProf = temposProf.tempo_coleta || 
        (p.count_tempo_coleta > 0 ? p.soma_tempo_coleta / p.count_tempo_coleta : 0);
      
      return {
        cod_prof: p.cod_prof, nome_prof: p.nome_prof,
        total_entregas: p.total_entregas, dentro_prazo: p.dentro_prazo, fora_prazo: p.fora_prazo,
        dentro_prazo_prof: p.dentro_prazo_prof, fora_prazo_prof: p.fora_prazo_prof,
        tempo_medio: tempoMedioProf,
        tempo_alocado: tempoAlocadoProf,
        tempo_coleta: tempoColetaProf,
        distancia_total: p.soma_dist.toFixed(2), valor_prof: p.soma_valor_prof.toFixed(2),
        retornos: p.retornos
      };
    }).sort((a, b) => b.total_entregas - a.total_entregas);
    
    // DEBUG: Log dos primeiros profissionais para verificar tempos
    if (porProfissional.length > 0) {
      console.log('📊 DEBUG - Primeiro profissional:', {
        cod_prof: porProfissional[0].cod_prof,
        nome_prof: porProfissional[0].nome_prof,
        tempo_medio: porProfissional[0].tempo_medio,
        tempo_alocado: porProfissional[0].tempo_alocado,
        tempo_coleta: porProfissional[0].tempo_coleta,
        temposSQL: temposPorProfMap[porProfissional[0].cod_prof]
      });
    }
    
    // Gráficos - retorna dados brutos para o frontend agrupar nas faixas que quiser
    const dadosGraficos = await pool.query(`
      SELECT 
        tempo_execucao_minutos as tempo,
        distancia as km
      FROM bi_entregas 
      ${where}
    `, params);
    
    res.json({ 
      metricas, 
      porCliente, 
      porProfissional, 
      dadosGraficos: dadosGraficos.rows 
    });
  } catch (err) {
    console.error('❌ Erro dashboard-completo:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dashboard', details: err.message });
  }
});

// ============================================
// ENDPOINT: OS por Profissional (para expandir na aba profissionais)
// ============================================
app.get('/api/bi/os-profissional/:cod_prof', async (req, res) => {
  try {
    const { cod_prof } = req.params;
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_prazo, status_retorno, cidade } = req.query;
    
    let whereClause = 'WHERE cod_prof = $1';
    const params = [cod_prof];
    let paramIndex = 2;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria ILIKE $${paramIndex}`;
      params.push(`%${categoria}%`);
      paramIndex++;
    }
    if (status_prazo === 'dentro') {
      whereClause += ` AND dentro_prazo = true`;
    } else if (status_prazo === 'fora') {
      whereClause += ` AND dentro_prazo = false`;
    }
    if (cidade) {
      whereClause += ` AND cidade ILIKE $${paramIndex}`;
      params.push(`%${cidade}%`);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Buscar TODAS as linhas do profissional (incluindo ponto 1 para calcular tempos)
    const query = await pool.query(`
      SELECT 
        os,
        COALESCE(ponto, 1) as ponto,
        cod_cliente,
        COALESCE(nome_fantasia, nome_cliente) as cliente,
        centro_custo,
        distancia,
        valor,
        valor_prof,
        dentro_prazo,
        data_solicitado,
        data_hora,
        data_hora_alocado,
        data_chegada,
        hora_chegada,
        finalizado,
        ocorrencia,
        motivo
      FROM bi_entregas
      ${whereClause}
      ORDER BY data_solicitado DESC, os DESC
    `, params);
    
    // Funções de cálculo (mesmas das outras abas)
    const calcularTempoAlocacao = (dataHora, dataHoraAlocado, ponto) => {
      if (!dataHora || !dataHoraAlocado) return null;
      const pontoNum = parseInt(ponto) || 1;
      if (pontoNum !== 1) return null; // Só calcula para ponto 1
      
      const solicitado = new Date(dataHora);
      const alocado = new Date(dataHoraAlocado);
      
      if (alocado < solicitado || isNaN(alocado.getTime()) || isNaN(solicitado.getTime())) return null;
      
      const horaSolicitado = solicitado.getHours();
      const depoisDas17 = horaSolicitado >= 17;
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem;
      if (depoisDas17 && !mesmaData) {
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (alocado - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null;
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {}
      }
      
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {}
      }
      
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    // Agrupar por OS
    const osPorNumero = {};
    query.rows.forEach(row => {
      const osNum = row.os;
      if (!osPorNumero[osNum]) {
        osPorNumero[osNum] = {
          os: osNum,
          linhas: [],
          cod_cliente: row.cod_cliente,
          cliente: row.cliente,
          centro_custo: row.centro_custo,
          data_solicitado: row.data_solicitado
        };
      }
      osPorNumero[osNum].linhas.push(row);
    });
    
    // Processar cada OS
    const oss = Object.values(osPorNumero).map(osData => {
      const { os, linhas, cod_cliente, cliente, centro_custo, data_solicitado } = osData;
      
      // Separar linhas por tipo
      const linhaPonto1 = linhas.find(l => parseInt(l.ponto) === 1);
      const linhasEntrega = linhas.filter(l => parseInt(l.ponto) >= 2);
      
      // Calcular tempos
      let tempoAlocacao = null;
      let tempoColeta = null;
      let tempoEntrega = null;
      let dentroPrazo = null;
      let distancia = 0;
      let valorProf = 0;
      
      // Tempo de alocação (do ponto 1)
      if (linhaPonto1) {
        tempoAlocacao = calcularTempoAlocacao(linhaPonto1.data_hora, linhaPonto1.data_hora_alocado, 1);
        tempoColeta = calcularTempoColeta(linhaPonto1);
      }
      
      // Tempo de entrega e demais dados (das entregas)
      if (linhasEntrega.length > 0) {
        // Pegar a primeira entrega para calcular tempo
        const primeiraEntrega = linhasEntrega[0];
        tempoEntrega = calcularTempoEntrega(primeiraEntrega);
        
        // Somar valores de todas as entregas
        linhasEntrega.forEach(l => {
          distancia += parseFloat(l.distancia) || 0;
          valorProf += parseFloat(l.valor_prof) || 0;
          if (l.dentro_prazo !== null) dentroPrazo = l.dentro_prazo;
        });
      }
      
      return {
        os,
        cod_cliente,
        cliente,
        centro_custo,
        data_solicitado,
        tempo_alocacao: tempoAlocacao,
        tempo_coleta: tempoColeta,
        tempo_entrega: tempoEntrega,
        distancia,
        dentro_prazo: dentroPrazo,
        valor_prof: valorProf
      };
    })
    .filter(os => os.tempo_entrega !== null || os.tempo_alocacao !== null) // Apenas OS com algum tempo calculado
    .sort((a, b) => new Date(b.data_solicitado) - new Date(a.data_solicitado))
    .slice(0, 100); // Limitar a 100 OS
    
    res.json({ oss, total: oss.length });
    
  } catch (error) {
    console.error('Erro OS profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar OS do profissional', details: error.message });
  }
});


// Lista de entregas detalhada (para análise por OS)
app.get('/api/bi/entregas-lista', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, status_retorno, cidade, clientes_sem_filtro_cc } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // Clientes que não devem ter filtro de centro de custo
    let clientesSemFiltroCC = [];
    if (clientes_sem_filtro_cc) {
      clientesSemFiltroCC = clientes_sem_filtro_cc.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }
    
    // Converter datas ISO para YYYY-MM-DD
    if (data_inicio) { 
      const dataIni = data_inicio.includes('T') ? data_inicio.split('T')[0] : data_inicio;
      where += ` AND data_solicitado >= $${paramIndex++}`; 
      params.push(dataIni); 
    }
    if (data_fim) { 
      const dataFim = data_fim.includes('T') ? data_fim.split('T')[0] : data_fim;
      where += ` AND data_solicitado <= $${paramIndex++}`; 
      params.push(dataFim); 
    }
    if (cod_cliente) { 
      // Suporta múltiplos clientes separados por vírgula
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        where += ` AND cod_cliente = ANY($${paramIndex++}::int[])`; 
        params.push(clientes);
      }
    }
    if (centro_custo) { 
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        if (clientesSemFiltroCC.length > 0) {
          // Filtrar por CC OU ser um cliente sem filtro de CC
          where += ` AND (centro_custo = ANY($${paramIndex++}::text[]) OR cod_cliente = ANY($${paramIndex++}::int[]))`;
          params.push(centros);
          params.push(clientesSemFiltroCC);
        } else {
          where += ` AND centro_custo = ANY($${paramIndex++}::text[])`; 
          params.push(centros);
        }
      }
    }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    
    // Filtro de retorno - usar mesma lógica da função isRetorno
    let retornoFilter = '';
    if (status_retorno === 'com_retorno') {
      retornoFilter = ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      retornoFilter = ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    const result = await pool.query(`
      SELECT 
        os,
        COALESCE(ponto, 1) as ponto,
        cod_prof,
        nome_prof,
        cod_cliente,
        COALESCE(nome_fantasia, nome_cliente) as cliente,
        centro_custo,
        endereco,
        cidade,
        data_solicitado,
        hora_solicitado,
        data_hora,
        data_hora_alocado,
        data_chegada,
        hora_chegada,
        data_saida,
        hora_saida,
        finalizado,
        distancia,
        dentro_prazo,
        tempo_execucao_minutos,
        prazo_minutos,
        dentro_prazo_prof,
        prazo_prof_minutos,
        tempo_entrega_prof_minutos,
        valor,
        valor_prof,
        categoria,
        ocorrencia,
        motivo,
        status
      FROM bi_entregas ${where}${retornoFilter}
      ORDER BY os DESC, COALESCE(ponto, 1) ASC
      LIMIT 2000
    `, params);
    
    // Retornar direto - campos já calculados no banco durante upload/recálculo
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar entregas:', err);
    res.status(500).json({ error: 'Erro ao listar entregas' });
  }
});

// Lista de cidades disponíveis
app.get('/api/bi/cidades', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cidade, COUNT(*) as total
      FROM bi_entregas
      WHERE cidade IS NOT NULL AND cidade != ''
      GROUP BY cidade
      ORDER BY total DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar cidades:', err);
    res.json([]);
  }
});

// Relação Cliente -> Centros de Custo
app.get('/api/bi/cliente-centros', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cod_cliente, centro_custo
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL AND centro_custo IS NOT NULL AND centro_custo != ''
      GROUP BY cod_cliente, centro_custo
      ORDER BY cod_cliente, centro_custo
    `);
    // Agrupa por cliente
    const mapa = {};
    result.rows.forEach(r => {
      const cod = String(r.cod_cliente);
      if (!mapa[cod]) mapa[cod] = [];
      mapa[cod].push(r.centro_custo);
    });
    res.json(mapa);
  } catch (err) {
    console.error('❌ Erro ao listar cliente-centros:', err);
    res.json({});
  }
});

// ===== MÁSCARAS DE CLIENTES =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_mascaras (
    id SERIAL PRIMARY KEY,
    cod_cliente VARCHAR(50) NOT NULL UNIQUE,
    mascara VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_mascaras já existe ou erro:', err.message));

// Listar máscaras
app.get('/api/bi/mascaras', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_mascaras ORDER BY cod_cliente');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar máscaras:', err);
    res.json([]);
  }
});

// Criar/Atualizar máscara
app.post('/api/bi/mascaras', async (req, res) => {
  try {
    const { cod_cliente, mascara } = req.body;
    if (!cod_cliente || !mascara) {
      return res.status(400).json({ error: 'cod_cliente e mascara são obrigatórios' });
    }
    
    // Upsert - atualiza se existir, insere se não
    const result = await pool.query(`
      INSERT INTO bi_mascaras (cod_cliente, mascara) 
      VALUES ($1, $2)
      ON CONFLICT (cod_cliente) DO UPDATE SET mascara = $2
      RETURNING *
    `, [cod_cliente, mascara]);
    
    res.json({ success: true, mascara: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar máscara:', err);
    res.status(500).json({ error: 'Erro ao salvar máscara' });
  }
});

// Excluir máscara
app.delete('/api/bi/mascaras/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_mascaras WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir máscara:', err);
    res.status(500).json({ error: 'Erro ao excluir máscara' });
  }
});

// ===== LOCALIZAÇÃO DE CLIENTES (Ponto 1) =====
// Endpoint para listar clientes com seus endereços de coleta (Ponto 1) e coordenadas
app.get('/api/bi/localizacao-clientes', async (req, res) => {
  try {
    // Clientes que devem ter endereços separados por centro de custo
    const clientesSeparadosPorCC = ['767', '1046', '713'];
    
    // Query para clientes NORMAIS - retorna apenas o endereço com mais entregas
    const resultNormal = await pool.query(`
      WITH endereco_normalizado AS (
        SELECT 
          cod_cliente,
          nome_cliente,
          centro_custo,
          UPPER(TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(endereco, '^Ponto\\s*\\d+\\s*-\\s*', '', 'i'),
              '\\s*-\\s*(GALPAO|GALPÃO|DEPOSITO|DEPÓSITO|CD|LOJA|FILIAL).*$', '', 'i'
            ),
            '\\s+', ' ', 'g'
          ))) as endereco_normalizado,
          endereco as endereco_original,
          bairro,
          cidade,
          estado,
          latitude,
          longitude
        FROM bi_entregas
        WHERE ponto = 1 
          AND cod_cliente IS NOT NULL
          AND endereco IS NOT NULL
          AND endereco != ''
          AND cod_cliente::text NOT IN ('767', '1046', '713')
      ),
      cliente_enderecos AS (
        SELECT 
          cod_cliente,
          MAX(nome_cliente) as nome_cliente,
          LEFT(endereco_normalizado, 50) as endereco_grupo,
          MODE() WITHIN GROUP (ORDER BY endereco_original) as endereco,
          MAX(bairro) as bairro,
          MAX(cidade) as cidade,
          MAX(estado) as estado,
          AVG(NULLIF(latitude, 0)) as latitude,
          AVG(NULLIF(longitude, 0)) as longitude,
          COUNT(*) as total_entregas
        FROM endereco_normalizado
        GROUP BY cod_cliente, LEFT(endereco_normalizado, 50)
      ),
      -- Pega apenas o endereço com mais entregas por cliente
      cliente_top_endereco AS (
        SELECT DISTINCT ON (cod_cliente)
          cod_cliente,
          nome_cliente,
          endereco,
          bairro,
          cidade,
          estado,
          latitude,
          longitude,
          total_entregas
        FROM cliente_enderecos
        ORDER BY cod_cliente, total_entregas DESC
      )
      SELECT 
        ce.cod_cliente,
        COALESCE(m.mascara, ce.nome_cliente) as nome_cliente,
        NULL as centro_custo,
        jsonb_build_array(
          jsonb_build_object(
            'endereco', ce.endereco,
            'bairro', ce.bairro,
            'cidade', ce.cidade,
            'estado', ce.estado,
            'latitude', ce.latitude,
            'longitude', ce.longitude,
            'total_entregas', ce.total_entregas,
            'centro_custo', NULL
          )
        ) as enderecos
      FROM cliente_top_endereco ce
      LEFT JOIN bi_mascaras m ON m.cod_cliente = ce.cod_cliente::text
    `);
    
    // Query para clientes ESPECIAIS (767, 1046, 713) - separados por centro de custo, 1 endereço por CC
    const resultEspecial = await pool.query(`
      WITH endereco_normalizado AS (
        SELECT 
          cod_cliente,
          nome_cliente,
          centro_custo,
          UPPER(TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(endereco, '^Ponto\\s*\\d+\\s*-\\s*', '', 'i'),
              '\\s*-\\s*(GALPAO|GALPÃO|DEPOSITO|DEPÓSITO|CD|LOJA|FILIAL).*$', '', 'i'
            ),
            '\\s+', ' ', 'g'
          ))) as endereco_normalizado,
          endereco as endereco_original,
          bairro,
          cidade,
          estado,
          latitude,
          longitude
        FROM bi_entregas
        WHERE ponto = 1 
          AND cod_cliente IS NOT NULL
          AND endereco IS NOT NULL
          AND endereco != ''
          AND cod_cliente::text IN ('767', '1046', '713')
      ),
      cliente_enderecos AS (
        SELECT 
          cod_cliente,
          MAX(nome_cliente) as nome_cliente,
          centro_custo,
          LEFT(endereco_normalizado, 50) as endereco_grupo,
          MODE() WITHIN GROUP (ORDER BY endereco_original) as endereco,
          MAX(bairro) as bairro,
          MAX(cidade) as cidade,
          MAX(estado) as estado,
          AVG(NULLIF(latitude, 0)) as latitude,
          AVG(NULLIF(longitude, 0)) as longitude,
          COUNT(*) as total_entregas
        FROM endereco_normalizado
        GROUP BY cod_cliente, centro_custo, LEFT(endereco_normalizado, 50)
      ),
      -- Pega apenas o endereço com mais entregas por cliente + centro de custo
      cliente_cc_top_endereco AS (
        SELECT DISTINCT ON (cod_cliente, centro_custo)
          cod_cliente,
          nome_cliente,
          centro_custo,
          endereco,
          bairro,
          cidade,
          estado,
          latitude,
          longitude,
          total_entregas
        FROM cliente_enderecos
        ORDER BY cod_cliente, centro_custo, total_entregas DESC
      )
      SELECT 
        ce.cod_cliente,
        COALESCE(m.mascara, ce.nome_cliente) as nome_cliente,
        ce.centro_custo,
        jsonb_build_array(
          jsonb_build_object(
            'endereco', ce.endereco,
            'bairro', ce.bairro,
            'cidade', ce.cidade,
            'estado', ce.estado,
            'latitude', ce.latitude,
            'longitude', ce.longitude,
            'total_entregas', ce.total_entregas,
            'centro_custo', ce.centro_custo
          )
        ) as enderecos
      FROM cliente_cc_top_endereco ce
      LEFT JOIN bi_mascaras m ON m.cod_cliente = ce.cod_cliente::text
    `);
    
    // Combina os resultados e ordena
    const todosClientes = [...resultNormal.rows, ...resultEspecial.rows]
      .sort((a, b) => parseInt(a.cod_cliente) - parseInt(b.cod_cliente));
    
    res.json(todosClientes);
  } catch (err) {
    console.error('❌ Erro ao buscar localização clientes:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// ===== SISTEMA DE SETORES =====

// Listar todos os setores
app.get('/api/setores', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM users u WHERE u.setor_id = s.id) as total_usuarios
      FROM setores s 
      ORDER BY s.nome ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar setores:', err);
    res.status(500).json({ error: 'Erro ao listar setores' });
  }
});

// Criar setor
app.post('/api/setores', async (req, res) => {
  try {
    const { nome, descricao, cor } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    const result = await pool.query(`
      INSERT INTO setores (nome, descricao, cor)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [nome, descricao || '', cor || '#6366f1']);
    
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe um setor com este nome' });
    }
    console.error('❌ Erro ao criar setor:', err);
    res.status(500).json({ error: 'Erro ao criar setor' });
  }
});

// Atualizar setor
app.put('/api/setores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, cor, ativo } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    const result = await pool.query(`
      UPDATE setores 
      SET nome = $1, descricao = $2, cor = $3, ativo = $4, updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [nome, descricao || '', cor || '#6366f1', ativo !== false, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Setor não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe um setor com este nome' });
    }
    console.error('❌ Erro ao atualizar setor:', err);
    res.status(500).json({ error: 'Erro ao atualizar setor' });
  }
});

// Excluir setor
app.delete('/api/setores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se há usuários vinculados
    const usuarios = await pool.query('SELECT COUNT(*) FROM users WHERE setor_id = $1', [id]);
    if (parseInt(usuarios.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: `Não é possível excluir. Existem ${usuarios.rows[0].count} usuário(s) vinculado(s) a este setor.` 
      });
    }
    
    const result = await pool.query('DELETE FROM setores WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Setor não encontrado' });
    }
    
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao excluir setor:', err);
    res.status(500).json({ error: 'Erro ao excluir setor' });
  }
});

// Atualizar setor do usuário
app.patch('/api/users/:codProfissional/setor', async (req, res) => {
  try {
    const { codProfissional } = req.params;
    const { setor_id } = req.body;
    
    const result = await pool.query(`
      UPDATE users 
      SET setor_id = $1, updated_at = NOW()
      WHERE LOWER(cod_profissional) = LOWER($2)
      RETURNING id, cod_profissional, full_name, setor_id
    `, [setor_id || null, codProfissional]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar setor do usuário:', err);
    res.status(500).json({ error: 'Erro ao atualizar setor' });
  }
});

// ===== RELATÓRIOS DIÁRIOS =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS relatorios_diarios (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL,
    conteudo TEXT,
    usuario_id VARCHAR(100),
    usuario_nome VARCHAR(255),
    usuario_foto TEXT,
    imagem_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela relatorios_diarios já existe ou erro:', err.message));

// Criar tabela de visualizações
pool.query(`
  CREATE TABLE IF NOT EXISTS relatorios_visualizacoes (
    id SERIAL PRIMARY KEY,
    relatorio_id INTEGER NOT NULL REFERENCES relatorios_diarios(id) ON DELETE CASCADE,
    usuario_id VARCHAR(100) NOT NULL,
    usuario_nome VARCHAR(255),
    usuario_foto TEXT,
    visualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(relatorio_id, usuario_id)
  )
`).catch(err => console.log('Tabela relatorios_visualizacoes já existe ou erro:', err.message));

// Listar relatórios diários com visualizações
app.get('/api/relatorios-diarios', async (req, res) => {
  try {
    const { setor_id, usuario_id } = req.query;
    
    // Se passar setor_id, filtra relatórios que o usuário pode ver
    // Se não passar, retorna todos (para admin ver tudo)
    let query;
    let params = [];
    
    if (setor_id || usuario_id) {
      // Usuário comum: só vê relatórios para todos OU para seu setor
      query = `
        SELECT 
          r.*,
          COALESCE(
            json_agg(
              json_build_object(
                'usuario_id', rv.usuario_id,
                'usuario_nome', rv.usuario_nome,
                'usuario_foto', rv.usuario_foto,
                'visualizado_em', rv.visualizado_em
              )
            ) FILTER (WHERE rv.id IS NOT NULL),
            '[]'
          ) as visualizacoes
        FROM relatorios_diarios r
        LEFT JOIN relatorios_visualizacoes rv ON r.id = rv.relatorio_id
        WHERE (
          r.para_todos = true 
          OR ($1::integer IS NOT NULL AND $1 = ANY(r.setores_destino))
          OR r.usuario_id = $2
        )
        GROUP BY r.id
        ORDER BY r.created_at DESC 
        LIMIT 100
      `;
      params = [setor_id || null, usuario_id || ''];
    } else {
      // Admin sem filtro: vê todos os relatórios
      query = `
        SELECT 
          r.*,
          COALESCE(
            json_agg(
              json_build_object(
                'usuario_id', rv.usuario_id,
                'usuario_nome', rv.usuario_nome,
                'usuario_foto', rv.usuario_foto,
                'visualizado_em', rv.visualizado_em
              )
            ) FILTER (WHERE rv.id IS NOT NULL),
            '[]'
          ) as visualizacoes
        FROM relatorios_diarios r
        LEFT JOIN relatorios_visualizacoes rv ON r.id = rv.relatorio_id
        GROUP BY r.id
        ORDER BY r.created_at DESC 
        LIMIT 100
      `;
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar relatórios:', err);
    res.status(500).json({ error: 'Erro ao listar relatórios' });
  }
});

// Buscar relatórios não lidos por um usuário (filtrado por setor)
app.get('/api/relatorios-diarios/nao-lidos/:usuario_id', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    const { setor_id } = req.query;
    
    // Query que considera:
    // 1. Relatórios para todos (para_todos = true)
    // 2. Relatórios onde o setor do usuário está na lista de setores_destino
    const result = await pool.query(`
      SELECT r.* 
      FROM relatorios_diarios r
      WHERE NOT EXISTS (
        SELECT 1 FROM relatorios_visualizacoes rv 
        WHERE rv.relatorio_id = r.id AND rv.usuario_id = $1
      )
      AND r.usuario_id != $1
      AND (
        r.para_todos = true 
        OR ($2::integer IS NOT NULL AND $2 = ANY(r.setores_destino))
      )
      ORDER BY r.created_at DESC
    `, [usuario_id, setor_id || null]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar relatórios não lidos:', err);
    res.status(500).json({ error: 'Erro ao buscar relatórios não lidos' });
  }
});

// Marcar relatório como lido
app.post('/api/relatorios-diarios/:id/visualizar', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id, usuario_nome, usuario_foto } = req.body;
    
    if (!usuario_id) {
      return res.status(400).json({ error: 'usuario_id é obrigatório' });
    }
    
    // Inserir ou ignorar se já existe
    await pool.query(`
      INSERT INTO relatorios_visualizacoes (relatorio_id, usuario_id, usuario_nome, usuario_foto)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (relatorio_id, usuario_id) DO NOTHING
    `, [id, usuario_id, usuario_nome, usuario_foto]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao marcar como lido:', err);
    res.status(500).json({ error: 'Erro ao marcar como lido' });
  }
});

// Criar relatório diário
app.post('/api/relatorios-diarios', async (req, res) => {
  try {
    const { titulo, conteudo, usuario_id, usuario_nome, usuario_foto, imagem_base64, setores_destino, para_todos } = req.body;
    
    if (!titulo) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    
    // Converter array de setores para formato PostgreSQL
    const setoresArray = Array.isArray(setores_destino) ? setores_destino : [];
    
    const result = await pool.query(`
      INSERT INTO relatorios_diarios (titulo, conteudo, usuario_id, usuario_nome, usuario_foto, imagem_url, setores_destino, para_todos)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [titulo, conteudo || '', usuario_id, usuario_nome, usuario_foto, imagem_base64 || null, setoresArray, para_todos !== false]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar relatório:', err);
    res.status(500).json({ error: 'Erro ao criar relatório' });
  }
});

// Atualizar relatório diário
app.put('/api/relatorios-diarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, conteudo, imagem_base64 } = req.body;
    
    if (!titulo) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    
    let updateQuery, params;
    
    if (imagem_base64) {
      updateQuery = `
        UPDATE relatorios_diarios 
        SET titulo = $1, conteudo = $2, imagem_url = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *
      `;
      params = [titulo, conteudo || '', imagem_base64, id];
    } else {
      updateQuery = `
        UPDATE relatorios_diarios 
        SET titulo = $1, conteudo = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `;
      params = [titulo, conteudo || '', id];
    }
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar relatório:', err);
    res.status(500).json({ error: 'Erro ao atualizar relatório' });
  }
});

// Excluir relatório diário
app.delete('/api/relatorios-diarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM relatorios_diarios WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json({ success: true, message: 'Relatório excluído' });
  } catch (err) {
    console.error('❌ Erro ao excluir relatório:', err);
    res.status(500).json({ error: 'Erro ao excluir relatório' });
  }
});

// ===== REGRAS DE CONTAGEM DE ENTREGAS =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_regras_contagem (
    id SERIAL PRIMARY KEY,
    cod_cliente VARCHAR(50) NOT NULL UNIQUE,
    nome_cliente VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_regras_contagem já existe ou erro:', err.message));

// Listar regras de contagem
app.get('/api/bi/regras-contagem', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_regras_contagem ORDER BY cod_cliente');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar regras de contagem:', err);
    res.json([]);
  }
});

// Criar regra de contagem
app.post('/api/bi/regras-contagem', async (req, res) => {
  try {
    const { cod_cliente, nome_cliente } = req.body;
    if (!cod_cliente) {
      return res.status(400).json({ error: 'cod_cliente é obrigatório' });
    }
    
    const result = await pool.query(`
      INSERT INTO bi_regras_contagem (cod_cliente, nome_cliente) 
      VALUES ($1, $2)
      ON CONFLICT (cod_cliente) DO NOTHING
      RETURNING *
    `, [cod_cliente, nome_cliente || null]);
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Cliente já possui regra de contagem' });
    }
    
    res.json({ success: true, regra: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar regra de contagem:', err);
    res.status(500).json({ error: 'Erro ao salvar regra' });
  }
});

// Excluir regra de contagem
app.delete('/api/bi/regras-contagem/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_regras_contagem WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir regra:', err);
    res.status(500).json({ error: 'Erro ao excluir regra' });
  }
});

// Resumo por Cliente (tabela detalhada)
app.get('/api/bi/resumo-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    const result = await pool.query(`
      SELECT 
        cod_cliente,
        nome_cliente,
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
        ROUND(SUM(valor)::numeric, 2) as valor_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_prof,
        ROUND(SUM(valor)::numeric - COALESCE(SUM(valor_prof)::numeric, 0), 2) as faturamento
      FROM bi_entregas ${where}
      GROUP BY cod_cliente, nome_cliente
      ORDER BY total_entregas DESC
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro resumo clientes:', err);
    res.status(500).json({ error: 'Erro ao carregar resumo por cliente' });
  }
});

// Resumo por Profissional (tabela detalhada)
app.get('/api/bi/resumo-profissionais', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    const result = await pool.query(`
      SELECT 
        cod_prof,
        nome_prof,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_entrega,
        ROUND(SUM(distancia)::numeric, 2) as distancia_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_total,
        COUNT(*) FILTER (WHERE ocorrencia = 'Retorno') as retornos
      FROM bi_entregas ${where}
      GROUP BY cod_prof, nome_prof
      ORDER BY total_entregas DESC
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro resumo profissionais:', err);
    res.status(500).json({ error: 'Erro ao carregar resumo por profissional' });
  }
});

// Análise por OS (detalhamento)
app.get('/api/bi/analise-os', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, os } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (os) { where += ` AND os = $${paramIndex++}`; params.push(os); }
    
    const result = await pool.query(`
      SELECT 
        os, nome_prof, endereco, cidade, 
        data_solicitado, hora_solicitado,
        hora_chegada, hora_saida,
        tempo_execucao_minutos, distancia, 
        dentro_prazo, prazo_minutos,
        finalizado, status, ocorrencia, categoria
      FROM bi_entregas ${where}
      ORDER BY data_solicitado DESC, os DESC
      LIMIT 500
    `, params);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro análise OS:', err);
    res.status(500).json({ error: 'Erro ao carregar análise por OS' });
  }
});

// Gráficos - Faixas de tempo e KM
app.get('/api/bi/graficos', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) { where += ` AND data_solicitado >= $${paramIndex++}`; params.push(data_inicio); }
    if (data_fim) { where += ` AND data_solicitado <= $${paramIndex++}`; params.push(data_fim); }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    
    // Faixas de tempo
    const faixasTempo = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE tempo_execucao_minutos IS NULL) as nao_atribuida,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 45) as ate_45,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 45 AND tempo_execucao_minutos <= 60) as ate_60,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 60 AND tempo_execucao_minutos <= 75) as ate_75,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 75 AND tempo_execucao_minutos <= 90) as ate_90,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 90 AND tempo_execucao_minutos <= 120) as ate_120,
        COUNT(*) FILTER (WHERE tempo_execucao_minutos > 120) as mais_120
      FROM bi_entregas ${where}
    `, params);
    
    // Faixas de KM
    const faixasKm = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE distancia > 100) as mais_100,
        COUNT(*) FILTER (WHERE distancia >= 0 AND distancia <= 10) as km_0_10,
        COUNT(*) FILTER (WHERE distancia > 10 AND distancia <= 15) as km_11_15,
        COUNT(*) FILTER (WHERE distancia > 15 AND distancia <= 20) as km_16_20,
        COUNT(*) FILTER (WHERE distancia > 20 AND distancia <= 25) as km_21_25,
        COUNT(*) FILTER (WHERE distancia > 25 AND distancia <= 30) as km_26_30,
        COUNT(*) FILTER (WHERE distancia > 30 AND distancia <= 35) as km_31_35,
        COUNT(*) FILTER (WHERE distancia > 35 AND distancia <= 40) as km_36_40,
        COUNT(*) FILTER (WHERE distancia > 40 AND distancia <= 50) as km_41_50,
        COUNT(*) FILTER (WHERE distancia > 50 AND distancia <= 60) as km_51_60,
        COUNT(*) FILTER (WHERE distancia > 60 AND distancia <= 70) as km_61_70,
        COUNT(*) FILTER (WHERE distancia > 70 AND distancia <= 80) as km_71_80,
        COUNT(*) FILTER (WHERE distancia > 80 AND distancia <= 90) as km_81_90,
        COUNT(*) FILTER (WHERE distancia > 90 AND distancia <= 100) as km_91_100
      FROM bi_entregas ${where}
    `, params);
    
    res.json({
      faixasTempo: faixasTempo.rows[0] || {},
      faixasKm: faixasKm.rows[0] || {}
    });
  } catch (err) {
    console.error('❌ Erro gráficos:', err);
    res.status(500).json({ error: 'Erro ao carregar gráficos' });
  }
});

// Listar clientes únicos (para dropdown)
app.get('/api/bi/clientes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_cliente 
      FROM bi_entregas 
      WHERE cod_cliente IS NOT NULL
      ORDER BY nome_cliente
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Listar centros de custo únicos (para dropdown)
app.get('/api/bi/centros-custo', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT centro_custo 
      FROM bi_entregas 
      WHERE centro_custo IS NOT NULL AND centro_custo != ''
      ORDER BY centro_custo
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar centros:', err);
    res.status(500).json({ error: 'Erro ao listar centros' });
  }
});

// Listar centros de custo de um cliente específico
app.get('/api/bi/centros-custo/:cod_cliente', async (req, res) => {
  try {
    const { cod_cliente } = req.params;
    const result = await pool.query(`
      SELECT DISTINCT centro_custo, COUNT(*) as total_entregas
      FROM bi_entregas 
      WHERE cod_cliente = $1 AND centro_custo IS NOT NULL AND centro_custo != ''
      GROUP BY centro_custo
      ORDER BY centro_custo
    `, [cod_cliente]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar centros do cliente:', err);
    res.status(500).json({ error: 'Erro ao listar centros do cliente' });
  }
});

// Listar profissionais únicos (para dropdown)
app.get('/api/bi/profissionais', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_prof, nome_prof 
      FROM bi_entregas 
      WHERE cod_prof IS NOT NULL
      ORDER BY nome_prof
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar profissionais:', err);
    res.status(500).json({ error: 'Erro ao listar profissionais' });
  }
});

// Listar datas disponíveis (apenas datas com dados)
app.get('/api/bi/datas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT data_solicitado as data, COUNT(*) as total
      FROM bi_entregas 
      WHERE data_solicitado IS NOT NULL
      GROUP BY data_solicitado
      ORDER BY data_solicitado DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar datas:', err);
    res.status(500).json({ error: 'Erro ao listar datas' });
  }
});

// Listar uploads realizados
// Listar histórico de uploads
app.get('/api/bi/uploads', async (req, res) => {
  try {
    // Primeiro tenta buscar do histórico novo
    const historico = await pool.query(`
      SELECT 
        id,
        usuario_id,
        usuario_nome,
        nome_arquivo,
        total_linhas,
        linhas_inseridas,
        linhas_ignoradas,
        os_novas,
        os_ignoradas,
        data_upload
      FROM bi_upload_historico
      ORDER BY data_upload DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }));
    
    if (historico.rows.length > 0) {
      res.json(historico.rows);
    } else {
      // Fallback para o método antigo (agregado por data_upload)
      const result = await pool.query(`
        SELECT data_upload, COUNT(*) as total_registros, 
               MIN(data_solicitado) as data_inicial,
               MAX(data_solicitado) as data_final
        FROM bi_entregas 
        WHERE data_upload IS NOT NULL
        GROUP BY data_upload
        ORDER BY data_upload DESC
      `);
      res.json(result.rows);
    }
  } catch (err) {
    console.error('❌ Erro ao listar uploads:', err);
    res.status(500).json({ error: 'Erro ao listar uploads' });
  }
});

// Excluir upload por data
app.delete('/api/bi/uploads/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const result = await pool.query(`DELETE FROM bi_entregas WHERE data_upload = $1`, [data]);
    // Também remove do histórico
    await pool.query(`DELETE FROM bi_upload_historico WHERE DATE(data_upload) = $1`, [data]).catch(() => {});
    res.json({ success: true, deletados: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao excluir upload:', err);
    res.status(500).json({ error: 'Erro ao excluir upload' });
  }
});

// Excluir upload por ID do histórico
app.delete('/api/bi/uploads/historico/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Buscar info do histórico
    const hist = await pool.query(`SELECT data_upload FROM bi_upload_historico WHERE id = $1`, [id]);
    if (hist.rows.length > 0) {
      const dataUpload = hist.rows[0].data_upload;
      // Deletar entregas dessa data
      await pool.query(`DELETE FROM bi_entregas WHERE data_upload = DATE($1)`, [dataUpload]);
    }
    // Deletar do histórico
    await pool.query(`DELETE FROM bi_upload_historico WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir histórico:', err);
    res.status(500).json({ error: 'Erro ao excluir histórico' });
  }
});

// Limpar entregas por período
app.delete('/api/bi/entregas', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    
    let query = 'DELETE FROM bi_entregas WHERE 1=1';
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND data_solicitado >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND data_solicitado <= $${params.length}`;
    }
    
    const result = await pool.query(query, params);
    res.json({ success: true, deletados: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao limpar entregas:', err);
    res.status(500).json({ error: 'Erro ao limpar entregas' });
  }
});

// ============================================
// ROTAS TO-DO - GRUPOS
// ============================================

// Listar grupos (filtrado por permissão)
app.get('/api/todo/grupos', async (req, res) => {
  try {
    const { user_cod, role } = req.query;
    
    let query = `
      SELECT * FROM todo_grupos 
      WHERE ativo = TRUE
    `;
    
    if (role !== 'admin_master') {
      query += ` AND (
        tipo = 'compartilhado' 
        OR criado_por = '${user_cod}'
        OR visivel_para @> '"${user_cod}"'
      )`;
    }
    
    query += ' ORDER BY ordem, nome';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar grupos:', err);
    res.status(500).json({ error: 'Erro ao listar grupos' });
  }
});

// Criar grupo
app.post('/api/todo/grupos', async (req, res) => {
  try {
    const { nome, descricao, icone, cor, tipo, criado_por, criado_por_nome, visivel_para } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_grupos (nome, descricao, icone, cor, tipo, criado_por, criado_por_nome, visivel_para)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [nome, descricao, icone || '📋', cor || '#7c3aed', tipo || 'compartilhado', criado_por, criado_por_nome, JSON.stringify(visivel_para || [])]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar grupo:', err);
    res.status(500).json({ error: 'Erro ao criar grupo' });
  }
});

// Atualizar grupo
app.put('/api/todo/grupos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, icone, cor, visivel_para } = req.body;
    
    const result = await pool.query(`
      UPDATE todo_grupos 
      SET nome = COALESCE($1, nome),
          descricao = COALESCE($2, descricao),
          icone = COALESCE($3, icone),
          cor = COALESCE($4, cor),
          visivel_para = COALESCE($5, visivel_para),
          updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [nome, descricao, icone, cor, JSON.stringify(visivel_para), id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar grupo:', err);
    res.status(500).json({ error: 'Erro ao atualizar grupo' });
  }
});

// Excluir grupo (soft delete)
app.delete('/api/todo/grupos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE todo_grupos SET ativo = FALSE WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir grupo:', err);
    res.status(500).json({ error: 'Erro ao excluir grupo' });
  }
});

// ============================================
// ROTAS TO-DO - TAREFAS
// ============================================

// Listar tarefas (com filtros)
app.get('/api/todo/tarefas', async (req, res) => {
  try {
    const { user_cod, role, grupo_id, status, responsavel, coluna_kanban } = req.query;
    
    let query = `
      SELECT t.*, g.nome as grupo_nome, g.icone as grupo_icone, g.cor as grupo_cor,
             (SELECT COUNT(*) FROM todo_anexos WHERE tarefa_id = t.id) as qtd_anexos,
             (SELECT COUNT(*) FROM todo_comentarios WHERE tarefa_id = t.id) as qtd_comentarios,
             (SELECT COUNT(*) FROM todo_subtarefas WHERE tarefa_id = t.id) as qtd_subtarefas,
             (SELECT COUNT(*) FROM todo_subtarefas WHERE tarefa_id = t.id AND concluida = true) as qtd_subtarefas_concluidas,
             (SELECT COUNT(*) FROM todo_dependencias WHERE tarefa_id = t.id) as qtd_dependencias
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    // Se um grupo específico for selecionado, mostra TODAS as tarefas desse grupo
    if (grupo_id) {
      query += ` AND t.grupo_id = $${paramIndex}`;
      params.push(grupo_id);
      paramIndex++;
      // Não aplica filtro de usuário quando visualizando um grupo específico
    } else {
      // Se não for admin_master e não tiver grupo específico, filtra por permissões
      if (role !== 'admin_master') {
        query += ` AND (
          t.tipo = 'compartilhado' 
          OR t.criado_por = '${user_cod}'
          OR t.responsaveis @> '[{"user_cod":"${user_cod}"}]'
          OR t.responsaveis::text LIKE '%${user_cod}%'
        )`;
      }
    }
    
    if (status && status !== 'todas') {
      query += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    if (coluna_kanban) {
      query += ` AND t.coluna_kanban = $${paramIndex}`;
      params.push(coluna_kanban);
      paramIndex++;
    }
    
    if (responsavel) {
      query += ` AND t.responsaveis @> $${paramIndex}::jsonb`;
      params.push(JSON.stringify([{ user_cod: responsavel }]));
      paramIndex++;
    }
    
    query += ' ORDER BY t.ordem ASC, CASE t.prioridade WHEN \'urgente\' THEN 1 WHEN \'alta\' THEN 2 WHEN \'media\' THEN 3 ELSE 4 END, t.data_prazo ASC NULLS LAST, t.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar tarefas:', err);
    res.status(500).json({ error: 'Erro ao listar tarefas' });
  }
});

// Buscar tarefa específica com detalhes
app.get('/api/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const tarefa = await pool.query(`
      SELECT t.*, g.nome as grupo_nome, g.icone as grupo_icone, g.cor as grupo_cor
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE t.id = $1
    `, [id]);
    
    const anexos = await pool.query('SELECT * FROM todo_anexos WHERE tarefa_id = $1 ORDER BY created_at DESC', [id]);
    const comentarios = await pool.query('SELECT * FROM todo_comentarios WHERE tarefa_id = $1 ORDER BY created_at DESC', [id]);
    const historico = await pool.query('SELECT * FROM todo_historico WHERE tarefa_id = $1 ORDER BY created_at DESC LIMIT 20', [id]);
    
    res.json({
      ...tarefa.rows[0],
      anexos: anexos.rows,
      comentarios: comentarios.rows,
      historico: historico.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar tarefa:', err);
    res.status(500).json({ error: 'Erro ao buscar tarefa' });
  }
});

// Função para calcular próxima data de recorrência
function calcularProximaRecorrencia(dataBase, tipoRecorrencia, intervalo = 1) {
  const data = new Date(dataBase);
  data.setHours(0, 0, 0, 0);
  
  switch (tipoRecorrencia) {
    case 'diaria':
    case 'diario':
      data.setDate(data.getDate() + intervalo);
      break;
    case 'semanal':
      data.setDate(data.getDate() + (7 * intervalo));
      break;
    case 'mensal':
      data.setMonth(data.getMonth() + intervalo);
      break;
    case 'personalizado':
      data.setDate(data.getDate() + intervalo);
      break;
    default:
      data.setDate(data.getDate() + 1);
  }
  
  return data;
}

// Endpoint para processar tarefas recorrentes (chamado por cron ou manualmente)
app.post('/api/todo/processar-recorrencias', async (req, res) => {
  try {
    const agora = new Date();
    
    // Buscar tarefas recorrentes concluídas que precisam ser reabertas
    const tarefasRecorrentes = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrente = true 
      AND status = 'concluida'
      AND proxima_recorrencia IS NOT NULL 
      AND proxima_recorrencia <= $1
    `, [agora]);
    
    let reabertas = 0;
    
    for (const tarefa of tarefasRecorrentes.rows) {
      // Calcular próxima recorrência
      const proximaData = calcularProximaRecorrencia(
        new Date(), 
        tarefa.tipo_recorrencia, 
        tarefa.intervalo_recorrencia || 1
      );
      
      // Reabrir a tarefa
      await pool.query(`
        UPDATE todo_tarefas 
        SET status = 'pendente',
            data_conclusao = NULL,
            concluido_por = NULL,
            concluido_por_nome = NULL,
            proxima_recorrencia = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [proximaData, tarefa.id]);
      
      // Registrar no histórico
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')
      `, [tarefa.id]);
      
      reabertas++;
    }
    
    console.log(`✅ Processamento de recorrências: ${reabertas} tarefa(s) reaberta(s)`);
    res.json({ success: true, reabertas });
  } catch (err) {
    console.error('❌ Erro ao processar recorrências:', err);
    res.status(500).json({ error: 'Erro ao processar recorrências' });
  }
});

// Criar tarefa
app.post('/api/todo/tarefas', async (req, res) => {
  try {
    const { 
      grupo_id, titulo, descricao, prioridade, data_prazo, 
      recorrente, tipo_recorrencia, intervalo_recorrencia, tipo, 
      criado_por, criado_por_nome, criado_por_foto, responsaveis 
    } = req.body;
    
    // Calcular próxima recorrência se for recorrente
    let proxima_recorrencia = null;
    if (recorrente && tipo_recorrencia) {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      proxima_recorrencia = calcularProximaRecorrencia(hoje, tipo_recorrencia, intervalo_recorrencia || 1);
    }
    
    const result = await pool.query(`
      INSERT INTO todo_tarefas (
        grupo_id, titulo, descricao, prioridade, data_prazo,
        recorrente, tipo_recorrencia, intervalo_recorrencia, proxima_recorrencia, tipo,
        criado_por, criado_por_nome, criado_por_foto, responsaveis
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      grupo_id, titulo, descricao, prioridade || 'media', data_prazo,
      recorrente || false, tipo_recorrencia, intervalo_recorrencia || 1, proxima_recorrencia, tipo || 'compartilhado',
      criado_por, criado_por_nome, criado_por_foto || null, JSON.stringify(responsaveis || [])
    ]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'criada', 'Tarefa criada', $2, $3)
    `, [result.rows[0].id, criado_por, criado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar tarefa:', err);
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// Atualizar tarefa
app.put('/api/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      titulo, descricao, status, prioridade, data_prazo,
      recorrente, tipo_recorrencia, intervalo_recorrencia, responsaveis,
      user_cod, user_name
    } = req.body;
    
    const anterior = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    const tarefaAnterior = anterior.rows[0];
    
    let concluido_por = null;
    let concluido_por_nome = null;
    let data_conclusao = null;
    let proxima_recorrencia = tarefaAnterior?.proxima_recorrencia;
    
    // Se está sendo concluída
    if (status === 'concluida' && tarefaAnterior?.status !== 'concluida') {
      concluido_por = user_cod;
      concluido_por_nome = user_name;
      data_conclusao = new Date();
      
      // Se é recorrente, calcular próxima data
      if (tarefaAnterior?.recorrente) {
        proxima_recorrencia = calcularProximaRecorrencia(
          new Date(), 
          tarefaAnterior.tipo_recorrencia, 
          tarefaAnterior.intervalo_recorrencia || 1
        );
      }
    }
    
    const result = await pool.query(`
      UPDATE todo_tarefas 
      SET titulo = COALESCE($1, titulo),
          descricao = COALESCE($2, descricao),
          status = COALESCE($3, status),
          prioridade = COALESCE($4, prioridade),
          data_prazo = COALESCE($5, data_prazo),
          recorrente = COALESCE($6, recorrente),
          tipo_recorrencia = COALESCE($7, tipo_recorrencia),
          intervalo_recorrencia = COALESCE($8, intervalo_recorrencia),
          responsaveis = COALESCE($9, responsaveis),
          concluido_por = COALESCE($10, concluido_por),
          concluido_por_nome = COALESCE($11, concluido_por_nome),
          data_conclusao = COALESCE($12, data_conclusao),
          proxima_recorrencia = $13,
          updated_at = NOW()
      WHERE id = $14
      RETURNING *
    `, [
      titulo, descricao, status, prioridade, data_prazo,
      recorrente, tipo_recorrencia, intervalo_recorrencia,
      responsaveis ? JSON.stringify(responsaveis) : null,
      concluido_por, concluido_por_nome, data_conclusao, proxima_recorrencia, id
    ]);
    
    let acaoDesc = 'Tarefa atualizada';
    if (status && status !== anterior.rows[0]?.status) {
      acaoDesc = `Status alterado: ${anterior.rows[0]?.status || 'pendente'} → ${status}`;
    }
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name, dados_anteriores, dados_novos)
      VALUES ($1, 'atualizada', $2, $3, $4, $5, $6)
    `, [id, acaoDesc, user_cod, user_name, JSON.stringify(anterior.rows[0]), JSON.stringify(result.rows[0])]);
    
    // Se tarefa recorrente foi concluída, criar próxima
    if (status === 'concluida' && result.rows[0].recorrente && result.rows[0].tipo_recorrencia) {
      const tarefa = result.rows[0];
      let proximoPrazo = new Date();
      proximoPrazo.setHours(0, 0, 0, 0); // Começa à meia-noite
      
      const intervalo = tarefa.intervalo_recorrencia || 1;
      
      switch (tarefa.tipo_recorrencia) {
        case 'diario':
          proximoPrazo.setDate(proximoPrazo.getDate() + 1); // Próximo dia às 00:00
          break;
        case 'semanal':
          proximoPrazo.setDate(proximoPrazo.getDate() + (7 * intervalo));
          break;
        case 'mensal':
          proximoPrazo.setMonth(proximoPrazo.getMonth() + intervalo);
          break;
        case 'personalizado':
          proximoPrazo.setDate(proximoPrazo.getDate() + intervalo);
          break;
      }
      
      await pool.query(`
        INSERT INTO todo_tarefas (
          grupo_id, titulo, descricao, prioridade, data_prazo,
          recorrente, tipo_recorrencia, intervalo_recorrencia, tipo,
          criado_por, criado_por_nome, criado_por_foto, responsaveis
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        tarefa.grupo_id, tarefa.titulo, tarefa.descricao, tarefa.prioridade, proximoPrazo,
        true, tarefa.tipo_recorrencia, intervalo, tarefa.tipo,
        tarefa.criado_por, tarefa.criado_por_nome, tarefa.criado_por_foto, tarefa.responsaveis
      ]);
      console.log('✅ Tarefa recorrente criada para:', proximoPrazo);
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar tarefa:', err);
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

// Excluir tarefa
app.delete('/api/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_tarefas WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir tarefa:', err);
    res.status(500).json({ error: 'Erro ao excluir tarefa' });
  }
});

// ============================================
// ROTAS TO-DO - COMENTÁRIOS
// ============================================

app.post('/api/todo/tarefas/:id/comentarios', async (req, res) => {
  try {
    const { id } = req.params;
    const { texto, user_cod, user_name } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_comentarios (tarefa_id, texto, user_cod, user_name)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, texto, user_cod, user_name]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'comentario', 'Comentário adicionado', $2, $3)
    `, [id, user_cod, user_name]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar comentário:', err);
    res.status(500).json({ error: 'Erro ao adicionar comentário' });
  }
});

// ============================================
// ROTAS TO-DO - ANEXOS
// ============================================

app.post('/api/todo/tarefas/:id/anexos', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_anexos (tarefa_id, nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [id, nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'anexo', $2, $3, $4)
    `, [id, `Anexo adicionado: ${nome_arquivo}`, enviado_por, enviado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar anexo:', err);
    res.status(500).json({ error: 'Erro ao adicionar anexo' });
  }
});

app.delete('/api/todo/anexos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_anexos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir anexo:', err);
    res.status(500).json({ error: 'Erro ao excluir anexo' });
  }
});

// ============================================
// ROTAS TO-DO - MÉTRICAS (Admin Master)
// ============================================

app.get('/api/todo/metricas', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    const dias = parseInt(periodo);
    
    const statusResult = await pool.query(`
      SELECT status, COUNT(*) as total
      FROM todo_tarefas
      WHERE created_at >= NOW() - INTERVAL '${dias} days'
      GROUP BY status
    `);
    
    const conclusaoResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'concluida' AND (data_conclusao <= data_prazo OR data_prazo IS NULL)) as no_prazo,
        COUNT(*) FILTER (WHERE status = 'concluida' AND data_conclusao > data_prazo) as fora_prazo,
        COUNT(*) FILTER (WHERE status = 'concluida') as total_concluidas,
        COUNT(*) FILTER (WHERE status != 'concluida' AND data_prazo < NOW()) as atrasadas,
        COUNT(*) as total
      FROM todo_tarefas
      WHERE created_at >= NOW() - INTERVAL '${dias} days'
    `);
    
    const porResponsavelResult = await pool.query(`
      SELECT 
        concluido_por as user_cod,
        concluido_por_nome as user_name,
        COUNT(*) as total_concluidas,
        COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL) as no_prazo,
        COUNT(*) FILTER (WHERE data_conclusao > data_prazo) as fora_prazo,
        AVG(EXTRACT(EPOCH FROM (data_conclusao - created_at)) / 3600) as tempo_medio_horas
      FROM todo_tarefas
      WHERE status = 'concluida' 
        AND concluido_por IS NOT NULL
        AND data_conclusao >= NOW() - INTERVAL '${dias} days'
      GROUP BY concluido_por, concluido_por_nome
      ORDER BY total_concluidas DESC
    `);
    
    const porGrupoResult = await pool.query(`
      SELECT 
        g.id,
        g.nome,
        g.icone,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE t.status = 'concluida') as concluidas,
        COUNT(*) FILTER (WHERE t.status = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE t.status = 'em_andamento') as em_andamento
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE t.created_at >= NOW() - INTERVAL '${dias} days'
      GROUP BY g.id, g.nome, g.icone
      ORDER BY total DESC
    `);
    
    const conclusao = conclusaoResult.rows[0];
    const taxaNoPrazo = conclusao.total_concluidas > 0 
      ? ((conclusao.no_prazo / conclusao.total_concluidas) * 100).toFixed(1) 
      : 0;
    
    res.json({
      totais: {
        total: parseInt(conclusao.total),
        concluidas: parseInt(conclusao.total_concluidas),
        atrasadas: parseInt(conclusao.atrasadas),
        no_prazo: parseInt(conclusao.no_prazo),
        vencidas: parseInt(conclusao.atrasadas),
        taxaNoPrazo: parseFloat(taxaNoPrazo)
      },
      porStatus: statusResult.rows,
      porResponsavel: porResponsavelResult.rows,
      porGrupo: porGrupoResult.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar métricas:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

app.get('/api/todo/metricas/ranking', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    const result = await pool.query(`
      SELECT 
        concluido_por as user_cod,
        concluido_por_nome as user_name,
        COUNT(*) as total_concluidas,
        COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL) as no_prazo,
        ROUND(
          (COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL)::DECIMAL / 
           NULLIF(COUNT(*), 0) * 100), 1
        ) as taxa_prazo,
        ROUND(AVG(EXTRACT(EPOCH FROM (data_conclusao - created_at)) / 3600)::DECIMAL, 1) as tempo_medio_horas
      FROM todo_tarefas
      WHERE status = 'concluida' 
        AND concluido_por IS NOT NULL
        AND data_conclusao >= NOW() - INTERVAL '${periodo} days'
      GROUP BY concluido_por, concluido_por_nome
      HAVING COUNT(*) >= 1
      ORDER BY taxa_prazo DESC, total_concluidas DESC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// Listar admins para o TO-DO
app.get('/api/todo/admins', async (req, res) => {
  try {
    // Retorna apenas ADMINS e ADMIN_MASTER com foto do perfil social
    const result = await pool.query(`
      SELECT 
        u.cod_profissional as cod, 
        u.full_name as nome,
        u.role,
        sp.profile_photo as foto
      FROM users u
      LEFT JOIN social_profiles sp ON u.cod_profissional = sp.user_cod
      WHERE u.role IN ('admin', 'admin_master')
      ORDER BY u.full_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar admins para TODO:', err);
    res.json([]);
  }
});

// ============================================
// ROTAS TO-DO - SUBTAREFAS/CHECKLIST
// ============================================

// Listar subtarefas de uma tarefa
app.get('/api/todo/tarefas/:id/subtarefas', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM todo_subtarefas WHERE tarefa_id = $1 ORDER BY ordem, id',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar subtarefas:', err);
    res.status(500).json({ error: 'Erro ao listar subtarefas' });
  }
});

// Criar subtarefa
app.post('/api/todo/tarefas/:id/subtarefas', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, ordem } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_subtarefas (tarefa_id, titulo, ordem)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [id, titulo, ordem || 0]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar subtarefa:', err);
    res.status(500).json({ error: 'Erro ao criar subtarefa' });
  }
});

// Atualizar subtarefa (toggle concluída)
app.put('/api/todo/subtarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, concluida, user_cod, user_name } = req.body;
    
    const result = await pool.query(`
      UPDATE todo_subtarefas 
      SET titulo = COALESCE($1, titulo),
          concluida = COALESCE($2, concluida),
          concluida_por = CASE WHEN $2 = true THEN $3 ELSE NULL END,
          concluida_por_nome = CASE WHEN $2 = true THEN $4 ELSE NULL END,
          concluida_em = CASE WHEN $2 = true THEN NOW() ELSE NULL END
      WHERE id = $5
      RETURNING *
    `, [titulo, concluida, user_cod, user_name, id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar subtarefa:', err);
    res.status(500).json({ error: 'Erro ao atualizar subtarefa' });
  }
});

// Excluir subtarefa
app.delete('/api/todo/subtarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_subtarefas WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir subtarefa:', err);
    res.status(500).json({ error: 'Erro ao excluir subtarefa' });
  }
});

// Reordenar subtarefas
app.put('/api/todo/tarefas/:id/subtarefas/reordenar', async (req, res) => {
  try {
    const { id } = req.params;
    const { subtarefas } = req.body; // Array de {id, ordem}
    
    for (const sub of subtarefas) {
      await pool.query('UPDATE todo_subtarefas SET ordem = $1 WHERE id = $2', [sub.ordem, sub.id]);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao reordenar subtarefas:', err);
    res.status(500).json({ error: 'Erro ao reordenar subtarefas' });
  }
});

// ============================================
// ROTAS TO-DO - TIME TRACKING
// ============================================

// Iniciar timer
app.post('/api/todo/tarefas/:id/timer/iniciar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name } = req.body;
    
    // Verificar se já tem timer ativo
    const tarefaAtual = await pool.query('SELECT timer_ativo FROM todo_tarefas WHERE id = $1', [id]);
    if (tarefaAtual.rows[0]?.timer_ativo) {
      return res.status(400).json({ error: 'Timer já está ativo para esta tarefa' });
    }
    
    // Parar qualquer outro timer do usuário
    const outrosTimers = await pool.query(
      'SELECT id, timer_inicio FROM todo_tarefas WHERE timer_ativo = true AND timer_user_cod = $1',
      [user_cod]
    );
    
    for (const tarefa of outrosTimers.rows) {
      const duracaoSegundos = Math.floor((Date.now() - new Date(tarefa.timer_inicio).getTime()) / 1000);
      await pool.query(`
        UPDATE todo_tarefas 
        SET timer_ativo = false, 
            timer_inicio = NULL, 
            timer_user_cod = NULL,
            tempo_gasto_segundos = COALESCE(tempo_gasto_segundos, 0) + $1
        WHERE id = $2
      `, [duracaoSegundos, tarefa.id]);
      
      // Registrar no histórico de time tracking
      await pool.query(`
        INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos)
        VALUES ($1, $2, $3, $4, NOW(), $5)
      `, [tarefa.id, user_cod, user_name, tarefa.timer_inicio, duracaoSegundos]);
    }
    
    // Iniciar novo timer
    await pool.query(`
      UPDATE todo_tarefas 
      SET timer_ativo = true, timer_inicio = NOW(), timer_user_cod = $1, status = 'em_andamento'
      WHERE id = $2
    `, [user_cod, id]);
    
    const result = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao iniciar timer:', err);
    res.status(500).json({ error: 'Erro ao iniciar timer' });
  }
});

// Parar timer
app.post('/api/todo/tarefas/:id/timer/parar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name, descricao } = req.body;
    
    const tarefa = await pool.query('SELECT timer_inicio, tempo_gasto_segundos FROM todo_tarefas WHERE id = $1', [id]);
    if (!tarefa.rows[0]?.timer_inicio) {
      return res.status(400).json({ error: 'Nenhum timer ativo para esta tarefa' });
    }
    
    const duracaoSegundos = Math.floor((Date.now() - new Date(tarefa.rows[0].timer_inicio).getTime()) / 1000);
    const tempoTotal = (tarefa.rows[0].tempo_gasto_segundos || 0) + duracaoSegundos;
    
    // Registrar no histórico
    await pool.query(`
      INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos, descricao)
      VALUES ($1, $2, $3, $4, NOW(), $5, $6)
    `, [id, user_cod, user_name, tarefa.rows[0].timer_inicio, duracaoSegundos, descricao]);
    
    // Atualizar tarefa
    await pool.query(`
      UPDATE todo_tarefas 
      SET timer_ativo = false, 
          timer_inicio = NULL, 
          timer_user_cod = NULL,
          tempo_gasto_segundos = $1
      WHERE id = $2
    `, [tempoTotal, id]);
    
    const result = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao parar timer:', err);
    res.status(500).json({ error: 'Erro ao parar timer' });
  }
});

// Histórico de tempo de uma tarefa
app.get('/api/todo/tarefas/:id/time-tracking', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM todo_time_tracking WHERE tarefa_id = $1 ORDER BY inicio DESC',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico de tempo:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// Adicionar tempo manual
app.post('/api/todo/tarefas/:id/time-tracking', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name, duracao_minutos, descricao, data } = req.body;
    
    const duracaoSegundos = duracao_minutos * 60;
    const dataRegistro = data ? new Date(data) : new Date();
    
    // Inserir registro
    await pool.query(`
      INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos, descricao)
      VALUES ($1, $2, $3, $4, $4, $5, $6)
    `, [id, user_cod, user_name, dataRegistro, duracaoSegundos, descricao]);
    
    // Atualizar tempo total da tarefa
    await pool.query(`
      UPDATE todo_tarefas 
      SET tempo_gasto_segundos = COALESCE(tempo_gasto_segundos, 0) + $1
      WHERE id = $2
    `, [duracaoSegundos, id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao adicionar tempo:', err);
    res.status(500).json({ error: 'Erro ao adicionar tempo' });
  }
});

// ============================================
// ROTAS TO-DO - KANBAN
// ============================================

// Atualizar coluna kanban de uma tarefa
app.put('/api/todo/tarefas/:id/kanban', async (req, res) => {
  try {
    const { id } = req.params;
    const { coluna_kanban, ordem, user_cod, user_name } = req.body;
    
    console.log('🔄 Movendo tarefa no kanban:', { id, coluna_kanban, user_cod });
    
    if (!coluna_kanban) {
      return res.status(400).json({ error: 'coluna_kanban é obrigatório' });
    }
    
    // Verificar se a tarefa existe
    const tarefaCheck = await pool.query('SELECT id FROM todo_tarefas WHERE id = $1', [id]);
    if (tarefaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }
    
    // Mapear coluna para status
    let status = 'pendente';
    if (coluna_kanban === 'doing') status = 'em_andamento';
    else if (coluna_kanban === 'done') status = 'concluida';
    
    // Atualizar tarefa
    const updateQuery = status === 'concluida' 
      ? `UPDATE todo_tarefas 
         SET coluna_kanban = $1, 
             status = $2, 
             concluido_por = $3,
             concluido_por_nome = $4,
             data_conclusao = NOW(),
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`
      : `UPDATE todo_tarefas 
         SET coluna_kanban = $1, 
             status = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`;
    
    const params = status === 'concluida' 
      ? [coluna_kanban, status, user_cod, user_name, id]
      : [coluna_kanban, status, id];
    
    const result = await pool.query(updateQuery, params);
    
    // Registrar no histórico (ignorar erro se tabela não existir)
    try {
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'movida', $2, $3, $4)
      `, [id, `Movida para ${coluna_kanban}`, user_cod || 'sistema', user_name || 'Sistema']);
    } catch (histErr) {
      console.log('⚠️ Histórico não registrado:', histErr.message);
    }
    
    console.log('✅ Tarefa movida com sucesso:', result.rows[0]?.id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao mover tarefa no kanban:', err);
    res.status(500).json({ error: 'Erro ao mover tarefa', details: err.message });
  }
});

// Reordenar tarefas dentro de uma coluna
app.put('/api/todo/kanban/reordenar', async (req, res) => {
  try {
    const { tarefas } = req.body; // Array de {id, ordem, coluna_kanban}
    
    for (const tarefa of tarefas) {
      await pool.query(
        'UPDATE todo_tarefas SET ordem = $1, coluna_kanban = $2 WHERE id = $3',
        [tarefa.ordem, tarefa.coluna_kanban, tarefa.id]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao reordenar kanban:', err);
    res.status(500).json({ error: 'Erro ao reordenar' });
  }
});

// ============================================
// ROTAS TO-DO - DEPENDÊNCIAS
// ============================================

// Listar dependências de uma tarefa
app.get('/api/todo/tarefas/:id/dependencias', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Tarefas das quais esta depende
    const dependeDe = await pool.query(`
      SELECT d.*, t.titulo, t.status 
      FROM todo_dependencias d
      JOIN todo_tarefas t ON d.depende_de = t.id
      WHERE d.tarefa_id = $1
    `, [id]);
    
    // Tarefas que dependem desta
    const dependentes = await pool.query(`
      SELECT d.*, t.titulo, t.status 
      FROM todo_dependencias d
      JOIN todo_tarefas t ON d.tarefa_id = t.id
      WHERE d.depende_de = $1
    `, [id]);
    
    res.json({
      depende_de: dependeDe.rows,
      dependentes: dependentes.rows
    });
  } catch (err) {
    console.error('❌ Erro ao listar dependências:', err);
    res.status(500).json({ error: 'Erro ao listar dependências' });
  }
});

// Adicionar dependência
app.post('/api/todo/tarefas/:id/dependencias', async (req, res) => {
  try {
    const { id } = req.params;
    const { depende_de, tipo } = req.body;
    
    // Verificar se não cria dependência circular
    const circular = await pool.query(`
      WITH RECURSIVE dep_chain AS (
        SELECT tarefa_id, depende_de FROM todo_dependencias WHERE tarefa_id = $1
        UNION
        SELECT d.tarefa_id, d.depende_de 
        FROM todo_dependencias d
        JOIN dep_chain c ON d.tarefa_id = c.depende_de
      )
      SELECT * FROM dep_chain WHERE depende_de = $2
    `, [depende_de, id]);
    
    if (circular.rows.length > 0) {
      return res.status(400).json({ error: 'Dependência circular detectada!' });
    }
    
    const result = await pool.query(`
      INSERT INTO todo_dependencias (tarefa_id, depende_de, tipo)
      VALUES ($1, $2, $3)
      ON CONFLICT (tarefa_id, depende_de) DO NOTHING
      RETURNING *
    `, [id, depende_de, tipo || 'finish_to_start']);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar dependência:', err);
    res.status(500).json({ error: 'Erro ao adicionar dependência' });
  }
});

// Remover dependência
app.delete('/api/todo/dependencias/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_dependencias WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover dependência:', err);
    res.status(500).json({ error: 'Erro ao remover dependência' });
  }
});

// ============================================
// ROTAS TO-DO - TEMPLATES
// ============================================

// Listar templates
app.get('/api/todo/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM todo_templates WHERE ativo = true ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar templates:', err);
    res.json([]);
  }
});

// Criar template
app.post('/api/todo/templates', async (req, res) => {
  try {
    const { grupo_id, nome, titulo_tarefa, descricao, prioridade, checklist, tempo_estimado_minutos, criado_por, criado_por_nome } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_templates (grupo_id, nome, titulo_tarefa, descricao, prioridade, checklist, tempo_estimado_minutos, criado_por, criado_por_nome)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [grupo_id, nome, titulo_tarefa, descricao, prioridade, JSON.stringify(checklist || []), tempo_estimado_minutos, criado_por, criado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar template:', err);
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// Criar tarefa a partir de template
app.post('/api/todo/templates/:id/criar-tarefa', async (req, res) => {
  try {
    const { id } = req.params;
    const { grupo_id, data_prazo, responsaveis, criado_por, criado_por_nome } = req.body;
    
    const template = await pool.query('SELECT * FROM todo_templates WHERE id = $1', [id]);
    if (template.rows.length === 0) {
      return res.status(404).json({ error: 'Template não encontrado' });
    }
    
    const t = template.rows[0];
    
    // Criar tarefa
    const tarefa = await pool.query(`
      INSERT INTO todo_tarefas (
        grupo_id, titulo, descricao, prioridade, data_prazo,
        tempo_estimado_minutos, template_id, tipo,
        criado_por, criado_por_nome, responsaveis
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'compartilhado', $8, $9, $10)
      RETURNING *
    `, [
      grupo_id || t.grupo_id, t.titulo_tarefa, t.descricao, t.prioridade, data_prazo,
      t.tempo_estimado_minutos, id,
      criado_por, criado_por_nome, JSON.stringify(responsaveis || [])
    ]);
    
    // Criar subtarefas do checklist
    const checklist = t.checklist || [];
    for (let i = 0; i < checklist.length; i++) {
      await pool.query(`
        INSERT INTO todo_subtarefas (tarefa_id, titulo, ordem)
        VALUES ($1, $2, $3)
      `, [tarefa.rows[0].id, checklist[i], i]);
    }
    
    res.json(tarefa.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar tarefa do template:', err);
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// ============================================
// ROTAS TO-DO - RELATÓRIO DE TEMPO
// ============================================

app.get('/api/todo/relatorio-tempo', async (req, res) => {
  try {
    const { periodo = '30', user_cod } = req.query;
    const dias = parseInt(periodo);
    
    let query = `
      SELECT 
        t.id as tarefa_id,
        t.titulo,
        t.tempo_estimado_minutos,
        t.tempo_gasto_segundos,
        g.nome as grupo_nome,
        COALESCE(SUM(tt.duracao_segundos), 0) as tempo_registrado
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      LEFT JOIN todo_time_tracking tt ON t.id = tt.tarefa_id
      WHERE t.created_at >= NOW() - INTERVAL '${dias} days'
    `;
    
    const params = [];
    if (user_cod) {
      query += ` AND tt.user_cod = $1`;
      params.push(user_cod);
    }
    
    query += ` GROUP BY t.id, t.titulo, t.tempo_estimado_minutos, t.tempo_gasto_segundos, g.nome ORDER BY tempo_registrado DESC`;
    
    const result = await pool.query(query, params);
    
    // Calcular totais
    const totais = result.rows.reduce((acc, row) => ({
      tempo_estimado: acc.tempo_estimado + (row.tempo_estimado_minutos || 0) * 60,
      tempo_gasto: acc.tempo_gasto + (row.tempo_gasto_segundos || 0),
      tempo_registrado: acc.tempo_registrado + parseInt(row.tempo_registrado || 0)
    }), { tempo_estimado: 0, tempo_gasto: 0, tempo_registrado: 0 });
    
    res.json({
      tarefas: result.rows,
      totais
    });
  } catch (err) {
    console.error('❌ Erro ao gerar relatório de tempo:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

// ==================== ROTAS DO MÓDULO SOCIAL ====================

// Obter perfil social do usuário
app.get('/api/social/profile/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM social_profiles WHERE user_cod = $1',
      [userCod]
    );
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.json(null);
    }
  } catch (err) {
    console.error('Erro ao buscar perfil social:', err);
    res.status(500).json({ error: err.message });
  }
});

// Criar ou atualizar perfil social
app.put('/api/social/profile/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const { display_name, profile_photo } = req.body;
    
    const result = await pool.query(`
      INSERT INTO social_profiles (user_cod, display_name, profile_photo, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (user_cod) 
      DO UPDATE SET 
        display_name = COALESCE($2, social_profiles.display_name),
        profile_photo = COALESCE($3, social_profiles.profile_photo),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [userCod, display_name, profile_photo]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao salvar perfil social:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar status online
app.post('/api/social/status', async (req, res) => {
  try {
    const { user_cod, is_online } = req.body;
    
    await pool.query(`
      INSERT INTO social_status (user_cod, is_online, last_seen)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (user_cod) 
      DO UPDATE SET 
        is_online = $2,
        last_seen = CURRENT_TIMESTAMP
    `, [user_cod, is_online]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao atualizar status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Listar todos os usuários com status e perfil social
app.get('/api/social/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.cod_profissional,
        u.full_name,
        u.role,
        COALESCE(sp.display_name, u.full_name) as display_name,
        sp.profile_photo,
        COALESCE(ss.is_online, false) as is_online,
        ss.last_seen
      FROM users u
      LEFT JOIN social_profiles sp ON u.cod_profissional = sp.user_cod
      LEFT JOIN social_status ss ON u.cod_profissional = ss.user_cod
      WHERE u.role IN ('user', 'admin', 'admin_financeiro', 'admin_master')
      ORDER BY ss.is_online DESC NULLS LAST, COALESCE(sp.display_name, u.full_name) ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar usuários:', err);
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem ou reação
app.post('/api/social/messages', async (req, res) => {
  try {
    const { from_user_cod, from_user_name, to_user_cod, message_type, content } = req.body;
    
    const result = await pool.query(`
      INSERT INTO social_messages (from_user_cod, from_user_name, to_user_cod, message_type, content)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [from_user_cod, from_user_name, to_user_cod, message_type, content]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).json({ error: err.message });
  }
});

// Buscar mensagens recebidas por um usuário
app.get('/api/social/messages/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(`
      SELECT * FROM social_messages 
      WHERE to_user_cod = $1 
      ORDER BY created_at DESC 
      LIMIT 50
    `, [userCod]);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar mensagens:', err);
    res.status(500).json({ error: err.message });
  }
});

// Marcar mensagens como lidas
app.patch('/api/social/messages/read', async (req, res) => {
  try {
    const { user_cod } = req.body;
    await pool.query(
      'UPDATE social_messages SET is_read = true WHERE to_user_cod = $1 AND is_read = false',
      [user_cod]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao marcar como lido:', err);
    res.status(500).json({ error: err.message });
  }
});

// Contar mensagens não lidas
app.get('/api/social/messages/unread/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM social_messages WHERE to_user_cod = $1 AND is_read = false',
      [userCod]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Erro ao contar não lidas:', err);
    res.json({ count: 0 });
  }
});

// ==================== FIM ROTAS MÓDULO SOCIAL ====================

// ==================== ROTAS DO MÓDULO AVISOS OPERACIONAL ====================

// Listar todas as regiões (cidades) da planilha
app.get('/api/avisos-op/regioes', async (req, res) => {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1); // pular header
    
    const regioes = new Set();
    lines.forEach(line => {
      const cols = line.split(',');
      const cidade = cols[3]?.trim(); // coluna Cidade
      if (cidade && cidade.length > 0 && cidade !== '') {
        regioes.add(cidade);
      }
    });
    
    res.json([...regioes].sort());
  } catch (err) {
    console.error('❌ Erro ao buscar regiões:', err);
    res.json([]);
  }
});

// Listar todos os avisos (para admin)
app.get('/api/avisos-op', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, 
        (SELECT COUNT(*) FROM avisos_visualizacoes WHERE aviso_id = a.id) as total_visualizacoes
      FROM avisos a 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar avisos:', err);
    res.json([]);
  }
});

// Criar novo aviso
app.post('/api/avisos-op', async (req, res) => {
  try {
    const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by } = req.body;
    
    const result = await pool.query(`
      INSERT INTO avisos (titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [titulo, regioes || [], todas_regioes || false, data_inicio, data_fim, recorrencia_tipo || 'uma_vez', recorrencia_intervalo || 0, imagem_url, created_by]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar aviso:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar aviso
app.put('/api/avisos-op/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE avisos 
      SET titulo = $1, regioes = $2, todas_regioes = $3, data_inicio = $4, data_fim = $5, 
          recorrencia_tipo = $6, recorrencia_intervalo = $7, imagem_url = $8, ativo = $9, updated_at = NOW()
      WHERE id = $10
      RETURNING *
    `, [titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo, id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar aviso:', err);
    res.status(500).json({ error: err.message });
  }
});

// Deletar aviso
app.delete('/api/avisos-op/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM avisos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao deletar aviso:', err);
    res.status(500).json({ error: err.message });
  }
});

// Buscar avisos para um usuário específico (baseado na região)
app.get('/api/avisos-op/usuario/:cod', async (req, res) => {
  try {
    const { cod } = req.params;
    
    // Buscar região do usuário na planilha
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1);
    
    let userRegiao = null;
    for (const line of lines) {
      const cols = line.split(',');
      if (cols[0]?.trim() === cod) {
        userRegiao = cols[3]?.trim(); // coluna Cidade
        break;
      }
    }
    
    const now = new Date();
    
    // Buscar avisos ativos para a região do usuário
    const result = await pool.query(`
      SELECT a.* FROM avisos a
      WHERE a.ativo = true
        AND a.data_inicio <= $1
        AND a.data_fim >= $1
        AND (a.todas_regioes = true OR $2 = ANY(a.regioes) OR $2 IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM avisos_visualizacoes av 
          WHERE av.aviso_id = a.id AND av.user_cod = $3
          AND (
            a.recorrencia_tipo = 'uma_vez'
            OR (a.recorrencia_tipo = 'diario' AND av.visualizado_em > NOW() - INTERVAL '1 day')
            OR (a.recorrencia_tipo = 'intervalo_horas' AND av.visualizado_em > NOW() - (a.recorrencia_intervalo || ' hours')::INTERVAL)
          )
        )
      ORDER BY a.created_at DESC
      LIMIT 1
    `, [now, userRegiao, cod]);
    
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('❌ Erro ao buscar avisos do usuário:', err);
    res.json(null);
  }
});

// Marcar aviso como visualizado
app.post('/api/avisos-op/:id/visualizar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod } = req.body;
    
    await pool.query(`
      INSERT INTO avisos_visualizacoes (aviso_id, user_cod, visualizado_em)
      VALUES ($1, $2, NOW())
      ON CONFLICT (aviso_id, user_cod) DO UPDATE SET visualizado_em = NOW()
    `, [id, user_cod]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao marcar visualização:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FIM ROTAS MÓDULO AVISOS ====================

// Função para processar recorrências
async function processarRecorrenciasInterno() {
  try {
    const agora = new Date();
    
    const tarefasRecorrentes = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrente = true 
      AND status = 'concluida'
      AND proxima_recorrencia IS NOT NULL 
      AND proxima_recorrencia <= $1
    `, [agora]);
    
    let reabertas = 0;
    
    for (const tarefa of tarefasRecorrentes.rows) {
      const proximaData = calcularProximaRecorrencia(
        new Date(), 
        tarefa.tipo_recorrencia, 
        tarefa.intervalo_recorrencia || 1
      );
      
      await pool.query(`
        UPDATE todo_tarefas 
        SET status = 'pendente',
            data_conclusao = NULL,
            concluido_por = NULL,
            concluido_por_nome = NULL,
            proxima_recorrencia = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [proximaData, tarefa.id]);
      
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')
      `, [tarefa.id]);
      
      reabertas++;
    }
    
    if (reabertas > 0) {
      console.log(`🔄 Recorrências: ${reabertas} tarefa(s) reaberta(s)`);
    }
  } catch (err) {
    console.error('❌ Erro ao processar recorrências:', err);
  }
}

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`📡 API: http://localhost:${port}/api/health`);
  
  // Processar recorrências a cada hora (para garantir que tarefas não fiquem presas)
  setInterval(processarRecorrenciasInterno, 60 * 60 * 1000); // 1 hora
  
  // Processar imediatamente ao iniciar
  setTimeout(processarRecorrenciasInterno, 10000); // 10 segundos após iniciar
  console.log('⏰ Processamento de recorrências ativado (a cada 1h)');
});

// ===== REGIÕES =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS bi_regioes (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    clientes JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela bi_regioes já existe ou erro:', err.message));

// Listar regiões
app.get('/api/bi/regioes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_regioes ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar regiões:', err);
    res.json([]);
  }
});

// Criar região - Suporta novo formato com cliente + centro de custo
app.post('/api/bi/regioes', async (req, res) => {
  try {
    const { nome, clientes, itens } = req.body;
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    // Se vier no novo formato (itens), usa ele. Senão, usa o formato antigo (clientes)
    let dadosParaSalvar;
    if (itens && itens.length > 0) {
      // Novo formato: array de {cod_cliente, centro_custo}
      dadosParaSalvar = itens;
    } else if (clientes && clientes.length > 0) {
      // Formato antigo: array de cod_cliente
      // Converte para novo formato (sem centro_custo especificado = todos)
      dadosParaSalvar = clientes.map(c => ({ cod_cliente: c, centro_custo: null }));
    } else {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      INSERT INTO bi_regioes (nome, clientes) 
      VALUES ($1, $2)
      RETURNING *
    `, [nome, JSON.stringify(dadosParaSalvar)]);
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar região:', err);
    res.status(500).json({ error: 'Erro ao salvar região' });
  }
});

// Atualizar região existente
app.put('/api/bi/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, itens } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    if (!itens || itens.length === 0) {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      UPDATE bi_regioes 
      SET nome = $1, clientes = $2
      WHERE id = $3
      RETURNING *
    `, [nome, JSON.stringify(itens), id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// Excluir região
app.delete('/api/bi/regioes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_regioes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir região:', err);
    res.status(500).json({ error: 'Erro ao excluir região' });
  }
});

// Atualizar região existente
app.put('/api/bi/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, clientes, itens } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    // Se vier no novo formato (itens), usa ele. Senão, usa o formato antigo (clientes)
    let dadosParaSalvar;
    if (itens && itens.length > 0) {
      dadosParaSalvar = itens;
    } else if (clientes && clientes.length > 0) {
      dadosParaSalvar = clientes.map(c => ({ cod_cliente: c, centro_custo: null }));
    } else {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      UPDATE bi_regioes 
      SET nome = $1, clientes = $2
      WHERE id = $3
      RETURNING *
    `, [nome, JSON.stringify(dadosParaSalvar), id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// ===== CATEGORIAS (da planilha) =====
app.get('/api/bi/categorias', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT categoria
      FROM bi_entregas
      WHERE categoria IS NOT NULL AND categoria != ''
      ORDER BY categoria
    `);
    res.json(result.rows.map(r => r.categoria));
  } catch (err) {
    console.error('❌ Erro ao listar categorias:', err);
    res.json([]);
  }
});

// ===== DADOS PARA FILTROS INTELIGENTES =====
app.get('/api/bi/dados-filtro', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_cliente, centro_custo, categoria
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar dados de filtro:', err);
    res.json([]);
  }
});

// ============================================
// MÓDULO OPERAÇÕES - Novas Operações
// ============================================

// GET - Listar todas as operações
app.get('/api/operacoes', async (req, res) => {
  try {
    const { status, regiao } = req.query;
    
    let query = `
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND o.status = $${params.length}`;
    }
    
    if (regiao) {
      params.push(regiao);
      query += ` AND o.regiao = $${params.length}`;
    }
    
    query += ` ORDER BY o.criado_em DESC`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar operações:', error);
    res.status(500).json({ error: 'Erro ao listar operações' });
  }
});

// GET - Buscar operação por ID
app.get('/api/operacoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const operacao = await pool.query(`
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE o.id = $1
    `, [id]);
    
    if (operacao.rows.length === 0) {
      return res.status(404).json({ error: 'Operação não encontrada' });
    }
    
    res.json(operacao.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar operação:', error);
    res.status(500).json({ error: 'Erro ao buscar operação' });
  }
});

// POST - Criar nova operação
app.post('/api/operacoes', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      regiao,
      nome_cliente,
      endereco,
      modelo,
      quantidade_motos,
      obrigatoriedade_bau,
      possui_garantido,
      valor_garantido,
      data_inicio,
      observacoes,
      faixas_km,
      criado_por
    } = req.body;
    
    // Inserir operação
    const operacaoResult = await client.query(`
      INSERT INTO operacoes (
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, criado_por
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      regiao, nome_cliente, endereco, modelo, quantidade_motos || 1,
      obrigatoriedade_bau || false, possui_garantido || false, valor_garantido || 0,
      data_inicio, observacoes, criado_por
    ]);
    
    const operacaoId = operacaoResult.rows[0].id;
    
    // Inserir faixas de KM
    if (faixas_km && faixas_km.length > 0) {
      for (const faixa of faixas_km) {
        if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
          await client.query(`
            INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
            VALUES ($1, $2, $3, $4)
          `, [operacaoId, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
        }
      }
    }
    
    await client.query('COMMIT');
    
    // Buscar operação completa
    const operacaoCompleta = await pool.query(`
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE o.id = $1
    `, [operacaoId]);
    
    res.status(201).json(operacaoCompleta.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar operação:', error);
    res.status(500).json({ error: 'Erro ao criar operação' });
  } finally {
    client.release();
  }
});

// PUT - Atualizar operação
app.put('/api/operacoes/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      regiao,
      nome_cliente,
      endereco,
      modelo,
      quantidade_motos,
      obrigatoriedade_bau,
      possui_garantido,
      valor_garantido,
      data_inicio,
      observacoes,
      status,
      faixas_km
    } = req.body;
    
    // Atualizar operação
    await client.query(`
      UPDATE operacoes SET
        regiao = COALESCE($1, regiao),
        nome_cliente = COALESCE($2, nome_cliente),
        endereco = COALESCE($3, endereco),
        modelo = COALESCE($4, modelo),
        quantidade_motos = COALESCE($5, quantidade_motos),
        obrigatoriedade_bau = COALESCE($6, obrigatoriedade_bau),
        possui_garantido = COALESCE($7, possui_garantido),
        valor_garantido = COALESCE($8, valor_garantido),
        data_inicio = COALESCE($9, data_inicio),
        observacoes = COALESCE($10, observacoes),
        status = COALESCE($11, status),
        atualizado_em = NOW()
      WHERE id = $12
    `, [
      regiao, nome_cliente, endereco, modelo, quantidade_motos,
      obrigatoriedade_bau, possui_garantido, valor_garantido,
      data_inicio, observacoes, status, id
    ]);
    
    // Atualizar faixas de KM (deletar antigas e inserir novas)
    if (faixas_km) {
      await client.query('DELETE FROM operacoes_faixas_km WHERE operacao_id = $1', [id]);
      
      for (const faixa of faixas_km) {
        if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
          await client.query(`
            INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
            VALUES ($1, $2, $3, $4)
          `, [id, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
        }
      }
    }
    
    await client.query('COMMIT');
    
    // Buscar operação atualizada
    const operacaoAtualizada = await pool.query(`
      SELECT o.*, 
        (SELECT json_agg(json_build_object(
          'id', f.id,
          'km_inicio', f.km_inicio,
          'km_fim', f.km_fim,
          'valor_motoboy', f.valor_motoboy
        ) ORDER BY f.km_inicio)
        FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
        ) as faixas_km
      FROM operacoes o
      WHERE o.id = $1
    `, [id]);
    
    res.json(operacaoAtualizada.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar operação:', error);
    res.status(500).json({ error: 'Erro ao atualizar operação' });
  } finally {
    client.release();
  }
});

// DELETE - Excluir operação
app.delete('/api/operacoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM operacoes WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Operação não encontrada' });
    }
    
    res.json({ message: 'Operação excluída com sucesso', operacao: result.rows[0] });
  } catch (error) {
    console.error('Erro ao excluir operação:', error);
    res.status(500).json({ error: 'Erro ao excluir operação' });
  }
});

// GET - Listar regiões das operações
app.get('/api/operacoes-regioes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT regiao FROM operacoes WHERE regiao IS NOT NULL ORDER BY regiao
    `);
    res.json(result.rows.map(r => r.regiao));
  } catch (error) {
    console.error('Erro ao listar regiões:', error);
    res.status(500).json({ error: 'Erro ao listar regiões' });
  }
});

// ============================================
// FIM MÓDULO OPERAÇÕES
// ============================================
// ============================================
// NOVOS ENDPOINTS BI - MAPA DE CALOR COM COORDENADAS REAIS
// Adicione isso ao final do seu server.js
// ============================================

// MIGRATION: Adicionar colunas de latitude e longitude na tabela bi_entregas
// Execute isso uma vez para adicionar as colunas
const migrateCoordenadas = async () => {
  try {
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_coords ON bi_entregas(latitude, longitude)`).catch(() => {});
    console.log('✅ Colunas latitude/longitude adicionadas na bi_entregas');
  } catch (err) {
    console.log('Colunas de coordenadas já existem ou erro:', err.message);
  }
};
migrateCoordenadas();

// GET - Mapa de Calor usando COORDENADAS REAIS do banco
app.get('/api/bi/mapa-calor', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria } = req.query;
    
    let whereClause = 'WHERE ponto >= 2'; // REGRA: apenas entregas (ponto >= 2), não conta coleta (ponto 1)
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    
    // BUSCAR PONTOS COM COORDENADAS REAIS DO BANCO (apenas ponto >= 2)
    // Agrupa por coordenadas aproximadas (arredonda para 3 casas decimais ~111m de precisão)
    const pontosQuery = await pool.query(`
      SELECT 
        ROUND(latitude::numeric, 3) as lat_group,
        ROUND(longitude::numeric, 3) as lng_group,
        AVG(latitude) as latitude,
        AVG(longitude) as longitude,
        COALESCE(bairro, 'N/A') as bairro,
        COALESCE(cidade, 'N/A') as cidade,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      AND latitude IS NOT NULL 
      AND longitude IS NOT NULL
      AND latitude != 0 
      AND longitude != 0
      GROUP BY lat_group, lng_group, bairro, cidade
      ORDER BY total_entregas DESC
    `, params);
    
    // Buscar dados agrupados por cidade (para o ranking lateral)
    const cidadesQuery = await pool.query(`
      SELECT 
        COALESCE(cidade, 'Não informado') as cidade,
        COALESCE(estado, 'GO') as estado,
        COUNT(*) as total_entregas,
        COUNT(DISTINCT os) as total_os,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
        COALESCE(SUM(valor), 0) as valor_total,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY cidade, estado
      ORDER BY total_entregas DESC
    `, params);
    
    // Buscar dados agrupados por bairro (top 50)
    const bairrosQuery = await pool.query(`
      SELECT 
        COALESCE(bairro, 'Não informado') as bairro,
        COALESCE(cidade, 'Não informado') as cidade,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo
      FROM bi_entregas
      ${whereClause}
      GROUP BY bairro, cidade
      ORDER BY total_entregas DESC
      LIMIT 50
    `, params);
    
    // Resumo geral
    const resumoQuery = await pool.query(`
      SELECT 
        COUNT(*) as total_entregas,
        COUNT(DISTINCT os) as total_os,
        COUNT(DISTINCT cidade) as total_cidades,
        COUNT(DISTINCT bairro) as total_bairros,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo_geral,
        COUNT(DISTINCT cod_prof) as total_profissionais,
        SUM(CASE WHEN latitude IS NOT NULL AND latitude != 0 THEN 1 ELSE 0 END) as com_coordenadas
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    // Horários de pico (heatmap por hora)
    const horariosQuery = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM data_hora) as hora,
        EXTRACT(DOW FROM data_hora) as dia_semana,
        COUNT(*) as total
      FROM bi_entregas
      ${whereClause}
      AND data_hora IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM data_hora), EXTRACT(DOW FROM data_hora)
      ORDER BY dia_semana, hora
    `, params);
    
    // Converter pontos do banco para o formato do mapa
    const pontos = pontosQuery.rows.map(p => ({
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      bairro: p.bairro,
      cidade: p.cidade,
      count: parseInt(p.total_entregas),
      taxaPrazo: parseFloat(p.taxa_prazo) || 0,
      noPrazo: parseInt(p.no_prazo) || 0,
      foraPrazo: parseInt(p.fora_prazo) || 0,
      totalProfissionais: parseInt(p.total_profissionais) || 0
    })).filter(p => !isNaN(p.lat) && !isNaN(p.lng) && p.lat !== 0 && p.lng !== 0);
    
    console.log(`🗺️ Mapa de calor: ${pontos.length} pontos com coordenadas reais`);
    
    res.json({
      totalEntregas: parseInt(resumoQuery.rows[0]?.total_entregas) || 0,
      totalOS: parseInt(resumoQuery.rows[0]?.total_os) || 0,
      totalPontos: pontos.length,
      totalCidades: parseInt(resumoQuery.rows[0]?.total_cidades) || 0,
      totalBairros: parseInt(resumoQuery.rows[0]?.total_bairros) || 0,
      totalProfissionais: parseInt(resumoQuery.rows[0]?.total_profissionais) || 0,
      taxaPrazoGeral: parseFloat(resumoQuery.rows[0]?.taxa_prazo_geral) || 0,
      comCoordenadas: parseInt(resumoQuery.rows[0]?.com_coordenadas) || 0,
      pontos: pontos,
      cidadesRanking: cidadesQuery.rows.slice(0, 15).map(c => ({
        cidade: c.cidade,
        estado: c.estado,
        total: parseInt(c.total_entregas),
        noPrazo: parseInt(c.no_prazo) || 0,
        foraPrazo: parseInt(c.fora_prazo) || 0,
        taxaPrazo: parseFloat(c.taxa_prazo) || 0,
        totalProfissionais: parseInt(c.total_profissionais) || 0
      })),
      bairrosRanking: bairrosQuery.rows.slice(0, 20).map(b => ({
        bairro: b.bairro,
        cidade: b.cidade,
        total: parseInt(b.total_entregas),
        noPrazo: parseInt(b.no_prazo) || 0,
        foraPrazo: parseInt(b.fora_prazo) || 0,
        taxaPrazo: parseFloat(b.taxa_prazo) || 0
      })),
      horariosHeatmap: horariosQuery.rows.map(h => ({
        hora: parseInt(h.hora),
        diaSemana: parseInt(h.dia_semana),
        total: parseInt(h.total)
      }))
    });
    
  } catch (error) {
    console.error('Erro mapa de calor:', error);
    res.status(500).json({ error: 'Erro ao gerar mapa de calor', details: error.message });
  }
});

// GET - Acompanhamento Periódico (evolução temporal)
app.get('/api/bi/acompanhamento-periodico', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_retorno } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    // Cada métrica filtra pelo ponto apropriado internamente
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Dados por data
    // REGRA ALOCAÇÃO: Se solicitado após 17h E alocação no dia seguinte, início = 08:00 do dia da alocação
    const porDataQuery = await pool.query(`
      SELECT 
        data_solicitado,
        TO_CHAR(data_solicitado, 'DD/MM') as data_formatada,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_motoboy,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_coleta,
        
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional
      FROM bi_entregas
      ${whereClause}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // Calcular evolução semanal
    const porData = porDataQuery.rows.map((d, idx, arr) => {
      let evolucaoSemanal = null;
      if (idx >= 7) {
        const entregas7DiasAtras = arr[idx - 7]?.total_entregas;
        if (entregas7DiasAtras > 0) {
          evolucaoSemanal = ((d.total_entregas - entregas7DiasAtras) / entregas7DiasAtras * 100).toFixed(1);
        }
      }
      return {
        ...d,
        total_os: parseInt(d.total_os) || 0,
        total_entregas: parseInt(d.total_entregas) || 0,
        dentro_prazo: parseInt(d.dentro_prazo) || 0,
        fora_prazo: parseInt(d.fora_prazo) || 0,
        taxa_prazo: parseFloat(d.taxa_prazo) || 0,
        retornos: parseInt(d.retornos) || 0,
        valor_total: parseFloat(d.valor_total) || 0,
        valor_motoboy: parseFloat(d.valor_motoboy) || 0,
        ticket_medio: parseFloat(d.ticket_medio) || 0,
        tempo_medio_entrega: parseFloat(d.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(d.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(d.tempo_medio_coleta) || 0,
        total_entregadores: parseInt(d.total_entregadores) || 0,
        media_ent_profissional: parseFloat(d.media_ent_profissional) || 0,
        evolucao_semanal: evolucaoSemanal
      };
    });
    
    // Resumo geral
    const resumoQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as total_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo_geral,
        COALESCE(SUM(valor), 0) as valor_total,
        ROUND(AVG(tempo_execucao_minutos), 1) as tempo_medio_geral,
        COUNT(DISTINCT cod_prof) as total_profissionais,
        COUNT(DISTINCT data_solicitado) as total_dias
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    res.json({
      porData: porData,
      resumo: {
        totalOS: parseInt(resumoQuery.rows[0]?.total_os) || 0,
        totalEntregas: parseInt(resumoQuery.rows[0]?.total_entregas) || 0,
        totalPrazo: parseInt(resumoQuery.rows[0]?.total_prazo) || 0,
        taxaPrazoGeral: parseFloat(resumoQuery.rows[0]?.taxa_prazo_geral) || 0,
        valorTotal: parseFloat(resumoQuery.rows[0]?.valor_total) || 0,
        tempoMedioGeral: parseFloat(resumoQuery.rows[0]?.tempo_medio_geral) || 0,
        totalProfissionais: parseInt(resumoQuery.rows[0]?.total_profissionais) || 0,
        totalDias: parseInt(resumoQuery.rows[0]?.total_dias) || 0
      }
    });
    
  } catch (error) {
    console.error('Erro acompanhamento periódico:', error);
    res.status(500).json({ error: 'Erro ao gerar acompanhamento', details: error.message });
  }
});

// GET - Comparativo Semanal para aba Acompanhamento
// Agrupa dados por semana e calcula variações entre semanas
app.get('/api/bi/comparativo-semanal', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    // Cada métrica filtra pelo ponto apropriado internamente
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    
    // Agrupa por semana do ano
    const semanalQuery = await pool.query(`
      SELECT 
        EXTRACT(ISOYEAR FROM data_solicitado) as ano,
        EXTRACT(WEEK FROM data_solicitado) as semana,
        MIN(data_solicitado) as data_inicio_semana,
        MAX(data_solicitado) as data_fim_semana,
        TO_CHAR(MIN(data_solicitado), 'DD/MM') || ' - ' || TO_CHAR(MAX(data_solicitado), 'DD/MM') as periodo,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END) as dentro_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = false THEN 1 ELSE 0 END) as fora_prazo_prof,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND data_hora IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_coleta,
        
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_entrega_prof_minutos END), 1) as tempo_medio_prof,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0)::numeric, 1) as km_total
      FROM bi_entregas
      ${whereClause}
      GROUP BY EXTRACT(ISOYEAR FROM data_solicitado), EXTRACT(WEEK FROM data_solicitado)
      ORDER BY ano DESC, semana DESC
    `, params);
    
    // Processar dados para calcular variações
    const semanas = semanalQuery.rows.map((row, idx, arr) => {
      const semanaAnterior = arr[idx + 1]; // próximo no array é a semana anterior (ordenado DESC)
      
      // Calcular variações percentuais
      const calcVariacao = (atual, anterior) => {
        if (!anterior || anterior === 0) return null;
        return ((atual - anterior) / anterior * 100).toFixed(1);
      };
      
      return {
        ano: parseInt(row.ano),
        semana: parseInt(row.semana),
        periodo: row.periodo,
        data_inicio_semana: row.data_inicio_semana,
        data_fim_semana: row.data_fim_semana,
        total_os: parseInt(row.total_os) || 0,
        total_entregas: parseInt(row.total_entregas) || 0,
        dentro_prazo: parseInt(row.dentro_prazo) || 0,
        fora_prazo: parseInt(row.fora_prazo) || 0,
        dentro_prazo_prof: parseInt(row.dentro_prazo_prof) || 0,
        fora_prazo_prof: parseInt(row.fora_prazo_prof) || 0,
        taxa_prazo: parseFloat(row.taxa_prazo) || 0,
        taxa_prazo_prof: parseFloat(row.taxa_prazo_prof) || 0,
        retornos: parseInt(row.retornos) || 0,
        valor_total: parseFloat(row.valor_total) || 0,
        valor_prof: parseFloat(row.valor_prof) || 0,
        ticket_medio: parseFloat(row.ticket_medio) || 0,
        tempo_medio_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(row.tempo_medio_coleta) || 0,
        tempo_medio_prof: parseFloat(row.tempo_medio_prof) || 0,
        total_entregadores: parseInt(row.total_entregadores) || 0,
        media_ent_profissional: parseFloat(row.media_ent_profissional) || 0,
        km_total: parseFloat(row.km_total) || 0,
        // Variações em relação à semana anterior
        var_entregas: calcVariacao(parseInt(row.total_entregas), semanaAnterior ? parseInt(semanaAnterior.total_entregas) : null),
        var_os: calcVariacao(parseInt(row.total_os), semanaAnterior ? parseInt(semanaAnterior.total_os) : null),
        var_valor: calcVariacao(parseFloat(row.valor_total), semanaAnterior ? parseFloat(semanaAnterior.valor_total) : null),
        var_prazo: semanaAnterior ? (parseFloat(row.taxa_prazo) - parseFloat(semanaAnterior.taxa_prazo)).toFixed(1) : null,
        var_prazo_prof: semanaAnterior ? (parseFloat(row.taxa_prazo_prof) - parseFloat(semanaAnterior.taxa_prazo_prof)).toFixed(1) : null,
        var_retornos: calcVariacao(parseInt(row.retornos), semanaAnterior ? parseInt(semanaAnterior.retornos) : null),
        // Dados da semana anterior para comparativo lado a lado
        anterior: semanaAnterior ? {
          total_entregas: parseInt(semanaAnterior.total_entregas) || 0,
          total_os: parseInt(semanaAnterior.total_os) || 0,
          taxa_prazo: parseFloat(semanaAnterior.taxa_prazo) || 0,
          taxa_prazo_prof: parseFloat(semanaAnterior.taxa_prazo_prof) || 0,
          valor_total: parseFloat(semanaAnterior.valor_total) || 0,
          retornos: parseInt(semanaAnterior.retornos) || 0
        } : null
      };
    });
    
    // Resumo geral (todas as semanas)
    const totalSemanas = semanas.length;
    const mediaEntregasSemana = totalSemanas > 0 ? Math.round(semanas.reduce((a, s) => a + s.total_entregas, 0) / totalSemanas) : 0;
    const melhorSemana = semanas.reduce((best, s) => (!best || s.total_entregas > best.total_entregas) ? s : best, null);
    const piorSemana = semanas.reduce((worst, s) => (!worst || s.total_entregas < worst.total_entregas) ? s : worst, null);
    
    res.json({
      semanas: semanas,
      resumo: {
        total_semanas: totalSemanas,
        media_entregas_semana: mediaEntregasSemana,
        melhor_semana: melhorSemana ? { periodo: melhorSemana.periodo, entregas: melhorSemana.total_entregas } : null,
        pior_semana: piorSemana ? { periodo: piorSemana.periodo, entregas: piorSemana.total_entregas } : null
      }
    });
    
  } catch (error) {
    console.error('Erro comparativo semanal:', error);
    res.status(500).json({ error: 'Erro ao gerar comparativo semanal', details: error.message });
  }
});

// GET - Comparativo semanal POR CLIENTE (detalhado)
app.get('/api/bi/comparativo-semanal-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    
    // Agrupa por nome_fantasia E semana do ano (como Power BI)
    const semanalQuery = await pool.query(`
      SELECT 
        nome_fantasia,
        EXTRACT(ISOYEAR FROM data_solicitado) as ano,
        EXTRACT(WEEK FROM data_solicitado) as semana,
        MIN(data_solicitado) as data_inicio_semana,
        MAX(data_solicitado) as data_fim_semana,
        TO_CHAR(MIN(data_solicitado), 'DD/MM') || ' - ' || TO_CHAR(MAX(data_solicitado), 'DD/MM') as periodo,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END) as dentro_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = false THEN 1 ELSE 0 END) as fora_prazo_prof,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND data_hora IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 1) as tempo_medio_coleta,
        
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_entrega_prof_minutos END), 1) as tempo_medio_prof,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_fantasia, EXTRACT(ISOYEAR FROM data_solicitado), EXTRACT(WEEK FROM data_solicitado)
      ORDER BY nome_fantasia, ano DESC, semana DESC
    `, params);
    
    // Agrupar por nome_fantasia (não por cod_cliente)
    const clientesMap = {};
    semanalQuery.rows.forEach(row => {
      const key = row.nome_fantasia;
      if (!clientesMap[key]) {
        clientesMap[key] = {
          nome_fantasia: row.nome_fantasia,
          semanas: []
        };
      }
      clientesMap[key].semanas.push(row);
    });
    
    // Processar dados para calcular variações por cliente
    const clientes = Object.values(clientesMap).map(cliente => {
      const semanas = cliente.semanas.map((row, idx, arr) => {
        const semanaAnterior = arr[idx + 1];
        
        const calcVariacao = (atual, anterior) => {
          if (!anterior || anterior === 0) return null;
          return ((atual - anterior) / anterior * 100).toFixed(1);
        };
        
        return {
          ano: parseInt(row.ano),
          semana: parseInt(row.semana),
          periodo: row.periodo,
          total_os: parseInt(row.total_os) || 0,
          total_entregas: parseInt(row.total_entregas) || 0,
          dentro_prazo: parseInt(row.dentro_prazo) || 0,
          fora_prazo: parseInt(row.fora_prazo) || 0,
          taxa_prazo: parseFloat(row.taxa_prazo) || 0,
          taxa_prazo_prof: parseFloat(row.taxa_prazo_prof) || 0,
          retornos: parseInt(row.retornos) || 0,
          valor_total: parseFloat(row.valor_total) || 0,
          valor_prof: parseFloat(row.valor_prof) || 0,
          ticket_medio: parseFloat(row.ticket_medio) || 0,
          tempo_medio_entrega: parseFloat(row.tempo_medio_entrega) || 0,
          tempo_medio_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
          tempo_medio_coleta: parseFloat(row.tempo_medio_coleta) || 0,
          tempo_medio_prof: parseFloat(row.tempo_medio_prof) || 0,
          total_entregadores: parseInt(row.total_entregadores) || 0,
          media_ent_profissional: parseFloat(row.media_ent_profissional) || 0,
          var_entregas: calcVariacao(parseInt(row.total_entregas), semanaAnterior ? parseInt(semanaAnterior.total_entregas) : null),
          var_valor: calcVariacao(parseFloat(row.valor_total), semanaAnterior ? parseFloat(semanaAnterior.valor_total) : null),
          var_prazo: semanaAnterior ? (parseFloat(row.taxa_prazo) - parseFloat(semanaAnterior.taxa_prazo)).toFixed(1) : null,
          var_retornos: calcVariacao(parseInt(row.retornos), semanaAnterior ? parseInt(semanaAnterior.retornos) : null)
        };
      });
      
      // Calcular totais do cliente
      const totalEntregas = semanas.reduce((a, s) => a + s.total_entregas, 0);
      const mediaEntregas = semanas.length > 0 ? Math.round(totalEntregas / semanas.length) : 0;
      const mediaPrazo = semanas.length > 0 ? (semanas.reduce((a, s) => a + s.taxa_prazo, 0) / semanas.length).toFixed(1) : 0;
      
      return {
        nome_fantasia: cliente.nome_fantasia,
        semanas: semanas,
        resumo: {
          total_semanas: semanas.length,
          total_entregas: totalEntregas,
          media_entregas_semana: mediaEntregas,
          media_taxa_prazo: parseFloat(mediaPrazo)
        }
      };
    });
    
    // Ordenar por total de entregas (maiores primeiro)
    clientes.sort((a, b) => b.resumo.total_entregas - a.resumo.total_entregas);
    
    res.json({
      clientes: clientes,
      total_clientes: clientes.length
    });
    
  } catch (error) {
    console.error('Erro comparativo semanal por cliente:', error);
    res.status(500).json({ error: 'Erro ao gerar comparativo semanal por cliente', details: error.message });
  }
});

// GET - Dados agrupados por cliente para tabela de acompanhamento
// IMPORTANTE: Agrupa por NOME_FANTASIA (como o Power BI) e não por cod_cliente
// IMPORTANTE: Calcula média de tempo POR OS (não por linha/ponto)
// IMPORTANTE: Tempo de entrega usa Data Chegada + Hora Chegada (não Finalizado)
app.get('/api/bi/acompanhamento-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_retorno } = req.query;
    
    // Não filtramos por Ponto aqui para incluir coletas (Ponto 1) e entregas (Ponto >= 2)
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Buscar dados agrupados por COD_CLIENTE - Média direta de todas as linhas (igual ao Dashboard)
    const clientesQuery = await pool.query(`
      SELECT 
        cod_cliente,
        MAX(COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente)) as nome_display,
        COUNT(DISTINCT os) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as faturamento_total,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
              NULLIF(COUNT(DISTINCT os), 0), 2) as ticket_medio,
        -- TEMPO MÉDIO ENTREGA: média direta de todas as linhas (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega_min,
        -- TEMPO MÉDIO ALOCAÇÃO: média direta de todas as linhas (Ponto = 1)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao_min,
        -- TEMPO MÉDIO COLETA: média direta de todas as linhas (Ponto = 1)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta_min,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY cod_cliente
      ORDER BY total_entregas DESC
    `, params);
    
    // Calcular totais com média direta (igual ao Dashboard)
    const totaisQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as faturamento_total,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(DISTINCT os), 0), 2) as ticket_medio,
        -- TEMPO MÉDIO ENTREGA: média direta de todas as linhas
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega_min,
        -- TEMPO MÉDIO ALOCAÇÃO
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao_min,
        -- TEMPO MÉDIO COLETA
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta_min,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    // Formatar tempo em HH:MM:SS
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    const clientes = clientesQuery.rows.map(c => ({
      cliente: c.nome_display,
      cod_cliente: parseInt(c.cod_cliente),
      os: parseInt(c.total_os) || 0,
      entregas: parseInt(c.total_entregas) || 0,
      entregasNoPrazo: parseInt(c.entregas_no_prazo) || 0,
      entregasForaPrazo: parseInt(c.entregas_fora_prazo) || 0,
      noPrazo: parseFloat(c.taxa_no_prazo) || 0,
      foraPrazo: parseFloat(c.taxa_fora_prazo) || 0,
      retornos: parseInt(c.retornos) || 0,
      valorTotal: parseFloat(c.valor_total) || 0,
      valorProf: parseFloat(c.valor_prof) || 0,
      faturamentoTotal: parseFloat(c.faturamento_total) || 0,
      ticketMedio: parseFloat(c.ticket_medio) || 0,
      tempoMedioEntrega: formatarTempo(parseFloat(c.tempo_medio_entrega_min)),
      tempoMedioAlocacao: formatarTempo(parseFloat(c.tempo_medio_alocacao_min)),
      tempoMedioColeta: formatarTempo(parseFloat(c.tempo_medio_coleta_min)),
      totalProfissionais: parseInt(c.total_profissionais) || 0,
      mediaEntProfissional: ((parseInt(c.total_entregas) || 0) / Math.max(parseInt(c.total_profissionais) || 1, 1)).toFixed(1),
      centros_custo: [] // Será preenchido abaixo
    }));
    
    // Buscar centros de custo por cliente
    const centrosCustoQuery = await pool.query(`
      WITH tempo_por_os AS (
        SELECT 
          os,
          cod_cliente,
          centro_custo,
          -- Métricas de ENTREGA (Ponto >= 2)
          MIN(CASE WHEN COALESCE(ponto, 1) >= 2 THEN dentro_prazo::int END) as dentro_prazo,
          MAX(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as eh_retorno,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END) as valor_os,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_prof_os,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas_os,
          AVG(
            CASE 
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND data_chegada IS NOT NULL 
                   AND hora_chegada IS NOT NULL
              THEN
                EXTRACT(EPOCH FROM (
                  (data_chegada + hora_chegada) - 
                  CASE 
                    WHEN DATE(data_chegada) <> DATE(data_hora)
                    THEN DATE(data_chegada) + TIME '08:00:00'
                    ELSE data_hora
                  END
                )) / 60
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND finalizado IS NOT NULL
                   AND finalizado >= data_hora
              THEN
                EXTRACT(EPOCH FROM (
                  finalizado - 
                  CASE 
                    WHEN DATE(finalizado) <> DATE(data_hora)
                    THEN DATE(finalizado) + TIME '08:00:00'
                    ELSE data_hora
                  END
                )) / 60
              ELSE NULL
            END
          ) as tempo_entrega_min
        FROM bi_entregas
        ${whereClause}
        AND centro_custo IS NOT NULL AND centro_custo != ''
        GROUP BY os, cod_cliente, centro_custo
      )
      SELECT 
        cod_cliente,
        centro_custo,
        COUNT(DISTINCT os) as total_os,
        SUM(total_entregas_os) as total_entregas,
        SUM(CASE WHEN dentro_prazo = 1 THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN dentro_prazo = 0 THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = 1 THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(total_entregas_os), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = 0 THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(total_entregas_os), 0) * 100, 2) as taxa_fora_prazo,
        SUM(eh_retorno) as retornos,
        COALESCE(SUM(valor_os), 0) as valor_total,
        COALESCE(SUM(valor_prof_os), 0) as valor_prof,
        ROUND(AVG(tempo_entrega_min), 2) as tempo_medio_entrega_min
      FROM tempo_por_os
      GROUP BY cod_cliente, centro_custo
      ORDER BY cod_cliente, total_entregas DESC
    `, params);
    
    // Mapear centros de custo para os clientes
    centrosCustoQuery.rows.forEach(cc => {
      const codCliente = parseInt(cc.cod_cliente);
      const cliente = clientes.find(c => c.cod_cliente === codCliente);
      if (cliente) {
        cliente.centros_custo.push({
          centro_custo: cc.centro_custo,
          total_os: parseInt(cc.total_os) || 0,
          total_entregas: parseInt(cc.total_entregas) || 0,
          dentro_prazo: parseInt(cc.entregas_no_prazo) || 0,
          fora_prazo: parseInt(cc.entregas_fora_prazo) || 0,
          taxa_no_prazo: parseFloat(cc.taxa_no_prazo) || 0,
          taxa_fora_prazo: parseFloat(cc.taxa_fora_prazo) || 0,
          retornos: parseInt(cc.retornos) || 0,
          valor_total: parseFloat(cc.valor_total) || 0,
          valor_prof: parseFloat(cc.valor_prof) || 0,
          tempo_medio: formatarTempo(parseFloat(cc.tempo_medio_entrega_min))
        });
      }
    });
    
    const totais = {
      os: parseInt(totaisQuery.rows[0]?.total_os) || 0,
      entregas: parseInt(totaisQuery.rows[0]?.total_entregas) || 0,
      entregasNoPrazo: parseInt(totaisQuery.rows[0]?.entregas_no_prazo) || 0,
      entregasForaPrazo: parseInt(totaisQuery.rows[0]?.entregas_fora_prazo) || 0,
      noPrazo: parseFloat(totaisQuery.rows[0]?.taxa_no_prazo) || 0,
      foraPrazo: parseFloat(totaisQuery.rows[0]?.taxa_fora_prazo) || 0,
      retornos: parseInt(totaisQuery.rows[0]?.retornos) || 0,
      valorTotal: parseFloat(totaisQuery.rows[0]?.valor_total) || 0,
      valorProf: parseFloat(totaisQuery.rows[0]?.valor_prof) || 0,
      faturamentoTotal: parseFloat(totaisQuery.rows[0]?.faturamento_total) || 0,
      ticketMedio: parseFloat(totaisQuery.rows[0]?.ticket_medio) || 0,
      tempoMedioEntrega: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_entrega_min)),
      tempoMedioAlocacao: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_alocacao_min)),
      tempoMedioColeta: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_coleta_min)),
      totalProfissionais: parseInt(totaisQuery.rows[0]?.total_profissionais) || 0,
      mediaEntProfissional: ((parseInt(totaisQuery.rows[0]?.total_entregas) || 0) / Math.max(parseInt(totaisQuery.rows[0]?.total_profissionais) || 1, 1)).toFixed(1)
    };
    
    res.json({ clientes, totais });
    
  } catch (error) {
    console.error('Erro acompanhamento clientes:', error);
    res.status(500).json({ error: 'Erro ao buscar dados de clientes', details: error.message });
  }
});

// ============================================
// ENDPOINT ESPECIAL: Cliente 767 com prazo de 120 minutos
// ============================================
app.get('/api/bi/cliente-767', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const PRAZO_767 = 120; // Prazo específico de 120 minutos para cliente 767
    
    // Primeiro, buscar todos os centros de custo disponíveis para o cliente 767
    const centrosCustoQuery = await pool.query(`
      SELECT DISTINCT centro_custo 
      FROM bi_entregas 
      WHERE cod_cliente = 767 AND centro_custo IS NOT NULL AND centro_custo != ''
      ORDER BY centro_custo
    `);
    const centrosCustoDisponiveis = centrosCustoQuery.rows.map(r => r.centro_custo);
    
    let whereClause = 'WHERE cod_cliente = 767';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    // Filtro por centro de custo (pode ser um ou vários separados por vírgula)
    const { centro_custo } = req.query;
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo IN (${centros.map((_, i) => `$${paramIndex + i}`).join(',')})`;
        params.push(...centros);
        paramIndex += centros.length;
      }
    }
    
    // Buscar dados do cliente 767
    const dadosQuery = await pool.query(`
      SELECT 
        os, 
        COALESCE(ponto, 1) as ponto, 
        cod_cliente, 
        nome_cliente,
        nome_fantasia,
        cod_prof, 
        nome_prof, 
        valor, 
        valor_prof, 
        distancia,
        ocorrencia, 
        centro_custo, 
        motivo, 
        finalizado,
        data_hora, 
        data_hora_alocado, 
        data_chegada, 
        hora_chegada,
        data_solicitado
      FROM bi_entregas 
      ${whereClause}
    `, params);
    
    const dados = dadosQuery.rows;
    console.log('📊 Cliente 767: Total registros:', dados.length);
    
    // Função para calcular tempo de entrega
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null;
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {}
      }
      
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    // Função para calcular tempo de coleta (Alocado -> Saída conforme DAX)
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {}
      }
      
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    // Função para calcular tempo de alocação
    const calcularTempoAlocacao = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora || !row.data_hora_alocado) return null;
      
      const solicitado = new Date(row.data_hora);
      const alocado = new Date(row.data_hora_alocado);
      
      if (alocado < solicitado) return null;
      
      const horaSolicitado = solicitado.getHours();
      const depoisDas17 = horaSolicitado >= 17;
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem = solicitado;
      if (depoisDas17 && !mesmaData) {
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      }
      
      const difMinutos = (alocado - inicioContagem) / (1000 * 60);
      return difMinutos >= 0 ? difMinutos : null;
    };
    
    // Função para formatar tempo em HH:MM:SS (igual ao Acompanhamento)
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0 || isNaN(minutos)) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    // Agrupar por OS
    const osPorOS = {};
    dados.forEach(row => {
      const os = row.os;
      if (!osPorOS[os]) osPorOS[os] = [];
      osPorOS[os].push(row);
    });
    
    // Calcular métricas com prazo de 120 minutos
    let totalOS = new Set();
    let totalEntregas = 0, dentroPrazo = 0, foraPrazo = 0;
    let somaValor = 0, somaValorProf = 0;
    let somaTempoEntrega = 0, countTempoEntrega = 0;
    let somaTempoAlocacao = 0, countTempoAlocacao = 0;
    let somaTempoColeta = 0, countTempoColeta = 0;
    let profissionais = new Set();
    let totalRetornos = 0;
    
    // Dados por data para gráfico
    const porDataMap = {};
    
    Object.keys(osPorOS).forEach(os => {
      const linhasOS = osPorOS[os];
      totalOS.add(os);
      
      // Contagem de entregas (pontos >= 2)
      const entregasOS = linhasOS.filter(l => (parseInt(l.ponto) || 1) >= 2).length || 1;
      totalEntregas += entregasOS;
      
      linhasOS.forEach(row => {
        profissionais.add(row.cod_prof);
        
        const ocorrencia = (row.ocorrencia || '').toLowerCase();
        if (ocorrencia.includes('cliente fechado') || ocorrencia.includes('cliente ausente') || 
            ocorrencia.includes('loja fechada') || ocorrencia.includes('produto incorreto')) {
          totalRetornos++;
        }
        
        // Calcular tempos
        const tempoEnt = calcularTempoEntrega(row);
        if (tempoEnt !== null) {
          somaTempoEntrega += tempoEnt;
          countTempoEntrega++;
          
          // Verificar prazo de 120 minutos
          if (tempoEnt <= PRAZO_767) {
            dentroPrazo++;
          } else {
            foraPrazo++;
          }
        }
        
        const tempoAloc = calcularTempoAlocacao(row);
        if (tempoAloc !== null) {
          somaTempoAlocacao += tempoAloc;
          countTempoAlocacao++;
        }
        
        const tempoCol = calcularTempoColeta(row);
        if (tempoCol !== null) {
          somaTempoColeta += tempoCol;
          countTempoColeta++;
        }
        
        // Agrupar por data
        const data = row.data_solicitado;
        if (data) {
          if (!porDataMap[data]) {
            porDataMap[data] = {
              data_solicitado: data,
              total_os: new Set(),
              total_entregas: 0,
              dentro_prazo: 0,
              fora_prazo: 0,
              soma_tempo_entrega: 0,
              count_tempo_entrega: 0,
              soma_tempo_alocacao: 0,
              count_tempo_alocacao: 0,
              soma_tempo_coleta: 0,
              count_tempo_coleta: 0,
              soma_valor: 0,
              soma_valor_prof: 0,
              retornos: 0,
              profissionais: new Set()
            };
          }
          porDataMap[data].total_os.add(os);
          porDataMap[data].profissionais.add(row.cod_prof);
          
          if ((parseInt(row.ponto) || 1) >= 2) {
            porDataMap[data].total_entregas++;
          }
          
          if (tempoEnt !== null) {
            porDataMap[data].soma_tempo_entrega += tempoEnt;
            porDataMap[data].count_tempo_entrega++;
            if (tempoEnt <= PRAZO_767) {
              porDataMap[data].dentro_prazo++;
            } else {
              porDataMap[data].fora_prazo++;
            }
          }
          
          if (tempoAloc !== null) {
            porDataMap[data].soma_tempo_alocacao += tempoAloc;
            porDataMap[data].count_tempo_alocacao++;
          }
          
          if (tempoCol !== null) {
            porDataMap[data].soma_tempo_coleta += tempoCol;
            porDataMap[data].count_tempo_coleta++;
          }
        }
      });
      
      // Valores (1x por OS)
      const linhaValor = linhasOS.reduce((maior, atual) => {
        return (parseInt(atual.ponto) || 0) > (parseInt(maior?.ponto) || 0) ? atual : maior;
      }, linhasOS[0]);
      
      somaValor += parseFloat(linhaValor?.valor) || 0;
      somaValorProf += parseFloat(linhaValor?.valor_prof) || 0;
      
      // Valor por data
      const data = linhaValor?.data_solicitado;
      if (data && porDataMap[data]) {
        porDataMap[data].soma_valor += parseFloat(linhaValor?.valor) || 0;
        porDataMap[data].soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
      }
    });
    
    // Formatar dados por data
    const porData = Object.keys(porDataMap).sort().map(data => {
      const d = porDataMap[data];
      const totalEnt = d.total_entregas || 1;
      return {
        data_solicitado: data,
        data_formatada: new Date(data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        total_os: d.total_os.size,
        total_entregas: d.total_entregas,
        dentro_prazo: d.dentro_prazo,
        fora_prazo: d.fora_prazo,
        taxa_prazo: d.count_tempo_entrega > 0 ? ((d.dentro_prazo / d.count_tempo_entrega) * 100).toFixed(1) : 0,
        tempo_medio_entrega: d.count_tempo_entrega > 0 ? formatarTempo(d.soma_tempo_entrega / d.count_tempo_entrega) : '00:00:00',
        tempo_medio_alocacao: d.count_tempo_alocacao > 0 ? formatarTempo(d.soma_tempo_alocacao / d.count_tempo_alocacao) : '00:00:00',
        tempo_medio_coleta: d.count_tempo_coleta > 0 ? formatarTempo(d.soma_tempo_coleta / d.count_tempo_coleta) : '00:00:00',
        valor_total: d.soma_valor,
        valor_motoboy: d.soma_valor_prof,
        ticket_medio: d.total_os.size > 0 ? (d.soma_valor / d.total_os.size).toFixed(2) : 0,
        total_entregadores: d.profissionais.size
      };
    });
    
    // =============================================
    // DADOS POR CENTRO DE CUSTO
    // =============================================
    const porCentroCustoMap = {};
    
    Object.keys(osPorOS).forEach(os => {
      const linhasOS = osPorOS[os];
      
      linhasOS.forEach(row => {
        const centroCusto = row.centro_custo || 'Sem Centro de Custo';
        
        if (!porCentroCustoMap[centroCusto]) {
          porCentroCustoMap[centroCusto] = {
            centro_custo: centroCusto,
            total_os: new Set(),
            total_entregas: 0,
            dentro_prazo: 0,
            fora_prazo: 0,
            count_tempo: 0
          };
        }
        
        porCentroCustoMap[centroCusto].total_os.add(os);
        
        if ((parseInt(row.ponto) || 1) >= 2) {
          porCentroCustoMap[centroCusto].total_entregas++;
        }
        
        // Calcular tempo de entrega para verificar prazo
        const tempoEnt = calcularTempoEntrega(row);
        if (tempoEnt !== null) {
          porCentroCustoMap[centroCusto].count_tempo++;
          if (tempoEnt <= PRAZO_767) {
            porCentroCustoMap[centroCusto].dentro_prazo++;
          } else {
            porCentroCustoMap[centroCusto].fora_prazo++;
          }
        }
      });
    });
    
    // Formatar dados por centro de custo
    const porCentroCusto = Object.values(porCentroCustoMap).map(cc => ({
      centro_custo: cc.centro_custo,
      total_os: cc.total_os.size,
      total_entregas: cc.total_entregas,
      dentro_prazo: cc.dentro_prazo,
      fora_prazo: cc.fora_prazo,
      taxa_prazo: cc.count_tempo > 0 ? ((cc.dentro_prazo / cc.count_tempo) * 100).toFixed(1) : 0
    })).sort((a, b) => b.total_entregas - a.total_entregas);
    
    // =============================================
    // CÁLCULO DE META MENSAL (95%)
    // =============================================
    const META_MENSAL = 95; // Meta de 95%
    
    // Usar sempre a data atual para o cálculo de dias restantes
    const hoje = new Date();
    const diaAtual = hoje.getDate();
    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();
    
    // Determinar o mês de referência (do filtro ou mês atual)
    let mesReferencia, anoReferencia;
    if (data_inicio) {
      const dataRef = new Date(data_inicio);
      mesReferencia = dataRef.getMonth();
      anoReferencia = dataRef.getFullYear();
    } else {
      mesReferencia = mesAtual;
      anoReferencia = anoAtual;
    }
    
    // Calcular dias do mês
    const ultimoDiaMes = new Date(anoReferencia, mesReferencia + 1, 0).getDate();
    
    // Dias passados baseado no dia atual do mês
    let diasPassados;
    const mesmoMesAno = (mesReferencia === mesAtual && anoReferencia === anoAtual);
    
    if (mesmoMesAno) {
      // Estamos no mês atual - usar o dia de hoje
      diasPassados = diaAtual;
    } else if (anoReferencia < anoAtual || (anoReferencia === anoAtual && mesReferencia < mesAtual)) {
      // Mês passado - todos os dias já passaram
      diasPassados = ultimoDiaMes;
    } else {
      // Mês futuro - nenhum dia passou
      diasPassados = 0;
    }
    
    // Dias restantes = total de dias do mês - dia atual
    const diasRestantes = Math.max(0, ultimoDiaMes - diasPassados);
    
    // Total de entregas e dentro do prazo até agora
    const totalEntregasAteAgora = countTempoEntrega;
    const dentroPrazoAteAgora = dentroPrazo;
    const taxaAtual = totalEntregasAteAgora > 0 ? (dentroPrazoAteAgora / totalEntregasAteAgora) * 100 : 0;
    
    // Estimar média de entregas por dia (baseado nos dias que tiveram entregas)
    const diasComDados = porData.length || 1;
    const mediaEntregasPorDia = diasComDados > 0 ? totalEntregasAteAgora / diasComDados : 0;
    const entregasEstimadasRestantes = Math.round(mediaEntregasPorDia * diasRestantes);
    const totalEntregasEstimadoMes = totalEntregasAteAgora + entregasEstimadasRestantes;
    
    // Calcular quantas entregas no prazo são necessárias para atingir 95%
    const entregasNoPrazoNecessariasMes = Math.ceil(totalEntregasEstimadoMes * (META_MENSAL / 100));
    const entregasNoPrazoFaltam = Math.max(0, entregasNoPrazoNecessariasMes - dentroPrazoAteAgora);
    
    // Calcular a taxa mínima necessária nos dias restantes
    let taxaMinimaRestante = 0;
    let metaAtingivel = true;
    let mensagemMeta = '';
    
    if (diasRestantes > 0 && entregasEstimadasRestantes > 0) {
      taxaMinimaRestante = (entregasNoPrazoFaltam / entregasEstimadasRestantes) * 100;
      
      if (taxaMinimaRestante > 100) {
        metaAtingivel = false;
        mensagemMeta = 'Meta de 95% não é mais atingível este mês';
      } else if (taxaMinimaRestante <= 0) {
        taxaMinimaRestante = 0;
        mensagemMeta = 'Meta de 95% já foi atingida!';
      } else {
        mensagemMeta = `Precisa de ${taxaMinimaRestante.toFixed(1)}% nos próximos ${diasRestantes} dias`;
      }
    } else if (diasRestantes === 0) {
      mensagemMeta = taxaAtual >= META_MENSAL ? 'Meta atingida!' : 'Mês encerrado - meta não atingida';
      metaAtingivel = taxaAtual >= META_MENSAL;
    }
    
    const indicadorMeta = {
      meta_mensal: META_MENSAL,
      mes_referencia: new Date(anoReferencia, mesReferencia, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
      dia_atual: diaAtual,
      dias_mes: ultimoDiaMes,
      dias_passados: diasPassados,
      dias_restantes: diasRestantes,
      taxa_atual: parseFloat(taxaAtual.toFixed(1)),
      total_entregas_ate_agora: totalEntregasAteAgora,
      dentro_prazo_ate_agora: dentroPrazoAteAgora,
      media_entregas_dia: parseFloat(mediaEntregasPorDia.toFixed(1)),
      entregas_estimadas_restantes: entregasEstimadasRestantes,
      total_estimado_mes: totalEntregasEstimadoMes,
      entregas_no_prazo_necessarias: entregasNoPrazoNecessariasMes,
      entregas_no_prazo_faltam: entregasNoPrazoFaltam,
      taxa_minima_restante: parseFloat(taxaMinimaRestante.toFixed(1)),
      meta_atingivel: metaAtingivel,
      mensagem: mensagemMeta
    };
    
    // Métricas gerais
    const metricas = {
      total_os: totalOS.size,
      total_entregas: totalEntregas,
      dentro_prazo: dentroPrazo,
      fora_prazo: foraPrazo,
      taxa_prazo: countTempoEntrega > 0 ? ((dentroPrazo / countTempoEntrega) * 100).toFixed(1) : 0,
      tempo_medio: countTempoEntrega > 0 ? formatarTempo(somaTempoEntrega / countTempoEntrega) : '00:00:00',
      tempo_medio_alocacao: countTempoAlocacao > 0 ? formatarTempo(somaTempoAlocacao / countTempoAlocacao) : '00:00:00',
      tempo_medio_coleta: countTempoColeta > 0 ? formatarTempo(somaTempoColeta / countTempoColeta) : '00:00:00',
      valor_total: somaValor.toFixed(2),
      valor_prof_total: somaValorProf.toFixed(2),
      ticket_medio: totalOS.size > 0 ? (somaValor / totalOS.size).toFixed(2) : 0,
      total_profissionais: profissionais.size,
      media_entregas_por_prof: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      total_retornos: totalRetornos,
      prazo_minutos: PRAZO_767
    };
    
    res.json({
      metricas,
      porData,
      porCentroCusto,
      indicadorMeta,
      centrosCustoDisponiveis,
      prazo: PRAZO_767,
      cliente: {
        cod_cliente: 767,
        nome: dados[0]?.nome_cliente || dados[0]?.nome_fantasia || 'Cliente 767'
      }
    });
    
  } catch (error) {
    console.error('Erro cliente 767:', error);
    res.status(500).json({ error: 'Erro ao buscar dados do cliente 767', details: error.message });
  }
});
