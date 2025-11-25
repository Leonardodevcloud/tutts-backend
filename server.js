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

// Testar conexão
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Erro ao conectar no banco:', err.message);
  } else {
    console.log('✅ Banco de dados conectado!', res.rows[0].now);
  }
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

    console.log('📝 Tentando registrar:', { codProfissional, fullName });

    // Verificar se usuário já existe
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (existingUser.rows.length > 0) {
      console.log('⚠️ Código profissional já existe');
      return res.status(400).json({ error: 'Código profissional já cadastrado' });
    }

    // Inserir novo usuário
    const result = await pool.query(
      `INSERT INTO users (cod_profissional, password, full_name, role, created_at) 
       VALUES ($1, $2, $3, 'user', NOW()) 
       RETURNING id, cod_profissional, full_name, role, created_at`,
      [codProfissional, password, fullName]
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

    // Buscar usuário
    const result = await pool.query(
      'SELECT id, cod_profissional, full_name, role, password FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (result.rows.length === 0 || result.rows[0].password !== password) {
      console.log('❌ Credenciais inválidas');
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = result.rows[0];
    delete user.password; // Remover senha da resposta

    console.log('✅ Login bem-sucedido:', user.cod_profissional);
    res.json(user);
  } catch (error) {
    console.error('❌ Erro ao fazer login:', error);
    res.status(500).json({ error: 'Erro ao fazer login: ' + error.message });
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
    console.error('❌ Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários: ' + error.message });
  }
});

// Resetar senha de usuário (apenas admin)
app.post('/api/users/reset-password', async (req, res) => {
  try {
    const { codProfissional, newPassword } = req.body;

    console.log('🔑 Resetando senha para:', codProfissional);

    const result = await pool.query(
      'UPDATE users SET password = $1 WHERE LOWER(cod_profissional) = LOWER($2) RETURNING id, cod_profissional, full_name',
      [newPassword, codProfissional]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    console.log('✅ Senha resetada:', result.rows[0]);
    res.json({ message: 'Senha alterada com sucesso', user: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao resetar senha:', error);
    res.status(500).json({ error: 'Erro ao resetar senha: ' + error.message });
  }
});

// SUBMISSÕES
// Criar submissão
app.post('/api/submissions', async (req, res) => {
  try {
    const { ordemServico, motivo, userId, userCod, userName, imagemComprovante, coordenadas } = req.body;

    const result = await pool.query(
      `INSERT INTO submissions (ordem_servico, motivo, status, user_id, user_cod, user_name, imagem_comprovante, coordenadas, created_at) 
       VALUES ($1, $2, 'pendente', $3, $4, $5, $6, $7, NOW()) 
       RETURNING *`,
      [ordemServico, motivo, userId, userCod, userName, imagemComprovante, coordenadas]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar submissão:', error);
    res.status(500).json({ error: 'Erro ao criar submissão: ' + error.message });
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
    console.error('❌ Erro ao listar submissões:', error);
    res.status(500).json({ error: 'Erro ao listar submissões: ' + error.message });
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
    console.error('❌ Erro ao atualizar submissão:', error);
    res.status(500).json({ error: 'Erro ao atualizar submissão: ' + error.message });
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
    console.error('❌ Erro ao criar notificação:', error);
    res.status(500).json({ error: 'Erro ao criar notificação: ' + error.message });
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
    console.error('❌ Erro ao listar notificações:', error);
    res.status(500).json({ error: 'Erro ao listar notificações: ' + error.message });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`🔗 API: http://localhost:${port}/api/health`);
});
