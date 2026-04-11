'use strict';

/**
 * sla-detector-worker.js
 *
 * Cron janela comercial Bahia que dispara detectarOsNovas a cada 2 minutos.
 * Substitui a extensão Chrome — operadores não precisam mais de nada.
 *
 * Janela:
 *   Seg-Sex 08:00 → 18:00 (a cada 2 minutos)
 *   Sáb     08:00 → 12:00 (a cada 2 minutos)
 *   Fora disso: dorme totalmente.
 *
 * Auto-relogin: se detectarOsNovas retornar sessaoExpirada=true,
 * chama capturarPontosOS com OS dummy só pra forçar o login do
 * playwright-sla-capture (que já cuida de salvar /tmp/tutts-sla-session.json).
 */

const cron = require('node-cron');
const { detectarOsNovas } = require('./sla-detector.service');

let _rodando = false;
let _ultimoRelogin = 0;
const RELOGIN_COOLDOWN_MS = 60_000; // não relogar mais de 1x por minuto

function log(msg) {
  console.log(`[sla-detector-worker] ${msg}`);
}

async function tentarRelogin() {
  const agora = Date.now();
  if (agora - _ultimoRelogin < RELOGIN_COOLDOWN_MS) {
    log('⏭️ Relogin em cooldown, pulando');
    return false;
  }
  _ultimoRelogin = agora;

  try {
    log('🔑 Disparando relogin via playwright-sla-capture...');
    // Importa lazy pra não carregar Playwright na boot do worker
    const { capturarPontosOS } = require('./playwright-sla-capture');
    // OS dummy só pra forçar o fluxo de login → o erro ENDERECO_JA_CORRIGIDO
    // ou OS_NAO_ENCONTRADA é esperado, o que importa é o cookie ser salvo.
    await capturarPontosOS({ os_numero: '0000001', cliente_cod: '814' }).catch(e => {
      log(`(esperado) relogin: ${e.message}`);
    });
    log('✅ Relogin concluído');
    return true;
  } catch (err) {
    log(`❌ Relogin falhou: ${err.message}`);
    return false;
  }
}

async function tick(pool) {
  if (_rodando) {
    log('⏭️ Tick anterior ainda rodando, pulando');
    return;
  }
  _rodando = true;
  try {
    const result = await detectarOsNovas(pool);
    if (result.sessaoExpirada) {
      const ok = await tentarRelogin();
      if (ok) {
        // Tenta de novo após relogin
        await detectarOsNovas(pool);
      }
    }
  } catch (err) {
    log(`❌ Erro no tick: ${err.message}`);
  } finally {
    _rodando = false;
  }
}

function startSlaDetectorWorker(pool) {
  if (process.env.SLA_DETECTOR_ATIVO !== 'true') {
    log('⏸️ SLA_DETECTOR_ATIVO != true — worker NÃO iniciado');
    return;
  }

  const tz = { timezone: 'America/Bahia' };

  // Seg-Sex 08:00-17:58 a cada 2 min
  cron.schedule('*/2 8-17 * * 1-5', () => tick(pool), tz);
  // Borda 18:00 seg-sex
  cron.schedule('0 18 * * 1-5', () => tick(pool), tz);
  // Sáb 08:00-11:58 a cada 2 min
  cron.schedule('*/2 8-11 * * 6', () => tick(pool), tz);
  // Borda 12:00 sáb
  cron.schedule('0 12 * * 6', () => tick(pool), tz);

  log('▶️ SLA Detector Worker iniciado (Seg-Sex 08-18h, Sáb 08-12h, Bahia, polling 2min)');
}

module.exports = { startSlaDetectorWorker };
