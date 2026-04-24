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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
  log(agente.nome, `📝 Registrado (slots: ${agente.slots}, sessionStrategy: ${agente.sessionStrategy})`);
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
  log(agente.nome, `▶️ Iniciado em modo paralelo (${agente.slots} slot(s))`);
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
  log(agente.nome, `▶️ slot lógico ${slotIdx} entrou no loop`);

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
            ehParaParar: () => !agente._ativo,
          };
          await agente.processar(pool, registro, ctx);
        });

        agente._stats.ticksComSucesso++;
      } catch (err) {
        agente._stats.ticksComErro++;
        agente._stats.ultimoErroEm = new Date().toISOString();
        agente._stats.ultimoErroMsg = err.message;
        logErr(agente.nome, `slot[${slotIdx}] erro: ${err.message}`);

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
  }
}

/**
 * Loop pra agentes com tickGlobal (sem fila item por item).
 */
async function _iniciarTickGlobal(pool, agente, sessao) {
  log(agente.nome, `▶️ Iniciado em modo tickGlobal (intervalo: ${agente.intervalo}ms)`);

  agente._slotsAtivos++;
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
              ehParaParar: () => !agente._ativo,
            };
            await agente.tickGlobal(pool, ctx);
          });

          agente._stats.ticksComSucesso++;
        } catch (err) {
          agente._stats.ticksComErro++;
          agente._stats.ultimoErroEm = new Date().toISOString();
          agente._stats.ultimoErroMsg = err.message;
          logErr(agente.nome, `tickGlobal erro: ${err.message}`);
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

  log(agente.nome, `▶️ Cron agendado: "${agente.cronExpression}" (TZ: ${agente.timezone})`);

  let rodandoAgora = false;

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
          ehParaParar: () => !agente._ativo,
        };
        await agente.tickGlobal(pool, ctx);
      });

      agente._stats.ticksComSucesso++;
    } catch (err) {
      agente._stats.ticksComErro++;
      agente._stats.ultimoErroEm = new Date().toISOString();
      agente._stats.ultimoErroMsg = err.message;
      logErr(agente.nome, `cron erro: ${err.message}`);
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
