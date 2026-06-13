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

// ── Reaper de Chromium orfao ────────────────────────────────────────────
// tutts-agents e dedicado aos agentes RPA: nenhum Chromium legitimo vive
// muito (jobs duram segundos ate ~90s). Qualquer headless_shell/chrome com
// mais de REAPER_MAX_IDADE_MS e leak (launch que falhou deixou processo orfao)
// e estava enchendo o limite de PIDs do container. O reaper mata na marra.
// Le direto do /proc (sem depender de 'ps', que pode nao existir no container).
const REAPER_INTERVALO_MS = 30 * 1000;       // varre a cada 30s (mais agressivo sob rajada)
const REAPER_MAX_IDADE_MS = 3 * 60 * 1000;   // mata Chromium com mais de 3 min (jobs duram ate ~90s)
const ZUMBI_ALERTA = Number(process.env.CHROMIUM_ZUMBI_ALERTA || 50); // loga ERROR se zumbis >= isso
let _reaperLigado = false;
// 2026-06: estatisticas do reaper. zumbis altos = init reaper (dumb-init) ausente.
let _reaperStats = { ultimaVarredura: null, orfaosMortos: 0, zumbisAgora: 0, chromiumVivos: 0 };
// 2026-06: circuit-breaker de tempestade de launch (N falhas seguidas -> handler).
let _falhasLaunchSeguidas = 0;
let _onLaunchStorm = null;
const LAUNCH_STORM_LIMIAR = Number(process.env.LAUNCH_STORM_LIMIAR || 6);
function setLaunchStormHandler(fn) { _onLaunchStorm = (typeof fn === 'function') ? fn : null; }
function getReaperStats() { return Object.assign({}, _reaperStats); }

// Le o state do processo (R/S/Z/...) do /proc/<pid>/stat. Zumbi = 'Z'.
// Zumbi tem cmdline VAZIA, entao o regex de chromium nao o pega; aqui detectamos
// pelo state pra ao menos CONTAR (nao da pra SIGKILL zumbi, so o PID 1 reapa).
function _estadoProc(pid, fs) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const apos = stat.slice(stat.lastIndexOf(')') + 2).trim();
    return apos.charAt(0);
  } catch (_) { return ''; }
}

function _uptimeSeg() {
  try {
    const fs = require('fs');
    return parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) || 0;
  } catch (_) { return 0; }
}

function _idadeProcMs(pid, uptimeSeg) {
  try {
    const fs = require('fs');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // formato: pid (comm) state ppid ... starttime(campo 22).
    // Pega tudo depois do ultimo ')': [state, ppid, ..., starttime, ...].
    const apos = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const starttimeTicks = parseFloat(apos[19]); // campo 22 = indice 19 pos-comm
    const clkTck = 100; // USER_HZ padrao no Linux
    const startSeg = starttimeTicks / clkTck;
    return Math.max(0, (uptimeSeg - startSeg) * 1000);
  } catch (_) { return -1; }
}

function _varrerChromiumOrfao() {
  let fs;
  try { fs = require('fs'); } catch (_) { return; }
  let pids;
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (_) { return; }
  const uptime = _uptimeSeg();
  let mortos = 0;
  let zumbis = 0;
  let chromiumVivos = 0;
  for (const pid of pids) {
    // Zumbi (state Z) tem cmdline vazia -> detecta pelo state. So contamos.
    if (_estadoProc(pid, fs) === 'Z') { zumbis++; continue; }
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (_) { continue; }
    if (!/headless_shell|chromium|chrome-linux/i.test(cmd)) continue;
    chromiumVivos++;
    const idade = _idadeProcMs(pid, uptime);
    if (idade > REAPER_MAX_IDADE_MS) {
      try { process.kill(Number(pid), 'SIGKILL'); mortos++; } catch (_) {}
    }
  }
  _reaperStats = {
    ultimaVarredura: new Date().toISOString(),
    orfaosMortos: (_reaperStats.orfaosMortos || 0) + mortos,
    zumbisAgora: zumbis,
    chromiumVivos,
  };
  if (mortos > 0) {
    try { logger.warn(`[chromium-reaper] 🧹 ${mortos} Chromium orfao(s) mortos (idade > ${Math.round(REAPER_MAX_IDADE_MS / 60000)}min)`); } catch (_) {}
  }
  if (zumbis >= ZUMBI_ALERTA) {
    try { logger.error(`[chromium-reaper] 🧟 ${zumbis} zumbis detectados — init reaper (dumb-init) pode nao estar como PID 1. Leva a spawn EAGAIN.`); } catch (_) {}
  }
}

function _iniciarReaper() {
  if (_reaperLigado) return;
  _reaperLigado = true;
  const timer = setInterval(_varrerChromiumOrfao, REAPER_INTERVALO_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  try { logger.info(`[chromium-reaper] ▶️ ligado (varre a cada ${Math.round(REAPER_INTERVALO_MS / 1000)}s, mata Chromium > ${Math.round(REAPER_MAX_IDADE_MS / 60000)}min)`); } catch (_) {}
}
_iniciarReaper();

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
      // So matamos o browser se REALMENTE desistimos do launch por timeout.
      // (comparar _browser !== b tinha race: o .then disparava ANTES de
      //  _browser receber b, matando o browser que acabou de subir com sucesso.)
      let _desistiu = false;
      try {
        // 🆕 2026-06: retry sob erro TRANSITORIO (spawn EAGAIN / Target closed)
        // que aparece sob pressao de PIDs numa rajada. Cada tentativa tem seu
        // proprio orphan-kill (_attemptDesistiu); o _desistiu global (catch)
        // cobre o caso de abandono definitivo.
        let _tentativa = 0;
        while (true) {
          _tentativa++;
          let _attemptDesistiu = false;
          const _launchPromise = chromium.launch(launchOpts);
          // Promise.race NAO cancela: se o timeout estourar, este launch pode
          // resolver DEPOIS e deixar um Chromium orfao. Mata o que chega tarde.
          _launchPromise.then(
            (b) => {
              if (_attemptDesistiu || _desistiu) {
                try {
                  const p = b.process && b.process();
                  if (p && typeof p.kill === 'function') p.kill('SIGKILL');
                } catch (_) {}
                try { b.close().catch(() => {}); } catch (_) {}
              }
            },
            () => {}
          );
          try {
            _browser = await comTimeout(_launchPromise, TIMEOUT_LAUNCH_MS, 'chromium.launch');
            break;  // sucesso
          } catch (errTent) {
            _attemptDesistiu = true;  // mata o launch orfao DESTA tentativa
            const _msg = (errTent && errTent.message) || '';
            const _transit = /EAGAIN|spawn|Target page|has been closed|Failed to launch|timeout/i.test(_msg);
            if (!_transit || _tentativa >= 4) throw errTent;
            const _espera = 400 * _tentativa;
            logErr(`⚠️ launch #${_totalLaunches} tentativa ${_tentativa}/4: ${_msg.split('\n')[0]} — retry em ${_espera}ms`);
            await new Promise((r) => setTimeout(r, _espera));
          }
        }
        _vivo = true;
        _falhasLaunchSeguidas = 0;  // 2026-06: launch OK reseta o circuit-breaker

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
        _desistiu = true;   // launch abandonado -> mata o browser se chegar tarde
        logErr(`❌ Falha no launch #${_totalLaunches}: ${err.message}`);
        _browser = null;
        _vivo = false;
        // 2026-06: circuit-breaker — N launches falhos seguidos disparam handler global
        _falhasLaunchSeguidas++;
        if (_falhasLaunchSeguidas >= LAUNCH_STORM_LIMIAR && _onLaunchStorm) {
          logErr(`🌩️ ${_falhasLaunchSeguidas} launches falharam seguidos — disparando handler de tempestade (provavel PID esgotado)`);
          try { _onLaunchStorm(_falhasLaunchSeguidas); } catch (_) {}
        }
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

module.exports = { criarBrowserSession, getReaperStats, setLaunchStormHandler };
