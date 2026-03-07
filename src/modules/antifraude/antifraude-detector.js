/**
 * antifraude-detector.js
 * Analisa dados da bi_entregas diretamente (sem Playwright).
 * Detecta NFs/pedidos duplicados e padrões de fraude.
 *
 * Regras:
 * 1. Mesma NF/pedido para o MESMO motoboy em janela de tempo → severidade alta
 * 2. Mesma NF/pedido para o MESMO cliente em janela de tempo → severidade média
 * 3. Mesma NF/pedido repetida no mesmo dia → severidade média
 * 4. Motoboy reincidente (>= threshold duplicatas) → severidade alta
 * 5. Cliente reincidente (>= threshold duplicatas) → severidade alta
 */

'use strict';

const { logger } = require('../../config/logger');

function log(msg) {
  logger.info(`[antifraude-detector] ${msg}`);
}

/**
 * Executa análise de fraude consultando bi_entregas diretamente.
 * @param {object} pool - PostgreSQL pool
 * @param {number} varreduraId - ID da varredura
 * @param {object} config - { janela_dias, threshold_reincidente }
 * @returns {{ alertasGerados: number, osAnalisadas: number }}
 */
async function analisarFraudes(pool, varreduraId, config = {}) {
  const janelaDias = parseInt(config.janela_dias) || 7;
  const thresholdReincidente = parseInt(config.threshold_reincidente) || 3;

  log(`🔍 Analisando fraudes na bi_entregas — janela: ${janelaDias} dias, threshold: ${thresholdReincidente}`);

  let alertasGerados = 0;
  let osAnalisadas = 0;

  // Contar total de OSs no período
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT os) as total FROM bi_entregas
       WHERE data_solicitado >= CURRENT_DATE - $1::int
       AND num_pedido IS NOT NULL AND num_pedido != ''`,
      [janelaDias]
    );
    osAnalisadas = parseInt(rows[0]?.total) || 0;
    log(`📊 ${osAnalisadas} OS(s) com NF/pedido nos últimos ${janelaDias} dias`);
  } catch (err) {
    log(`❌ Erro ao contar OSs: ${err.message}`);
  }

  // ── Regra 1: Mesma NF + mesmo motoboy na janela ──
  try {
    const { rows: dupMotoboyNf } = await pool.query(`
      SELECT num_pedido, cod_prof, nome_prof,
             array_agg(DISTINCT os::TEXT) as os_codigos,
             COUNT(DISTINCT os) as qtd,
             MIN(data_solicitado) as primeira_data,
             MAX(data_solicitado) as ultima_data,
             array_agg(DISTINCT nome_cliente) as clientes
      FROM bi_entregas
      WHERE num_pedido IS NOT NULL AND num_pedido != ''
        AND cod_prof IS NOT NULL
        AND data_solicitado >= CURRENT_DATE - $1::int
      GROUP BY num_pedido, cod_prof, nome_prof
      HAVING COUNT(DISTINCT os) > 1
      ORDER BY qtd DESC
    `, [janelaDias]);

    for (const dup of dupMotoboyNf) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_motoboy'
           AND profissional_cod = $1
           AND numeros_nf @> ARRAY[$2]::TEXT[]
           AND created_at >= NOW() - ($3 || ' days')::INTERVAL`,
        [String(dup.cod_prof), dup.num_pedido, janelaDias]
      );
      if (existe.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          profissional_cod, profissional_nome, dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          'nf_duplicada_motoboy',
          'alta',
          `NF ${dup.num_pedido} duplicada — Motoboy ${dup.nome_prof || dup.cod_prof}`,
          `A NF/pedido ${dup.num_pedido} aparece em ${dup.qtd} OS(s) diferentes para o mesmo motoboy (${dup.nome_prof || dup.cod_prof}) nos últimos ${janelaDias} dias. Clientes: ${(dup.clientes || []).filter(Boolean).join(', ')}.`,
          dup.os_codigos,
          [dup.num_pedido],
          String(dup.cod_prof),
          dup.nome_prof,
          JSON.stringify({ qtd: dup.qtd, primeira_data: dup.primeira_data, ultima_data: dup.ultima_data, clientes: dup.clientes }),
          varreduraId,
        ]
      );
      alertasGerados++;
      log(`🚨 NF ${dup.num_pedido} duplicada para motoboy ${dup.cod_prof} (${dup.qtd}x)`);
    }
  } catch (err) {
    log(`❌ Erro regra 1: ${err.message}`);
  }

  // ── Regra 2: Mesma NF + mesmo cliente na janela ──
  try {
    const { rows: dupClienteNf } = await pool.query(`
      SELECT num_pedido, cod_cliente, nome_cliente,
             array_agg(DISTINCT os::TEXT) as os_codigos,
             array_agg(DISTINCT nome_prof) as motoboys,
             COUNT(DISTINCT os) as qtd
      FROM bi_entregas
      WHERE num_pedido IS NOT NULL AND num_pedido != ''
        AND cod_cliente IS NOT NULL
        AND data_solicitado >= CURRENT_DATE - $1::int
      GROUP BY num_pedido, cod_cliente, nome_cliente
      HAVING COUNT(DISTINCT os) > 1
      ORDER BY qtd DESC
    `, [janelaDias]);

    for (const dup of dupClienteNf) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_cliente'
           AND solicitante_cod = $1
           AND numeros_nf @> ARRAY[$2]::TEXT[]
           AND created_at >= NOW() - ($3 || ' days')::INTERVAL`,
        [String(dup.cod_cliente), dup.num_pedido, janelaDias]
      );
      if (existe.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          solicitante_cod, solicitante_nome, dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          'nf_duplicada_cliente',
          'media',
          `NF ${dup.num_pedido} duplicada — Cliente ${dup.nome_cliente || dup.cod_cliente}`,
          `A NF/pedido ${dup.num_pedido} aparece em ${dup.qtd} OS(s) diferentes para o mesmo cliente (${dup.nome_cliente}) com motoboys: ${(dup.motoboys || []).filter(Boolean).join(', ')}.`,
          dup.os_codigos,
          [dup.num_pedido],
          String(dup.cod_cliente),
          dup.nome_cliente,
          JSON.stringify({ qtd: dup.qtd, motoboys: dup.motoboys }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) {
    log(`❌ Erro regra 2: ${err.message}`);
  }

  // ── Regra 3: Mesma NF no mesmo dia ──
  try {
    const { rows: dupDia } = await pool.query(`
      SELECT num_pedido, data_solicitado as dia,
             array_agg(DISTINCT os::TEXT) as os_codigos,
             array_agg(DISTINCT nome_prof) as motoboys,
             array_agg(DISTINCT nome_cliente) as clientes,
             COUNT(DISTINCT os) as qtd
      FROM bi_entregas
      WHERE num_pedido IS NOT NULL AND num_pedido != ''
        AND data_solicitado >= CURRENT_DATE - $1::int
      GROUP BY num_pedido, data_solicitado
      HAVING COUNT(DISTINCT os) > 1
      ORDER BY qtd DESC
    `, [janelaDias]);

    for (const dup of dupDia) {
      const diaStr = dup.dia ? new Date(dup.dia).toISOString().split('T')[0] : '';
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_mesmo_dia'
           AND numeros_nf @> ARRAY[$1]::TEXT[]
           AND dados_evidencia->>'dia' = $2
           AND created_at >= NOW() - ($3 || ' days')::INTERVAL`,
        [dup.num_pedido, diaStr, janelaDias]
      );
      if (existe.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO antifraude_alertas
         (tipo, severidade, titulo, descricao, os_codigos, numeros_nf,
          dados_evidencia, varredura_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          'nf_mesmo_dia',
          'media',
          `NF ${dup.num_pedido} — ${dup.qtd}x no mesmo dia (${diaStr})`,
          `A NF/pedido ${dup.num_pedido} aparece ${dup.qtd} vezes no dia ${diaStr}. Motoboys: ${(dup.motoboys || []).filter(Boolean).join(', ')}. Clientes: ${(dup.clientes || []).filter(Boolean).join(', ')}.`,
          dup.os_codigos,
          [dup.num_pedido],
          JSON.stringify({ dia: diaStr, motoboys: dup.motoboys, clientes: dup.clientes }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) {
    log(`❌ Erro regra 3: ${err.message}`);
  }

  // ── Regra 4: Motoboy reincidente ──
  try {
    const { rows: reincidentes } = await pool.query(`
      SELECT profissional_cod, profissional_nome, COUNT(*) as total_alertas
      FROM antifraude_alertas
      WHERE tipo = 'nf_duplicada_motoboy'
        AND profissional_cod IS NOT NULL
        AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY profissional_cod, profissional_nome
      HAVING COUNT(*) >= $2
    `, [janelaDias, thresholdReincidente]);

    for (const r of reincidentes) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'motoboy_reincidente'
           AND profissional_cod = $1
           AND created_at >= NOW() - ($2 || ' days')::INTERVAL`,
        [r.profissional_cod, janelaDias]
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
          `O motoboy ${r.profissional_nome} (cód: ${r.profissional_cod}) tem ${r.total_alertas} alertas de NF duplicada nos últimos ${janelaDias} dias.`,
          r.profissional_cod, r.profissional_nome,
          JSON.stringify({ total_alertas: r.total_alertas }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) {
    log(`❌ Erro regra 4: ${err.message}`);
  }

  // ── Regra 5: Cliente reincidente ──
  try {
    const { rows: reincidentesCli } = await pool.query(`
      SELECT solicitante_cod, solicitante_nome, COUNT(*) as total_alertas
      FROM antifraude_alertas
      WHERE tipo = 'nf_duplicada_cliente'
        AND solicitante_cod IS NOT NULL
        AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY solicitante_cod, solicitante_nome
      HAVING COUNT(*) >= $2
    `, [janelaDias, thresholdReincidente]);

    for (const r of reincidentesCli) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'cliente_reincidente'
           AND solicitante_cod = $1
           AND created_at >= NOW() - ($2 || ' days')::INTERVAL`,
        [r.solicitante_cod, janelaDias]
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
          `O cliente ${r.solicitante_nome} (cód: ${r.solicitante_cod}) tem ${r.total_alertas} alertas de NF duplicada nos últimos ${janelaDias} dias.`,
          r.solicitante_cod, r.solicitante_nome,
          JSON.stringify({ total_alertas: r.total_alertas }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) {
    log(`❌ Erro regra 5: ${err.message}`);
  }

  log(`✅ Análise concluída: ${alertasGerados} alerta(s) gerado(s), ${osAnalisadas} OS(s) analisadas`);
  return { alertasGerados, osAnalisadas };
}

module.exports = { analisarFraudes };
