/**
 * core/playwright-helpers.js
 * ─────────────────────────────────────────────────────────────────────────
 * Helpers compartilhados pra agentes que usam Playwright. Encapsula:
 *
 *   - launch + cleanup robusto (fecharBrowserSeguro com SIGKILL fallback)
 *   - tratamento uniforme de timeouts internos
 *   - reuso de sessão (storageState) por slot
 *   - relogin automático se sessão expirou
 *
 * USO TÍPICO em um processar() de agente:
 *
 *   const { runComBrowser } = require('../core/playwright-helpers');
 *
 *   await runComBrowser(ctx, async ({ browser, context, page, fazerLogin }) => {
 *     // sua lógica aqui — page já vem com sessão carregada
 *     await page.goto(URL_DA_TAREFA);
 *
 *     if (await ehTelaDeLogin(page)) {
 *       await fazerLogin(page); // usa credenciais do slot atual
 *     }
 *
 *     // ... resto do trabalho ...
 *
 *     // browser/context/page são fechados automaticamente no finally
 *   });
 */

'use strict';

const { chromium } = require('playwright');
const { logger } = require('../../../config/logger');

// Opções idênticas às que o código antigo usava — testadas em produção
const CHROMIUM_LAUNCH_OPTS = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--mute-audio',
    '--no-first-run',
  ],
};

const TIMEOUT_DEFAULT     = 25_000;
const NAV_TIMEOUT_DEFAULT = 45_000;

function log(msg) {
  logger.info(`[playwright-helpers] ${msg}`);
}

/**
 * Promise com timeout. Se a Promise não resolver no tempo, REJEITA.
 * Usado SÓ pra operações de close/cleanup (5s) — NUNCA pra envelopar
 * funções inteiras (isso causava o vazamento de Chromium do bug antigo).
 */
function comTimeout(promise, ms, nome) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${nome}: timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fecha browser de forma robusta:
 *   1. Tenta close gracioso com timeout de 5s
 *   2. Se falhar, manda SIGKILL no processo
 *
 * Garante que quando retorna, o Chromium ESTÁ MORTO. Isso é crítico
 * pro pool não disparar Chromium concorrente em cima do anterior.
 */
async function fecharBrowserSeguro(browser) {
  if (!browser) return;
  try {
    await comTimeout(browser.close(), 5_000, 'browser.close');
  } catch (e) {
    logger.error(`[playwright-helpers] close gracioso falhou: ${e.message} — SIGKILL`);
    try {
      const proc = browser.process();
      if (proc && proc.pid) {
        process.kill(proc.pid, 'SIGKILL');
      }
    } catch (e2) {
      logger.error(`[playwright-helpers] SIGKILL falhou: ${e2.message}`);
    }
  }
}

async function fecharContextSeguro(context) {
  if (!context) return;
  try {
    await comTimeout(context.close(), 3_000, 'context.close');
  } catch (e) {
    logger.error(`[playwright-helpers] context.close falhou: ${e.message}`);
  }
}

/**
 * Roda fn() com browser+context+page já criados, sessão carregada,
 * e cleanup garantido no finally.
 *
 * fn recebe { browser, context, page, slotId, slotIdx, fazerLogin, log }
 *
 * Se o agente passou sessionStrategy, page virá com storageState carregado
 * (se existir arquivo). fazerLogin(page) está disponível se a sessão expirou.
 */
async function runComBrowser(ctx, opts, fn) {
  // Permite chamar como runComBrowser(ctx, fn) sem opts
  if (typeof opts === 'function') {
    fn = opts;
    opts = {};
  }
  opts = opts || {};

  const launchOpts = { ...CHROMIUM_LAUNCH_OPTS, ...(opts.launchOpts || {}) };
  const timeout = opts.timeout || TIMEOUT_DEFAULT;
  const navTimeout = opts.navTimeout || NAV_TIMEOUT_DEFAULT;

  const sessao = ctx.sessao || null;
  const slotIdx = ctx.slotIdx || 0;
  const sessaoPath = sessao ? sessao.caminhoSessao(slotIdx) : null;

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch(launchOpts);

    const contextOpts = {};
    if (sessaoPath) {
      const fs = require('fs');
      if (fs.existsSync(sessaoPath)) {
        contextOpts.storageState = sessaoPath;
      }
    }

    try {
      context = await browser.newContext(contextOpts);
    } catch (e) {
      // Sessão inválida → tenta sem storageState
      logger.error(`[playwright-helpers] newContext c/ storageState falhou: ${e.message}`);
      if (sessao) sessao.descartarSessao(slotIdx);
      context = await browser.newContext();
    }

    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(navTimeout);

    const page = await context.newPage();

    // Helper de login que usa as credenciais do slot
    const fazerLogin = async (pageParam, customLoginFn) => {
      if (!sessao) {
        throw new Error('runComBrowser: agente sem sessionStrategy não pode fazer login');
      }
      const creds = sessao.credenciaisDoSlot(slotIdx);
      ctx.log(`🔐 Login necessário (conta: ${creds.fonte}, slot: ${slotIdx})`);

      // O agente deve fornecer customLoginFn (porque a UI é específica do
      // sistema externo). Aqui só passamos as credenciais.
      if (typeof customLoginFn !== 'function') {
        throw new Error('fazerLogin: customLoginFn obrigatório (página → ações de login)');
      }
      await customLoginFn(pageParam, creds);

      // Salva sessão atualizada
      try {
        await context.storageState({ path: sessaoPath });
        ctx.log(`💾 Sessão salva em ${sessaoPath}`);
      } catch (e) {
        logger.error(`[playwright-helpers] falha ao salvar storageState: ${e.message}`);
      }
    };

    // Helper pra salvar sessão sem fazer login (depois de qualquer ação que muda cookies)
    const salvarSessao = async () => {
      if (!sessaoPath) return;
      try {
        await context.storageState({ path: sessaoPath });
      } catch (e) {
        logger.error(`[playwright-helpers] salvarSessao falhou: ${e.message}`);
      }
    };

    return await fn({
      browser,
      context,
      page,
      slotId:    ctx.slotId,
      slotIdx,
      fazerLogin,
      salvarSessao,
      log:       ctx.log,
      sessaoPath,
    });
  } finally {
    // Ordem: page é fechado quando context fecha; context primeiro, depois browser
    await fecharContextSeguro(context);
    await fecharBrowserSeguro(browser);
  }
}

module.exports = {
  CHROMIUM_LAUNCH_OPTS,
  TIMEOUT_DEFAULT,
  NAV_TIMEOUT_DEFAULT,
  comTimeout,
  fecharBrowserSeguro,
  fecharContextSeguro,
  runComBrowser,
};
