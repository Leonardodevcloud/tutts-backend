/**
 * agent-worker.js
 * Worker assíncrono: processa a fila ajustes_automaticos a cada 10s.
 * Processa 1 registro por vez — nunca abre Playwright em paralelo.
 */

'use strict';

const { logger } = require('../../config/logger');
const { normalizeLocation }        = require('./location-normalizer');
const { executarCorrecaoEndereco } = require('./playwright-agent');

const INTERVALO_MS = 10_000;
let   workerAtivo  = false;

function log(msg) {
  logger.info(`[agent-worker] ${msg}`);
}

async function processarProximoPendente(pool) {
  let registro = null;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM ajustes_automaticos
       WHERE status = 'pendente'
       ORDER BY criado_em ASC
       LIMIT 1`
    );

    if (rows.length === 0) return;

    registro = rows[0];
    log(`📋 Processando ID ${registro.id} — OS ${registro.os_numero} — Ponto ${registro.ponto}`);

    // Marcar como processando (evitar duplo processamento)
    await pool.query(
      `UPDATE ajustes_automaticos SET status = 'processando' WHERE id = $1`,
      [registro.id]
    );

    // Normalizar localização
    let coords;
    try {
      coords = await normalizeLocation(registro.localizacao_raw);
      log(`📍 Coords: ${coords.latitude}, ${coords.longitude}`);
    } catch (err) {
      log(`❌ Normalização falhou: ${err.message}`);
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
         WHERE id = $2`,
        [`[Normalização] ${err.message}`, registro.id]
      );
      return;
    }

    // Salvar coords extraídas
    await pool.query(
      `UPDATE ajustes_automaticos SET latitude = $1, longitude = $2 WHERE id = $3`,
      [coords.latitude, coords.longitude, registro.id]
    );

    // Executar Playwright
    log(`🤖 Acionando Playwright para OS ${registro.os_numero}...`);
    const resultado = await executarCorrecaoEndereco({
      os_numero:  registro.os_numero,
      ponto:      registro.ponto,
      latitude:   coords.latitude,
      longitude:  coords.longitude,
    });

    if (resultado.sucesso) {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'sucesso', processado_em = NOW()
         WHERE id = $1`,
        [registro.id]
      );
      log(`✅ ID ${registro.id} concluído.`);
    } else {
      const detalhe = resultado.screenshot
        ? `${resultado.erro} [Screenshot: ${resultado.screenshot}]`
        : resultado.erro;
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
         WHERE id = $2`,
        [detalhe, registro.id]
      );
      log(`❌ ID ${registro.id} erro: ${resultado.erro}`);
    }

  } catch (err) {
    log(`💥 Erro crítico: ${err.message}`);
    if (registro?.id) {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'erro', detalhe_erro = $1, processado_em = NOW()
         WHERE id = $2`,
        [`[Worker] ${err.message}`, registro.id]
      ).catch(() => {});
    }
  }
}

function startAgentWorker(pool) {
  if (workerAtivo) {
    log('⚠️  Worker já ativo, ignorando.');
    return;
  }
  workerAtivo = true;
  log('🚀 Worker iniciado — verificando fila a cada 10s...');

  setInterval(async () => {
    try {
      await processarProximoPendente(pool);
    } catch (err) {
      log(`💥 Exceção no ciclo: ${err.message}`);
    }
  }, INTERVALO_MS);
}

module.exports = { startAgentWorker };
