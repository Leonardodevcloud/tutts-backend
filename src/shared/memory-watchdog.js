/**
 * Tutts Backend — src/shared/memory-watchdog.js
 * ─────────────────────────────────────────────────────────────────────────
 * Failsafe que monitora uso de memória do processo e força restart se
 * ultrapassar limite. Defesa em última instância contra vazamentos que
 * o cleanup periódico não pega.
 *
 * Por que não confiar só no Railway?
 * ───────────────────────────────────
 * O Railway só restarta quando o container fica realmente travado ou
 * quando o OOM killer mata. Mas a degradação acontece ANTES disso:
 * a partir de ~1GB a memória pressiona o cgroup, Chromium novos não
 * sobem, agentes começam a falhar — mesmo sem OOM kill explícito.
 *
 * Este watchdog detecta a degradação cedo (a partir de 1.5GB) e
 * encerra o processo gracefully. Como o Railway tem restart=on-failure
 * por default, o serviço sobe limpo em segundos.
 *
 * Estratégia
 * ──────────
 * 1. A cada 60s, lê process.memoryUsage().rss
 * 2. Se passar de WARN_LIMIT → loga aviso (ainda funciona)
 * 3. Se passar de KILL_LIMIT 3 verificações seguidas → encerra com graceful
 *    shutdown (process.exit(1) — Railway restart)
 *
 * Por que 3 verificações seguidas? Pra evitar restart por pico transiente
 * (ex: durante export grande). Só restarta se memória ficou alta de forma
 * SUSTENTADA (3 minutos).
 */

'use strict';

// Limites em bytes — configuráveis via env var
// MEMORY_WATCHDOG_WARN_MB: limite de warning (default 1024 MB)
// MEMORY_WATCHDOG_KILL_MB: limite que dispara restart (default 1536 MB)
// MEMORY_WATCHDOG_CHECKS:  verificações seguidas necessárias (default 3)
//
// Razão de ser configurável: o tutts-agents (worker) é mais sensível e
// roda Chromium 24/7 — limite menor faz sentido. Já o tutts-backend
// atende HTTP e pode ter picos legítimos durante exports/uploads grandes,
// então usa limites maiores e mais verificações antes de matar (pra não
// reiniciar com users no meio de operação).
const WARN_LIMIT = (parseInt(process.env.MEMORY_WATCHDOG_WARN_MB, 10) || 1024) * 1024 * 1024;
const KILL_LIMIT = (parseInt(process.env.MEMORY_WATCHDOG_KILL_MB, 10) || 1536) * 1024 * 1024;

// Quantas verificações seguidas precisam estourar antes de matar
const VERIFICACOES_NECESSARIAS = parseInt(process.env.MEMORY_WATCHDOG_CHECKS, 10) || 3;

// Intervalo de verificação
const INTERVALO_MS = 60 * 1000;

const TAG = '[mem-watchdog]';

let _timer = null;
let _consecutivoAcimaLimite = 0;
let _shutdownIniciado = false;

function log(msg) { console.log(`${TAG} ${msg}`); }
function warn(msg) { console.warn(`${TAG} ${msg}`); }

function fmtMB(bytes) {
  return Math.round(bytes / 1024 / 1024) + ' MB';
}

/**
 * Verifica memória e age conforme nível. Idempotente; safe pra chamar
 * várias vezes.
 */
function verificarMemoria(callbackBeforeExit) {
  if (_shutdownIniciado) return;

  let mem;
  try {
    mem = process.memoryUsage();
  } catch (e) {
    warn(`Falha ao ler memoryUsage: ${e.message}`);
    return;
  }

  const rss = mem.rss;

  if (rss >= KILL_LIMIT) {
    _consecutivoAcimaLimite++;
    warn(
      `RSS=${fmtMB(rss)} acima do limite de KILL (${fmtMB(KILL_LIMIT)}). ` +
      `Contagem: ${_consecutivoAcimaLimite}/${VERIFICACOES_NECESSARIAS}`
    );

    if (_consecutivoAcimaLimite >= VERIFICACOES_NECESSARIAS) {
      _shutdownIniciado = true;
      warn(
        `🚨 RSS sustentadamente acima do limite. Forçando restart graceful ` +
        `(Railway vai subir nova instância em segundos).`
      );

      // Tenta callback de cleanup primeiro (ex: stopAll do agent-pool),
      // mas com timeout pra não travar.
      const cb = typeof callbackBeforeExit === 'function'
        ? callbackBeforeExit
        : () => Promise.resolve();

      Promise.race([
        Promise.resolve().then(() => cb()).catch(e => warn(`Callback falhou: ${e.message}`)),
        new Promise(r => setTimeout(r, 10_000)),  // 10s max
      ]).finally(() => {
        warn('Encerrando processo agora.');
        process.exit(1);
      });
    }
    return;
  }

  // Resetar contador se estiver abaixo do KILL
  if (_consecutivoAcimaLimite > 0) {
    log(`RSS voltou a ${fmtMB(rss)} (abaixo do KILL). Resetando contador.`);
    _consecutivoAcimaLimite = 0;
  }

  if (rss >= WARN_LIMIT) {
    warn(`RSS=${fmtMB(rss)} acima do WARN (${fmtMB(WARN_LIMIT)}). Continuando.`);
  }
}

/**
 * Inicia o watchdog. Idempotente.
 *
 * @param {Function} callbackBeforeExit - (opcional) função async chamada
 *   antes do process.exit, com até 10s pra completar. Útil pra parar
 *   pools de agentes graciosamente.
 */
function iniciarMemoryWatchdog(callbackBeforeExit) {
  if (_timer) {
    log('⚠️ Watchdog já está rodando, ignorando segunda chamada');
    return;
  }
  log(
    `▶️ Iniciado. WARN=${fmtMB(WARN_LIMIT)}, KILL=${fmtMB(KILL_LIMIT)} ` +
    `(${VERIFICACOES_NECESSARIAS} verificações seguidas), ` +
    `intervalo=${Math.round(INTERVALO_MS / 1000)}s`
  );

  _timer = setInterval(() => verificarMemoria(callbackBeforeExit), INTERVALO_MS);
  if (_timer.unref) _timer.unref();
}

function pararMemoryWatchdog() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    log('⏹️ Watchdog parado');
  }
}

module.exports = {
  iniciarMemoryWatchdog,
  pararMemoryWatchdog,
  verificarMemoria,  // exportado pra teste
  // Constantes pra docs/teste
  _WARN_LIMIT: WARN_LIMIT,
  _KILL_LIMIT: KILL_LIMIT,
};
