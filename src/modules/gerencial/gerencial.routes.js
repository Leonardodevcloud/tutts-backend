/**
 * MÓDULO GERENCIAL - Análise Gerencial Semanal
 * 2 endpoints: /gerencial/semanas + /gerencial/dados
 * Consome bi_entregas + bi_garantido_cache
 */
const express = require('express');

// Listas fixas de clientes por seção
const PORTO_SECO = [
  '4-REAL-SSA', '17-Embrepar', '480-Rolemar', '577-SK Automotive',
  '680-Auto norte', '720-AQUI TEM PECAS', '767-Pellegrino SSA',
  '767-Sama SSA', '805-NRD PEÇAS', '814-Cobra rolamentos',
  '853-VANNUCCI', '897-FURACÃO'
];

const OUTROS_MONITORADOS = [
  '949-Comando Auto Peças', '767-BR AutoParts CampinasSP',
  '767-BR AUTOPARTS PI', '767-BR autoparts Brasilia',
  '1017-Auto norte - RN', '249-Auto Norte - Filial Sergipe'
];

const CAT_FILTER = "categoria IN ('Motofrete','Motofrete - C','Motofrete (Expresso)','Tutts Fast')";
const ENTREGA_FILTER = "COALESCE(ponto, 1) >= 2";

function createGerencialRouter(pool, verificarToken) {
  const router = express.Router();

  // ══════════════════════════════════════════
  // GET /gerencial/semanas — Listar semanas disponíveis
  // ══════════════════════════════════════════
  router.get('/gerencial/semanas', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          DATE_TRUNC('week', data_solicitado)::date as seg,
          (DATE_TRUNC('week', data_solicitado) + INTERVAL '6 days')::date as dom,
          COUNT(*) as entregas
        FROM bi_entregas
        WHERE data_solicitado >= CURRENT_DATE - INTERVAL '90 days'
          AND ${CAT_FILTER} AND ${ENTREGA_FILTER}
        GROUP BY DATE_TRUNC('week', data_solicitado)
        ORDER BY seg DESC
        LIMIT 16
      `);

      const semanas = result.rows.map(function(r) {
        var s = new Date(r.seg), d = new Date(r.dom);
        return {
          data_inicio: r.seg,
          data_fim: r.dom,
          label: pad(s.getDate()) + '/' + pad(s.getMonth() + 1) + ' - ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1),
          entregas: parseInt(r.entregas),
        };
      });
      res.json({ success: true, semanas: semanas });
    } catch (error) {
      console.error('❌ Gerencial semanas:', error.message);
      res.status(500).json({ error: 'Erro ao listar semanas' });
    }
  });

  // ══════════════════════════════════════════
  // GET /gerencial/dados — Dados completos do relatório
  // ══════════════════════════════════════════
  router.get('/gerencial/dados', verificarToken, async (req, res) => {
    try {
      var { data_inicio, data_fim } = req.query;
      if (!data_inicio || !data_fim) return res.status(400).json({ error: 'data_inicio e data_fim obrigatórios' });

      var di = data_inicio, df = data_fim;
      // Semana anterior para comparação
      var diaMs = 24 * 60 * 60 * 1000;
      var diDate = new Date(di), dfDate = new Date(df);
      var diasSemana = Math.round((dfDate - diDate) / diaMs) + 1;
      var antFim = new Date(diDate.getTime() - diaMs).toISOString().split('T')[0];
      var antInicio = new Date(diDate.getTime() - diasSemana * diaMs).toISOString().split('T')[0];
      // 4 semanas atrás para ticket/demanda
      var sem4Inicio = new Date(diDate.getTime() - 3 * 7 * diaMs).toISOString().split('T')[0];

      var BASE = `data_solicitado >= $1 AND data_solicitado <= $2 AND ${CAT_FILTER} AND ${ENTREGA_FILTER}`;

      // ── Executar todas as queries em paralelo ──
      var [
        qKpi, qKpiAnt,
        q767, q767Ant,
        qSlaConcat, qSlaAnt,
        qTicket4sem,
        qGarantido, qGarFat
      ] = await Promise.all([

        // 1. KPIs da semana atual
        pool.query(`
          SELECT
            COUNT(*) as entregas,
            COUNT(DISTINCT os) as os_count,
            COUNT(DISTINCT cod_prof) as entregadores,
            SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
            COALESCE(SUM(valor), 0) as valor_total,
            COALESCE(SUM(valor_prof), 0) as valor_prof,
            ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio,
            SUM(CASE WHEN ocorrencia IS NOT NULL AND ocorrencia != '' AND LOWER(ocorrencia) NOT LIKE 'entreg%' AND LOWER(ocorrencia) NOT LIKE 'coletad%' THEN 1 ELSE 0 END) as retornos
          FROM bi_entregas WHERE ${BASE}
        `, [di, df]),

        // 2. KPIs da semana anterior
        pool.query(`
          SELECT
            COUNT(*) as entregas,
            SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
            COALESCE(SUM(valor), 0) as valor_total,
            COALESCE(SUM(valor_prof), 0) as valor_prof
          FROM bi_entregas WHERE ${BASE}
        `, [antInicio, antFim]),

        // 3. SLA 767 (Comollati) — usa SLA fixo 120min
        pool.query(`
          SELECT
            cod_cliente::text || '-' || COALESCE(centro_custo, '') as concat,
            COALESCE(nome_fantasia, centro_custo, 'Filial') as nome,
            COUNT(*) as entregas,
            SUM(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120 THEN 1 ELSE 0 END) as no_prazo,
            ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio
          FROM bi_entregas
          WHERE ${BASE} AND cod_cliente = 767
          GROUP BY cod_cliente, centro_custo, nome_fantasia
          ORDER BY COUNT(*) DESC
        `, [di, df]),

        // 4. SLA 767 semana anterior
        pool.query(`
          SELECT
            cod_cliente::text || '-' || COALESCE(centro_custo, '') as concat,
            COUNT(*) as entregas,
            SUM(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120 THEN 1 ELSE 0 END) as no_prazo
          FROM bi_entregas
          WHERE ${BASE} AND cod_cliente = 767
          GROUP BY cod_cliente, centro_custo
        `, [antInicio, antFim]),

        // 5. SLA por concat (Porto Seco + Outros) — prazo padrão
        pool.query(`
          SELECT
            cod_cliente::text || '-' || COALESCE(centro_custo, '') as concat,
            COALESCE(nome_fantasia, centro_custo, 'Cliente') as nome,
            COUNT(*) as entregas,
            SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
            ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio
          FROM bi_entregas
          WHERE ${BASE}
          GROUP BY cod_cliente, centro_custo, nome_fantasia
          HAVING COUNT(*) > 0
          ORDER BY COUNT(*) DESC
        `, [di, df]),

        // 6. SLA semana anterior (todos) — para var pp
        pool.query(`
          SELECT
            cod_cliente::text || '-' || COALESCE(centro_custo, '') as concat,
            COUNT(*) as entregas,
            SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo
          FROM bi_entregas
          WHERE ${BASE}
          GROUP BY cod_cliente, centro_custo
        `, [antInicio, antFim]),

        // 7. Ticket Médio + Demanda (4 semanas)
        pool.query(`
          SELECT
            cod_cliente::text || '-' || COALESCE(centro_custo, '') as concat,
            COALESCE(nome_fantasia, centro_custo, 'Cliente ' || cod_cliente) as nome,
            DATE_TRUNC('week', data_solicitado)::date as semana,
            COUNT(*) as entregas,
            COALESCE(SUM(valor), 0) as valor_total,
            COALESCE(SUM(valor_prof), 0) as valor_prof
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2
            AND ${CAT_FILTER} AND ${ENTREGA_FILTER}
          GROUP BY cod_cliente, centro_custo, nome_fantasia, DATE_TRUNC('week', data_solicitado)
          ORDER BY concat, semana
        `, [sem4Inicio, df]),

        // 8. Mínimo Garantido (RODOU)
        pool.query(`
          SELECT
            cod_cliente,
            SUM(COALESCE(valor_negociado, 0)) as negociado,
            SUM(COALESCE(valor_produzido, 0)) as produzido,
            SUM(COALESCE(complemento, 0)) as complemento
          FROM bi_garantido_cache
          WHERE data >= $1 AND data <= $2
            AND UPPER(COALESCE(status, '')) = 'RODOU'
          GROUP BY cod_cliente
          ORDER BY SUM(COALESCE(valor_negociado, 0)) DESC
        `, [di, df]),

        // 9. Faturamento líquido por cliente (para cruzar com garantido)
        pool.query(`
          SELECT
            cod_cliente::text as cod,
            COALESCE(SUM(valor), 0) - COALESCE(SUM(valor_prof), 0) as fat_liquido
          FROM bi_entregas
          WHERE ${BASE}
          GROUP BY cod_cliente
        `, [di, df]),
      ]);

      // ── Montar resposta ──

      // KPIs
      var k = qKpi.rows[0] || {};
      var ka = qKpiAnt.rows[0] || {};
      var entregas = parseInt(k.entregas) || 0;
      var noPrazo = parseInt(k.no_prazo) || 0;
      var valorTotal = parseFloat(k.valor_total) || 0;
      var valorProf = parseFloat(k.valor_prof) || 0;
      var fat = valorTotal - valorProf;
      var entregasAnt = parseInt(ka.entregas) || 0;
      var noPrazoAnt = parseInt(ka.no_prazo) || 0;
      var fatAnt = (parseFloat(ka.valor_total) || 0) - (parseFloat(ka.valor_prof) || 0);

      var kpis = {
        entregas: entregas,
        os_count: parseInt(k.os_count) || 0,
        entregadores: parseInt(k.entregadores) || 0,
        no_prazo: noPrazo,
        prazo_pct: entregas > 0 ? round2(noPrazo / entregas * 100) : 0,
        valor_total: round2(valorTotal),
        valor_prof: round2(valorProf),
        faturamento: round2(fat),
        ticket_medio: entregas > 0 ? round2(fat / entregas) : 0,
        tempo_medio: parseFloat(k.tempo_medio) || 0,
        retornos: parseInt(k.retornos) || 0,
        var_entregas: varPct(entregas, entregasAnt),
        var_prazo_pp: entregasAnt > 0 ? round2((noPrazo / entregas * 100) - (noPrazoAnt / entregasAnt * 100)) : null,
        var_faturamento: varPct(fat, fatAnt),
      };

      // SLA 767 (Comollati)
      var ant767Map = {};
      q767Ant.rows.forEach(function(r) { ant767Map[r.concat] = r; });
      var sla767 = q767.rows.map(function(r) {
        var ent = parseInt(r.entregas) || 0;
        var np = parseInt(r.no_prazo) || 0;
        var pct = ent > 0 ? round2(np / ent * 100) : 0;
        var ant = ant767Map[r.concat] || {};
        var entA = parseInt(ant.entregas) || 0;
        var npA = parseInt(ant.no_prazo) || 0;
        var pctA = entA > 0 ? round2(npA / entA * 100) : null;
        return {
          concat: r.concat, nome: r.nome, entregas: ent, no_prazo: np,
          fora_prazo: ent - np, prazo_pct: pct,
          tempo_medio: parseFloat(r.tempo_medio) || 0,
          var_pp: pctA !== null ? round2(pct - pctA) : null,
        };
      });

      // SLA Porto Seco + Outros (prazo padrão)
      var allSlaMap = {};
      qSlaConcat.rows.forEach(function(r) { allSlaMap[r.concat] = r; });
      var antSlaMap = {};
      qSlaAnt.rows.forEach(function(r) { antSlaMap[r.concat] = r; });

      function buildSlaSec(concats) {
        return concats.map(function(c) {
          var r = allSlaMap[c] || {};
          var ent = parseInt(r.entregas) || 0;
          var np = parseInt(r.no_prazo) || 0;
          var pct = ent > 0 ? round2(np / ent * 100) : 0;
          var ant = antSlaMap[c] || {};
          var entA = parseInt(ant.entregas) || 0;
          var npA = parseInt(ant.no_prazo) || 0;
          var pctA = entA > 0 ? round2(npA / entA * 100) : null;
          return {
            concat: c, nome: r.nome || c, entregas: ent, no_prazo: np,
            fora_prazo: ent - np, prazo_pct: pct,
            tempo_medio: parseFloat(r.tempo_medio) || 0,
            var_pp: pctA !== null ? round2(pct - pctA) : null,
          };
        }).filter(function(r) { return r.entregas > 0; });
      }

      var slaPortoSeco = buildSlaSec(PORTO_SECO);
      var slaOutros = buildSlaSec(OUTROS_MONITORADOS);

      // Ticket Médio + Demanda (4 semanas)
      var semanas4Set = new Set();
      var clienteMap = {};
      qTicket4sem.rows.forEach(function(r) {
        var sem = r.semana;
        semanas4Set.add(sem);
        if (!clienteMap[r.concat]) clienteMap[r.concat] = { nome: r.nome, semanas: {} };
        clienteMap[r.concat].semanas[sem] = {
          entregas: parseInt(r.entregas) || 0,
          fat: round2((parseFloat(r.valor_total) || 0) - (parseFloat(r.valor_prof) || 0)),
        };
      });

      var semanas4 = Array.from(semanas4Set).sort();
      var ultimas4 = semanas4.slice(-4);
      var semLabels = ultimas4.map(function(s) {
        var d = new Date(s);
        return pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
      });

      var ticketClientes = [];
      var demandaClientes = [];
      Object.keys(clienteMap).forEach(function(concat) {
        var cl = clienteMap[concat];
        var ticketRow = { concat: concat, nome: cl.nome, semanas: [] };
        var demandaRow = { concat: concat, nome: cl.nome, semanas: [] };
        ultimas4.forEach(function(sem) {
          var d = cl.semanas[sem] || { entregas: 0, fat: 0 };
          ticketRow.semanas.push(d.entregas > 0 ? round2(d.fat / d.entregas) : null);
          demandaRow.semanas.push(d.entregas);
        });
        // Só incluir se teve entregas na semana atual
        var lastIdx = ticketRow.semanas.length - 1;
        if (demandaRow.semanas[lastIdx] > 0) {
          var prev = ticketRow.semanas[lastIdx - 1];
          var curr = ticketRow.semanas[lastIdx];
          ticketRow.variacao = prev && curr ? round2((curr - prev) / prev * 100) : null;
          var prevD = demandaRow.semanas[lastIdx - 1];
          var currD = demandaRow.semanas[lastIdx];
          demandaRow.variacao = prevD > 0 ? round2((currD - prevD) / prevD * 100) : null;
          ticketClientes.push(ticketRow);
          demandaClientes.push(demandaRow);
        }
      });

      // Ordenar por faturamento atual desc
      ticketClientes.sort(function(a, b) {
        return (b.semanas[b.semanas.length - 1] || 0) - (a.semanas[a.semanas.length - 1] || 0);
      });
      demandaClientes.sort(function(a, b) {
        return (b.semanas[b.semanas.length - 1] || 0) - (a.semanas[a.semanas.length - 1] || 0);
      });

      // Mínimo Garantido
      var fatMap = {};
      qGarFat.rows.forEach(function(r) { fatMap[r.cod] = parseFloat(r.fat_liquido) || 0; });

      var garantido = qGarantido.rows.map(function(r) {
        var neg = parseFloat(r.negociado) || 0;
        var prod = parseFloat(r.produzido) || 0;
        var comp = parseFloat(r.complemento) || 0;
        var fatLiq = fatMap[r.cod_cliente] || 0;
        return {
          cod_cliente: r.cod_cliente,
          negociado: round2(neg),
          produzido: round2(prod),
          complemento: round2(comp),
          fat_liquido: round2(fatLiq),
          saldo: round2(fatLiq - comp),
        };
      });

      res.json({
        success: true,
        semana: {
          data_inicio: di, data_fim: df,
          label: fmtBR(di) + ' a ' + fmtBR(df),
        },
        kpis: kpis,
        sla_767: sla767,
        sla_porto_seco: slaPortoSeco,
        sla_outros: slaOutros,
        ticket_medio: { semanas: semLabels, clientes: ticketClientes },
        demanda: { semanas: semLabels, clientes: demandaClientes },
        garantido: garantido,
      });

      console.log('📊 Gerencial: relatório gerado (' + di + ' a ' + df + ') — ' + entregas + ' entregas');

    } catch (error) {
      console.error('❌ Gerencial dados:', error.message, error.stack);
      res.status(500).json({ error: 'Erro ao gerar relatório: ' + error.message });
    }
  });

  return router;
}

// Helpers
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function round2(n) { return Math.round(n * 100) / 100; }
function fmtBR(d) { var p = d.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function varPct(atual, anterior) {
  if (!anterior || anterior === 0) return null;
  return round2((atual - anterior) / anterior * 100);
}

module.exports = { createGerencialRouter };
