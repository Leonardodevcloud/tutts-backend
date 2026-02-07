/**
 * Sub-Router: Pedidos + Sugestões
 */
const express = require('express');

function createPedidosRoutes(pool) {
  const router = express.Router();

  router.get('/pedidos', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT * FROM loja_pedidos ORDER BY created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar pedidos:', err);
      res.status(500).json({ error: 'Erro ao listar pedidos' });
    }
  });

  // GET - Pedidos do usuário
  router.get('/pedidos/user/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const result = await pool.query(
        `SELECT * FROM loja_pedidos WHERE user_cod = $1 ORDER BY created_at DESC`,
        [userCod]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar pedidos do usuário:', err);
      res.status(500).json({ error: 'Erro ao listar pedidos' });
    }
  });

  // POST - Criar pedido
  router.post('/pedidos', async (req, res) => {
    try {
      const { produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela } = req.body;
      
      const result = await pool.query(
        `INSERT INTO loja_pedidos (produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [produto_id, user_cod, user_name, produto_nome, tamanho, marca, valor_original, tipo_abatimento, valor_abatimento, valor_final, parcelas, valor_parcela]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar pedido:', err);
      res.status(500).json({ error: 'Erro ao criar pedido' });
    }
  });

  // PATCH - Atualizar status do pedido
  router.patch('/pedidos/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status, admin_id, admin_name, observacao, debito_lancado, debito_lancado_em, debito_lancado_por } = req.body;
      
      let result;
      
      if (debito_lancado !== undefined) {
        result = await pool.query(
          `UPDATE loja_pedidos SET debito_lancado=$1, debito_lancado_em=$2, debito_lancado_por=$3, updated_at=NOW()
           WHERE id=$4 RETURNING *`,
          [debito_lancado, debito_lancado_em, debito_lancado_por, id]
        );
      } else {
        result = await pool.query(
          `UPDATE loja_pedidos SET status=$1, admin_id=$2, admin_name=$3, observacao=$4, updated_at=NOW()
           WHERE id=$5 RETURNING *`,
          [status, admin_id, admin_name, observacao, id]
        );
        
        if (status === 'aprovado') {
          const pedido = result.rows[0];
          if (pedido.tamanho) {
            await pool.query(`
              UPDATE loja_estoque_tamanhos 
              SET quantidade = quantidade - 1 
              WHERE estoque_id = (SELECT estoque_id FROM loja_produtos WHERE id = $1) 
              AND tamanho = $2 AND quantidade > 0
            `, [pedido.produto_id, pedido.tamanho]);
          } else {
            await pool.query(`
              UPDATE loja_estoque 
              SET quantidade = quantidade - 1 
              WHERE id = (SELECT estoque_id FROM loja_produtos WHERE id = $1) 
              AND quantidade > 0
            `, [pedido.produto_id]);
          }
        }
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar pedido:', err);
      res.status(500).json({ error: 'Erro ao atualizar pedido' });
    }
  });

  // DELETE - Remover pedido
  router.delete('/pedidos/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query(`DELETE FROM loja_pedidos WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao remover pedido:', err);
      res.status(500).json({ error: 'Erro ao remover pedido' });
    }
  });

  // ==================== MOVIMENTAÇÕES DE ESTOQUE ====================

  // GET - Listar movimentações de um item
  router.get('/estoque/:id/movimentacoes', async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT * FROM loja_estoque_movimentacoes WHERE estoque_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar movimentações:', err);
      res.status(500).json({ error: 'Erro ao listar movimentações' });
    }
  });

  // GET - Listar todas movimentações
  router.get('/movimentacoes', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT m.*, e.nome as produto_nome, e.marca
        FROM loja_estoque_movimentacoes m
        LEFT JOIN loja_estoque e ON m.estoque_id = e.id
        ORDER BY m.created_at DESC
        LIMIT 500
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar movimentações:', err);
      res.status(500).json({ error: 'Erro ao listar movimentações' });
    }
  });

  // POST - Registrar entrada de estoque
  router.post('/estoque/:id/entrada', async (req, res) => {
    try {
      const { id } = req.params;
      const { quantidade, tamanho, motivo, created_by } = req.body;
      
      await pool.query(
        `INSERT INTO loja_estoque_movimentacoes (estoque_id, tipo, quantidade, tamanho, motivo, created_by)
         VALUES ($1, 'entrada', $2, $3, $4, $5)`,
        [id, quantidade, tamanho || null, motivo || 'Entrada manual', created_by]
      );
      
      if (tamanho) {
        await pool.query(
          `UPDATE loja_estoque_tamanhos SET quantidade = quantidade + $1 WHERE estoque_id = $2 AND tamanho = $3`,
          [quantidade, id, tamanho]
        );
      } else {
        await pool.query(
          `UPDATE loja_estoque SET quantidade = quantidade + $1 WHERE id = $2`,
          [quantidade, id]
        );
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao registrar entrada:', err);
      res.status(500).json({ error: 'Erro ao registrar entrada' });
    }
  });

  // POST - Registrar saída de estoque
  router.post('/estoque/:id/saida', async (req, res) => {
    try {
      const { id } = req.params;
      const { quantidade, tamanho, motivo, created_by } = req.body;
      
      await pool.query(
        `INSERT INTO loja_estoque_movimentacoes (estoque_id, tipo, quantidade, tamanho, motivo, created_by)
         VALUES ($1, 'saida', $2, $3, $4, $5)`,
        [id, quantidade, tamanho || null, motivo || 'Saída manual', created_by]
      );
      
      if (tamanho) {
        await pool.query(
          `UPDATE loja_estoque_tamanhos SET quantidade = GREATEST(0, quantidade - $1) WHERE estoque_id = $2 AND tamanho = $3`,
          [quantidade, id, tamanho]
        );
      } else {
        await pool.query(
          `UPDATE loja_estoque SET quantidade = GREATEST(0, quantidade - $1) WHERE id = $2`,
          [quantidade, id]
        );
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao registrar saída:', err);
      res.status(500).json({ error: 'Erro ao registrar saída' });
    }
  });

  // ==================== SUGESTÕES DE PRODUTOS ====================

  // GET - Listar todas sugestões (admin)
  router.get('/sugestoes', async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM loja_sugestoes ORDER BY created_at DESC`);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar sugestões:', err);
      res.status(500).json({ error: 'Erro ao listar sugestões' });
    }
  });

  // GET - Listar sugestões do usuário
  router.get('/sugestoes/user/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const result = await pool.query(
        `SELECT * FROM loja_sugestoes WHERE user_cod = $1 ORDER BY created_at DESC`,
        [userCod]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar sugestões:', err);
      res.status(500).json({ error: 'Erro ao listar sugestões' });
    }
  });

  // POST - Criar sugestão
  router.post('/sugestoes', async (req, res) => {
    try {
      const { user_cod, user_name, sugestao } = req.body;
      
      const result = await pool.query(
        `INSERT INTO loja_sugestoes (user_cod, user_name, sugestao) VALUES ($1, $2, $3) RETURNING *`,
        [user_cod, user_name, sugestao]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar sugestão:', err);
      res.status(500).json({ error: 'Erro ao criar sugestão' });
    }
  });

  // PATCH - Responder sugestão (admin)
  router.patch('/sugestoes/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status, resposta, respondido_por } = req.body;
      
      const result = await pool.query(
        `UPDATE loja_sugestoes SET status=$1, resposta=$2, respondido_por=$3, respondido_em=NOW() WHERE id=$4 RETURNING *`,
        [status, resposta, respondido_por, id]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao responder sugestão:', err);
      res.status(500).json({ error: 'Erro ao responder sugestão' });
    }
  });

  // DELETE - Remover sugestão
  router.delete('/sugestoes/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query(`DELETE FROM loja_sugestoes WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao remover sugestão:', err);
      res.status(500).json({ error: 'Erro ao remover sugestão' });
    }
  });

  return router;

  return router;
}

module.exports = { createPedidosRoutes };
