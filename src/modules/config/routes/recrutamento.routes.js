/**
 * Config Sub-Router: Recrutamento de Profissionais
 */
const express = require('express');

function createRecrutamentoRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

router.get('/recrutamento', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT n.*, 
        COALESCE(
          (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE necessidade_id = n.id AND tipo = 'titular'),
          0
        ) as motos_atribuidas,
        COALESCE(
          (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE necessidade_id = n.id AND tipo = 'backup'),
          0
        ) as backups_atribuidos
      FROM recrutamento_necessidades n
    `;
    
    const params = [];
    if (status) {
      params.push(status);
      query += ` WHERE n.status = $1`;
    }
    
    query += ` ORDER BY n.data_conclusao ASC, n.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    // Para cada necessidade, buscar as atribuições
    const necessidades = [];
    for (const nec of result.rows) {
      const atribuicoes = await pool.query(
        `SELECT * FROM recrutamento_atribuicoes WHERE necessidade_id = $1 ORDER BY tipo, created_at`,
        [nec.id]
      );
      necessidades.push({
        ...nec,
        atribuicoes: atribuicoes.rows
      });
    }
    
    res.json(necessidades);
  } catch (error) {
    console.error('Erro ao listar recrutamento:', error);
    res.status(500).json({ error: 'Erro ao listar necessidades de recrutamento' });
  }
});

// POST /api/recrutamento - Criar nova necessidade
router.post('/recrutamento', async (req, res) => {
  try {
    const { nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, criado_por } = req.body;
    
    if (!nome_cliente || !data_conclusao || !quantidade_motos) {
      return res.status(400).json({ error: 'Nome do cliente, data de conclusão e quantidade de motos são obrigatórios' });
    }
    
    const result = await pool.query(
      `INSERT INTO recrutamento_necessidades 
        (nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [nome_cliente, data_conclusao, quantidade_motos, quantidade_backup || 0, observacao || null, criado_por]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar necessidade:', error);
    res.status(500).json({ error: 'Erro ao criar necessidade de recrutamento' });
  }
});

// PUT /api/recrutamento/:id - Atualizar necessidade
router.put('/recrutamento/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, status } = req.body;
    
    const result = await pool.query(
      `UPDATE recrutamento_necessidades 
       SET nome_cliente = COALESCE($1, nome_cliente),
           data_conclusao = COALESCE($2, data_conclusao),
           quantidade_motos = COALESCE($3, quantidade_motos),
           quantidade_backup = COALESCE($4, quantidade_backup),
           observacao = $5,
           status = COALESCE($6, status),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, status, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar necessidade:', error);
    res.status(500).json({ error: 'Erro ao atualizar necessidade' });
  }
});

// DELETE /api/recrutamento/:id - Deletar necessidade
router.delete('/recrutamento/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM recrutamento_necessidades WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('Erro ao deletar necessidade:', error);
    res.status(500).json({ error: 'Erro ao deletar necessidade' });
  }
});

// POST /api/recrutamento/:id/atribuir - Atribuir moto a uma necessidade
router.post('/recrutamento/:id/atribuir', async (req, res) => {
  try {
    const { id } = req.params;
    const { cod_profissional, tipo, atribuido_por } = req.body;
    
    if (!cod_profissional) {
      return res.status(400).json({ error: 'Código do profissional é obrigatório' });
    }
    
    // Verificar se a necessidade existe
    const necessidade = await pool.query(
      'SELECT * FROM recrutamento_necessidades WHERE id = $1',
      [id]
    );
    
    if (necessidade.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    // Verificar se já está atribuído nesta necessidade
    const jaAtribuido = await pool.query(
      'SELECT * FROM recrutamento_atribuicoes WHERE necessidade_id = $1 AND cod_profissional = $2',
      [id, cod_profissional]
    );
    
    if (jaAtribuido.rows.length > 0) {
      return res.status(400).json({ error: 'Este profissional já está atribuído a esta necessidade' });
    }
    
    // Buscar nome do profissional na planilha do Google Sheets
    let nome_profissional = null;
    try {
      const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
      const response = await fetch(sheetUrl);
      const text = await response.text();
      const lines = text.split('\n').slice(1);
      
      for (const line of lines) {
        const cols = line.split(',');
        if (cols[0]?.trim() === cod_profissional) {
          nome_profissional = cols[1]?.trim() || null;
          break;
        }
      }
    } catch (sheetErr) {
      console.log('Erro ao buscar na planilha, tentando fallback:', sheetErr.message);
    }
    
    // Fallback: buscar na tabela de disponibilidade se não achou na planilha
    if (!nome_profissional) {
      const profResult = await pool.query(
        `SELECT DISTINCT nome_profissional 
         FROM disponibilidade_linhas 
         WHERE cod_profissional = $1 AND nome_profissional IS NOT NULL
         LIMIT 1`,
        [cod_profissional]
      );
      nome_profissional = profResult.rows[0]?.nome_profissional || null;
    }
    
    // Inserir atribuição
    const result = await pool.query(
      `INSERT INTO recrutamento_atribuicoes 
        (necessidade_id, tipo, cod_profissional, nome_profissional, atribuido_por)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, tipo || 'titular', cod_profissional, nome_profissional, atribuido_por]
    );
    
    // Verificar se a necessidade foi completada
    const atribuicoes = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE tipo = 'titular') as titulares,
        COUNT(*) FILTER (WHERE tipo = 'backup') as backups
       FROM recrutamento_atribuicoes 
       WHERE necessidade_id = $1`,
      [id]
    );
    
    const nec = necessidade.rows[0];
    const stats = atribuicoes.rows[0];
    
    // Se atingiu o total necessário, atualizar status para concluído
    if (parseInt(stats.titulares) >= nec.quantidade_motos && 
        parseInt(stats.backups) >= nec.quantidade_backup) {
      await pool.query(
        `UPDATE recrutamento_necessidades SET status = 'concluido', updated_at = NOW() WHERE id = $1`,
        [id]
      );
    }
    
    res.json({ 
      atribuicao: result.rows[0],
      nome_profissional: nome_profissional
    });
  } catch (error) {
    console.error('Erro ao atribuir profissional:', error);
    res.status(500).json({ error: 'Erro ao atribuir profissional' });
  }
});

// DELETE /api/recrutamento/atribuicao/:id - Remover atribuição
router.delete('/recrutamento/atribuicao/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar a atribuição para saber qual necessidade
    const atribuicao = await pool.query(
      'SELECT * FROM recrutamento_atribuicoes WHERE id = $1',
      [id]
    );
    
    if (atribuicao.rows.length === 0) {
      return res.status(404).json({ error: 'Atribuição não encontrada' });
    }
    
    const necessidadeId = atribuicao.rows[0].necessidade_id;
    
    // Deletar atribuição
    await pool.query('DELETE FROM recrutamento_atribuicoes WHERE id = $1', [id]);
    
    // Atualizar status da necessidade para em_andamento se estava concluída
    await pool.query(
      `UPDATE recrutamento_necessidades 
       SET status = 'em_andamento', updated_at = NOW() 
       WHERE id = $1 AND status = 'concluido'`,
      [necessidadeId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover atribuição:', error);
    res.status(500).json({ error: 'Erro ao remover atribuição' });
  }
});

// GET /api/recrutamento/buscar-profissional/:cod - Buscar profissional por código
router.get('/recrutamento/buscar-profissional/:cod', async (req, res) => {
  try {
    const { cod } = req.params;
    
    // Buscar na planilha do Google Sheets (mesma usada no módulo de disponibilidade)
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1); // pular header
    
    let profissional = null;
    for (const line of lines) {
      const cols = line.split(',');
      const codigo = cols[0]?.trim();
      if (codigo === cod) {
        profissional = {
          cod_profissional: codigo,
          nome_profissional: cols[1]?.trim() || null,
          cidade: cols[3]?.trim() || null
        };
        break;
      }
    }
    
    if (!profissional) {
      // Fallback: tentar buscar na tabela de disponibilidade
      const dispResult = await pool.query(
        `SELECT DISTINCT cod_profissional, nome_profissional
         FROM disponibilidade_linhas 
         WHERE cod_profissional = $1 AND nome_profissional IS NOT NULL
         LIMIT 1`,
        [cod]
      );
      
      if (dispResult.rows.length > 0) {
        return res.json(dispResult.rows[0]);
      }
      
      // Fallback 2: tentar buscar na tabela de usuários
      const userResult = await pool.query(
        'SELECT cod_profissional, full_name as nome_profissional FROM users WHERE cod_profissional = $1',
        [cod]
      );
      
      if (userResult.rows.length > 0) {
        return res.json(userResult.rows[0]);
      }
      
      return res.status(404).json({ error: 'Profissional não encontrado' });
    }
    
    res.json(profissional);
  } catch (error) {
    console.error('Erro ao buscar profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar profissional' });
  }
});

// GET /api/recrutamento/estatisticas - Estatísticas gerais de recrutamento
router.get('/recrutamento/estatisticas', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_necessidades,
        COUNT(*) FILTER (WHERE status = 'em_andamento') as em_andamento,
        COUNT(*) FILTER (WHERE status = 'concluido') as concluidas,
        COUNT(*) FILTER (WHERE status = 'cancelado') as canceladas,
        SUM(quantidade_motos) as total_motos_necessarias,
        SUM(quantidade_backup) as total_backups_necessarios,
        (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE tipo = 'titular') as total_motos_atribuidas,
        (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE tipo = 'backup') as total_backups_atribuidos
      FROM recrutamento_necessidades
    `);
    
    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});


  return router;

  return router;
}

module.exports = { createRecrutamentoRoutes };
