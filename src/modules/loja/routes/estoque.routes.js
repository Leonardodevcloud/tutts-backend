/**
 * Sub-Router: Estoque + Produtos
 */
const express = require('express');

function createEstoqueRoutes(pool) {
  const router = express.Router();

  router.get('/estoque', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT e.*, 
          COALESCE(json_agg(
            json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
          ) FILTER (WHERE t.id IS NOT NULL), '[]') as tamanhos
        FROM loja_estoque e
        LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
        GROUP BY e.id
        ORDER BY e.created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar estoque:', err);
      res.status(500).json({ error: 'Erro ao listar estoque' });
    }
  });

  // POST - Adicionar item ao estoque
  router.post('/estoque', async (req, res) => {
    try {
      const { nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, tamanhos, imagem_url, created_by } = req.body;
      
      const result = await pool.query(
        `INSERT INTO loja_estoque (nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, imagem_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [nome, marca, valor, quantidade || 0, tem_tamanho || false, tipo_tamanho || 'letras', imagem_url, created_by]
      );
      
      const estoqueId = result.rows[0].id;
      
      if (tem_tamanho && tamanhos && tamanhos.length > 0) {
        for (const t of tamanhos) {
          await pool.query(
            `INSERT INTO loja_estoque_tamanhos (estoque_id, tamanho, quantidade) VALUES ($1, $2, $3)`,
            [estoqueId, t.tamanho, t.quantidade || 0]
          );
        }
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao adicionar estoque:', err);
      res.status(500).json({ error: 'Erro ao adicionar estoque' });
    }
  });

  // PUT - Atualizar item do estoque
  router.put('/estoque/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho, tamanhos, imagem_url, status } = req.body;
      
      const result = await pool.query(
        `UPDATE loja_estoque SET nome=$1, marca=$2, valor=$3, quantidade=$4, tem_tamanho=$5, tipo_tamanho=$6, imagem_url=$7, status=$8, updated_at=NOW()
         WHERE id=$9 RETURNING *`,
        [nome, marca, valor, quantidade, tem_tamanho, tipo_tamanho || 'letras', imagem_url, status || 'ativo', id]
      );
      
      if (tem_tamanho) {
        await pool.query(`DELETE FROM loja_estoque_tamanhos WHERE estoque_id = $1`, [id]);
        
        if (tamanhos && tamanhos.length > 0) {
          for (const t of tamanhos) {
            await pool.query(
              `INSERT INTO loja_estoque_tamanhos (estoque_id, tamanho, quantidade) VALUES ($1, $2, $3)`,
              [id, t.tamanho, t.quantidade || 0]
            );
          }
        }
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar estoque:', err);
      res.status(500).json({ error: 'Erro ao atualizar estoque' });
    }
  });

  // DELETE - Remover item do estoque
  router.delete('/estoque/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query(`DELETE FROM loja_estoque WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao remover estoque:', err);
      res.status(500).json({ error: 'Erro ao remover estoque' });
    }
  });

  // ==================== PRODUTOS À VENDA ====================

  // GET - Listar produtos
  router.get('/produtos', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT p.*, e.tem_tamanho,
          COALESCE(json_agg(
            json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
          ) FILTER (WHERE t.id IS NOT NULL), '[]') as tamanhos
        FROM loja_produtos p
        LEFT JOIN loja_estoque e ON e.id = p.estoque_id
        LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
        GROUP BY p.id, e.tem_tamanho
        ORDER BY p.created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar produtos:', err);
      res.status(500).json({ error: 'Erro ao listar produtos' });
    }
  });

  // GET - Produtos ativos (para usuário)
  router.get('/produtos/ativos', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT p.*, e.tem_tamanho, e.quantidade as estoque_total,
          COALESCE(json_agg(
            json_build_object('id', t.id, 'tamanho', t.tamanho, 'quantidade', t.quantidade)
          ) FILTER (WHERE t.id IS NOT NULL AND t.quantidade > 0), '[]') as tamanhos
        FROM loja_produtos p
        LEFT JOIN loja_estoque e ON e.id = p.estoque_id
        LEFT JOIN loja_estoque_tamanhos t ON t.estoque_id = e.id
        WHERE p.status = 'ativo'
        GROUP BY p.id, e.tem_tamanho, e.quantidade
        ORDER BY p.created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar produtos ativos:', err);
      res.status(500).json({ error: 'Erro ao listar produtos' });
    }
  });

  // POST - Adicionar produto à venda
  router.post('/produtos', async (req, res) => {
    try {
      const { estoque_id, nome, descricao, marca, valor, imagem_url, parcelas_config, created_by } = req.body;
      
      const result = await pool.query(
        `INSERT INTO loja_produtos (estoque_id, nome, descricao, marca, valor, imagem_url, parcelas_config, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [estoque_id, nome, descricao, marca, valor, imagem_url, JSON.stringify(parcelas_config || []), created_by]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao adicionar produto:', err);
      res.status(500).json({ error: 'Erro ao adicionar produto' });
    }
  });

  // PUT - Atualizar produto
  router.put('/produtos/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { nome, descricao, marca, valor, imagem_url, parcelas_config, status } = req.body;
      
      const result = await pool.query(
        `UPDATE loja_produtos SET nome=$1, descricao=$2, marca=$3, valor=$4, imagem_url=$5, parcelas_config=$6, status=$7, updated_at=NOW()
         WHERE id=$8 RETURNING *`,
        [nome, descricao, marca, valor, imagem_url, JSON.stringify(parcelas_config || []), status, id]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar produto:', err);
      res.status(500).json({ error: 'Erro ao atualizar produto' });
    }
  });

  // DELETE - Remover produto
  router.delete('/produtos/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query(`DELETE FROM loja_produtos WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao remover produto:', err);
      res.status(500).json({ error: 'Erro ao remover produto' });
    }
  });

  // ==================== PEDIDOS ====================

  // GET - Listar todos os pedidos (admin)

  return router;
}

module.exports = { createEstoqueRoutes };
