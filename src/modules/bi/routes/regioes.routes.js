/**
 * BI Sub-Router: Regiões, Categorias e Dados de Filtro
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createRegioesRoutes(pool) {
  const router = express.Router();

router.get('/bi/regioes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bi_regioes ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar regiões:', err);
    res.json([]);
  }
});

// Criar região - Suporta novo formato com cliente + centro de custo
router.post('/bi/regioes', async (req, res) => {
  try {
    const { nome, clientes, itens } = req.body;
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    // Se vier no novo formato (itens), usa ele. Senão, usa o formato antigo (clientes)
    let dadosParaSalvar;
    if (itens && itens.length > 0) {
      // Novo formato: array de {cod_cliente, centro_custo}
      dadosParaSalvar = itens;
    } else if (clientes && clientes.length > 0) {
      // Formato antigo: array de cod_cliente
      // Converte para novo formato (sem centro_custo especificado = todos)
      dadosParaSalvar = clientes.map(c => ({ cod_cliente: c, centro_custo: null }));
    } else {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      INSERT INTO bi_regioes (nome, clientes) 
      VALUES ($1, $2)
      RETURNING *
    `, [nome, JSON.stringify(dadosParaSalvar)]);
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao salvar região:', err);
    res.status(500).json({ error: 'Erro ao salvar região' });
  }
});

// Atualizar região existente
router.put('/bi/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, itens } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    if (!itens || itens.length === 0) {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      UPDATE bi_regioes 
      SET nome = $1, clientes = $2
      WHERE id = $3
      RETURNING *
    `, [nome, JSON.stringify(itens), id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// Excluir região
router.delete('/bi/regioes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bi_regioes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir região:', err);
    res.status(500).json({ error: 'Erro ao excluir região' });
  }
});

// Atualizar região existente
router.put('/bi/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, clientes, itens } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    // Se vier no novo formato (itens), usa ele. Senão, usa o formato antigo (clientes)
    let dadosParaSalvar;
    if (itens && itens.length > 0) {
      dadosParaSalvar = itens;
    } else if (clientes && clientes.length > 0) {
      dadosParaSalvar = clientes.map(c => ({ cod_cliente: c, centro_custo: null }));
    } else {
      return res.status(400).json({ error: 'Adicione pelo menos um cliente/centro de custo' });
    }
    
    const result = await pool.query(`
      UPDATE bi_regioes 
      SET nome = $1, clientes = $2
      WHERE id = $3
      RETURNING *
    `, [nome, JSON.stringify(dadosParaSalvar), id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    
    res.json({ success: true, regiao: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// ===== CATEGORIAS (da planilha) =====
router.get('/bi/categorias', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT categoria
      FROM bi_entregas
      WHERE categoria IS NOT NULL AND categoria != ''
      ORDER BY categoria
    `);
    res.json(result.rows.map(r => r.categoria));
  } catch (err) {
    console.error('❌ Erro ao listar categorias:', err);
    res.json([]);
  }
});

// ===== DADOS PARA FILTROS INTELIGENTES =====
router.get('/bi/dados-filtro', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT cod_cliente, centro_custo, categoria
      FROM bi_entregas
      WHERE cod_cliente IS NOT NULL
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar dados de filtro:', err);
    res.json([]);
  }
});

// NOVOS ENDPOINTS BI - MAPA DE CALOR COM COORDENADAS REAIS
// Adicione isso ao final do seu server.js
// ============================================

// MIGRATION: Adicionar colunas de latitude e longitude na tabela bi_entregas
// Execute isso uma vez para adicionar as colunas
const migrateCoordenadas = async () => {
  try {
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8)`).catch(() => {});
    await pool.query(`ALTER TABLE bi_entregas ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_entregas_coords ON bi_entregas(latitude, longitude)`).catch(() => {});
    console.log('✅ Colunas latitude/longitude adicionadas na bi_entregas');
  } catch (err) {
    console.log('Colunas de coordenadas já existem ou erro:', err.message);
  }
};
migrateCoordenadas();

// GET - Mapa de Calor usando COORDENADAS REAIS do banco

  return router;
}

module.exports = { createRegioesRoutes };
