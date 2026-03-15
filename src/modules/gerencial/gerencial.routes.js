/**
 * MÓDULO GERENCIAL - Análise Gerencial Semanal v2
 * Config dinâmica de grupos SLA + relatório semanal
 * Endpoints: /gerencial/semanas, /gerencial/dados, /gerencial/config, /gerencial/clientes-disponiveis
 */
const express = require('express');

var CAT_FILTER = "categoria IN ('Motofrete','Motofrete - C','Motofrete (Expresso)','Tutts Fast')";
var ENTREGA_FILTER = "COALESCE(ponto, 1) >= 2";

function createGerencialRouter(pool, verificarToken) {
  var router = express.Router();

  // ══════════════════════════════════════════
  // GET /gerencial/clientes-disponiveis — para o selector de config
  // ══════════════════════════════════════════
  router.get('/gerencial/clientes-disponiveis', verificarToken, async function(req, res) {
    try {
      var result = await pool.query(
        "SELECT DISTINCT cod_cliente, COALESCE(centro_custo, '') as centro_custo, " +
        "COALESCE(nome_fantasia, centro_custo, 'Cliente ' || cod_cliente) as nome " +
        "FROM bi_entregas WHERE data_solicitado >= CURRENT_DATE - INTERVAL '90 days' " +
        "AND " + ENTREGA_FILTER + " AND cod_cliente IS NOT NULL " +
        "ORDER BY cod_cliente, centro_custo"
      );
      // Agrupar por cod_cliente
      var clienteMap = {};
      result.rows.forEach(function(r) {
        var cod = r.cod_cliente;
        if (!clienteMap[cod]) clienteMap[cod] = { cod_cliente: cod, nome: r.nome, centros: [] };
        if (r.centro_custo) clienteMap[cod].centros.push(r.centro_custo);
        if (!clienteMap[cod].nome || clienteMap[cod].nome === 'Cliente ' + cod) clienteMap[cod].nome = r.nome;
      });
      // Máscara do BI
      var mascaras = {};
      try {
        var mr = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
        mr.rows.forEach(function(m) { mascaras[String(m.cod_cliente)] = m.mascara; });
      } catch(e) {}
      var clientes = Object.values(clienteMap).map(function(c) {
        c.mascara = mascaras[String(c.cod_cliente)] || null;
        return c;
      });
      clientes.sort(function(a, b) { return a.cod_cliente - b.cod_cliente; });
      res.json({ success: true, clientes: clientes });
    } catch(e) {
      console.error('❌ Gerencial clientes-disp:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════
  // GET /gerencial/config — listar grupos configurados
  // ══════════════════════════════════════════
  router.get('/gerencial/config', verificarToken, async function(req, res) {
    try {
      var result = await pool.query(
        "SELECT * FROM gerencial_sla_grupos ORDER BY grupo, nome_display"
      );
      res.json({ success: true, grupos: result.rows });
    } catch(e) {
      console.error('❌ Gerencial config:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════
  // POST /gerencial/config — adicionar cliente a um grupo
  // ══════════════════════════════════════════
  router.post('/gerencial/config', verificarToken, async function(req, res) {
    try {
      var { grupo, cod_cliente, centro_custo, nome_display } = req.body;
      if (!grupo || !cod_cliente) return res.status(400).json({ error: 'grupo e cod_cliente obrigatórios' });
      if (!['porto_seco', 'outros'].includes(grupo)) return res.status(400).json({ error: 'grupo deve ser porto_seco ou outros' });
      var result = await pool.query(
        "INSERT INTO gerencial_sla_grupos (grupo, cod_cliente, centro_custo, nome_display, criado_por) " +
        "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (grupo, cod_cliente, centro_custo) DO NOTHING RETURNING *",
        [grupo, parseInt(cod_cliente), centro_custo || '', nome_display || '', req.user && req.user.nome || '']
      );
      if (result.rows.length === 0) return res.json({ success: true, msg: 'Já existe' });
      res.status(201).json({ success: true, item: result.rows[0] });
    } catch(e) {
      console.error('❌ Gerencial config add:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════
  // DELETE /gerencial/config/:id — remover
  // ══════════════════════════════════════════
  router.delete('/gerencial/config/:id', verificarToken, async function(req, res) {
    try {
      await pool.query("DELETE FROM gerencial_sla_grupos WHERE id = $1", [parseInt(req.params.id)]);
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════
  // GET /gerencial/semanas
  // ══════════════════════════════════════════
  router.get('/gerencial/semanas', verificarToken, async function(req, res) {
    try {
      var result = await pool.query(
        "SELECT DATE_TRUNC('week', data_solicitado)::date as seg, " +
        "(DATE_TRUNC('week', data_solicitado) + INTERVAL '6 days')::date as dom, " +
        "COUNT(*) as entregas FROM bi_entregas " +
        "WHERE data_solicitado >= CURRENT_DATE - INTERVAL '90 days' AND " + ENTREGA_FILTER + " " +
        "GROUP BY DATE_TRUNC('week', data_solicitado) ORDER BY seg DESC LIMIT 16"
      );
      var semanas = result.rows.map(function(r) {
        var sStr = toDateStr(r.seg), dStr = toDateStr(r.dom);
        var sp = sStr.split('-'), dp = dStr.split('-');
        return {
          data_inicio: sStr, data_fim: dStr,
          label: sp[2] + '/' + sp[1] + ' - ' + dp[2] + '/' + dp[1],
          entregas: parseInt(r.entregas),
        };
      });
      res.json({ success: true, semanas: semanas });
    } catch(e) {
      console.error('❌ Gerencial semanas:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════
  // GET /gerencial/dados — relatório completo
  // ══════════════════════════════════════════
  router.get('/gerencial/dados', verificarToken, async function(req, res) {
    try {
      var di = req.query.data_inicio, df = req.query.data_fim;
      if (!di || !df) return res.status(400).json({ error: 'data_inicio e data_fim obrigatórios' });

      var diaMs = 86400000;
      var diDate = new Date(di), dfDate = new Date(df);
      var diasSemana = Math.round((dfDate - diDate) / diaMs) + 1;
      var antFim = new Date(diDate.getTime() - diaMs).toISOString().split('T')[0];
      var antInicio = new Date(diDate.getTime() - diasSemana * diaMs).toISOString().split('T')[0];
      var sem4Inicio = new Date(diDate.getTime() - 3 * 7 * diaMs).toISOString().split('T')[0];

      var BASE = "data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + " AND " + ENTREGA_FILTER;

      // Carregar config de grupos do banco
      var gruposResult = await pool.query("SELECT * FROM gerencial_sla_grupos ORDER BY grupo");
      var portoSecoConfig = [], outrosConfig = [];
      gruposResult.rows.forEach(function(r) {
        var item = { cod: parseInt(r.cod_cliente), cc: r.centro_custo || '', nome: r.nome_display || '' };
        if (r.grupo === 'porto_seco') portoSecoConfig.push(item);
        else if (r.grupo === 'outros') outrosConfig.push(item);
      });

      // ── Queries em paralelo ──
      var [qKpi, qKpiAnt, q767, q767Ant, qSlaAll, qSlaAntAll, qTicket4sem, qGarantido, qGarFat] = await Promise.all([
        // 1. KPIs semana
        pool.query(
          "SELECT COUNT(*) as entregas, COUNT(DISTINCT os) as os_count, COUNT(DISTINCT cod_prof) as entregadores, " +
          "SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo, " +
          "COALESCE(SUM(valor), 0) as valor_total, COALESCE(SUM(valor_prof), 0) as valor_prof, " +
          "ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio " +
          "FROM bi_entregas WHERE " + BASE, [di, df]),
        // 2. KPIs anterior
        pool.query(
          "SELECT COUNT(*) as entregas, SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo, " +
          "COALESCE(SUM(valor), 0) as valor_total, COALESCE(SUM(valor_prof), 0) as valor_prof " +
          "FROM bi_entregas WHERE " + BASE, [antInicio, antFim]),
        // 3. SLA 767 (2h fixo)
        pool.query(
          "SELECT cod_cliente::text || '-' || COALESCE(centro_custo, '') as concat, " +
          "COALESCE(nome_fantasia, centro_custo, 'Filial') as nome, COUNT(*) as entregas, " +
          "SUM(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120 THEN 1 ELSE 0 END) as no_prazo, " +
          "ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio " +
          "FROM bi_entregas WHERE " + BASE + " AND cod_cliente = 767 GROUP BY cod_cliente, centro_custo, nome_fantasia ORDER BY COUNT(*) DESC",
          [di, df]),
        // 4. SLA 767 anterior
        pool.query(
          "SELECT cod_cliente::text || '-' || COALESCE(centro_custo, '') as concat, COUNT(*) as entregas, " +
          "SUM(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120 THEN 1 ELSE 0 END) as no_prazo " +
          "FROM bi_entregas WHERE " + BASE + " AND cod_cliente = 767 GROUP BY cod_cliente, centro_custo",
          [antInicio, antFim]),
        // 5. SLA todos (para Porto Seco + Outros)
        pool.query(
          "SELECT cod_cliente, COALESCE(centro_custo, '') as centro_custo, " +
          "COALESCE(nome_fantasia, centro_custo, 'Cliente') as nome, COUNT(*) as entregas, " +
          "SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo, " +
          "ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio " +
          "FROM bi_entregas WHERE " + BASE + " GROUP BY cod_cliente, centro_custo, nome_fantasia",
          [di, df]),
        // 6. SLA anterior todos
        pool.query(
          "SELECT cod_cliente, COALESCE(centro_custo, '') as centro_custo, COUNT(*) as entregas, " +
          "SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo " +
          "FROM bi_entregas WHERE " + BASE + " GROUP BY cod_cliente, centro_custo",
          [antInicio, antFim]),
        // 7. Ticket/Demanda 4 semanas
        pool.query(
          "SELECT cod_cliente, COALESCE(centro_custo, '') as centro_custo, " +
          "COALESCE(nome_fantasia, centro_custo, 'Cliente ' || cod_cliente) as nome, " +
          "DATE_TRUNC('week', data_solicitado)::date as semana, " +
          "COUNT(*) as entregas, COALESCE(SUM(valor), 0) as valor_total, COALESCE(SUM(valor_prof), 0) as valor_prof " +
          "FROM bi_entregas WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + " AND " + ENTREGA_FILTER + " " +
          "GROUP BY cod_cliente, centro_custo, nome_fantasia, DATE_TRUNC('week', data_solicitado) ORDER BY cod_cliente, semana",
          [sem4Inicio, df]),
        // 8. Garantido
        pool.query(
          "SELECT cod_cliente, SUM(COALESCE(valor_negociado, 0)) as negociado, " +
          "SUM(COALESCE(valor_produzido, 0)) as produzido, SUM(COALESCE(complemento, 0)) as complemento " +
          "FROM bi_garantido_cache WHERE data >= $1 AND data <= $2 GROUP BY cod_cliente ORDER BY SUM(COALESCE(valor_negociado, 0)) DESC",
          [di, df]).catch(function() { return { rows: [] }; }),
        // 9. Fat líquido por cliente
        pool.query(
          "SELECT cod_cliente::text as cod, COALESCE(SUM(valor), 0) - COALESCE(SUM(valor_prof), 0) as fat_liquido " +
          "FROM bi_entregas WHERE " + BASE + " GROUP BY cod_cliente", [di, df]).catch(function() { return { rows: [] }; }),
      ]);

      // ── KPIs ──
      var k = qKpi.rows[0] || {}, ka = qKpiAnt.rows[0] || {};
      var entregas = parseInt(k.entregas) || 0, noPrazo = parseInt(k.no_prazo) || 0;
      var vt = parseFloat(k.valor_total) || 0, vp = parseFloat(k.valor_prof) || 0, fat = vt - vp;
      var entAnt = parseInt(ka.entregas) || 0, npAnt = parseInt(ka.no_prazo) || 0;
      var fatAnt = (parseFloat(ka.valor_total) || 0) - (parseFloat(ka.valor_prof) || 0);
      var kpis = {
        entregas: entregas, os_count: parseInt(k.os_count) || 0, entregadores: parseInt(k.entregadores) || 0,
        no_prazo: noPrazo, prazo_pct: entregas > 0 ? r2(noPrazo / entregas * 100) : 0,
        valor_total: r2(vt), valor_prof: r2(vp), faturamento: r2(fat),
        ticket_medio: entregas > 0 ? r2(fat / entregas) : 0, tempo_medio: parseFloat(k.tempo_medio) || 0,
        var_entregas: varP(entregas, entAnt),
        var_prazo_pp: entAnt > 0 ? r2((noPrazo/entregas*100) - (npAnt/entAnt*100)) : null,
        var_faturamento: varP(fat, fatAnt),
      };

      // ── SLA 767 ──
      var ant767 = {}; q767Ant.rows.forEach(function(r) { ant767[r.concat] = r; });
      var sla767 = q767.rows.map(function(r) {
        var e = parseInt(r.entregas)||0, np = parseInt(r.no_prazo)||0, pct = e>0 ? r2(np/e*100) : 0;
        var a = ant767[r.concat]||{}, eA = parseInt(a.entregas)||0, npA = parseInt(a.no_prazo)||0;
        var pctA = eA>0 ? r2(npA/eA*100) : null;
        return { concat: r.concat, nome: r.nome, entregas: e, no_prazo: np, fora_prazo: e-np, prazo_pct: pct, tempo_medio: parseFloat(r.tempo_medio)||0, var_pp: pctA!==null ? r2(pct-pctA) : null };
      });

      // ── SLA Porto Seco + Outros (do banco config) ──
      var slaMap = {}, slaAntMap = {};
      qSlaAll.rows.forEach(function(r) { slaMap[r.cod_cliente + '|' + r.centro_custo] = r; });
      qSlaAntAll.rows.forEach(function(r) { slaAntMap[r.cod_cliente + '|' + r.centro_custo] = r; });

      function buildSla(configItems) {
        return configItems.map(function(cfg) {
          var key = cfg.cod + '|' + cfg.cc;
          var r = slaMap[key] || {};
          var a = slaAntMap[key] || {};
          var e = parseInt(r.entregas)||0, np = parseInt(r.no_prazo)||0, pct = e>0 ? r2(np/e*100) : 0;
          var eA = parseInt(a.entregas)||0, npA = parseInt(a.no_prazo)||0;
          var pctA = eA>0 ? r2(npA/eA*100) : null;
          return { concat: cfg.cod + '-' + cfg.cc, nome: cfg.nome || r.nome || cfg.cc || ('Cliente ' + cfg.cod), entregas: e, no_prazo: np, fora_prazo: e-np, prazo_pct: pct, tempo_medio: parseFloat(r.tempo_medio)||0, var_pp: pctA!==null ? r2(pct-pctA) : null };
        }).filter(function(r) { return r.entregas > 0; });
      }
      var slaPortoSeco = buildSla(portoSecoConfig);
      var slaOutros = buildSla(outrosConfig);

      // ── Ticket/Demanda 4 semanas ──
      var sem4Set = new Set(), clMap = {};
      qTicket4sem.rows.forEach(function(r) {
        var sem = toDateStr(r.semana);
        var ckey = r.cod_cliente + '|' + r.centro_custo;
        sem4Set.add(sem);
        if (!clMap[ckey]) clMap[ckey] = { nome: r.nome, s: {} };
        clMap[ckey].s[sem] = { e: parseInt(r.entregas)||0, f: r2((parseFloat(r.valor_total)||0) - (parseFloat(r.valor_prof)||0)) };
      });
      var sem4 = Array.from(sem4Set).sort().slice(-4);
      var semLabels = sem4.map(function(s) { var p = s.split('-'); return p[2] + '/' + p[1]; });

      var ticketCl = [], demandaCl = [];
      Object.keys(clMap).forEach(function(ckey) {
        var cl = clMap[ckey];
        var tRow = { concat: ckey, nome: cl.nome, semanas: [] };
        var dRow = { concat: ckey, nome: cl.nome, semanas: [] };
        sem4.forEach(function(s) {
          var d = cl.s[s] || { e: 0, f: 0 };
          tRow.semanas.push(d.e > 0 ? r2(d.f / d.e) : null);
          dRow.semanas.push(d.e);
        });
        var li = tRow.semanas.length - 1;
        if (dRow.semanas[li] > 0) {
          var pt = tRow.semanas[li-1], ct = tRow.semanas[li];
          tRow.variacao = pt && ct ? r2((ct-pt)/pt*100) : null;
          var pd = dRow.semanas[li-1], cd = dRow.semanas[li];
          dRow.variacao = pd > 0 ? r2((cd-pd)/pd*100) : null;
          ticketCl.push(tRow); demandaCl.push(dRow);
        }
      });
      ticketCl.sort(function(a,b) { return (b.semanas[b.semanas.length-1]||0) - (a.semanas[a.semanas.length-1]||0); });
      demandaCl.sort(function(a,b) { return (b.semanas[b.semanas.length-1]||0) - (a.semanas[a.semanas.length-1]||0); });

      // ── Garantido ──
      var fatMap = {}; qGarFat.rows.forEach(function(r) { fatMap[r.cod] = parseFloat(r.fat_liquido)||0; });
      var garantido = qGarantido.rows.map(function(r) {
        var neg = parseFloat(r.negociado)||0, prod = parseFloat(r.produzido)||0, comp = parseFloat(r.complemento)||0;
        var fl = fatMap[r.cod_cliente] || 0;
        return { cod_cliente: r.cod_cliente, negociado: r2(neg), produzido: r2(prod), complemento: r2(comp), fat_liquido: r2(fl), saldo: r2(fl - comp) };
      });

      res.json({
        success: true,
        semana: { data_inicio: di, data_fim: df, label: fmtBR(di) + ' a ' + fmtBR(df) },
        kpis: kpis, sla_767: sla767, sla_porto_seco: slaPortoSeco, sla_outros: slaOutros,
        ticket_medio: { semanas: semLabels, clientes: ticketCl },
        demanda: { semanas: semLabels, clientes: demandaCl },
        garantido: garantido,
        config_count: { porto_seco: portoSecoConfig.length, outros: outrosConfig.length },
      });
      console.log('📊 Gerencial: ' + di + ' a ' + df + ' — ' + entregas + ' ent, PS:' + slaPortoSeco.length + ' OUT:' + slaOutros.length);
    } catch(e) {
      console.error('❌ Gerencial dados:', e.message, e.stack);
      res.status(500).json({ error: 'Erro: ' + e.message });
    }
  });

  return router;
}

// Helpers
function toDateStr(d) { if (typeof d === 'string') return d.split('T')[0]; return new Date(d).toISOString().split('T')[0]; }
function r2(n) { return Math.round(n * 100) / 100; }
function fmtBR(d) { var p = d.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function varP(a, b) { if (!b || b === 0) return null; return r2((a - b) / b * 100); }

module.exports = { createGerencialRouter };
