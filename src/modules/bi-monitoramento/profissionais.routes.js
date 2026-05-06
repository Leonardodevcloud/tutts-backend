/**
 * BI Monitoramento - Aba "Por Profissional"
 *
 * Lista motoboys com KPIs operacionais.
 * SEM valor_total e valor_prof.
 */
const express = require('express');
const { montarWhere, RETORNO_FILTRO } = require('./dashboard.routes');

function createProfissionaisRoutes(pool) {
  const router = express.Router();

  /**
   * GET /api/bi-monitoramento/profissionais
   * Aceita os mesmos filtros do dashboard.
   */
  router.get('/bi-monitoramento/profissionais', async (req, res) => {
    try {
      const { where, params } = montarWhere(req.query);

      const profissionaisQuery = await pool.query(`
        SELECT
          cod_prof,
          MAX(nome_prof) as nome_prof,
          COUNT(DISTINCT os) as total_os,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
          COUNT(*) FILTER (WHERE ${RETORNO_FILTRO}) as retornos,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
          ROUND(SUM(distancia)::numeric, 2) as km_total,
          COUNT(DISTINCT cod_cliente) as total_clientes,
          MAX(data_solicitado) as ultima_entrega
        FROM bi_entregas ${where} AND cod_prof IS NOT NULL
        GROUP BY cod_prof
        ORDER BY total_entregas DESC
      `, params);

      res.json({ profissionais: profissionaisQuery.rows });
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro profissionais:', err);
      res.status(500).json({ error: 'Erro ao carregar profissionais' });
    }
  });

  return router;
}

module.exports = { createProfissionaisRoutes };
