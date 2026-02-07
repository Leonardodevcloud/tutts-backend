const express = require('express');
function createOperacoesRouter(pool) {
  const router = express.Router();

  // GET - Listar todas as operações
  router.get('/', async (req, res) => {
    try {
      const { status, regiao } = req.query;
      
      let query = `
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE 1=1
      `;
      const params = [];
      
      if (status) {
        params.push(status);
        query += ` AND o.status = $${params.length}`;
      }
      
      if (regiao) {
        params.push(regiao);
        query += ` AND o.regiao = $${params.length}`;
      }
      
      query += ` ORDER BY o.criado_em DESC`;
      
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (error) {
      console.error('Erro ao listar operações:', error);
      res.status(500).json({ error: 'Erro ao listar operações' });
    }
  });

  // GET - Listar regiões das operações
  router.get('/regioes', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DISTINCT regiao FROM operacoes WHERE regiao IS NOT NULL ORDER BY regiao
      `);
      res.json(result.rows.map(r => r.regiao));
    } catch (error) {
      console.error('Erro ao listar regiões:', error);
      res.status(500).json({ error: 'Erro ao listar regiões' });
    }
  });

  // GET - Buscar operação por ID
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const operacao = await pool.query(`
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE o.id = $1
      `, [id]);
      
      if (operacao.rows.length === 0) {
        return res.status(404).json({ error: 'Operação não encontrada' });
      }
      
      res.json(operacao.rows[0]);
    } catch (error) {
      console.error('Erro ao buscar operação:', error);
      res.status(500).json({ error: 'Erro ao buscar operação' });
    }
  });

  // POST - Criar nova operação
  router.post('/', async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, faixas_km, criado_por
      } = req.body;
      
      const operacaoResult = await client.query(`
        INSERT INTO operacoes (
          regiao, nome_cliente, endereco, modelo, quantidade_motos,
          obrigatoriedade_bau, possui_garantido, valor_garantido,
          data_inicio, observacoes, criado_por
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `, [
        regiao, nome_cliente, endereco, modelo, quantidade_motos || 1,
        obrigatoriedade_bau || false, possui_garantido || false, valor_garantido || 0,
        data_inicio, observacoes, criado_por
      ]);
      
      const operacaoId = operacaoResult.rows[0].id;
      
      if (faixas_km && faixas_km.length > 0) {
        for (const faixa of faixas_km) {
          if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
            await client.query(`
              INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
              VALUES ($1, $2, $3, $4)
            `, [operacaoId, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
          }
        }
      }
      
      await client.query('COMMIT');
      
      const operacaoCompleta = await pool.query(`
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE o.id = $1
      `, [operacaoId]);
      
      res.status(201).json(operacaoCompleta.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar operação:', error);
      res.status(500).json({ error: 'Erro ao criar operação' });
    } finally {
      client.release();
    }
  });

  // PUT - Atualizar operação
  router.put('/:id', async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const {
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, status, faixas_km
      } = req.body;
      
      await client.query(`
        UPDATE operacoes SET
          regiao = COALESCE($1, regiao),
          nome_cliente = COALESCE($2, nome_cliente),
          endereco = COALESCE($3, endereco),
          modelo = COALESCE($4, modelo),
          quantidade_motos = COALESCE($5, quantidade_motos),
          obrigatoriedade_bau = COALESCE($6, obrigatoriedade_bau),
          possui_garantido = COALESCE($7, possui_garantido),
          valor_garantido = COALESCE($8, valor_garantido),
          data_inicio = COALESCE($9, data_inicio),
          observacoes = COALESCE($10, observacoes),
          status = COALESCE($11, status),
          atualizado_em = NOW()
        WHERE id = $12
      `, [
        regiao, nome_cliente, endereco, modelo, quantidade_motos,
        obrigatoriedade_bau, possui_garantido, valor_garantido,
        data_inicio, observacoes, status, id
      ]);
      
      if (faixas_km) {
        await client.query('DELETE FROM operacoes_faixas_km WHERE operacao_id = $1', [id]);
        
        for (const faixa of faixas_km) {
          if (faixa.valor_motoboy && parseFloat(faixa.valor_motoboy) > 0) {
            await client.query(`
              INSERT INTO operacoes_faixas_km (operacao_id, km_inicio, km_fim, valor_motoboy)
              VALUES ($1, $2, $3, $4)
            `, [id, faixa.km_inicio, faixa.km_fim, faixa.valor_motoboy]);
          }
        }
      }
      
      await client.query('COMMIT');
      
      const operacaoAtualizada = await pool.query(`
        SELECT o.*, 
          (SELECT json_agg(json_build_object(
            'id', f.id,
            'km_inicio', f.km_inicio,
            'km_fim', f.km_fim,
            'valor_motoboy', f.valor_motoboy
          ) ORDER BY f.km_inicio)
          FROM operacoes_faixas_km f WHERE f.operacao_id = o.id
          ) as faixas_km
        FROM operacoes o
        WHERE o.id = $1
      `, [id]);
      
      res.json(operacaoAtualizada.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao atualizar operação:', error);
      res.status(500).json({ error: 'Erro ao atualizar operação' });
    } finally {
      client.release();
    }
  });

  // DELETE - Excluir operação
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await pool.query('DELETE FROM operacoes WHERE id = $1 RETURNING *', [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Operação não encontrada' });
      }
      
      res.json({ message: 'Operação excluída com sucesso', operacao: result.rows[0] });
    } catch (error) {
      console.error('Erro ao excluir operação:', error);
      res.status(500).json({ error: 'Erro ao excluir operação' });
    }
  });

  return router;
}

-e 
module.exports = { createOperacoesRouter };
