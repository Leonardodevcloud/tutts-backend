/**
 * MÓDULO LOGISTICS — Dashboard Routes (Fase 4)
 *
 * Endpoints de observabilidade do hub. Saem do 501.
 *
 *   GET /metrics  — agregados: despachos, taxa de sucesso, comparativo de
 *                   providers, decisões de estratégia, margem média.
 *   GET /events   — feed paginado de logistics_events com filtros.
 *
 * Ambos leem de logistics_events e logistics_deliveries. Não escrevem nada.
 * São read-only e seguros — montados com verificarToken.
 *
 * Filtros suportados (query params):
 *   /metrics?dias=7                   — janela temporal (default 7)
 *   /events?provider=uber&tipo=quote_created&limit=50&offset=0&codigo_os=123
 */

const express = require('express');

function createDashboardRoutes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // ───────────────────────────────────────────────────────────
  // GET /metrics — agregados do hub
  // ───────────────────────────────────────────────────────────
  router.get('/metrics', verificarToken, async (req, res) => {
    try {
      const dias = Math.min(parseInt(req.query.dias, 10) || 7, 90);
      const desde = `NOW() - INTERVAL '${dias} days'`;

      // 1. Resumo de eventos por tipo
      const { rows: porTipo } = await pool.query(`
        SELECT event_type, COUNT(*)::int AS total
        FROM logistics_events
        WHERE created_at > ${desde}
        GROUP BY event_type
        ORDER BY total DESC
      `);

      // 2. Despachos por provider (sucesso vs falha)
      const { rows: porProvider } = await pool.query(`
        SELECT
          provider_code,
          COUNT(*) FILTER (WHERE event_type = 'dispatch_success')::int AS sucessos,
          COUNT(*) FILTER (WHERE event_type = 'dispatch_failed')::int  AS falhas,
          COUNT(*) FILTER (WHERE event_type = 'quote_created')::int    AS cotacoes
        FROM logistics_events
        WHERE created_at > ${desde}
          AND provider_code <> 'none'
        GROUP BY provider_code
        ORDER BY sucessos DESC
      `);

      // 3. Decisões de estratégia (Fase 4) — quantas vezes cada estratégia rodou
      //    e qual provider venceu. Lê do payload JSONB dos eventos strategy_decided.
      const { rows: estrategias } = await pool.query(`
        SELECT
          payload->>'estrategia' AS estrategia,
          payload->>'vencedor'   AS provider_vencedor,
          COUNT(*)::int          AS total
        FROM logistics_events
        WHERE event_type = 'strategy_decided'
          AND created_at > ${desde}
        GROUP BY payload->>'estrategia', payload->>'vencedor'
        ORDER BY total DESC
      `);

      // 4. Estado atual das entregas (snapshot de logistics_deliveries)
      const { rows: entregasPorStatus } = await pool.query(`
        SELECT provider_code, status_canonico, COUNT(*)::int AS total
        FROM logistics_deliveries
        GROUP BY provider_code, status_canonico
        ORDER BY provider_code, total DESC
      `);

      // 5. Margem média e ticket médio por provider (das entregas com valores)
      const { rows: financeiro } = await pool.query(`
        SELECT
          provider_code,
          COUNT(*)::int AS entregas_com_valor,
          ROUND(AVG(valor_servico)::numeric, 2)    AS ticket_medio_servico,
          ROUND(AVG(valor_provider)::numeric, 2)   AS custo_medio_provider,
          ROUND(AVG(valor_servico - valor_provider)::numeric, 2) AS margem_media
        FROM logistics_deliveries
        WHERE valor_servico IS NOT NULL AND valor_provider IS NOT NULL
        GROUP BY provider_code
      `);

      // 6. Totais rápidos
      const { rows: [totais] } = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM logistics_deliveries) AS total_entregas,
          (SELECT COUNT(*)::int FROM logistics_events WHERE created_at > ${desde}) AS eventos_periodo,
          (SELECT COUNT(*)::int FROM logistics_providers WHERE ativo = true) AS providers_ativos,
          (SELECT COUNT(*)::int FROM logistics_dispatch_rules WHERE ativo = true) AS regras_ativas
      `);

      // Calcula taxa de sucesso global
      const totalSucessos = porProvider.reduce((s, p) => s + p.sucessos, 0);
      const totalFalhas = porProvider.reduce((s, p) => s + p.falhas, 0);
      const taxaSucesso = (totalSucessos + totalFalhas) > 0
        ? Math.round((totalSucessos / (totalSucessos + totalFalhas)) * 100)
        : null;

      res.json({
        success: true,
        periodo_dias: dias,
        gerado_em: new Date().toISOString(),
        totais: {
          ...totais,
          despachos_sucesso: totalSucessos,
          despachos_falha: totalFalhas,
          taxa_sucesso_pct: taxaSucesso,
        },
        eventos_por_tipo: porTipo,
        despachos_por_provider: porProvider,
        estrategias: estrategias,
        entregas_por_status: entregasPorStatus,
        financeiro_por_provider: financeiro,
      });
    } catch (err) {
      console.error('[logistics/dashboard] erro /metrics:', err.message);
      res.status(500).json({ error: 'Erro ao gerar métricas', detalhe: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /events — feed paginado de eventos
  // ───────────────────────────────────────────────────────────
  router.get('/events', verificarToken, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      // Filtros opcionais — montados com $N parametrizado
      const where = [];
      const params = [];
      let p = 1;

      if (req.query.provider) {
        where.push(`provider_code = $${p++}`);
        params.push(String(req.query.provider).toLowerCase());
      }
      if (req.query.tipo) {
        where.push(`event_type = $${p++}`);
        params.push(String(req.query.tipo));
      }
      if (req.query.codigo_os) {
        where.push(`codigo_os = $${p++}`);
        params.push(parseInt(req.query.codigo_os, 10));
      }
      if (req.query.source) {
        where.push(`event_source = $${p++}`);
        params.push(String(req.query.source));
      }
      if (req.query.so_erros === 'true') {
        where.push(`erro IS NOT NULL`);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      // Total (pra paginação)
      const { rows: [{ total }] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM logistics_events ${whereSql}`,
        params
      );

      // Página
      const { rows: eventos } = await pool.query(
        `SELECT
           id, provider_code, delivery_id, codigo_os, external_delivery_id,
           event_type, event_source, status_canonico, status_native,
           payload, erro, processado, created_at
         FROM logistics_events
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, limit, offset]
      );

      res.json({
        success: true,
        total,
        limit,
        offset,
        tem_mais: offset + eventos.length < total,
        eventos,
      });
    } catch (err) {
      console.error('[logistics/dashboard] erro /events:', err.message);
      res.status(500).json({ error: 'Erro ao listar eventos', detalhe: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /events/:codigoOS/timeline — timeline de uma OS específica
  // (extra útil: todos os eventos de uma OS em ordem cronológica)
  // ───────────────────────────────────────────────────────────
  router.get('/events/timeline/:codigoOS', verificarToken, async (req, res) => {
    try {
      const codigoOS = parseInt(req.params.codigoOS, 10);
      const { rows } = await pool.query(
        `SELECT id, provider_code, event_type, event_source, status_canonico,
                status_native, payload, erro, created_at
         FROM logistics_events
         WHERE codigo_os = $1
         ORDER BY created_at ASC, id ASC`,
        [codigoOS]
      );
      res.json({ success: true, codigo_os: codigoOS, eventos: rows });
    } catch (err) {
      console.error('[logistics/dashboard] erro /events/timeline:', err.message);
      res.status(500).json({ error: 'Erro ao gerar timeline', detalhe: err.message });
    }
  });

  return router;
}

module.exports = { createDashboardRoutes };
