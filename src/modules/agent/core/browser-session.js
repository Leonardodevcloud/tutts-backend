/**
 * core/browser-session.js
 * ─────────────────────────────────────────────────────────────────────────
 * Sessão de browser PERSISTENTE por slot de agente.
 *
 * ── PROBLEMA QUE RESOLVE ────────────────────────────────────────────────
 *
 * O padrão anterior abria E fechava um Chromium A CADA JOB:
 *   - sla-capture: 270 ticks → 270+ chromium.launch() em ~2h
 *   - liberar-ponto: idem
 *
 * Em containers Linux, cada launch/close deixa rastros de recursos de kernel
 * (pipes IPC, sockets, semáforos POSIX). Depois de centenas de launches,
 * o kernel esgota esses handles → próximo launch recebe SIGTRAP (assertion
 * interna do Chromium ao tentar alocar recursos que não existem mais).
 *
 * Sintoma nos logs:
 *   [pid=XXXX] <process did exit: exitCode=null, signal=SIGTRAP>
 *   browserType.launch: Target page, context or browser has been closed
 *
 * NÃO é falta de /tmp (cleanup funcionava, só 3 profiles encontrados).
 * NÃO é OOM (memória OK nos logs do watchdog).
 * É esgotamento de recursos de kernel IPC por uso repetido de launch/close.
 *
 * ── SOLUÇÃO ─────────────────────────────────────────────────────────────
 *
 * Cada slot mantém 1 browser vivo durante TODA a vida do processo.
 * Em vez de abrir/fechar por job, o browser fica aberto e uma nova
 * context/page é criada por job. Context é muito mais leve que browser:
 *   - Sem fork de processo
 *   - Sem inicialização de kernel IPC
 *   - Só aloca memória no processo Node/Chromium existente
 *
 * Se o browser morrer (crash, SIGTRAP, OOM), a sessão detecta e recria
 * automaticamente no próximo uso. Máximo de 2-3 browsers vivos no total
 * (um por slot) em vez de dezenas por hora.
 *
 * ── MODELO DE USO ───────────────────────────────────────────────────────
 *
 *   const { criarBrowserSession } = require('./core/browser-session');
 *
 *   // No início do agente (1x por slot):
 *   const sessao = criarBrowserSession({
 *     nome: 'sla-capture-slot-0',
 *     launchOpts: { headless: true, args: [...] },
 *   });
 *
 *   // A cada job:
 *   await sessao.comContext(async (context, slotId) => {
 *     const page = await context.newPage();
 *     try {
 *       // ... trabalho com a página ...
 *     } finally {
 *       await page.close().catch(() => {});
 *     }
 *   });
 *
 *   // Shutdown gracioso:
 *   await sessao.fechar();
 *
 * comContext() garante:
 *   1. Browser ativo (recria se necessário)
 *   2. Context limpo a cada chamada (cookies isolados por job)
 *   3. Context fechado no finally, mesmo se fn() lançar
 *   4. Se o browser morrer durante o job, marca como "morto" pra
 *      recreação no próximo uso (não deixa zombie)
 */

'use strict';

const { chromium } = require('playwright');
const { logger } = require('../../../config/logger');

// Timeout pra subir o browser (launch pode demorar em container frio)
const TIMEOUT_LAUNCH_MS = 30_000;
// Timeout pra fechar browser graciosamente antes de SIGKILL
const TIMEOUT_CLOSE_MS = 5_000;

function comTimeout(promise, ms, nome) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${nome}: timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/**
 * Cria uma sessão de browser persistente.
 *
 * @param {object} opts
 * @param {string} opts.nome        — nome do slot (pra logs), ex: 'sla-capture-0'
 * @param {object} opts.launchOpts  — opções do chromium.launch() (args, headless, etc.)
 * @returns {object}  { comContext, fechar, status }
 */
function criarBrowserSession(opts) {
  opts = opts || {};
  const nome = opts.nome || 'browser-session';
  const launchOpts = Object.assign({ headless: true }, opts.launchOpts || {});

  // Garante --no-sandbox e --disable-dev-shm-usage sempre presentes
  const argsBase = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=TranslateUI,IsolateOrigins,site-per-process',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--no-default-browser-check',
  ];

  if (!launchOpts.args || launchOpts.args.length === 0) {
    launchOpts.args = argsBase;
  }

  let _browser = null;       // instância do Playwright Browser
  let _vivo = false;         // true = browser está rodando e acessível
  let _lancando = false;     // true = em processo de launch (evita lançar duplo)
  let _lancandoPromise = null; // compartilha a Promise de launch em andamento
  let _totalLaunches = 0;
  let _totalJobs = 0;
  let _ultimoCrashEm = null;
  let _encerrado = false;

  function log(msg) {
    logger.info(`[browser-session/${nome}] ${msg}`);
  }
  function logErr(msg) {
    logger.error(`[browser-session/${nome}] ${msg}`);
  }

  /**
   * Verifica se o browser está realmente vivo (processo ativo).
   * browser.isConnected() retorna false quando o processo Chromium morreu.
   */
  function _browserVivo() {
    if (!_browser) return false;
    try {
      return _browser.isConnected();
    } catch (_) {
      return false;
    }
  }

  /**
   * Mata o browser atual sem lançar erro.
   */
  async function _matarBrowserAtual() {
    if (!_browser) return;
    const b = _browser;
    _browser = null;
    _vivo = false;
    try {
      await comTimeout(b.close(), TIMEOUT_CLOSE_MS, 'browser.close');
    } catch (_) {
      // Tenta SIGKILL se close() pendurar
      try {
        const proc = b.process && b.process();
        if (proc && typeof proc.kill === 'function') {
          proc.kill('SIGKILL');
        }
      } catch (_2) {}
    }
  }

  /**
   * Lança um browser novo. Idempotente: se já está lançando, aguarda o
   * launch em andamento em vez de criar um segundo (evita double-launch
   * em caso de chamadas concorrentes durante reconnect).
   */
  async function _garantirBrowser() {
    if (_encerrado) {
      throw new Error('BrowserSession encerrada — não pode criar browser');
    }

    // Já está vivo
    if (_vivo && _browserVivo()) return;

    // Já tem um launch em andamento — aguarda o mesmo
    if (_lancando && _lancandoPromise) {
      await _lancandoPromise;
      return;
    }

    // Mata o browser morto antes de recriar
    if (_browser && !_browserVivo()) {
      log('⚠️ Browser morto detectado — recriando');
      _ultimoCrashEm = new Date().toISOString();
      await _matarBrowserAtual();
    }

    _lancando = true;
    _lancandoPromise = (async () => {
      _totalLaunches++;
      log(`🚀 Lançando Chromium (launch #${_totalLaunches})`);
      try {
        _browser = await comTimeout(
          chromium.launch(launchOpts),
          TIMEOUT_LAUNCH_MS,
          'chromium.launch'
        );
        _vivo = true;

        // Detecta crash/close inesperado do processo Chromium
        _browser.on('disconnected', () => {
          if (_vivo) {
            log('⚠️ Browser desconectou inesperadamente (crash/SIGTRAP)');
            _ultimoCrashEm = new Date().toISOString();
            _vivo = false;
            _browser = null;
          }
        });

        log(`✅ Chromium ativo (launch #${_totalLaunches})`);
      } catch (err) {
        logErr(`❌ Falha no launch #${_totalLaunches}: ${err.message}`);
        _browser = null;
        _vivo = false;
        throw err;
      } finally {
        _lancando = false;
        _lancandoPromise = null;
      }
    })();

    await _lancandoPromise;
  }

  /**
   * Executa fn(context) com um context limpo do browser persistente.
   *
   * - Garante browser ativo (lança se necessário, recria se crashou)
   * - Cria context novo pra isolamento de cookies/storage entre jobs
   * - Fecha context no finally
   * - Se o browser morrer durante o job, marca como morto (sem zombie)
   *
   * @param {function} fn  async (context) => any
   * @param {object}   contextOpts  opções do browser.newContext()
   */
  async function comContext(fn, contextOpts) {
    await _garantirBrowser();

    _totalJobs++;
    let context = null;

    try {
      context = await _browser.newContext(contextOpts || {});
      return await fn(context);
    } catch (err) {
      // Se o browser morreu durante o job, marca pra recreação
      if (!_browserVivo()) {
        log('⚠️ Browser morreu durante job — será recriado no próximo uso');
        _ultimoCrashEm = new Date().toISOString();
        _vivo = false;
        _browser = null;
      }
      throw err;
    } finally {
      // Fecha o context sem matar o browser
      if (context) {
        try {
          await comTimeout(context.close(), 3_000, 'context.close');
        } catch (_) {
          // context.close() pode falhar se o browser morreu — ignora
        }
        context = null;
      }
    }
  }

  /**
   * Retorna o browser ativo (lança se necessário).
   * Usado quando o caller precisa do objeto browser diretamente
   * (ex: para passá-lo como override ao playwright-sla-capture).
   */
  async function obterBrowser() {
    await _garantirBrowser();
    return _browser;
  }

  /**
   * Marca o browser como morto externamente (ex: quando o caller detecta
   * que browser.isConnected() voltou false durante um job).
   * No próximo obterBrowser() ou comContext(), o browser será recriado.
   */
  function _marcarMorto() {
    if (_vivo) {
      _vivo = false;
      _ultimoCrashEm = new Date().toISOString();
      _browser = null;
    }
  }

  /**
   * Encerra a sessão definitivamente (shutdown gracioso).
   * Após fechar(), comContext() lança erro imediatamente.
   */
  async function fechar() {
    if (_encerrado) return;
    _encerrado = true;
    log('🛑 Encerrando sessão...');
    await _matarBrowserAtual();
    log('✅ Sessão encerrada');
  }

  /**
   * Snapshot do estado interno pra diagnóstico/health.
   */
  function status() {
    return {
      nome,
      vivo: _vivo && _browserVivo(),
      encerrado: _encerrado,
      totalLaunches: _totalLaunches,
      totalJobs: _totalJobs,
      ultimoCrashEm: _ultimoCrashEm,
    };
  }

  return { comContext, obterBrowser, _marcarMorto, fechar, status };
}

module.exports = { criarBrowserSession };
