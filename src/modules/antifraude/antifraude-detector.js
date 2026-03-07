/**
 * antifraude-detector.js
 * Analisa dados extraídos e detecta padrões de fraude/duplicação.
 *
 * Regras:
 * 1. Mesma NF/pedido para o MESMO motoboy em janela de tempo → fraude alta
 * 2. Mesma NF/pedido para o MESMO cliente em janela de tempo → fraude média
 * 3. Mesma NF/pedido repetida no mesmo dia (qualquer combinação) → fraude média
 * 4. Motoboy reincidente (>= threshold duplicatas) → fraude alta
 * 5. Cliente reincidente (>= threshold duplicatas) → fraude alta
 */

'use strict';

const { logger } = require('../../config/logger');

function log(msg) {
  logger.info(`[antifraude-detector] ${msg}`);
}

/**
 * Executa análise de fraude nos dados extraídos.
 * @param {object} pool - PostgreSQL pool
 * @param {number} varreduraId - ID da varredura
 * @param {object} config - { janela_dias, threshold_reincidente }
 * @returns {{ alertasGerados: number }}
 */
async function analisarFraudes(pool, varreduraId, config = {}) {
  const janelaDias = parseInt(config.janela_dias) || 7;
  const thresholdReincidente = parseInt(config.threshold_reincidente) || 3;

  log(`🔍 Analisando fraudes — janela: ${janelaDias} dias, threshold reincidente: ${thresholdReincidente}`);

  let alertasGerados = 0;

  // ── Regra 1: Mesma NF + mesmo motoboy na janela ──
  try {
    const { rows: dupMotoboyNf } = await pool.query(`
      SELECT numero_pedido_nf, profissional_cod, profissional_nome,
             array_agg(DISTINCT os_codigo) as os_codigos,
             COUNT(DISTINCT os_codigo) as qtd,
             MIN(data_solicitacao) as primeira_data,
             MAX(data_solicitacao) as ultima_data
      FROM antifraude_os_dados
      WHERE numero_pedido_nf IS NOT NULL
        AND numero_pedido_nf != ''
        AND profissional_cod IS NOT NULL
        AND extraido_em >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY numero_pedido_nf, profissional_cod, profissional_nome
      HAVING COUNT(DISTINCT os_codigo) > 1
      ORDER BY qtd DESC
    `, [janelaDias]);

    for (const dup of dupMotoboyNf) {
      // Verificar se já existe alerta para essa combinação
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_motoboy'
           AND profissional_cod = $1
           AND numeros_nf @> ARRAY[$2]::TEXT[]
           AND created_at >= NOW() - ($3 || ' days')::INTERVAL`,
        [dup.profissional_cod, dup.numero_pedido_nf, janelaDias]
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
          `NF ${dup.numero_pedido_nf} duplicada — Motoboy ${dup.profissional_nome || dup.profissional_cod}`,
          `A NF/pedido ${dup.numero_pedido_nf} aparece em ${dup.qtd} OS(s) diferentes para o mesmo motoboy (${dup.profissional_nome || dup.profissional_cod}) nos últimos ${janelaDias} dias.`,
          dup.os_codigos,
          [dup.numero_pedido_nf],
          dup.profissional_cod,
          dup.profissional_nome,
          JSON.stringify({ qtd: dup.qtd, primeira_data: dup.primeira_data, ultima_data: dup.ultima_data }),
          varreduraId,
        ]
      );
      alertasGerados++;
      log(`🚨 Alerta: NF ${dup.numero_pedido_nf} duplicada para motoboy ${dup.profissional_cod} (${dup.qtd}x)`);
    }
  } catch (err) {
    log(`❌ Erro regra 1: ${err.message}`);
  }

  // ── Regra 2: Mesma NF + mesmo cliente na janela ──
  try {
    const { rows: dupClienteNf } = await pool.query(`
      SELECT numero_pedido_nf, solicitante_cod, solicitante_nome,
             array_agg(DISTINCT os_codigo) as os_codigos,
             array_agg(DISTINCT profissional_nome) as motoboys,
             COUNT(DISTINCT os_codigo) as qtd
      FROM antifraude_os_dados
      WHERE numero_pedido_nf IS NOT NULL
        AND numero_pedido_nf != ''
        AND solicitante_cod IS NOT NULL
        AND extraido_em >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY numero_pedido_nf, solicitante_cod, solicitante_nome
      HAVING COUNT(DISTINCT os_codigo) > 1
      ORDER BY qtd DESC
    `, [janelaDias]);

    for (const dup of dupClienteNf) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_duplicada_cliente'
           AND solicitante_cod = $1
           AND numeros_nf @> ARRAY[$2]::TEXT[]
           AND created_at >= NOW() - ($3 || ' days')::INTERVAL`,
        [dup.solicitante_cod, dup.numero_pedido_nf, janelaDias]
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
          `NF ${dup.numero_pedido_nf} duplicada — Cliente ${dup.solicitante_nome || dup.solicitante_cod}`,
          `A NF/pedido ${dup.numero_pedido_nf} aparece em ${dup.qtd} OS(s) diferentes para o mesmo cliente (${dup.solicitante_nome}) com motoboys: ${dup.motoboys.filter(Boolean).join(', ')}.`,
          dup.os_codigos,
          [dup.numero_pedido_nf],
          null, null,
          JSON.stringify({ solicitante_cod: dup.solicitante_cod, qtd: dup.qtd, motoboys: dup.motoboys }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) {
    log(`❌ Erro regra 2: ${err.message}`);
  }

  // ── Regra 3: Mesma NF no mesmo dia (qualquer combinação) ──
  try {
    const { rows: dupDia } = await pool.query(`
      SELECT numero_pedido_nf, DATE(data_solicitacao) as dia,
             array_agg(DISTINCT os_codigo) as os_codigos,
             array_agg(DISTINCT profissional_nome) as motoboys,
             array_agg(DISTINCT solicitante_nome) as clientes,
             COUNT(DISTINCT os_codigo) as qtd
      FROM antifraude_os_dados
      WHERE numero_pedido_nf IS NOT NULL
        AND numero_pedido_nf != ''
        AND data_solicitacao IS NOT NULL
        AND extraido_em >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY numero_pedido_nf, DATE(data_solicitacao)
      HAVING COUNT(DISTINCT os_codigo) > 1
      ORDER BY qtd DESC
    `, [janelaDias]);

    for (const dup of dupDia) {
      const existe = await pool.query(
        `SELECT id FROM antifraude_alertas
         WHERE tipo = 'nf_mesmo_dia'
           AND numeros_nf @> ARRAY[$1]::TEXT[]
           AND dados_evidencia->>'dia' = $2
           AND created_at >= NOW() - ($3 || ' days')::INTERVAL`,
        [dup.numero_pedido_nf, dup.dia, janelaDias]
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
          `NF ${dup.numero_pedido_nf} — ${dup.qtd}x no mesmo dia (${dup.dia})`,
          `A NF/pedido ${dup.numero_pedido_nf} aparece ${dup.qtd} vezes no dia ${dup.dia}. Motoboys: ${dup.motoboys.filter(Boolean).join(', ')}. Clientes: ${dup.clientes.filter(Boolean).join(', ')}.`,
          dup.os_codigos,
          [dup.numero_pedido_nf],
          JSON.stringify({ dia: dup.dia, motoboys: dup.motoboys, clientes: dup.clientes }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) {
    log(`❌ Erro regra 3: ${err.message}`);
  }

  // ── Regra 4: Motoboy reincidente (muitas duplicatas) ──
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
          'motoboy_reincidente',
          'alta',
          `⚠️ Motoboy reincidente: ${r.profissional_nome || r.profissional_cod}`,
          `O motoboy ${r.profissional_nome} (cód: ${r.profissional_cod}) tem ${r.total_alertas} alertas de NF duplicada nos últimos ${janelaDias} dias. Padrão reincidente detectado.`,
          r.profissional_cod,
          r.profissional_nome,
          JSON.stringify({ total_alertas: r.total_alertas }),
          varreduraId,
        ]
      );
      alertasGerados++;
      log(`🚨 Motoboy reincidente: ${r.profissional_cod} (${r.total_alertas} alertas)`);
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
          'cliente_reincidente',
          'alta',
          `⚠️ Cliente reincidente: ${r.solicitante_nome || r.solicitante_cod}`,
          `O cliente ${r.solicitante_nome} (cód: ${r.solicitante_cod}) tem ${r.total_alertas} alertas de NF duplicada nos últimos ${janelaDias} dias.`,
          r.solicitante_cod,
          r.solicitante_nome,
          JSON.stringify({ total_alertas: r.total_alertas }),
          varreduraId,
        ]
      );
      alertasGerados++;
    }
  } catch (err) {
    log(`❌ Erro regra 5: ${err.message}`);
  }

  log(`✅ Análise concluída: ${alertasGerados} alerta(s) gerado(s)`);
  return { alertasGerados };
}

module.exports = { analisarFraudes };
