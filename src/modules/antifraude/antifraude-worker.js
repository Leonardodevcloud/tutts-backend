/**
 * antifraude-worker.js
 * Orquestra: scanner Playwright → detector de fraudes.
 * Roda via cron automático e/ou botão manual.
 */

'use strict';

const { logger } = require('../../config/logger');
const { executarVarredura } = require('./antifraude-scanner');
const { analisarFraudes } = require('./antifraude-detector');

let workerAtivo = false;
let cronInterval = null;

function log(msg) {
  logger.info(`[antifraude-worker] ${msg}`);
}

/**
 * Carrega configs do banco.
 */
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
      max_paginas_concluidos: '3',
      threshold_reincidente: '3',
    };
  }
}

/**
 * Executa uma varredura completa (scanner + detector).
 * @param {object} pool
 * @param {string} tipo - 'manual' ou 'cron'
 * @param {string|null} iniciadoPor - nome do admin (se manual)
 */
async function executarVarreduraCompleta(pool, tipo = 'manual', iniciadoPor = null) {
  const config = await carregarConfig(pool);

  // Criar registro da varredura
  const { rows } = await pool.query(
    `INSERT INTO antifraude_varreduras (tipo, status, iniciado_por)
     VALUES ($1, 'executando', $2)
     RETURNING id`,
    [tipo, iniciadoPor]
  );
  const varreduraId = rows[0].id;

  try {
    log(`🚀 Varredura #${varreduraId} (${tipo}) iniciada${iniciadoPor ? ` por ${iniciadoPor}` : ''}`);

    // Passo 1: Scanner Playwright — extrair dados do MAP
    const scanResult = await executarVarredura(pool, varreduraId, config);

    // Passo 2: Detector — analisar fraudes nos dados
    const detectResult = await analisarFraudes(pool, varreduraId, config);

    // Atualizar registro da varredura
    await pool.query(
      `UPDATE antifraude_varreduras
       SET status = 'concluido', os_analisadas = $2, alertas_gerados = $3,
           detalhes = $4, finalizado_em = NOW()
       WHERE id = $1`,
      [
        varreduraId,
        scanResult.totalOs,
        detectResult.alertasGerados,
        JSON.stringify({ inseridos: scanResult.inseridos, ...detectResult }),
      ]
    );

    log(`✅ Varredura #${varreduraId} concluída: ${scanResult.totalOs} OS(s), ${detectResult.alertasGerados} alerta(s)`);

    return {
      varreduraId,
      osAnalisadas: scanResult.totalOs,
      alertasGerados: detectResult.alertasGerados,
    };

  } catch (err) {
    log(`❌ Varredura #${varreduraId} falhou: ${err.message}`);

    await pool.query(
      `UPDATE antifraude_varreduras
       SET status = 'erro', erro = $2, finalizado_em = NOW()
       WHERE id = $1`,
      [varreduraId, err.message]
    ).catch(() => {});

    throw err;
  }
}

/**
 * Inicia o cron automático.
 */
function startAntiFraudeWorker(pool) {
  if (workerAtivo) {
    log('⚠️ Worker já ativo, ignorando.');
    return;
  }
  workerAtivo = true;

  // Verificar config e agendar
  (async () => {
    const config = await carregarConfig(pool);
    const cronAtivo = config.cron_ativo === 'true';
    const intervaloMin = parseInt(config.cron_intervalo_min) || 60;

    if (!cronAtivo) {
      log('⏸️ Cron anti-fraude desativado nas configurações.');
      return;
    }

    log(`🚀 Worker anti-fraude iniciado — cron a cada ${intervaloMin} minuto(s)`);

    // Primeira execução após 5 minutos (dar tempo do sistema subir)
    setTimeout(async () => {
      try {
        await executarVarreduraCompleta(pool, 'cron');
      } catch (err) {
        log(`❌ Erro no cron inicial: ${err.message}`);
      }
    }, 5 * 60 * 1000);

    // Cron periódico
    cronInterval = setInterval(async () => {
      try {
        // Re-checar se cron ainda está ativo
        const cfgAtual = await carregarConfig(pool);
        if (cfgAtual.cron_ativo !== 'true') {
          log('⏸️ Cron desativado — pulando execução');
          return;
        }
        await executarVarreduraCompleta(pool, 'cron');
      } catch (err) {
        log(`❌ Erro no cron: ${err.message}`);
      }
    }, intervaloMin * 60 * 1000);
  })();
}

module.exports = { startAntiFraudeWorker, executarVarreduraCompleta };
