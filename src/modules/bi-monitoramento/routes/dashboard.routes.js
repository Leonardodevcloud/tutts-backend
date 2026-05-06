/**
 * BI Monitoramento - Dashboard Routes
 *
 * v2 (2026-05-06):
 *  - Tempo médio agora usa a fórmula CASE WHEN do BI principal (descarta lixo
 *    de OS abertas durante a noite/dias)
 *  - JOIN com bi_mascaras pra exibir nome_display
 *  - cod_cliente, centro_custo e categoria aceitam múltiplos valores
 *    (CSV no query string, ex: "cod_cliente=767,860")
 *  - Filtro 'regiao' agora resolve via bi_regioes -> pares (cod, cc)
 *  - Tabela por cliente devolve também centros_custo[] com KPIs por CC
 */
const express = require('express');

const RETORNO_FILTRO = `(
  LOWER(ocorrencia) LIKE '%cliente fechado%' OR
  LOWER(ocorrencia) LIKE '%clienteaus%' OR
  LOWER(ocorrencia) LIKE '%cliente ausente%' OR
  LOWER(ocorrencia) LIKE '%loja fechada%' OR
  LOWER(ocorrencia) LIKE '%produto incorreto%' OR
  LOWER(ocorrencia) LIKE '%retorno%'
)`;

/**
 * Fórmula SQL idêntica ao BI principal pra calcular tempo de entrega.
 * Lida com OS que finalizam em outro dia: começa a contar das 08:00 do
 * dia da chegada (em vez de contar a noite inteira).
 *
 * Retorna minutos ou NULL.
 */
const TEMPO_ENTREGA_EXPR = `(
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
)`;

/**
 * Resolve uma região (nome) -> conjunto de cod_cliente "todos os CC" e
 * conjunto de pares cliente:cc específicos.
 */
async function resolverRegiao(pool, nomeRegiao) {
  if (!nomeRegiao) return null;
  const r = await pool.query(
    'SELECT clientes FROM bi_regioes WHERE nome = $1 LIMIT 1',
    [nomeRegiao]
  );
  if (r.rows.length === 0) return { codClientes: [], pares: new Set() };

  let itens = r.rows[0].clientes;
  if (typeof itens === 'string') {
    try { itens = JSON.parse(itens); } catch { itens = []; }
  }
  if (!Array.isArray(itens)) return { codClientes: [], pares: new Set() };

  const codClientesSemCC = [];
  const pares = new Set();

  for (const item of itens) {
    let cod, cc;
    if (typeof item === 'object' && item !== null) {
      cod = item.cod_cliente; cc = item.centro_custo;
    } else {
      cod = item; cc = null;
    }
    if (cod === undefined || cod === null) continue;

    if (cc === null || cc === undefined || cc === '') {
      codClientesSemCC.push(cod);
    } else {
      pares.add(`${cod}:${cc}`);
    }
  }
  return { codClientes: codClientesSemCC, pares };
}

/** Converte string CSV ou array em array limpo. */
function parseCsv(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.filter(x => x !== '' && x !== null && x !== undefined);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Constrói WHERE parametrizado com filtros e (opcional) restrição de região.
 * Retorna { where, params }.
 */
async function montarWhere(pool, query) {
  const {
    data_inicio, data_fim, cod_prof,
    status_prazo, status_retorno, cidade, regiao
  } = query;

  const codClientes = parseCsv(query.cod_cliente).map(v => parseInt(v, 10)).filter(n => !isNaN(n));
  const centrosCusto = parseCsv(query.centro_custo);
  const categorias = parseCsv(query.categoria);

  let where = 'WHERE COALESCE(ponto, 1) >= 2';
  const params = [];
  let i = 1;

  if (data_inicio) { where += ` AND data_solicitado >= $${i++}`; params.push(data_inicio); }
  if (data_fim)    { where += ` AND data_solicitado <= $${i++}`; params.push(data_fim); }

  if (codClientes.length === 1) {
    where += ` AND cod_cliente = $${i++}`; params.push(codClientes[0]);
  } else if (codClientes.length > 1) {
    where += ` AND cod_cliente = ANY($${i++}::int[])`; params.push(codClientes);
  }

  if (centrosCusto.length === 1) {
    where += ` AND centro_custo = $${i++}`; params.push(centrosCusto[0]);
  } else if (centrosCusto.length > 1) {
    where += ` AND centro_custo = ANY($${i++}::text[])`; params.push(centrosCusto);
  }

  if (categorias.length === 1) {
    where += ` AND categoria ILIKE $${i++}`; params.push('%' + categorias[0] + '%');
  } else if (categorias.length > 1) {
    where += ` AND categoria = ANY($${i++}::text[])`; params.push(categorias);
  }

  if (cod_prof) { where += ` AND cod_prof = $${i++}`; params.push(cod_prof); }
  if (cidade)   { where += ` AND cidade = $${i++}`;   params.push(cidade); }

  if (status_prazo === 'dentro') where += ` AND dentro_prazo = true`;
  else if (status_prazo === 'fora') where += ` AND dentro_prazo = false`;

  if (status_retorno === 'com_retorno') {
    where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE ${RETORNO_FILTRO})`;
  } else if (status_retorno === 'sem_retorno') {
    where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE ${RETORNO_FILTRO})`;
  }

  // Filtro de região: resolve aqui pra adicionar no WHERE
  if (regiao) {
    const reg = await resolverRegiao(pool, regiao);
    if (reg) {
      const condicoes = [];
      if (reg.codClientes.length > 0) {
        condicoes.push(`cod_cliente = ANY($${i++}::int[])`);
        params.push(reg.codClientes.map(Number));
      }
      if (reg.pares.size > 0) {
        const orPair = [];
        for (const par of reg.pares) {
          const idx = par.indexOf(':');
          const c = par.slice(0, idx);
          const cc = par.slice(idx + 1);
          orPair.push(`(cod_cliente = $${i++} AND centro_custo = $${i++})`);
          params.push(parseInt(c, 10), cc);
        }
        condicoes.push('(' + orPair.join(' OR ') + ')');
      }
      if (condicoes.length === 0) {
        where += ` AND 1 = 0`;
      } else {
        where += ` AND (${condicoes.join(' OR ')})`;
      }
    } else {
      where += ` AND 1 = 0`;
    }
  }

  return { where, params };
}

function createDashboardRoutes(pool) {
  const router = express.Router();

  router.get('/bi-monitoramento/dashboard', async (req, res) => {
    try {
      const { where, params } = await montarWhere(pool, req.query);

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
          ROUND(AVG(${TEMPO_ENTREGA_EXPR})::numeric, 2) as tempo_medio,
          ROUND(AVG(distancia)::numeric, 2) as distancia_media,
          ROUND(SUM(distancia)::numeric, 2) as distancia_total,
          COUNT(DISTINCT cod_prof) as total_entregadores,
          COUNT(DISTINCT cod_cliente) as total_clientes,
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 2) as media_entregas_entregador,
          COUNT(*) FILTER (WHERE ${RETORNO_FILTRO}) as retornos
        FROM bi_entregas ${where}
      `, params);

      // Carrega máscaras (cod_cliente -> nome legal)
      const mascarasResult = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras')
        .catch(() => ({ rows: [] }));
      const mapMascaras = {};
      mascarasResult.rows.forEach(m => { mapMascaras[String(m.cod_cliente)] = m.mascara; });

      // Resumo POR CLIENTE
      const porClienteQuery = await pool.query(`
        SELECT
          cod_cliente,
          MAX(nome_fantasia) as nome_fantasia,
          MAX(nome_cliente) as nome_cliente,
          COUNT(DISTINCT os) as total_os,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE ${RETORNO_FILTRO}) as retornos,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
          ROUND(AVG(${TEMPO_ENTREGA_EXPR})::numeric, 1) as tempo_medio,
          COUNT(DISTINCT cod_prof) as total_profissionais,
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 2) as media_ent_prof,
          MAX(data_solicitado) as ultima_entrega
        FROM bi_entregas ${where} AND cod_cliente IS NOT NULL
        GROUP BY cod_cliente
        ORDER BY total_entregas DESC
      `, params);

      // Resumo POR CLIENTE + CENTRO DE CUSTO (pra expansão do +)
      const porClienteCcQuery = await pool.query(`
        SELECT
          cod_cliente,
          centro_custo,
          COUNT(DISTINCT os) as total_os,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE ${RETORNO_FILTRO}) as retornos,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) /
                NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
          ROUND(AVG(${TEMPO_ENTREGA_EXPR})::numeric, 1) as tempo_medio,
          COUNT(DISTINCT cod_prof) as total_profissionais
        FROM bi_entregas ${where} AND cod_cliente IS NOT NULL AND centro_custo IS NOT NULL
        GROUP BY cod_cliente, centro_custo
        ORDER BY cod_cliente, total_entregas DESC
      `, params);

      // Agrupa centros por cliente
      const ccPorCliente = new Map();
      porClienteCcQuery.rows.forEach(r => {
        const k = String(r.cod_cliente);
        if (!ccPorCliente.has(k)) ccPorCliente.set(k, []);
        ccPorCliente.get(k).push({
          centro_custo: r.centro_custo,
          total_os: Number(r.total_os),
          total_entregas: Number(r.total_entregas),
          retornos: Number(r.retornos),
          dentro_prazo: Number(r.dentro_prazo),
          fora_prazo: Number(r.fora_prazo),
          taxa_prazo: r.taxa_prazo == null ? null : Number(r.taxa_prazo),
          tempo_medio: r.tempo_medio == null ? null : Number(r.tempo_medio),
          total_profissionais: Number(r.total_profissionais)
        });
      });

      // Aplica nome_display (máscara) em cada cliente
      const porCliente = porClienteQuery.rows.map(c => {
        const k = String(c.cod_cliente);
        const nomeDisplay = mapMascaras[k] || c.nome_fantasia || c.nome_cliente || ('Cliente ' + c.cod_cliente);
        return {
          cod_cliente: c.cod_cliente,
          nome_fantasia: c.nome_fantasia,
          nome_cliente: c.nome_cliente,
          nome_display: nomeDisplay,
          tem_mascara: !!mapMascaras[k],
          total_os: Number(c.total_os),
          total_entregas: Number(c.total_entregas),
          retornos: Number(c.retornos),
          dentro_prazo: Number(c.dentro_prazo),
          fora_prazo: Number(c.fora_prazo),
          taxa_prazo: c.taxa_prazo == null ? null : Number(c.taxa_prazo),
          tempo_medio: c.tempo_medio == null ? null : Number(c.tempo_medio),
          total_profissionais: Number(c.total_profissionais),
          media_ent_prof: c.media_ent_prof == null ? null : Number(c.media_ent_prof),
          ultima_entrega: c.ultima_entrega,
          centros_custo: ccPorCliente.get(k) || []
        };
      });

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
        porCliente,
        porDia: porDiaQuery.rows,
        porCentro: porCentroQuery.rows
      });
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro dashboard:', err);
      res.status(500).json({ error: 'Erro ao carregar dashboard', detail: err.message });
    }
  });

  return router;
}

module.exports = {
  createDashboardRoutes,
  montarWhere,
  resolverRegiao,
  parseCsv,
  RETORNO_FILTRO,
  TEMPO_ENTREGA_EXPR
};
