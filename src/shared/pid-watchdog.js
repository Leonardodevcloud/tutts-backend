/**
 * Tutts Backend — src/shared/pid-watchdog.js
 * ─────────────────────────────────────────────────────────────────────────
 * Failsafe que monitora uso de PIDs do cgroup do container e força restart
 * se ultrapassar limite. Defesa de última instância contra acúmulo de
 * zumbis do Chromium que o dumb-init não conseguir reapar a tempo.
 *
 * ── PROBLEMA QUE RESOLVE ────────────────────────────────────────────────
 *
 * Em 2026-04/05 o tutts-agents passou a dar "spawn EAGAIN" no Chromium
 * depois de horas de uptime. EAGAIN no fork() significa esgotamento de
 * PIDs do cgroup (default Docker: pids.max ≈ 4096).
 *
 * Causa: Chromium spawna ~50 subprocessos por launch. Quando o browser
 * fecha (ou é SIGKILL), os filhos órfãos viram zumbis se PID 1 não fizer
 * wait(). O Dockerfile usa dumb-init pra resolver isso, mas:
 *   - Se o Railway estiver usando nixpacks em vez de Dockerfile, dumb-init
 *     não está como PID 1 e os zumbis acumulam linearmente.
 *   - Mesmo com dumb-init, em casos extremos (Chromium travando, sinais
 *     perdidos), o reaping pode atrasar e PIDs encherem temporariamente.
 *
 * Este watchdog é a defesa de ÚLTIMA INSTÂNCIA: se PIDs subirem além de
 * um limite (default 80% de pids.max), restarta o processo graceful.
 * Railway recria o container limpo em segundos. Isso transforma um
 * outage de horas (até alguém perceber) num glitch de poucos segundos.
 *
 * ── COMO LEMOS O LIMITE ─────────────────────────────────────────────────
 *
 * No Linux container (cgroups v2):
 *   /sys/fs/cgroup/pids.current  → quantos PIDs estão alocados
 *   /sys/fs/cgroup/pids.max      → limite ("max" = unlimited)
 *
 * No cgroups v1 (Railway pode usar):
 *   /sys/fs/cgroup/pids/pids.current
 *   /sys/fs/cgroup/pids/pids.max
 *
 * Tentamos os dois caminhos. Se nenhum existir (host sem cgroups, dev local,
 * Mac), o watchdog loga warning UMA vez e fica em no-op. Sem crash.
 */

'use strict';

const fs = require('fs');

const TAG = '[pid-watchdog]';

// Caminhos possíveis pra pids.current / pids.max (v2 primeiro, depois v1)
const CAMINHOS_CURRENT = [
  '/sys/fs/cgroup/pids.current',
  '/sys/fs/cgroup/pids/pids.current',
];
const CAMINHOS_MAX = [
  '/sys/fs/cgroup/pids.max',
  '/sys/fs/cgroup/pids/pids.max',
];

// Threshold pra disparar restart — porcentagem do pids.max (0-100)
const THRESHOLD_PCT = parseInt(process.env.PID_WATCHDOG_THRESHOLD_PCT, 10) || 80;

// Threshold de WARN (loga mas não restarta)
const WARN_PCT = parseInt(process.env.PID_WATCHDOG_WARN_PCT, 10) || 60;

// Verificações seguidas necessárias antes de matar (evita restart por pico)
const VERIFICACOES_NECESSARIAS = parseInt(process.env.PID_WATCHDOG_CHECKS, 10) || 3;

// Intervalo de verificação
const INTERVALO_MS = 30 * 1000;

// Pra hosts sem cgroups (Windows/Mac dev), aceitamos um teto absoluto via env
const PID_HARDCAP = parseInt(process.env.PID_WATCHDOG_HARDCAP, 10) || 0;

let _timer = null;
let _consecutivoAcima = 0;
let _shutdownIniciado = false;
let _avisouSemCgroup = false;
let _caminhoCurrent = null;
let _caminhoMax = null;

function log(msg) { console.log(`${TAG} ${msg}`); }
function warn(msg) { console.warn(`${TAG} ${msg}`); }

/**
 * Resolve os caminhos uma vez. Retorna true se encontrou.
 */
function _resolverCaminhos() {
  if (_caminhoCurrent && _caminhoMax) return true;
  for (const c of CAMINHOS_CURRENT) {
    if (fs.existsSync(c)) { _caminhoCurrent = c; break; }
  }
  for (const c of CAMINHOS_MAX) {
    if (fs.existsSync(c)) { _caminhoMax = c; break; }
  }
  return !!(_caminhoCurrent && _caminhoMax);
}

/**
 * Lê pids.current e pids.max. Retorna { current, max } ou null se não conseguir.
 * max pode ser Infinity (string "max" no cgroup = unlimited).
 */
function _lerPids() {
  if (!_resolverCaminhos()) return null;
  try {
    const current = parseInt(fs.readFileSync(_caminhoCurrent, 'utf8').trim(), 10);
    const maxRaw = fs.readFileSync(_caminhoMax, 'utf8').trim();
    const max = (maxRaw === 'max' || maxRaw === '') ? Infinity : parseInt(maxRaw, 10);
    if (Number.isNaN(current)) return null;
    return { current, max };
  } catch (_) {
    return null;
  }
}

/**
 * Verifica e age. Idempotente.
 */
function verificarPids(callbackBeforeExit) {
  if (_shutdownIniciado) return;

  const dados = _lerPids();

  // Sem cgroup acessível — avisa 1x e usa hardcap se configurado
  if (!dados) {
    if (!_avisouSemCgroup) {
      warn('cgroup pids não acessível — watchdog em modo no-op (defina PID_WATCHDOG_HARDCAP=N pra ativar fallback)');
      _avisouSemCgroup = true;
    }
    return;
  }

  const { current, max } = dados;

  // Sem limite configurado — só monitora informacionalmente
  if (!isFinite(max)) {
    // Só loga se passar de WARN absoluto (3000+) que indica problema mesmo sem cap
    if (PID_HARDCAP > 0 && current >= PID_HARDCAP) {
      _consecutivoAcima++;
      warn(`PIDs=${current} acima do HARDCAP=${PID_HARDCAP} (max=unlimited). Contagem: ${_consecutivoAcima}/${VERIFICACOES_NECESSARIAS}`);
      if (_consecutivoAcima >= VERIFICACOES_NECESSARIAS) {
        return _dispararRestart(callbackBeforeExit, `PIDs=${current} acima do hardcap=${PID_HARDCAP}`);
      }
    } else if (_consecutivoAcima > 0) {
      _consecutivoAcima = 0;
    }
    return;
  }

  const pct = Math.round((current / max) * 100);

  if (pct >= THRESHOLD_PCT) {
    _consecutivoAcima++;
    warn(`PIDs=${current}/${max} (${pct}%) acima do KILL threshold (${THRESHOLD_PCT}%). Contagem: ${_consecutivoAcima}/${VERIFICACOES_NECESSARIAS}`);
    if (_consecutivoAcima >= VERIFICACOES_NECESSARIAS) {
      return _dispararRestart(
        callbackBeforeExit,
        `PIDs=${current}/${max} (${pct}%) sustentadamente acima de ${THRESHOLD_PCT}%`
      );
    }
    return;
  }

  // Voltou pra zona segura — reseta contador
  if (_consecutivoAcima > 0) {
    log(`PIDs voltaram a ${current}/${max} (${pct}%). Resetando contador.`);
    _consecutivoAcima = 0;
  }

  if (pct >= WARN_PCT) {
    warn(`PIDs=${current}/${max} (${pct}%) acima do WARN (${WARN_PCT}%). Continuando.`);
  }
}

function _dispararRestart(callbackBeforeExit, motivo) {
  _shutdownIniciado = true;
  warn(`🚨 ${motivo}. Forçando restart graceful (Railway sobe nova instância em segundos).`);

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

/**
 * Inicia o watchdog. Idempotente.
 *
 * @param {Function} callbackBeforeExit - opcional, async, executado antes do
 *   process.exit com até 10s pra completar (ex: stopAll do agent-pool).
 */
function iniciarPidWatchdog(callbackBeforeExit) {
  if (_timer) {
    log('⚠️ Watchdog já está rodando, ignorando segunda chamada');
    return;
  }

  // Faz 1 leitura logo de cara pra reportar estado inicial e detectar
  // ausência de cgroup
  const dados = _lerPids();
  if (dados) {
    const { current, max } = dados;
    const pct = isFinite(max) ? Math.round((current / max) * 100) : 'inf';
    log(`▶️ Iniciado. PIDs iniciais=${current}/${max} (${pct}%), threshold=${THRESHOLD_PCT}%, warn=${WARN_PCT}%, checks=${VERIFICACOES_NECESSARIAS}, intervalo=${INTERVALO_MS / 1000}s`);
  } else {
    log(`▶️ Iniciado em modo no-op (sem cgroup), hardcap=${PID_HARDCAP || 'desabilitado'}`);
  }

  _timer = setInterval(() => verificarPids(callbackBeforeExit), INTERVALO_MS);
  if (_timer.unref) _timer.unref();
}

function pararPidWatchdog() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    log('⏹️ Watchdog parado');
  }
}

module.exports = {
  iniciarPidWatchdog,
  pararPidWatchdog,
  verificarPids,  // exportado pra teste
  _THRESHOLD_PCT: THRESHOLD_PCT,
  _WARN_PCT: WARN_PCT,
};
