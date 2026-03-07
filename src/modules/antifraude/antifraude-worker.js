/**
 * antifraude-worker.js
 * Orquestra análise de fraude direto na bi_entregas (sem Playwright).
 * Roda via cron automático e/ou botão manual.
 */

'use strict';

const { logger } = require('../../config/logger');
const { analisarFraudes } = require('./antifraude-detector');

let workerAtivo = false;
let cronInterval = null;

function log(msg) {
  logger.info(`[antifraude-worker] ${msg}`);
}

async function carregarConfig(pool) {
  try {
    const { rows } = await pool.query('SELECT chave, valor FROM antifraude_config');
    const config = {};
    rows.forEach(r => { config[r.chave] = r.valor; });
    return config;
  } catch {
    return {
      janela_dias: '7',
      cron_ativo: 'true',
      cron_intervalo_min: '60',
      threshold_reincidente: '3',
    };
  }
}

/**
 * Executa análise completa direto na bi_entregas.
 */
async function executarVarreduraCompleta(pool, tipo = 'manual', iniciadoPor = null) {
  const config = await carregarConfig(pool);

  const { rows } = await pool.query(
    `INSERT INTO antifraude_varreduras (tipo, status, iniciado_por)
     VALUES ($1, 'executando', $2)
     RETURNING id`,
    [tipo, iniciadoPor]
  );
  const varreduraId = rows[0].id;

  try {
    log(`🚀 Varredura #${varreduraId} (${tipo}) iniciada${iniciadoPor ? ` por ${iniciadoPor}` : ''}`);

    await pool.query(
      `UPDATE antifraude_varreduras SET detalhes = 'Analisando bi_entregas...' WHERE id = $1`,
      [varreduraId]
    );

    const result = await analisarFraudes(pool, varreduraId, config);

    await pool.query(
      `UPDATE antifraude_varreduras
       SET status = 'concluido', os_analisadas = $2, alertas_gerados = $3,
           detalhes = 'Concluído — consulta direta na bi_entregas', finalizado_em = NOW()
       WHERE id = $1`,
      [varreduraId, result.osAnalisadas, result.alertasGerados]
    );

    log(`✅ Varredura #${varreduraId} concluída: ${result.osAnalisadas} OS(s), ${result.alertasGerados} alerta(s)`);
    return { varreduraId, osAnalisadas: result.osAnalisadas, alertasGerados: result.alertasGerados };

  } catch (err) {
    log(`❌ Varredura #${varreduraId} falhou: ${err.message}`);
    await pool.query(
      `UPDATE antifraude_varreduras SET status = 'erro', erro = $2, finalizado_em = NOW() WHERE id = $1`,
      [varreduraId, err.message]
    ).catch(() => {});
    throw err;
  }
}

function startAntiFraudeWorker(pool) {
  if (workerAtivo) { log('⚠️ Worker já ativo'); return; }
  workerAtivo = true;

  (async () => {
    const config = await carregarConfig(pool);
    const cronAtivo = config.cron_ativo === 'true';
    const intervaloMin = parseInt(config.cron_intervalo_min) || 60;

    if (!cronAtivo) { log('⏸️ Cron anti-fraude desativado.'); return; }

    log(`🚀 Worker anti-fraude iniciado — cron a cada ${intervaloMin} min (consulta direta bi_entregas)`);

    // Primeira execução após 2 minutos
    setTimeout(async () => {
      try { await executarVarreduraCompleta(pool, 'cron'); }
      catch (err) { log(`❌ Cron inicial: ${err.message}`); }
    }, 2 * 60 * 1000);

    cronInterval = setInterval(async () => {
      try {
        const cfgAtual = await carregarConfig(pool);
        if (cfgAtual.cron_ativo !== 'true') { log('⏸️ Cron desativado'); return; }
        await executarVarreduraCompleta(pool, 'cron');
      } catch (err) { log(`❌ Cron: ${err.message}`); }
    }, intervaloMin * 60 * 1000);
  })();
}

module.exports = { startAntiFraudeWorker, executarVarreduraCompleta };
