/**
 * CS Sub-Router: Raio-X PDF Presentation
 * Gera PDF estilo slide/apresentação do relatório Raio-X
 * Usa Playwright para render HTML → PDF landscape
 * v2: slides bem dimensionados, SVGs responsivos, dados limitados ao espaço
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

      const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('pt-BR'); } catch (e) { return d || ''; } };
      const fmtNum = (n) => { try { return parseInt(n).toLocaleString('pt-BR'); } catch (e) { return n || '0'; } };
      const dtInicio = fmtDate(rx.data_inicio || periodo.inicio);
      const dtFim = fmtDate(rx.data_fim || periodo.fim);
      const nomeCliente = rx.nome_cliente || cliente.nome || 'Cliente';
      const hsColor = healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#f59e0b' : '#ef4444';
      const hsLabel = healthScore >= 80 ? 'Excelente' : healthScore >= 50 ? 'Atenção' : 'Crítico';

      // ═══ HELPERS SVG ═══

      function barraHorizontalSVG(items, opts = {}) {
        const { w = 520, corBase = '#7c3aed', maxItems = 7 } = opts;
        const list = items.slice(0, maxItems);
        if (!list.length) return '';
        const maxVal = Math.max(...list.map(i => i.valor || 0), 1);
        const barH = list.length <= 5 ? 28 : 22;
        const gap = list.length <= 5 ? 8 : 5;
        const labelW = 130;
        const chartW = w - labelW - 20;
        const h = list.length * (barH + gap) + 10;
        let bars = '';
        list.forEach((item, idx) => {
          const y = idx * (barH + gap) + 5;
          const bw = Math.max(4, (item.valor / maxVal) * chartW * 0.6);
          const cor = item.cor || corBase;
          bars += '<text x="' + (labelW - 8) + '" y="' + (y + barH/2 + 4) + '" text-anchor="end" font-size="12" fill="rgba(255,255,255,0.75)" font-family="Segoe UI,sans-serif">' + (item.label||'').substring(0,22) + '</text>';
          bars += '<rect x="' + labelW + '" y="' + y + '" width="' + bw + '" height="' + barH + '" rx="5" fill="' + cor + '" opacity="0.9"/>';
          bars += '<text x="' + (labelW + bw + 8) + '" y="' + (y + barH/2 + 4) + '" font-size="11" font-weight="700" fill="white" font-family="Segoe UI,sans-serif">' + (item.display || item.valor) + '</text>';
        });
        return '<svg width="100%" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">' + bars + '</svg>';
      }

      function barraVerticalSVG(items, opts = {}) {
        const { w = 520, chartH = 200, corBarra = '#7c3aed', corLinha = '#f59e0b', labelKey = 'label', valKey = 'valor', val2Key = null, maxItems = 16 } = opts;
        const list = items.slice(-maxItems);
        if (!list.length) return '';
        const maxVal = Math.max(...list.map(i => parseFloat(i[valKey]) || 0), 1);
        const barW = Math.max(12, Math.min(36, Math.floor((w - 80) / list.length) - 6));
        const bottomY = chartH + 20;
        const leftPad = 45;
        let svg = '';

        for (let g = 0; g <= 4; g++) {
          const gy = bottomY - (g / 4) * chartH;
          const gv = Math.round((g / 4) * maxVal);
          svg += '<line x1="' + leftPad + '" y1="' + gy + '" x2="' + (leftPad + list.length * (barW + 6)) + '" y2="' + gy + '" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>';
          svg += '<text x="' + (leftPad - 8) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="rgba(255,255,255,0.4)" font-family="Segoe UI,sans-serif">' + gv + '</text>';
        }

        list.forEach((item, idx) => {
          const x = leftPad + idx * (barW + 6) + 3;
          const val = parseFloat(item[valKey]) || 0;
          const bh = Math.max(3, (val / maxVal) * chartH);
          const y = bottomY - bh;
          svg += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + bh + '" rx="3" fill="' + corBarra + '" opacity="0.85"/>';
          if (barW >= 20) svg += '<text x="' + (x + barW/2) + '" y="' + (y - 4) + '" text-anchor="middle" font-size="10" font-weight="700" fill="white" font-family="Segoe UI,sans-serif">' + val + '</text>';
          svg += '<text x="' + (x + barW/2) + '" y="' + (bottomY + 13) + '" text-anchor="middle" font-size="' + (barW >= 24 ? 10 : 8) + '" fill="rgba(255,255,255,0.5)" font-family="Segoe UI,sans-serif">' + (item[labelKey]||'').substring(0,7) + '</text>';
        });

        if (val2Key) {
          const points = list.map((item, idx) => {
            const x = leftPad + idx * (barW + 6) + 3 + barW / 2;
            const val2 = parseFloat(item[val2Key]) || 0;
            return x + ',' + (bottomY - (val2 / 100) * chartH);
          }).join(' ');
          svg += '<polyline points="' + points + '" fill="none" stroke="' + corLinha + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
          list.forEach((item, idx) => {
            const x = leftPad + idx * (barW + 6) + 3 + barW / 2;
            const val2 = parseFloat(item[val2Key]) || 0;
            const y = bottomY - (val2 / 100) * chartH;
            svg += '<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + corLinha + '" stroke="#1a1a2e" stroke-width="1.5"/>';
            if (barW >= 16) svg += '<text x="' + x + '" y="' + (y - 9) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + corLinha + '" font-family="Segoe UI,sans-serif">' + val2.toFixed(0) + '%</text>';
          });
        }

        const svgW = leftPad + list.length * (barW + 6) + 20;
        const svgH = bottomY + 28;
        return '<svg width="100%" viewBox="0 0 ' + svgW + ' ' + svgH + '" xmlns="http://www.w3.org/2000/svg">' + svg + '</svg>';
      }

      function gaugeSVG(valor, max, label, cor) {
        const size = 130;
        const pct = Math.min(valor / max, 1);
        const r = size / 2 - 14;
        const cx = size / 2, cy = size / 2 + 8;
        const sa = Math.PI, ea = sa + Math.PI * pct;
        const x1 = cx + r * Math.cos(sa), y1 = cy + r * Math.sin(sa);
        const x2 = cx + r * Math.cos(ea), y2 = cy + r * Math.sin(ea);
        return '<svg width="' + size + '" height="' + (size * 0.65) + '" viewBox="0 0 ' + size + ' ' + (size * 0.65) + '" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r) + ' ' + cy + '" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10" stroke-linecap="round"/>' +
          '<path d="M ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + (pct > 0.5 ? 1 : 0) + ' 1 ' + x2 + ' ' + y2 + '" fill="none" stroke="' + cor + '" stroke-width="10" stroke-linecap="round"/>' +
          '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" font-size="24" font-weight="800" fill="white" font-family="Segoe UI,sans-serif">' + (typeof valor === 'number' && valor % 1 !== 0 ? valor.toFixed(1) : valor) + '</text>' +
          '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.5)" font-family="Segoe UI,sans-serif">' + label + '</text>' +
          '</svg>';
      }

      function kpiBlock(valor, label, unidade, cor) {
        unidade = unidade || '';
        cor = cor || '#7c3aed';
        return '<div class="kpi-block"><div class="kpi-valor" style="color:' + cor + '">' + valor + '<span class="kpi-unidade">' + unidade + '</span></div><div class="kpi-label">' + label + '</div></div>';
      }

      function deltaBadge(atual, anterior, invertido) {
        const a = parseFloat(atual) || 0, b = parseFloat(anterior) || 0;
        if (b === 0) return '<span class="delta neutral">\u2014</span>';
        const diff = ((a - b) / b * 100).toFixed(1);
        const positivo = invertido ? diff <= 0 : diff >= 0;
        return '<span class="delta ' + (positivo ? 'up' : 'down') + '">' + (diff >= 0 ? '\u2191' : '\u2193') + ' ' + Math.abs(diff) + '%</span>';
      }

      // ═══ PREPARAR GRÁFICOS ═══

      const evolucaoItems = evolucao.slice(-16).map(function(s) {
        const d = new Date(s.semana);
        return { label: d.getDate() + '/' + (d.getMonth() + 1), valor: parseInt(s.entregas) || 0, taxa_prazo: parseFloat(s.taxa_prazo || 0) || 0 };
      });
      const svgEvolucao = barraVerticalSVG(evolucaoItems, { val2Key: 'taxa_prazo', chartH: 220 });

      const faixasItems = faixasKm.slice(0, 7).map(function(f) {
        return { label: f.faixa, valor: parseInt(f.quantidade) || 0, display: (parseInt(f.quantidade) || 0) + ' \u00B7 ' + (f.taxa_prazo_faixa || 0) + '%', cor: parseFloat(f.taxa_prazo_faixa) >= 90 ? '#10b981' : parseFloat(f.taxa_prazo_faixa) >= 75 ? '#f59e0b' : '#ef4444' };
      });
      const svgFaixas = barraHorizontalSVG(faixasItems);

      const profItems = profissionais.slice(0, 6).map(function(p) {
        return { label: (p.nome_prof || '').split(' ').slice(0, 2).join(' '), valor: parseInt(p.total_entregas) || 0, display: p.total_entregas + ' ent \u00B7 ' + (p.taxa_prazo || 0) + '%', cor: parseFloat(p.taxa_prazo) >= 90 ? '#10b981' : parseFloat(p.taxa_prazo) >= 75 ? '#f59e0b' : '#ef4444' };
      });
      const svgProfissionais = barraHorizontalSVG(profItems, { maxItems: 6 });

      const horarioItems = horarios.slice(0, 10).map(function(h) {
        return { label: h.faixa_horaria, valor: parseInt(h.entregas) || 0, taxa_prazo: parseFloat(h.taxa_prazo) || 0 };
      });
      const svgHorarios = barraVerticalSVG(horarioItems, { val2Key: 'taxa_prazo', corBarra: '#8b5cf6', chartH: 180 });

      const motosItems = motosDia.slice(-20).map(function(m) {
        const d = new Date(m.dia);
        return { label: d.getDate() + '/' + (d.getMonth() + 1), valor: parseInt(m.motos) || 0 };
      });
      const svgMotos = barraVerticalSVG(motosItems, { corBarra: '#8b5cf6', chartH: 140, maxItems: 20 });

      const topBairros = bairros.slice(0, 6).map(function(b) {
        return { label: (b.bairro || 'N/I').substring(0, 22), valor: parseInt(b.entregas) || 0, display: b.entregas + ' \u00B7 ' + (b.taxa_prazo || 0) + '%', cor: parseFloat(b.taxa_prazo) >= 90 ? '#10b981' : parseFloat(b.taxa_prazo) >= 75 ? '#f59e0b' : '#ef4444' };
      });
      const svgBairros = barraHorizontalSVG(topBairros, { maxItems: 6 });

      const retornoItems = retornos.slice(0, 5).map(function(r) {
        return { label: (r.ocorrencia || '').substring(0, 22), valor: parseInt(r.quantidade) || 0, display: r.quantidade + ' (' + (r.percentual || 0) + '%)', cor: '#ef4444' };
      });
      const svgRetornos = barraHorizontalSVG(retornoItems, { corBase: '#ef4444', maxItems: 5 });


      // ═══ HTML ═══
      const taxaRetorno = parseFloat(ma.taxa_retorno || 0);
      const html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><style>'
+ '@page { size: 1280px 720px; margin: 0; }'
+ '* { margin: 0; padding: 0; box-sizing: border-box; }'
+ 'body { font-family: "Segoe UI", system-ui, sans-serif; background: #0f0f23; color: white; }'
+ '.slide { width: 1280px; height: 720px; background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%); padding: 48px 60px 52px; page-break-after: always; position: relative; display: flex; flex-direction: column; }'
+ '.slide:last-child { page-break-after: auto; }'
+ '.slide::before { content: ""; position: absolute; top: -200px; right: -200px; width: 500px; height: 500px; border-radius: 50%; background: radial-gradient(circle, rgba(124,58,237,0.08) 0%, transparent 70%); pointer-events: none; }'
+ '.brand-bar { position: absolute; bottom: 18px; left: 60px; right: 60px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; }'
+ '.brand-name { font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.25); letter-spacing: 2px; text-transform: uppercase; }'
+ '.brand-page { font-size: 11px; color: rgba(255,255,255,0.15); }'
+ '.slide-title { font-size: 30px; font-weight: 800; margin-bottom: 4px; background: linear-gradient(135deg, #7c3aed, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; flex-shrink: 0; }'
+ '.slide-subtitle { font-size: 13px; color: rgba(255,255,255,0.45); margin-bottom: 20px; flex-shrink: 0; }'
+ '.section-accent { display: inline-block; width: 4px; height: 24px; background: #7c3aed; border-radius: 2px; margin-right: 10px; vertical-align: middle; }'
+ '.slide-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }'
+ '.kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }'
+ '.kpi-block { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 14px; padding: 18px; text-align: center; }'
+ '.kpi-valor { font-size: 36px; font-weight: 800; line-height: 1.1; }'
+ '.kpi-unidade { font-size: 16px; font-weight: 400; opacity: 0.5; margin-left: 3px; }'
+ '.kpi-label { font-size: 11px; color: rgba(255,255,255,0.45); margin-top: 4px; text-transform: uppercase; letter-spacing: 1px; }'
+ '.kpi-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 12px; }'
+ '.kpi-grid-4 .kpi-block { padding: 14px; }'
+ '.kpi-grid-4 .kpi-valor { font-size: 28px; }'
+ '.delta { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 20px; margin-left: 6px; }'
+ '.delta.up { background: rgba(16,185,129,0.15); color: #10b981; }'
+ '.delta.down { background: rgba(239,68,68,0.15); color: #ef4444; }'
+ '.delta.neutral { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.35); }'
+ '.chart-area { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 14px; padding: 16px; flex: 1; min-height: 0; }'
+ '.chart-title { font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.6); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }'
+ '.chart-legend { font-size: 10px; color: rgba(255,255,255,0.35); margin-top: 6px; }'
+ '.cols-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; flex: 1; min-height: 0; }'
+ '.cols-2 > div { display: flex; flex-direction: column; min-height: 0; }'
+ '.cover-content { display: flex; align-items: center; justify-content: center; flex: 1; gap: 50px; }'
+ '.comp-row { display: grid; grid-template-columns: 100px 1fr 70px; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }'
+ '.comp-label { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.6); }'
+ '.comp-bar { height: 16px; border-radius: 3px; min-width: 6px; display: flex; align-items: center; padding-left: 6px; font-size: 10px; font-weight: 700; margin-bottom: 3px; }'
+ '.comp-delta { text-align: right; }'
+ '</style></head><body>'

// SLIDE 1: CAPA
+ '<div class="slide"><div class="cover-content"><div style="flex:1">'
+ '<div style="font-size:12px;font-weight:700;color:#7c3aed;letter-spacing:3px;text-transform:uppercase;margin-bottom:20px">RAIO-X OPERACIONAL</div>'
+ '<div style="font-size:44px;font-weight:900;line-height:1.1;margin-bottom:10px;color:white">' + nomeCliente + '</div>'
+ '<div style="font-size:24px;font-weight:300;color:#a78bfa;margin-bottom:20px">Relatório de Desempenho Logístico</div>'
+ '<div style="font-size:14px;color:rgba(255,255,255,0.35)">Período: <strong style="color:rgba(255,255,255,0.6)">' + dtInicio + '</strong> a <strong style="color:rgba(255,255,255,0.6)">' + dtFim + '</strong></div>'
+ '</div>'
+ '<div style="text-align:center"><div style="width:180px;height:180px;border-radius:50%;border:6px solid ' + hsColor + ';display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,0.02)">'
+ '<div style="font-size:56px;font-weight:900;color:' + hsColor + '">' + healthScore + '</div>'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.4)">Health Score</div>'
+ '<div style="font-size:14px;font-weight:700;color:' + hsColor + '">' + hsLabel + '</div>'
+ '</div></div></div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">Confidencial</div></div></div>'

// SLIDE 2: KPIs
+ '<div class="slide">'
+ '<div class="slide-title"><span class="section-accent"></span>Visão Geral da Operação</div>'
+ '<div class="slide-subtitle">Indicadores-chave do período</div>'
+ '<div class="slide-body">'
+ '<div class="kpi-grid">'
+ kpiBlock(fmtNum(parseInt(ma.total_entregas || 0)), 'Total de Entregas', '', '#7c3aed')
+ kpiBlock(ma.taxa_prazo || '0', 'Taxa de Prazo', '%', parseFloat(ma.taxa_prazo) >= 85 ? '#10b981' : '#f59e0b')
+ kpiBlock(ma.tempo_medio_entrega || ma.tempo_medio || '0', 'Tempo Médio', 'min', '#3b82f6')
+ '</div>'
+ '<div class="kpi-grid-4">'
+ kpiBlock(ma.profissionais_unicos || '0', 'Profissionais', '', '#8b5cf6')
+ kpiBlock(mediaMotos || '0', 'Motos/Dia', '', '#8b5cf6')
+ kpiBlock(ma.km_medio || '0', 'KM Médio', 'km', '#06b6d4')
+ kpiBlock(ma.total_retornos || '0', 'Retornos', '', parseInt(ma.total_retornos) > 10 ? '#ef4444' : '#64748b')
+ '</div>'
+ '<div style="display:flex;gap:16px;margin-top:14px">'
+ '<div style="flex:1;background:rgba(124,58,237,0.06);border-radius:10px;padding:14px;border:1px solid rgba(124,58,237,0.12)">'
+ '<div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:6px">vs. Período Anterior</div>'
+ '<div style="display:flex;gap:16px;flex-wrap:wrap">'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.6)">Entregas ' + deltaBadge(ma.total_entregas, mp.total_entregas) + '</div>'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.6)">Prazo ' + deltaBadge(ma.taxa_prazo, mp.taxa_prazo) + '</div>'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.6)">Tempo ' + deltaBadge(ma.tempo_medio_entrega || ma.tempo_medio, mp.tempo_medio_entrega || mp.tempo_medio, true) + '</div>'
+ '</div></div>'
+ '<div style="flex:1;background:rgba(16,185,129,0.06);border-radius:10px;padding:14px;border:1px solid rgba(16,185,129,0.12)">'
+ '<div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:6px">Posição no Ranking Tutts</div>'
+ '<div style="display:flex;gap:16px">'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.6)">Prazo: <strong style="color:#10b981">Top ' + (ranking.percentil_prazo || '\u2014') + '%</strong></div>'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.6)">Volume: <strong style="color:#3b82f6">Top ' + (ranking.percentil_volume || '\u2014') + '%</strong></div>'
+ '</div></div></div>'
+ '</div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">02</div></div></div>'

// SLIDE 3: EVOLUÇÃO
+ '<div class="slide">'
+ '<div class="slide-title"><span class="section-accent"></span>Evolução Semanal</div>'
+ '<div class="slide-subtitle">Volume de entregas e taxa de prazo por semana</div>'
+ '<div class="slide-body"><div class="chart-area" style="flex:1">'
+ (svgEvolucao || '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:60px">Dados insuficientes</div>')
+ '<div class="chart-legend">\u25A0 Entregas \u00A0\u00A0 \u25CF Taxa de Prazo (%)</div>'
+ '</div></div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">03</div></div></div>'

// SLIDE 4: COBERTURA
+ '<div class="slide">'
+ '<div class="slide-title"><span class="section-accent"></span>Cobertura Geográfica</div>'
+ '<div class="slide-subtitle">Distribuição por faixa de distância e regiões</div>'
+ '<div class="slide-body"><div class="cols-2">'
+ '<div class="chart-area"><div class="chart-title">Faixas de Distância</div>' + (svgFaixas || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>') + '</div>'
+ '<div class="chart-area"><div class="chart-title">Top Bairros/Regiões</div>' + (svgBairros || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>') + '</div>'
+ '</div></div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">04</div></div></div>'

// SLIDE 5: PROFISSIONAIS
+ '<div class="slide">'
+ '<div class="slide-title"><span class="section-accent"></span>Profissionais e Frota</div>'
+ '<div class="slide-subtitle">Desempenho dos motoboys e cobertura diária</div>'
+ '<div class="slide-body"><div class="cols-2">'
+ '<div class="chart-area"><div class="chart-title">Top Profissionais por Volume</div>' + (svgProfissionais || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>') + '</div>'
+ '<div>'
+ '<div class="chart-area" style="flex:1"><div class="chart-title">Motos/Dia no Período</div>' + (svgMotos || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>') + '</div>'
+ '<div style="margin-top:10px;background:rgba(139,92,246,0.08);border-radius:10px;padding:14px;border:1px solid rgba(139,92,246,0.15);flex-shrink:0"><div style="font-size:22px;font-weight:800;color:#a78bfa">' + (mediaMotos || 0) + ' <span style="font-size:12px;font-weight:400;color:rgba(255,255,255,0.35)">motos/dia (média)</span></div></div>'
+ '</div></div></div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">05</div></div></div>'

// SLIDE 6: HORÁRIOS + RETORNOS
+ '<div class="slide">'
+ '<div class="slide-title"><span class="section-accent"></span>Janela Operacional</div>'
+ '<div class="slide-subtitle">Entregas por horário e retornos</div>'
+ '<div class="slide-body"><div class="cols-2">'
+ '<div class="chart-area"><div class="chart-title">Entregas por Horário + Prazo</div>' + (svgHorarios || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>') + '<div class="chart-legend">\u25A0 Entregas \u00A0\u00A0 \u25CF Prazo (%)</div></div>'
+ '<div>'
+ '<div class="chart-area" style="flex:1"><div class="chart-title">Retornos por Motivo</div>' + (svgRetornos || '<div style="color:rgba(255,255,255,0.3);padding:30px;text-align:center">Nenhum retorno</div>') + '</div>'
+ (taxaRetorno > 0 ? '<div style="margin-top:10px;background:' + (taxaRetorno <= 2 ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)') + ';border-radius:10px;padding:14px;border:1px solid ' + (taxaRetorno <= 2 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)') + ';flex-shrink:0"><div style="font-size:22px;font-weight:800;color:' + (taxaRetorno <= 2 ? '#10b981' : '#ef4444') + '">' + ma.taxa_retorno + '% <span style="font-size:12px;font-weight:400;color:rgba(255,255,255,0.35)">taxa de retorno</span></div><div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:3px">' + (taxaRetorno <= 2 ? 'Padr\u00e3o saud\u00e1vel (\u22642%)' : taxaRetorno <= 5 ? 'Faixa de aten\u00e7\u00e3o (2-5%)' : 'Acima do limite (>5%)') + '</div></div>' : '')
+ '</div></div></div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">06</div></div></div>'

// SLIDE 7: BENCHMARK
+ '<div class="slide">'
+ '<div class="slide-title"><span class="section-accent"></span>Comparativo com o Mercado</div>'
+ '<div class="slide-subtitle">Posicionamento na base Tutts</div>'
+ '<div class="slide-body"><div class="cols-2">'
+ '<div>'
+ '<div class="kpi-grid" style="grid-template-columns:1fr 1fr;gap:12px">'
+ '<div class="kpi-block"><div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:6px">ESTE CLIENTE</div>' + gaugeSVG(parseFloat(ma.taxa_prazo) || 0, 100, 'Taxa de Prazo', parseFloat(ma.taxa_prazo) >= 85 ? '#10b981' : '#f59e0b') + '</div>'
+ '<div class="kpi-block"><div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:6px">M\u00c9DIA TUTTS</div>' + gaugeSVG(parseFloat(benchGeral.media_taxa_prazo) || 0, 100, 'Base completa', '#64748b') + '</div>'
+ '</div>'
+ '<div style="margin-top:12px">'
+ '<div class="comp-row"><div class="comp-label">Taxa Prazo</div><div><div class="comp-bar" style="width:' + Math.min(parseFloat(ma.taxa_prazo) || 0, 100) + '%;background:#7c3aed;color:white">' + (ma.taxa_prazo || 0) + '%</div><div class="comp-bar" style="width:' + Math.min(parseFloat(benchGeral.media_taxa_prazo) || 0, 100) + '%;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.5)">' + (benchGeral.media_taxa_prazo || 0) + '%</div></div><div class="comp-delta">' + deltaBadge(ma.taxa_prazo, benchGeral.media_taxa_prazo) + '</div></div>'
+ '<div class="comp-row"><div class="comp-label">Tempo M\u00e9dio</div><div style="font-size:13px;font-weight:700;color:white">' + (ma.tempo_medio_entrega || ma.tempo_medio || 0) + 'min <span style="font-weight:400;color:rgba(255,255,255,0.35)">vs ' + (benchGeral.media_tempo_entrega || 0) + 'min</span></div><div class="comp-delta">' + deltaBadge(ma.tempo_medio_entrega || ma.tempo_medio, benchGeral.media_tempo_entrega, true) + '</div></div>'
+ '<div class="comp-row"><div class="comp-label">KM M\u00e9dio</div><div style="font-size:13px;font-weight:700;color:white">' + (ma.km_medio || 0) + 'km <span style="font-weight:400;color:rgba(255,255,255,0.35)">vs ' + (benchGeral.media_km || 0) + 'km</span></div><div></div></div>'
+ '</div></div>'
+ '<div>'
+ '<div class="kpi-block" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">'
+ '<div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:16px;text-transform:uppercase;letter-spacing:1px">Ranking Geral</div>'
+ '<div style="font-size:44px;font-weight:900;color:#7c3aed">Top ' + (ranking.percentil_prazo || '\u2014') + '%</div>'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px">em Taxa de Prazo entre ' + (benchGeral.total_clientes || '\u2014') + ' clientes</div>'
+ '<div style="margin-top:20px;font-size:32px;font-weight:800;color:#3b82f6">Top ' + (ranking.percentil_volume || '\u2014') + '%</div>'
+ '<div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px">em Volume de Entregas</div>'
+ '</div></div></div></div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">07</div></div></div>'

// SLIDE 8: ENCERRAMENTO
+ '<div class="slide"><div class="cover-content"><div style="text-align:center;width:100%">'
+ '<div style="font-size:12px;font-weight:700;color:#7c3aed;letter-spacing:3px;text-transform:uppercase;margin-bottom:28px">CENTRAL TUTTS</div>'
+ '<div style="font-size:48px;font-weight:900;color:white;margin-bottom:14px">Obrigado</div>'
+ '<div style="font-size:16px;color:rgba(255,255,255,0.35);max-width:560px;margin:0 auto;line-height:1.6">Estamos \u00e0 disposi\u00e7\u00e3o para apresentar e detalhar este relat\u00f3rio.</div>'
+ '<div style="margin-top:40px;display:flex;justify-content:center;gap:36px">'
+ '<div><div style="font-size:36px;font-weight:900;color:' + hsColor + '">' + healthScore + '</div><div style="font-size:11px;color:rgba(255,255,255,0.35)">Health Score</div></div>'
+ '<div style="width:1px;background:rgba(255,255,255,0.08)"></div>'
+ '<div><div style="font-size:36px;font-weight:900;color:#7c3aed">' + fmtNum(parseInt(ma.total_entregas || 0)) + '</div><div style="font-size:11px;color:rgba(255,255,255,0.35)">Entregas</div></div>'
+ '<div style="width:1px;background:rgba(255,255,255,0.08)"></div>'
+ '<div><div style="font-size:36px;font-weight:900;color:#10b981">' + (ma.taxa_prazo || 0) + '%</div><div style="font-size:11px;color:rgba(255,255,255,0.35)">Taxa de Prazo</div></div>'
+ '</div>'
+ '<div style="margin-top:32px;font-size:12px;color:rgba(255,255,255,0.2)">' + nomeCliente + ' \u00B7 ' + dtInicio + ' a ' + dtFim + '</div>'
+ '</div></div>'
+ '<div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">08</div></div></div>'
+ '</body></html>';

      // ═══ GERAR PDF ═══
      const { chromium } = require('playwright');
      browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.setContent(html, { waitUntil: 'networkidle' });

      const pdfBuffer = await page.pdf({
        width: '1280px',
        height: '720px',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });

      await browser.close();
      browser = null;

      const filename = 'RaioX_' + nomeCliente.replace(/[^a-zA-Z0-9]/g, '_') + '_' + rx.data_inicio + '_' + rx.data_fim + '.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);

      console.log('📊 PDF Raio-X gerado: ' + filename + ' (' + (pdfBuffer.length / 1024).toFixed(0) + 'KB)');

    } catch (error) {
      if (browser) try { await browser.close(); } catch (e) {}
      console.error('❌ Erro ao gerar PDF Raio-X:', error.message, error.stack);
      res.status(500).json({ error: 'Erro ao gerar PDF: ' + error.message });
    }
  });

  return router;
}

module.exports = { createRaioXPdfRoutes };
