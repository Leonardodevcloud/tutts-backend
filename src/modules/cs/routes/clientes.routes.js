/**
 * CS Sub-Router: Gestão de Clientes
 * CRUD + métricas do BI via bi_resumo_cliente (MESMA FONTE DO BI)
 */
const express = require('express');
const { calcularHealthScore, determinarStatusCliente, STATUS_CLIENTE } = require('../cs.service');

function createClientesRoutes(pool) {
  const router = express.Router();

  // ==================== GET /cs/clientes ====================
  // Lista todos os clientes com métricas resumidas do BI
  router.get('/cs/clientes', async (req, res) => {
    try {
      const { status, search, ordem = 'nome', direcao = 'asc', page = 1, limit = 50 } = req.query;
      const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (status) {
        whereClause += ` AND c.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (search) {
        whereClause += ` AND (c.nome_fantasia ILIKE $${paramIndex} OR c.razao_social ILIKE $${paramIndex} OR c.cnpj ILIKE $${paramIndex} OR c.cod_cliente::text ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      // Buscar clientes com métricas dos últimos 30 dias via bi_resumo_cliente
      const query = `
        SELECT 
          c.*,
          COALESCE(bi.total_entregas_30d, 0) as total_entregas_30d,
          COALESCE(bi.taxa_prazo_30d, 0) as taxa_prazo_30d,
          COALESCE(bi.valor_total_30d, 0) as valor_total_30d,
          bi.ultima_entrega,
          COALESCE(bi.total_retornos_30d, 0) as total_retornos_30d,
          COALESCE(oc.ocorrencias_abertas, 0) as ocorrencias_abertas,
          COALESCE(it.ultima_interacao, NULL) as ultima_interacao,
          COALESCE(it.total_interacoes_30d, 0) as total_interacoes_30d
        FROM cs_clientes c
        LEFT JOIN LATERAL (
          SELECT 
            SUM(total_entregas) as total_entregas_30d,
            ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 1) as taxa_prazo_30d,
            COALESCE(SUM(valor_total), 0) as valor_total_30d,
            MAX(data) as ultima_entrega,
            COALESCE(SUM(total_retornos), 0) as total_retornos_30d
          FROM bi_resumo_cliente
          WHERE cod_cliente = c.cod_cliente AND data >= CURRENT_DATE - 30
        ) bi ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) as ocorrencias_abertas
          FROM cs_ocorrencias 
          WHERE cod_cliente = c.cod_cliente AND status IN ('aberta', 'em_andamento')
        ) oc ON true
        LEFT JOIN LATERAL (
          SELECT 
            MAX(data_interacao) as ultima_interacao,
            COUNT(*) FILTER (WHERE data_interacao >= NOW() - INTERVAL '30 days') as total_interacoes_30d
          FROM cs_interacoes WHERE cod_cliente = c.cod_cliente
        ) it ON true
        ${whereClause}
        ORDER BY ${ordem === 'health' ? 'c.health_score' : ordem === 'entregas' ? 'bi.total_entregas_30d' : 'c.nome_fantasia'} ${direcao === 'desc' ? 'DESC' : 'ASC'} NULLS LAST
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      params.push(parseInt(limit), offset);

      const result = await pool.query(query, params);

      // Count total
      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM cs_clientes c ${whereClause}`,
        params.slice(0, paramIndex - 1)
      );

      res.json({
        success: true,
        clientes: result.rows,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        limit: parseInt(limit),
        statusOptions: STATUS_CLIENTE,
      });
    } catch (error) {
      console.error('❌ Erro ao listar clientes CS:', error);
      res.status(500).json({ error: 'Erro ao listar clientes' });
    }
  });

  // ==================== GET /cs/clientes/:cod ====================
  // Detalhes completos de um cliente
  router.get('/cs/clientes/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      if (!cod || isNaN(cod)) return res.status(400).json({ error: 'Código inválido' });

      // Dados da ficha
      const fichaResult = await pool.query(
        'SELECT * FROM cs_clientes WHERE cod_cliente = $1', [cod]
      );

      // Se não existe ficha, criar automaticamente com dados do BI
      let ficha = fichaResult.rows[0];
      if (!ficha) {
        const biInfo = await pool.query(
          `SELECT DISTINCT nome_fantasia, cod_cliente
           FROM bi_resumo_cliente WHERE cod_cliente = $1 LIMIT 1`, [cod]
        );
        if (biInfo.rows.length > 0) {
          const bi = biInfo.rows[0];
          const insertResult = await pool.query(
            `INSERT INTO cs_clientes (cod_cliente, nome_fantasia, status)
             VALUES ($1, LEFT($2, 255), 'ativo')
             ON CONFLICT (cod_cliente) DO NOTHING
             RETURNING *`,
            [cod, bi.nome_fantasia]
          );
          ficha = insertResult.rows[0] || { cod_cliente: cod, nome_fantasia: bi.nome_fantasia, status: 'ativo' };
        } else {
          return res.status(404).json({ error: 'Cliente não encontrado no BI' });
        }
      }

      // Métricas BI dos últimos 90 dias via bi_resumo_cliente
      const metricasBi = await pool.query(`
        SELECT 
          COALESCE(SUM(total_entregas), 0) as total_entregas,
          COALESCE(SUM(total_os), 0) as total_os,
          COALESCE(SUM(entregas_no_prazo), 0) as entregas_no_prazo,
          COALESCE(SUM(entregas_fora_prazo), 0) as entregas_fora_prazo,
          ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 1) as taxa_prazo,
          COALESCE(SUM(valor_total), 0) as valor_total,
          COALESCE(SUM(valor_prof), 0) as valor_prof,
          ROUND(AVG(CASE WHEN tempo_medio_entrega > 0 THEN tempo_medio_entrega END), 1) as tempo_medio,
          COALESCE(SUM(total_retornos), 0) as total_retornos,
          COALESCE(SUM(total_profissionais), 0) as profissionais_unicos,
          MAX(data) as ultima_entrega,
          MIN(data) as primeira_entrega
        FROM bi_resumo_cliente
        WHERE cod_cliente = $1
          AND data >= CURRENT_DATE - 90
      `, [cod]);

      // Evolução por semana (últimos 90 dias) via bi_resumo_cliente
      const evolucaoSemanal = await pool.query(`
        SELECT 
          DATE_TRUNC('week', data)::date as semana,
          SUM(total_entregas) as entregas,
          ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 1) as taxa_prazo,
          COALESCE(SUM(valor_total), 0) as valor
        FROM bi_resumo_cliente
        WHERE cod_cliente = $1 AND data >= CURRENT_DATE - 90
        GROUP BY DATE_TRUNC('week', data)
        ORDER BY semana
      `, [cod]);

      // Últimas interações
      const interacoes = await pool.query(
        `SELECT * FROM cs_interacoes WHERE cod_cliente = $1 ORDER BY data_interacao DESC LIMIT 10`, [cod]
      );

      // Ocorrências abertas
      const ocorrencias = await pool.query(
        `SELECT * FROM cs_ocorrencias WHERE cod_cliente = $1 AND status IN ('aberta', 'em_andamento') ORDER BY data_abertura DESC`, [cod]
      );

      // Últimos raio-x
      const raioXHistorico = await pool.query(
        `SELECT id, data_inicio, data_fim, score_saude, tipo_analise, created_at FROM cs_raio_x_historico WHERE cod_cliente = $1 ORDER BY created_at DESC LIMIT 5`, [cod]
      );

      // Calcular health score atualizado
      const metricas = metricasBi.rows[0];
      const healthScore = calcularHealthScore(metricas);
      const diasSemEntrega = metricas.ultima_entrega
        ? Math.floor((Date.now() - new Date(metricas.ultima_entrega).getTime()) / (1000 * 60 * 60 * 24))
        : 999;
      const statusSugerido = determinarStatusCliente(healthScore, diasSemEntrega);

      // Atualizar health score no banco
      await pool.query(
        'UPDATE cs_clientes SET health_score = $1, updated_at = NOW() WHERE cod_cliente = $2',
        [healthScore, cod]
      ).catch(() => {});

      res.json({
        success: true,
        ficha: { ...ficha, health_score: healthScore },
        metricas_bi: metricas,
        evolucao_semanal: evolucaoSemanal.rows,
        interacoes: interacoes.rows,
        ocorrencias: ocorrencias.rows,
        raio_x_historico: raioXHistorico.rows,
        diagnostico: {
          health_score: healthScore,
          status_sugerido: statusSugerido,
          dias_sem_entrega: diasSemEntrega,
        },
      });
    } catch (error) {
      console.error('❌ Erro ao buscar detalhes CS:', error);
      res.status(500).json({ error: 'Erro ao buscar detalhes do cliente' });
    }
  });

  // ==================== PUT /cs/clientes/:cod ====================
  // Atualizar ficha do cliente
  router.put('/cs/clientes/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      const {
        razao_social, cnpj, telefone, email, endereco, cidade, estado,
        responsavel_nome, responsavel_telefone, responsavel_email,
        segmento, porte, data_inicio_parceria, observacoes, tags, status,
      } = req.body;

      const result = await pool.query(`
        UPDATE cs_clientes SET
          razao_social = COALESCE($1, razao_social),
          cnpj = COALESCE($2, cnpj),
          telefone = COALESCE($3, telefone),
          email = COALESCE($4, email),
          endereco = COALESCE($5, endereco),
          cidade = COALESCE($6, cidade),
          estado = COALESCE($7, estado),
          responsavel_nome = COALESCE($8, responsavel_nome),
          responsavel_telefone = COALESCE($9, responsavel_telefone),
          responsavel_email = COALESCE($10, responsavel_email),
          segmento = COALESCE($11, segmento),
          porte = COALESCE($12, porte),
          data_inicio_parceria = COALESCE($13, data_inicio_parceria),
          observacoes = COALESCE($14, observacoes),
          tags = COALESCE($15, tags),
          status = COALESCE($16, status),
          updated_by = $17,
          updated_at = NOW()
        WHERE cod_cliente = $18
        RETURNING *
      `, [
        razao_social, cnpj, telefone, email, endereco, cidade, estado,
        responsavel_nome, responsavel_telefone, responsavel_email,
        segmento, porte, data_inicio_parceria, observacoes,
        tags ? JSON.stringify(tags) : null, status,
        req.user?.codProfissional, cod,
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
      }

      res.json({ success: true, cliente: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao atualizar cliente CS:', error);
      res.status(500).json({ error: 'Erro ao atualizar cliente' });
    }
  });

  // ==================== POST /cs/clientes/sync-bi ====================
  // Sincroniza clientes do BI que ainda não têm ficha CS
  router.post('/cs/clientes/sync-bi', async (req, res) => {
    try {
      const result = await pool.query(`
        INSERT INTO cs_clientes (cod_cliente, nome_fantasia, status)
        SELECT DISTINCT 
          e.cod_cliente, 
          LEFT(MAX(e.nome_fantasia), 255),
          'ativo'
        FROM bi_resumo_cliente e
        WHERE e.cod_cliente IS NOT NULL
          AND e.cod_cliente NOT IN (SELECT cod_cliente FROM cs_clientes)
          AND e.data >= CURRENT_DATE - 90
        GROUP BY e.cod_cliente
        ON CONFLICT (cod_cliente) DO NOTHING
        RETURNING cod_cliente, nome_fantasia
      `);

      console.log(`📥 CS Sync: ${result.rows.length} novos clientes importados do BI`);
      res.json({
        success: true,
        importados: result.rows.length,
        clientes: result.rows,
      });
    } catch (error) {
      console.error('❌ Erro ao sincronizar clientes do BI:', error);
      res.status(500).json({ error: 'Erro ao sincronizar' });
    }
  });

  return router;
}

module.exports = { createClientesRoutes };
