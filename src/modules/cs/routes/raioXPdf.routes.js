/**
 * CS Sub-Router: Raio-X PDF Presentation
 * Gera PDF estilo slide/apresentação do relatório Raio-X
 * Usa Playwright para render HTML → PDF landscape
 */
const express = require('express');

function createRaioXPdfRoutes(pool) {
  const router = express.Router();

  // ══════════════════════════════════════════════════
  // GET /cs/raio-x/pdf/:id — Gera PDF apresentação
  // ══════════════════════════════════════════════════
  router.get('/cs/raio-x/pdf/:id', async (req, res) => {
    let browser;
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      // 1. Buscar dados do Raio-X salvo
      const rxResult = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [id]);
      if (rxResult.rows.length === 0) return res.status(404).json({ error: 'Raio-X não encontrado' });
      const rx = rxResult.rows[0];

      // 2. Parse dos dados
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

      // Datas formatadas
      const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('pt-BR'); } catch (e) { return d || ''; } };
      const dtInicio = fmtDate(rx.data_inicio || periodo.inicio);
      const dtFim = fmtDate(rx.data_fim || periodo.fim);
      const nomeCliente = rx.nome_cliente || cliente.nome || 'Cliente';

      // Health score color
      const hsColor = healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#f59e0b' : '#ef4444';
      const hsLabel = healthScore >= 80 ? 'Excelente' : healthScore >= 50 ? 'Atenção' : 'Crítico';

      // 3. Gerar SVGs dos gráficos

      // Helper: barra horizontal
      function barraHorizontalSVG(items, { w = 700, barH = 32, gap = 8, corBase = '#7c3aed' } = {}) {
        if (!items.length) return '';
        const maxVal = Math.max(...items.map(i => i.valor || 0), 1);
        const labelW = 110;
        const valW = 80;
        const chartW = w - labelW - valW - 30;
        const h = items.length * (barH + gap) + 10;
        let bars = '';
        items.forEach((item, idx) => {
          const y = idx * (barH + gap) + 5;
          const bw = Math.max(4, (item.valor / maxVal) * chartW);
          const cor = item.cor || corBase;
          bars += `<text x="${labelW - 8}" y="${y + barH/2 + 5}" text-anchor="end" font-size="13" fill="rgba(255,255,255,0.8)" font-family="Segoe UI,system-ui,sans-serif">${(item.label||'').substring(0,16)}</text>`;
          bars += `<rect x="${labelW}" y="${y}" width="${bw}" height="${barH}" rx="6" fill="${cor}" opacity="0.9"/>`;
          bars += `<text x="${labelW + bw + 10}" y="${y + barH/2 + 5}" font-size="13" font-weight="700" fill="white" font-family="Segoe UI,system-ui,sans-serif">${item.display || item.valor}</text>`;
        });
        return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
      }

      // Helper: barra vertical com linha
      function barraVerticalSVG(items, { w = 700, chartH = 220, corBarra = '#7c3aed', corLinha = '#f59e0b', labelKey = 'label', valKey = 'valor', val2Key = null } = {}) {
        if (!items.length) return '';
        const maxVal = Math.max(...items.map(i => parseFloat(i[valKey]) || 0), 1);
        const barW = Math.min(50, Math.floor((w - 100) / items.length) - 10);
        const bottomY = chartH + 30;
        const leftPad = 55;
        let svg = '';

        // Grid
        for (let g = 0; g <= 4; g++) {
          const gy = bottomY - (g / 4) * chartH;
          const gv = Math.round((g / 4) * maxVal);
          svg += `<line x1="${leftPad}" y1="${gy}" x2="${leftPad + items.length * (barW + 10)}" y2="${gy}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`;
          svg += `<text x="${leftPad - 10}" y="${gy + 4}" text-anchor="end" font-size="11" fill="rgba(255,255,255,0.5)" font-family="Segoe UI,sans-serif">${gv}</text>`;
        }

        // Bars
        items.forEach((item, idx) => {
          const x = leftPad + idx * (barW + 10) + 5;
          const val = parseFloat(item[valKey]) || 0;
          const bh = Math.max(3, (val / maxVal) * chartH);
          const y = bottomY - bh;
          svg += `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4" fill="${corBarra}" opacity="0.85"/>`;
          svg += `<text x="${x + barW/2}" y="${y - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="white" font-family="Segoe UI,sans-serif">${val}</text>`;
          svg += `<text x="${x + barW/2}" y="${bottomY + 16}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.6)" font-family="Segoe UI,sans-serif">${(item[labelKey]||'').substring(0,10)}</text>`;
        });

        // Line overlay (taxa_prazo, etc)
        if (val2Key) {
          const points = items.map((item, idx) => {
            const x = leftPad + idx * (barW + 10) + 5 + barW / 2;
            const val2 = parseFloat(item[val2Key]) || 0;
            const y = bottomY - (val2 / 100) * chartH;
            return `${x},${y}`;
          }).join(' ');
          svg += `<polyline points="${points}" fill="none" stroke="${corLinha}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
          items.forEach((item, idx) => {
            const x = leftPad + idx * (barW + 10) + 5 + barW / 2;
            const val2 = parseFloat(item[val2Key]) || 0;
            const y = bottomY - (val2 / 100) * chartH;
            svg += `<circle cx="${x}" cy="${y}" r="5" fill="${corLinha}" stroke="#1a1a2e" stroke-width="2"/>`;
            svg += `<text x="${x}" y="${y - 12}" text-anchor="middle" font-size="11" font-weight="700" fill="${corLinha}" font-family="Segoe UI,sans-serif">${val2.toFixed(0)}%</text>`;
          });
        }

        // Eixo X
        svg += `<line x1="${leftPad}" y1="${bottomY}" x2="${leftPad + items.length * (barW + 10)}" y2="${bottomY}" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>`;

        const svgW = leftPad + items.length * (barW + 10) + 30;
        const svgH = bottomY + 35;
        return `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
      }

      // Helper: gauge semicircular
      function gaugeSVG(valor, max, label, cor, { size = 140 } = {}) {
        const pct = Math.min(valor / max, 1);
        const r = size / 2 - 15;
        const cx = size / 2;
        const cy = size / 2 + 10;
        const startAngle = Math.PI;
        const endAngle = startAngle + Math.PI * pct;
        const x1 = cx + r * Math.cos(startAngle);
        const y1 = cy + r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle);
        const y2 = cy + r * Math.sin(endAngle);
        const largeArc = pct > 0.5 ? 1 : 0;
        return `<svg width="${size}" height="${size * 0.7}" viewBox="0 0 ${size} ${size * 0.7}" xmlns="http://www.w3.org/2000/svg">
          <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="12" stroke-linecap="round"/>
          <path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}" fill="none" stroke="${cor}" stroke-width="12" stroke-linecap="round"/>
          <text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="28" font-weight="800" fill="white" font-family="Segoe UI,sans-serif">${typeof valor === 'number' && valor % 1 !== 0 ? valor.toFixed(1) : valor}</text>
          <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.6)" font-family="Segoe UI,sans-serif">${label}</text>
        </svg>`;
      }

      // Helper: KPI big number
      function kpiBlock(valor, label, unidade = '', cor = '#7c3aed') {
        return `<div class="kpi-block">
          <div class="kpi-valor" style="color:${cor}">${valor}<span class="kpi-unidade">${unidade}</span></div>
          <div class="kpi-label">${label}</div>
        </div>`;
      }

      // Helper: delta badge
      function deltaBadge(atual, anterior, invertido = false) {
        const a = parseFloat(atual) || 0;
        const b = parseFloat(anterior) || 0;
        if (b === 0) return '<span class="delta neutral">—</span>';
        const diff = ((a - b) / b * 100).toFixed(1);
        const positivo = invertido ? diff <= 0 : diff >= 0;
        const seta = diff >= 0 ? '↑' : '↓';
        return `<span class="delta ${positivo ? 'up' : 'down'}">${seta} ${Math.abs(diff)}%</span>`;
      }

      // ═══════════════════════════════════════════
      // 4. PREPARAR DADOS DOS GRÁFICOS
      // ═══════════════════════════════════════════

      // Gráfico evolução semanal
      const evolucaoItems = evolucao.map(s => {
        const d = new Date(s.semana);
        return { label: `${d.getDate()}/${d.getMonth() + 1}`, valor: parseInt(s.entregas) || 0, taxa_prazo: parseFloat(s.taxa_prazo || (s.no_prazo && s.entregas ? (s.no_prazo / s.entregas * 100) : 0)) || 0 };
      });
      const svgEvolucao = barraVerticalSVG(evolucaoItems, { val2Key: 'taxa_prazo' });

      // Gráfico faixas de km
      const faixasItems = faixasKm.map(f => ({
        label: f.faixa,
        valor: parseInt(f.quantidade) || 0,
        display: `${parseInt(f.quantidade) || 0} entregas · ${f.taxa_prazo_faixa || 0}%`,
        cor: parseFloat(f.taxa_prazo_faixa) >= 90 ? '#10b981' : parseFloat(f.taxa_prazo_faixa) >= 75 ? '#f59e0b' : '#ef4444',
      }));
      const svgFaixas = barraHorizontalSVG(faixasItems);

      // Gráfico profissionais (top 8)
      const profItems = profissionais.slice(0, 8).map(p => ({
        label: (p.nome_prof || '').split(' ').slice(0, 2).join(' '),
        valor: parseInt(p.total_entregas) || 0,
        display: `${p.total_entregas} ent. · ${p.taxa_prazo || 0}% prazo`,
        cor: parseFloat(p.taxa_prazo) >= 90 ? '#10b981' : parseFloat(p.taxa_prazo) >= 75 ? '#f59e0b' : '#ef4444',
      }));
      const svgProfissionais = barraHorizontalSVG(profItems);

      // Gráfico horários
      const horarioItems = horarios.map(h => ({
        label: h.faixa_horaria,
        valor: parseInt(h.entregas) || 0,
        taxa_prazo: parseFloat(h.taxa_prazo) || 0,
      }));
      const svgHorarios = barraVerticalSVG(horarioItems, { val2Key: 'taxa_prazo', corBarra: '#8b5cf6' });

      // Gráfico motos por dia
      const motosItems = motosDia.map(m => {
        const d = new Date(m.dia);
        return { label: `${d.getDate()}/${d.getMonth() + 1}`, valor: parseInt(m.motos) || 0 };
      });
      const svgMotos = barraVerticalSVG(motosItems, { corBarra: '#8b5cf6' });

      // Top bairros (top 8)
      const topBairros = bairros.slice(0, 8).map(b => ({
        label: (b.bairro || 'N/I').substring(0, 16),
        valor: parseInt(b.entregas) || 0,
        display: `${b.entregas} ent. · ${b.taxa_prazo || 0}% · ${b.km_medio || 0}km`,
        cor: parseFloat(b.taxa_prazo) >= 90 ? '#10b981' : parseFloat(b.taxa_prazo) >= 75 ? '#f59e0b' : '#ef4444',
      }));
      const svgBairros = barraHorizontalSVG(topBairros);

      // Retornos
      const retornoItems = retornos.slice(0, 6).map(r => ({
        label: (r.ocorrencia || '').substring(0, 20),
        valor: parseInt(r.quantidade) || 0,
        display: `${r.quantidade} (${r.percentual || 0}%)`,
        cor: '#ef4444',
      }));
      const svgRetornos = barraHorizontalSVG(retornoItems, { corBase: '#ef4444' });

      // ═══════════════════════════════════════════
      // 5. MONTAR HTML DA APRESENTAÇÃO
      // ═══════════════════════════════════════════
      const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  @page { size: 1280px 720px; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #0f0f23; color: white; }

  .slide {
    width: 1280px; height: 720px;
    background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
    padding: 60px 70px;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .slide:last-child { page-break-after: auto; }

  /* Decoração de fundo */
  .slide::before {
    content: ''; position: absolute; top: -200px; right: -200px;
    width: 500px; height: 500px; border-radius: 50%;
    background: radial-gradient(circle, rgba(124,58,237,0.08) 0%, transparent 70%);
  }
  .slide::after {
    content: ''; position: absolute; bottom: -150px; left: -150px;
    width: 400px; height: 400px; border-radius: 50%;
    background: radial-gradient(circle, rgba(245,158,11,0.05) 0%, transparent 70%);
  }

  /* Logo / brand bar */
  .brand-bar {
    position: absolute; bottom: 24px; left: 70px; right: 70px;
    display: flex; justify-content: space-between; align-items: center;
    border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;
  }
  .brand-name { font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.3); letter-spacing: 2px; text-transform: uppercase; }
  .brand-page { font-size: 12px; color: rgba(255,255,255,0.2); }

  /* Títulos */
  .slide-title {
    font-size: 36px; font-weight: 800; margin-bottom: 8px;
    background: linear-gradient(135deg, #7c3aed, #a78bfa);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .slide-subtitle { font-size: 15px; color: rgba(255,255,255,0.5); margin-bottom: 32px; font-weight: 400; }

  /* Section title accent */
  .section-accent {
    display: inline-block; width: 4px; height: 28px; background: #7c3aed;
    border-radius: 2px; margin-right: 12px; vertical-align: middle;
  }

  /* KPIs */
  .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin: 20px 0; }
  .kpi-block {
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px; padding: 24px; text-align: center;
  }
  .kpi-valor { font-size: 42px; font-weight: 800; line-height: 1.1; }
  .kpi-unidade { font-size: 18px; font-weight: 400; opacity: 0.6; margin-left: 4px; }
  .kpi-label { font-size: 13px; color: rgba(255,255,255,0.5); margin-top: 6px; text-transform: uppercase; letter-spacing: 1px; }

  .kpi-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; margin: 16px 0; }
  .kpi-grid-4 .kpi-block { padding: 18px; }
  .kpi-grid-4 .kpi-valor { font-size: 32px; }

  /* Delta badges */
  .delta { font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 20px; margin-left: 8px; }
  .delta.up { background: rgba(16,185,129,0.15); color: #10b981; }
  .delta.down { background: rgba(239,68,68,0.15); color: #ef4444; }
  .delta.neutral { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.4); }

  /* Chart container */
  .chart-area {
    background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 16px; padding: 24px; margin: 12px 0;
  }
  .chart-title { font-size: 14px; font-weight: 700; color: rgba(255,255,255,0.7); margin-bottom: 12px; }
  .chart-legend { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 8px; }

  /* Two column layout */
  .cols-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .cols-2-wide { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 24px; }

  /* Health ring */
  .health-ring-big {
    width: 180px; height: 180px; border-radius: 50%;
    border: 8px solid rgba(255,255,255,0.08);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative;
  }
  .health-ring-big::before {
    content: ''; position: absolute; inset: -8px; border-radius: 50%;
    border: 8px solid transparent; border-top-color: var(--hs-color);
    border-right-color: var(--hs-color);
    transform: rotate(-45deg);
  }
  .health-score-big { font-size: 52px; font-weight: 900; line-height: 1; }
  .health-label-big { font-size: 14px; font-weight: 600; margin-top: 4px; }

  /* Cover slide */
  .cover-content {
    display: flex; align-items: center; justify-content: center;
    height: 100%; gap: 60px;
  }
  .cover-left { flex: 1; }
  .cover-title { font-size: 48px; font-weight: 900; line-height: 1.1; margin-bottom: 12px; color: white; }
  .cover-client { font-size: 28px; font-weight: 300; color: #a78bfa; margin-bottom: 24px; }
  .cover-period { font-size: 16px; color: rgba(255,255,255,0.4); }
  .cover-period strong { color: rgba(255,255,255,0.7); }

  /* Action items */
  .action-item {
    background: rgba(255,255,255,0.03); border-left: 4px solid #7c3aed;
    border-radius: 0 12px 12px 0; padding: 14px 18px; margin-bottom: 10px;
  }
  .action-title { font-size: 14px; font-weight: 700; color: white; margin-bottom: 4px; }
  .action-desc { font-size: 12px; color: rgba(255,255,255,0.5); }

  /* Comparativo */
  .comp-row {
    display: grid; grid-template-columns: 120px 1fr 80px; align-items: center;
    padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .comp-label { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7); }
  .comp-bars { display: flex; flex-direction: column; gap: 4px; }
  .comp-bar { height: 18px; border-radius: 4px; min-width: 8px; display: flex; align-items: center; padding-left: 8px; font-size: 11px; font-weight: 700; }
  .comp-delta { text-align: right; }

  /* Top bairros table-like */
  .ranking-item {
    display: grid; grid-template-columns: 30px 1fr 100px 80px; align-items: center;
    padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .ranking-pos {
    width: 24px; height: 24px; border-radius: 50%;
    background: rgba(124,58,237,0.2); display: flex; align-items: center;
    justify-content: center; font-size: 11px; font-weight: 700; color: #a78bfa;
  }
  .ranking-name { font-size: 13px; color: rgba(255,255,255,0.8); padding-left: 8px; }
  .ranking-val { font-size: 13px; font-weight: 700; color: white; text-align: right; }
  .ranking-pct { font-size: 12px; font-weight: 600; text-align: right; }
</style>
</head>
<body>

<!-- ═══════ SLIDE 1: CAPA ═══════ -->
<div class="slide">
  <div class="cover-content">
    <div class="cover-left">
      <div style="font-size:14px;font-weight:700;color:#7c3aed;letter-spacing:3px;text-transform:uppercase;margin-bottom:24px">RAIO-X OPERACIONAL</div>
      <div class="cover-title">${nomeCliente}</div>
      <div class="cover-client">Relatório de Desempenho Logístico</div>
      <div class="cover-period">
        Período: <strong>${dtInicio}</strong> a <strong>${dtFim}</strong><br>
        ${periodo.dias || ''} dias analisados · Gerado em ${fmtDate(rx.created_at)}
      </div>
    </div>
    <div style="text-align:center">
      <div style="width:200px;height:200px;border-radius:50%;border:6px solid ${hsColor};display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,0.02)">
        <div style="font-size:64px;font-weight:900;color:${hsColor}">${healthScore}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.5)">Health Score</div>
        <div style="font-size:16px;font-weight:700;color:${hsColor}">${hsLabel}</div>
      </div>
    </div>
  </div>
  <div class="brand-bar">
    <div class="brand-name">Central Tutts</div>
    <div class="brand-page">Confidencial · Uso Interno</div>
  </div>
</div>

<!-- ═══════ SLIDE 2: KPIs OVERVIEW ═══════ -->
<div class="slide">
  <div class="slide-title"><span class="section-accent"></span>Visão Geral da Operação</div>
  <div class="slide-subtitle">Indicadores-chave do período</div>

  <div class="kpi-grid">
    ${kpiBlock(parseInt(ma.total_entregas || 0).toLocaleString('pt-BR'), 'Total de Entregas', '', '#7c3aed')}
    ${kpiBlock(ma.taxa_prazo || '0', 'Taxa de Prazo', '%', parseFloat(ma.taxa_prazo) >= 85 ? '#10b981' : '#f59e0b')}
    ${kpiBlock(ma.tempo_medio_entrega || ma.tempo_medio || '0', 'Tempo Médio', 'min', '#3b82f6')}
  </div>

  <div class="kpi-grid-4">
    ${kpiBlock(ma.profissionais_unicos || '0', 'Profissionais', '', '#8b5cf6')}
    ${kpiBlock(mediaMotos || '0', 'Motos/Dia', '', '#8b5cf6')}
    ${kpiBlock(ma.km_medio || '0', 'KM Médio', 'km', '#06b6d4')}
    ${kpiBlock(ma.total_retornos || '0', 'Retornos', '', parseInt(ma.total_retornos) > 10 ? '#ef4444' : '#64748b')}
  </div>

  <div style="display:flex;gap:20px;margin-top:12px">
    <div style="flex:1;background:rgba(124,58,237,0.08);border-radius:12px;padding:16px;border:1px solid rgba(124,58,237,0.15)">
      <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:6px">vs. Período Anterior</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div style="font-size:13px;color:rgba(255,255,255,0.7)">Entregas ${deltaBadge(ma.total_entregas, mp.total_entregas)}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.7)">Prazo ${deltaBadge(ma.taxa_prazo, mp.taxa_prazo)}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.7)">Tempo ${deltaBadge(ma.tempo_medio_entrega || ma.tempo_medio, mp.tempo_medio_entrega || mp.tempo_medio, true)}</div>
      </div>
    </div>
    <div style="flex:1;background:rgba(16,185,129,0.08);border-radius:12px;padding:16px;border:1px solid rgba(16,185,129,0.15)">
      <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:6px">Posição no Ranking Tutts</div>
      <div style="display:flex;gap:20px">
        <div style="font-size:13px;color:rgba(255,255,255,0.7)">Prazo: <strong style="color:#10b981">Top ${ranking.percentil_prazo || '—'}%</strong></div>
        <div style="font-size:13px;color:rgba(255,255,255,0.7)">Volume: <strong style="color:#3b82f6">Top ${ranking.percentil_volume || '—'}%</strong></div>
      </div>
    </div>
  </div>

  <div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">02</div></div>
</div>

<!-- ═══════ SLIDE 3: EVOLUÇÃO SEMANAL ═══════ -->
<div class="slide">
  <div class="slide-title"><span class="section-accent"></span>Evolução Semanal</div>
  <div class="slide-subtitle">Volume de entregas e taxa de prazo por semana</div>

  <div class="chart-area" style="margin-top:16px">
    ${svgEvolucao || '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:40px">Dados insuficientes para gráfico</div>'}
    <div class="chart-legend">■ Entregas &nbsp;&nbsp; ● Taxa de Prazo (%)</div>
  </div>

  <div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">03</div></div>
</div>

<!-- ═══════ SLIDE 4: COBERTURA GEOGRÁFICA ═══════ -->
<div class="slide">
  <div class="slide-title"><span class="section-accent"></span>Cobertura Geográfica</div>
  <div class="slide-subtitle">Distribuição por faixa de distância e regiões atendidas</div>

  <div class="cols-2">
    <div class="chart-area">
      <div class="chart-title">Entregas por Faixa de Distância</div>
      ${svgFaixas || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>'}
    </div>
    <div class="chart-area">
      <div class="chart-title">Top Bairros/Regiões</div>
      ${svgBairros || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>'}
    </div>
  </div>

  <div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">04</div></div>
</div>

<!-- ═══════ SLIDE 5: PROFISSIONAIS ═══════ -->
<div class="slide">
  <div class="slide-title"><span class="section-accent"></span>Análise de Profissionais</div>
  <div class="slide-subtitle">Desempenho individual dos motoboys alocados</div>

  <div class="cols-2-wide">
    <div class="chart-area">
      <div class="chart-title">Ranking por Volume de Entregas</div>
      ${svgProfissionais || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>'}
    </div>
    <div>
      <div class="chart-area">
        <div class="chart-title">Frota Diária (Motos/Dia)</div>
        ${svgMotos || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>'}
      </div>
      <div style="margin-top:12px;background:rgba(139,92,246,0.1);border-radius:12px;padding:16px;border:1px solid rgba(139,92,246,0.2)">
        <div style="font-size:24px;font-weight:800;color:#a78bfa">${mediaMotos || 0} <span style="font-size:14px;font-weight:400;color:rgba(255,255,255,0.4)">motos/dia (média)</span></div>
      </div>
    </div>
  </div>

  <div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">05</div></div>
</div>

<!-- ═══════ SLIDE 6: JANELA OPERACIONAL ═══════ -->
<div class="slide">
  <div class="slide-title"><span class="section-accent"></span>Janela Operacional</div>
  <div class="slide-subtitle">Distribuição de entregas por faixa de horário (08h–18h)</div>

  <div class="cols-2">
    <div class="chart-area">
      <div class="chart-title">Entregas por Horário + Taxa de Prazo</div>
      ${svgHorarios || '<div style="color:rgba(255,255,255,0.3)">Sem dados</div>'}
      <div class="chart-legend">■ Entregas &nbsp;&nbsp; ● Taxa de Prazo (%)</div>
    </div>
    <div>
      <div class="chart-area">
        <div class="chart-title">Retornos por Motivo</div>
        ${svgRetornos || '<div style="color:rgba(255,255,255,0.3);padding:20px;text-align:center">Nenhum retorno no período</div>'}
      </div>
      ${parseFloat(ma.taxa_retorno || 0) > 0 ? `
      <div style="margin-top:12px;background:${parseFloat(ma.taxa_retorno) <= 2 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'};border-radius:12px;padding:16px;border:1px solid ${parseFloat(ma.taxa_retorno) <= 2 ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}">
        <div style="font-size:24px;font-weight:800;color:${parseFloat(ma.taxa_retorno) <= 2 ? '#10b981' : '#ef4444'}">${ma.taxa_retorno}% <span style="font-size:13px;font-weight:400;color:rgba(255,255,255,0.4)">taxa de retorno</span></div>
        <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px">${parseFloat(ma.taxa_retorno) <= 2 ? 'Dentro do padrão saudável (≤2%)' : parseFloat(ma.taxa_retorno) <= 5 ? 'Faixa de atenção (2-5%)' : 'Acima do limite (>5%)'}</div>
      </div>` : ''}
    </div>
  </div>

  <div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">06</div></div>
</div>

<!-- ═══════ SLIDE 7: BENCHMARK ═══════ -->
<div class="slide">
  <div class="slide-title"><span class="section-accent"></span>Comparativo com o Mercado</div>
  <div class="slide-subtitle">Posicionamento entre todos os clientes da base Tutts</div>

  <div class="cols-2">
    <div>
      <div class="kpi-grid" style="grid-template-columns:1fr 1fr;gap:16px">
        <div class="kpi-block">
          <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:8px">TAXA DE PRAZO</div>
          ${gaugeSVG(parseFloat(ma.taxa_prazo) || 0, 100, 'Este cliente', parseFloat(ma.taxa_prazo) >= 85 ? '#10b981' : '#f59e0b')}
        </div>
        <div class="kpi-block">
          <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:8px">MÉDIA TUTTS</div>
          ${gaugeSVG(parseFloat(benchGeral.media_taxa_prazo) || 0, 100, 'Base completa', '#64748b')}
        </div>
      </div>

      <div style="margin-top:16px">
        <div class="comp-row">
          <div class="comp-label">Taxa Prazo</div>
          <div class="comp-bars">
            <div class="comp-bar" style="width:${Math.min(parseFloat(ma.taxa_prazo) || 0, 100)}%;background:#7c3aed;color:white">${ma.taxa_prazo}%</div>
            <div class="comp-bar" style="width:${Math.min(parseFloat(benchGeral.media_taxa_prazo) || 0, 100)}%;background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.6)">${benchGeral.media_taxa_prazo || 0}%</div>
          </div>
          <div class="comp-delta">${deltaBadge(ma.taxa_prazo, benchGeral.media_taxa_prazo)}</div>
        </div>
        <div class="comp-row">
          <div class="comp-label">Tempo Médio</div>
          <div style="font-size:14px;font-weight:700;color:white">${ma.tempo_medio_entrega || ma.tempo_medio || 0} min <span style="font-weight:400;color:rgba(255,255,255,0.4)">vs ${benchGeral.media_tempo_entrega || 0} min</span></div>
          <div class="comp-delta">${deltaBadge(ma.tempo_medio_entrega || ma.tempo_medio, benchGeral.media_tempo_entrega, true)}</div>
        </div>
        <div class="comp-row">
          <div class="comp-label">KM Médio</div>
          <div style="font-size:14px;font-weight:700;color:white">${ma.km_medio || 0} km <span style="font-weight:400;color:rgba(255,255,255,0.4)">vs ${benchGeral.media_km || 0} km</span></div>
          <div></div>
        </div>
      </div>
    </div>
    <div>
      <div class="kpi-block" style="margin-bottom:16px">
        <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:12px;text-transform:uppercase;letter-spacing:1px">Ranking Geral</div>
        <div style="font-size:48px;font-weight:900;color:#7c3aed">Top ${ranking.percentil_prazo || '—'}%</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.5)">em Taxa de Prazo entre ${benchGeral.total_clientes || '—'} clientes</div>
        <div style="margin-top:16px;font-size:36px;font-weight:800;color:#3b82f6">Top ${ranking.percentil_volume || '—'}%</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.5)">em Volume de Entregas</div>
      </div>
    </div>
  </div>

  <div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">07</div></div>
</div>

<!-- ═══════ SLIDE 8: ENCERRAMENTO ═══════ -->
<div class="slide">
  <div class="cover-content">
    <div style="text-align:center;width:100%">
      <div style="font-size:14px;font-weight:700;color:#7c3aed;letter-spacing:3px;text-transform:uppercase;margin-bottom:32px">CENTRAL TUTTS</div>
      <div style="font-size:52px;font-weight:900;color:white;margin-bottom:16px">Obrigado</div>
      <div style="font-size:18px;color:rgba(255,255,255,0.4);max-width:600px;margin:0 auto;line-height:1.6">
        Estamos à disposição para apresentar e detalhar este relatório diretamente.
      </div>
      <div style="margin-top:48px;display:flex;justify-content:center;gap:40px">
        <div>
          <div style="font-size:40px;font-weight:900;color:${hsColor}">${healthScore}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4)">Health Score</div>
        </div>
        <div style="width:1px;background:rgba(255,255,255,0.1)"></div>
        <div>
          <div style="font-size:40px;font-weight:900;color:#7c3aed">${parseInt(ma.total_entregas || 0).toLocaleString('pt-BR')}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4)">Entregas</div>
        </div>
        <div style="width:1px;background:rgba(255,255,255,0.1)"></div>
        <div>
          <div style="font-size:40px;font-weight:900;color:#10b981">${ma.taxa_prazo || 0}%</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4)">Taxa de Prazo</div>
        </div>
      </div>
      <div style="margin-top:40px;font-size:13px;color:rgba(255,255,255,0.25)">
        ${nomeCliente} · ${dtInicio} a ${dtFim}
      </div>
    </div>
  </div>
  <div class="brand-bar"><div class="brand-name">Central Tutts</div><div class="brand-page">08</div></div>
</div>

</body>
</html>`;

      // 6. Gerar PDF com Playwright
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

      // 7. Enviar PDF
      const filename = `RaioX_${nomeCliente.replace(/[^a-zA-Z0-9]/g, '_')}_${rx.data_inicio}_${rx.data_fim}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.send(pdfBuffer);

      console.log(`📊 PDF Raio-X gerado: ${filename} (${(pdfBuffer.length / 1024).toFixed(0)}KB)`);

    } catch (error) {
      if (browser) try { await browser.close(); } catch (e) {}
      console.error('❌ Erro ao gerar PDF Raio-X:', error.message, error.stack);
      res.status(500).json({ error: `Erro ao gerar PDF: ${error.message}` });
    }
  });

  return router;
}

module.exports = { createRaioXPdfRoutes };
