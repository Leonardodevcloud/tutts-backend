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
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API funcionando' });
});

// USUÁRIOS
// Registrar novo usuário
app.post('/api/users/register', async (req, res) => {
  try {
    const { codProfissional, password, fullName, role } = req.body;

    console.log('📝 Tentando registrar:', { codProfissional, fullName, role });

    // Verificar se usuário já existe
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(cod_profissional) = LOWER($1)',
      [codProfissional]
    );

    if (existingUser.rows.length > 0) {
      console.log('⚠️ Código profissional já existe');
      return res.status(400).json({ error: 'Código profissional já cadastrado' });
    }

    // Inserir novo usuário (role pode ser 'user' ou 'admin')
    const userRole = role === 'admin' ? 'admin' : 'user';
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
      'SELECT id, cod_profissional, full_name, role, created_at FROM users ORDER BY created_at DESC'
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

// Deletar usuário (apenas admin)
app.delete('/api/users/:codProfissional', async (req, res) => {
  try {
    const { codProfissional } = req.params;

    console.log('🗑️ Deletando usuário:', codProfissional);

    const result = await pool.query(
      'DELETE FROM users WHERE LOWER(cod_profissional) = LOWER($1) RETURNING *',
      [codProfissional]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    console.log('✅ Usuário deletado:', result.rows[0].full_name);
    res.json({ message: 'Usuário excluído com sucesso', deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar usuário:', error);
    res.status(500).json({ error: 'Erro ao deletar usuário: ' + error.message });
  }
});

// SUBMISSÕES
// Criar submissão
app.post('/api/submissions', async (req, res) => {
  try {
    const { ordemServico, motivo, userId, userCod, userName, imagemComprovante, imagens, coordenadas } = req.body;

    console.log('📝 Criando submissão:', {
      ordemServico,
      userId,
      temImagemAntiga: !!imagemComprovante,
      temImagensNovas: !!imagens,
      tamanhoImagens: imagens ? imagens.length : 0
    });

    const result = await pool.query(
      `INSERT INTO submissions 
       (ordem_servico, motivo, status, user_id, user_cod, user_name, 
        imagem_comprovante, imagens, coordenadas, created_at) 
       VALUES ($1, $2, 'pendente', $3, $4, $5, $6, $7, $8, NOW()) 
       RETURNING *`,
      [ordemServico, motivo, userId, userCod, userName, imagemComprovante, imagens, coordenadas]
    );

    console.log('✅ Submissão criada:', {
      id: result.rows[0].id,
      ordem_servico: result.rows[0].ordem_servico,
      temImagens: !!result.rows[0].imagens
    });

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

    let query = `
      SELECT 
        id, ordem_servico, motivo, status, 
        user_id, user_cod, user_name,
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
    
    console.log('📋 Listando submissões:', {
      total: result.rows.length,
      comImagens: result.rows.filter(r => r.imagens).length,
      comImagemAntiga: result.rows.filter(r => r.imagem_comprovante).length
    });

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar submissões:', error);
    res.status(500).json({ error: 'Erro ao listar submissões: ' + error.message });
  }
});

// Buscar imagens de uma submissão específica (otimização de banda)
app.get('/api/submissions/:id/images', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('📸 Buscando imagens da OS:', id);
    
    const result = await pool.query(
      'SELECT imagens, imagem_comprovante FROM submissions WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }
    
    const row = result.rows[0];
    let imagensArray = [];
    
    console.log('🔍 DEBUG - Tipo de imagens:', typeof row.imagens);
    console.log('🔍 DEBUG - Primeiros 200 chars:', row.imagens ? String(row.imagens).substring(0, 200) : 'null');
    
    // Converter string CSV em array
    if (row.imagens) {
      if (typeof row.imagens === 'string') {
        // String CSV → Array
        const parts = row.imagens.split(',');
        console.log('🔍 DEBUG - Split resultou em', parts.length, 'partes');
        
        imagensArray = parts
          .map(img => img.trim())
          .filter(img => img.length > 50); // Imagens base64 são grandes
        
        console.log('🔄 Convertido string→array:', imagensArray.length, 'imagens');
      } else if (Array.isArray(row.imagens)) {
        // Já é array
        imagensArray = row.imagens.filter(img => img && img.length > 50);
        console.log('✅ Já era array:', imagensArray.length, 'imagens');
      } else {
        console.log('⚠️ Tipo desconhecido:', typeof row.imagens);
      }
    } else {
      console.log('⚠️ Nenhuma imagem encontrada (null/undefined)');
    }
    
    console.log('📤 Retornando:', imagensArray.length, 'imagens');
    
    res.json({
      imagens: imagensArray,
      imagemComprovante: row.imagem_comprovante || null
    });
  } catch (error) {
    console.error('❌ Erro ao buscar imagens:', error);
    res.status(500).json({ error: 'Erro ao buscar imagens: ' + error.message });
  }
});

// Atualizar status da submissão
app.patch('/api/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, observacao, validatedBy, validatedByName } = req.body;

    console.log('✏️ Atualizando submissão:', { id, status, validatedBy, validatedByName });

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

    console.log('✅ Submissão atualizada:', {
      id: result.rows[0].id,
      status: result.rows[0].status,
      validatedBy: result.rows[0].validated_by_name
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar submissão:', error);
    res.status(500).json({ error: 'Erro ao atualizar submissão: ' + error.message });
  }
});

// Deletar submissão
app.delete('/api/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    console.log('🗑️ Deletando submissão:', id);

    const result = await pool.query(
      'DELETE FROM submissions WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    console.log('✅ Submissão deletada:', result.rows[0].ordem_servico);
    res.json({ message: 'Submissão excluída com sucesso', deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar submissão:', error);
    res.status(500).json({ error: 'Erro ao deletar submissão: ' + error.message });
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
