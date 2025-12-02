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
        resolved_by VARCHAR(255)
      )
    `);
    console.log('✅ Tabela indicacoes verificada');

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

    // ============================================
    // TABELAS DE DISPONIBILIDADE
    // ============================================
    
    // Tabela de Regiões de Disponibilidade
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disponibilidade_regioes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migração: adicionar colunas se não existirem
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS is_excedente BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE disponibilidade_linhas ADD COLUMN IF NOT EXISTS is_reposicao BOOLEAN DEFAULT FALSE`).catch(() => {});
    console.log('✅ Tabela disponibilidade_linhas verificada');

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

    // Índices para performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_lojas_regiao ON disponibilidade_lojas(regiao_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_linhas_loja ON disponibilidade_linhas(loja_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_disp_linhas_cod ON disponibilidade_linhas(cod_profissional)`).catch(() => {});

    console.log('✅ Todas as tabelas verificadas/criadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error.message);
  }
}

// Middlewares - CORS configurado
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://tutts.vercel.app',
    'https://tutts-frontend.vercel.app'
  ],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check
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
      'SELECT id, cod_profissional, full_name, role, password FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
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
      'DELETE FROM withdrawals WHERE LOWER(user_cod) = LOWER($1)',
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

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET status = $1, admin_id = $2, admin_name = $3, reject_reason = $4, updated_at = NOW() 
       WHERE id = $5 
       RETURNING *`,
      [status, adminId, adminName, rejectReason || null, id]
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
    const { nome, ordem } = req.body;
    
    const result = await pool.query(
      `UPDATE disponibilidade_regioes 
       SET nome = COALESCE($1, nome), ordem = COALESCE($2, ordem), updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [nome ? nome.toUpperCase().trim() : null, ordem, id]
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
    const { cod_profissional, nome_profissional, status, observacao } = req.body;
    
    // Validar status
    const statusValidos = ['A CONFIRMAR', 'CONFIRMADO', 'EM LOJA', 'FALTANDO'];
    const statusFinal = statusValidos.includes(status) ? status : 'A CONFIRMAR';
    
    const result = await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = $1, 
           nome_profissional = $2, 
           status = $3, 
           observacao = $4, 
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [
        cod_profissional || null, 
        nome_profissional || null, 
        statusFinal, 
        observacao || null, 
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
    const { loja_id, cod_profissional, nome_profissional, motivo } = req.body;
    
    if (!loja_id || !motivo) {
      return res.status(400).json({ error: 'Campos obrigatórios: loja_id, motivo' });
    }
    
    const result = await pool.query(
      `INSERT INTO disponibilidade_faltosos (loja_id, cod_profissional, nome_profissional, motivo)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [loja_id, cod_profissional || null, nome_profissional || null, motivo]
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

// POST /api/disponibilidade/resetar - Resetar status (com salvamento de espelho)
app.post('/api/disponibilidade/resetar', async (req, res) => {
  try {
    // 1. Salvar espelho antes de resetar
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      salvo_em: new Date().toISOString()
    };
    
    const hoje = new Date().toISOString().split('T')[0];
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [hoje]
    );
    
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1 WHERE data_registro = $2',
        [JSON.stringify(dados), hoje]
      );
    } else {
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [hoje, JSON.stringify(dados)]
      );
    }
    console.log('📸 Espelho salvo antes do reset');
    
    // 2. Converter linhas de reposição em excedentes
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET is_excedente = true, is_reposicao = false 
       WHERE is_reposicao = true`
    );
    
    // 3. Resetar todas as linhas
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = NULL, 
           nome_profissional = NULL, 
           status = 'A CONFIRMAR', 
           observacao = NULL,
           updated_at = CURRENT_TIMESTAMP`
    );
    
    console.log('🔄 Status resetado com sucesso');
    res.json({ success: true, espelho_data: hoje });
  } catch (err) {
    console.error('❌ Erro ao resetar:', err);
    res.status(500).json({ error: 'Erro ao resetar status' });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`📡 API: http://localhost:${port}/api/health`);
});
