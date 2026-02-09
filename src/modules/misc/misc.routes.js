/**
 * MÓDULO MISC - Routes
 * 10 endpoints: setores(4), relatórios-diários(6)
 */

const express = require('express');

function createMiscRouter(pool, verificarToken) {
  const router = express.Router();

  // Aplicar verificarToken apenas a rotas deste módulo (não bloquear outros módulos)
  router.use((req, res, next) => {
    if (req.path.startsWith('/setores') || req.path.startsWith('/relatorios-diarios')) {
      if (verificarToken) return verificarToken(req, res, next);
    }
    next();
  });

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
router.get('/relatorios-diarios', async (req, res) => {
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
router.get('/relatorios-diarios/nao-lidos/:usuario_id', async (req, res) => {
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
router.post('/relatorios-diarios/:id/visualizar', async (req, res) => {
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
router.post('/relatorios-diarios', async (req, res) => {
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
router.put('/relatorios-diarios/:id', async (req, res) => {
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
router.delete('/relatorios-diarios/:id', async (req, res) => {
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


  return router;
}

module.exports = { createMiscRouter };
