/**
 * Sub-Router: Restrições + Espelho + Correções
 */
const express = require('express');

function createRestricoesRoutes(pool) {
  const router = express.Router();

router.get('/disponibilidade/restricoes', async (req, res) => {
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
router.get('/disponibilidade/restricoes/verificar', async (req, res) => {
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
router.post('/disponibilidade/restricoes', async (req, res) => {
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
router.put('/disponibilidade/restricoes/:id', async (req, res) => {
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
router.delete('/disponibilidade/restricoes/:id', async (req, res) => {
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
router.post('/disponibilidade/espelho', async (req, res) => {
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
router.get('/disponibilidade/espelho', async (req, res) => {
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
router.get('/disponibilidade/espelho/:data', async (req, res) => {
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
router.delete('/disponibilidade/espelho/:id', async (req, res) => {
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
router.patch('/disponibilidade/faltosos/corrigir-datas', async (req, res) => {
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
router.patch('/disponibilidade/espelho/corrigir-data', async (req, res) => {
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

  return router;
}

module.exports = { createRestricoesRoutes };
