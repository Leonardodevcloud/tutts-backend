/**
 * CS Sub-Router: Dashboard
 * KPIs consolidados — FONTE DIRETA: bi_entregas (mesma do BI dashboard-completo)
 */
const express = require('express');
const { STATUS_CLIENTE, TIPOS_INTERACAO, SEVERIDADES } = require('../cs.service');

function createDashboardRoutes(pool) {
  const router = express.Router();

  // ==================== GET /cs/dashboard ====================
  router.get('/cs/dashboard', async (req, res) => {
    try {
      const { data_inicio, data_fim } = req.query;

      const inicio = data_inicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const fim = data_fim || new Date().toISOString().split('T')[0];

      // 1. KPIs dos clientes CS
      const kpisClientes = await pool.query(`
        SELECT 
          COUNT(*) as total_clientes,
          COUNT(*) FILTER (WHERE status = 'ativo') as ativos,
          COUNT(*) FILTER (WHERE status = 'em_risco') as em_risco,
          COUNT(*) FILTER (WHERE status = 'inativo') as inativos,
          COUNT(*) FILTER (WHERE status = 'churned') as churned,
          ROUND(AVG(health_score), 1) as health_score_medio,
          COUNT(*) FILTER (WHERE health_score >= 70) as saudaveis,
          COUNT(*) FILTER (WHERE health_score < 30) as criticos
        FROM cs_clientes
      `);

      // 2. KPIs de interações no período
      const kpisInteracoes = await pool.query(`
        SELECT
          COUNT(*) as total_interacoes,
          COUNT(DISTINCT cod_cliente) as clientes_contatados,
          COUNT(*) FILTER (WHERE tipo = 'visita') as visitas,
          COUNT(*) FILTER (WHERE tipo = 'reuniao') as reunioes,
          COUNT(*) FILTER (WHERE tipo = 'ligacao') as ligacoes,
          COUNT(*) FILTER (WHERE tipo = 'pos_venda') as pos_vendas,
          COUNT(*) FILTER (WHERE tipo = 'whatsapp') as whatsapp,
          COUNT(*) FILTER (WHERE data_proxima_acao IS NOT NULL AND data_proxima_acao >= CURRENT_DATE AND data_proxima_acao <= CURRENT_DATE + 7) as acoes_proximos_7d
        FROM cs_interacoes
        WHERE data_interacao >= $1 AND data_interacao <= $2::date + 1
      `, [inicio, fim]);

      // 3. KPIs de ocorrências
      const kpisOcorrencias = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('aberta', 'em_andamento')) as abertas,
          COUNT(*) FILTER (WHERE severidade = 'critica' AND status IN ('aberta', 'em_andamento')) as criticas,
          COUNT(*) FILTER (WHERE status = 'resolvida' AND data_resolucao >= $1) as resolvidas_periodo,
          ROUND(AVG(
            CASE WHEN status IN ('resolvida', 'fechada') AND data_resolucao IS NOT NULL 
            THEN EXTRACT(EPOCH FROM (data_resolucao - data_abertura)) / 3600 END
          ), 1) as tempo_medio_resolucao_horas
        FROM cs_ocorrencias
      `, [inicio]);

      // ============================================
      // 4. Métricas operacionais — FONTE DIRETA: bi_entregas
      //    Mesma lógica do /bi/dashboard-completo
      //    Conta apenas pontos >= 2 como entregas
      // ============================================
      const metricasBi = await pool.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
          ROUND(
            SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 END), 0) * 100
          , 2) as taxa_prazo_global,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
          ROUND(
            COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric -
            COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0)::numeric
          , 2) as faturamento_total,
          ROUND(
            COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric /
            NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0)
          , 2) as ticket_medio,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR
            LOWER(ocorrencia) LIKE '%%clienteaus%%' OR
            LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR
            LOWER(ocorrencia) LIKE '%%loja fechada%%' OR
            LOWER(ocorrencia) LIKE '%%produto incorreto%%'
          ) THEN 1 ELSE 0 END) as total_retornos,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_profissionais,
          -- Tempo médio entrega (Ponto >= 2): Solicitado -> Chegada — mesma lógica SQL do BI
          ROUND(AVG(
            CASE 
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND data_chegada IS NOT NULL 
                   AND hora_chegada IS NOT NULL
                   AND (data_chegada + hora_chegada::time) >= data_hora
              THEN
                EXTRACT(EPOCH FROM (
                  (data_chegada + hora_chegada::time) - 
                  CASE 
                    WHEN DATE(data_chegada) <> DATE(data_hora)
                    THEN DATE(data_chegada) + TIME '08:00:00'
                    ELSE data_hora
                  END
                )) / 60
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND finalizado IS NOT NULL
                   AND finalizado >= data_hora
              THEN
                EXTRACT(EPOCH FROM (
                  finalizado - 
                  CASE 
                    WHEN DATE(finalizado) <> DATE(data_hora)
                    THEN DATE(finalizado) + TIME '08:00:00'
                    ELSE data_hora
                  END
                )) / 60
              ELSE NULL
            END
          ), 2) as tempo_medio_entrega
        FROM bi_entregas
        WHERE data_solicitado >= $1 AND data_solicitado <= $2
      `, [inicio, fim]);

      // 5. Clientes ativos no período — FONTE DIRETA: bi_entregas
      const clientesAtivosBi = await pool.query(`
        SELECT COUNT(DISTINCT cod_cliente) as clientes_ativos_bi
        FROM bi_entregas
        WHERE data_solicitado >= $1 AND data_solicitado <= $2
          AND COALESCE(ponto, 1) >= 2
          AND cod_cliente IS NOT NULL
      `, [inicio, fim]);

      // 6. Top 5 clientes em risco (health score baixo + métricas do bi_entregas)
      const clientesRisco = await pool.query(`
        SELECT 
          c.cod_cliente, c.nome_fantasia, c.health_score, c.status,
          COALESCE(oc.abertas, 0) as ocorrencias_abertas,
          COALESCE(bi.total_entregas_30d, 0) as total_entregas_30d,
          COALESCE(bi.taxa_prazo_30d, 0) as taxa_prazo_30d
        FROM cs_clientes c
        LEFT JOIN LATERAL (
          SELECT COUNT(*) as abertas FROM cs_ocorrencias
          WHERE cod_cliente = c.cod_cliente AND status IN ('aberta', 'em_andamento')
        ) oc ON true
        LEFT JOIN LATERAL (
          SELECT 
            COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas_30d,
            ROUND(
              SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 END), 0) * 100
            , 1) as taxa_prazo_30d
          FROM bi_entregas 
          WHERE cod_cliente = c.cod_cliente 
            AND data_solicitado >= CURRENT_DATE - 30
            AND COALESCE(ponto, 1) >= 2
        ) bi ON true
        WHERE c.health_score < 50 OR c.status IN ('em_risco', 'inativo')
        ORDER BY c.health_score ASC, oc.abertas DESC
        LIMIT 5
      `);

      // 7. Interações recentes (últimas 10)
      const interacoesRecentes = await pool.query(`
        SELECT i.id, i.tipo, i.titulo, i.data_interacao, i.criado_por_nome, i.cod_cliente, c.nome_fantasia
        FROM cs_interacoes i
        LEFT JOIN cs_clientes c ON c.cod_cliente = i.cod_cliente
        ORDER BY i.data_interacao DESC
        LIMIT 10
      `);

      // 8. Distribuição Health Score
      const distribuicaoHealth = await pool.query(`
        SELECT 
          CASE 
            WHEN health_score >= 80 THEN 'Excelente (80-100)'
            WHEN health_score >= 60 THEN 'Bom (60-79)'
            WHEN health_score >= 40 THEN 'Atenção (40-59)'
            WHEN health_score >= 20 THEN 'Crítico (20-39)'
            ELSE 'Urgente (0-19)'
          END as faixa,
          COUNT(*) as quantidade,
          CASE 
            WHEN health_score >= 80 THEN '#10B981'
            WHEN health_score >= 60 THEN '#3B82F6'
            WHEN health_score >= 40 THEN '#F59E0B'
            WHEN health_score >= 20 THEN '#F97316'
            ELSE '#EF4444'
          END as cor
        FROM cs_clientes
        GROUP BY 
          CASE 
            WHEN health_score >= 80 THEN 'Excelente (80-100)'
            WHEN health_score >= 60 THEN 'Bom (60-79)'
            WHEN health_score >= 40 THEN 'Atenção (40-59)'
            WHEN health_score >= 20 THEN 'Crítico (20-39)'
            ELSE 'Urgente (0-19)'
          END,
          CASE 
            WHEN health_score >= 80 THEN '#10B981'
            WHEN health_score >= 60 THEN '#3B82F6'
            WHEN health_score >= 40 THEN '#F59E0B'
            WHEN health_score >= 20 THEN '#F97316'
            ELSE '#EF4444'
          END
        ORDER BY MIN(health_score) DESC
      `);

      // Montar objeto operação
      const operacao = metricasBi.rows[0] || {};
      operacao.clientes_ativos_bi = parseInt(clientesAtivosBi.rows[0]?.clientes_ativos_bi) || 0;

      res.json({
        success: true,
        periodo: { inicio, fim },
        kpis: {
          clientes: kpisClientes.rows[0],
          interacoes: kpisInteracoes.rows[0],
          ocorrencias: kpisOcorrencias.rows[0],
          operacao,
        },
        clientes_risco: clientesRisco.rows,
        interacoes_recentes: interacoesRecentes.rows,
        distribuicao_health: distribuicaoHealth.rows,
      });
    } catch (error) {
      console.error('❌ Erro ao carregar dashboard CS:', error);
      res.status(500).json({ error: 'Erro ao carregar dashboard' });
    }
  });

  // ==================== GET /cs/constantes ====================
  router.get('/cs/constantes', async (req, res) => {
    res.json({
      success: true,
      tipos_interacao: TIPOS_INTERACAO,
      tipos_ocorrencia: require('../cs.service').TIPOS_OCORRENCIA,
      severidades: SEVERIDADES,
      status_ocorrencia: require('../cs.service').STATUS_OCORRENCIA,
      status_cliente: STATUS_CLIENTE,
    });
  });

  return router;
}

module.exports = { createDashboardRoutes };
