/**
 * MÓDULO GERENCIAL - Análise Gerencial Semanal v2
 * Config dinâmica de grupos SLA + relatório semanal
 * Endpoints: /gerencial/semanas, /gerencial/dados, /gerencial/config, /gerencial/clientes-disponiveis
 */
const express = require('express');

var CAT_FILTER = "categoria IN ('Motofrete','Motofrete - C','Motofrete (Expresso)','Tutts Fast')";
var ENTREGA_FILTER = "COALESCE(ponto, 1) >= 2";

// Base de entregas: TODAS as linhas com ponto >= 2 (sem DISTINCT ON)
// Compatível com Power BI: COUNTROWS WHERE Ponto_Entrega <> "Ponto 1"
// PBI conta cada linha/ponto de entrega, não agrupa por OS
var EU = "SELECT * FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2";

// Para faturamento: PBI usa SUMMARIZE por OS → FIRSTNONBLANK(Valor)
// Equivale a pegar 1 valor por OS (o primeiro não-nulo)
var EU_FAT = "SELECT DISTINCT ON (os) os, valor, valor_prof, cod_cliente, centro_custo, data_solicitado, categoria, nome_fantasia FROM bi_entregas WHERE COALESCE(ponto, 1) >= 2 AND os IS NOT NULL ORDER BY os, ponto ASC";

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
        "WITH eu AS (" + EU + ") " +
        "SELECT DATE_TRUNC('week', data_solicitado)::date as seg, " +
        "(DATE_TRUNC('week', data_solicitado) + INTERVAL '6 days')::date as dom, " +
        "COUNT(*) as entregas FROM eu " +
        "WHERE data_solicitado >= CURRENT_DATE - INTERVAL '90 days' AND " + CAT_FILTER + " " +
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

      // BASE agora usa CTE com DISTINCT ON (os) — EU definido no escopo do módulo
      var BASE_EU = "data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER;

      // Carregar config de grupos do banco
      var gruposResult = await pool.query("SELECT * FROM gerencial_sla_grupos ORDER BY grupo");
      var portoSecoRaw = [], outrosRaw = [];
      gruposResult.rows.forEach(function(r) {
        var item = { cod: parseInt(r.cod_cliente), cc: r.centro_custo || '', nome: r.nome_display || '' };
        if (r.grupo === 'porto_seco') portoSecoRaw.push(item);
        else if (r.grupo === 'outros') outrosRaw.push(item);
      });

      // Consolidar: se um cod_cliente aparece MUITAS vezes (>5 CCs), unificar como 1 entrada sem CC
      // Poucos CCs (2-3) são intencionais — manter separados
      function consolidarConfig(items) {
        var codNome = {};
        items.forEach(function(it) {
          if (!codNome[it.cod] || (it.nome && it.nome.length > (codNome[it.cod] || '').length)) codNome[it.cod] = it.nome;
        });
        var seen = {};
        var result = [];
        items.forEach(function(it) {
          // 🔧 FIX: Apenas 949 consolida CCs (os demais mantém CC separado)
          if (it.cod === 949) {
            if (!seen[it.cod]) {
              seen[it.cod] = true;
              result.push({ cod: it.cod, cc: '', nome: codNome[it.cod] || it.nome });
            }
          } else {
            result.push(it);
          }
        });
        return result;
      }
      var portoSecoConfig = consolidarConfig(portoSecoRaw);
      var outrosConfig = consolidarConfig(outrosRaw);

      // ── Queries em paralelo ──
      // EU = todas as linhas ponto>=2 (contagem como PBI)
      // EU_FAT = DISTINCT ON (os) ASC para faturamento (1 valor por OS como PBI FIRSTNONBLANK)
      var [qKpi, qKpiAnt, q767, q767Ant, qSlaAll, qSlaAntAll, qTicket4sem, qGarFat] = await Promise.all([
        // 1. KPIs semana — contagem de LINHAS (como PBI) + fat via subquery DISTINCT
        pool.query(
          "WITH eu AS (" + EU + "), euf AS (" + EU_FAT + ") " +
          "SELECT " +
          "(SELECT COUNT(*) FROM eu WHERE " + BASE_EU + ") as entregas, " +
          "(SELECT COUNT(DISTINCT os) FROM eu WHERE " + BASE_EU + ") as os_count, " +
          "(SELECT COUNT(DISTINCT cod_prof) FROM eu WHERE " + BASE_EU + ") as entregadores, " +
          "(SELECT SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) FROM eu WHERE " + BASE_EU + ") as no_prazo, " +
          "(SELECT COALESCE(SUM(valor), 0) FROM euf WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + ") as valor_total, " +
          "(SELECT COALESCE(SUM(valor_prof), 0) FROM euf WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + ") as valor_prof, " +
          "(SELECT ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 480 THEN tempo_execucao_minutos END)::numeric, 1) FROM eu WHERE " + BASE_EU + ") as tempo_medio",
          [di, df]),
        // 2. KPIs anterior
        pool.query(
          "WITH eu AS (" + EU + "), euf AS (" + EU_FAT + ") " +
          "SELECT " +
          "(SELECT COUNT(*) FROM eu WHERE " + BASE_EU + ") as entregas, " +
          "(SELECT SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) FROM eu WHERE " + BASE_EU + ") as no_prazo, " +
          "(SELECT COALESCE(SUM(valor), 0) FROM euf WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + ") as valor_total, " +
          "(SELECT COALESCE(SUM(valor_prof), 0) FROM euf WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + ") as valor_prof",
          [antInicio, antFim]),
        // 3. SLA 767 (2h fixo) — agrupado por centro_custo (cada CC = 1 filial)
        pool.query(
          "WITH eu AS (" + EU + ") " +
          "SELECT COALESCE(centro_custo, MAX(nome_fantasia), 'Filial') as nome, " +
          "COALESCE(centro_custo, '') as centro_custo, " +
          "COUNT(*) as entregas, " +
          "SUM(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120 THEN 1 ELSE 0 END) as no_prazo, " +
          "ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 480 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio " +
          "FROM eu WHERE " + BASE_EU + " AND cod_cliente = 767 GROUP BY centro_custo ORDER BY COUNT(*) DESC",
          [di, df]),
        // 4. SLA 767 anterior — agrupado por centro_custo
        pool.query(
          "WITH eu AS (" + EU + ") " +
          "SELECT COALESCE(centro_custo, MAX(nome_fantasia), 'Filial') as nome, COUNT(*) as entregas, " +
          "SUM(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120 THEN 1 ELSE 0 END) as no_prazo " +
          "FROM eu WHERE " + BASE_EU + " AND cod_cliente = 767 GROUP BY centro_custo",
          [antInicio, antFim]),
        // 5. SLA todos (para Porto Seco + Outros + 767)
        // Todos usam dentro_prazo (faixas km padrão) — inclusive 767 quando está em grupo
        pool.query(
          "WITH eu AS (" + EU + ") " +
          "SELECT cod_cliente, COALESCE(centro_custo, '') as centro_custo, " +
          "MAX(COALESCE(nome_fantasia, centro_custo, 'Cliente')) as nome, COUNT(*) as entregas, " +
          "SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo, " +
          "ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 480 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio " +
          "FROM eu WHERE " + BASE_EU + " GROUP BY cod_cliente, centro_custo",
          [di, df]),
        // 6. SLA anterior todos
        pool.query(
          "WITH eu AS (" + EU + ") " +
          "SELECT cod_cliente, COALESCE(centro_custo, '') as centro_custo, COUNT(*) as entregas, " +
          "SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo " +
          "FROM eu WHERE " + BASE_EU + " GROUP BY cod_cliente, centro_custo",
          [antInicio, antFim]),
        // 7. Ticket/Demanda 4 semanas — entregas=linhas (PBI), valor=1 por OS (PBI FIRSTNONBLANK)
        pool.query(
          "WITH eu AS (" + EU + "), euf AS (" + EU_FAT + "), " +
          "cnt AS (SELECT cod_cliente, COALESCE(centro_custo, '') as centro_custo, " +
          "MAX(COALESCE(nome_fantasia, centro_custo, 'Cliente ' || cod_cliente)) as nome, " +
          "DATE_TRUNC('week', data_solicitado)::date as semana, COUNT(*) as entregas " +
          "FROM eu WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + " " +
          "GROUP BY cod_cliente, centro_custo, DATE_TRUNC('week', data_solicitado)), " +
          "fat AS (SELECT cod_cliente, COALESCE(centro_custo, '') as centro_custo, " +
          "DATE_TRUNC('week', data_solicitado)::date as semana, " +
          "COALESCE(SUM(valor), 0) as valor_total, COALESCE(SUM(valor_prof), 0) as valor_prof " +
          "FROM euf WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + " " +
          "GROUP BY cod_cliente, centro_custo, DATE_TRUNC('week', data_solicitado)) " +
          "SELECT c.cod_cliente, c.centro_custo, c.nome, c.semana, c.entregas, " +
          "COALESCE(f.valor_total, 0) as valor_total, COALESCE(f.valor_prof, 0) as valor_prof " +
          "FROM cnt c LEFT JOIN fat f ON c.cod_cliente = f.cod_cliente AND c.centro_custo = f.centro_custo AND c.semana = f.semana " +
          "ORDER BY c.cod_cliente, c.semana",
          [sem4Inicio, df]),
        // 8. Fat líquido por cliente+CC — 1 valor por OS (PBI FIRSTNONBLANK)
        pool.query(
          "WITH euf AS (" + EU_FAT + ") " +
          "SELECT cod_cliente::text as cod, COALESCE(centro_custo, '') as cc, COALESCE(SUM(valor), 0) - COALESCE(SUM(valor_prof), 0) as fat_liquido " +
          "FROM euf WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + " GROUP BY cod_cliente, centro_custo", [di, df]).catch(function() { return { rows: [] }; }),
      ]);

      // Fat líquido por cliente+CC e também total por cliente (pra cruzar com garantido)
      var fatMap = {};
      qGarFat.rows.forEach(function(r) {
        var perCcKey = r.cod + '|' + (r.cc || '');
        fatMap[perCcKey] = (fatMap[perCcKey] || 0) + (parseFloat(r.fat_liquido) || 0);
        // Total por cliente (sem CC)
        var totalKey = r.cod + '|';
        fatMap[totalKey] = (fatMap[totalKey] || 0) + (parseFloat(r.fat_liquido) || 0);
      });

      // ── Garantido: Google Sheet + lógica idêntica ao /bi/garantido ──
      // Para cada prof/dia na planilha: busca produção total, determina onde rodou, calcula complemento
      // Depois agrupa por "onde rodou" com SUM
      var garantido = [];
      try {
        var sheetUrl = 'https://docs.google.com/spreadsheets/d/1ohUOrfXmhEQ9jD_Ferzd1pAE5w2PhJTJumd6ILAeehE/export?format=csv';
        var sheetRes = await fetch(sheetUrl);
        var sheetText = await sheetRes.text();
        var sheetLines = sheetText.split('\n').slice(1);

        // Parse planilha
        var garEntries = [];
        for (var li = 0; li < sheetLines.length; li++) {
          var line = sheetLines[li].trim();
          if (!line) continue;
          var cols = line.split(',').map(function(c) { return c.replace(/^"|"$/g, '').trim(); });
          var codCl = cols[0], dataStr = cols[1], profNome = cols[2] || '', codProf = cols[3] || '';
          var valNeg = parseFloat((cols[4] || '').replace(',', '.')) || 0;
          if (!dataStr || valNeg <= 0) continue;
          var dp = dataStr.split('/');
          if (dp.length !== 3) continue;
          var dataFmt = dp[2] + '-' + dp[1].padStart(2, '0') + '-' + dp[0].padStart(2, '0');
          if (dataFmt < di || dataFmt > df) continue;
          garEntries.push({ codCl: codCl, data: dataFmt, profNome: profNome, codProf: codProf ? parseInt(codProf) : null, valNeg: valNeg });
        }

        // Buscar produção de TODOS os profs em batch (mesma query do BI mas em lote)
        // Agrupa por OS para pegar FIRSTNONBLANK (valor da OS, não duplicar por ponto)
        var profCods = garEntries.filter(function(e) { return e.codProf; }).map(function(e) { return e.codProf; });
        var uniqueProfs = Array.from(new Set(profCods));
        
        // prodMap: "codProf_data" → { valorTotal, entregasTotal, clientes: { codCl: { valor, cc, nome } } }
        var prodMap = {};
        if (uniqueProfs.length > 0) {
          var prodResult = await pool.query(
            "WITH os_dados AS (" +
            "  SELECT os, cod_prof, data_solicitado::date as data, " +
            "    MAX(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_os, " +
            "    MAX(cod_cliente) as cod_cliente_os, " +
            "    MAX(centro_custo) as centro_custo_os, " +
            "    MAX(nome_fantasia) as nome_fantasia_os, " +
            "    COUNT(*) FILTER (WHERE COALESCE(ponto, 1) >= 2) as entregas_os " +
            "  FROM bi_entregas " +
            "  WHERE cod_prof = ANY($3) AND data_solicitado >= $1 AND data_solicitado <= $2 " +
            "  GROUP BY os, cod_prof, data_solicitado::date" +
            ") " +
            "SELECT cod_prof, data, cod_cliente_os::text as cod_cliente, " +
            "  COALESCE(centro_custo_os, '') as centro_custo, " +
            "  MAX(nome_fantasia_os) as nome_fantasia, " +
            "  COALESCE(SUM(valor_os), 0) as valor_produzido, " +
            "  COALESCE(SUM(entregas_os), 0) as total_entregas " +
            "FROM os_dados GROUP BY cod_prof, data, cod_cliente_os, centro_custo_os",
            [di, df, uniqueProfs]
          ).catch(function() { return { rows: [] }; });

          prodResult.rows.forEach(function(r) {
            var key = r.cod_prof + '_' + toDateStr(r.data);
            if (!prodMap[key]) prodMap[key] = { valorTotal: 0, entregasTotal: 0, clientes: {} };
            prodMap[key].valorTotal += parseFloat(r.valor_produzido) || 0;
            prodMap[key].entregasTotal += parseInt(r.total_entregas) || 0;
            var codCl = String(r.cod_cliente || '');
            if (codCl) {
              prodMap[key].clientes[codCl] = {
                valor: parseFloat(r.valor_produzido) || 0,
                cc: r.centro_custo || '',
                nome: r.nome_fantasia || ''
              };
            }
          });
        }

        // Máscaras
        var mascarasG = {};
        try { var mr2 = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras'); mr2.rows.forEach(function(m) { mascarasG[String(m.cod_cliente)] = m.mascara; }); } catch(e) {}

        // Processar cada entrada da planilha
        // 🔧 FIX: ondeRodou SEMPRE usa codCl da planilha (não bi_entregas)
        // Se motoboy rodou em múltiplos clientes, não buga mais
        var resultadosIndiv = [];
        garEntries.forEach(function(entry) {
          var prodKey = entry.codProf ? (entry.codProf + '_' + entry.data) : null;
          var prod = prodKey ? prodMap[prodKey] : null;
          
          var valorProduzido = prod ? prod.valorTotal : 0;
          var totalEntregas = prod ? prod.entregasTotal : 0;
          var complemento = Math.max(0, r2(entry.valNeg - valorProduzido));

          // 🔧 FIX: Nome SEMPRE da planilha (codCl) + máscara. Se vazio → PORTO SECO
          var codSheet = String(entry.codCl || '').trim();
          var clienteDetail = prod && codSheet ? (prod.clientes[codSheet] || null) : null;
          var ccRodou = clienteDetail ? clienteDetail.cc : '';
          var nomeBase = mascarasG[codSheet] || (clienteDetail ? clienteDetail.nome : '') || '';
          
          var ondeRodou;
          if (!codSheet || !nomeBase) {
            ondeRodou = 'PORTO SECO';
          } else if (codSheet === '949') {
            ondeRodou = codSheet + ' - ' + nomeBase;
          } else if (ccRodou) {
            ondeRodou = codSheet + ' - ' + ccRodou;
          } else {
            ondeRodou = codSheet + ' - ' + nomeBase;
          }

          resultadosIndiv.push({
            ondeRodou: ondeRodou,
            codCliente: parseInt(codSheet) || 0,
            cc: ccRodou,
            negociado: entry.valNeg,
            produzido: valorProduzido,
            complemento: complemento,
            rodou: totalEntregas > 0,
            // Para PORTO SECO: guardar todos os clientes onde o motoboy efetivamente entregou
            clientesRodou: prod ? Object.keys(prod.clientes).map(function(ck) {
              return { cod: ck, cc: prod.clientes[ck].cc || '' };
            }) : []
          });
        });

        // Agrupar por "onde rodou" — SUM de negociado, produzido, complemento
        var garGrupo = {};
        resultadosIndiv.forEach(function(r) {
          if (!r.rodou) return;
          var gKey = r.ondeRodou;
          if (!garGrupo[gKey]) garGrupo[gKey] = { nome: r.ondeRodou, cod: r.codCliente, cc: r.cc, negociado: 0, produzido: 0, complemento: 0, clientesRodou: [] };
          garGrupo[gKey].negociado += r.negociado;
          garGrupo[gKey].produzido += r.produzido;
          garGrupo[gKey].complemento += r.complemento;
          // Acumular clientes onde os motoboys efetivamente entregaram (para PORTO SECO)
          if (r.clientesRodou) {
            r.clientesRodou.forEach(function(cr) {
              garGrupo[gKey].clientesRodou.push(cr);
            });
          }
        });

        // Montar resultado final
        // fat_liquido: para clientes normais usa fatMap por cod+cc
        // Para PORTO SECO (cod=0): soma fat_liquido de TODOS os clientes onde os motoboys entregaram
        Object.keys(garGrupo).forEach(function(gKey) {
          var g = garGrupo[gKey];
          var neg = r2(g.negociado), prod = r2(g.produzido), comp = r2(g.complemento);
          var fl;
          if (g.cod === 0 || gKey === 'PORTO SECO') {
            // PORTO SECO: somar fat_liquido de todos os clientes onde os motoboys rodaram
            var fatTotal = 0;
            var clientesContados = {};
            g.clientesRodou.forEach(function(cr) {
              var fk = cr.cod + '|' + (cr.cc || '');
              if (!clientesContados[fk]) {
                clientesContados[fk] = true;
                fatTotal += fatMap[fk] || 0;
              }
            });
            // Se não encontrou por cod+cc, tentar por cod sem cc
            if (fatTotal === 0) {
              var codContados = {};
              g.clientesRodou.forEach(function(cr) {
                if (!codContados[cr.cod]) {
                  codContados[cr.cod] = true;
                  fatTotal += fatMap[cr.cod + '|'] || 0;
                }
              });
            }
            fl = fatTotal;
          } else {
            // Cliente normal: buscar por cod+cc, depois total do cod
            fl = fatMap[String(g.cod) + '|' + (g.cc || '')] || fatMap[String(g.cod) + '|'] || 0;
          }
          garantido.push({
            cod_cliente: g.cod, centro_custo: g.cc, nome: g.nome,
            negociado: neg, produzido: prod, complemento: comp,
            fat_liquido: r2(fl), saldo: r2(fl - comp),
          });
        });

        garantido.sort(function(a, b) { return b.negociado - a.negociado; });
        console.log('Gerencial garantido: ' + garantido.length + ' linhas, neg=' + r2(garantido.reduce(function(s,g){return s+g.negociado;},0)));
      } catch(e) {
        console.warn('Gerencial garantido error:', e.message);
      }
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


      // ── Normalizar centro_custo sujo ──
      // Se um CC tem < 1% das entregas do cod_cliente, mescla com o CC dominante
      // Ex: cod 1039 tem 4049 em "União.FeiraHUB" e 2 em "BR Autoparts Goiânia" → mescla os 2 no dominante
      function normalizarCC(rows) {
        // 1. Contar entregas por cod_cliente+CC
        var totaisPorCod = {}, porCodCC = {};
        rows.forEach(function(r) {
          var cod = String(r.cod_cliente);
          var cc = r.centro_custo || '';
          var ent = parseInt(r.entregas) || 0;
          totaisPorCod[cod] = (totaisPorCod[cod] || 0) + ent;
          var k = cod + '|' + cc;
          porCodCC[k] = (porCodCC[k] || 0) + ent;
        });
        // 2. Achar CC dominante por cod_cliente
        var dominante = {};
        Object.keys(porCodCC).forEach(function(k) {
          var cod = k.split('|')[0];
          if (!dominante[cod] || porCodCC[k] > porCodCC[cod + '|' + dominante[cod]]) {
            dominante[cod] = k.split('|')[1];
          }
        });
        // 3. Substituir CCs outliers (< 1% do total) pelo dominante
        return rows.map(function(r) {
          var cod = String(r.cod_cliente);
          var cc = r.centro_custo || '';
          var total = totaisPorCod[cod] || 0;
          var ccTotal = porCodCC[cod + '|' + cc] || 0;
          if (total > 0 && ccTotal < total * 0.01 && dominante[cod] && cc !== dominante[cod]) {
            var fixed = Object.assign({}, r);
            fixed.centro_custo = dominante[cod];
            // Usar nome do CC dominante se disponível
            var domRow = rows.find(function(x) { return String(x.cod_cliente) === cod && (x.centro_custo || '') === dominante[cod]; });
            if (domRow && domRow.nome) fixed.nome = domRow.nome;
            return fixed;
          }
          return r;
        });
      }

      // ── SLA Porto Seco + Outros (do banco config) ──
      // Normalizar CCs sujos antes de mapear
      var slaAllNorm = normalizarCC(qSlaAll.rows);
      var slaAntAllNorm = normalizarCC(qSlaAntAll.rows);

      // Reagrupar após normalização (CCs mesclados precisam somar)
      var slaMap = {}, slaAntMap = {};
      slaAllNorm.forEach(function(r) {
        var k = r.cod_cliente + '|' + (r.centro_custo || '');
        if (!slaMap[k]) {
          slaMap[k] = Object.assign({}, r);
        } else {
          // Somar entregas e no_prazo de CCs mesclados
          slaMap[k].entregas = (parseInt(slaMap[k].entregas) || 0) + (parseInt(r.entregas) || 0);
          slaMap[k].no_prazo = (parseInt(slaMap[k].no_prazo) || 0) + (parseInt(r.no_prazo) || 0);
        }
      });
      slaAntAllNorm.forEach(function(r) {
        var k = r.cod_cliente + '|' + (r.centro_custo || '');
        if (!slaAntMap[k]) {
          slaAntMap[k] = Object.assign({}, r);
        } else {
          slaAntMap[k].entregas = (parseInt(slaAntMap[k].entregas) || 0) + (parseInt(r.entregas) || 0);
          slaAntMap[k].no_prazo = (parseInt(slaAntMap[k].no_prazo) || 0) + (parseInt(r.no_prazo) || 0);
        }
      });

      // ── Máscaras BI para nomes corretos (usado em SLA + Ticket/Demanda) ──
      var mascarasBI = {};
      try { var mr = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras'); mr.rows.forEach(function(m) { mascarasBI[String(m.cod_cliente)] = m.mascara; }); } catch(e) {}

      function buildSla(configItems) {
        var results = [];
        configItems.forEach(function(cfg) {
          var key = cfg.cod + '|' + (cfg.cc || '');
          var r, a;

          if (!cfg.cc) {
            // CC vazio → consolidar todos os centros deste cliente em 1 linha
            var totalE = 0, totalNP = 0, totalTM = 0, countTM = 0, firstName = '';
            Object.keys(slaMap).forEach(function(k) {
              if (k.indexOf(cfg.cod + '|') === 0) {
                var item = slaMap[k];
                totalE += parseInt(item.entregas) || 0;
                totalNP += parseInt(item.no_prazo) || 0;
                if (parseFloat(item.tempo_medio) > 0) { totalTM += parseFloat(item.tempo_medio) * (parseInt(item.entregas) || 0); countTM += parseInt(item.entregas) || 0; }
                if (!firstName) firstName = item.nome;
              }
            });
            r = totalE > 0 ? { entregas: totalE, no_prazo: totalNP, tempo_medio: countTM > 0 ? (totalTM / countTM).toFixed(1) : 0, nome: firstName } : {};
            var totalEA = 0, totalNPA = 0;
            Object.keys(slaAntMap).forEach(function(k) { if (k.indexOf(cfg.cod + '|') === 0) { totalEA += parseInt(slaAntMap[k].entregas) || 0; totalNPA += parseInt(slaAntMap[k].no_prazo) || 0; } });
            a = totalEA > 0 ? { entregas: totalEA, no_prazo: totalNPA } : {};
          } else {
            // CC específico → busca exata
            r = slaMap[key] || {};
            a = slaAntMap[key] || {};
          }

          var e = parseInt(r.entregas)||0, np = parseInt(r.no_prazo)||0, pct = e>0 ? r2(np/e*100) : 0;
          var eA = parseInt(a.entregas)||0, npA = parseInt(a.no_prazo)||0;
          var pctA = eA>0 ? r2(npA/eA*100) : null;
          // Nome: cod - mascara/nome_cliente - centro_custo
          var nomeCliente = mascarasBI[String(cfg.cod)] || cfg.nome || r.nome || '';
          var slaName;
          if (cfg.cc && nomeCliente && nomeCliente.toLowerCase() !== (cfg.cc || '').toLowerCase()) {
            slaName = cfg.cod + ' - ' + nomeCliente + ' - ' + cfg.cc;
          } else {
            slaName = cfg.cod + ' - ' + (nomeCliente || cfg.cc || 'Cliente ' + cfg.cod);
          }
          if (e > 0) results.push({ concat: cfg.cod + '-' + (cfg.cc || ''), cod_cliente: cfg.cod, nome: slaName, entregas: e, no_prazo: np, fora_prazo: e-np, prazo_pct: pct, tempo_medio: parseFloat(r.tempo_medio)||0, var_pp: pctA!==null ? r2(pct-pctA) : null });
        });
        return results;
      }
      var slaPortoSeco = buildSla(portoSecoConfig);
      var slaOutros = buildSla(outrosConfig);

      // Debug: log das configs e resultados
      console.log('📊 [Gerencial] Porto Seco config:', JSON.stringify(portoSecoConfig.map(function(c) { return c.cod + '|' + c.cc; })));
      console.log('📊 [Gerencial] Porto Seco resultado:', JSON.stringify(slaPortoSeco.map(function(r) { return r.nome + '=' + r.entregas; })));
      console.log('📊 [Gerencial] slaMap keys (767):', JSON.stringify(Object.keys(slaMap).filter(function(k) { return k.indexOf('767|') === 0; })));

      // sla_767 dedicado (SLA 2h) — sempre mostra, independente de estar em grupo
      // No grupo ele aparece com dentro_prazo (faixas km). Aqui mostra com 2h fixo.
      var ant767 = {}; q767Ant.rows.forEach(function(r) { ant767[r.nome] = r; });
      var sla767 = q767.rows.map(function(r) {
        var e = parseInt(r.entregas)||0, np = parseInt(r.no_prazo)||0, pct = e>0 ? r2(np/e*100) : 0;
        var a = ant767[r.nome]||{}, eA = parseInt(a.entregas)||0, npA = parseInt(a.no_prazo)||0;
        var pctA = eA>0 ? r2(npA/eA*100) : null;
        return { concat: r.nome, cod_cliente: 767, nome: '767 - ' + (r.centro_custo || r.nome), entregas: e, no_prazo: np, fora_prazo: e-np, prazo_pct: pct, tempo_medio: parseFloat(r.tempo_medio)||0, var_pp: pctA!==null ? r2(pct-pctA) : null };
      });

      // ── Ticket/Demanda 4 semanas ── (com máscara BI para nomes corretos)
      // mascarasBI já carregado acima

      // Clientes que devem ser consolidados:
      // 1) Os que na config final têm CC vazio (marcados como "geral")
      // 2) Os que têm CC específico MAS foram consolidados pela consolidarConfig (múltiplos CCs)
      // 3) QUALQUER cliente que aparece nos grupos (para evitar poluição no Ticket/Demanda)
      var consolidarCods = { '949': true };
      portoSecoConfig.concat(outrosConfig).forEach(function(it) {
        if (!it.cc) consolidarCods[String(it.cod)] = true;
      });

      // Normalizar CCs sujos no ticket/demanda (mesmo critério: < 1% → mescla no dominante)
      var ticket4semNorm = normalizarCC(qTicket4sem.rows);

      var sem4Set = new Set(), clMap = {};
      ticket4semNorm.forEach(function(r) {
        var sem = toDateStr(r.semana);
        // Se o cliente deve ser consolidado, ignorar CC na chave
        var devConsolidar = consolidarCods[String(r.cod_cliente)];
        var ckey = devConsolidar ? (r.cod_cliente + '|') : (r.cod_cliente + '|' + (r.centro_custo || ''));
        sem4Set.add(sem);
        // Nome: cod - nomeCliente (mascara) - centro_custo
        var nomeCliente = mascarasBI[String(r.cod_cliente)] || '';
        var nomeDisplay;
        if (devConsolidar || !r.centro_custo) {
          // Consolidado ou sem CC: cod - nome
          nomeDisplay = r.cod_cliente + ' - ' + (nomeCliente || r.nome || 'Cliente ' + r.cod_cliente);
        } else {
          // Tem CC: cod - nomeCliente - CC
          var nomeBase = nomeCliente || r.nome || '';
          if (nomeBase && nomeBase.toLowerCase() !== r.centro_custo.toLowerCase()) {
            nomeDisplay = r.cod_cliente + ' - ' + nomeBase + ' - ' + r.centro_custo;
          } else {
            // Nome igual ao CC (sem nome separado disponível)
            nomeDisplay = r.cod_cliente + ' - ' + r.centro_custo;
          }
        }
        if (!clMap[ckey]) clMap[ckey] = { nome: nomeDisplay, s: {} };
        var fatLiq = r2((parseFloat(r.valor_total)||0) - (parseFloat(r.valor_prof)||0));
        var existing = clMap[ckey].s[sem];
        if (existing) {
          // Consolidar: somar entregas e faturamento
          existing.e += parseInt(r.entregas) || 0;
          existing.f = Math.max(0, existing.f + fatLiq);
        } else {
          clMap[ckey].s[sem] = { e: parseInt(r.entregas)||0, f: Math.max(0, fatLiq) };
        }
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
        if (dRow.semanas.some(function(v) { return v > 0; })) {
          var pt = tRow.semanas[li-1], ct = tRow.semanas[li];
          tRow.variacao = pt && ct ? r2((ct-pt)/pt*100) : null;
          var pd = dRow.semanas[li-1], cd = dRow.semanas[li];
          dRow.variacao = pd > 0 ? r2((cd-pd)/pd*100) : null;
          ticketCl.push(tRow); demandaCl.push(dRow);
        }
      });
      ticketCl.sort(function(a,b) { return (b.semanas[b.semanas.length-1]||0) - (a.semanas[a.semanas.length-1]||0); });
      demandaCl.sort(function(a,b) { return (b.semanas[b.semanas.length-1]||0) - (a.semanas[a.semanas.length-1]||0); });

      // ── Evolução semanal por loja (item #3) ──
      // Para cada grupo monitorado, buscar últimas 8 semanas de dados por loja
      var evolucaoSemanal = {};
      try {
        // Coletar todos os cod_cliente monitorados (767 + porto seco + outros)
        var todosMonitorados = [767];
        portoSecoConfig.forEach(function(c) { if (todosMonitorados.indexOf(c.cod) === -1) todosMonitorados.push(c.cod); });
        outrosConfig.forEach(function(c) { if (todosMonitorados.indexOf(c.cod) === -1) todosMonitorados.push(c.cod); });

        var sem8Inicio = new Date(new Date(di).getTime() - 7 * 7 * 86400000).toISOString().split('T')[0];

        // Evolução para 767: agrupar por centro_custo (cada CC = 1 filial) + SLA 2h fixo
        var qEvol767 = await pool.query(
          "WITH eu AS (" + EU + ") " +
          "SELECT cod_cliente, COALESCE(centro_custo, MAX(nome_fantasia), 'Filial') as nome, " +
          "DATE_TRUNC('week', data_solicitado)::date as semana, " +
          "COUNT(*) as entregas, " +
          "SUM(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120 THEN 1 ELSE 0 END) as no_prazo, " +
          "ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 480 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio, " +
          "COUNT(DISTINCT cod_prof) as entregadores " +
          "FROM eu WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + " " +
          "AND cod_cliente = 767 " +
          "GROUP BY cod_cliente, centro_custo, DATE_TRUNC('week', data_solicitado) " +
          "ORDER BY semana",
          [sem8Inicio, df]
        );

        // Evolução para outros monitorados: consolidar por cod_cliente (1 linha por cliente)
        var outrosCods = todosMonitorados.filter(function(c) { return c !== 767; });
        var qEvolOutros = outrosCods.length > 0 ? await pool.query(
          "WITH eu AS (" + EU + ") " +
          "SELECT cod_cliente, " +
          "DATE_TRUNC('week', data_solicitado)::date as semana, " +
          "COUNT(*) as entregas, " +
          "SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo, " +
          "ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 480 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio, " +
          "COUNT(DISTINCT cod_prof) as entregadores " +
          "FROM eu WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND " + CAT_FILTER + " " +
          "AND cod_cliente = ANY($3) " +
          "GROUP BY cod_cliente, DATE_TRUNC('week', data_solicitado) " +
          "ORDER BY cod_cliente, semana",
          [sem8Inicio, df, outrosCods]
        ) : { rows: [] };

        // Processar 767 por filial
        qEvol767.rows.forEach(function(r) {
          var cod = r.cod_cliente, nomeKey = r.nome, sem = toDateStr(r.semana);
          if (!evolucaoSemanal[cod]) evolucaoSemanal[cod] = { semanas_set: new Set(), lojas: {} };
          evolucaoSemanal[cod].semanas_set.add(sem);
          if (!evolucaoSemanal[cod].lojas[nomeKey]) evolucaoSemanal[cod].lojas[nomeKey] = { nome: nomeKey, dados: {} };
          var ent = parseInt(r.entregas) || 0, np = parseInt(r.no_prazo) || 0;
          evolucaoSemanal[cod].lojas[nomeKey].dados[sem] = {
            entregas: ent, prazo_pct: ent > 0 ? r2(np / ent * 100) : 0,
            tempo_medio: parseFloat(r.tempo_medio) || 0, entregadores: parseInt(r.entregadores) || 0,
          };
        });

        // Processar outros por cod_cliente consolidado
        qEvolOutros.rows.forEach(function(r) {
          var cod = r.cod_cliente, sem = toDateStr(r.semana);
          if (!evolucaoSemanal[cod]) evolucaoSemanal[cod] = { semanas_set: new Set(), lojas: {} };
          evolucaoSemanal[cod].semanas_set.add(sem);
          var nomeCl = mascarasBI[String(cod)] || ('Cliente ' + cod);
          if (!evolucaoSemanal[cod].lojas['_total']) evolucaoSemanal[cod].lojas['_total'] = { nome: nomeCl, dados: {} };
          var ent = parseInt(r.entregas) || 0, np = parseInt(r.no_prazo) || 0;
          evolucaoSemanal[cod].lojas['_total'].dados[sem] = {
            entregas: ent, prazo_pct: ent > 0 ? r2(np / ent * 100) : 0,
            tempo_medio: parseFloat(r.tempo_medio) || 0, entregadores: parseInt(r.entregadores) || 0,
          };
        });

        // Formatar para response
        Object.keys(evolucaoSemanal).forEach(function(cod) {
          var obj = evolucaoSemanal[cod];
          var semanas = Array.from(obj.semanas_set).sort();
          var labels = semanas.map(function(s) { var p = s.split('-'); return p[2] + '/' + p[1]; });
          var lojas = Object.keys(obj.lojas).map(function(cc) {
            var loja = obj.lojas[cc];
            return {
              nome: loja.nome, centro_custo: cc,
              entregas: semanas.map(function(s) { return (loja.dados[s] || {}).entregas || 0; }),
              prazo_pct: semanas.map(function(s) { return (loja.dados[s] || {}).prazo_pct || 0; }),
              tempo_medio: semanas.map(function(s) { return (loja.dados[s] || {}).tempo_medio || 0; }),
              entregadores: semanas.map(function(s) { return (loja.dados[s] || {}).entregadores || 0; }),
            };
          });
          evolucaoSemanal[cod] = { semanas: labels, semanas_raw: semanas, lojas: lojas };
        });
      } catch(evErr) {
        console.warn('⚠️ Evolução semanal error:', evErr.message);
      }

      res.json({
        success: true,
        semana: { data_inicio: di, data_fim: df, label: fmtBR(di) + ' a ' + fmtBR(df) },
        kpis: kpis, sla_767: sla767, sla_porto_seco: slaPortoSeco, sla_outros: slaOutros,
        ticket_medio: { semanas: semLabels, clientes: ticketCl },
        demanda: { semanas: semLabels, clientes: demandaCl },
        garantido: garantido,
        evolucao_semanal: evolucaoSemanal,
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
