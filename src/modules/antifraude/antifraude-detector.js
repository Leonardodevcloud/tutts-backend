/**
 * antifraude-detector.js (v4 — alertas AGRUPADOS por motoboy e por cliente)
 *
 * Em vez de 1 alerta por NF, agrupa TODAS as NFs duplicadas de um motoboy num único alerta,
 * e TODAS as NFs duplicadas de um cliente em outro alerta.
 */
'use strict';
const { logger } = require('../../config/logger');
function log(msg) { logger.info(`[antifraude-detector] ${msg}`); }

async function analisarFraudes(pool, varreduraId, config = {}) {
  const janelaDias = parseInt(config.janela_dias) || 7;
  const dataInicio = config.data_inicio || null;
  const dataFim = config.data_fim || null;

  let filtroData = '';
  const paramsBase = [];
  if (dataInicio && dataFim) {
    paramsBase.push(dataInicio, dataFim);
    filtroData = `AND data_solicitado >= $1 AND data_solicitado <= $2`;
  } else {
    paramsBase.push(janelaDias);
    filtroData = `AND data_solicitado >= CURRENT_DATE - $1::int`;
  }

  const periodo = dataInicio ? `${dataInicio} a ${dataFim}` : `últimos ${janelaDias} dias`;
  log(`🔍 Analisando fraudes — ${periodo}`);

  let alertasGerados = 0;
  let osAnalisadas = 0;

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT os) as total FROM bi_entregas
       WHERE num_pedido IS NOT NULL AND num_pedido != '' ${filtroData}`, paramsBase
    );
    osAnalisadas = parseInt(rows[0]?.total) || 0;
    log(`📊 ${osAnalisadas} OS(s) com NF/pedido no período`);
  } catch (err) { log(`❌ Contagem: ${err.message}`); }

  // ══════════════════════════════════════════════
  // REGRA 1: NFs duplicadas AGRUPADAS POR MOTOBOY
  // Um único alerta por motoboy com TODAS as NFs suspeitas
  // ══════════════════════════════════════════════
  try {
    // Primeiro: encontrar motoboys com NFs duplicadas
    const { rows: motoboys } = await pool.query(`
      SELECT cod_prof, nome_prof
      FROM (
        SELECT num_pedido, cod_prof, nome_prof, COUNT(DISTINCT os) as qtd
        FROM bi_entregas
        WHERE num_pedido IS NOT NULL AND num_pedido != ''
          AND cod_prof IS NOT NULL ${filtroData}
        GROUP BY num_pedido, cod_prof, nome_prof
        HAVING COUNT(DISTINCT os) > 1
      ) sub
      GROUP BY cod_prof, nome_prof
      ORDER BY COUNT(*) DESC
    `, paramsBase);

    for (const mb of motoboys) {
      // Verificar se já existe alerta para este motoboy hoje
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_motoboy' AND profissional_cod = $1
           AND created_at >= NOW() - INTERVAL '1 day'`,
        [String(mb.cod_prof)]
      );
      if (existe.rows.length > 0) continue;

      // Buscar TODAS as NFs duplicadas desse motoboy
      const { rows: nfsDup } = await pool.query(`
        SELECT num_pedido,
               array_agg(DISTINCT os::TEXT ORDER BY os::TEXT) as os_list,
               COUNT(DISTINCT os) as qtd_os,
               TO_CHAR(MIN(data_solicitado), 'DD/MM/YYYY') as primeira,
               TO_CHAR(MAX(data_solicitado), 'DD/MM/YYYY') as ultima,
               array_agg(DISTINCT nome_cliente ORDER BY nome_cliente) as clientes
        FROM bi_entregas
        WHERE num_pedido IS NOT NULL AND num_pedido != ''
          AND cod_prof = ${dataInicio ? '$3' : '$2'} ${filtroData}
        GROUP BY num_pedido
        HAVING COUNT(DISTINCT os) > 1
        ORDER BY COUNT(DISTINCT os) DESC
      `, dataInicio ? [dataInicio, dataFim, mb.cod_prof] : [janelaDias, mb.cod_prof]);

      if (nfsDup.length === 0) continue;

      // Montar descrição rica
      const todasOs = [...new Set(nfsDup.flatMap(n => n.os_list))];
      const todasNfs = nfsDup.map(n => n.num_pedido);
      const todosClientes = [...new Set(nfsDup.flatMap(n => n.clientes).filter(Boolean))];
      const totalDups = nfsDup.reduce((s, n) => s + parseInt(n.qtd_os), 0);

      let desc = `🏍️ *Motoboy:* ${mb.nome_prof || '—'} (Cód: ${mb.cod_prof})\n`;
      desc += `🚨 *${nfsDup.length} NF(s) duplicada(s)* em ${todasOs.length} OS(s)\n`;
      desc += `📅 Período: ${periodo}\n\n`;

      nfsDup.forEach((nf, i) => {
        desc += `${i + 1}. NF ${nf.num_pedido} → ${nf.qtd_os}x (OSs: ${nf.os_list.join(', ')})\n`;
        desc += `   Clientes: ${nf.clientes.filter(Boolean).join(', ')}\n`;
        desc += `   Período: ${nf.primeira} a ${nf.ultima}\n`;
      });

      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          profissional_cod, profissional_nome, solicitante_nome, dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          'nf_duplicada_motoboy', 'alta',
          `🏍️ ${mb.nome_prof || 'Cód ' + mb.cod_prof} — ${nfsDup.length} NF(s) duplicada(s)`,
          desc,
          todasOs, todasNfs,
          String(mb.cod_prof), mb.nome_prof,
          todosClientes.join(', '),
          JSON.stringify({ total_nfs: nfsDup.length, total_os: todasOs.length, total_duplicacoes: totalDups, detalhes: nfsDup }),
          varreduraId,
        ]
      );
      alertasGerados++;
      log(`🚨 Motoboy ${mb.cod_prof} - ${mb.nome_prof}: ${nfsDup.length} NF(s) duplicada(s)`);
    }
  } catch (err) { log(`❌ Regra 1: ${err.message}`); }

  // ══════════════════════════════════════════════
  // REGRA 2: NFs duplicadas AGRUPADAS POR CLIENTE
  // Um único alerta por cliente com TODAS as NFs suspeitas
  // ══════════════════════════════════════════════
  try {
    const { rows: clientes } = await pool.query(`
      SELECT cod_cliente, nome_cliente
      FROM (
        SELECT num_pedido, cod_cliente, nome_cliente, COUNT(DISTINCT os) as qtd
        FROM bi_entregas
        WHERE num_pedido IS NOT NULL AND num_pedido != ''
          AND cod_cliente IS NOT NULL ${filtroData}
        GROUP BY num_pedido, cod_cliente, nome_cliente
        HAVING COUNT(DISTINCT os) > 1
      ) sub
      GROUP BY cod_cliente, nome_cliente
      ORDER BY COUNT(*) DESC
    `, paramsBase);

    for (const cl of clientes) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_cliente' AND solicitante_cod = $1
           AND created_at >= NOW() - INTERVAL '1 day'`,
        [String(cl.cod_cliente)]
      );
      if (existe.rows.length > 0) continue;

      const { rows: nfsDup } = await pool.query(`
        SELECT num_pedido,
               array_agg(DISTINCT os::TEXT ORDER BY os::TEXT) as os_list,
               COUNT(DISTINCT os) as qtd_os,
               TO_CHAR(MIN(data_solicitado), 'DD/MM/YYYY') as primeira,
               TO_CHAR(MAX(data_solicitado), 'DD/MM/YYYY') as ultima,
               array_agg(DISTINCT nome_prof ORDER BY nome_prof) as motoboys
        FROM bi_entregas
        WHERE num_pedido IS NOT NULL AND num_pedido != ''
          AND cod_cliente = ${dataInicio ? '$3' : '$2'} ${filtroData}
        GROUP BY num_pedido
        HAVING COUNT(DISTINCT os) > 1
        ORDER BY COUNT(DISTINCT os) DESC
      `, dataInicio ? [dataInicio, dataFim, cl.cod_cliente] : [janelaDias, cl.cod_cliente]);

      if (nfsDup.length === 0) continue;

      const todasOs = [...new Set(nfsDup.flatMap(n => n.os_list))];
      const todasNfs = nfsDup.map(n => n.num_pedido);
      const todosMotoboys = [...new Set(nfsDup.flatMap(n => n.motoboys).filter(Boolean))];

      let desc = `🏢 *Cliente:* ${cl.nome_cliente || '—'} (Cód: ${cl.cod_cliente})\n`;
      desc += `🚨 *${nfsDup.length} NF(s) duplicada(s)* em ${todasOs.length} OS(s)\n`;
      desc += `📅 Período: ${periodo}\n\n`;

      nfsDup.forEach((nf, i) => {
        desc += `${i + 1}. NF ${nf.num_pedido} → ${nf.qtd_os}x (OSs: ${nf.os_list.join(', ')})\n`;
        desc += `   Motoboys: ${nf.motoboys.filter(Boolean).join(', ')}\n`;
        desc += `   Período: ${nf.primeira} a ${nf.ultima}\n`;
      });

      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          solicitante_cod, solicitante_nome, profissional_nome, dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          'nf_duplicada_cliente', 'media',
          `🏢 ${cl.nome_cliente || 'Cód ' + cl.cod_cliente} — ${nfsDup.length} NF(s) duplicada(s)`,
          desc,
          todasOs, todasNfs,
          String(cl.cod_cliente), cl.nome_cliente,
          todosMotoboys.join(', '),
          JSON.stringify({ total_nfs: nfsDup.length, total_os: todasOs.length, detalhes: nfsDup }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) { log(`❌ Regra 2: ${err.message}`); }

  log(`✅ Análise: ${alertasGerados} alerta(s) agrupado(s), ${osAnalisadas} OS(s)`);
  return { alertasGerados, osAnalisadas };
}

module.exports = { analisarFraudes };
