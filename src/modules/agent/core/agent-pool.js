/**
 * core/agent-pool.js
 * ─────────────────────────────────────────────────────────────────────────
 * Orquestrador central. Cada agente registrado roda em N slots concorrentes
 * (slot = "vaga" no browser-pool). Cada slot é um loop independente:
 *
 *   loop(slotId):
 *     while (agente.ativo):
 *       try {
 *         registro = await buscarPendentes()     ← FOR UPDATE SKIP LOCKED
 *         if (!registro) await sleep(intervalo); continue
 *         await marcarProcessando(registro)
 *         await processar(registro, ctx)         ← dentro de withBrowserSlot
 *                                                ← com timeoutMs do agente
 *       } catch (err) {
 *         await onErro(registro, err)
 *       }
 *
 * Como cada slot pega seu próprio registro via SKIP LOCKED, dois slots
 * NUNCA pegam o mesmo item. Paralelismo seguro garantido pelo banco.
 *
 * MODO tickGlobal: alguns agentes não têm fila por item (ex: sla-detector
 * faz uma varredura única). Esses usam tickGlobal — uma função chamada
 * a cada N ms ou via cron expression. Esses agentes têm slots=1 sempre.
 *
 * ── DEFESA CONTRA DEADLOCK (2026-05) ────────────────────────────────────
 *
 * Todas as chamadas de processar() e tickGlobal() são envolvidas com
 * timeout (agente.timeoutMs). Quando o timeout dispara:
 *
 *   1. Lança erro "[agent-timeout] ${nome}: ${ms}ms"
 *   2. Se slotState.browserSession existe, marca como morto pra recriação
 *      no próximo job (resolve o problema de BrowserSession zumbi onde
 *      isConnected()=true mas operações newContext/newPage penduram)
 *   3. finally do withBrowserSlot libera o slot naturalmente — sem
 *      force-release que daria SIGTRAP
 *
 * A Promise interna do processar() continua rodando em background (JS não
 * cancela Promise), mas:
 *   - O próximo job NUNCA reusa o browser zumbi (foi marcado morto)
 *   - Eventualmente o GC + crash detection do BrowserSession recolhe
 *   - O slot está liberado, então fila volta a fluir
 *
 * Isso resolve o caso documentado: agent-correcao trava em browser.newContext
 * ou context.newPage (sem timeout próprio), browser-pool fica 4/4 ocupado pra
 * sempre, sla-detector e liberar-ponto bloqueiam em "aguardando slot".
 */

'use strict';

const { logger } = require('../../../config/logger');
const { withBrowserSlot, snapshot: poolSnapshot } = require('./browser-pool');
const { criarSessionManager } = require('./session-manager');

const _agentes = new Map(); // nome → agente
let _cronModule = null; // node-cron lazy load

function log(agente, msg) {
  logger.info(`[agent-pool/${agente}] ${msg}`);
}
function logErr(agente, msg) {
  logger.error(`[agent-pool/${agente}] ${msg}`);
}
function logWarn(agente, msg) {
  logger.warn(`[agent-pool/${agente}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Envolve uma promise com timeout. Quando o timeout dispara:
 *   - Rejeita imediatamente com Error('[agent-timeout] ...')
 *   - A promise original continua rodando em background (JS não cancela)
 *   - Marca slotState.browserSession como morto (se existir) pra forçar
 *     recriação no próximo job, evitando que próximo job reuse browser zumbi.
 *
 * @param {Promise} promise — promise a ser limitada
 * @param {number} ms — timeout em ms
 * @param {string} nomeAgente — nome do agente (pra mensagem de erro)
 * @param {object} slotState — slotState do agente (pode conter browserSession)
 * @returns {Promise} — resultado da promise OU rejeita com timeout
 */
function _comTimeoutAgente(promise, ms, nomeAgente, slotState) {
  let timer;
  let timedOut = false;

  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Marca BrowserSession como morto pra recriação no próximo job.
      // Isso resolve o caso onde o browser persistente ficou em estado
      // zumbi (isConnected()=true mas WS travado em newContext/newPage).
      try {
        if (slotState && slotState.browserSession &&
            typeof slotState.browserSession._marcarMorto === 'function') {
          slotState.browserSession._marcarMorto();
          logWarn(nomeAgente, `🩺 timeout disparou — BrowserSession marcada como morta pra recriação no próximo job`);
        }
      } catch (e) {
        // Não pode falhar no setTimeout — ignora silenciosamente
      }
      rej(new Error(`[agent-timeout] ${nomeAgente}: ${ms}ms excedido (slot pode ter ficado preso em chamada Playwright sem timeout próprio)`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    // Se a promise original resolver/rejeitar APÓS o timeout, fica no .catch
    // pra não dar UnhandledPromiseRejection. O resultado é descartado.
    if (timedOut) {
      promise.catch(() => {});
    }
  });
}

/**
 * Registra um agente (criado via defineAgent) no pool.
 * Não inicia automaticamente — chame `startAll(pool)` depois.
 */
function register(agente) {
  if (!agente || !agente.nome) {
    throw new Error('agent-pool.register: agente inválido');
  }
  if (_agentes.has(agente.nome)) {
    throw new Error(`agent-pool.register: agente "${agente.nome}" já registrado`);
  }
  _agentes.set(agente.nome, agente);
  log(agente.nome, `📝 Registrado (slots: ${agente.slots}, sessionStrategy: ${agente.sessionStrategy}, timeoutMs: ${agente.timeoutMs})`);
}

/**
 * Inicia todos os agentes habilitados.
 */
function startAll(pool) {
  for (const agente of _agentes.values()) {
    if (!agente.habilitado()) {
      log(agente.nome, '⏸️ Desabilitado (habilitado() retornou false)');
      continue;
    }
    if (agente._ativo) {
      log(agente.nome, '⚠️ Já ativo, ignorando start');
      continue;
    }
    _startAgente(pool, agente);
  }
}

/**
 * Para todos os agentes (graceful shutdown).
 */
async function stopAll() {
  for (const agente of _agentes.values()) {
    agente._ativo = false;
  }
  // Espera até 30s pros loops perceberem o stop e finalizarem trabalho em curso
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const aindaAtivos = Array.from(_agentes.values()).filter(a => a._slotsAtivos > 0);
    if (aindaAtivos.length === 0) break;
    await sleep(500);
  }
}

function _startAgente(pool, agente) {
  agente._ativo = true;
  agente._stats.iniciadoEm = new Date().toISOString();

  // Session manager (mesmo se sessionStrategy = null, criamos o objeto vazio)
  let sessao = null;
  if (agente.sessionStrategy) {
    sessao = criarSessionManager(agente.nome, agente.sessionStrategy, agente.envPrefix);
  }

  // Modo cron (cron expression definida)
  if (agente.cronExpression) {
    _iniciarCron(pool, agente, sessao);
    return;
  }

  // Modo tickGlobal (1 função única por tick, polling simples)
  if (agente.tickGlobal) {
    _iniciarTickGlobal(pool, agente, sessao);
    return;
  }

  // Modo padrão: N slots paralelos consumindo fila item por item
  log(agente.nome, `▶️ Iniciado em modo paralelo (${agente.slots} slot(s), timeout: ${agente.timeoutMs}ms)`);
  for (let i = 0; i < agente.slots; i++) {
    _loopSlot(pool, agente, sessao, i).catch(err => {
      logErr(agente.nome, `slot[${i}] crashed loop: ${err.message}`);
    });
  }
}

/**
 * Loop infinito de 1 slot lógico do agente. Múltiplos slots rodam em paralelo,
 * cada um com sua própria invocação de _loopSlot. SKIP LOCKED garante que
 * pegam itens diferentes da fila.
 *
 * IMPORTANTE: o "slot lógico" (slotIdx) é diferente do "slot do browser-pool"
 * (que é global e atribuído dentro de withBrowserSlot). O slotIdx serve só
 * pra credenciais/sessão (se isolada): slot lógico 0 → conta 1, etc.
 */
async function _loopSlot(pool, agente, sessao, slotIdx) {
  agente._slotsAtivos++;

  // Estado privado do slot — pode ser preenchido pelo onSlotStart e lido
  // pelo processar() via ctx.slotState. Uso principal: browser persistente.
  let slotState = {};
  log(agente.nome, `▶️ slot lógico ${slotIdx} entrou no loop`);

  // Hook de inicialização do slot (ex: criar browser persistente)
  if (typeof agente.onSlotStart === 'function') {
    try {
      const ctxInit = {
        slotIdx,
        log: (msg) => log(agente.nome, `slot[${slotIdx}] ${msg}`),
        sessao,
        slotState,
      };
      const ret = await agente.onSlotStart(pool, ctxInit);
      if (ret && typeof ret === 'object') slotState = ret;
    } catch (err) {
      logErr(agente.nome, `slot[${slotIdx}] onSlotStart falhou: ${err.message}`);
    }
  }

  // Hook de encerramento do slot
  async function _chamarOnSlotStop() {
    if (typeof agente.onSlotStop === 'function') {
      try {
        await agente.onSlotStop(pool, { slotIdx, slotState });
      } catch (err) {
        logErr(agente.nome, `slot[${slotIdx}] onSlotStop falhou: ${err.message}`);
      }
    }
  }

  try {
    while (agente._ativo) {
      let registro = null;
      try {
        registro = await agente.buscarPendentes(pool, 1);
        // buscarPendentes pode retornar [registro] ou registro ou null
        if (Array.isArray(registro)) registro = registro[0] || null;

        if (!registro) {
          await sleep(agente.intervalo);
          continue;
        }

        if (agente.marcarProcessando) {
          await agente.marcarProcessando(pool, registro);
        }

        agente._stats.ticksTotais++;
        agente._stats.ultimoTickEm = new Date().toISOString();

        // Encapsula no browser-pool (espera slot livre globalmente)
        await withBrowserSlot(`${agente.nome}-${slotIdx}`, async (browserSlotId) => {
          const ctx = {
            slotId:    browserSlotId,
            slotIdx,         // slot lógico do agente (pra credenciais)
            log:       (msg) => log(agente.nome, `slot[${slotIdx}] ${msg}`),
            sessao,
            slotState,       // estado persistente do slot (ex: browser)
            ehParaParar: () => !agente._ativo,
          };
          // 🛡️ DEFESA CONTRA DEADLOCK: processar() envelopado com timeout.
          // Se a chamada do Playwright travar (newContext/newPage zumbi),
          // o timeout dispara, marca BrowserSession como morto, e o finally
          // do withBrowserSlot libera o slot.
          await _comTimeoutAgente(
            agente.processar(pool, registro, ctx),
            agente.timeoutMs,
            agente.nome,
            slotState
          );
        });

        agente._stats.ticksComSucesso++;
      } catch (err) {
        agente._stats.ticksComErro++;
        agente._stats.ultimoErroEm = new Date().toISOString();
        agente._stats.ultimoErroMsg = err.message;

        // Contabiliza timeouts separadamente pra métricas
        if (err.message && err.message.startsWith('[agent-timeout]')) {
          agente._stats.ticksComTimeout++;
          logErr(agente.nome, `slot[${slotIdx}] ⏱️ TIMEOUT: ${err.message}`);
        } else {
          logErr(agente.nome, `slot[${slotIdx}] erro: ${err.message}`);
        }

        try {
          if (registro) {
            await agente.onErro(pool, registro, err);
          }
        } catch (e2) {
          logErr(agente.nome, `slot[${slotIdx}] onErro também falhou: ${e2.message}`);
        }

        // Pequeno back-off pra não floodar em caso de erro recorrente
        await sleep(2000);
      }
    }
  } finally {
    agente._slotsAtivos--;
    log(agente.nome, `⏹️ slot lógico ${slotIdx} saiu do loop`);
    await _chamarOnSlotStop();
  }
}

/**
 * Loop pra agentes com tickGlobal (sem fila item por item).
 */
async function _iniciarTickGlobal(pool, agente, sessao) {
  log(agente.nome, `▶️ Iniciado em modo tickGlobal (intervalo: ${agente.intervalo}ms, timeout: ${agente.timeoutMs}ms)`);

  agente._slotsAtivos++;
  // tickGlobal não tem slotState persistente (cada tick é independente).
  // Mas mantemos o objeto vazio pra compat com _comTimeoutAgente.
  const slotStateVazio = {};

  (async () => {
    try {
      while (agente._ativo) {
        try {
          agente._stats.ticksTotais++;
          agente._stats.ultimoTickEm = new Date().toISOString();

          await withBrowserSlot(`${agente.nome}-global`, async (browserSlotId) => {
            const ctx = {
              slotId: browserSlotId,
              slotIdx: 0,
              log:    (msg) => log(agente.nome, msg),
              sessao,
              slotState: slotStateVazio,
              ehParaParar: () => !agente._ativo,
            };
            await _comTimeoutAgente(
              agente.tickGlobal(pool, ctx),
              agente.timeoutMs,
              agente.nome,
              slotStateVazio
            );
          });

          agente._stats.ticksComSucesso++;
        } catch (err) {
          agente._stats.ticksComErro++;
          agente._stats.ultimoErroEm = new Date().toISOString();
          agente._stats.ultimoErroMsg = err.message;

          if (err.message && err.message.startsWith('[agent-timeout]')) {
            agente._stats.ticksComTimeout++;
            logErr(agente.nome, `⏱️ TIMEOUT tickGlobal: ${err.message}`);
          } else {
            logErr(agente.nome, `tickGlobal erro: ${err.message}`);
          }
        }

        if (agente.apenasUmTick) {
          agente._ativo = false;
          break;
        }

        await sleep(agente.intervalo);
      }
    } finally {
      agente._slotsAtivos--;
    }
  })().catch(err => {
    logErr(agente.nome, `tickGlobal loop crashed: ${err.message}`);
  });
}

/**
 * Loop pra agentes em cron expression (substitui o gating manual de horário).
 */
function _iniciarCron(pool, agente, sessao) {
  if (!_cronModule) {
    try {
      _cronModule = require('node-cron');
    } catch (e) {
      logErr(agente.nome, 'node-cron não está instalado, agente cron não vai rodar');
      return;
    }
  }

  log(agente.nome, `▶️ Cron agendado: "${agente.cronExpression}" (TZ: ${agente.timezone}, timeout: ${agente.timeoutMs}ms)`);

  let rodandoAgora = false;
  const slotStateVazio = {};

  _cronModule.schedule(agente.cronExpression, async () => {
    if (!agente._ativo) return;
    if (rodandoAgora) {
      log(agente.nome, '⏭️ Tick cron pulado (anterior ainda rodando)');
      return;
    }
    rodandoAgora = true;
    agente._slotsAtivos++;

    try {
      agente._stats.ticksTotais++;
      agente._stats.ultimoTickEm = new Date().toISOString();

      await withBrowserSlot(`${agente.nome}-cron`, async (browserSlotId) => {
        const ctx = {
          slotId: browserSlotId,
          slotIdx: 0,
          log:    (msg) => log(agente.nome, msg),
          sessao,
          slotState: slotStateVazio,
          ehParaParar: () => !agente._ativo,
        };
        await _comTimeoutAgente(
          agente.tickGlobal(pool, ctx),
          agente.timeoutMs,
          agente.nome,
          slotStateVazio
        );
      });

      agente._stats.ticksComSucesso++;
    } catch (err) {
      agente._stats.ticksComErro++;
      agente._stats.ultimoErroEm = new Date().toISOString();
      agente._stats.ultimoErroMsg = err.message;

      if (err.message && err.message.startsWith('[agent-timeout]')) {
        agente._stats.ticksComTimeout++;
        logErr(agente.nome, `⏱️ TIMEOUT cron: ${err.message}`);
      } else {
        logErr(agente.nome, `cron erro: ${err.message}`);
      }
    } finally {
      agente._slotsAtivos--;
      rodandoAgora = false;
    }
  }, { timezone: agente.timezone });
}

/**
 * Snapshot completo do estado do pool — pra endpoint de health/debug.
 */
function snapshot() {
  const agentes = Array.from(_agentes.values()).map(a => ({
    nome:             a.nome,
    slots:            a.slots,
    sessionStrategy:  a.sessionStrategy,
    intervalo:        a.intervalo,
    timeoutMs:        a.timeoutMs,
    cronExpression:   a.cronExpression,
    ativo:            a._ativo,
    slotsAtivos:      a._slotsAtivos,
    stats:            { ...a._stats },
  }));

  return {
    browserPool: poolSnapshot(),
    agentes,
  };
}

module.exports = {
  register,
  startAll,
  stopAll,
  snapshot,
};
