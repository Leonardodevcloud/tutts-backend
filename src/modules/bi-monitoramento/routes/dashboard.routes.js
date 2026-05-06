/**
 * BI Monitoramento - Dashboard Routes
 *
 * Reaproveita a mesma estrutura do dashboard do BI principal,
 * mas SEM nenhuma coluna ou cálculo financeiro:
 *  - Sem valor_total, valor_prof, faturamento, ticket_medio
 *  - Sem subqueries de eu_fat
 *
 * Mantém:
 *  - dentro_prazo (já pré-calculado por cliente/centro de custo)
 *  - COALESCE(ponto, 1) >= 2 (só entregas)
 *  - Retornos com mesma string-match do dashboard atual
 *  - Mesmos filtros: data, cod_cliente, centro_custo, cod_prof,
 *    categoria, status_prazo, status_retorno, cidade
 */
const express = require('express');

// String-match de retornos — idêntico ao dashboard do BI principal
// (cliente_fechado, clienteaus, cliente ausente, loja fechada, produto incorreto, retorno)
const RETORNO_FILTRO = `(
  LOWER(ocorrencia) LIKE '%cliente fechado%' OR
  LOWER(ocorrencia) LIKE '%clienteaus%' OR
  LOWER(ocorrencia) LIKE '%cliente ausente%' OR
  LOWER(ocorrencia) LIKE '%loja fechada%' OR
  LOWER(ocorrencia) LIKE '%produto incorreto%' OR
  LOWER(ocorrencia) LIKE '%retorno%'
)`;

/**
 * Constrói cláusula WHERE com os mesmos filtros do BI principal.
 * Retorna { where, params } pronto pra usar.
 */
function montarWhere(query) {
  const {
    data_inicio, data_fim, cod_cliente, centro_custo, cod_prof,
    categoria, status_prazo, status_retorno, cidade
  } = query;

  let where = 'WHERE COALESCE(ponto, 1) >= 2';
  const params = [];
  let i = 1;

  if (data_inicio) { where += ` AND data_solicitado >= $${i++}`; params.push(data_inicio); }
  if (data_fim)    { where += ` AND data_solicitado <= $${i++}`; params.push(data_fim); }
  if (cod_cliente) { where += ` AND cod_cliente = $${i++}`;      params.push(cod_cliente); }
  if (centro_custo){ where += ` AND centro_custo = $${i++}`;     params.push(centro_custo); }
  if (cod_prof)    { where += ` AND cod_prof = $${i++}`;         params.push(cod_prof); }
  if (categoria)   { where += ` AND categoria ILIKE $${i++}`;    params.push(`%${categoria}%`); }
  if (cidade)      { where += ` AND cidade = $${i++}`;           params.push(cidade); }

  if (status_prazo === 'dentro') where += ` AND dentro_prazo = true`;
  else if (status_prazo === 'fora') where += ` AND dentro_prazo = false`;

  if (status_retorno === 'com_retorno') {
    where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE ${RETORNO_FILTRO})`;
  } else if (status_retorno === 'sem_retorno') {
    where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE ${RETORNO_FILTRO})`;
  }

  return { where, params };
}

function createDashboardRoutes(pool) {
  const router = express.Router();

  /**
   * GET /api/bi-monitoramento/dashboard
   *
   * Retorna métricas operacionais consolidadas:
   *  - metricas: KPIs gerais (sem valores R$)
   *  - porCliente: tabela resumo por cliente (sem colunas R$)
   *  - porDia: evolução diária (qtd + % prazo)
   *  - porCentro: agrupamento por centro de custo
   */
  router.get('/bi-monitoramento/dashboard', async (req, res) => {
    try {
      const { where, params } = montarWhere(req.query);

      // KPIs principais — só operacional
      const metricasQuery = await pool.query(`
        SELECT
          COUNT(DISTINCT os) as total_os,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo IS NULL) as sem_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
          ROUND(AVG(distancia)::numeric, 2) as distancia_media,
          ROUND(SUM(distancia)::numeric, 2) as distancia_total,
          COUNT(DISTINCT cod_prof) as total_entregadores,
          COUNT(DISTINCT cod_cliente) as total_clientes,
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 2) as media_entregas_entregador,
          COUNT(*) FILTER (WHERE ${RETORNO_FILTRO}) as retornos
        FROM bi_entregas ${where}
      `, params);

      // Tabela resumo POR CLIENTE — só colunas operacionais
      const porClienteQuery = await pool.query(`
        SELECT
          cod_cliente,
          MAX(nome_fantasia) as nome_fantasia,
          COUNT(DISTINCT os) as total_os,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE ${RETORNO_FILTRO}) as retornos,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
          COUNT(DISTINCT cod_prof) as total_profissionais,
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 2) as media_ent_prof,
          MAX(data_solicitado) as ultima_entrega
        FROM bi_entregas ${where} AND cod_cliente IS NOT NULL
        GROUP BY cod_cliente
        ORDER BY total_entregas DESC
      `, params);

      // Evolução por dia
      const porDiaQuery = await pool.query(`
        SELECT
          data_solicitado as data,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo
        FROM bi_entregas ${where}
        GROUP BY data_solicitado
        ORDER BY data_solicitado
      `, params);

      // Por centro de custo
      const porCentroQuery = await pool.query(`
        SELECT
          centro_custo,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo
        FROM bi_entregas ${where}
        GROUP BY centro_custo
        ORDER BY total DESC
        LIMIT 30
      `, params);

      res.json({
        metricas: metricasQuery.rows[0] || {},
        porCliente: porClienteQuery.rows,
        porDia: porDiaQuery.rows,
        porCentro: porCentroQuery.rows
      });
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro dashboard:', err);
      res.status(500).json({ error: 'Erro ao carregar dashboard' });
    }
  });

  return router;
}

module.exports = { createDashboardRoutes, montarWhere, RETORNO_FILTRO };
