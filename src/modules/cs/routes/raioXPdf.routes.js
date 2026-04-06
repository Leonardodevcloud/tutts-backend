/**
 * CS Sub-Router: Raio-X PDF Presentation v3
 * SVGs com dimensões fixas, sem flex-grow nos charts
 */
const express = require('express');

function createRaioXPdfRoutes(pool) {
  const router = express.Router();

  router.get('/cs/raio-x/pdf/:id', async (req, res) => {
    let browser;
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const rxResult = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [id]);
      if (rxResult.rows.length === 0) return res.status(404).json({ error: 'Raio-X não encontrado' });
      const rx = rxResult.rows[0];

      let dados = {};
      try { dados = typeof rx.metricas_snapshot === 'string' ? JSON.parse(rx.metricas_snapshot) : (rx.metricas_snapshot || {}); } catch (e) { dados = {}; }
      let benchmark = {};
      try { benchmark = typeof rx.benchmark_snapshot === 'string' ? JSON.parse(rx.benchmark_snapshot) : (rx.benchmark_snapshot || {}); } catch (e) { benchmark = {}; }

      const cliente = dados.cliente || {};
      const periodo = dados.periodo || {};
      const ma = dados.metricas_atuais || {};
      const mp = dados.metricas_periodo_anterior || {};
      const faixasKm = dados.faixas_km || [];
      const evolucao = dados.evolucao_semanal || [];
      const motosDia = dados.motos_por_dia || [];
      const profissionais = dados.corridas_por_motoboy || [];
      const horarios = dados.padroes_horario || [];
      const retornos = dados.retornos_detalhados || [];
      const bairros = dados.mapa_calor_bairros || [];
      const benchGeral = dados.benchmark_geral_tutts || benchmark || {};
      const ranking = dados.ranking_geral || {};
      const healthScore = rx.score_saude || cliente.health_score || 0;
      const mediaMotos = dados.media_motos_dia || 0;

      const fmtDate = function(d) { try { return new Date(d).toLocaleDateString('pt-BR'); } catch (e) { return d || ''; } };
      const fmtNum = function(n) { try { return parseInt(n).toLocaleString('pt-BR'); } catch (e) { return n || '0'; } };
      const dtInicio = fmtDate(rx.data_inicio || periodo.inicio);
      const dtFim = fmtDate(rx.data_fim || periodo.fim);
      const nomeCliente = rx.nome_cliente || cliente.nome || 'Cliente';
      const hsColor = healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#f59e0b' : '#ef4444';
      const hsLabel = healthScore >= 80 ? 'Excelente' : healthScore >= 50 ? 'Aten\u00e7\u00e3o' : 'Cr\u00edtico';

      // ═══ SVG HELPERS — dimensões FIXAS em pixels ═══

      function barraH(items, w, maxItems) {
        w = w || 500; maxItems = maxItems || 7;
        var list = items.slice(0, maxItems);
        if (!list.length) return '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:20px">Sem dados</div>';
        var maxVal = Math.max.apply(null, list.map(function(i) { return i.valor || 0; }).concat([1]));
        var barH = 26, gap = 6, labelW = 140, chartW = w - labelW - 20;
        var h = list.length * (barH + gap) + 10;
        var bars = '';
        list.forEach(function(item, idx) {
          var y = idx * (barH + gap) + 5;
          var bw = Math.max(4, (item.valor / maxVal) * chartW * 0.55);
          var cor = item.cor || '#7c3aed';
          bars += '<text x="' + (labelW - 8) + '" y="' + (y + barH/2 + 4) + '" text-anchor="end" font-size="11" fill="rgba(255,255,255,0.7)" font-family="Segoe UI,sans-serif">' + (item.label || '').substring(0, 22) + '</text>';
          bars += '<rect x="' + labelW + '" y="' + y + '" width="' + bw + '" height="' + barH + '" rx="4" fill="' + cor + '" opacity="0.9"/>';
          bars += '<text x="' + (labelW + bw + 8) + '" y="' + (y + barH/2 + 4) + '" font-size="11" font-weight="700" fill="white" font-family="Segoe UI,sans-serif">' + (item.display || item.valor) + '</text>';
        });
        return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">' + bars + '</svg>';
      }

      function barraV(items, w, chartH, opts) {
        opts = opts || {};
        var corBarra = opts.corBarra || '#7c3aed', corLinha = opts.corLinha || '#F97316';
        var labelKey = opts.labelKey || 'label', valKey = opts.valKey || 'valor', val2Key = opts.val2Key || null;
        var maxItems = opts.maxItems || 16;
        w = w || 1060; chartH = chartH || 280;
        var list = items.slice(-maxItems);
        if (!list.length) return '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:20px">Sem dados</div>';
        var maxVal = Math.max.apply(null, list.map(function(i) { return parseFloat(i[valKey]) || 0; }).concat([1]));
        var totalW = w - 80;
        var barW = Math.max(14, Math.min(40, Math.floor(totalW / list.length) - 8));
        var usedW = list.length * (barW + 8);
        var bottomY = chartH + 20, leftPad = 50;
        var svg = '';

        for (var g = 0; g <= 4; g++) {
          var gy = bottomY - (g / 4) * chartH;
          var gv = Math.round((g / 4) * maxVal);
          svg += '<line x1="' + leftPad + '" y1="' + gy + '" x2="' + (leftPad + usedW) + '" y2="' + gy + '" stroke="rgba(124,58,237,0.15)" stroke-width="1"/>';
          svg += '<text x="' + (leftPad - 8) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="rgba(167,139,250,0.5)" font-family="Segoe UI,sans-serif">' + gv + '</text>';
        }

        // Guardar posição do topo de cada barra para evitar colisão com labels da linha
        var barTops = [];
        list.forEach(function(item, idx) {
          var x = leftPad + idx * (barW + 8) + 4;
          var val = parseFloat(item[valKey]) || 0;
          var bh = Math.max(3, (val / maxVal) * chartH);
          var y = bottomY - bh;
          barTops.push(y);
          svg += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + bh + '" rx="3" fill="' + corBarra + '" opacity="0.85"/>';
          if (barW >= 18) svg += '<text x="' + (x + barW/2) + '" y="' + (y - 6) + '" text-anchor="middle" font-size="10" font-weight="700" fill="white" font-family="Segoe UI,sans-serif">' + Math.round(val) + '</text>';
          svg += '<text x="' + (x + barW/2) + '" y="' + (bottomY + 14) + '" text-anchor="middle" font-size="' + (barW >= 22 ? 10 : 8) + '" fill="rgba(167,139,250,0.55)" font-family="Segoe UI,sans-serif">' + (item[labelKey] || '').substring(0, 8) + '</text>';
        });

        if (val2Key) {
          var points = list.map(function(item, idx) {
            var x = leftPad + idx * (barW + 8) + 4 + barW / 2;
            var v2 = parseFloat(item[val2Key]) || 0;
            return x + ',' + (bottomY - (v2 / 100) * chartH);
          }).join(' ');
          svg += '<polyline points="' + points + '" fill="none" stroke="' + corLinha + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
          list.forEach(function(item, idx) {
            var x = leftPad + idx * (barW + 8) + 4 + barW / 2;
            var v2 = parseFloat(item[val2Key]) || 0;
            var ly = bottomY - (v2 / 100) * chartH;
            svg += '<circle cx="' + x + '" cy="' + ly + '" r="4" fill="' + corLinha + '" stroke="#1e0a3c" stroke-width="1.5"/>';
            if (barW >= 16) {
              var barTopY = barTops[idx] || 0;
              var barLabelY = barTopY - 16;
              var labelY = ly - 22;
              if (labelY > barLabelY - 14 && labelY < barLabelY + 14) {
                labelY = barLabelY - 18;
              }
              if (labelY < 4) labelY = ly + 16;
              svg += '<rect x="' + (x - 20) + '" y="' + (labelY - 8) + '" width="40" height="14" rx="3" fill="rgba(26,26,46,0.9)"/>';
              svg += '<text x="' + x + '" y="' + (labelY + 3) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + corLinha + '" font-family="Segoe UI,sans-serif">' + v2.toFixed(0) + '%</text>';
            }
          });
        }

        var svgW = leftPad + usedW + 20;
        var svgH = bottomY + 30;
        return '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '" xmlns="http://www.w3.org/2000/svg">' + svg + '</svg>';
      }

      function gaugeSVG(valor, max, label, cor) {
        var size = 120, pct = Math.min(valor / max, 1);
        var r = size / 2 - 14, cx = size / 2, cy = size / 2 + 8;
        var sa = Math.PI, ea = sa + Math.PI * pct;
        var x1 = cx + r * Math.cos(sa), y1 = cy + r * Math.sin(sa);
        var x2 = cx + r * Math.cos(ea), y2 = cy + r * Math.sin(ea);
        return '<svg width="' + size + '" height="' + Math.round(size * 0.65) + '" viewBox="0 0 ' + size + ' ' + Math.round(size * 0.65) + '">' +
          '<path d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r) + ' ' + cy + '" fill="none" stroke="rgba(124,58,237,0.15)" stroke-width="10" stroke-linecap="round"/>' +
          '<path d="M ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + (pct > 0.5 ? 1 : 0) + ' 1 ' + x2 + ' ' + y2 + '" fill="none" stroke="' + cor + '" stroke-width="10" stroke-linecap="round"/>' +
          '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" font-size="22" font-weight="800" fill="white" font-family="Segoe UI,sans-serif">' + (typeof valor === 'number' && valor % 1 !== 0 ? valor.toFixed(1) : valor) + '</text>' +
          '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="9" fill="rgba(167,139,250,0.55)" font-family="Segoe UI,sans-serif">' + label + '</text></svg>';
      }

      function kpi(valor, label, un, cor) {
        return '<div class="kpi"><div class="kv" style="color:' + (cor || '#7c3aed') + '">' + valor + (un ? '<span class="ku">' + un + '</span>' : '') + '</div><div class="kl">' + label + '</div></div>';
      }

      function delta(atual, anterior, inv) {
        var a = parseFloat(atual) || 0, b = parseFloat(anterior) || 0;
        if (b === 0) return '<span class="d dn">\u2014</span>';
        var diff = ((a - b) / b * 100).toFixed(1);
        var ok = inv ? diff <= 0 : diff >= 0;
        return '<span class="d ' + (ok ? 'du' : 'dd') + '">' + (diff >= 0 ? '\u2191' : '\u2193') + ' ' + Math.abs(diff) + '%</span>';
      }

      // ═══ DADOS DOS GRÁFICOS ═══
      var evolItems = evolucao.slice(-12).map(function(s) {
        var d = new Date(s.semana);
        var ent = parseInt(s.entregas) || 0;
        var np = parseInt(s.no_prazo) || 0;
        var tp = s.taxa_prazo ? parseFloat(s.taxa_prazo) : (ent > 0 ? Math.round((np / ent) * 1000) / 10 : 0);
        return { label: String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0'), valor: ent, taxa_prazo: tp };
      });
      var totalFaixasKm = faixasKm.reduce(function(s,f){ return s + (parseInt(f.quantidade) || 0); }, 0);
      var faixasItems = faixasKm.slice(0, 7).map(function(f) { var qtd = parseInt(f.quantidade) || 0; var pctTotal = totalFaixasKm > 0 ? ((qtd / totalFaixasKm) * 100).toFixed(0) : '0'; return { label: f.faixa, valor: qtd, display: qtd + ' ent \u00B7 ' + (f.taxa_prazo_faixa || 0) + '% No Prazo \u00B7 ' + pctTotal + '% do total', cor: parseFloat(f.taxa_prazo_faixa) >= 90 ? '#10b981' : parseFloat(f.taxa_prazo_faixa) >= 75 ? '#f59e0b' : '#ef4444' }; });
      var profItems = profissionais.slice(0, 6).map(function(p) { return { label: (p.nome_prof || '').split(' ').slice(0, 2).join(' '), valor: parseInt(p.total_entregas) || 0, display: p.total_entregas + ' ent \u00B7 ' + (p.taxa_prazo || 0) + '% No Prazo', cor: parseFloat(p.taxa_prazo) >= 90 ? '#10b981' : parseFloat(p.taxa_prazo) >= 75 ? '#f59e0b' : '#ef4444' }; });
      var horItems = horarios.slice(0, 8).map(function(h) { return { label: h.faixa_horaria, valor: parseInt(h.entregas) || 0, taxa_prazo: parseFloat(h.taxa_prazo) || 0 }; });
      var motosItems = motosDia.slice(-14).map(function(m) { var d = new Date(m.dia); return { label: String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0'), valor: parseInt(m.motos) || 0 }; });
      // Retornos: filtrar "Entregue" — não é motivo de retorno
      var retItems = retornos.filter(function(r) {
        var oc = (r.ocorrencia || '').toLowerCase();
        return oc !== 'entregue' && oc !== 'entregue com sucesso' && !oc.startsWith('entreg') && oc !== 'coletado' && !oc.startsWith('coletad');
      }).slice(0, 5).map(function(r) { return { label: (r.ocorrencia || '').substring(0, 20), valor: parseInt(r.quantidade) || 0, display: r.quantidade + ' (' + (r.percentual || 0) + '%)', cor: '#ef4444' }; });

      var svgEvol = barraV(evolItems, 1060, 320, { val2Key: 'taxa_prazo' });
      var svgFaixas = barraH(faixasItems, 520);
      var svgProf = barraH(profItems, 520, 6);
      var svgHor = barraV(horItems, 500, 260, { val2Key: 'taxa_prazo', corBarra: ROXO });
      var svgMotos = barraV(motosItems, 480, 200, { corBarra: ROXO, maxItems: 14 });
      var svgRet = barraH(retItems, 480, 5);
      var taxaRet = parseFloat(ma.taxa_retorno || 0);
      var linkMapa = dados.link_mapa_calor || '';


      // ═══ LOGO TUTTS BASE64 ═══
      var logoTuttsB64 = 'data:image/png;base64,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';

      // Cores da marca
      var ROXO = '#7C3AED';
      var ROXO_ESCURO = '#5B21B6';
      var ROXO_CLARO = '#A78BFA';
      var LARANJA = '#F97316';
      var LARANJA_CLARO = '#FB923C';

      // ═══ CAPTURAR SCREENSHOT DO MAPA DE CALOR ═══
      var mapaScreenshotB64 = '';
      if (linkMapa) {
        try {
          var chromiumCapture = require('playwright').chromium;
          var captureBrowser = await chromiumCapture.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security'] });
          var capturePage = await captureBrowser.newPage();
          await capturePage.setViewportSize({ width: 1280, height: 720 });
          await capturePage.goto(linkMapa, { waitUntil: 'domcontentloaded', timeout: 30000 });

          // Aguardar Google Maps renderizar (verifica se o div do mapa tem tiles)
          for (var mw = 0; mw < 15; mw++) {
            await capturePage.waitForTimeout(1000);
            var mapaReady = await capturePage.evaluate(function() {
              var mapDiv = document.getElementById('map');
              if (!mapDiv) return false;
              // Google Maps renderiza tiles como <img> ou <canvas> dentro do div
              var tiles = mapDiv.querySelectorAll('img, canvas');
              return tiles.length > 5; // Mapa carregado tem vários tiles
            }).catch(function() { return false; });
            if (mapaReady) break;
          }

          // Espera extra pro heatmap layer renderizar
          await capturePage.waitForTimeout(2000);

          var screenshotBuffer = await capturePage.screenshot({ type: 'jpeg', quality: 85 });
          mapaScreenshotB64 = 'data:image/jpeg;base64,' + screenshotBuffer.toString('base64');
          await captureBrowser.close();
          console.log('\uD83D\uDDFA Screenshot mapa de calor capturado (' + (screenshotBuffer.length / 1024).toFixed(0) + 'KB)');
        } catch (mapaErr) {
          console.warn('\u26A0\uFE0F Falha ao capturar mapa de calor:', mapaErr.message);
          mapaScreenshotB64 = '';
        }
      }

      // ═══ HTML — slides com identidade visual Tutts ═══
      var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'
        + '@page{size:1280px 720px;margin:0}'
        + '*{margin:0;padding:0;box-sizing:border-box}'
        + 'body{font-family:"Segoe UI",system-ui,sans-serif;background:#120826;color:#fff}'
        // Fundo dos slides: gradiente de roxos escuros
        + '.s{width:1280px;height:720px;background:linear-gradient(135deg,#120826 0%,#1e0a3c 40%,#2a1052 70%,#1a0833 100%);padding:0;page-break-after:always;position:relative;overflow:hidden}'
        + '.s:last-child{page-break-after:auto}'
        // Header branded — barra roxa no topo
        + '.sh{height:6px;background:linear-gradient(90deg,' + ROXO + ',' + ROXO_CLARO + ' 60%,' + LARANJA + ')}'
        + '.sc{padding:32px 56px 48px}'
        // Rodapé branded com fundo roxo
        + '.bb{position:absolute;bottom:0;left:0;right:0;height:40px;background:linear-gradient(90deg,rgba(124,58,237,.18),rgba(124,58,237,.06));border-top:1px solid rgba(124,58,237,.25);display:flex;align-items:center;justify-content:space-between;padding:0 56px;font-size:10px;color:rgba(167,139,250,.5);letter-spacing:1.5px;text-transform:uppercase}'
        + '.bb-left{display:flex;align-items:center;gap:8px}'
        + '.bb-logo{height:18px;border-radius:3px}'
        + '.bb-divider{width:1px;height:14px;background:rgba(124,58,237,.4)}'
        + '.bb-accent{width:20px;height:3px;background:linear-gradient(90deg,' + ROXO + ',' + LARANJA + ');border-radius:2px}'
        // Títulos com gradiente roxo
        + '.st{font-size:28px;font-weight:800;margin-bottom:4px;background:linear-gradient(135deg,' + ROXO_CLARO + ',#c4b5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}'
        + '.ss{font-size:12px;color:rgba(167,139,250,.5);margin-bottom:16px}'
        // Accent bar vertical roxo → laranja
        + '.sa{display:inline-block;width:4px;height:22px;background:linear-gradient(180deg,' + ROXO + ',' + LARANJA + ');border-radius:2px;margin-right:10px;vertical-align:middle}'
        // KPIs com fundo roxo translúcido
        + '.kpi{background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.2);border-radius:12px;padding:16px;text-align:center}'
        + '.kv{font-size:34px;font-weight:800;line-height:1.1}'
        + '.ku{font-size:15px;font-weight:400;opacity:.5;margin-left:2px}'
        + '.kl{font-size:10px;color:rgba(167,139,250,.5);margin-top:4px;text-transform:uppercase;letter-spacing:1px}'
        // Deltas: laranja para positivo (cor da seta da marca)
        + '.d{font-size:11px;font-weight:700;padding:2px 7px;border-radius:16px;margin-left:4px}'
        + '.du{background:rgba(249,115,22,.15);color:' + LARANJA + '}'
        + '.dd{background:rgba(239,68,68,.15);color:#ef4444}'
        + '.dn{background:rgba(124,58,237,.1);color:rgba(167,139,250,.4)}'
        // Cards com borda e fundo roxo
        + '.ca{background:rgba(124,58,237,.06);border:1px solid rgba(124,58,237,.15);border-radius:12px;padding:14px;overflow:hidden}'
        + '.ct{font-size:11px;font-weight:700;color:rgba(167,139,250,.6);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}'
        + '.cl{font-size:9px;color:rgba(167,139,250,.4);margin-top:6px}'
        + '.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}'
        + '</style></head><body>'

        // SLIDE 1: CAPA — identidade visual forte
        + '<div class="s">'
        // Barra superior roxa grossa
        + '<div style="height:8px;background:linear-gradient(90deg,' + ROXO + ',' + ROXO_CLARO + ' 70%,' + LARANJA + ')"></div>'
        // Seta decorativa (SVG inspirada na seta laranja da logo)
        + '<svg style="position:absolute;right:80px;top:60px;opacity:.06" width="300" height="300" viewBox="0 0 100 100"><path d="M20,50 L70,50 L60,35 L85,50 L60,65 L70,50" fill="' + LARANJA + '" stroke="none"/></svg>'
        + '<svg style="position:absolute;left:-40px;bottom:80px;opacity:.04" width="200" height="200" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="none" stroke="' + ROXO + '" stroke-width="2"/></svg>'
        + '<div style="display:flex;align-items:center;justify-content:center;height:calc(100% - 48px);gap:60px;padding:0 56px">'
        + '<div style="flex:1">'
        // Logo
        + '<div style="margin-bottom:28px"><img src="' + logoTuttsB64 + '" style="height:140px" alt="Tutts"/></div>'
        // Linha decorativa laranja
        + '<div style="width:48px;height:4px;background:linear-gradient(90deg,' + LARANJA + ',' + LARANJA_CLARO + ');border-radius:2px;margin-bottom:20px"></div>'
        + '<div style="font-size:11px;font-weight:700;color:' + ROXO_CLARO + ';letter-spacing:3px;text-transform:uppercase;margin-bottom:16px">RAIO-X OPERACIONAL</div>'
        + '<div style="font-size:42px;font-weight:900;line-height:1.1;margin-bottom:10px">' + nomeCliente + '</div>'
        + '<div style="font-size:22px;font-weight:300;color:' + ROXO_CLARO + ';margin-bottom:18px">Relat\u00f3rio de Desempenho Log\u00edstico</div>'
        + '<div style="font-size:15px;color:rgba(167,139,250,.5)">Per\u00edodo: <strong style="color:rgba(220,210,255,.8)">' + dtInicio + '</strong> a <strong style="color:rgba(220,210,255,.8)">' + dtFim + '</strong></div>'
        + '</div>'
        // KPIs resumo no lado direito (no lugar do Health Score)
        + '<div style="display:flex;flex-direction:column;gap:14px;min-width:180px">'
        + '<div style="background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.25);border-radius:14px;padding:18px;text-align:center"><div style="font-size:32px;font-weight:900;color:' + ROXO_CLARO + '">' + fmtNum(parseInt(ma.total_entregas || 0)) + '</div><div style="font-size:10px;color:rgba(167,139,250,.5);text-transform:uppercase;letter-spacing:1px;margin-top:4px">Entregas</div></div>'
        + '<div style="background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.25);border-radius:14px;padding:18px;text-align:center"><div style="font-size:32px;font-weight:900;color:' + (parseFloat(ma.taxa_prazo) >= 85 ? '#10b981' : LARANJA) + '">' + (ma.taxa_prazo || 0) + '%</div><div style="font-size:10px;color:rgba(167,139,250,.5);text-transform:uppercase;letter-spacing:1px;margin-top:4px">Taxa de Prazo</div></div>'
        + '<div style="background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.25);border-radius:14px;padding:18px;text-align:center"><div style="font-size:32px;font-weight:900;color:' + ROXO_CLARO + '">' + (ma.tempo_medio_entrega || ma.tempo_medio || 0) + '<span style="font-size:14px;opacity:.5">min</span></div><div style="font-size:10px;color:rgba(167,139,250,.5);text-transform:uppercase;letter-spacing:1px;margin-top:4px">Tempo M\u00e9dio</div></div>'
        + '</div></div>'
        // Rodapé capa
        + '<div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>Confidencial</span></div></div>'
        + '</div>'

        // SLIDE 2: KPIs
        + '<div class="s"><div class="sh"></div><div class="sc"><div class="st"><span class="sa"></span>Vis\u00e3o Geral da Opera\u00e7\u00e3o</div><div class="ss">Indicadores-chave do per\u00edodo</div>'
        + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">'
        + kpi(fmtNum(parseInt(ma.total_entregas || 0)), 'Total de Entregas', '', ROXO)
        + kpi(ma.taxa_prazo || '0', 'Taxa de Prazo', '%', parseFloat(ma.taxa_prazo) >= 85 ? '#10b981' : LARANJA)
        + kpi(ma.tempo_medio_entrega || ma.tempo_medio || '0', 'Tempo M\u00e9dio', 'min', ROXO_CLARO)
        + '</div>'
        + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px">'
        + kpi(ma.profissionais_unicos || '0', 'Profissionais', '', ROXO)
        + kpi(mediaMotos || '0', 'Motos/Dia', '', LARANJA)
        + kpi(ma.km_medio || '0', 'KM M\u00e9dio', 'km', ROXO_CLARO)
        + kpi(ma.total_retornos || '0', 'Retornos', '', parseInt(ma.total_retornos) > 10 ? '#ef4444' : 'rgba(167,139,250,.6)')
        + '</div>'
        + '<div style="display:flex;gap:14px;margin-top:14px">'
        + '<div style="flex:1;background:rgba(124,58,237,.06);border-radius:10px;padding:12px;border:1px solid rgba(124,58,237,.12)">'
        + '<div style="font-size:10px;color:rgba(167,139,250,.45);margin-bottom:5px">vs. Per\u00edodo Anterior</div>'
        + '<div style="display:flex;gap:14px;font-size:11px;color:rgba(220,210,255,.8)"><span>Entregas ' + delta(ma.total_entregas, mp.total_entregas) + '</span><span>Prazo ' + delta(ma.taxa_prazo, mp.taxa_prazo) + '</span><span>Tempo ' + delta(ma.tempo_medio_entrega || ma.tempo_medio, mp.tempo_medio_entrega || mp.tempo_medio, true) + '</span></div></div>'
        + '</div>'
        + '</div><div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>02</span></div></div></div>'

        // SLIDE 3: EVOLUÇÃO — chart com max-height fixo
        + '<div class="s"><div class="sh"></div><div class="sc"><div class="st"><span class="sa"></span>Evolu\u00e7\u00e3o Semanal</div><div class="ss">Volume de entregas e taxa de prazo por semana</div>'
        + '<div class="ca" style="max-height:480px">' + svgEvol + '<div class="cl">\u25A0 Entregas \u00A0\u00A0 \u25CF Taxa de Prazo (%)</div></div>'
        + '</div><div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>03</span></div></div></div>'

        // SLIDE 4: COBERTURA — faixas de km + botão mapa de calor
        + '<div class="s"><div class="sh"></div><div class="sc"><div class="st"><span class="sa"></span>Cobertura Geogr\u00e1fica</div><div class="ss">Distribui\u00e7\u00e3o por faixa de dist\u00e2ncia</div>'
        + '<div class="ca" style="margin-bottom:16px"><div class="ct">Entregas por Faixa de Dist\u00e2ncia</div>' + svgFaixas + '<div class="cl">Barras = volume de entregas \u00A0\u00A0 Cor = % No Prazo (verde \u2265 90% / amarelo \u2265 75% / vermelho &lt; 75%)</div></div>'
        + (linkMapa ? '<a href="' + linkMapa + '" style="display:flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,' + ROXO + ',' + ROXO_ESCURO + ');border:2px solid ' + ROXO_CLARO + ';border-radius:12px;padding:14px 28px;text-decoration:none;cursor:pointer">'
        + '<span style="font-size:22px">\uD83D\uDDFA\uFE0F</span>'
        + '<span style="font-size:15px;font-weight:700;color:white;letter-spacing:0.5px">Abrir Mapa de Calor Interativo</span>'
        + '<span style="font-size:14px;color:' + LARANJA + '">→</span>'
        + '</a>' : '')
        + '</div><div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>04</span></div></div></div>'

        // SLIDE 4b: MAPA DE CALOR (screenshot + botão interativo)
        + (mapaScreenshotB64 ? '<div class="s"><div class="sh"></div><div class="sc">'
        + '<div class="st"><span class="sa"></span>Mapa de Calor</div><div class="ss">Distribui\u00e7\u00e3o geogr\u00e1fica dos pontos de entrega</div>'
        + '<div style="border-radius:12px;overflow:hidden;border:1px solid rgba(124,58,237,.2);margin-bottom:12px">'
        + '<img src="' + mapaScreenshotB64 + '" style="width:100%;height:auto;max-height:480px;object-fit:cover;display:block"/>'
        + '</div>'
        + '<a href="' + linkMapa + '" style="display:flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,' + ROXO + ',' + ROXO_ESCURO + ');border:2px solid ' + ROXO_CLARO + ';border-radius:12px;padding:12px 24px;text-decoration:none;cursor:pointer">'
        + '<span style="font-size:18px">\uD83D\uDDFA\uFE0F</span>'
        + '<span style="font-size:13px;font-weight:700;color:white">Abrir Vers\u00e3o Interativa</span>'
        + '<span style="font-size:13px;color:' + LARANJA + '">→</span>'
        + '</a>'
        + '</div><div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>05</span></div></div></div>' : '')

        // SLIDE 5: PROFISSIONAIS
        + '<div class="s"><div class="sh"></div><div class="sc"><div class="st"><span class="sa"></span>Profissionais e Frota</div><div class="ss">Desempenho dos motoboys e cobertura di\u00e1ria</div>'
        + '<div class="g2"><div class="ca"><div class="ct">Top Profissionais</div>' + svgProf + '<div class="cl">Barras = entregas \u00A0\u00A0 Cor = % No Prazo</div></div>'
        + '<div><div class="ca" style="margin-bottom:10px"><div class="ct">Motos/Dia</div>' + svgMotos + '</div>'
        + '<div style="background:rgba(124,58,237,.12);border-radius:10px;padding:12px;border:1px solid rgba(124,58,237,.25)">'
        + '<span style="font-size:20px;font-weight:800;color:' + ROXO_CLARO + '">' + (mediaMotos || 0) + '</span> <span style="font-size:11px;color:rgba(167,139,250,.45)">motos/dia (m\u00e9dia)</span></div></div></div>'
        + '</div><div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>05</span></div></div></div>'

        // SLIDE 6: HORÁRIOS + RETORNOS
        + '<div class="s"><div class="sh"></div><div class="sc"><div class="st"><span class="sa"></span>Janela Operacional</div><div class="ss">Entregas por hor\u00e1rio e retornos</div>'
        + '<div class="g2"><div class="ca"><div class="ct">Entregas por Hor\u00e1rio + Prazo</div>' + svgHor + '<div class="cl">\u25A0 Entregas \u00A0\u00A0 \u25CF Prazo (%)</div></div>'
        + '<div><div class="ca" style="margin-bottom:10px"><div class="ct">Retornos por Motivo</div>' + svgRet + '</div>'
        + (taxaRet > 0 ? '<div style="background:' + (taxaRet <= 2 ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)') + ';border-radius:10px;padding:12px;border:1px solid ' + (taxaRet <= 2 ? 'rgba(16,185,129,.15)' : 'rgba(239,68,68,.15)') + '">'
        + '<span style="font-size:20px;font-weight:800;color:' + (taxaRet <= 2 ? '#10b981' : '#ef4444') + '">' + ma.taxa_retorno + '%</span> <span style="font-size:11px;color:rgba(167,139,250,.45)">taxa de retorno</span>'
        + '<div style="font-size:10px;color:rgba(255,255,255,.3);margin-top:2px">' + (taxaRet <= 2 ? 'Saud\u00e1vel (\u22642%)' : taxaRet <= 5 ? 'Aten\u00e7\u00e3o (2-5%)' : 'Acima do limite (>5%)') + '</div></div>' : '')
        + '</div></div>'
        + '</div><div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>06</span></div></div></div>'

        // SLIDE 7: ENCERRAMENTO — identidade visual Tutts
        + '<div class="s">'
        + '<div style="height:8px;background:linear-gradient(90deg,' + ROXO + ',' + ROXO_CLARO + ' 70%,' + LARANJA + ')"></div>'
        // Setas decorativas de fundo
        + '<svg style="position:absolute;right:100px;top:80px;opacity:.05" width="280" height="280" viewBox="0 0 100 100"><path d="M20,50 L70,50 L60,35 L85,50 L60,65 L70,50" fill="' + LARANJA + '" stroke="none"/></svg>'
        + '<svg style="position:absolute;left:100px;bottom:100px;opacity:.03" width="200" height="200" viewBox="0 0 100 100"><path d="M20,50 L70,50 L60,35 L85,50 L60,65 L70,50" fill="' + ROXO + '" stroke="none"/></svg>'
        + '<div style="display:flex;align-items:center;justify-content:center;height:calc(100% - 48px)"><div style="text-align:center">'
        // Logo grande
        + '<div style="margin-bottom:20px"><img src="' + logoTuttsB64 + '" style="height:160px" alt="Tutts"/></div>'
        // Linha decorativa laranja
        + '<div style="width:56px;height:4px;background:linear-gradient(90deg,' + LARANJA + ',' + LARANJA_CLARO + ');border-radius:2px;margin:0 auto 20px"></div>'
        + '<div style="font-size:46px;font-weight:900;margin-bottom:12px">Obrigado</div>'
        + '<div style="font-size:15px;color:rgba(167,139,250,.45);max-width:520px;margin:0 auto;line-height:1.5">Estamos \u00e0 disposi\u00e7\u00e3o para apresentar e detalhar este relat\u00f3rio.</div>'
        + '<div style="margin-top:36px;display:flex;justify-content:center;gap:32px">'
        + '<div><div style="font-size:34px;font-weight:900;color:' + ROXO + '">' + fmtNum(parseInt(ma.total_entregas || 0)) + '</div><div style="font-size:10px;color:rgba(167,139,250,.5)">Entregas</div></div>'
        + '<div style="width:1px;background:rgba(124,58,237,.2)"></div>'
        + '<div><div style="font-size:34px;font-weight:900;color:#10b981">' + (ma.taxa_prazo || 0) + '%</div><div style="font-size:10px;color:rgba(167,139,250,.5)">Taxa de Prazo</div></div>'
        + '<div style="width:1px;background:rgba(124,58,237,.2)"></div>'
        + '<div><div style="font-size:34px;font-weight:900;color:' + ROXO_CLARO + '">' + (ma.tempo_medio_entrega || ma.tempo_medio || 0) + '<span style="font-size:16px;opacity:.5">min</span></div><div style="font-size:10px;color:rgba(167,139,250,.5)">Tempo M\u00e9dio</div></div></div>'
        + '<div style="margin-top:28px;font-size:11px;color:rgba(167,139,250,.3)">' + nomeCliente + ' \u00B7 ' + dtInicio + ' a ' + dtFim + '</div>'
        + '</div></div>'
        + '<div class="bb"><div class="bb-left"><img src="' + logoTuttsB64 + '" class="bb-logo"/><div class="bb-divider"></div><span>Central Tutts</span></div><div class="bb-left"><div class="bb-accent"></div><span>07</span></div></div>'
        + '</div>'

        + '</body></html>';

      // ═══ PDF ═══
      var chromium = require('playwright').chromium;
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      var page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.setContent(html, { waitUntil: 'networkidle' });
      var pdfBuffer = await page.pdf({ width: '1280px', height: '720px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      await browser.close();
      browser = null;

      var filename = 'RaioX_' + nomeCliente.replace(/[^a-zA-Z0-9]/g, '_') + '_' + rx.data_inicio + '_' + rx.data_fim + '.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
      console.log('\uD83D\uDCCA PDF Raio-X v3: ' + filename + ' (' + (pdfBuffer.length / 1024).toFixed(0) + 'KB)');

    } catch (error) {
      if (browser) try { await browser.close(); } catch (e) {}
      console.error('\u274C Erro PDF Raio-X:', error.message);
      res.status(500).json({ error: 'Erro ao gerar PDF: ' + error.message });
    }
  });

  // ==================== GET /cs/raio-x/pdf-texto/:id ====================
  // PDF do relatório TEXTUAL (analise_texto) — reflete edições do usuário
  router.get('/cs/raio-x/pdf-texto/:id', async (req, res) => {
    let browser;
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const rxResult = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [id]);
      if (rxResult.rows.length === 0) return res.status(404).json({ error: 'Raio-X não encontrado' });
      const rx = rxResult.rows[0];

      const nomeCliente = rx.nome_cliente || 'Cliente';
      const dtInicio = new Date(rx.data_inicio).toLocaleDateString('pt-BR');
      const dtFim = new Date(rx.data_fim).toLocaleDateString('pt-BR');
      const healthScore = rx.score_saude || 0;
      const hsColor = healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#f59e0b' : '#ef4444';
      const analiseTexto = rx.analise_texto || '';

      // Detectar se é HTML (editado) ou Markdown (original com gráficos SVG inline)
      const isHTML = analiseTexto.indexOf('<h2 class=') !== -1 || analiseTexto.indexOf('<strong class="font-semibold') !== -1;

      let htmlContent = analiseTexto;
      if (!isHTML) {
        // O analise_texto é Markdown MAS contém blocos HTML de gráficos SVG inline
        // Preservar esses blocos antes de escapar o Markdown
        var svgBlocks = [];
        htmlContent = htmlContent.replace(/<div style="margin:16px 0;background:#f8fafc[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g, function(match) {
          var idx = svgBlocks.length;
          svgBlocks.push(match);
          return '\n%%SVG_BLOCK_' + idx + '%%\n';
        });

        // Também preservar links com estilo (botão mapa de calor)
        var linkBlocks = [];
        htmlContent = htmlContent.replace(/<a href="[^"]*"[^>]*style="[^"]*"[^>]*>[^<]*<\/a>/g, function(match) {
          var idx = linkBlocks.length;
          linkBlocks.push(match);
          return '%%LINK_BLOCK_' + idx + '%%';
        });

        // Agora sim, escapar e converter Markdown
        htmlContent = htmlContent
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/^### (.+)$/gm, '<h3 style="font-size:16px;font-weight:700;color:#4c1d95;margin:20px 0 8px">$1</h3>')
          .replace(/^## (.+)$/gm, '<h2 style="font-size:20px;font-weight:800;color:#4c1d95;margin:28px 0 12px;border-bottom:2px solid #7c3aed;padding-bottom:6px">$1</h2>')
          .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#1e1b4b">$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/^- (.+)$/gm, '<div style="margin:4px 0 4px 16px;font-size:13px">\u2022 $1</div>')
          .replace(/\n\n/g, '<br/><br/>').replace(/\n/g, '<br/>');

        // Restaurar blocos SVG preservados
        svgBlocks.forEach(function(block, idx) {
          htmlContent = htmlContent.replace('%%SVG_BLOCK_' + idx + '%%', block);
        });
        linkBlocks.forEach(function(block, idx) {
          htmlContent = htmlContent.replace('%%LINK_BLOCK_' + idx + '%%', block);
        });
      }

      // Reutilizar logo do escopo pai (logoTuttsB64 já está definido no createRaioXPdfRoutes)
      // Nota: logoTuttsB64 não está acessível aqui pois é definido dentro da rota GET /pdf/:id
      // Vou embutir uma referência simplificada
      var hasLogo = false; // Logo será incluída via CSS background na header

      const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'
        + '*{margin:0;padding:0;box-sizing:border-box}'
        + 'body{font-family:"Segoe UI",system-ui,sans-serif;background:white;color:#1e1b4b;font-size:13px;line-height:1.7}'
        + '.page{padding:20mm 20mm 16mm}'
        + '.header-bar{background:linear-gradient(90deg,#7c3aed,#6d28d9,#5b21b6);height:8px;margin:-20mm -20mm 16px}'
        + '.footer-bar{border-top:2px solid #7c3aed;padding-top:8px;margin-top:24px;display:flex;justify-content:space-between;font-size:9px;color:#7c3aed}'
        + '.cover{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(297mm - 40mm);text-align:center}'
        + '.cover-title{font-size:32px;font-weight:900;color:#4c1d95;margin-bottom:8px}'
        + '.cover-subtitle{font-size:18px;color:#7c3aed;margin-bottom:16px}'
        + '.cover-meta{font-size:12px;color:#6b7280}'
        + '.hs-badge{display:inline-block;padding:8px 24px;border-radius:20px;font-size:20px;font-weight:800;color:white;margin-top:16px}'
        + '.content{page-break-before:always}'
        + '.content h2,.content .text-lg{font-size:18px;font-weight:800;color:#4c1d95;margin:24px 0 10px;border-bottom:2px solid #7c3aed;padding-bottom:4px}'
        + '.content h3,.content .text-base{font-size:15px;font-weight:700;color:#6d28d9;margin:16px 0 6px}'
        + '.content strong,.content .font-semibold{color:#1e1b4b}'
        + '.content a{color:#7c3aed}'
        + '.content li{margin:3px 0 3px 12px;font-size:13px}'
        // Gráficos SVG inline — o analise_texto já contém os gráficos com fundo #f8fafc
        + '.content div[style*="background:#f8fafc"]{background:#f8fafc !important;border:1px solid #e2e8f0 !important;border-radius:10px !important;padding:16px !important;margin:16px 0 !important;overflow-x:auto !important;page-break-inside:avoid}'
        + '.content svg{max-width:100%;height:auto}'
        // Botão do mapa de calor — manter estilo visual
        + '.content a[style*="background:linear-gradient"]{display:inline-block !important;padding:8px 20px !important;border-radius:8px !important;text-decoration:none !important;font-weight:700 !important;font-size:13px !important;margin:8px 0 !important}'
        + '</style></head><body>'

        // CAPA
        + '<div class="page"><div class="cover">'
        + '<div style="font-size:48px;font-weight:900;color:#7c3aed;margin-bottom:8px">tutts</div>'
        + '<div style="width:60px;height:4px;background:linear-gradient(90deg,#f97316,#fb923c);border-radius:2px;margin:0 auto 20px"></div>'
        + '<div style="font-size:11px;font-weight:700;color:#7c3aed;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px">RAIO-X OPERACIONAL</div>'
        + '<div class="cover-title">' + nomeCliente + '</div>'
        + '<div class="cover-subtitle">Relatório de Desempenho Logístico</div>'
        + '<div class="cover-meta">Período: ' + dtInicio + ' a ' + dtFim + '</div>'
        + '<div class="hs-badge" style="background:' + hsColor + '">Health Score: ' + healthScore + '/100</div>'
        + '</div></div>'

        // CONTEÚDO
        + '<div class="page content">'
        + '<div class="header-bar"></div>'
        + htmlContent
        + '<div class="footer-bar"><span>Central Tutts — Raio-X Operacional</span><span>' + nomeCliente + ' · ' + dtInicio + ' a ' + dtFim + '</span></div>'
        + '</div>'

        + '</body></html>';

      var chromium = require('playwright').chromium;
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      var page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      var pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', right: '0', bottom: '12mm', left: '0' },
        displayHeaderFooter: false
      });
      await browser.close();
      browser = null;

      var filename = 'RaioX_Texto_' + nomeCliente.replace(/[^a-zA-Z0-9]/g, '_') + '.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);
      console.log('\uD83D\uDCDD PDF Raio-X Texto: ' + filename + ' (' + (pdfBuffer.length / 1024).toFixed(0) + 'KB)');

    } catch (error) {
      if (browser) try { await browser.close(); } catch (e) {}
      console.error('\u274C Erro PDF Raio-X Texto:', error.message);
      res.status(500).json({ error: 'Erro ao gerar PDF texto: ' + error.message });
    }
  });

  return router;
}

module.exports = { createRaioXPdfRoutes };
