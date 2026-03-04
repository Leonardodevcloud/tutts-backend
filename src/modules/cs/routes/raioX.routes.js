/**
 * CS Sub-Router: Raio-X IA
 * Relatório operacional profissional via Gemini
 * Focado em apresentação ao cliente final — sem dados financeiros
 */
const express = require('express');
const { calcularHealthScore, getClienteConfig } = require('../cs.service');
const { enviarRaioXEmail } = require('../cs.email');

function createRaioXRoutes(pool) {
  const router = express.Router();

  // ══════════════════════════════════════════════════
  // Gerador de gráficos SVG inline para o relatório
  // ══════════════════════════════════════════════════

  function gerarBarraSVG(dados, { titulo = '', width = 560, barHeight = 24, cor = '#6366f1', showPercent = false, maxVal = null } = {}) {
    if (!dados || dados.length === 0) return '';
    const max = maxVal || Math.max(...dados.map(d => d.valor), 1);
    const gap = 6;
    const labelW = 120;
    const valueW = 60;
    const chartW = width - labelW - valueW - 20;
    const h = dados.length * (barHeight + gap) + 10;

    let bars = '';
    dados.forEach((d, i) => {
      const y = i * (barHeight + gap) + 5;
      const w = Math.max(2, (d.valor / max) * chartW);
      const label = (d.label || '').substring(0, 18);
      const displayVal = showPercent ? `${d.valor.toFixed(1)}%` : d.valor.toLocaleString('pt-BR');
      bars += `
        <text x="${labelW - 8}" y="${y + barHeight / 2 + 4}" text-anchor="end" font-size="11" fill="#475569" font-family="Segoe UI,sans-serif">${label}</text>
        <rect x="${labelW}" y="${y}" width="${w}" height="${barHeight}" rx="4" fill="${d.cor || cor}" opacity="0.85"/>
        <text x="${labelW + w + 6}" y="${y + barHeight / 2 + 4}" font-size="11" font-weight="600" fill="#1e293b" font-family="Segoe UI,sans-serif">${displayVal}</text>
      `;
    });

    return `\n\n<div style="margin:16px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;overflow-x:auto">
${titulo ? `<div style="font-size:13px;font-weight:700;color:#334155;margin-bottom:10px">${titulo}</div>` : ''}
<svg width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" xmlns="http://www.w3.org/2000/svg">${bars}</svg></div>\n\n`;
  }

  function gerarBarraVerticalSVG(dados, { titulo = '', width = 560, cor = '#6366f1', dualAxis = false, dados2 = null, cor2 = '#10b981' } = {}) {
    if (!dados || dados.length === 0) return '';
    const max = Math.max(...dados.map(d => d.valor), 1);
    const barW = Math.min(40, Math.floor((width - 80) / dados.length) - 8);
    const chartH = 160;
    const bottomY = chartH + 20;
    const leftPad = 45;

    let bars = '';
    dados.forEach((d, i) => {
      const x = leftPad + i * (barW + 8) + 4;
      const h = Math.max(2, (d.valor / max) * chartH);
      const y = bottomY - h;
      bars += `
        <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${d.cor || cor}" opacity="0.85"/>
        <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="10" font-weight="600" fill="#1e293b" font-family="Segoe UI,sans-serif">${d.valor}</text>
        <text x="${x + barW / 2}" y="${bottomY + 14}" text-anchor="middle" font-size="9" fill="#64748b" font-family="Segoe UI,sans-serif">${(d.label || '').substring(0, 8)}</text>
      `;
    });

    // Linhas de grade
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const y = bottomY - (i / 4) * chartH;
      const val = Math.round((i / 4) * max);
      grid += `<line x1="${leftPad - 5}" y1="${y}" x2="${leftPad + dados.length * (barW + 8)}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
      grid += `<text x="${leftPad - 8}" y="${y + 3}" text-anchor="end" font-size="9" fill="#94a3b8" font-family="Segoe UI,sans-serif">${val}</text>`;
    }

    // Linha de tendência (dados2) se dualAxis
    let linePath = '';
    if (dualAxis && dados2 && dados2.length > 0) {
      const max2 = 100; // percentual
      const points = dados2.map((d, i) => {
        const x = leftPad + i * (barW + 8) + 4 + barW / 2;
        const y = bottomY - (d.valor / max2) * chartH;
        return `${x},${y}`;
      }).join(' ');
      linePath = `
        <polyline points="${points}" fill="none" stroke="${cor2}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${dados2.map((d, i) => {
          const x = leftPad + i * (barW + 8) + 4 + barW / 2;
          const y = bottomY - (d.valor / max2) * chartH;
          return `<circle cx="${x}" cy="${y}" r="3.5" fill="${cor2}" stroke="white" stroke-width="1.5"/>
                  <text x="${x}" y="${y - 8}" text-anchor="middle" font-size="9" font-weight="600" fill="${cor2}" font-family="Segoe UI,sans-serif">${d.valor.toFixed(0)}%</text>`;
        }).join('')}
      `;
      // Eixo Y direito
      for (let i = 0; i <= 4; i++) {
        const y = bottomY - (i / 4) * chartH;
        const val = Math.round((i / 4) * 100);
        grid += `<text x="${leftPad + dados.length * (barW + 8) + 8}" y="${y + 3}" font-size="9" fill="${cor2}" font-family="Segoe UI,sans-serif">${val}%</text>`;
      }
    }

    const svgW = leftPad + dados.length * (barW + 8) + (dualAxis ? 40 : 10);
    const svgH = bottomY + 28;

    return `\n\n<div style="margin:16px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;overflow-x:auto">
${titulo ? `<div style="font-size:13px;font-weight:700;color:#334155;margin-bottom:10px">${titulo}</div>` : ''}
<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
${grid}${bars}${linePath}
<line x1="${leftPad}" y1="${bottomY}" x2="${leftPad + dados.length * (barW + 8)}" y2="${bottomY}" stroke="#cbd5e1" stroke-width="1"/>
</svg>
${dualAxis ? '<div style="font-size:10px;color:#94a3b8;margin-top:6px">🟦 Entregas &nbsp;&nbsp; 🟢 Taxa de Prazo (%)</div>' : ''}
</div>\n\n`;
  }

  function gerarComparativoSVG(atual, anterior, labels, { titulo = '', invertidos = [] } = {}) {
    if (!atual || !anterior) return '';
    const width = 480;
    const barH = 22;
    const gap = 32;
    const labelW = 130;
    const chartW = 240;

    let bars = '';
    labels.forEach((label, i) => {
      const y = i * (barH * 2 + gap);
      const maxV = Math.max(atual[i], anterior[i], 1);
      const wAtual = Math.max(2, (atual[i] / maxV) * chartW);
      const wAnterior = Math.max(2, (anterior[i] / maxV) * chartW);
      const diff = atual[i] - anterior[i];
      const pct = anterior[i] > 0 ? ((diff / anterior[i]) * 100).toFixed(1) : '0';
      const arrow = diff >= 0 ? '↑' : '↓';
      // Para métricas invertidas (ex: tempo), diminuir é positivo (verde)
      const isInvertido = invertidos.includes(i);
      const isPositivo = isInvertido ? diff <= 0 : diff >= 0;
      const arrowColor = isPositivo ? '#10b981' : '#ef4444';

      bars += `
        <text x="${labelW - 8}" y="${y + 10}" text-anchor="end" font-size="12" font-weight="600" fill="#334155" font-family="Segoe UI,sans-serif">${label}</text>
        <rect x="${labelW}" y="${y}" width="${wAtual}" height="${barH}" rx="4" fill="#6366f1" opacity="0.85"/>
        <text x="${labelW + wAtual + 6}" y="${y + barH / 2 + 4}" font-size="11" font-weight="700" fill="#1e293b" font-family="Segoe UI,sans-serif">${typeof atual[i] === 'number' && atual[i] % 1 !== 0 ? atual[i].toFixed(1) : atual[i]}</text>
        <rect x="${labelW}" y="${y + barH + 3}" width="${wAnterior}" height="${barH}" rx="4" fill="#cbd5e1"/>
        <text x="${labelW + wAnterior + 6}" y="${y + barH * 1.5 + 7}" font-size="11" fill="#64748b" font-family="Segoe UI,sans-serif">${typeof anterior[i] === 'number' && anterior[i] % 1 !== 0 ? anterior[i].toFixed(1) : anterior[i]}</text>
        <text x="${width - 10}" y="${y + barH + 4}" text-anchor="end" font-size="12" font-weight="700" fill="${arrowColor}" font-family="Segoe UI,sans-serif">${arrow} ${Math.abs(pct)}%</text>
      `;
    });

    const svgH = labels.length * (barH * 2 + gap);
    return `\n\n<div style="margin:16px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;overflow-x:auto">
${titulo ? `<div style="font-size:13px;font-weight:700;color:#334155;margin-bottom:10px">${titulo}</div>` : ''}
<svg width="${width}" height="${svgH}" viewBox="0 0 ${width} ${svgH}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>
<div style="font-size:10px;color:#94a3b8;margin-top:6px">🟦 Período Atual &nbsp;&nbsp; ⬜ Período Anterior</div>
</div>\n\n`;
  }

  function injetarGraficos(texto, dados) {
    if (!dados) return texto;
    let resultado = texto;

    try {
      // 1. Após "ENTREGAS E DESEMPENHO" — comparativo atual vs anterior
      const { metricas_atuais: ma, metricas_periodo_anterior: mp } = dados;
      if (ma && mp) {
        const grafico = gerarComparativoSVG(
          [parseInt(ma.total_entregas) || 0, parseFloat(ma.taxa_prazo) || 0, parseFloat(ma.tempo_medio_entrega || ma.tempo_medio) || 0],
          [parseInt(mp.total_entregas) || 0, parseFloat(mp.taxa_prazo) || 0, parseFloat(mp.tempo_medio_entrega || mp.tempo_medio) || 0],
          ['Entregas', 'Taxa Prazo (%)', 'Tempo Médio (min)'],
          { titulo: '📊 Comparativo: Período Atual vs Anterior', invertidos: [2] }
        );
        resultado = resultado.replace(
          /(#{2,3}\s*🚀.*?ENTREGAS.*?\n(?:[\s\S]*?))(\n#{2,3}\s)/,
          `$1${grafico}$2`
        );
      }

      // 2. Após "COBERTURA GEOGRÁFICA" — faixas de km (campo: quantidade)
      const { faixas_km } = dados;
      if (faixas_km && faixas_km.length > 0) {
        const dadosF = faixas_km.map(f => ({
          label: f.faixa,
          valor: parseInt(f.quantidade) || parseInt(f.entregas) || 0,
          cor: '#3b82f6',
        }));
        const grafico = gerarBarraSVG(dadosF, { titulo: '📊 Entregas por Faixa de Distância' });
        resultado = resultado.replace(
          /(#{2,3}\s*📍.*?COBERTURA.*?\n(?:[\s\S]*?))(\n#{2,3}\s)/,
          `$1${grafico}$2`
        );
      }

      // 3. Após "TENDÊNCIAS" — evolução semanal
      const { evolucao_semanal } = dados;
      if (evolucao_semanal && evolucao_semanal.length > 0) {
        const dadosE = evolucao_semanal.map(s => {
          const d = new Date(s.semana);
          return { label: `${d.getDate()}/${d.getMonth() + 1}`, valor: parseInt(s.entregas) || 0 };
        });
        const taxaE = evolucao_semanal.map(s => ({ valor: parseFloat(s.taxa_prazo) || 0 }));
        const grafico = gerarBarraVerticalSVG(dadosE, { titulo: '📊 Evolução Semanal de Entregas', dualAxis: true, dados2: taxaE });
        resultado = resultado.replace(
          /(#{2,3}\s*📈.*?TEND[ÊE]NCIAS.*?\n(?:[\s\S]*?))(\n#{2,3}\s)/,
          `$1${grafico}$2`
        );
      }

      // 4. Após "FROTA DIÁRIA" — motos por dia
      const { motos_por_dia } = dados;
      if (motos_por_dia && motos_por_dia.length > 0) {
        const grafico = gerarGraficoMotosDia(motos_por_dia, { titulo: '📊 Profissionais por Dia' });
        resultado = resultado.replace(
          /(#{2,3}\s*🏍️.*?FROTA.*?\n(?:[\s\S]*?))(\n#{2,3}\s)/,
          `$1${grafico}$2`
        );
      }

    } catch (e) {
      console.warn('⚠️ Erro ao injetar gráficos:', e.message);
    }

    return resultado;
  }

  // Função auxiliar para gráfico de motos por dia
  function gerarGraficoMotosDia(dados, { titulo = '', width = 560, cor = '#8b5cf6', cor2 = '#10b981' } = {}) {
    if (!dados || dados.length === 0) return '';
    const max = Math.max(...dados.map(d => Math.max(d.motos || 0, d.entregas_por_moto || 0)), 1);
    const barW = Math.min(28, Math.floor((width - 80) / dados.length) - 6);
    const chartH = 140;
    const bottomY = chartH + 20;
    const leftPad = 45;

    let bars = '';
    const maxMotos = Math.max(...dados.map(d => parseInt(d.motos) || 0), 1);
    dados.forEach((d, i) => {
      const x = leftPad + i * (barW + 6) + 4;
      const motos = parseInt(d.motos) || 0;
      const h = Math.max(2, (motos / maxMotos) * chartH);
      const y = bottomY - h;
      const dia = new Date(d.dia);
      const label = `${dia.getDate()}/${dia.getMonth() + 1}`;
      bars += `
        <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${cor}" opacity="0.85"/>
        <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="9" font-weight="600" fill="#1e293b" font-family="Segoe UI,sans-serif">${motos}</text>
        <text x="${x + barW / 2}" y="${bottomY + 12}" text-anchor="middle" font-size="8" fill="#64748b" font-family="Segoe UI,sans-serif">${label}</text>
      `;
    });

    // Linhas de grade
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const y = bottomY - (i / 4) * chartH;
      const val = Math.round((i / 4) * maxMotos);
      grid += `<line x1="${leftPad - 5}" y1="${y}" x2="${leftPad + dados.length * (barW + 6)}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
      grid += `<text x="${leftPad - 8}" y="${y + 3}" text-anchor="end" font-size="9" fill="#94a3b8" font-family="Segoe UI,sans-serif">${val}</text>`;
    }

    const svgW = leftPad + dados.length * (barW + 6) + 10;
    const svgH = bottomY + 24;

    return `\n\n<div style="margin:16px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;overflow-x:auto">
${titulo ? `<div style="font-size:13px;font-weight:700;color:#334155;margin-bottom:10px">${titulo}</div>` : ''}
<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
${grid}${bars}
<line x1="${leftPad}" y1="${bottomY}" x2="${leftPad + dados.length * (barW + 6)}" y2="${bottomY}" stroke="#cbd5e1" stroke-width="1"/>
</svg>
<div style="font-size:10px;color:#94a3b8;margin-top:6px">🟪 Motos por dia</div>
</div>\n\n`;
  }

  router.post('/cs/raio-x', async (req, res) => {
    try {
      const { cod_cliente, data_inicio, data_fim, tipo = 'completo', centro_custo } = req.body;
      if (!cod_cliente || !data_inicio || !data_fim) {
        return res.status(400).json({ error: 'cod_cliente, data_inicio e data_fim são obrigatórios' });
      }
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) {
        return res.status(400).json({ error: 'API Key do Gemini não configurada. Configure GEMINI_API_KEY no .env' });
      }
      const temCC = centro_custo && centro_custo !== '';
      console.log(`🔬 Gerando Raio-X IA: cliente=${cod_cliente}, período=${data_inicio} a ${data_fim}${temCC ? `, CC=${centro_custo}` : ''}`);
      const codInt = parseInt(cod_cliente);

      // Cliente 767 (Grupo Comollati): prazo FIXO de 120min (2h) para QUALQUER faixa de km
      // Para os demais clientes, usa o campo dentro_prazo já calculado no banco
      const isCliente767 = codInt === 767;
      if (isCliente767) console.log('⚠️ [Raio-X] Cliente 767 (Comollati): SLA fixo 120min aplicado');
      const DP = isCliente767
        ? '(tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120)'
        : 'dentro_prazo = true';
      const DP_FALSE = isCliente767
        ? '(tempo_execucao_minutos IS NULL OR tempo_execucao_minutos <= 0 OR tempo_execucao_minutos > 120)'
        : 'dentro_prazo = false';
      const DP_NOT_NULL = isCliente767
        ? '(tempo_execucao_minutos IS NOT NULL AND tempo_execucao_minutos > 0)'
        : 'dentro_prazo IS NOT NULL';

      // Filtro SQL de centro de custo (aplicado em todas as queries do bi_entregas)
      const ccSQL = temCC ? ' AND centro_custo = $4' : '';
      const baseParams = temCC ? [codInt, data_inicio, data_fim, centro_custo] : [codInt, data_inicio, data_fim];

      // 1. DADOS DO CLIENTE
      let fichaResult;
      if (temCC) {
        fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1 AND centro_custo = $2', [codInt, centro_custo]);
        if (fichaResult.rows.length === 0) fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1 LIMIT 1', [codInt]);
      } else {
        fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1 LIMIT 1', [codInt]);
      }
      const ficha = fichaResult.rows[0] || {};

      // 2. MÉTRICAS OPERACIONAIS DO PERÍODO
      const metricasCliente = await pool.query(`
        SELECT 
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          COUNT(DISTINCT os) as total_os,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND ${DP} THEN 1 ELSE 0 END) as entregas_no_prazo,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND ${DP_FALSE} THEN 1 ELSE 0 END) as entregas_fora_prazo,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND ${DP} THEN 1 ELSE 0 END)::numeric /
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND ${DP_NOT_NULL} THEN 1 END), 0) * 100, 2) as taxa_prazo,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio_entrega,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END)::numeric, 2) as km_medio,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais_unicos,
          COUNT(DISTINCT data_solicitado) as dias_com_entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR LOWER(ocorrencia) LIKE '%%clienteaus%%' OR
            LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR LOWER(ocorrencia) LIKE '%%loja fechada%%' OR
            LOWER(ocorrencia) LIKE '%%produto incorreto%%'
          ) THEN 1 ELSE 0 END) as total_retornos,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio_alocacao,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN velocidade_media END)::numeric, 1) as velocidade_media
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
      `, baseParams);

      // 3. FAIXAS DE KM
      const faixasKm = await pool.query(`
        SELECT 
          CASE WHEN distancia <= 5 THEN '0-5 km'
               WHEN distancia <= 10 THEN '5-10 km'
               WHEN distancia <= 15 THEN '10-15 km'
               WHEN distancia <= 20 THEN '15-20 km'
               WHEN distancia <= 25 THEN '20-25 km'
               WHEN distancia <= 30 THEN '25-30 km'
               ELSE '30+ km' END as faixa,
          COUNT(*) as quantidade,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
          ROUND(SUM(CASE WHEN ${DP} THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN ${DP_NOT_NULL} THEN 1 END), 0) * 100, 1) as taxa_prazo_faixa
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
          AND COALESCE(ponto, 1) >= 2 AND distancia IS NOT NULL AND distancia > 0
        GROUP BY CASE WHEN distancia <= 5 THEN '0-5 km'
               WHEN distancia <= 10 THEN '5-10 km'
               WHEN distancia <= 15 THEN '10-15 km'
               WHEN distancia <= 20 THEN '15-20 km'
               WHEN distancia <= 25 THEN '20-25 km'
               WHEN distancia <= 30 THEN '25-30 km'
               ELSE '30+ km' END
        ORDER BY MIN(distancia)
      `, baseParams);

      // 4. MAPA DE CALOR — por bairro/cidade
      const mapaCalor = await pool.query(`
        SELECT COALESCE(NULLIF(bairro, ''), 'Não informado') as bairro, COALESCE(cidade, '') as cidade,
          COUNT(*) as entregas, ROUND(AVG(distancia)::numeric, 1) as km_medio,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
          ROUND(SUM(CASE WHEN ${DP} THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN ${DP_NOT_NULL} THEN 1 END), 0) * 100, 1) as taxa_prazo
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL} AND COALESCE(ponto, 1) >= 2
        GROUP BY COALESCE(NULLIF(bairro, ''), 'Não informado'), COALESCE(cidade, '')
        ORDER BY COUNT(*) DESC LIMIT 20
      `, baseParams);

      // 5. ANÁLISE DE CORRIDAS/ROTEIROS POR MOTOBOY
      // Agrupa OS do mesmo motoboy criadas em janela de 10 minutos = mesmo roteiro/saída
      const corridasMotoboy = await pool.query(`
        WITH entregas_ordenadas AS (
          SELECT 
            cod_prof, nome_prof, os, data_solicitado, data_hora,
            COALESCE(ponto, 1) as ponto,
            distancia,
            tempo_execucao_minutos,
            CASE WHEN ${DP} THEN true ELSE false END as dp_ok,
            CASE WHEN ${DP_NOT_NULL} THEN true ELSE false END as dp_valido
          FROM bi_entregas
          WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
            AND data_hora IS NOT NULL
        ),
        roteiros AS (
          SELECT 
            cod_prof, nome_prof, os, data_solicitado, data_hora, ponto, distancia,
            tempo_execucao_minutos, dp_ok, dp_valido,
            -- Detecta se esta OS pertence ao mesmo roteiro da anterior (mesma janela de 10min)
            CASE WHEN data_hora - LAG(data_hora) OVER (PARTITION BY cod_prof, data_solicitado ORDER BY data_hora)
                 <= INTERVAL '10 minutes'
            THEN 0 ELSE 1 END as nova_saida
          FROM entregas_ordenadas
        ),
        saidas_numeradas AS (
          SELECT *,
            SUM(nova_saida) OVER (PARTITION BY cod_prof, data_solicitado ORDER BY data_hora) as id_saida
          FROM roteiros
        ),
        resumo_saidas AS (
          SELECT 
            cod_prof, nome_prof, data_solicitado, id_saida,
            COUNT(DISTINCT os) as os_no_roteiro,
            COUNT(CASE WHEN ponto >= 2 THEN 1 END) as entregas_no_roteiro,
            COALESCE(SUM(CASE WHEN ponto >= 2 THEN distancia END), 0) as km_roteiro,
            SUM(CASE WHEN ponto >= 2 AND dp_ok THEN 1 ELSE 0 END) as no_prazo_roteiro,
            SUM(CASE WHEN ponto >= 2 AND dp_valido THEN 1 ELSE 0 END) as valido_roteiro
          FROM saidas_numeradas
          GROUP BY cod_prof, nome_prof, data_solicitado, id_saida
        )
        SELECT 
          nome_prof,
          COUNT(*) as total_saidas,
          SUM(entregas_no_roteiro) as total_entregas,
          ROUND(SUM(entregas_no_roteiro)::numeric / NULLIF(COUNT(*), 0), 1) as entregas_por_saida,
          ROUND(SUM(os_no_roteiro)::numeric / NULLIF(COUNT(*), 0), 1) as os_por_saida,
          COUNT(DISTINCT data_solicitado) as dias_trabalhados,
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT data_solicitado), 0), 1) as saidas_por_dia,
          ROUND(AVG(km_roteiro)::numeric, 1) as km_medio_por_saida,
          ROUND(SUM(km_roteiro)::numeric, 1) as km_total,
          SUM(no_prazo_roteiro) as entregas_no_prazo,
          ROUND(SUM(no_prazo_roteiro)::numeric / NULLIF(SUM(valido_roteiro), 0) * 100, 1) as taxa_prazo
        FROM resumo_saidas
        WHERE entregas_no_roteiro > 0
        GROUP BY nome_prof
        ORDER BY SUM(entregas_no_roteiro) DESC LIMIT 15
      `, baseParams);

      // 6. PADRÕES DE HORÁRIO
      const padroesHorario = await pool.query(`
        SELECT 
          CASE WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 8 AND 9 THEN '08-10h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 10 AND 11 THEN '10-12h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 12 AND 13 THEN '12-14h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 14 AND 15 THEN '14-16h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 16 AND 17 THEN '16-18h'
               ELSE 'Fora do horário' END as faixa_horaria,
          COUNT(*) as entregas,
          ROUND(SUM(CASE WHEN ${DP} THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN ${DP_NOT_NULL} THEN 1 END), 0) * 100, 1) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
          AND COALESCE(ponto, 1) >= 2 AND data_hora IS NOT NULL
        GROUP BY CASE WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 8 AND 9 THEN '08-10h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 10 AND 11 THEN '10-12h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 12 AND 13 THEN '12-14h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 14 AND 15 THEN '14-16h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 16 AND 17 THEN '16-18h'
               ELSE 'Fora do horário' END
        ORDER BY MIN(EXTRACT(HOUR FROM data_hora))
      `, baseParams);

      // 7. EVOLUÇÃO SEMANAL
      const evolucaoSemanal = await pool.query(`
        SELECT DATE_TRUNC('week', data_solicitado)::date as semana,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND ${DP} THEN 1 ELSE 0 END) as no_prazo,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END)::numeric, 1) as km_medio,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
        GROUP BY DATE_TRUNC('week', data_solicitado) ORDER BY semana
      `, baseParams);

      // 8. RETORNOS DETALHADOS
      const retornosDetalhe = await pool.query(`
        SELECT ocorrencia, COUNT(*) as quantidade,
          ROUND(COUNT(*)::numeric / NULLIF((
            SELECT COUNT(*) FROM bi_entregas WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL} AND COALESCE(ponto, 1) >= 2
          ), 0) * 100, 2) as percentual
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
          AND COALESCE(ponto, 1) >= 2 AND ocorrencia IS NOT NULL AND ocorrencia != ''
        GROUP BY ocorrencia ORDER BY COUNT(*) DESC LIMIT 10
      `, baseParams);

      // 8b. MOTOS POR DIA — quantidade de profissionais distintos por dia
      const motosPorDia = await pool.query(`
        SELECT data_solicitado as dia,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as motos,
          ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / 
            NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as entregas_por_moto
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
        GROUP BY data_solicitado
        ORDER BY data_solicitado
      `, baseParams);

      // 9. BENCHMARK GERAL TUTTS (todos os clientes, não apenas da região)
      const estadoCliente = ficha.estado || (await pool.query(
        `SELECT estado FROM bi_entregas WHERE cod_cliente = $1 AND estado IS NOT NULL LIMIT 1`, [codInt]
      )).rows[0]?.estado || 'N/A';

      const benchmarkGeral = await pool.query(`
        SELECT ROUND(AVG(taxa_prazo)::numeric, 1) as media_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY taxa_prazo)::numeric, 1) as mediana_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY taxa_prazo)::numeric, 1) as p75_taxa_prazo,
          ROUND(AVG(total_entregas)::numeric, 0) as media_entregas,
          ROUND(AVG(km_medio)::numeric, 1) as media_km,
          ROUND(AVG(tempo_medio)::numeric, 1) as media_tempo_entrega,
          ROUND(AVG(taxa_retorno)::numeric, 2) as media_taxa_retorno,
          COUNT(*) as total_clientes
        FROM (
          SELECT cod_cliente,
            ROUND(SUM(CASE WHEN ${DP} THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN ${DP_NOT_NULL} THEN 1 END), 0) * 100, 1) as taxa_prazo,
            COUNT(*) as total_entregas, ROUND(AVG(distancia)::numeric, 1) as km_medio,
            ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio,
            ROUND(SUM(CASE WHEN (LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR LOWER(ocorrencia) LIKE '%%clienteaus%%' OR
              LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR LOWER(ocorrencia) LIKE '%%loja fechada%%'
            ) THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as taxa_retorno
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND COALESCE(ponto, 1) >= 2
            AND cod_cliente IS NOT NULL
          GROUP BY cod_cliente HAVING COUNT(*) >= 5
        ) sub
      `, [data_inicio, data_fim]);

      // 10. RANKING GERAL TUTTS
      const ranking = await pool.query(`
        WITH ranking_clientes AS (
          SELECT cod_cliente,
            ROUND(SUM(CASE WHEN ${DP} THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN ${DP_NOT_NULL} THEN 1 END), 0) * 100, 1) as taxa_prazo,
            COUNT(*) as total_entregas,
            RANK() OVER (ORDER BY SUM(CASE WHEN ${DP} THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN ${DP_NOT_NULL} THEN 1 END), 0) * 100 DESC) as rank_prazo,
            RANK() OVER (ORDER BY COUNT(*) DESC) as rank_volume
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2
            AND COALESCE(ponto, 1) >= 2 AND cod_cliente IS NOT NULL
          GROUP BY cod_cliente HAVING COUNT(*) >= 5
        )
        SELECT rank_prazo, rank_volume, (SELECT COUNT(*) FROM ranking_clientes) as total_ranqueados
        FROM ranking_clientes WHERE cod_cliente = $3
      `, [data_inicio, data_fim, codInt]);

      // 11. PERÍODO ANTERIOR
      const diasPeriodo = Math.ceil((new Date(data_fim) - new Date(data_inicio)) / (1000 * 60 * 60 * 24));
      const inicioAnterior = new Date(new Date(data_inicio) - diasPeriodo * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const fimAnterior = new Date(new Date(data_inicio) - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const metricasAnteriores = await pool.query(`
        SELECT COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND ${DP} THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND ${DP_NOT_NULL} THEN 1 END), 0) * 100, 2) as taxa_prazo,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio_entrega,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END)::numeric, 1) as km_medio,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais_unicos
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
      `, temCC ? [codInt, inicioAnterior, fimAnterior, centro_custo] : [codInt, inicioAnterior, fimAnterior]);

      // 12. MONTAR DADOS
      const metricas = metricasCliente.rows[0];
      const benchmark = benchmarkGeral.rows[0] || {};
      const rankingData = ranking.rows[0] || {};
      const metrAnterior = metricasAnteriores.rows[0];
      const healthScore = calcularHealthScore(metricas, getClienteConfig(codInt));

      // Calcular taxa de retorno explícita
      const totalEntregasNum = parseInt(metricas.total_entregas) || 0;
      const totalRetornos = parseInt(metricas.total_retornos) || 0;
      const taxaRetorno = totalEntregasNum > 0 ? ((totalRetornos / totalEntregasNum) * 100).toFixed(2) : '0';

      // Média de motos por dia
      const motosDiaRows = motosPorDia.rows;
      const mediaMotosdia = motosDiaRows.length > 0
        ? (motosDiaRows.reduce((s, r) => s + parseInt(r.motos || 0), 0) / motosDiaRows.length).toFixed(1)
        : '0';

      // Link do mapa de calor interativo (acesso público)
      const baseUrl = process.env.BASE_URL || req.protocol + '://' + req.get('host');
      const linkMapaCalor = `${baseUrl}/api/cs/mapa-calor/${codInt}?data_inicio=${data_inicio}&data_fim=${data_fim}${temCC ? `&centro_custo=${encodeURIComponent(centro_custo)}` : ''}`;

      // 12b. BUSCAR INTERAÇÕES DO PERÍODO
      const interacoesCliente = await pool.query(`
        SELECT tipo, titulo, descricao, resultado, proxima_acao, 
          TO_CHAR(data_interacao, 'DD/MM/YYYY') as data_fmt,
          criado_por_nome
        FROM cs_interacoes 
        WHERE cod_cliente = $1 AND data_interacao::date >= $2::date AND data_interacao::date <= $3::date
        ORDER BY data_interacao DESC
      `, [codInt, data_inicio, data_fim]).catch(err => { console.error('⚠️ Erro buscando interações:', err.message); return { rows: [] }; });

      // 12c. BUSCAR OCORRÊNCIAS CS DO PERÍODO
      const ocorrenciasCliente = await pool.query(`
        SELECT titulo, descricao, tipo, severidade, status, 
          responsavel_nome, resolucao, impacto_operacional,
          TO_CHAR(data_abertura, 'DD/MM/YYYY') as data_abertura_fmt,
          TO_CHAR(data_resolucao, 'DD/MM/YYYY') as data_resolucao_fmt
        FROM cs_ocorrencias 
        WHERE cod_cliente = $1 AND data_abertura::date >= $2::date AND data_abertura::date <= $3::date
        ORDER BY 
          CASE severidade WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END,
          data_abertura DESC
      `, [codInt, data_inicio, data_fim]).catch(err => { console.error('⚠️ Erro buscando ocorrências:', err.message); return { rows: [] }; });

      console.log(`📋 Raio-X dados CS: ${interacoesCliente.rows.length} interações, ${ocorrenciasCliente.rows.length} ocorrências (cliente=${codInt}, ${data_inicio} a ${data_fim})`);

      // Buscar máscara do BI
      let mascara = null;
      try {
        const mascaraResult = await pool.query('SELECT mascara FROM bi_mascaras WHERE cod_cliente = $1', [codInt]);
        if (mascaraResult.rows.length > 0) mascara = mascaraResult.rows[0].mascara;
      } catch (e) { /* bi_mascaras pode não existir */ }

      // Nome para o relatório: se tem CC selecionado usa o CC, senão usa máscara ou nome_fantasia
      const nomeRelatorio = temCC ? centro_custo : (mascara || ficha.nome_fantasia || `Cliente ${cod_cliente}`);

      const dadosAnalise = {
        cliente: { nome: nomeRelatorio, segmento: ficha.segmento || 'autopeças', health_score: healthScore },
        periodo: { inicio: data_inicio, fim: data_fim, dias: diasPeriodo },
        metricas_atuais: { ...metricas, taxa_retorno: taxaRetorno },
        metricas_periodo_anterior: metrAnterior,
        faixas_km: faixasKm.rows,
        mapa_calor_bairros: mapaCalor.rows,
        corridas_por_motoboy: corridasMotoboy.rows,
        padroes_horario: padroesHorario.rows,
        evolucao_semanal: evolucaoSemanal.rows,
        retornos_detalhados: retornosDetalhe.rows,
        motos_por_dia: motosDiaRows,
        media_motos_dia: mediaMotosdia,
        interacoes_periodo: interacoesCliente.rows,
        ocorrencias_periodo: ocorrenciasCliente.rows,
        benchmark_geral_tutts: { ...benchmark, total_clientes: benchmark.total_clientes },
        ranking_geral: { posicao_prazo: rankingData.rank_prazo, posicao_volume: rankingData.rank_volume, total_clientes: rankingData.total_ranqueados },
        link_mapa_calor: linkMapaCalor,
      };

      // 13. Dados para o Gemini (sem bairros para evitar listagem)
      const dadosParaGemini = { ...dadosAnalise };
      delete dadosParaGemini.mapa_calor_bairros; // Remover para evitar que o Gemini liste bairros
      // Manter benchmark geral para comparação com todos os clientes Tutts
      // Manter ranking para posicionamento percentual
      const totalClientes = dadosParaGemini.ranking_geral?.total_clientes || 1;
      const posPrazo = dadosParaGemini.ranking_geral?.posicao_prazo || 1;
      const posVolume = dadosParaGemini.ranking_geral?.posicao_volume || 1;
      dadosParaGemini.ranking_geral = {
        ...dadosParaGemini.ranking_geral,
        percentil_prazo: Math.round((1 - posPrazo / totalClientes) * 100),
        percentil_volume: Math.round((1 - posVolume / totalClientes) * 100),
      };

      // 14. PROMPT GEMINI
      const slaInfo767 = isCliente767
        ? `\n\n⚠️ REGRA ESPECIAL DESTE CLIENTE — COMOLLATI (cliente 767):\n- Prazo FIXO de 120 minutos (2 horas) para QUALQUER faixa de km.\n- Os dados de "dentro do prazo" já foram recalculados com base nessa regra.\n- O SLA MÍNIMO CONTRATUAL é de **95% no prazo**. Se a taxa atual estiver abaixo de 95%, é uma violação de SLA — trate como CRÍTICO e inclua no plano de ação com prioridade máxima.\n- Se estiver entre 95% e 97%, destaque como "atenção — margem estreita". Acima de 97% = excelente.\n`
        : '';

      // Resumo de ocorrências e interações para injetar no prompt
      const resumoOcorrencias = ocorrenciasCliente.rows.length > 0
        ? ocorrenciasCliente.rows.map(o =>
            `• [${(o.severidade || 'media').toUpperCase()}] ${o.titulo} (${o.status}) — ${o.descricao || ''} | Resolução: ${o.resolucao || 'pendente'} | Impacto: ${o.impacto_operacional || 'não informado'}`
          ).join('\n')
        : 'Nenhuma ocorrência no período.';

      const resumoInteracoes = interacoesCliente.rows.length > 0
        ? interacoesCliente.rows.map(i =>
            `• [${i.data_fmt}] ${i.tipo} (por ${i.criado_por_nome || 'equipe'}): ${i.descricao || ''} | Resultado: ${i.resultado || 'não registrado'} | Próxima ação: ${i.proxima_acao || 'nenhuma'}`
          ).join('\n')
        : 'Nenhuma interação no período.';

      const prompt = `Você é um analista sênior da equipe de Sucesso do Cliente (CS) da Tutts, empresa de logística de entregas com motoboys. Você FAZ PARTE DO TIME — não é consultor externo, não é terceiro, não é "alguém de fora". Você usa "nós", "nossa equipe", "vamos", "identificamos". Gere o RELATÓRIO OPERACIONAL do cliente ${nomeRelatorio}.${temCC ? ` Relatório específico do centro de custo "${centro_custo}".` : ''}${slaInfo767}

═══════════════════════════════════
BLOCO 1 — IDENTIDADE E TOM (REGRAS ABSOLUTAS)
═══════════════════════════════════
✅ Fale SEMPRE em primeira pessoa do plural: "nós", "nossa equipe", "nosso time", "identificamos", "vamos garantir", "já estamos atuando".
✅ Tom: parceiro interno que conhece a operação de dentro, não consultor que analisa de fora.

⛔ NUNCA use: "a Tutts deveria", "recomendo que a empresa", "a empresa precisa melhorar", "seria interessante que a Tutts". Você É a Tutts.
⛔ NUNCA sugira aumentar frequência de contato com o cliente (ligações, visitas, reuniões mais frequentes). Isso nos prejudica comercialmente — o cliente pode interpretar como monitoramento excessivo. Qualidade > quantidade no relacionamento.
⛔ NUNCA sugira ao cliente que ele mude seus processos internos. Nossas sugestões são sobre o que NÓS controlaremos e melhoraremos.
⛔ NUNCA defina prazos ou datas ("em 2 semanas", "até o dia X"). Trabalhamos com melhoria contínua.
⛔ NUNCA mencione valores financeiros, faturamento, custos ou receitas.
⛔ NUNCA cite métricas individuais de outros clientes pelo nome.
⛔ NUNCA liste bairros, ruas ou endereços específicos.

═══════════════════════════════════
BLOCO 2 — REGRAS DE FORMATO
═══════════════════════════════════
- Siga EXATAMENTE a estrutura de seções abaixo, com títulos ## e emojis EXATOS.
- ⛔ PROIBIDO tabelas markdown (| --- |). Use listas com bullet points (- item).
- Destaque números com **negrito**.
- Português brasileiro, tom consultivo e de parceria interna.

═══════════════════════════════════
BLOCO 3 — REGRAS DE RETORNO (CRÍTICO — LER COM ATENÇÃO)
═══════════════════════════════════
A taxa de retorno no setor de autopeças funciona assim:
- Até **2%** → SAUDÁVEL e NORMAL. NÃO é um problema. Não escreva "plano de ação" se estiver nessa faixa.
- Entre **2% e 5%** → Atenção pontual, mas não crítico.
- Acima de **5%** → Preocupante, requer ação.

A taxa de retorno atual deste cliente é **${taxaRetorno}%**.
${parseFloat(taxaRetorno) <= 2
  ? '✅ Está DENTRO do padrão saudável. Contextualize positivamente — NÃO trate como problema.'
  : parseFloat(taxaRetorno) <= 5
    ? '⚠️ Merece atenção mas não é crítico. Mencione com tom de acompanhamento, não de alarme.'
    : '🔴 Acima do limite. Inclua no plano de ação com prioridade alta.'}

═══════════════════════════════════
BLOCO 4 — REGRAS DO BENCHMARK (COMPARATIVO COM O MERCADO)
═══════════════════════════════════
O campo "benchmark_geral_tutts" contém médias calculadas com TODOS os clientes ativos da Tutts no mesmo período — independente de região ou porte. Os campos "ranking_geral" mostram a posição percentil deste cliente entre todos.

- Use esses dados para posicionar o cliente de forma RELATIVA E PERCENTUAL (ex: "está acima de X% dos clientes da nossa base").
- ⛔ NÃO cite regiões específicas, NÃO compare com "clientes da mesma região".
- ⛔ NÃO invente médias nem use dados que não estejam nos campos fornecidos.

═══════════════════════════════════
BLOCO 5 — OCORRÊNCIAS E INTERAÇÕES (INSUMO OBRIGATÓRIO PARA O PLANO DE AÇÃO)
═══════════════════════════════════
OCORRÊNCIAS DO PERÍODO (${ocorrenciasCliente.rows.length} registros):
${resumoOcorrencias}

INTERAÇÕES DO PERÍODO (${interacoesCliente.rows.length} registros):
${resumoInteracoes}

⚠️ REGRA CRÍTICA: Se existirem ocorrências ou interações acima, o PLANO DE AÇÃO deve OBRIGATORIAMENTE endereçar os pontos levantados neles. Não é opcional. Se o cliente reportou um problema em uma interação, o plano de ação deve ter uma ação correspondente. Se houve ocorrência em aberto, deve estar no plano.

═══════════════════════════════════
DADOS COMPLETOS DA OPERAÇÃO
═══════════════════════════════════
${JSON.stringify(dadosParaGemini, null, 2)}

═══════════════════════════════════
ESTRUTURA FIXA DO RELATÓRIO — SIGA EXATAMENTE
═══════════════════════════════════

## 📊 VISÃO GERAL DA OPERAÇÃO

Parágrafo 1 (3-4 linhas): síntese executiva com total de entregas, dias operados, profissionais envolvidos e média de motos por dia (${mediaMotosdia} motos/dia).

Parágrafo 2: Health Score de **${healthScore}/100** — classificação ${healthScore >= 80 ? '🟢 **Excelente**' : healthScore >= 50 ? '🟡 **Boa com pontos de atenção**' : '🔴 **Requer ação imediata**'}. Explique de forma clara o que esse score representa para a operação.

## 🚀 ENTREGAS E DESEMPENHO

Parágrafo sobre volume (entregas atual vs anterior, variação ↑↓%). Variação < 3% = "volume estável", sem análise de fatores.

Parágrafo sobre taxa de prazo (atual vs anterior ↑↓%).${isCliente767 ? ' ⚠️ COMOLLATI: mínimo é 95%. Abaixo disso = CRÍTICO, acima de 97% = excelente.' : ''} Variação < 3% = "manteve-se estável".

Parágrafo sobre tempo médio de entrega. Variação < 3% = "manteve-se estável".

Parágrafo sobre retornos: informe quantidade total, **taxa de ${taxaRetorno}%**, principais motivos.${parseFloat(taxaRetorno) <= 2 ? ' Esta taxa está dentro do padrão saudável para operações de autopeças (até 2%). Contextualize positivamente.' : parseFloat(taxaRetorno) <= 5 ? ' Está na faixa de atenção (2-5%). Mencione sem alarmar.' : ' Está acima do limite de 5%. Inclua plano de ação.'}

## 🏍️ FROTA DIÁRIA (Motos por Dia)

Informe que a média foi de **${mediaMotosdia} motos/dia** no período.

Analise a distribuição diária com base nos dados de "motos_por_dia": dias de pico, dias de menor cobertura, relação entregas/moto por dia, e se houve desequilíbrio na alocação.

## 📍 COBERTURA GEOGRÁFICA E DISTÂNCIAS

Liste CADA FAIXA de KM disponível nos dados exatamente assim (uma linha por faixa, sem pular):

- **[FAIXA] km:** [X] entregas · prazo [Y]% · tempo médio [Z] min

Parágrafo analítico sobre concentração de volume e comportamento do SLA por distância.

Encerre com: "Para uma visualização completa da cobertura, disponibilizamos um **mapa de calor interativo** com todos os pontos de entrega, taxa de prazo por região e tempo médio. Acesse: ${linkMapaCalor}"

## 🏍️ ANÁLISE DOS ROTEIROS E PROFISSIONAIS

Liste cada profissional dos dados "corridas_por_motoboy" exatamente assim:

- **[NOME]:** [X] entregas · [Y] saídas · prazo [Z]% · [W] entregas/saída · [V] saídas/dia

Parágrafo analítico: melhores e piores taxas de prazo, padrões de sobrecarga, destaques positivos.

## ⏰ JANELA OPERACIONAL (08h às 18h)

Liste cada faixa horária dos dados "padroes_horario" exatamente assim:

- **[FAIXA]:** [X] entregas · prazo [Y]% · tempo médio [Z] min

(Se houver "Fora do horário", liste como última linha.)

Parágrafo sobre picos de demanda e variação de SLA entre faixas.

## 📈 COMPARATIVO COM O MERCADO (Todos os Clientes Tutts)

⚠️ INSTRUÇÕES ESPECÍFICAS DESTA SEÇÃO:
- Use os dados de "benchmark_geral_tutts" (médias de TODOS os clientes da Tutts, não só da região).
- Use "ranking_geral" para percentil (percentil_prazo e percentil_volume).
- Posicione o cliente de forma percentual: "está entre os X% melhores da nossa base em [métrica]".
- Compare taxa de prazo atual com a média geral da Tutts e com a mediana.
- Compare taxa de retorno atual (${taxaRetorno}%) com a média geral da base.
- ⛔ NÃO compare com região específica. ⛔ NÃO use nome de outros clientes.

## 📉 TENDÊNCIAS E PROJEÇÕES

Parágrafo sobre evolução semanal baseado em "evolucao_semanal": volume crescendo, estável ou caindo?

Parágrafo sobre riscos identificados com classificação: 🔴 Alto · 🟠 Médio · 🟡 Baixo.

## ⚠️ PONTOS DE ATENÇÃO

Para cada problema REAL identificado nos dados, use:

- **Situação:** [descrição] · **Ação:** [o que vamos fazer] · **Prioridade:** 🔴 Urgente / 🟠 Importante / 🟡 Melhoria contínua

⛔ Apenas problemas reais. ⛔ Sem prazos ou datas. ⛔ Ações são sobre o que NÓS faremos.

## 🎯 PLANO DE AÇÃO

⚠️ OBRIGATÓRIO: Se existirem ocorrências ou interações no período (ver Bloco 5 acima), as ações devem ENDEREÇAR diretamente os pontos levantados. As 5 ações devem refletir os dados operacionais E os problemas reportados nas ocorrências/interações.

Liste exatamente 5 ações:

- **Ação 1 — [Título]:** [Descrição do que vamos fazer]. **Meta:** [resultado esperado].
- **Ação 2 — [Título]:** [Descrição]. **Meta:** [resultado].
- **Ação 3 — [Título]:** [Descrição]. **Meta:** [resultado].
- **Ação 4 — [Título]:** [Descrição]. **Meta:** [resultado].
- **Ação 5 — [Título]:** [Descrição]. **Meta:** [resultado].

## 💡 OPORTUNIDADES

2-3 parágrafos com oportunidades de melhoria baseadas nos dados. Quick wins operacionais INTERNOS — roteirização, alocação, treinamento, otimização de rotas.

## 📋 OCORRÊNCIAS REGISTRADAS

${ocorrenciasCliente.rows.length > 0
  ? `Foram registradas **${ocorrenciasCliente.rows.length}** ocorrência(s) no período. Analise CADA UMA dos dados em "ocorrencias_periodo" usando:

- **[🔴🟠🟡🟢] [TÍTULO]** ([✅ Resolvida / 🔄 Em andamento / 🕐 Aberta]) — [descrição]. [Resolução quando houver]. [Impacto quando informado].

Parágrafo final: quantas resolvidas vs abertas, padrões identificados, conexão com o plano de ação.`
  : `Não houve ocorrências registradas no período. Escreva um parágrafo positivo sobre a estabilidade operacional.`}

## 🤝 RELACIONAMENTO E ACOMPANHAMENTO

${interacoesCliente.rows.length > 0
  ? `Foram registradas **${interacoesCliente.rows.length}** interação(ões) no período. Apresente CADA UMA dos dados em "interacoes_periodo" usando:

- **[DATA] — [TIPO]** (por [NOME]): [o que foi tratado]. [Resultado]. [Próxima ação definida].

Parágrafo final: avalie se os compromissos assumidos estão refletidos no plano de ação. ⛔ NÃO sugira aumentar frequência de contato.`
  : `Não houve interações formais registradas no período. Escreva um parágrafo curto informando que o acompanhamento operacional segue em andamento de forma contínua.`}

---

Encerre com um parágrafo de parceria interna: "Estamos à disposição para apresentar e detalhar este relatório diretamente."

⛔ CHECKLIST FINAL ANTES DE RESPONDER:
[ ] Usei "nós", "nossa equipe" em todo o texto?
[ ] Evitei sugerir aumento de frequência de contato?
[ ] O plano de ação endereça as ocorrências/interações?
[ ] Contextualizei a taxa de retorno de ${taxaRetorno}% corretamente (até 2% = saudável)?
[ ] O benchmark usa todos os clientes Tutts, não só da região?
[ ] Incluí a seção de motos por dia?`;

      // Incluir link do mapa no response final
      // Incluir link do mapa no response final
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
          }),
        }
      );

      const geminiData = await geminiResponse.json();
      if (geminiData.error) {
        console.error('❌ Erro Gemini Raio-X:', geminiData.error);
        return res.status(500).json({ error: `Erro Gemini: ${geminiData.error.message}` });
      }

      const analiseTexto = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'Erro ao gerar análise';
      const tokensUsados = geminiData.usageMetadata?.candidatesTokenCount || 0;

      // 15. INJETAR GRÁFICOS SVG NO RELATÓRIO
      const analiseComGraficos = injetarGraficos(analiseTexto, dadosAnalise);

      // 16. SALVAR HISTÓRICO (texto original sem gráficos)
      const saveResult = await pool.query(`
        INSERT INTO cs_raio_x_historico (
          cod_cliente, nome_cliente, data_inicio, data_fim,
          metricas_snapshot, benchmark_snapshot, analise_texto,
          tipo_analise, score_saude, alertas, recomendacoes,
          gerado_por, gerado_por_nome, tokens_utilizados
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `, [
        codInt, temCC ? `${nomeRelatorio}` : (mascara || ficha.nome_fantasia || `Cliente ${cod_cliente}`), data_inicio, data_fim,
        JSON.stringify(dadosAnalise), JSON.stringify(benchmark), analiseComGraficos,
        tipo, healthScore, JSON.stringify([]), JSON.stringify([]),
        req.user?.codProfissional, req.user?.nome, tokensUsados,
      ]);

      console.log(`✅ Raio-X gerado: cliente=${cod_cliente}, health=${healthScore}, tokens=${tokensUsados}`);

      res.json({
        success: true,
        raio_x: {
          id: saveResult.rows[0].id, analise: analiseComGraficos, health_score: healthScore,
          dados_utilizados: dadosAnalise, tokens: tokensUsados, gerado_em: new Date().toISOString(),
          link_mapa_calor: linkMapaCalor,
        },
      });
    } catch (error) {
      console.error('❌ Erro ao gerar Raio-X CS:', error.message, error.stack);
      res.status(500).json({ error: `Erro ao gerar Raio-X: ${error.message}` });
    }
  });


  // ==================== GET /cs/mapa-calor/:cod ====================
  // Mapa de calor — geocodificação no BACKEND com cache em DB
  router.get('/cs/mapa-calor/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      const { data_inicio, data_fim, centro_custo } = req.query;
      const inicio = data_inicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const fim = data_fim || new Date().toISOString().split('T')[0];
      const temCC = centro_custo && centro_custo.trim() !== '';
      const ccSQL = temCC ? ' AND centro_custo = $4' : '';
      const baseParams = temCC ? [cod, inicio, fim, centro_custo] : [cod, inicio, fim];

      const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
      if (!GOOGLE_API_KEY) return res.status(400).send('GOOGLE_GEOCODING_API_KEY não configurada');

      // Cliente 767 (Comollati): prazo FIXO de 120min para qualquer faixa
      const isCliente767Mapa = cod === 767;
      const DP_MAPA = isCliente767Mapa
        ? '(tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 120)'
        : 'dentro_prazo = true';
      const DP_NOT_NULL_MAPA = isCliente767Mapa
        ? '(tempo_execucao_minutos IS NOT NULL AND tempo_execucao_minutos > 0)'
        : 'dentro_prazo IS NOT NULL';

      // Tabela de cache
      await pool.query(`
        CREATE TABLE IF NOT EXISTS geocode_cache (
          endereco_hash VARCHAR(64) PRIMARY KEY,
          endereco_original TEXT,
          lat DOUBLE PRECISION,
          lng DOUBLE PRECISION,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      const clienteResult = await pool.query('SELECT nome_fantasia, cidade, estado FROM cs_clientes WHERE cod_cliente = $1', [cod]);
      const ficha = clienteResult.rows[0] || {};
      const nomeCliente = temCC
        ? `${ficha.nome_fantasia || `Cliente ${cod}`} — ${centro_custo}`
        : (ficha.nome_fantasia || `Cliente ${cod}`);

      // Todos os endereços agrupados — SEM LIMITE
      const entregas = await pool.query(`
        SELECT
          endereco, bairro, cidade, estado,
          COUNT(*) as quantidade,
          ROUND(SUM(CASE WHEN ${DP_MAPA} THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN ${DP_NOT_NULL_MAPA} THEN 1 END), 0) * 100, 1) as taxa_prazo,
          ROUND(AVG(distancia)::numeric, 1) as km_medio,
          ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3${ccSQL}
          AND COALESCE(ponto, 1) >= 2
          AND endereco IS NOT NULL AND endereco != ''
        GROUP BY endereco, bairro, cidade, estado
        ORDER BY COUNT(*) DESC
      `, baseParams);

      const totalEntregas = entregas.rows.reduce((s, r) => s + parseInt(r.quantidade), 0);

      // ── Geocodificar no backend com cache OTIMIZADO ──
      const crypto = require('crypto');
      const pontosGeo = [];
      let cacheHits = 0, apiCalls = 0;

      // Preparar hashes de todos os endereços
      const enderecosMapped = entregas.rows.map(e => {
        const addrParts = [e.endereco, e.bairro, e.cidade, e.estado].filter(Boolean);
        const addrStr = addrParts.join(', ');
        const hash = crypto.createHash('md5').update(addrStr.toLowerCase().trim()).digest('hex');
        return { ...e, addrStr, hash };
      });

      // Buscar TODOS os caches de uma vez (1 query em vez de N)
      const allHashes = enderecosMapped.map(e => e.hash);
      const cachedResult = await pool.query(
        'SELECT endereco_hash, lat, lng FROM geocode_cache WHERE endereco_hash = ANY($1)',
        [allHashes]
      );
      const cacheMap = {};
      cachedResult.rows.forEach(r => { cacheMap[r.endereco_hash] = r; });

      // Separar: com cache vs precisam de API
      const needsApi = [];
      for (const e of enderecosMapped) {
        const cached = cacheMap[e.hash];
        if (cached) {
          cacheHits++;
          pontosGeo.push({
            lat: cached.lat, lng: cached.lng,
            quantidade: parseInt(e.quantidade), taxa_prazo: parseFloat(e.taxa_prazo || 0),
            km_medio: e.km_medio, tempo_medio: e.tempo_medio,
            bairro: e.bairro || '', cidade: e.cidade || '', endereco: e.endereco || '',
          });
        } else {
          needsApi.push(e);
        }
      }

      // Geocodificar os que faltam em lotes de 10 paralelos
      const BATCH_SIZE = 10;
      for (let i = 0; i < needsApi.length; i += BATCH_SIZE) {
        const batch = needsApi.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(async (e) => {
          try {
            const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(e.addrStr)}&key=${GOOGLE_API_KEY}&region=br&language=pt-BR`;
            const geoRes = await fetch(url);
            const geoData = await geoRes.json();
            apiCalls++;
            if (geoData.status === 'OK' && geoData.results[0]) {
              const loc = geoData.results[0].geometry.location;
              await pool.query(
                'INSERT INTO geocode_cache (endereco_hash, endereco_original, lat, lng) VALUES ($1, $2, $3, $4) ON CONFLICT (endereco_hash) DO NOTHING',
                [e.hash, e.addrStr, loc.lat, loc.lng]
              ).catch(() => {});
              return { lat: loc.lat, lng: loc.lng, e };
            }
          } catch (err) { console.warn('Geocode falhou:', e.addrStr); }
          return null;
        }));

        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value) {
            pontosGeo.push({
              lat: r.value.lat, lng: r.value.lng,
              quantidade: parseInt(r.value.e.quantidade), taxa_prazo: parseFloat(r.value.e.taxa_prazo || 0),
              km_medio: r.value.e.km_medio, tempo_medio: r.value.e.tempo_medio,
              bairro: r.value.e.bairro || '', cidade: r.value.e.cidade || '', endereco: r.value.e.endereco || '',
            });
          }
        });

        // Pause entre lotes para não estourar rate limit
        if (i + BATCH_SIZE < needsApi.length) await new Promise(r => setTimeout(r, 200));
      }

      console.log(`🗺️ Mapa calor: ${pontosGeo.length} pontos (${cacheHits} cache, ${apiCalls} API)`);

      // Centro = média dos pontos reais
      let centerLat = -12.97, centerLng = -38.51;
      if (pontosGeo.length > 0) {
        centerLat = pontosGeo.reduce((s, p) => s + p.lat, 0) / pontosGeo.length;
        centerLng = pontosGeo.reduce((s, p) => s + p.lng, 0) / pontosGeo.length;
      }

      const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Mapa de Calor - ${nomeCliente}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',-apple-system,sans-serif;background:#0f172a}
#header{background:linear-gradient(135deg,#6366f1,#8b5cf6,#a855f7);color:#fff;padding:20px 28px;display:flex;align-items:center;justify-content:space-between}
#header .left h1{font-size:20px;font-weight:700}
#header .left p{font-size:13px;opacity:.85;margin-top:4px}
#header .right{text-align:right}
#header .stat{font-size:28px;font-weight:800}
#header .stat-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.7}
#map{height:calc(100vh - 80px);width:100%}
.legend{background:#fff;border-radius:10px;padding:14px 18px;box-shadow:0 4px 16px rgba(0,0,0,.12);font-size:12px}
.legend h4{font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
.legend-item{display:flex;align-items:center;gap:8px;margin:4px 0}
.legend-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.toggle-btn{background:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.1);display:flex;align-items:center;gap:6px;color:#334155}
.toggle-btn:hover{background:#f1f5f9}
.toggle-btn.active{background:#6366f1;color:#fff}
.info-panel{background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:16px 20px;font-size:13px;line-height:1.7;min-width:200px}
.info-panel h3{font-size:14px;font-weight:700;color:#1e293b;margin-bottom:4px}
</style></head><body>
<div id="header"><div class="left"><h1>🗺️ Mapa de Calor — ${nomeCliente}</h1><p>Período: ${inicio} a ${fim}</p></div>
<div class="right"><div class="stat">${totalEntregas.toLocaleString('pt-BR')}</div><div class="stat-label">entregas mapeadas</div></div></div>
<div id="map"></div>
<script>
var pontos=${JSON.stringify(pontosGeo)};
var map,heatmap,markers=[];
var showHeat=true,showMarkers=true;
function initMap(){
  map=new google.maps.Map(document.getElementById('map'),{
    zoom:13,center:{lat:${centerLat},lng:${centerLng}},mapTypeId:'roadmap',
    styles:[{featureType:'poi',stylers:[{visibility:'off'}]},{featureType:'transit',stylers:[{visibility:'simplified'}]}],
    mapTypeControl:true,mapTypeControlOptions:{position:google.maps.ControlPosition.TOP_LEFT},fullscreenControl:true
  });
  var ld=document.createElement('div');ld.className='legend';ld.style.margin='10px';
  ld.innerHTML='<h4>📊 Legenda SLA</h4><div class="legend-item"><div class="legend-dot" style="background:#10b981"></div> Prazo ≥ 95%</div><div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div> Prazo 85-95%</div><div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div> Prazo &lt; 85%</div><div style="border-top:1px solid #e2e8f0;margin:8px 0;padding-top:8px"><div class="legend-item"><div class="legend-dot" style="background:rgba(99,102,241,.5);width:8px;height:8px"></div> Menor volume</div><div class="legend-item"><div class="legend-dot" style="background:rgba(99,102,241,.8);width:16px;height:16px"></div> Maior volume</div></div>';
  map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(ld);
  var td=document.createElement('div');td.style.cssText='margin:10px;display:flex;gap:6px';
  td.innerHTML='<button id="btnHeat" class="toggle-btn active" onclick="toggleHeat()">🔥 Calor</button><button id="btnMarkers" class="toggle-btn active" onclick="toggleMarkers()">📍 Marcadores</button>';
  map.controls[google.maps.ControlPosition.TOP_RIGHT].push(td);
  var ip=document.createElement('div');ip.className='info-panel';ip.style.margin='10px';
  ip.innerHTML='<h3>✅ '+pontos.length+' endereços mapeados</h3><p style="font-size:11px;color:#94a3b8">Use 🔥 e 📍 para alternar camadas</p>';
  map.controls[google.maps.ControlPosition.LEFT_BOTTOM].push(ip);
  var bounds=new google.maps.LatLngBounds();
  var heatData=[];
  pontos.forEach(function(p){
    var pos=new google.maps.LatLng(p.lat,p.lng);
    heatData.push({location:pos,weight:Math.min(p.quantidade,30)});
    bounds.extend(pos);
    var color=p.taxa_prazo>=95?'#10b981':p.taxa_prazo>=85?'#f59e0b':'#ef4444';
    var sz=Math.max(6,Math.min(p.quantidade*1.5,22));
    var mk=new google.maps.Marker({position:pos,map:map,icon:{path:google.maps.SymbolPath.CIRCLE,scale:sz,fillColor:color,fillOpacity:.7,strokeColor:'#fff',strokeWeight:2}});
    var iw=new google.maps.InfoWindow({content:'<div style="font-family:Segoe UI,sans-serif;padding:4px;min-width:180px"><b style="font-size:14px;color:#1e293b">'+(p.bairro||p.endereco)+'</b><div style="color:#64748b;font-size:12px;margin-bottom:8px">'+p.cidade+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:13px"><span>📦 Entregas</span><b>'+p.quantidade+'</b><span>⏱️ Prazo</span><b style="color:'+color+'">'+p.taxa_prazo+'%</b><span>📏 KM</span><b>'+(p.km_medio||'-')+'</b><span>🕐 Tempo</span><b>'+(p.tempo_medio||'-')+' min</b></div></div>'});
    mk.addListener('click',function(){iw.open(map,mk)});
    markers.push(mk);
  });
  if(heatData.length>0){
    heatmap=new google.maps.visualization.HeatmapLayer({data:heatData,map:map,radius:40,opacity:.6,gradient:['rgba(0,0,0,0)','rgba(99,102,241,.3)','rgba(59,130,246,.5)','rgba(16,185,129,.6)','rgba(245,158,11,.7)','rgba(239,68,68,.8)','rgba(220,38,38,.9)']});
    map.fitBounds(bounds);
  }
}
function toggleHeat(){showHeat=!showHeat;heatmap&&heatmap.setMap(showHeat?map:null);document.getElementById('btnHeat').classList.toggle('active',showHeat)}
function toggleMarkers(){showMarkers=!showMarkers;markers.forEach(function(m){m.setMap(showMarkers?map:null)});document.getElementById('btnMarkers').classList.toggle('active',showMarkers)}
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&libraries=visualization&callback=initMap" async defer></script>
</body></html>`;

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://maps.googleapis.com https://maps.gstatic.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maps.googleapis.com https://maps.gstatic.com",
        "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' https://maps.googleapis.com https://*.googleapis.com https://*.gstatic.com",
        "frame-src https://maps.googleapis.com https://*.google.com",
        "worker-src blob: 'self'",
      ].join('; '));
      res.send(html);
    } catch (error) {
      console.error('❌ Erro mapa de calor:', error);
      res.status(500).json({ error: 'Erro ao gerar mapa de calor' });
    }
  });


  router.get('/cs/raio-x/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Raio-X não encontrado' });
      res.json({ success: true, raio_x: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao buscar Raio-X:', error);
      res.status(500).json({ error: 'Erro ao buscar Raio-X' });
    }
  });

  router.get('/cs/raio-x/historico/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      const result = await pool.query(
        `SELECT id, data_inicio, data_fim, tipo_analise, score_saude, gerado_por_nome, tokens_utilizados, created_at
         FROM cs_raio_x_historico WHERE cod_cliente = $1 ORDER BY created_at DESC LIMIT 20`, [cod]
      );
      res.json({ success: true, historico: result.rows });
    } catch (error) {
      console.error('❌ Erro ao buscar histórico Raio-X:', error);
      res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
  });

  // ==================== PUT /cs/raio-x/:id ====================
  router.put('/cs/raio-x/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
      const { analise_texto } = req.body;
      if (!analise_texto) return res.status(400).json({ error: 'Texto da análise é obrigatório' });
      const result = await pool.query(
        'UPDATE cs_raio_x_historico SET analise_texto = $1 WHERE id = $2 RETURNING id',
        [analise_texto, id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Relatório não encontrado' });
      console.log(`✏️ Raio-X #${id} editado`);
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao editar Raio-X:', error);
      res.status(500).json({ error: 'Erro ao editar relatório' });
    }
  });

  // ==================== DELETE /cs/raio-x/:id ====================
  router.delete('/cs/raio-x/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
      const result = await pool.query('DELETE FROM cs_raio_x_historico WHERE id = $1 RETURNING id', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Relatório não encontrado' });
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao excluir Raio-X:', error);
      res.status(500).json({ error: 'Erro ao excluir relatório' });
    }
  });

  // ==================== POST /cs/raio-x/enviar-email ====================
  router.post('/cs/raio-x/enviar-email', async (req, res) => {
    try {
      const { raio_x_id, para, cc, remetente } = req.body;
      if (!para) return res.status(400).json({ error: 'Email destinatário é obrigatório' });

      // Buscar raio-x do banco
      let raioX, cliente, periodo;

      if (raio_x_id) {
        // Enviar de um relatório salvo
        const rxResult = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [raio_x_id]);
        if (rxResult.rows.length === 0) return res.status(404).json({ error: 'Relatório não encontrado' });
        const rx = rxResult.rows[0];
        raioX = rx;
        cliente = { nome: rx.nome_cliente };
        periodo = { inicio: rx.data_inicio, fim: rx.data_fim };
      } else if (req.body.analise) {
        // Enviar da sessão atual (relatório acabou de ser gerado)
        raioX = { analise_texto: req.body.analise, score_saude: req.body.health_score };
        cliente = { nome: req.body.nome_cliente || 'Cliente' };
        periodo = { inicio: req.body.data_inicio, fim: req.body.data_fim };
      } else {
        return res.status(400).json({ error: 'Informe raio_x_id ou analise' });
      }

      const result = await enviarRaioXEmail({ para, cc, raioX, cliente, periodo, remetente });
      console.log(`📧 Raio-X enviado por email: ${para} (${result.messageId})`);
      res.json({ success: true, messageId: result.messageId });
    } catch (error) {
      console.error('❌ Erro ao enviar email Raio-X:', error.message);
      res.status(500).json({ error: `Erro ao enviar email: ${error.message}` });
    }
  });

  return router;
}

module.exports = { createRaioXRoutes };
