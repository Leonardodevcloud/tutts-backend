/**
 * src/shared/playwright-launch.js
 *
 * Wrapper UNIFICADO para Chromium do Playwright.
 *
 * ── PROBLEMA QUE RESOLVE ────────────────────────────────────────────────
 *
 * Em 2026-04 o Railway começou a dar "spawn EAGAIN" no Chromium após
 * algumas horas de uptime. Causa: vários arquivos usavam o pattern:
 *
 *     const browser = await chromium.launch(...);
 *     // ...
 *     await browser.close();
 *
 * Sem timeout no close() e sem fallback de SIGKILL. Em pressão de memória
 * o close() trava e o processo fica zombie. Acumula. Sistema esgota PIDs/RAM.
 *
 * Esse helper centraliza o launch + fechamento robusto. Todo arquivo que
 * lançava Chromium direto agora deve usar este helper.
 *
 * ── COMO USAR ───────────────────────────────────────────────────────────
 *
 *   const { lancarChromiumSeguro } = require('<path>/shared/playwright-launch');
 *
 *   const { browser, fechar } = await lancarChromiumSeguro({
 *     args: ['--no-sandbox', '--disable-setuid-sandbox'],
 *   });
 *   try {
 *     // ... uso normal do browser/page/context ...
 *   } finally {
 *     await fechar();
 *   }
 *
 * O fechar() é IDEMPOTENTE — pode chamar múltiplas vezes sem erro.
 * Garante que quando retorna, o Chromium ESTÁ MORTO (close gracioso ou SIGKILL).
 */

'use strict';

const { chromium } = require('playwright');

// Args padrão — combina os mais conservadores usados em todo o código.
// Cada caller pode passar `args` próprio que sobrescreve.
const ARGS_PADRAO = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--mute-audio',
  '--no-first-run',
];

const TIMEOUT_CLOSE_MS = 5_000;  // close gracioso. Se passar, manda SIGKILL.
// 🆕 2026-06: retry de launch. Sob rajada (site externo lento -> jobs empilham),
// o Chromium falha com "spawn EAGAIN" / "Target ... closed" de forma TRANSITORIA.
// Em vez de desistir na 1a, tenta algumas vezes com espera crescente.
const MAX_TENTATIVAS_LAUNCH = 4;
const BACKOFF_BASE_MS = 400;  // espera = 400, 800, 1200ms entre tentativas

function log(msg) {
  // Não usa o logger formal pra evitar dependências circulares —
  // este helper deve ter o mínimo possível de imports.
  console.log('[playwright-launch] ' + msg);
}

/**
 * Promise.race com timeout. Não cancela a Promise original (Promise não cancela),
 * mas garante que NÓS desistimos depois de N ms e seguimos pro próximo passo.
 */
function comTimeout(promise, ms, nome) {
  let timer;
  const timeout = new Promise(function(_, rej) {
    timer = setTimeout(function() { rej(new Error(nome + ': timeout ' + ms + 'ms')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(function() { clearTimeout(timer); });
}

/**
 * Lança Chromium e retorna { browser, fechar }.
 *
 * @param {object} opts - opcional. Se não passar, usa ARGS_PADRAO.
 *                         Aceita qualquer opção do chromium.launch (headless,
 *                         args, executablePath, etc).
 * @returns {Promise<{browser: import('playwright').Browser, fechar: () => Promise<void>}>}
 */
/**
 * 🆕 2026-06: chromium.launch com retry+backoff para erros TRANSITORIOS
 * (spawn EAGAIN, Target closed, Failed to launch) que aparecem sob pressao
 * de PIDs. Da tempo do reaper/GC liberarem recursos entre as tentativas.
 */
async function _lancarComRetry(launchOpts) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_LAUNCH; tentativa++) {
    try {
      return await chromium.launch(launchOpts);
    } catch (err) {
      ultimoErro = err;
      const msg = (err && err.message) || '';
      const transitorio = /EAGAIN|spawn|Target page|has been closed|Failed to launch|Timeout/i.test(msg);
      if (!transitorio || tentativa === MAX_TENTATIVAS_LAUNCH) break;
      const espera = BACKOFF_BASE_MS * tentativa;
      log('⚠️ launch falhou (tentativa ' + tentativa + '/' + MAX_TENTATIVAS_LAUNCH + '): ' + msg.split('\n')[0] + ' — retry em ' + espera + 'ms');
      await new Promise(function(r) { setTimeout(r, espera); });
    }
  }
  throw ultimoErro;
}

async function lancarChromiumSeguro(opts) {
  opts = opts || {};
  // Se o caller passou args, usa o dele. Senão, usa o padrão.
  const launchOpts = Object.assign({ headless: true }, opts);
  if (!launchOpts.args) launchOpts.args = ARGS_PADRAO;

  const browser = await _lancarComRetry(launchOpts);

  let jaFechado = false;

  async function fechar() {
    if (jaFechado) return;
    jaFechado = true;

    // 1. Tenta close gracioso com timeout.
    try {
      await comTimeout(browser.close(), TIMEOUT_CLOSE_MS, 'browser.close');
      return;
    } catch (e) {
      log('⚠️ browser.close() pendurou (' + e.message + ') — tentando SIGKILL');
    }

    // 2. Fallback: SIGKILL no processo do Chromium.
    // Garante que retornamos com o Chromium MORTO, não zumbi.
    try {
      const proc = browser.process && browser.process();
      if (proc && typeof proc.kill === 'function') {
        proc.kill('SIGKILL');
        log('💀 Chromium pid=' + proc.pid + ' morto via SIGKILL');
      }
    } catch (e) {
      log('⚠️ SIGKILL falhou: ' + e.message);
    }
  }

  return { browser: browser, fechar: fechar };
}

module.exports = {
  lancarChromiumSeguro: lancarChromiumSeguro,
  ARGS_PADRAO: ARGS_PADRAO,
};
