const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// Configuração do banco de dados
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API funcionando' });
});

// USUÁRIOS
// Registrar novo usuário
app.post('/api/users/register', async (req, res) => {
  try {
    const { codProfissional, password, fullName } = req.body;

    // Verificar se usuário já existe
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Código profissional já cadastrado' });
    }

    // Inserir novo usuário
    const result = await pool.query(
      `INSERT INTO users (cod_profissional, password, full_name, role, created_at) 
       VALUES ($1, $2, $3, 'user', NOW()) 
       RETURNING id, cod_profissional, full_name, role, created_at`,
      [codProfissional, password, fullName]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao registrar usuário:', error);
    res.status(500).json({ error: 'Erro ao registrar usuário' });
  }
});

// Login
app.post('/api/users/login', async (req, res) => {
  try {
    const { codProfissional, password } = req.body;

    // Admin hardcoded
    if (codProfissional.toLowerCase() === 'admin' && password === 'admin123') {
      return res.json({
        id: 0,
        cod_profissional: 'admin',
        full_name: 'Administrador',
        role: 'admin'
      });
    }

    // Buscar usuário
    const result = await pool.query(
      'SELECT id, cod_profissional, full_name, role, password FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (result.rows.length === 0 || result.rows[0].password !== password) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = result.rows[0];
    delete user.password; // Remover senha da resposta

    res.json(user);
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Listar todos os usuários (apenas admin)
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, cod_profissional, full_name, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// SUBMISSÕES
// Criar submissão
app.post('/api/submissions', async (req, res) => {
  try {
    const { ordemServico, motivo, userId, userCod, userName, imagemComprovante } = req.body;

    const result = await pool.query(
      `INSERT INTO submissions (ordem_servico, motivo, status, user_id, user_cod, user_name, imagem_comprovante, created_at) 
       VALUES ($1, $2, 'pendente', $3, $4, $5, $6, NOW()) 
       RETURNING *`,
      [ordemServico, motivo, userId, userCod, userName, imagemComprovante]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar submissão:', error);
    res.status(500).json({ error: 'Erro ao criar submissão' });
  }
});

// Listar todas as submissões
app.get('/api/submissions', async (req, res) => {
  try {
    const { userId, userCod } = req.query;

    let query = 'SELECT * FROM submissions ORDER BY created_at DESC';
    let params = [];

    if (userId && userId !== '0') {
      query = 'SELECT * FROM submissions WHERE user_cod = $1 ORDER BY created_at DESC';
      params = [userCod];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar submissões:', error);
    res.status(500).json({ error: 'Erro ao listar submissões' });
  }
});

// Atualizar status da submissão
app.patch('/api/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, observacao } = req.body;

    const result = await pool.query(
      'UPDATE submissions SET status = $1, observacao = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, observacao || '', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar submissão:', error);
    res.status(500).json({ error: 'Erro ao atualizar submissão' });
  }
});

// NOTIFICAÇÕES
// Criar notificação
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
    console.error('Erro ao criar notificação:', error);
    res.status(500).json({ error: 'Erro ao criar notificação' });
  }
});

// Listar notificações do usuário
app.get('/api/notifications/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;

    const result = await pool.query(
      'SELECT * FROM notifications WHERE for_user = $1 OR for_user = \'admin\' ORDER BY created_at DESC LIMIT 50',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar notificações:', error);
    res.status(500).json({ error: 'Erro ao listar notificações' });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`📍 API: http://localhost:${port}/api/health`);
});
