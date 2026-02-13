/**
 * CS Sub-Router: Ocorrências
 * Gestão de problemas, reclamações, incidentes
 */
const express = require('express');
const { TIPOS_OCORRENCIA, SEVERIDADES, STATUS_OCORRENCIA } = require('../cs.service');

function createOcorrenciasRoutes(pool) {
  const router = express.Router();

  // ==================== GET /cs/ocorrencias ====================
  router.get('/cs/ocorrencias', async (req, res) => {
    try {
      const { cod_cliente, status, severidade, tipo, page = 1, limit = 20 } = req.query;
      const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

      let whereClause = 'WHERE 1=1';
      const params = [];
      let idx = 1;

      if (cod_cliente) {
        whereClause += ` AND o.cod_cliente = $${idx}`;
        params.push(parseInt(cod_cliente));
        idx++;
      }
      if (status) {
        whereClause += ` AND o.status = $${idx}`;
        params.push(status);
        idx++;
      }
      if (severidade) {
        whereClause += ` AND o.severidade = $${idx}`;
        params.push(severidade);
        idx++;
      }
      if (tipo) {
        whereClause += ` AND o.tipo = $${idx}`;
        params.push(tipo);
        idx++;
      }

      const result = await pool.query(`
        SELECT o.*, c.nome_fantasia
        FROM cs_ocorrencias o
        LEFT JOIN cs_clientes c ON c.cod_cliente = o.cod_cliente
        ${whereClause}
        ORDER BY 
          CASE o.severidade WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END,
          o.data_abertura DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...params, parseInt(limit), offset]);

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM cs_ocorrencias o ${whereClause}`, params
      );

      res.json({
        success: true,
        ocorrencias: result.rows,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        tipos: TIPOS_OCORRENCIA,
        severidades: SEVERIDADES,
        statusOptions: STATUS_OCORRENCIA,
      });
    } catch (error) {
      console.error('❌ Erro ao listar ocorrências CS:', error);
      res.status(500).json({ error: 'Erro ao listar ocorrências' });
    }
  });

  // ==================== POST /cs/ocorrencias ====================
  router.post('/cs/ocorrencias', async (req, res) => {
    try {
      const {
        cod_cliente, titulo, descricao, tipo, severidade,
        responsavel_cod, responsavel_nome, impacto_operacional, tags,
      } = req.body;

      if (!cod_cliente || !titulo || !tipo) {
        return res.status(400).json({ error: 'cod_cliente, titulo e tipo são obrigatórios' });
      }

      const result = await pool.query(`
        INSERT INTO cs_ocorrencias (
          cod_cliente, titulo, descricao, tipo, severidade,
          responsavel_cod, responsavel_nome, impacto_operacional, tags,
          criado_por, criado_por_nome
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `, [
        parseInt(cod_cliente), titulo, descricao, tipo,
        severidade || 'media',
        responsavel_cod || null, responsavel_nome || null,
        impacto_operacional || null,
        JSON.stringify(tags || []),
        req.user?.codProfissional, req.user?.nome,
      ]);

      console.log(`🚨 CS Ocorrência criada: [${severidade}] ${titulo} (cliente ${cod_cliente})`);
      res.status(201).json({ success: true, ocorrencia: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao criar ocorrência CS:', error);
      res.status(500).json({ error: 'Erro ao criar ocorrência' });
    }
  });

  // ==================== PUT /cs/ocorrencias/:id ====================
  router.put('/cs/ocorrencias/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const {
        titulo, descricao, tipo, severidade, status,
        responsavel_cod, responsavel_nome, resolucao,
        impacto_operacional, tags,
      } = req.body;

      // Se está sendo resolvida, definir data_resolucao
      const dataResolucao = (status === 'resolvida' || status === 'fechada') ? 'NOW()' : null;

      const result = await pool.query(`
        UPDATE cs_ocorrencias SET
          titulo = COALESCE($1, titulo),
          descricao = COALESCE($2, descricao),
          tipo = COALESCE($3, tipo),
          severidade = COALESCE($4, severidade),
          status = COALESCE($5, status),
          responsavel_cod = COALESCE($6, responsavel_cod),
          responsavel_nome = COALESCE($7, responsavel_nome),
          resolucao = COALESCE($8, resolucao),
          impacto_operacional = COALESCE($9, impacto_operacional),
          tags = COALESCE($10, tags),
          data_resolucao = CASE WHEN $5 IN ('resolvida', 'fechada') AND data_resolucao IS NULL THEN NOW() ELSE data_resolucao END,
          updated_at = NOW()
        WHERE id = $11
        RETURNING *
      `, [
        titulo, descricao, tipo, severidade, status,
        responsavel_cod, responsavel_nome, resolucao,
        impacto_operacional,
        tags ? JSON.stringify(tags) : null, id,
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Ocorrência não encontrada' });
      }

      res.json({ success: true, ocorrencia: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao atualizar ocorrência CS:', error);
      res.status(500).json({ error: 'Erro ao atualizar ocorrência' });
    }
  });

  // ==================== DELETE /cs/ocorrencias/:id ====================
  router.delete('/cs/ocorrencias/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = await pool.query('DELETE FROM cs_ocorrencias WHERE id = $1 RETURNING id', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
      res.json({ success: true, message: 'Ocorrência removida' });
    } catch (error) {
      console.error('❌ Erro ao deletar ocorrência CS:', error);
      res.status(500).json({ error: 'Erro ao deletar ocorrência' });
    }
  });

  return router;
}

module.exports = { createOcorrenciasRoutes };
