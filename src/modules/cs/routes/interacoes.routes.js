/**
 * CS Sub-Router: Interações (Timeline)
 * Visitas, reuniões, ligações, pós-venda, anotações
 */
const express = require('express');
const { TIPOS_INTERACAO } = require('../cs.service');

function createInteracoesRoutes(pool) {
  const router = express.Router();

  // ==================== GET /cs/interacoes ====================
  // Lista interações (com filtros)
  router.get('/cs/interacoes', async (req, res) => {
    try {
      const { cod_cliente, tipo, data_inicio, data_fim, page = 1, limit = 20 } = req.query;
      const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

      let whereClause = 'WHERE 1=1';
      const params = [];
      let idx = 1;

      if (cod_cliente) {
        whereClause += ` AND i.cod_cliente = $${idx}`;
        params.push(parseInt(cod_cliente));
        idx++;
      }
      if (tipo) {
        whereClause += ` AND i.tipo = $${idx}`;
        params.push(tipo);
        idx++;
      }
      if (data_inicio) {
        whereClause += ` AND i.data_interacao >= $${idx}`;
        params.push(data_inicio);
        idx++;
      }
      if (data_fim) {
        whereClause += ` AND i.data_interacao <= $${idx}::date + 1`;
        params.push(data_fim);
        idx++;
      }

      const result = await pool.query(`
        SELECT i.*, c.nome_fantasia
        FROM cs_interacoes i
        LEFT JOIN cs_clientes c ON c.cod_cliente = i.cod_cliente
        ${whereClause}
        ORDER BY i.data_interacao DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...params, parseInt(limit), offset]);

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM cs_interacoes i ${whereClause}`, params
      );

      res.json({
        success: true,
        interacoes: result.rows,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        tipos: TIPOS_INTERACAO,
      });
    } catch (error) {
      console.error('❌ Erro ao listar interações CS:', error);
      res.status(500).json({ error: 'Erro ao listar interações' });
    }
  });

  // ==================== POST /cs/interacoes ====================
  // Criar nova interação
  router.post('/cs/interacoes', async (req, res) => {
    try {
      const {
        cod_cliente, tipo, titulo, descricao, data_interacao,
        duracao_minutos, participantes, resultado,
        proxima_acao, data_proxima_acao, tags,
      } = req.body;

      if (!cod_cliente || !tipo || !titulo) {
        return res.status(400).json({ error: 'cod_cliente, tipo e titulo são obrigatórios' });
      }

      if (!TIPOS_INTERACAO[tipo]) {
        return res.status(400).json({ error: `Tipo inválido. Tipos válidos: ${Object.keys(TIPOS_INTERACAO).join(', ')}` });
      }

      const result = await pool.query(`
        INSERT INTO cs_interacoes (
          cod_cliente, tipo, titulo, descricao, data_interacao,
          duracao_minutos, participantes, resultado,
          proxima_acao, data_proxima_acao, tags,
          criado_por, criado_por_nome
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `, [
        parseInt(cod_cliente), tipo, titulo, descricao,
        data_interacao || new Date().toISOString(),
        duracao_minutos || null,
        JSON.stringify(participantes || []),
        resultado || null,
        proxima_acao || null,
        data_proxima_acao || null,
        JSON.stringify(tags || []),
        req.user?.codProfissional,
        req.user?.nome,
      ]);

      console.log(`📝 CS Interação criada: ${tipo} — ${titulo} (cliente ${cod_cliente})`);
      res.status(201).json({ success: true, interacao: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao criar interação CS:', error);
      res.status(500).json({ error: 'Erro ao criar interação' });
    }
  });

  // ==================== PUT /cs/interacoes/:id ====================
  router.put('/cs/interacoes/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const {
        titulo, descricao, data_interacao, duracao_minutos,
        participantes, resultado, proxima_acao, data_proxima_acao, tags,
      } = req.body;

      const result = await pool.query(`
        UPDATE cs_interacoes SET
          titulo = COALESCE($1, titulo),
          descricao = COALESCE($2, descricao),
          data_interacao = COALESCE($3, data_interacao),
          duracao_minutos = COALESCE($4, duracao_minutos),
          participantes = COALESCE($5, participantes),
          resultado = COALESCE($6, resultado),
          proxima_acao = COALESCE($7, proxima_acao),
          data_proxima_acao = COALESCE($8, data_proxima_acao),
          tags = COALESCE($9, tags),
          updated_at = NOW()
        WHERE id = $10
        RETURNING *
      `, [
        titulo, descricao, data_interacao, duracao_minutos,
        participantes ? JSON.stringify(participantes) : null,
        resultado, proxima_acao, data_proxima_acao,
        tags ? JSON.stringify(tags) : null, id,
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Interação não encontrada' });
      }

      res.json({ success: true, interacao: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao atualizar interação CS:', error);
      res.status(500).json({ error: 'Erro ao atualizar interação' });
    }
  });

  // ==================== DELETE /cs/interacoes/:id ====================
  router.delete('/cs/interacoes/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = await pool.query('DELETE FROM cs_interacoes WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Interação não encontrada' });
      }

      res.json({ success: true, message: 'Interação removida' });
    } catch (error) {
      console.error('❌ Erro ao deletar interação CS:', error);
      res.status(500).json({ error: 'Erro ao deletar interação' });
    }
  });

  // ==================== GET /cs/interacoes/agenda ====================
  // Próximas ações agendadas
  router.get('/cs/interacoes/agenda', async (req, res) => {
    try {
      const { dias = 7 } = req.query;

      const result = await pool.query(`
        SELECT i.*, c.nome_fantasia
        FROM cs_interacoes i
        LEFT JOIN cs_clientes c ON c.cod_cliente = i.cod_cliente
        WHERE i.data_proxima_acao IS NOT NULL
          AND i.data_proxima_acao >= CURRENT_DATE
          AND i.data_proxima_acao <= CURRENT_DATE + $1::integer
        ORDER BY i.data_proxima_acao ASC
      `, [parseInt(dias)]);

      res.json({ success: true, agenda: result.rows, dias: parseInt(dias) });
    } catch (error) {
      console.error('❌ Erro ao buscar agenda CS:', error);
      res.status(500).json({ error: 'Erro ao buscar agenda' });
    }
  });

  return router;
}

module.exports = { createInteracoesRoutes };
