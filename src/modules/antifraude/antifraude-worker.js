/**
 * antifraude-worker.js (v3 — bi_entregas, com período configurável)
 */
'use strict';
const { logger } = require('../../config/logger');
const { analisarFraudes } = require('./antifraude-detector');

let workerAtivo = false;
function log(msg) { logger.info(`[antifraude-worker] ${msg}`); }

async function carregarConfig(pool) {
  try {
    const { rows } = await pool.query('SELECT chave, valor FROM antifraude_config');
    const config = {};
    rows.forEach(r => { config[r.chave] = r.valor; });
    return config;
  } catch {
    return { janela_dias: '7', cron_ativo: 'true', cron_intervalo_min: '60', threshold_reincidente: '3' };
  }
}

/**
 * Executa análise.
 * @param {string|null} dataInicio - 'YYYY-MM-DD' ou null (usa janela_dias)
 * @param {string|null} dataFim - 'YYYY-MM-DD' ou null
 */
async function executarVarreduraCompleta(pool, tipo = 'manual', iniciadoPor = null, dataInicio = null, dataFim = null) {
  const config = await carregarConfig(pool);

  const { rows } = await pool.query(
    `INSERT INTO antifraude_varreduras (tipo, status, iniciado_por, detalhes)
     VALUES ($1, 'executando', $2, $3) RETURNING id`,
    [tipo, iniciadoPor, dataInicio ? `Período: ${dataInicio} a ${dataFim}` : `Janela: ${config.janela_dias} dias`]
  );
  const varreduraId = rows[0].id;

  try {
    log(`🚀 Varredura #${varreduraId} (${tipo})${iniciadoPor ? ` por ${iniciadoPor}` : ''}${dataInicio ? ` — período ${dataInicio} a ${dataFim}` : ''}`);

    const result = await analisarFraudes(pool, varreduraId, {
      ...config,
      data_inicio: dataInicio,
      data_fim: dataFim,
    });

    await pool.query(
      `UPDATE antifraude_varreduras
       SET status = 'concluido', os_analisadas = $2, alertas_gerados = $3,
           detalhes = $4, finalizado_em = NOW()
       WHERE id = $1`,
      [varreduraId, result.osAnalisadas, result.alertasGerados,
       `Concluído — ${result.osAnalisadas} OSs, ${result.alertasGerados} alertas${dataInicio ? ` (${dataInicio} a ${dataFim})` : ''}`]
    );

    log(`✅ Varredura #${varreduraId}: ${result.osAnalisadas} OSs, ${result.alertasGerados} alertas`);
    return { varreduraId, ...result };

  } catch (err) {
    log(`❌ Varredura #${varreduraId}: ${err.message}`);
    await pool.query(
      `UPDATE antifraude_varreduras SET status = 'erro', erro = $2, finalizado_em = NOW() WHERE id = $1`,
      [varreduraId, err.message]
    ).catch(() => {});
    throw err;
  }
}

function startAntiFraudeWorker(pool) {
  if (workerAtivo) return;
  workerAtivo = true;

  (async () => {
    // Cron automático foi desligado a pedido — antifraude agora roda SÓ por ação manual
    // (via botão na UI → POST /antifraude/varredura). A função executarVarreduraCompleta
    // continua exportada abaixo, então os endpoints manuais continuam funcionando.
    //
    // Pra reativar: remover o early return abaixo E setar config `cron_ativo = 'true'` no banco.
    log('⏸️ Cron automático desativado — varredura só via ação manual');
    return;

    // eslint-disable-next-line no-unreachable
    const config = await carregarConfig(pool);
    if (config.cron_ativo !== 'true') { log('⏸️ Cron desativado'); return; }
    const intervaloMin = parseInt(config.cron_intervalo_min) || 60;

    log(`🚀 Worker iniciado — cron a cada ${intervaloMin} min (bi_entregas direto)`);

    setTimeout(async () => {
      try { await executarVarreduraCompleta(pool, 'cron'); }
      catch (err) { log(`❌ Cron inicial: ${err.message}`); }
    }, 2 * 60 * 1000);

    setInterval(async () => {
      try {
        const cfg = await carregarConfig(pool);
        if (cfg.cron_ativo !== 'true') return;
        await executarVarreduraCompleta(pool, 'cron');
      } catch (err) { log(`❌ Cron: ${err.message}`); }
    }, intervaloMin * 60 * 1000);
  })();
}

module.exports = { startAntiFraudeWorker, executarVarreduraCompleta };
