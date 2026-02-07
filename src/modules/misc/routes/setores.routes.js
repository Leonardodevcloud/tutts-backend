/**
 * Sub-Router: Setores
 */
const express = require('express');

function createSetoresRoutes(pool) {
  const router = express.Router();

router.get('/setores', async (req, res) => {
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
router.post('/setores', async (req, res) => {
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
router.put('/setores/:id', async (req, res) => {
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
router.delete('/setores/:id', async (req, res) => {
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

  return router;
}

module.exports = { createSetoresRoutes };
