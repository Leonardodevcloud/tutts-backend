const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
function createRoteirizadorRouter(pool, verificarToken) {
  const router = express.Router();
  const JWT_SECRET = process.env.JWT_SECRET;

  // Middleware para verificar token do roteirizador
  const verificarTokenRoteirizador = async (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      if (decoded.tipo !== 'roteirizador') {
        return res.status(401).json({ error: 'Token inválido para roteirizador' });
      }
      
      const usuario = await pool.query(
        'SELECT id, nome, email, ativo FROM usuarios_roteirizador WHERE id = $1',
        [decoded.id]
      );
      
      if (usuario.rows.length === 0 || !usuario.rows[0].ativo) {
        return res.status(401).json({ error: 'Usuário inativo ou não encontrado' });
      }
      
      req.usuarioRoteirizador = usuario.rows[0];
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
  };

  // Login do roteirizador
  router.post('/login', async (req, res) => {
    try {
      const { email, senha } = req.body;
      
      if (!email || !senha) {
        return res.status(400).json({ error: 'Email e senha são obrigatórios' });
      }
      
      const result = await pool.query(
        'SELECT id, nome, email, senha_hash, ativo, empresa FROM usuarios_roteirizador WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Email ou senha incorretos' });
      }
      
      const usuario = result.rows[0];
      
      if (!usuario.ativo) {
        return res.status(403).json({ error: 'Conta desativada. Entre em contato com o administrador.' });
      }
      
      const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
      if (!senhaValida) {
        return res.status(401).json({ error: 'Email ou senha incorretos' });
      }
      
      // Atualizar último acesso
      await pool.query(
        'UPDATE usuarios_roteirizador SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = $1',
        [usuario.id]
      );
      
      const token = jwt.sign(
        { id: usuario.id, email: usuario.email, tipo: 'roteirizador' },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      res.json({
        token,
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          empresa: usuario.empresa
        }
      });
    } catch (err) {
      console.error('❌ Erro login roteirizador:', err);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // Verificar token
  router.get('/verificar', verificarTokenRoteirizador, (req, res) => {
    res.json({
      valido: true,
      usuario: req.usuarioRoteirizador
    });
  });

  // Salvar rota no histórico
  router.post('/rotas', verificarTokenRoteirizador, async (req, res) => {
    try {
      const { nome, origem, destinos, rota_otimizada, distancia_total, tempo_total } = req.body;
      
      const result = await pool.query(
        `INSERT INTO rotas_historico 
         (usuario_id, nome, origem, destinos, rota_otimizada, distancia_total, tempo_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          req.usuarioRoteirizador.id,
          nome || `Rota ${new Date().toLocaleDateString('pt-BR')}`,
          origem,
          JSON.stringify(destinos),
          JSON.stringify(rota_otimizada),
          distancia_total,
          tempo_total
        ]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao salvar rota:', err);
      res.status(500).json({ error: 'Erro ao salvar rota' });
    }
  });

  // Listar histórico de rotas
  router.get('/rotas', verificarTokenRoteirizador, async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      
      const result = await pool.query(
        `SELECT id, nome, origem, distancia_total, tempo_total, created_at 
         FROM rotas_historico 
         WHERE usuario_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2 OFFSET $3`,
        [req.usuarioRoteirizador.id, limit, offset]
      );
      
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM rotas_historico WHERE usuario_id = $1',
        [req.usuarioRoteirizador.id]
      );
      
      res.json({
        rotas: result.rows,
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (err) {
      console.error('❌ Erro ao listar rotas:', err);
      res.status(500).json({ error: 'Erro ao listar rotas' });
    }
  });

  // Buscar rota por ID
  router.get('/rotas/:id', verificarTokenRoteirizador, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM rotas_historico 
         WHERE id = $1 AND usuario_id = $2`,
        [req.params.id, req.usuarioRoteirizador.id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao buscar rota:', err);
      res.status(500).json({ error: 'Erro ao buscar rota' });
    }
  });

  // Deletar rota
  router.delete('/rotas/:id', verificarTokenRoteirizador, async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM rotas_historico WHERE id = $1 AND usuario_id = $2 RETURNING id',
        [req.params.id, req.usuarioRoteirizador.id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao deletar rota:', err);
      res.status(500).json({ error: 'Erro ao deletar rota' });
    }
  });

  // Salvar/atualizar favorito
  router.post('/favoritos', verificarTokenRoteirizador, async (req, res) => {
    try {
      const { endereco, apelido, latitude, longitude } = req.body;
      
      // Verificar se já existe
      const existente = await pool.query(
        'SELECT id FROM enderecos_favoritos WHERE usuario_id = $1 AND endereco = $2',
        [req.usuarioRoteirizador.id, endereco]
      );
      
      if (existente.rows.length > 0) {
        // Atualizar uso_count
        const result = await pool.query(
          `UPDATE enderecos_favoritos 
           SET uso_count = uso_count + 1, apelido = COALESCE($1, apelido), updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [apelido, existente.rows[0].id]
        );
        return res.json(result.rows[0]);
      }
      
      const result = await pool.query(
        `INSERT INTO enderecos_favoritos (usuario_id, endereco, apelido, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.usuarioRoteirizador.id, endereco, apelido, latitude, longitude]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao salvar favorito:', err);
      res.status(500).json({ error: 'Erro ao salvar favorito' });
    }
  });

  // Listar favoritos
  router.get('/favoritos', verificarTokenRoteirizador, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM enderecos_favoritos 
         WHERE usuario_id = $1 
         ORDER BY uso_count DESC, updated_at DESC`,
        [req.usuarioRoteirizador.id]
      );
      
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar favoritos:', err);
      res.status(500).json({ error: 'Erro ao listar favoritos' });
    }
  });

  return router;
}
module.exports = { createRoteirizadorRouter };
