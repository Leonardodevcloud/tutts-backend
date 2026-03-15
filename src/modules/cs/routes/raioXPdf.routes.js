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
        var corBarra = opts.corBarra || '#7c3aed', corLinha = opts.corLinha || '#f59e0b';
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
          svg += '<line x1="' + leftPad + '" y1="' + gy + '" x2="' + (leftPad + usedW) + '" y2="' + gy + '" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>';
          svg += '<text x="' + (leftPad - 8) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="rgba(255,255,255,0.4)" font-family="Segoe UI,sans-serif">' + gv + '</text>';
        }

        list.forEach(function(item, idx) {
          var x = leftPad + idx * (barW + 8) + 4;
          var val = parseFloat(item[valKey]) || 0;
          var bh = Math.max(3, (val / maxVal) * chartH);
          var y = bottomY - bh;
          svg += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + bh + '" rx="3" fill="' + corBarra + '" opacity="0.85"/>';
          if (barW >= 18) svg += '<text x="' + (x + barW/2) + '" y="' + (y - 4) + '" text-anchor="middle" font-size="10" font-weight="700" fill="white" font-family="Segoe UI,sans-serif">' + Math.round(val) + '</text>';
          svg += '<text x="' + (x + barW/2) + '" y="' + (bottomY + 14) + '" text-anchor="middle" font-size="' + (barW >= 22 ? 10 : 8) + '" fill="rgba(255,255,255,0.5)" font-family="Segoe UI,sans-serif">' + (item[labelKey] || '').substring(0, 8) + '</text>';
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
            var y = bottomY - (v2 / 100) * chartH;
            svg += '<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + corLinha + '" stroke="#1a1a2e" stroke-width="1.5"/>';
            if (barW >= 16) svg += '<text x="' + x + '" y="' + (y - 10) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + corLinha + '" font-family="Segoe UI,sans-serif">' + v2.toFixed(0) + '%</text>';
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
          '<path d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r) + ' ' + cy + '" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10" stroke-linecap="round"/>' +
          '<path d="M ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + (pct > 0.5 ? 1 : 0) + ' 1 ' + x2 + ' ' + y2 + '" fill="none" stroke="' + cor + '" stroke-width="10" stroke-linecap="round"/>' +
          '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" font-size="22" font-weight="800" fill="white" font-family="Segoe UI,sans-serif">' + (typeof valor === 'number' && valor % 1 !== 0 ? valor.toFixed(1) : valor) + '</text>' +
          '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.5)" font-family="Segoe UI,sans-serif">' + label + '</text></svg>';
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
        return { label: d.getDate() + '/' + (d.getMonth()+1), valor: ent, taxa_prazo: tp };
      });
      var faixasItems = faixasKm.slice(0, 7).map(function(f) { return { label: f.faixa, valor: parseInt(f.quantidade) || 0, display: (parseInt(f.quantidade) || 0) + ' \u00B7 ' + (f.taxa_prazo_faixa || 0) + '%', cor: parseFloat(f.taxa_prazo_faixa) >= 90 ? '#10b981' : parseFloat(f.taxa_prazo_faixa) >= 75 ? '#f59e0b' : '#ef4444' }; });
      var profItems = profissionais.slice(0, 6).map(function(p) { return { label: (p.nome_prof || '').split(' ').slice(0, 2).join(' '), valor: parseInt(p.total_entregas) || 0, display: p.total_entregas + ' \u00B7 ' + (p.taxa_prazo || 0) + '%', cor: parseFloat(p.taxa_prazo) >= 90 ? '#10b981' : parseFloat(p.taxa_prazo) >= 75 ? '#f59e0b' : '#ef4444' }; });
      var horItems = horarios.slice(0, 8).map(function(h) { return { label: h.faixa_horaria, valor: parseInt(h.entregas) || 0, taxa_prazo: parseFloat(h.taxa_prazo) || 0 }; });
      var motosItems = motosDia.slice(-14).map(function(m) { var d = new Date(m.dia); return { label: d.getDate() + '/' + (d.getMonth()+1), valor: parseInt(m.motos) || 0 }; });
      // Retornos: filtrar "Entregue" — não é motivo de retorno
      var retItems = retornos.filter(function(r) {
        var oc = (r.ocorrencia || '').toLowerCase();
        return oc !== 'entregue' && oc !== 'entregue com sucesso' && !oc.startsWith('entreg');
      }).slice(0, 5).map(function(r) { return { label: (r.ocorrencia || '').substring(0, 20), valor: parseInt(r.quantidade) || 0, display: r.quantidade + ' (' + (r.percentual || 0) + '%)', cor: '#ef4444' }; });

      var svgEvol = barraV(evolItems, 1060, 320, { val2Key: 'taxa_prazo' });
      var svgFaixas = barraH(faixasItems, 520);
      var svgProf = barraH(profItems, 520, 6);
      var svgHor = barraV(horItems, 500, 260, { val2Key: 'taxa_prazo', corBarra: '#8b5cf6' });
      var svgMotos = barraV(motosItems, 480, 200, { corBarra: '#8b5cf6', maxItems: 14 });
      var svgRet = barraH(retItems, 480, 5);
      var taxaRet = parseFloat(ma.taxa_retorno || 0);
      var linkMapa = dados.link_mapa_calor || '';


      // ═══ HTML — slides com alturas FIXAS, sem flex-grow em charts ═══
      var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'
        + '@page{size:1280px 720px;margin:0}'
        + '*{margin:0;padding:0;box-sizing:border-box}'
        + 'body{font-family:"Segoe UI",system-ui,sans-serif;background:#0f0f23;color:#fff}'
        + '.s{width:1280px;height:720px;background:linear-gradient(135deg,#0f0f23,#1a1a2e,#16213e);padding:44px 56px 48px;page-break-after:always;position:relative}'
        + '.s:last-child{page-break-after:auto}'
        + '.bb{position:absolute;bottom:16px;left:56px;right:56px;display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.06);padding-top:8px;font-size:10px;color:rgba(255,255,255,.2);letter-spacing:1.5px;text-transform:uppercase}'
        + '.st{font-size:28px;font-weight:800;margin-bottom:4px;background:linear-gradient(135deg,#7c3aed,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}'
        + '.ss{font-size:12px;color:rgba(255,255,255,.4);margin-bottom:16px}'
        + '.sa{display:inline-block;width:4px;height:22px;background:#7c3aed;border-radius:2px;margin-right:10px;vertical-align:middle}'
        + '.kpi{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px;text-align:center}'
        + '.kv{font-size:34px;font-weight:800;line-height:1.1}'
        + '.ku{font-size:15px;font-weight:400;opacity:.5;margin-left:2px}'
        + '.kl{font-size:10px;color:rgba(255,255,255,.4);margin-top:4px;text-transform:uppercase;letter-spacing:1px}'
        + '.d{font-size:11px;font-weight:700;padding:2px 7px;border-radius:16px;margin-left:4px}'
        + '.du{background:rgba(16,185,129,.15);color:#10b981}'
        + '.dd{background:rgba(239,68,68,.15);color:#ef4444}'
        + '.dn{background:rgba(255,255,255,.06);color:rgba(255,255,255,.3)}'
        + '.ca{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:12px;padding:14px;overflow:hidden}'
        + '.ct{font-size:11px;font-weight:700;color:rgba(255,255,255,.55);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}'
        + '.cl{font-size:9px;color:rgba(255,255,255,.3);margin-top:6px}'
        + '.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}'
        + '</style></head><body>'

        // SLIDE 1: CAPA
        + '<div class="s"><div style="display:flex;align-items:center;justify-content:center;height:100%;gap:50px"><div style="flex:1">'
        + '<div style="font-size:11px;font-weight:700;color:#7c3aed;letter-spacing:3px;text-transform:uppercase;margin-bottom:20px">RAIO-X OPERACIONAL</div>'
        + '<div style="font-size:42px;font-weight:900;line-height:1.1;margin-bottom:10px">' + nomeCliente + '</div>'
        + '<div style="font-size:22px;font-weight:300;color:#a78bfa;margin-bottom:18px">Relat\u00f3rio de Desempenho Log\u00edstico</div>'
        + '<div style="font-size:13px;color:rgba(255,255,255,.35)">Per\u00edodo: <strong style="color:rgba(255,255,255,.6)">' + dtInicio + '</strong> a <strong style="color:rgba(255,255,255,.6)">' + dtFim + '</strong></div>'
        + '</div><div style="text-align:center"><div style="width:170px;height:170px;border-radius:50%;border:6px solid ' + hsColor + ';display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,.02)">'
        + '<div style="font-size:52px;font-weight:900;color:' + hsColor + '">' + healthScore + '</div>'
        + '<div style="font-size:11px;color:rgba(255,255,255,.4)">Health Score</div>'
        + '<div style="font-size:13px;font-weight:700;color:' + hsColor + '">' + hsLabel + '</div>'
        + '</div></div></div><div class="bb"><span>Central Tutts</span><span>Confidencial</span></div></div>'

        // SLIDE 2: KPIs
        + '<div class="s"><div class="st"><span class="sa"></span>Vis\u00e3o Geral da Opera\u00e7\u00e3o</div><div class="ss">Indicadores-chave do per\u00edodo</div>'
        + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">'
        + kpi(fmtNum(parseInt(ma.total_entregas || 0)), 'Total de Entregas', '', '#7c3aed')
        + kpi(ma.taxa_prazo || '0', 'Taxa de Prazo', '%', parseFloat(ma.taxa_prazo) >= 85 ? '#10b981' : '#f59e0b')
        + kpi(ma.tempo_medio_entrega || ma.tempo_medio || '0', 'Tempo M\u00e9dio', 'min', '#3b82f6')
        + '</div>'
        + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px">'
        + kpi(ma.profissionais_unicos || '0', 'Profissionais', '', '#8b5cf6')
        + kpi(mediaMotos || '0', 'Motos/Dia', '', '#8b5cf6')
        + kpi(ma.km_medio || '0', 'KM M\u00e9dio', 'km', '#06b6d4')
        + kpi(ma.total_retornos || '0', 'Retornos', '', parseInt(ma.total_retornos) > 10 ? '#ef4444' : '#64748b')
        + '</div>'
        + '<div style="display:flex;gap:14px;margin-top:14px">'
        + '<div style="flex:1;background:rgba(124,58,237,.06);border-radius:10px;padding:12px;border:1px solid rgba(124,58,237,.12)">'
        + '<div style="font-size:10px;color:rgba(255,255,255,.35);margin-bottom:5px">vs. Per\u00edodo Anterior</div>'
        + '<div style="display:flex;gap:14px;font-size:11px;color:rgba(255,255,255,.6)"><span>Entregas ' + delta(ma.total_entregas, mp.total_entregas) + '</span><span>Prazo ' + delta(ma.taxa_prazo, mp.taxa_prazo) + '</span><span>Tempo ' + delta(ma.tempo_medio_entrega || ma.tempo_medio, mp.tempo_medio_entrega || mp.tempo_medio, true) + '</span></div></div>'
        + '<div style="flex:1;background:rgba(16,185,129,.06);border-radius:10px;padding:12px;border:1px solid rgba(16,185,129,.12)">'
        + '<div style="font-size:10px;color:rgba(255,255,255,.35);margin-bottom:5px">Ranking Tutts</div>'
        + '<div style="font-size:11px;color:rgba(255,255,255,.6)">Prazo: <strong style="color:#10b981">Top ' + (ranking.percentil_prazo || '\u2014') + '%</strong> \u00A0\u00A0 Volume: <strong style="color:#3b82f6">Top ' + (ranking.percentil_volume || '\u2014') + '%</strong></div></div>'
        + '</div>'
        + '<div class="bb"><span>Central Tutts</span><span>02</span></div></div>'

        // SLIDE 3: EVOLUÇÃO — chart com max-height fixo
        + '<div class="s"><div class="st"><span class="sa"></span>Evolu\u00e7\u00e3o Semanal</div><div class="ss">Volume de entregas e taxa de prazo por semana</div>'
        + '<div class="ca" style="max-height:480px">' + svgEvol + '<div class="cl">\u25A0 Entregas \u00A0\u00A0 \u25CF Taxa de Prazo (%)</div></div>'
        + '<div class="bb"><span>Central Tutts</span><span>03</span></div></div>'

        // SLIDE 4: COBERTURA — faixas de km + link mapa de calor
        + '<div class="s"><div class="st"><span class="sa"></span>Cobertura Geogr\u00e1fica</div><div class="ss">Distribui\u00e7\u00e3o por faixa de dist\u00e2ncia</div>'
        + '<div class="ca" style="margin-bottom:16px"><div class="ct">Entregas por Faixa de Dist\u00e2ncia</div>' + svgFaixas + '</div>'
        + (linkMapa ? '<div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.12);border-radius:10px;padding:16px;display:flex;align-items:center;gap:14px">'
        + '<div style="font-size:28px">\uD83D\uDDFA\uFE0F</div>'
        + '<div><div style="font-size:14px;font-weight:700;color:#10b981">Mapa de Calor Interativo</div>'
        + '<div style="font-size:11px;color:rgba(255,255,255,.4);margin-top:2px">Visualize todos os pontos de entrega, taxa de prazo por regi\u00e3o e tempo m\u00e9dio</div>'
        + '<div style="font-size:10px;color:rgba(255,255,255,.25);margin-top:6px;word-break:break-all">' + linkMapa + '</div></div></div>' : '')
        + '<div class="bb"><span>Central Tutts</span><span>04</span></div></div>'

        // SLIDE 5: PROFISSIONAIS
        + '<div class="s"><div class="st"><span class="sa"></span>Profissionais e Frota</div><div class="ss">Desempenho dos motoboys e cobertura di\u00e1ria</div>'
        + '<div class="g2"><div class="ca"><div class="ct">Top Profissionais</div>' + svgProf + '</div>'
        + '<div><div class="ca" style="margin-bottom:10px"><div class="ct">Motos/Dia</div>' + svgMotos + '</div>'
        + '<div style="background:rgba(139,92,246,.08);border-radius:10px;padding:12px;border:1px solid rgba(139,92,246,.15)">'
        + '<span style="font-size:20px;font-weight:800;color:#a78bfa">' + (mediaMotos || 0) + '</span> <span style="font-size:11px;color:rgba(255,255,255,.35)">motos/dia (m\u00e9dia)</span></div></div></div>'
        + '<div class="bb"><span>Central Tutts</span><span>05</span></div></div>'

        // SLIDE 6: HORÁRIOS + RETORNOS
        + '<div class="s"><div class="st"><span class="sa"></span>Janela Operacional</div><div class="ss">Entregas por hor\u00e1rio e retornos</div>'
        + '<div class="g2"><div class="ca"><div class="ct">Entregas por Hor\u00e1rio + Prazo</div>' + svgHor + '<div class="cl">\u25A0 Entregas \u00A0\u00A0 \u25CF Prazo (%)</div></div>'
        + '<div><div class="ca" style="margin-bottom:10px"><div class="ct">Retornos por Motivo</div>' + svgRet + '</div>'
        + (taxaRet > 0 ? '<div style="background:' + (taxaRet <= 2 ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)') + ';border-radius:10px;padding:12px;border:1px solid ' + (taxaRet <= 2 ? 'rgba(16,185,129,.15)' : 'rgba(239,68,68,.15)') + '">'
        + '<span style="font-size:20px;font-weight:800;color:' + (taxaRet <= 2 ? '#10b981' : '#ef4444') + '">' + ma.taxa_retorno + '%</span> <span style="font-size:11px;color:rgba(255,255,255,.35)">taxa de retorno</span>'
        + '<div style="font-size:10px;color:rgba(255,255,255,.3);margin-top:2px">' + (taxaRet <= 2 ? 'Saud\u00e1vel (\u22642%)' : taxaRet <= 5 ? 'Aten\u00e7\u00e3o (2-5%)' : 'Acima do limite (>5%)') + '</div></div>' : '')
        + '</div></div>'
        + '<div class="bb"><span>Central Tutts</span><span>06</span></div></div>'

        // SLIDE 7: ENCERRAMENTO
        + '<div class="s"><div style="display:flex;align-items:center;justify-content:center;height:100%"><div style="text-align:center">'
        + '<div style="font-size:11px;font-weight:700;color:#7c3aed;letter-spacing:3px;text-transform:uppercase;margin-bottom:24px">CENTRAL TUTTS</div>'
        + '<div style="font-size:46px;font-weight:900;margin-bottom:12px">Obrigado</div>'
        + '<div style="font-size:15px;color:rgba(255,255,255,.35);max-width:520px;margin:0 auto;line-height:1.5">Estamos \u00e0 disposi\u00e7\u00e3o para apresentar e detalhar este relat\u00f3rio.</div>'
        + '<div style="margin-top:36px;display:flex;justify-content:center;gap:32px">'
        + '<div><div style="font-size:34px;font-weight:900;color:' + hsColor + '">' + healthScore + '</div><div style="font-size:10px;color:rgba(255,255,255,.3)">Health Score</div></div>'
        + '<div style="width:1px;background:rgba(255,255,255,.08)"></div>'
        + '<div><div style="font-size:34px;font-weight:900;color:#7c3aed">' + fmtNum(parseInt(ma.total_entregas || 0)) + '</div><div style="font-size:10px;color:rgba(255,255,255,.3)">Entregas</div></div>'
        + '<div style="width:1px;background:rgba(255,255,255,.08)"></div>'
        + '<div><div style="font-size:34px;font-weight:900;color:#10b981">' + (ma.taxa_prazo || 0) + '%</div><div style="font-size:10px;color:rgba(255,255,255,.3)">Taxa de Prazo</div></div></div>'
        + '<div style="margin-top:28px;font-size:11px;color:rgba(255,255,255,.18)">' + nomeCliente + ' \u00B7 ' + dtInicio + ' a ' + dtFim + '</div>'
        + '</div></div><div class="bb"><span>Central Tutts</span><span>07</span></div></div>'

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

  return router;
}

module.exports = { createRaioXPdfRoutes };
