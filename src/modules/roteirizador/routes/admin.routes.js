const express = require('express');
function createAdminRoteirizadorRouter(pool, verificarToken) {
  const router = express.Router();

  // Criar usuário do roteirizador
  router.post('/', verificarToken, async (req, res) => {
    try {
      const { nome, email, senha, telefone, empresa, observacoes } = req.body;
      
      if (!nome || !email || !senha) {
        return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
      }
      
      // Verificar se email já existe
      const existente = await pool.query(
        'SELECT id FROM usuarios_roteirizador WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      
      if (existente.rows.length > 0) {
        return res.status(400).json({ error: 'Email já cadastrado' });
      }
      
      const senha_hash = await bcrypt.hash(senha, 10);
      
      const result = await pool.query(
        `INSERT INTO usuarios_roteirizador (nome, email, senha_hash, telefone, empresa, observacoes, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, nome, email, telefone, empresa, ativo, created_at`,
        [nome, email.toLowerCase().trim(), senha_hash, telefone, empresa, observacoes, req.user?.nome || 'admin']
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar usuário roteirizador:', err);
      res.status(500).json({ error: 'Erro ao criar usuário' });
    }
  });

  // Listar usuários
  router.get('/', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, nome, email, telefone, empresa, ativo, ultimo_acesso, created_at,
               (SELECT COUNT(*) FROM rotas_historico WHERE usuario_id = usuarios_roteirizador.id) as total_rotas
        FROM usuarios_roteirizador 
        ORDER BY created_at DESC
      `);
      
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar usuários:', err);
      res.status(500).json({ error: 'Erro ao listar usuários' });
    }
  });

  // Ativar/desativar usuário
  router.patch('/:id/ativo', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { ativo } = req.body;
      
      const result = await pool.query(
        'UPDATE usuarios_roteirizador SET ativo = $1 WHERE id = $2 RETURNING id, nome, email, ativo',
        [ativo, id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar status:', err);
      res.status(500).json({ error: 'Erro ao atualizar status' });
    }
  });

  // Resetar senha
  router.patch('/:id/senha', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { nova_senha } = req.body;
      
      if (!nova_senha || nova_senha.length < 4) {
        return res.status(400).json({ error: 'Senha deve ter no mínimo 4 caracteres' });
      }
      
      const senha_hash = await bcrypt.hash(nova_senha, 10);
      
      const result = await pool.query(
        'UPDATE usuarios_roteirizador SET senha_hash = $1 WHERE id = $2 RETURNING id, nome, email',
        [senha_hash, id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      
      res.json({ ...result.rows[0], mensagem: 'Senha atualizada com sucesso' });
    } catch (err) {
      console.error('❌ Erro ao resetar senha:', err);
      res.status(500).json({ error: 'Erro ao resetar senha' });
    }
  });

  return router;
}
module.exports = { createAdminRoteirizadorRouter };
