/**
 * CS Sub-Router: Raio-X Versão Cliente
 *
 * Gera um relatório VOLTADO PARA O CLIENTE a partir de um raio-x interno existente.
 * - Reaproveita o metricas_snapshot do raio-x interno (evita duplicar queries)
 * - Chama Gemini com prompt novo: tom corporativo, técnico de logística, rebuscado
 * - Gemini responde em JSON estruturado (seções pré-definidas)
 * - Monta HTML visual tema claro com gráficos SVG inspirados na apresentação PDF
 * - Salva como novo registro com tipo_analise='cliente'
 * - O botão de envio por email só opera sobre registros deste tipo
 */

const express = require('express');

function createRaioXClienteRoutes(pool) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════
  // CORES — tema claro compatível com email
  // ═══════════════════════════════════════════════════════════
  const ROXO = '#7c3aed';
  const ROXO_ESC = '#5b21b6';
  const LARANJA = '#f97316';
  const VERDE = '#10b981';
  const AMARELO = '#f59e0b';
  const VERMELHO = '#ef4444';
  const TEXTO = '#1e293b';
  const TEXTO_CLARO = '#64748b';
  const GRID = '#e2e8f0';
  const FUNDO_CARD = '#f8fafc';

  // ═══════════════════════════════════════════════════════════
  // SVG HELPERS — tema claro
  // ═══════════════════════════════════════════════════════════

  /**
   * Barra horizontal — usado em faixas de km e top profissionais.
   */
  function barraHorizontalSVG(items, opts) {
    opts = opts || {};
    const width = opts.width || 560;
    const labelW = opts.labelW || 140;
    const maxItems = opts.maxItems || 8;
    const list = items.slice(0, maxItems);
    if (!list.length) return '<div style="color:#94a3b8;text-align:center;padding:20px;font-size:12px">Sem dados</div>';

    const maxVal = Math.max.apply(null, list.map((i) => i.valor || 0).concat([1]));
    const barH = 28, gap = 8, chartW = width - labelW - 20;
    const h = list.length * (barH + gap) + 10;
    let bars = '';
    list.forEach((item, idx) => {
      const y = idx * (barH + gap) + 5;
      const bw = Math.max(4, (item.valor / maxVal) * chartW * 0.60);
      const cor = item.cor || ROXO;
      bars += `<text x="${labelW - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" font-weight="500" fill="${TEXTO}" font-family="Segoe UI,sans-serif">${(item.label || '').substring(0, 24)}</text>`;
      bars += `<rect x="${labelW}" y="${y}" width="${bw}" height="${barH}" rx="4" fill="${cor}"/>`;
      bars += `<text x="${labelW + bw + 10}" y="${y + barH / 2 + 4}" font-size="11" font-weight="700" fill="${TEXTO}" font-family="Segoe UI,sans-serif">${item.display || item.valor}</text>`;
    });
    return `<svg width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
  }

  /**
   * Barra vertical com linha sobreposta — usado em evolução semanal e janela operacional.
   */
  function barraVerticalDualSVG(items, opts) {
    opts = opts || {};
    const width = opts.width || 600;
    const chartH = opts.chartH || 260;
    const valKey = opts.valKey || 'valor';
    const val2Key = opts.val2Key || null;
    const labelKey = opts.labelKey || 'label';
    if (!items.length) return '<div style="color:#94a3b8;text-align:center;padding:20px;font-size:12px">Sem dados</div>';

    const maxVal = Math.max.apply(null, items.map((i) => parseFloat(i[valKey]) || 0).concat([1]));
    // topPad generoso pra caber label da barra + badge da linha + folga
    const leftPad = 50, rightPad = 20, topPad = 44;
    const bottomY = chartH + topPad;
    const totalW = width - leftPad - rightPad;
    const barW = Math.max(14, Math.min(52, Math.floor(totalW / items.length) - 8));
    const usedW = items.length * (barW + 8);
    let svg = '';

    // Grid horizontal
    for (let g = 0; g <= 4; g++) {
      const gy = bottomY - (g / 4) * chartH;
      const gv = Math.round((g / 4) * maxVal);
      svg += `<line x1="${leftPad}" y1="${gy}" x2="${leftPad + usedW}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>`;
      svg += `<text x="${leftPad - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="${TEXTO_CLARO}" font-family="Segoe UI,sans-serif">${gv}</text>`;
    }

    // Desenha as barras + guarda posições dos topos
    const barTops = [];
    const barLabelPositions = [];  // onde cada label "233" foi desenhado
    items.forEach((item, idx) => {
      const x = leftPad + idx * (barW + 8) + 4;
      const val = parseFloat(item[valKey]) || 0;
      const bh = Math.max(3, (val / maxVal) * chartH);
      const y = bottomY - bh;
      barTops.push(y);
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="3" fill="${ROXO}"/>`;
      if (barW >= 18) {
        // Label do valor da barra fica 6px acima do topo da barra
        const barLabelY = y - 6;
        barLabelPositions.push(barLabelY);
        svg += `<text x="${x + barW / 2}" y="${barLabelY}" text-anchor="middle" font-size="10" font-weight="700" fill="${TEXTO}" font-family="Segoe UI,sans-serif">${Math.round(val)}</text>`;
      } else {
        barLabelPositions.push(y - 6);
      }
      const labelTxt = (item[labelKey] || '').toString().substring(0, 10);
      svg += `<text x="${x + barW / 2}" y="${bottomY + 14}" text-anchor="middle" font-size="${barW >= 22 ? 10 : 8}" fill="${TEXTO_CLARO}" font-family="Segoe UI,sans-serif">${labelTxt}</text>`;
    });

    // Linha sobreposta (taxa de prazo) + badges sem colisão
    if (val2Key) {
      const points = items.map((item, idx) => {
        const x = leftPad + idx * (barW + 8) + 4 + barW / 2;
        const v2 = parseFloat(item[val2Key]) || 0;
        return x + ',' + (bottomY - (v2 / 100) * chartH);
      }).join(' ');
      svg += `<polyline points="${points}" fill="none" stroke="${LARANJA}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

      const BADGE_H = 16;            // altura do badge "92%"
      const BAR_LABEL_FONT_H = 12;   // altura visual do label "233"
      const GAP = 6;                 // folga entre badge e label da barra

      items.forEach((item, idx) => {
        const x = leftPad + idx * (barW + 8) + 4 + barW / 2;
        const v2 = parseFloat(item[val2Key]) || 0;
        const ly = bottomY - (v2 / 100) * chartH;
        const barLabelY = barLabelPositions[idx];  // y do texto do label da barra

        // Posição padrão: centro do badge 14px acima da linha
        let badgeCenterY = ly - 14;
        // Colisão: se o badge iria cair em cima do label da barra, empurra pra cima
        // Label da barra ocupa de barLabelY-8 até barLabelY+4 (aprox)
        // Badge ocupa de badgeCenterY-8 até badgeCenterY+8
        const labelTop = barLabelY - BAR_LABEL_FONT_H + 2;
        if (badgeCenterY + BADGE_H / 2 + GAP > labelTop && badgeCenterY < barLabelY + GAP) {
          // Conflito: move o badge pra FICAR acima do label da barra
          badgeCenterY = labelTop - BADGE_H / 2 - GAP;
        }
        // Se ficou muito alto (saiu do SVG), joga pra baixo da linha
        if (badgeCenterY - BADGE_H / 2 < 4) {
          badgeCenterY = ly + 18;
        }

        svg += `<circle cx="${x}" cy="${ly}" r="4" fill="${LARANJA}" stroke="white" stroke-width="1.5"/>`;
        if (barW >= 16) {
          svg += `<rect x="${x - 18}" y="${badgeCenterY - BADGE_H / 2}" width="36" height="${BADGE_H}" rx="3" fill="white" stroke="${LARANJA}" stroke-width="1"/>`;
          svg += `<text x="${x}" y="${badgeCenterY + 3}" text-anchor="middle" font-size="10" font-weight="700" fill="${LARANJA}" font-family="Segoe UI,sans-serif">${v2.toFixed(0)}%</text>`;
        }
      });
    }

    const svgW = leftPad + usedW + rightPad;
    const svgH = bottomY + 30;
    return `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
  }

  /**
   * Gráfico simples de motos/dia — vertical bars.
   */
  function graficoMotosDiaSVG(dados, titulo) {
    if (!dados || !dados.length) return '';
    const leftPad = 45, rightPad = 15, bottomY = 160, topPad = 20, chartH = 130;
    const barW = Math.max(16, Math.min(44, Math.floor(580 / dados.length) - 6));
    const usedW = dados.length * (barW + 6);
    const max = Math.max.apply(null, dados.map((d) => parseInt(d.motos) || 0).concat([1]));
    let svg = '';

    for (let g = 0; g <= 4; g++) {
      const gy = bottomY - (g / 4) * chartH;
      const gv = Math.round((g / 4) * max);
      svg += `<line x1="${leftPad}" y1="${gy}" x2="${leftPad + usedW}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>`;
      svg += `<text x="${leftPad - 8}" y="${gy + 3}" text-anchor="end" font-size="9" fill="${TEXTO_CLARO}" font-family="Segoe UI,sans-serif">${gv}</text>`;
    }

    dados.forEach((d, i) => {
      const x = leftPad + i * (barW + 6) + 3;
      const motos = parseInt(d.motos) || 0;
      const bh = Math.max(2, (motos / max) * chartH);
      const y = bottomY - bh;
      const dia = new Date(d.dia);
      const label = String(dia.getUTCDate()).padStart(2, '0') + '/' + String(dia.getUTCMonth() + 1).padStart(2, '0');
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="3" fill="${ROXO}"/>`;
      if (barW >= 18) {
        svg += `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="10" font-weight="700" fill="${TEXTO}" font-family="Segoe UI,sans-serif">${motos}</text>`;
      }
      svg += `<text x="${x + barW / 2}" y="${bottomY + 14}" text-anchor="middle" font-size="${barW >= 22 ? 9 : 7}" fill="${TEXTO_CLARO}" font-family="Segoe UI,sans-serif">${label}</text>`;
    });

    const svgW = leftPad + usedW + rightPad;
    const svgH = bottomY + 28;
    return `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
  }

  /**
   * Particiona o gráfico de motos/dia — se tiver mais de 16 dias, quebra em dois períodos.
   * Retorna HTML com os SVGs + labels de período.
   */
  function gerarBlocoMotosDia(dados) {
    if (!dados || !dados.length) {
      return '<div style="color:#94a3b8;text-align:center;padding:20px;font-size:12px">Sem dados de motos por dia</div>';
    }
    const LIMITE = 16;
    if (dados.length <= LIMITE) {
      return `<div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;margin-top:10px;overflow-x:auto">` +
        graficoMotosDiaSVG(dados, 'Motos por dia') +
        `</div>`;
    }
    // Quebra em duas metades equilibradas
    const meio = Math.ceil(dados.length / 2);
    const parte1 = dados.slice(0, meio);
    const parte2 = dados.slice(meio);
    const fmt = (d) => {
      const dt = new Date(d);
      return String(dt.getUTCDate()).padStart(2, '0') + '/' + String(dt.getUTCMonth() + 1).padStart(2, '0');
    };
    return `
<div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;margin-top:10px;overflow-x:auto">
  <div style="font-size:11px;color:${TEXTO_CLARO};margin-bottom:6px;font-weight:600">Período ${fmt(parte1[0].dia)} a ${fmt(parte1[parte1.length - 1].dia)}</div>
  ${graficoMotosDiaSVG(parte1, '')}
</div>
<div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;margin-top:10px;overflow-x:auto">
  <div style="font-size:11px;color:${TEXTO_CLARO};margin-bottom:6px;font-weight:600">Período ${fmt(parte2[0].dia)} a ${fmt(parte2[parte2.length - 1].dia)}</div>
  ${graficoMotosDiaSVG(parte2, '')}
</div>`;
  }

  // ═══════════════════════════════════════════════════════════
  // SCREENSHOT DO MAPA DE CALOR via Playwright
  // ═══════════════════════════════════════════════════════════

  /**
   * Captura um screenshot JPEG do link do mapa de calor usando Playwright headless.
   * Retorna data URI (data:image/jpeg;base64,...) ou null em caso de falha.
   * Usa as mesmas configurações do PDF gerador (funciona no Railway com Chromium já instalado).
   */
  async function capturarScreenshotMapa(linkMapa) {
    if (!linkMapa) return null;
    let browser = null;
    try {
      const chromium = require('playwright').chromium;
      browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security']
      });
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(linkMapa, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Aguarda tiles do Google Maps carregarem
      for (let mw = 0; mw < 15; mw++) {
        await page.waitForTimeout(1000);
        const ready = await page.evaluate(() => {
          const mapDiv = document.getElementById('map');
          if (!mapDiv) return false;
          const tiles = mapDiv.querySelectorAll('img, canvas');
          return tiles.length > 5;
        }).catch(() => false);
        if (ready) break;
      }
      // Folga extra pra renderizar layer de heatmap
      await page.waitForTimeout(2000);

      const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
      await browser.close();
      browser = null;
      console.log(`🗺️ [RaioX Cliente] Screenshot mapa capturado (${(buf.length / 1024).toFixed(0)}KB)`);
      return 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (error) {
      console.warn('⚠️ [RaioX Cliente] Falha ao capturar mapa:', error.message);
      if (browser) try { await browser.close(); } catch (e) {}
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HTML BUILDER — monta o relatório completo
  // ═══════════════════════════════════════════════════════════

  function kpiBoxHTML(valor, label, unidade, cor) {
    cor = cor || ROXO;
    return `<td align="center" style="background:#ffffff;border:1px solid ${GRID};border-radius:10px;padding:14px 8px;width:33%">
      <div style="font-size:26px;font-weight:800;color:${cor};line-height:1;font-family:'Segoe UI',sans-serif">${valor}${unidade ? `<span style="font-size:13px;font-weight:500;color:${TEXTO_CLARO};margin-left:2px">${unidade}</span>` : ''}</div>
      <div style="font-size:9px;color:${TEXTO_CLARO};margin-top:6px;text-transform:uppercase;letter-spacing:1px;font-weight:600">${label}</div>
    </td>`;
  }

  function seccaoHTML(titulo, subtitulo, corpoHTML) {
    return `
<tr><td style="padding:24px 36px 8px">
  <div style="border-left:4px solid ${ROXO};padding-left:12px;margin-bottom:4px">
    <div style="font-size:20px;font-weight:800;color:${TEXTO};font-family:'Segoe UI',sans-serif">${titulo}</div>
    <div style="font-size:12px;color:${TEXTO_CLARO};margin-top:2px">${subtitulo}</div>
  </div>
</td></tr>
<tr><td style="padding:4px 36px 20px">
  ${corpoHTML}
</td></tr>`;
  }

  function paragrafoHTML(texto) {
    if (!texto) return '';
    // Converte **negrito** inline, mas sem processar markdown completo
    const escaped = String(texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${TEXTO}">$1</strong>`)
      .replace(/\n\n/g, '</p><p style="margin:12px 0;font-size:13.5px;line-height:1.7;color:#334155;text-align:justify">')
      .replace(/\n/g, '<br/>');
    return `<p style="margin:12px 0;font-size:13.5px;line-height:1.7;color:#334155;text-align:justify">${escaped}</p>`;
  }

  function deltaHTML(atual, anterior, inv) {
    const a = parseFloat(atual) || 0, b = parseFloat(anterior) || 0;
    if (b === 0) return '<span style="color:' + TEXTO_CLARO + '">—</span>';
    const diff = ((a - b) / b * 100);
    const up = diff >= 0;
    const bom = inv ? !up : up;
    const cor = bom ? VERDE : VERMELHO;
    const seta = up ? '↑' : '↓';
    return `<span style="color:${cor};font-weight:700">${seta} ${Math.abs(diff).toFixed(1)}%</span>`;
  }

  function fmtNum(n) {
    try { return parseInt(n).toLocaleString('pt-BR'); } catch (e) { return String(n || '0'); }
  }
  function fmtData(d) {
    if (!d) return '';
    try {
      const dt = new Date(d);
      return String(dt.getUTCDate()).padStart(2, '0') + '/' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '/' + dt.getUTCFullYear();
    } catch (e) { return String(d); }
  }

  function montarHTMLRelatorio(dados, textos, nomeCliente, periodo, healthScore, mapaScreenshotDataURI) {
    const ma = dados.metricas_atuais || {};
    const mp = dados.metricas_periodo_anterior || {};
    const faixasKm = dados.faixas_km || [];
    const evolucao = dados.evolucao_semanal || [];
    const motosDia = dados.motos_por_dia || [];
    const profissionais = dados.corridas_por_motoboy || [];
    const horarios = dados.padroes_horario || [];
    const retornos = dados.retornos_detalhados || [];
    const mediaMotos = dados.media_motos_dia || 0;

    const scoreCor = healthScore >= 80 ? VERDE : healthScore >= 60 ? AMARELO : VERMELHO;
    const scoreLabel = healthScore >= 80 ? 'Excelente' : healthScore >= 60 ? 'Bom' : 'Atenção';

    // ─── Evolução ───
    const evolItems = evolucao.map((s) => {
      const d = new Date(s.semana);
      const ent = parseInt(s.entregas) || 0;
      const np = parseInt(s.no_prazo) || 0;
      const tp = s.taxa_prazo ? parseFloat(s.taxa_prazo) : (ent > 0 ? Math.round((np / ent) * 1000) / 10 : 0);
      return { label: String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0'), valor: ent, taxa_prazo: tp };
    });
    const svgEvol = evolItems.length > 0 ? barraVerticalDualSVG(evolItems, { width: 600, chartH: 260, val2Key: 'taxa_prazo' }) : '';

    // ─── Cobertura ───
    const totalFaixas = faixasKm.reduce((s, f) => s + (parseInt(f.quantidade) || 0), 0);
    const faixasItems = faixasKm.slice(0, 8).map((f) => {
      const qtd = parseInt(f.quantidade) || 0;
      const pctTotal = totalFaixas > 0 ? ((qtd / totalFaixas) * 100).toFixed(0) : '0';
      const tp = parseFloat(f.taxa_prazo_faixa) || 0;
      return {
        label: f.faixa, valor: qtd,
        display: `${qtd} ent · ${tp}% No Prazo · ${pctTotal}% total`,
        cor: tp >= 90 ? VERDE : tp >= 75 ? AMARELO : VERMELHO,
      };
    });
    const svgFaixas = barraHorizontalSVG(faixasItems, { width: 580, labelW: 100 });

    // ─── Profissionais ───
    const profItems = profissionais.slice(0, 6).map((p) => {
      const tp = parseFloat(p.taxa_prazo) || 0;
      return {
        label: (p.nome_prof || '').split(' ').slice(0, 2).join(' '),
        valor: parseInt(p.total_entregas) || 0,
        display: `${p.total_entregas} ent · ${tp}% No Prazo`,
        cor: tp >= 90 ? VERDE : tp >= 75 ? AMARELO : VERMELHO,
      };
    });
    const svgProf = barraHorizontalSVG(profItems, { width: 580, labelW: 130 });

    // ─── Horários ───
    const horItems = horarios.slice(0, 8).map((h) => ({
      label: h.faixa_horaria,
      valor: parseInt(h.entregas) || 0,
      taxa_prazo: parseFloat(h.taxa_prazo) || 0,
    }));
    const svgHor = horItems.length > 0 ? barraVerticalDualSVG(horItems, { width: 600, chartH: 220, val2Key: 'taxa_prazo' }) : '';

    // ─── Retornos ───
    const retItems = retornos.filter((r) => {
      const oc = (r.ocorrencia || '').toLowerCase();
      return oc !== 'entregue' && !oc.startsWith('entreg') && !oc.startsWith('coletad');
    }).slice(0, 5).map((r) => ({
      label: (r.ocorrencia || '').substring(0, 24),
      valor: parseInt(r.quantidade) || 0,
      display: `${r.quantidade} (${r.percentual || 0}%)`,
      cor: VERMELHO,
    }));
    const svgRet = retItems.length > 0 ? barraHorizontalSVG(retItems, { width: 580, labelW: 160 }) : '<div style="color:' + TEXTO_CLARO + ';text-align:center;padding:20px;font-size:12px">Nenhum retorno no período</div>';

    // ─── Motos/dia (particionado) ───
    const blocoMotosDia = gerarBlocoMotosDia(motosDia);

    // ─── HTML FINAL ───
    const dtInicio = fmtData(periodo.inicio);
    const dtFim = fmtData(periodo.fim);
    const taxaRet = parseFloat(ma.taxa_retorno || 0);

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Roboto,Arial,sans-serif;color:${TEXTO}">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0">
<tr><td align="center">
<table width="720" cellpadding="0" cellspacing="0" style="background:white;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:720px">

<!-- Header com gradiente Tutts -->
<tr><td style="background:linear-gradient(135deg,${ROXO_ESC},${ROXO} 60%,${LARANJA});padding:36px 40px 32px;text-align:center">
  <div style="font-size:11px;letter-spacing:3px;color:rgba(255,255,255,0.75);text-transform:uppercase;font-weight:700;margin-bottom:6px">Relatório Operacional</div>
  <h1 style="color:white;font-size:28px;margin:0;font-weight:800;letter-spacing:-0.5px">${nomeCliente}</h1>
  <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:10px">Período analisado: ${dtInicio} a ${dtFim}</div>
</td></tr>

<!-- Abertura (IA) -->
<tr><td style="padding:28px 36px 8px">
  ${paragrafoHTML(textos.abertura)}
</td></tr>

<!-- ═══ Seção 1: Visão Geral ═══ -->
${seccaoHTML('Visão Geral da Operação', 'Indicadores-chave do período',
  `<table width="100%" cellpadding="0" cellspacing="8" style="border-collapse:separate">
    <tr>
      ${kpiBoxHTML(fmtNum(ma.total_entregas || 0), 'Total de Entregas', '', ROXO)}
      ${kpiBoxHTML(ma.taxa_prazo || '0', 'Taxa de Prazo', '%', parseFloat(ma.taxa_prazo) >= 85 ? VERDE : AMARELO)}
      ${kpiBoxHTML(ma.tempo_medio_entrega || ma.tempo_medio || '0', 'Tempo Médio', 'min', ROXO)}
    </tr>
    <tr>
      ${kpiBoxHTML(ma.profissionais_unicos || '0', 'Profissionais', '', ROXO)}
      ${kpiBoxHTML(mediaMotos || '0', 'Motos/Dia', '', LARANJA)}
      ${kpiBoxHTML(ma.km_medio || '0', 'KM Médio', 'km', ROXO)}
    </tr>
  </table>
  <div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:8px;padding:10px 14px;margin-top:12px;font-size:11px;color:${TEXTO_CLARO}">
    <strong style="color:${TEXTO}">vs. Período Anterior:</strong>
    &nbsp; Entregas ${deltaHTML(ma.total_entregas, mp.total_entregas)}
    &nbsp;&nbsp; Prazo ${deltaHTML(ma.taxa_prazo, mp.taxa_prazo)}
    &nbsp;&nbsp; Tempo ${deltaHTML(ma.tempo_medio_entrega || ma.tempo_medio, mp.tempo_medio_entrega || mp.tempo_medio, true)}
  </div>
  ${paragrafoHTML(textos.visao_geral)}`
)}

<!-- ═══ Seção 2: Evolução Semanal ═══ -->
${seccaoHTML('Evolução Semanal', 'Volume de entregas e taxa de prazo por semana',
  `<div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;overflow-x:auto">
    ${svgEvol}
    <div style="font-size:10px;color:${TEXTO_CLARO};margin-top:6px;text-align:center">Barras = Entregas &nbsp;·&nbsp; Linha laranja = Taxa de Prazo (%)</div>
  </div>
  ${paragrafoHTML(textos.evolucao)}`
)}

<!-- ═══ Seção 3: Cobertura Geográfica ═══ -->
${seccaoHTML('Cobertura Geográfica', 'Distribuição das entregas por faixa de distância',
  `<div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;overflow-x:auto">
    ${svgFaixas}
    <div style="font-size:10px;color:${TEXTO_CLARO};margin-top:8px;text-align:center">Cor = % No Prazo (verde ≥ 90% · amarelo ≥ 75% · vermelho &lt; 75%)</div>
  </div>
  ${paragrafoHTML(textos.cobertura)}
  ${mapaScreenshotDataURI ? `
  <div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;margin-top:14px">
    <div style="font-size:11px;font-weight:700;color:${TEXTO};margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px">Mapa de Calor — Distribuição Geográfica</div>
    <div style="border-radius:8px;overflow:hidden;border:1px solid ${GRID}">
      <img src="${mapaScreenshotDataURI}" alt="Mapa de Calor" style="display:block;width:100%;height:auto;max-width:100%" />
    </div>
    ${dados.link_mapa_calor ? `
    <div style="margin-top:12px;text-align:center">
      <a href="${dados.link_mapa_calor}" style="display:inline-block;background:linear-gradient(135deg,${ROXO},${ROXO_ESC});color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:0.3px;border:2px solid ${ROXO};box-shadow:0 2px 8px rgba(124,58,237,0.25)">
        🗺️ Abrir Mapa de Calor Interativo →
      </a>
    </div>` : ''}
  </div>` : (dados.link_mapa_calor ? `
  <div style="background:${FUNDO_CARD};border:1px dashed ${GRID};border-radius:10px;padding:18px;margin-top:14px;text-align:center">
    <div style="font-size:12px;color:${TEXTO_CLARO};margin-bottom:10px">Visualização geográfica interativa disponível</div>
    <a href="${dados.link_mapa_calor}" style="display:inline-block;background:linear-gradient(135deg,${ROXO},${ROXO_ESC});color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:0.3px">
      🗺️ Abrir Mapa de Calor Interativo →
    </a>
  </div>` : '')}`
)}

<!-- ═══ Seção 4: Profissionais e Frota ═══ -->
${seccaoHTML('Profissionais e Frota', 'Desempenho dos profissionais e cobertura diária',
  `<div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;overflow-x:auto">
    <div style="font-size:11px;font-weight:700;color:${TEXTO};margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Top Profissionais</div>
    ${svgProf}
  </div>
  ${blocoMotosDia}
  ${paragrafoHTML(textos.profissionais)}`
)}

<!-- ═══ Seção 5: Janela Operacional ═══ -->
${seccaoHTML('Janela Operacional', 'Distribuição por horário e análise de retornos',
  `<div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;overflow-x:auto;margin-bottom:10px">
    <div style="font-size:11px;font-weight:700;color:${TEXTO};margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Entregas por Horário + Prazo</div>
    ${svgHor}
  </div>
  <div style="background:${FUNDO_CARD};border:1px solid ${GRID};border-radius:10px;padding:14px;overflow-x:auto">
    <div style="font-size:11px;font-weight:700;color:${TEXTO};margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Retornos por Motivo</div>
    ${svgRet}
    ${taxaRet > 0 ? `<div style="margin-top:10px;padding:10px 14px;background:${taxaRet <= 2 ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)'};border-left:3px solid ${taxaRet <= 2 ? VERDE : VERMELHO};border-radius:6px">
      <span style="font-size:17px;font-weight:800;color:${taxaRet <= 2 ? VERDE : VERMELHO}">${ma.taxa_retorno}%</span>
      <span style="font-size:11px;color:${TEXTO_CLARO};margin-left:6px">taxa de retorno — ${taxaRet <= 2 ? 'dentro do padrão saudável (≤2%)' : taxaRet <= 5 ? 'atenção (2-5%)' : 'acima do limite (>5%)'}</span>
    </div>` : ''}
  </div>
  ${paragrafoHTML(textos.janela)}`
)}

<!-- Fechamento -->
<tr><td style="padding:16px 36px 32px">
  <div style="border-top:1px solid ${GRID};padding-top:20px">
    ${paragrafoHTML(textos.fechamento)}
  </div>
</td></tr>

<!-- Footer Tutts -->
<tr><td style="background:${FUNDO_CARD};padding:24px 36px;border-top:1px solid ${GRID};text-align:center">
  <div style="font-size:11px;font-weight:700;color:${ROXO};letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Central Tutts</div>
  <div style="font-size:10px;color:${TEXTO_CLARO}">Logística Inteligente para Autopeças</div>
  <div style="font-size:10px;color:${TEXTO_CLARO};margin-top:8px">© ${new Date().getFullYear()} Tutts Entregas Rápidas · Este relatório é confidencial e destina-se exclusivamente a ${nomeCliente}</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
  }

  // ═══════════════════════════════════════════════════════════
  // GEMINI CALLER — gera os textos em JSON estruturado
  // ═══════════════════════════════════════════════════════════

  async function gerarTextosIA(dados, nomeCliente, periodo) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurada');

    const ma = dados.metricas_atuais || {};
    const mp = dados.metricas_periodo_anterior || {};

    // Enxugamos os dados passados pro modelo pra economizar tokens
    const payload = {
      cliente: nomeCliente,
      periodo_inicio: periodo.inicio,
      periodo_fim: periodo.fim,
      metricas_atuais: ma,
      metricas_periodo_anterior: mp,
      faixas_km: (dados.faixas_km || []).slice(0, 8),
      evolucao_semanal: dados.evolucao_semanal || [],
      top_profissionais: (dados.corridas_por_motoboy || []).slice(0, 6),
      padroes_horario: dados.padroes_horario || [],
      retornos_detalhados: (dados.retornos_detalhados || []).slice(0, 5),
      motos_por_dia_resumo: {
        total_dias: (dados.motos_por_dia || []).length,
        media_motos_dia: dados.media_motos_dia || 0,
      },
      taxa_retorno: ma.taxa_retorno || 0,
    };

    const prompt = `Você é o Gerente de Sucesso do Cliente da **Tutts Entregas Rápidas**, empresa especializada em logística last-mile para o setor de autopeças. Sua missão é redigir um RELATÓRIO OPERACIONAL executivo para o cliente **${nomeCliente}**, em formato de corpo de email corporativo.

═══════════════════════════════════
TOM, ESTILO E VOCABULÁRIO (REGRAS ABSOLUTAS)
═══════════════════════════════════
✅ Tom: corporativo, maduro, analítico. Parceiro técnico sênior, não vendedor.
✅ Use vocabulário **técnico-operacional de logística**: lead time, SLA (Service Level Agreement), on-time delivery, ciclo operacional, janela de entrega, capilaridade da malha, roteirização, throughput, densidade operacional, tempo de atravessamento, taxa de ocupação da frota, indicadores de desempenho (KPIs), aderência a prazo, mix de faixas quilométricas, produtividade do binômio profissional-frota.
✅ Use também palavras **rebuscadas e formais**: outrossim, destarte, mormente, por conseguinte, via de regra, ademais, sobremaneira, efetivamente, consubstanciar, depreende-se, observa-se, verifica-se, denota-se, cumpre-nos, reafirmamos, reiteramos.
✅ Redação em português brasileiro formal, fluida, com períodos bem construídos. Evite frases curtas e bullet points. Prefira parágrafos densos e coesos.
✅ Destaque números-chave usando **negrito** (dois asteriscos).
✅ Escreva da perspectiva da Tutts se dirigindo ao cliente: "apresentamos a V. Sas.", "nossa equipe operacional realizou", "reafirmamos nosso compromisso".

⛔ NUNCA use emojis.
⛔ NUNCA use títulos, headers ou markdown além de **negrito** pontual.
⛔ NUNCA mencione valores financeiros, custos, faturamento ou preços.
⛔ NUNCA sugira mudanças nos processos internos do cliente.
⛔ NUNCA cite nomes de profissionais, motoboys ou entregadores específicos — refira-se sempre coletivamente ("nossa equipe", "o pool de profissionais", "o time alocado", "nosso corpo operacional").
⛔ NUNCA destaque o profissional que fez mais entregas, não faça ranking individual, não cite quantidades por pessoa.
⛔ NUNCA mencione "health score", "score de saúde", "nota da operação" ou qualquer pontuação agregada — essa é métrica interna e não faz parte do relatório cliente.
⛔ NUNCA sugira aumentar frequência de contato ou reuniões.
⛔ NUNCA faça promessas com prazo (não diga "em duas semanas", "até o mês que vem").

═══════════════════════════════════
FORMATO DE RESPOSTA (CRÍTICO)
═══════════════════════════════════
Responda EXCLUSIVAMENTE com um objeto JSON válido, sem blocos de código markdown (sem \`\`\`), sem comentários, sem texto antes ou depois. O JSON DEVE ter EXATAMENTE estas chaves, todas obrigatórias:

{
  "abertura": "Parágrafo único de abertura (2 a 3 linhas). Saudação formal dirigida ao cliente, apresentação do propósito do relatório e introdução do período analisado. Ex: 'Prezados, cumpre-nos apresentar o relatório operacional consolidado referente ao período de X a Y...'",
  "visao_geral": "APENAS UM parágrafo denso (4 a 6 linhas), analisando os KPIs totais (volume de entregas, taxa de prazo, tempo médio, profissionais únicos, motos/dia, km médio, km percorrido). Cite comparativos com o período anterior quando os dados permitirem. Use linguagem técnica de SLA e aderência. NÃO é permitido segundo parágrafo.",
  "evolucao": "2 parágrafos sobre a evolução temporal (semana a semana). Destaque picos, vales, estabilidade ou volatilidade do volume e da aderência ao prazo. Interprete a tendência, não apenas descreva.",
  "cobertura": "APENAS UM parágrafo denso (4 a 6 linhas) sobre cobertura geográfica — distribuição por faixa de distância. Identifique onde se concentra o volume (curta/média/longa distância), comente o desempenho de prazo em cada faixa e o que isso revela sobre o perfil operacional da rota. NÃO é permitido segundo parágrafo.",
  "profissionais": "APENAS UM parágrafo denso (4 a 6 linhas) sobre a força de trabalho coletiva. Analise a densidade operacional (média de motos/dia, profissionais únicos) e a uniformidade do efetivo ao longo dos dias do período. NÃO cite nomes. NÃO destaque quem fez mais entregas. NÃO mencione health score nem qualquer pontuação. NÃO é permitido segundo parágrafo.",
  "janela": "2 parágrafos sobre a janela operacional (comportamento por horário) e o perfil de retornos (motivos e taxa). Contextualize a taxa de retorno (≤2% é saudável para autopeças). NÃO alarme o cliente se estiver na faixa saudável.",
  "fechamento": "Parágrafo de fechamento (3 a 4 linhas). Reitere compromisso com a qualidade, coloque a equipe à disposição para esclarecimentos, e encerre com saudação formal. Ex: 'Reafirmamos nosso compromisso com a excelência operacional... Permanecemos à inteira disposição de V. Sas. Cordialmente, Equipe Tutts.'"
}

═══════════════════════════════════
DADOS DA OPERAÇÃO
═══════════════════════════════════
${JSON.stringify(payload, null, 2)}

Lembre-se: APENAS o JSON, nada mais.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.65,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            // Schema forçado — Gemini 2.0 garante estrutura exata, elimina JSON quebrado
            responseSchema: {
              type: 'object',
              properties: {
                abertura:      { type: 'string' },
                visao_geral:   { type: 'string' },
                evolucao:      { type: 'string' },
                cobertura:     { type: 'string' },
                profissionais: { type: 'string' },
                janela:        { type: 'string' },
                fechamento:    { type: 'string' },
              },
              required: ['abertura', 'visao_geral', 'evolucao', 'cobertura', 'profissionais', 'janela', 'fechamento'],
            },
          },
        }),
      }
    );

    const data = await response.json();
    if (data.error) {
      console.error('❌ Gemini (cliente):', data.error);
      throw new Error('Gemini: ' + data.error.message);
    }

    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokens = data.usageMetadata?.candidatesTokenCount || 0;

    // Parser robusto — tenta múltiplas estratégias em caso de JSON sujo
    const parsed = parseIAResponse(texto);
    if (!parsed) {
      console.error('❌ JSON inválido do Gemini — texto completo:\n', texto);
      throw new Error('Resposta da IA não é JSON válido após múltiplas tentativas de parse');
    }

    // Validação: garante que todas as chaves existem (preenche com string vazia se faltar)
    const chavesObrig = ['abertura', 'visao_geral', 'evolucao', 'cobertura', 'profissionais', 'janela', 'fechamento'];
    for (const k of chavesObrig) {
      if (!parsed[k]) parsed[k] = '';
    }

    return { textos: parsed, tokens };
  }

  /**
   * Parser tolerante pra resposta do Gemini — tenta 4 estratégias em sequência:
   * 1. JSON.parse direto
   * 2. Remove markdown fences (```json ... ```)
   * 3. Extrai o primeiro objeto { ... } do texto via regex
   * 4. Tenta corrigir aspas internas não-escapadas (fallback final)
   */
  function parseIAResponse(texto) {
    if (!texto || typeof texto !== 'string') return null;

    // Estratégia 1: parse direto
    try {
      return JSON.parse(texto);
    } catch (e) { /* continua */ }

    // Estratégia 2: remover markdown fences
    try {
      let limpo = texto.trim();
      if (limpo.startsWith('```')) {
        limpo = limpo.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      }
      return JSON.parse(limpo);
    } catch (e) { /* continua */ }

    // Estratégia 3: extrair primeiro objeto JSON do texto
    try {
      const match = texto.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (e) { /* continua */ }

    // Estratégia 4: tentar reparar aspas internas não-escapadas em valores string
    // Exemplo problemático: "texto": "frase com "aspas" dentro" → vira "texto": "frase com \"aspas\" dentro"
    try {
      const match = texto.match(/\{[\s\S]*\}/);
      if (match) {
        let raw = match[0];
        // Dentro de cada valor "chave": "valor", escapa aspas duplas internas que não estejam no final
        // Heurística: aspas duplas entre ": " e ("," ou "}") no final da linha
        raw = raw.replace(
          /"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*(?:"(?:[^"\\]|\\.)*)*)"\s*([,}])/g,
          (full, chave, valor, fim) => {
            // Escapa aspas internas que não estejam já escapadas
            const escaped = valor.replace(/(?<!\\)"/g, '\\"');
            return `"${chave}": "${escaped}"${fim}`;
          }
        );
        return JSON.parse(raw);
      }
    } catch (e) { /* desiste */ }

    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // ROTA: POST /cs/raio-x/cliente
  // ═══════════════════════════════════════════════════════════

  router.post('/cs/raio-x/cliente', async (req, res) => {
    try {
      const { raio_x_id } = req.body;
      if (!raio_x_id) {
        return res.status(400).json({ error: 'raio_x_id é obrigatório (ID do raio-x interno que será a base do relatório)' });
      }

      // 1. Carrega o raio-x interno
      const rxResult = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [parseInt(raio_x_id)]);
      if (rxResult.rows.length === 0) {
        return res.status(404).json({ error: 'Raio-X não encontrado' });
      }
      const rx = rxResult.rows[0];
      if (rx.tipo_analise === 'cliente') {
        return res.status(400).json({ error: 'Este registro já é um relatório cliente. Selecione um raio-x interno.' });
      }

      // 2. Extrai dados do snapshot
      let dados = {};
      try {
        dados = typeof rx.metricas_snapshot === 'string' ? JSON.parse(rx.metricas_snapshot) : (rx.metricas_snapshot || {});
      } catch (e) {
        return res.status(400).json({ error: 'Snapshot de métricas do raio-x original está corrompido' });
      }

      if (!dados.metricas_atuais) {
        return res.status(400).json({ error: 'Raio-X original sem dados de métricas — regenere o raio-x interno primeiro' });
      }

      const nomeCliente = rx.nome_cliente || dados.cliente?.nome || 'Cliente';
      const periodo = { inicio: rx.data_inicio, fim: rx.data_fim };
      const healthScore = rx.score_saude || dados.cliente?.health_score || 0;

      console.log(`👔 Gerando Raio-X Cliente: raio_x_id=${raio_x_id}, cliente=${nomeCliente}`);

      // 3a. Captura screenshot do mapa de calor em paralelo com o Gemini (ganha tempo)
      const [resIA, mapaURI] = await Promise.all([
        gerarTextosIA(dados, nomeCliente, periodo),
        capturarScreenshotMapa(dados.link_mapa_calor),
      ]);
      const { textos, tokens } = resIA;

      // 4. Monta HTML (com ou sem mapa, se falhou fica só o botão)
      const htmlRelatorio = montarHTMLRelatorio(dados, textos, nomeCliente, periodo, healthScore, mapaURI);

      // 5. Salva no histórico com tipo_analise='cliente'
      const saveResult = await pool.query(
        `INSERT INTO cs_raio_x_historico (
          cod_cliente, nome_cliente, data_inicio, data_fim,
          metricas_snapshot, benchmark_snapshot, analise_texto,
          tipo_analise, score_saude, alertas, recomendacoes,
          gerado_por, gerado_por_nome, tokens_utilizados
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id`,
        [
          rx.cod_cliente, rx.nome_cliente, rx.data_inicio, rx.data_fim,
          rx.metricas_snapshot, rx.benchmark_snapshot || JSON.stringify({}), htmlRelatorio,
          'cliente', healthScore, JSON.stringify([]), JSON.stringify([]),
          req.user?.codProfissional || null, req.user?.nome || null, tokens,
        ]
      );

      console.log(`✅ Raio-X Cliente gerado: id=${saveResult.rows[0].id}, tokens=${tokens}`);

      res.json({
        success: true,
        raio_x_cliente: {
          id: saveResult.rows[0].id,
          html: htmlRelatorio,
          health_score: healthScore,
          tokens,
          gerado_em: new Date().toISOString(),
          raio_x_interno_id: parseInt(raio_x_id),
        },
      });
    } catch (error) {
      console.error('❌ Erro ao gerar Raio-X Cliente:', error.message, error.stack);
      res.status(500).json({ error: 'Erro ao gerar relatório cliente: ' + error.message });
    }
  });

  return router;
}

module.exports = { createRaioXClienteRoutes };
