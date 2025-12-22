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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela bi_entregas verificada');

    // Migration: Adicionar coluna ponto se não existir
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS ponto INTEGER DEFAULT 1`).catch(() => {});
    
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
        proxima_recorrencia TIMESTAMP,
        tipo VARCHAR(20) DEFAULT 'compartilhado',
        criado_por VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        responsaveis JSONB DEFAULT '[]',
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        concluido_por VARCHAR(50),
        concluido_por_nome VARCHAR(255)
      )
    `);
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

    console.log('✅ Todas as tabelas verificadas/criadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error.message);
  }
}

// Middlewares - CORS configurado (DEVE SER O PRIMEIRO!)
// Responder imediatamente a requisições OPTIONS (preflight) - ANTES de tudo
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.status(200).end();
});

// CORS para todas requisições
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check (raiz e /api/health)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
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
      'SELECT id, cod_profissional, full_name, role, password, COALESCE(allowed_modules, \'[]\') as allowed_modules, COALESCE(allowed_tabs, \'{}\') as allowed_tabs FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
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
    const result = await pool.query(
      'SELECT id, cod_profissional, full_name, role, created_at FROM users ORDER BY created_at DESC'
    );
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

// DIAGNÓSTICO - verificar dados do BI
app.get('/api/bi/diagnostico', async (req, res) => {
  try {
    // Versão do código para verificar deploy
    const versao = '2025-12-09-v4-varchar-aumentado';
    
    // Verificar prazo padrão
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`);
    
    // Verificar entregas
    const entregas = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas`);
    const amostra = await pool.query(`SELECT id, os, cod_cliente, centro_custo, distancia, data_hora, finalizado, execucao_comp, dentro_prazo, prazo_minutos, tempo_execucao_minutos FROM bi_entregas LIMIT 5`);
    
    // Verificar quantos têm prazo calculado
    const comPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo IS NOT NULL`);
    const dentroPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = true`);
    const foraPrazo = await pool.query(`SELECT COUNT(*) as total FROM bi_entregas WHERE dentro_prazo = false`);
    
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
      prazoPadrao: prazoPadrao.rows,
      totalEntregas: entregas.rows[0].total,
      comPrazoCalculado: comPrazo.rows[0].total,
      dentroPrazo: dentroPrazo.rows[0].total,
      foraPrazo: foraPrazo.rows[0].total,
      comCentroCusto: comCentroCusto.rows[0].total,
      centrosUnicos: centrosUnicos.rows,
      comMotivo: comMotivo.rows[0].total,
      motivosComErro: motivosErro.rows[0].total,
      motivosUnicos: motivosUnicos.rows,
      amostraErros: amostraErros.rows,
      comOcorrencia: comOcorrencia.rows[0].total,
      ocorrenciasRetorno: ocorrenciasRetorno.rows[0].total,
      ocorrenciasUnicas: ocorrenciasUnicas.rows,
      amostraEntregas: amostra.rows,
      versao: versao
    });
  } catch (err) {
    console.error('❌ Erro no diagnóstico:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload de entregas (recebe JSON do Excel processado no frontend)
app.post('/api/bi/entregas/upload', async (req, res) => {
  try {
    const { entregas, data_referencia } = req.body;
    
    console.log(`📤 Upload BI: Recebendo ${entregas?.length || 0} entregas`);
    
    // Log para debug - verificar se centro_custo e motivo estão vindo
    if (entregas && entregas.length > 0) {
      console.log('📋 Amostra primeira entrega:', JSON.stringify(entregas[0], null, 2));
      console.log('📋 Centro custo da primeira:', entregas[0].centro_custo);
      console.log('📋 Motivo da primeira:', entregas[0].motivo);
      
      // Contar quantas têm motivo "erro"
      const comErro = entregas.filter(e => e.motivo && e.motivo.toLowerCase().includes('erro'));
      console.log(`📋 Total com motivo "erro": ${comErro.length}`);
      if (comErro.length > 0) {
        console.log('📋 Exemplos de motivos com erro:', comErro.slice(0, 5).map(e => e.motivo));
      }
    }
    
    if (!entregas || entregas.length === 0) {
      return res.status(400).json({ error: 'Nenhuma entrega recebida' });
    }
    
    console.log(`📤 Iniciando upload de ${entregas.length} entregas...`);
    
    // Log da primeira entrega para debug
    if (entregas.length > 0) {
      console.log('📋 Campos de data da primeira entrega:', {
        data_hora: entregas[0].data_hora,
        data_solicitado: entregas[0].data_solicitado,
        finalizado: entregas[0].finalizado
      });
    }
    
    // Detectar período das entregas para limpar dados antigos
    let dataMin = null, dataMax = null;
    let datasEncontradas = 0;
    
    for (const e of entregas) {
      // Tentar múltiplos campos de data
      const camposData = [e.data_hora, e.data_solicitado, e.finalizado];
      
      for (const data of camposData) {
        if (data) {
          let d = null;
          
          // Se for número (serial do Excel)
          if (typeof data === 'number') {
            d = new Date((data - 25569) * 86400000);
          }
          // Se for string
          else if (typeof data === 'string') {
            // Tentar formato DD/MM/YYYY
            const match = data.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (match) {
              d = new Date(match[3], match[2] - 1, match[1]);
            } else {
              d = new Date(data);
            }
          }
          // Se já for Date
          else if (data instanceof Date) {
            d = data;
          }
          
          if (d && !isNaN(d.getTime())) {
            datasEncontradas++;
            if (!dataMin || d < dataMin) dataMin = d;
            if (!dataMax || d > dataMax) dataMax = d;
            break; // Já encontrou uma data válida nessa linha
          }
        }
      }
    }
    
    console.log(`📅 Datas encontradas em ${datasEncontradas} de ${entregas.length} linhas`);
    
    // Limpar dados do período antes de inserir (evita duplicatas)
    if (dataMin && dataMax) {
      const dataInicioStr = dataMin.toISOString().split('T')[0];
      const dataFimStr = dataMax.toISOString().split('T')[0];
      console.log(`🧹 Limpando dados existentes de ${dataInicioStr} a ${dataFimStr}...`);
      
      // Limpar por data_hora (TIMESTAMP) ao invés de data_solicitado
      const deleteResult = await pool.query(`
        DELETE FROM bi_entregas 
        WHERE DATE(data_hora) >= $1 AND DATE(data_hora) <= $2
      `, [dataInicioStr, dataFimStr]);
      
      console.log(`🧹 ${deleteResult.rowCount} registros removidos do período`);
    } else {
      console.log(`⚠️ Não foi possível detectar período das datas - nenhum dado será limpo`);
    }
    
    // Buscar configurações de prazo
    const prazosCliente = await pool.query(`
      SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
      FROM bi_prazos_cliente pc
      JOIN bi_faixas_prazo fp ON pc.id = fp.prazo_cliente_id
    `).catch(() => ({ rows: [] }));
    
    const prazoPadrao = await pool.query(`SELECT * FROM bi_prazo_padrao ORDER BY km_min`).catch(() => ({ rows: [] }));
    
    console.log(`📊 Prazos cliente: ${prazosCliente.rows.length}, Prazo padrão: ${prazoPadrao.rows.length} faixas`);
    if (prazoPadrao.rows.length > 0) {
      console.log(`📊 Faixas padrão:`, prazoPadrao.rows.map(f => `${f.km_min}-${f.km_max || '∞'}km=${f.prazo_minutos}min`).join(', '));
    }
    
    // Função para encontrar prazo baseado na distância
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      if (faixas.length === 0) {
        faixas = prazoPadrao.rows;
      }
      for (const faixa of faixas) {
        const kmMin = parseFloat(faixa.km_min) || 0;
        const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
        if (distancia >= kmMin && distancia < kmMax) {
          return parseInt(faixa.prazo_minutos);
        }
      }
      return null;
    };
    
    // Função para converter data/hora do Excel para Date
    const parseDataHora = (valor) => {
      if (!valor) return null;
      // Se for número (serial date do Excel - dias desde 1900)
      if (typeof valor === 'number') {
        // Excel serial date: dias desde 1/1/1900 (com bug do ano 1900)
        const excelEpoch = new Date(1899, 11, 30); // 30/12/1899
        const date = new Date(excelEpoch.getTime() + valor * 86400000);
        return date;
      }
      // Se for string no formato DD/MM/YYYY HH:MM:SS ou DD/MM/YYYY HH:MM
      if (typeof valor === 'string') {
        // Tentar formato DD/MM/YYYY HH:MM:SS
        const regex = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
        const match = valor.match(regex);
        if (match) {
          const [_, dia, mes, ano, hora, min, seg] = match;
          return new Date(ano, mes - 1, dia, hora, min, seg || 0);
        }
        // Tentar ISO
        const d = new Date(valor);
        if (!isNaN(d.getTime())) return d;
      }
      return null;
    };
    
    // Função para calcular tempo de execução em minutos
    // Usa o campo Execução Comp. que já é a diferença em fração de dia
    // OU calcula (Finalizado - Data/Hora) se não tiver Execução Comp.
    const calcularTempoExecucao = (execucaoComp, dataHora, finalizado) => {
      // Se tiver Execução Comp. (fração do dia), usa direto
      if (execucaoComp !== null && execucaoComp !== undefined && execucaoComp !== '') {
        if (typeof execucaoComp === 'number') {
          // Fração do dia -> minutos (0.5 = 12h = 720min)
          return Math.round(execucaoComp * 24 * 60);
        }
        // Se for string HH:MM:SS
        if (typeof execucaoComp === 'string' && execucaoComp.includes(':')) {
          const partes = execucaoComp.split(':');
          if (partes.length >= 2) {
            return (parseInt(partes[0]) || 0) * 60 + (parseInt(partes[1]) || 0);
          }
        }
      }
      
      // Fallback: calcular a partir de Data/Hora e Finalizado
      if (dataHora && finalizado && typeof dataHora === 'number' && typeof finalizado === 'number') {
        const diff = finalizado - dataHora; // diferença em dias
        if (diff >= 0) {
          return Math.round(diff * 24 * 60); // converter para minutos
        }
      }
      
      return null;
    };
    
    // Função para converter data do Excel para formato ISO (só data)
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
    
    // Função para converter timestamp para formato ISO
    const parseTimestamp = (valor) => {
      const d = parseDataHora(valor);
      return d ? d.toISOString() : null;
    };
    
    // Função para limpar número
    const parseNum = (valor) => {
      if (!valor) return null;
      if (typeof valor === 'number') return valor;
      const str = String(valor).replace(',', '.').replace(/[^\d.-]/g, '');
      const num = parseFloat(str);
      return isNaN(num) ? null : num;
    };
    
    let inseridos = 0;
    let atualizados = 0;
    let erros = 0;
    let dentroPrazoCount = 0;
    let foraPrazoCount = 0;
    let linhasIgnoradas = 0;
    let motivosIgnoradas = {};
    
    // Processar em lotes para melhor performance
    const BATCH_SIZE = 500;
    const totalBatches = Math.ceil(entregas.length / BATCH_SIZE);
    
    console.log(`📦 Processando ${entregas.length} linhas em ${totalBatches} lotes de ${BATCH_SIZE}`);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, entregas.length);
      const batch = entregas.slice(start, end);
      
      console.log(`📦 Processando lote ${batchIndex + 1}/${totalBatches} (linhas ${start + 1} a ${end})`);
      
      // Preparar dados do lote
      const dadosLote = [];
      
      for (const e of batch) {
        try {
          const os = parseInt(e.os);
          if (!os) {
            linhasIgnoradas++;
            motivosIgnoradas['OS inválida'] = (motivosIgnoradas['OS inválida'] || 0) + 1;
            continue;
          }
          
          const distancia = parseNum(e.distancia) || 0;
          const prazoMinutos = encontrarPrazo(e.cod_cliente, e.centro_custo, distancia);
          
          // Calcular tempo de execução usando Execução Comp. ou (Finalizado - Data/Hora)
          const tempoExecucao = calcularTempoExecucao(e.execucao_comp, e.data_hora, e.finalizado);
          
          const dentroPrazo = (prazoMinutos !== null && tempoExecucao !== null) ? tempoExecucao <= prazoMinutos : null;
          
          if (dentroPrazo === true) dentroPrazoCount++;
          if (dentroPrazo === false) foraPrazoCount++;
          
          // Extrair número do ponto
          let ponto = parseInt(e.ponto || e.Ponto || e.seq || e.Seq || e.sequencia || e.Sequencia || e.pt || e.Pt || 0) || 0;
          
          // Se não encontrou ponto, tenta extrair do endereço
          if (ponto === 0 && e.endereco) {
            const matchPonto = String(e.endereco).match(/^Ponto\s*(\d+)/i);
            if (matchPonto) {
              ponto = parseInt(matchPonto[1]) || 1;
            }
          }
          
          // Se ainda não tem ponto, usa 1 como padrão
          if (ponto === 0) ponto = 1;
          
          // Função para truncar strings (evita erro de tamanho)
          const truncar = (str, max) => str ? String(str).substring(0, max) : null;
          
          dadosLote.push({
            os,
            ponto,
            num_pedido: truncar(e.num_pedido || e['Num Pedido'] || e['Num pedido'] || e['num pedido'], 100),
            cod_cliente: parseInt(e.cod_cliente || e['Cod Cliente'] || e['Cod cliente'] || e['cod cliente'] || e['Cód Cliente']) || null,
            nome_cliente: truncar(e.nome_cliente || e['Nome cliente'] || e['Nome Cliente'], 255),
            empresa: truncar(e.empresa || e.Empresa, 255),
            nome_fantasia: truncar(e.nome_fantasia || e['Nome Fantasia'] || e['Nome fantasia'], 255),
            centro_custo: truncar(e.centro_custo || e['Centro Custo'] || e['Centro custo'] || e['centro custo'] || e['Centro de Custo'] || e['Centro de custo'] || e.CentroCusto, 255),
            cidade_p1: truncar(e.cidade_p1 || e['Cidade P1'] || e['Cidade p1'], 100),
            endereco: e.endereco || null,
            bairro: truncar(e.bairro, 100),
            cidade: truncar(e.cidade, 100),
            estado: truncar(e.estado, 50),
            cod_prof: parseInt(e.cod_prof) || null,
            nome_prof: truncar(e.nome_prof, 255),
            data_hora: parseTimestamp(e.data_hora),
            finalizado: parseTimestamp(e.finalizado),
            data_solicitado: parseData(e.data_solicitado) || parseData(e.data_hora),
            categoria: truncar(e.categoria, 100),
            valor: parseNum(e.valor),
            distancia: distancia,
            valor_prof: parseNum(e.valor_prof),
            execucao_comp: truncar(e.execucao_comp ? String(e.execucao_comp) : null, 50),
            status: truncar(e.status, 100),
            motivo: truncar(e.motivo, 255),
            ocorrencia: truncar(e.ocorrencia, 255),
            velocidade_media: parseNum(e.velocidade_media),
            dentro_prazo: dentroPrazo,
            prazo_minutos: prazoMinutos,
            tempo_execucao_minutos: tempoExecucao,
            data_upload: data_referencia || new Date().toISOString().split('T')[0]
          });
        } catch (err) {
          linhasIgnoradas++;
          motivosIgnoradas['Erro parsing'] = (motivosIgnoradas['Erro parsing'] || 0) + 1;
        }
      }
      
      // Inserir lote usando INSERT ... ON CONFLICT (UPSERT)
      if (dadosLote.length > 0) {
        try {
          // Construir query de inserção em massa
          const valores = [];
          const params = [];
          let paramIndex = 1;
          
          for (const d of dadosLote) {
            const indices = [];
            for (let i = 0; i < 31; i++) {
              indices.push(`$${paramIndex++}`);
            }
            valores.push(`(${indices.join(',')})`);
            params.push(
              d.os, d.ponto, d.num_pedido, d.cod_cliente, d.nome_cliente, d.empresa,
              d.nome_fantasia, d.centro_custo, d.cidade_p1, d.endereco,
              d.bairro, d.cidade, d.estado, d.cod_prof, d.nome_prof,
              d.data_hora, d.finalizado, d.data_solicitado,
              d.categoria, d.valor, d.distancia, d.valor_prof,
              d.execucao_comp, d.status, d.motivo, d.ocorrencia, d.velocidade_media,
              d.dentro_prazo, d.prazo_minutos, d.tempo_execucao_minutos, d.data_upload
            );
          }
          
          const query = `
            INSERT INTO bi_entregas (
              os, ponto, num_pedido, cod_cliente, nome_cliente, empresa,
              nome_fantasia, centro_custo, cidade_p1, endereco,
              bairro, cidade, estado, cod_prof, nome_prof,
              data_hora, finalizado, data_solicitado,
              categoria, valor, distancia, valor_prof,
              execucao_comp, status, motivo, ocorrencia, velocidade_media,
              dentro_prazo, prazo_minutos, tempo_execucao_minutos, data_upload
            ) VALUES ${valores.join(',')}
          `;
          
          const result = await pool.query(query, params);
          inseridos += dadosLote.length;
          
        } catch (batchErr) {
          console.error(`❌ Erro no lote ${batchIndex + 1}:`, batchErr.message);
          // Se falhar o batch, tenta inserir um por um
          for (const d of dadosLote) {
            try {
              await pool.query(`
                INSERT INTO bi_entregas (
                  os, ponto, num_pedido, cod_cliente, nome_cliente, empresa,
                  nome_fantasia, centro_custo, cidade_p1, endereco,
                  bairro, cidade, estado, cod_prof, nome_prof,
                  data_hora, finalizado, data_solicitado,
                  categoria, valor, distancia, valor_prof,
                  execucao_comp, status, motivo, ocorrencia, velocidade_media,
                  dentro_prazo, prazo_minutos, tempo_execucao_minutos, data_upload
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
              `, [
                d.os, d.ponto, d.num_pedido, d.cod_cliente, d.nome_cliente, d.empresa,
                d.nome_fantasia, d.centro_custo, d.cidade_p1, d.endereco,
                d.bairro, d.cidade, d.estado, d.cod_prof, d.nome_prof,
                d.data_hora, d.finalizado, d.data_solicitado,
                d.categoria, d.valor, d.distancia, d.valor_prof,
                d.execucao_comp, d.status, d.motivo, d.ocorrencia, d.velocidade_media,
                d.dentro_prazo, d.prazo_minutos, d.tempo_execucao_minutos, d.data_upload
              ]);
              inseridos++;
            } catch (singleErr) {
              console.error(`❌ Erro individual OS ${d.os} Ponto ${d.ponto}:`, singleErr.message);
              erros++;
            }
          }
        }
      }
    }
    
    console.log(`✅ Upload concluído: ${inseridos} processados, ${erros} erros, ${linhasIgnoradas} ignoradas`);
    console.log(`📊 Dentro do prazo: ${dentroPrazoCount}, Fora do prazo: ${foraPrazoCount}`);
    if (Object.keys(motivosIgnoradas).length > 0) {
      console.log(`⚠️ Motivos de linhas ignoradas:`, motivosIgnoradas);
    }
    
    res.json({ 
      success: true, 
      inseridos, 
      atualizados, 
      erros, 
      linhasIgnoradas,
      motivosIgnoradas,
      total: entregas.length, 
      dentroPrazo: dentroPrazoCount, 
      foraPrazo: foraPrazoCount 
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
    
    const encontrarPrazo = (codCliente, centroCusto, distancia) => {
      let faixas = prazosCliente.rows.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      if (faixas.length === 0) {
        faixas = prazosCliente.rows.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      if (faixas.length === 0) {
        faixas = prazoPadrao.rows;
      }
      for (const faixa of faixas) {
        const kmMin = parseFloat(faixa.km_min) || 0;
        const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
        if (distancia >= kmMin && distancia < kmMax) {
          return parseInt(faixa.prazo_minutos);
        }
      }
      return null;
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

// Dashboard BI - Métricas gerais COMPLETO
app.get('/api/bi/dashboard', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, cidade } = req.query;
    
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
    if (cidade) {
      where += ` AND cidade = $${paramIndex++}`;
      params.push(cidade);
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
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
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
    let { data_inicio, data_fim, cod_prof, categoria, status_prazo, cidade } = req.query;
    // Suporte a múltiplos clientes e centros de custo
    let cod_cliente = req.query.cod_cliente;
    let centro_custo = req.query.centro_custo;
    
    // Converter para array se necessário
    if (cod_cliente && !Array.isArray(cod_cliente)) cod_cliente = [cod_cliente];
    if (centro_custo && !Array.isArray(centro_custo)) centro_custo = [centro_custo];
    
    console.log('📊 Dashboard-completo:', { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof });
    
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
    // Múltiplos centros de custo
    if (centro_custo && centro_custo.length > 0) { 
      where += ` AND centro_custo = ANY($${paramIndex++}::text[])`; 
      params.push(centro_custo); 
    }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    
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
    
    // Buscar todos os dados filtrados
    const dadosQuery = await pool.query(`
      SELECT os, COALESCE(ponto, 1) as ponto, cod_cliente, nome_cliente, 
        cod_prof, nome_prof, dentro_prazo, tempo_execucao_minutos,
        valor, valor_prof, distancia, ocorrencia, centro_custo, motivo, finalizado
      FROM bi_entregas ${where}
    `, params);
    
    const dados = dadosQuery.rows;
    console.log('📊 Total registros retornados:', dados.length);
    
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
    let somaValor = 0, somaValorProf = 0, somaTempoExec = 0, countTempoExec = 0;
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
        });
        
        // REGRA UNIVERSAL: métricas apenas das linhas com ponto >= 2 (entregas)
        const linhasEntrega = linhasOS.filter(l => parseInt(l.ponto) >= 2);
        
        // Para prazo: processa todas as linhas de entrega
        const processarPrazo = (l) => {
          if (l.dentro_prazo === true) dentroPrazo++;
          else if (l.dentro_prazo === false) foraPrazo++;
          else semPrazo++; // null ou undefined
          
          if (l.tempo_execucao_minutos != null) {
            somaTempoExec += parseFloat(l.tempo_execucao_minutos);
            countTempoExec++;
          }
        };
        
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
    
    const metricas = {
      total_os: totalOS.size,
      total_entregas: totalEntregas,
      dentro_prazo: dentroPrazo,
      fora_prazo: foraPrazo,
      sem_prazo: semPrazo,
      tempo_medio: countTempoExec > 0 ? (somaTempoExec / countTempoExec).toFixed(2) : 0,
      valor_total: somaValor.toFixed(2),
      valor_prof_total: somaValorProf.toFixed(2),
      ticket_medio: totalEntregas > 0 ? (somaValor / totalEntregas).toFixed(2) : 0,
      total_profissionais: profissionais.size,
      media_entregas_por_prof: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      total_retornos: totalRetornos,
      incentivo: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      ultima_entrega: ultimaEntrega ? ultimaEntrega.toISOString() : null
    };
    
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
          soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0,
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
      
      Object.keys(osDoCliente).forEach(os => {
        const linhasOS = osDoCliente[os];
        c.os_set.add(os);
        
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
        
        // Centro de custo para valores - pega do linhaValor
        const ccValor = linhaValor?.centro_custo || 'Sem Centro';
        if (!c.centros_custo_map[ccValor]) {
          c.centros_custo_map[ccValor] = {
            centro_custo: ccValor,
            os_set: new Set(),
            total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
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
          
          if (l.tempo_execucao_minutos != null) {
            c.soma_tempo += parseFloat(l.tempo_execucao_minutos);
            c.count_tempo++;
          }
          
          // Agrupar por centro de custo (prazo e entregas)
          const cc = l.centro_custo || 'Sem Centro';
          if (!c.centros_custo_map[cc]) {
            c.centros_custo_map[cc] = {
              centro_custo: cc,
              os_set: new Set(),
              total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
              soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0
            };
          }
          const ccData = c.centros_custo_map[cc];
          ccData.total_entregas++;
          if (l.dentro_prazo === true) ccData.dentro_prazo++;
          else if (l.dentro_prazo === false) ccData.fora_prazo++;
          else ccData.sem_prazo++;
          if (l.tempo_execucao_minutos != null) {
            ccData.soma_tempo += parseFloat(l.tempo_execucao_minutos);
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
      // Converter centros_custo_map em array com dados
      const centros_custo_dados = Object.values(c.centros_custo_map).map(cc => ({
        centro_custo: cc.centro_custo,
        total_os: cc.os_set.size,
        total_entregas: cc.total_entregas,
        total_retornos: cc.total_retornos,
        dentro_prazo: cc.dentro_prazo,
        fora_prazo: cc.fora_prazo,
        sem_prazo: cc.sem_prazo,
        tempo_medio: cc.count_tempo > 0 ? (cc.soma_tempo / cc.count_tempo).toFixed(2) : null,
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
        centros_custo: centros_custo_dados, // Agora é array com dados completos
        dentro_prazo: c.dentro_prazo, fora_prazo: c.fora_prazo, sem_prazo: c.sem_prazo,
        tempo_medio: c.count_tempo > 0 ? (c.soma_tempo / c.count_tempo).toFixed(2) : null,
        valor_total: c.soma_valor.toFixed(2), valor_prof: c.soma_valor_prof.toFixed(2),
        // Novas métricas
        ticket_medio: ticketMedio.toFixed(2),
        total_profissionais: totalProfs,
        entregas_por_prof: incentivo.toFixed(2),
        incentivo: incentivo.toFixed(2),
        total_retornos: c.total_retornos,
        ultima_entrega: c.ultima_entrega ? c.ultima_entrega.toISOString() : null
      };
    }).sort((a, b) => b.total_entregas - a.total_entregas);
    
    // Log centros de custo encontrados
    console.log('📁 CENTROS DE CUSTO POR CLIENTE:');
    porCliente.forEach(c => {
      console.log(`   - ${c.cod_cliente}: ${c.centros_custo.length} centros -> [${c.centros_custo.join(', ')}]`);
    });
    
    // Log resultado por cliente
    console.log('📊 RESULTADO POR CLIENTE:');
    porCliente.forEach(c => {
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
    
    Object.keys(osPorProf).forEach(codProf => {
      const osDoProf = osPorProf[codProf];
      
      if (!porProfMap[codProf]) {
        const primeiraLinha = Object.values(osDoProf)[0].linhas[0];
        porProfMap[codProf] = {
          cod_prof: primeiraLinha.cod_prof,
          nome_prof: primeiraLinha.nome_prof,
          total_entregas: 0, dentro_prazo: 0, fora_prazo: 0,
          soma_tempo: 0, count_tempo: 0, soma_dist: 0, soma_valor_prof: 0, retornos: 0
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
      
      Object.keys(osDoProf).forEach(os => {
        const { codCliente, linhas } = osDoProf[os];
        const entregasOS = calcularEntregasOS(linhas);
        p.total_entregas += entregasOS;
        
        // Contagem de retornos (ocorrência indica problema) - TODAS as linhas
        linhas.forEach(l => {
          if (isRetornoProf(l.ocorrencia)) p.retornos++;
        });
        
        // REGRA UNIVERSAL: métricas apenas das entregas (ponto >= 2)
        const linhasEntrega = linhas.filter(l => parseInt(l.ponto) >= 2);
        
        if (linhasEntrega.length > 0) {
          linhasEntrega.forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            if (l.tempo_execucao_minutos != null) {
              p.soma_tempo += parseFloat(l.tempo_execucao_minutos);
              p.count_tempo++;
            }
          });
        } else if (linhas.length > 1) {
          linhas.slice(1).forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            if (l.tempo_execucao_minutos != null) {
              p.soma_tempo += parseFloat(l.tempo_execucao_minutos);
              p.count_tempo++;
            }
          });
        } else {
          const l = linhas[0];
          if (l.dentro_prazo === true) p.dentro_prazo++;
          else if (l.dentro_prazo === false) p.fora_prazo++;
          p.soma_dist += parseFloat(l.distancia) || 0;
          p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
          if (l.tempo_execucao_minutos != null) {
            p.soma_tempo += parseFloat(l.tempo_execucao_minutos);
            p.count_tempo++;
          }
        }
      });
    });
    
    const porProfissional = Object.values(porProfMap).map(p => ({
      cod_prof: p.cod_prof, nome_prof: p.nome_prof,
      total_entregas: p.total_entregas, dentro_prazo: p.dentro_prazo, fora_prazo: p.fora_prazo,
      tempo_medio: p.count_tempo > 0 ? (p.soma_tempo / p.count_tempo).toFixed(2) : null,
      distancia_total: p.soma_dist.toFixed(2), valor_prof: p.soma_valor_prof.toFixed(2),
      retornos: p.retornos
    })).sort((a, b) => b.total_entregas - a.total_entregas);
    
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


// Lista de entregas detalhada (para análise por OS)
app.get('/api/bi/entregas-lista', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, cidade } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // Converter datas ISO para YYYY-MM-DD
    if (data_inicio) { 
      const dataIni = data_inicio.split('T')[0];
      where += ` AND data_solicitado >= $${paramIndex++}`; 
      params.push(dataIni); 
    }
    if (data_fim) { 
      const dataFim = data_fim.split('T')[0];
      where += ` AND data_solicitado <= $${paramIndex++}`; 
      params.push(dataFim); 
    }
    if (cod_cliente) { where += ` AND cod_cliente = $${paramIndex++}`; params.push(cod_cliente); }
    if (centro_custo) { where += ` AND centro_custo = $${paramIndex++}`; params.push(centro_custo); }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    
    const result = await pool.query(`
      SELECT 
        os,
        nome_prof,
        endereco,
        cidade,
        data_solicitado,
        data_hora,
        finalizado,
        distancia,
        dentro_prazo,
        tempo_execucao_minutos,
        prazo_minutos,
        valor,
        valor_prof,
        categoria,
        ocorrencia,
        status
      FROM bi_entregas ${where}
      ORDER BY data_hora DESC
      LIMIT 500
    `, params);
    
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
app.get('/api/bi/uploads', async (req, res) => {
  try {
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
    res.json({ success: true, deletados: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao excluir upload:', err);
    res.status(500).json({ error: 'Erro ao excluir upload' });
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
    
    if (grupo_id) {
      query += ` AND t.grupo_id = $${paramIndex}`;
      params.push(grupo_id);
      paramIndex++;
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
    
    if (role !== 'admin_master') {
      query += ` AND (
        t.tipo = 'compartilhado' 
        OR t.criado_por = '${user_cod}'
        OR t.responsaveis @> '[{"user_cod":"${user_cod}"}]'
      )`;
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

// Criar tarefa
app.post('/api/todo/tarefas', async (req, res) => {
  try {
    const { 
      grupo_id, titulo, descricao, prioridade, data_prazo, 
      recorrente, tipo_recorrencia, tipo, 
      criado_por, criado_por_nome, responsaveis 
    } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_tarefas (
        grupo_id, titulo, descricao, prioridade, data_prazo,
        recorrente, tipo_recorrencia, tipo,
        criado_por, criado_por_nome, responsaveis
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      grupo_id, titulo, descricao, prioridade || 'media', data_prazo,
      recorrente || false, tipo_recorrencia, tipo || 'compartilhado',
      criado_por, criado_por_nome, JSON.stringify(responsaveis || [])
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
      recorrente, tipo_recorrencia, responsaveis,
      user_cod, user_name
    } = req.body;
    
    const anterior = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    
    let concluido_por = null;
    let concluido_por_nome = null;
    let data_conclusao = null;
    
    if (status === 'concluida' && anterior.rows[0]?.status !== 'concluida') {
      concluido_por = user_cod;
      concluido_por_nome = user_name;
      data_conclusao = new Date();
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
          responsaveis = COALESCE($8, responsaveis),
          concluido_por = COALESCE($9, concluido_por),
          concluido_por_nome = COALESCE($10, concluido_por_nome),
          data_conclusao = COALESCE($11, data_conclusao),
          updated_at = NOW()
      WHERE id = $12
      RETURNING *
    `, [
      titulo, descricao, status, prioridade, data_prazo,
      recorrente, tipo_recorrencia, responsaveis ? JSON.stringify(responsaveis) : null,
      concluido_por, concluido_por_nome, data_conclusao, id
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
      let proximoPrazo = new Date(tarefa.data_prazo || new Date());
      
      switch (tarefa.tipo_recorrencia) {
        case 'diario':
          proximoPrazo.setDate(proximoPrazo.getDate() + 1);
          break;
        case 'semanal':
          proximoPrazo.setDate(proximoPrazo.getDate() + 7);
          break;
        case 'mensal':
          proximoPrazo.setMonth(proximoPrazo.getMonth() + 1);
          break;
      }
      
      await pool.query(`
        INSERT INTO todo_tarefas (
          grupo_id, titulo, descricao, prioridade, data_prazo,
          recorrente, tipo_recorrencia, tipo,
          criado_por, criado_por_nome, responsaveis
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        tarefa.grupo_id, tarefa.titulo, tarefa.descricao, tarefa.prioridade, proximoPrazo,
        true, tarefa.tipo_recorrencia, tarefa.tipo,
        tarefa.criado_por, tarefa.criado_por_nome, tarefa.responsaveis
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
    const result = await pool.query(`
      SELECT cod_profissional as cod, full_name as nome 
      FROM users 
      WHERE role IN ('admin', 'admin_master')
      ORDER BY full_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar admins:', err);
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
    
    // Mapear coluna para status
    let status = 'pendente';
    if (coluna_kanban === 'doing') status = 'em_andamento';
    else if (coluna_kanban === 'done') status = 'concluida';
    
    const updateData = {
      coluna_kanban,
      status,
      updated_at: new Date()
    };
    
    if (status === 'concluida') {
      updateData.concluido_por = user_cod;
      updateData.concluido_por_nome = user_name;
      updateData.data_conclusao = new Date();
    }
    
    await pool.query(`
      UPDATE todo_tarefas 
      SET coluna_kanban = $1, 
          status = $2, 
          ordem = COALESCE($3, ordem),
          concluido_por = CASE WHEN $2 = 'concluida' THEN $4 ELSE concluido_por END,
          concluido_por_nome = CASE WHEN $2 = 'concluida' THEN $5 ELSE concluido_por_nome END,
          data_conclusao = CASE WHEN $2 = 'concluida' THEN NOW() ELSE data_conclusao END,
          updated_at = NOW()
      WHERE id = $6
    `, [coluna_kanban, status, ordem, user_cod, user_name, id]);
    
    // Registrar no histórico
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'movida', $2, $3, $4)
    `, [id, `Movida para ${coluna_kanban}`, user_cod, user_name]);
    
    const result = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao mover tarefa no kanban:', err);
    res.status(500).json({ error: 'Erro ao mover tarefa' });
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

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`📡 API: http://localhost:${port}/api/health`);
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

// Criar região
app.post('/api/bi/regioes', async (req, res) => {
  try {
    const { nome, clientes } = req.body;
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    const result = await pool.query(`
      INSERT INTO bi_regioes (nome, clientes) 
      VALUES ($1, $2)
      RETURNING *
    `, [nome, JSON.stringify(clientes || [])]);
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar região:', err);
    res.status(500).json({ error: 'Erro ao salvar região' });
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
