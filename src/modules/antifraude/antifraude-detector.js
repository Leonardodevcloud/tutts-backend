/**
 * antifraude-detector.js  (v3 — bi_entregas direto, dados claros)
 */
'use strict';
const { logger } = require('../../config/logger');
function log(msg) { logger.info(`[antifraude-detector] ${msg}`); }

/**
 * @param {object} pool
 * @param {number} varreduraId
 * @param {object} config - { janela_dias, threshold_reincidente, data_inicio, data_fim }
 */
async function analisarFraudes(pool, varreduraId, config = {}) {
  const janelaDias = parseInt(config.janela_dias) || 7;
  const thresholdReincidente = parseInt(config.threshold_reincidente) || 3;
  const dataInicio = config.data_inicio || null;
  const dataFim = config.data_fim || null;

  // Montar filtro de data
  let filtroData = '';
  const paramsBase = [];
  if (dataInicio && dataFim) {
    paramsBase.push(dataInicio, dataFim);
    filtroData = `AND data_solicitado >= $1 AND data_solicitado <= $2`;
  } else {
    paramsBase.push(janelaDias);
    filtroData = `AND data_solicitado >= CURRENT_DATE - $1::int`;
  }

  log(`🔍 Analisando fraudes — ${dataInicio ? `período: ${dataInicio} a ${dataFim}` : `janela: ${janelaDias} dias`}, threshold: ${thresholdReincidente}`);

  let alertasGerados = 0;
  let osAnalisadas = 0;

  // Contar OSs
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT os) as total FROM bi_entregas
       WHERE num_pedido IS NOT NULL AND num_pedido != '' ${filtroData}`,
      paramsBase
    );
    osAnalisadas = parseInt(rows[0]?.total) || 0;
    log(`📊 ${osAnalisadas} OS(s) com NF/pedido no período`);
  } catch (err) { log(`❌ Erro contagem: ${err.message}`); }

  // ── Regra 1: Mesma NF + mesmo motoboy ──
  try {
    const { rows } = await pool.query(`
      SELECT num_pedido, cod_prof, nome_prof,
             array_agg(DISTINCT os::TEXT ORDER BY os::TEXT) as os_codigos,
             COUNT(DISTINCT os) as qtd,
             TO_CHAR(MIN(data_solicitado), 'DD/MM/YYYY') as primeira_data,
             TO_CHAR(MAX(data_solicitado), 'DD/MM/YYYY') as ultima_data,
             array_agg(DISTINCT nome_cliente ORDER BY nome_cliente) as clientes
      FROM bi_entregas
      WHERE num_pedido IS NOT NULL AND num_pedido != ''
        AND cod_prof IS NOT NULL ${filtroData}
      GROUP BY num_pedido, cod_prof, nome_prof
      HAVING COUNT(DISTINCT os) > 1
      ORDER BY qtd DESC
    `, paramsBase);

    for (const d of rows) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_motoboy' AND profissional_cod = $1
           AND numeros_nf @> ARRAY[$2]::TEXT[]
           AND created_at >= NOW() - INTERVAL '1 day'`,
        [String(d.cod_prof), d.num_pedido]
      );
      if (existe.rows.length > 0) continue;

      const clientesStr = (d.clientes || []).filter(Boolean).join(', ');
      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          profissional_cod, profissional_nome, solicitante_nome, dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          'nf_duplicada_motoboy', 'alta',
          `NF ${d.num_pedido} duplicada — ${d.nome_prof || 'Cód ' + d.cod_prof} (${d.qtd}x)`,
          `🏍️ Motoboy: ${d.nome_prof || '—'} (Cód: ${d.cod_prof})\n📝 NF/Pedido: ${d.num_pedido}\n📦 OSs: ${d.os_codigos.join(', ')}\n🏢 Clientes: ${clientesStr || '—'}\n📅 Período: ${d.primeira_data} a ${d.ultima_data}\n⚠️ ${d.qtd} ocorrência(s)`,
          d.os_codigos, [d.num_pedido],
          String(d.cod_prof), d.nome_prof, clientesStr,
          JSON.stringify({ qtd: d.qtd, primeira_data: d.primeira_data, ultima_data: d.ultima_data, clientes: d.clientes }),
          varreduraId,
        ]
      );
      alertasGerados++;
      log(`🚨 NF ${d.num_pedido} duplicada motoboy ${d.cod_prof} - ${d.nome_prof} (${d.qtd}x)`);
    }
  } catch (err) { log(`❌ Erro regra 1: ${err.message}`); }

  // ── Regra 2: Mesma NF + mesmo cliente ──
  try {
    const { rows } = await pool.query(`
      SELECT num_pedido, cod_cliente, nome_cliente,
             array_agg(DISTINCT os::TEXT ORDER BY os::TEXT) as os_codigos,
             array_agg(DISTINCT nome_prof ORDER BY nome_prof) as motoboys,
             array_agg(DISTINCT cod_prof::TEXT ORDER BY cod_prof::TEXT) as motoboys_cod,
             COUNT(DISTINCT os) as qtd,
             TO_CHAR(MIN(data_solicitado), 'DD/MM/YYYY') as primeira_data,
             TO_CHAR(MAX(data_solicitado), 'DD/MM/YYYY') as ultima_data
      FROM bi_entregas
      WHERE num_pedido IS NOT NULL AND num_pedido != ''
        AND cod_cliente IS NOT NULL ${filtroData}
      GROUP BY num_pedido, cod_cliente, nome_cliente
      HAVING COUNT(DISTINCT os) > 1
      ORDER BY qtd DESC
    `, paramsBase);

    for (const d of rows) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_cliente' AND solicitante_cod = $1
           AND numeros_nf @> ARRAY[$2]::TEXT[]
           AND created_at >= NOW() - INTERVAL '1 day'`,
        [String(d.cod_cliente), d.num_pedido]
      );
      if (existe.rows.length > 0) continue;

      const motoboysList = (d.motoboys || []).filter(Boolean).map((nome, i) => `${nome} (${d.motoboys_cod[i] || '—'})`).join(', ');
      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          solicitante_cod, solicitante_nome, profissional_nome, dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          'nf_duplicada_cliente', 'media',
          `NF ${d.num_pedido} duplicada — Cliente ${d.nome_cliente || 'Cód ' + d.cod_cliente} (${d.qtd}x)`,
          `🏢 Cliente: ${d.nome_cliente || '—'} (Cód: ${d.cod_cliente})\n📝 NF/Pedido: ${d.num_pedido}\n📦 OSs: ${d.os_codigos.join(', ')}\n🏍️ Motoboys: ${motoboysList || '—'}\n📅 Período: ${d.primeira_data} a ${d.ultima_data}\n⚠️ ${d.qtd} ocorrência(s)`,
          d.os_codigos, [d.num_pedido],
          String(d.cod_cliente), d.nome_cliente, motoboysList,
          JSON.stringify({ qtd: d.qtd, motoboys: d.motoboys, motoboys_cod: d.motoboys_cod }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) { log(`❌ Erro regra 2: ${err.message}`); }

  // ── Regra 3: Mesma NF no mesmo dia ──
  try {
    const { rows } = await pool.query(`
      SELECT num_pedido, data_solicitado,
             TO_CHAR(data_solicitado, 'DD/MM/YYYY') as dia_fmt,
             array_agg(DISTINCT os::TEXT ORDER BY os::TEXT) as os_codigos,
             array_agg(DISTINCT nome_prof ORDER BY nome_prof) as motoboys,
             array_agg(DISTINCT nome_cliente ORDER BY nome_cliente) as clientes,
             COUNT(DISTINCT os) as qtd
      FROM bi_entregas
      WHERE num_pedido IS NOT NULL AND num_pedido != '' ${filtroData}
      GROUP BY num_pedido, data_solicitado
      HAVING COUNT(DISTINCT os) > 1
      ORDER BY qtd DESC
    `, paramsBase);

    for (const d of rows) {
      const diaStr = d.data_solicitado ? new Date(d.data_solicitado).toISOString().split('T')[0] : '';
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_mesmo_dia' AND numeros_nf @> ARRAY[$1]::TEXT[]
           AND dados_evidencia->>'dia' = $2
           AND created_at >= NOW() - INTERVAL '1 day'`,
        [d.num_pedido, diaStr]
      );
      if (existe.rows.length > 0) continue;

      const motoboysList = (d.motoboys || []).filter(Boolean).join(', ');
      const clientesList = (d.clientes || []).filter(Boolean).join(', ');
      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          'nf_mesmo_dia', 'media',
          `NF ${d.num_pedido} — ${d.qtd}x no dia ${d.dia_fmt}`,
          `📅 Dia: ${d.dia_fmt}\n📝 NF/Pedido: ${d.num_pedido}\n📦 OSs: ${d.os_codigos.join(', ')}\n🏍️ Motoboys: ${motoboysList || '—'}\n🏢 Clientes: ${clientesList || '—'}\n⚠️ ${d.qtd} ocorrência(s) no mesmo dia`,
          d.os_codigos, [d.num_pedido],
          JSON.stringify({ dia: diaStr, dia_fmt: d.dia_fmt, motoboys: d.motoboys, clientes: d.clientes }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) { log(`❌ Erro regra 3: ${err.message}`); }

  // ── Regra 4: Motoboy reincidente ──
  try {
    const { rows } = await pool.query(`
      SELECT profissional_cod, profissional_nome, COUNT(*) as total_alertas
      FROM antifraude_alertas
      WHERE tipo = 'nf_duplicada_motoboy' AND profissional_cod IS NOT NULL
        AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY profissional_cod, profissional_nome
      HAVING COUNT(*) >= $2
    `, [janelaDias, thresholdReincidente]);

    for (const r of rows) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'motoboy_reincidente' AND profissional_cod = $1
           AND created_at >= NOW() - INTERVAL '1 day'`,
        [r.profissional_cod]
      );
      if (existe.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, profissional_cod, profissional_nome,
          dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          'motoboy_reincidente', 'alta',
          `⚠️ Motoboy reincidente: ${r.profissional_nome || r.profissional_cod}`,
          `🏍️ Motoboy: ${r.profissional_nome || '—'} (Cód: ${r.profissional_cod})\n🚨 ${r.total_alertas} alerta(s) de NF duplicada nos últimos ${janelaDias} dias\n⚠️ Padrão reincidente detectado — requer investigação`,
          r.profissional_cod, r.profissional_nome,
          JSON.stringify({ total_alertas: r.total_alertas }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) { log(`❌ Erro regra 4: ${err.message}`); }

  // ── Regra 5: Cliente reincidente ──
  try {
    const { rows } = await pool.query(`
      SELECT solicitante_cod, solicitante_nome, COUNT(*) as total_alertas
      FROM antifraude_alertas
      WHERE tipo = 'nf_duplicada_cliente' AND solicitante_cod IS NOT NULL
        AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY solicitante_cod, solicitante_nome
      HAVING COUNT(*) >= $2
    `, [janelaDias, thresholdReincidente]);

    for (const r of rows) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'cliente_reincidente' AND solicitante_cod = $1
           AND created_at >= NOW() - INTERVAL '1 day'`,
        [r.solicitante_cod]
      );
      if (existe.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, solicitante_cod, solicitante_nome,
          dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          'cliente_reincidente', 'alta',
          `⚠️ Cliente reincidente: ${r.solicitante_nome || r.solicitante_cod}`,
          `🏢 Cliente: ${r.solicitante_nome || '—'} (Cód: ${r.solicitante_cod})\n🚨 ${r.total_alertas} alerta(s) de NF duplicada nos últimos ${janelaDias} dias\n⚠️ Padrão reincidente detectado — requer investigação`,
          r.solicitante_cod, r.solicitante_nome,
          JSON.stringify({ total_alertas: r.total_alertas }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) { log(`❌ Erro regra 5: ${err.message}`); }

  log(`✅ Análise: ${alertasGerados} alerta(s), ${osAnalisadas} OS(s)`);
  return { alertasGerados, osAnalisadas };
}

module.exports = { analisarFraudes };
