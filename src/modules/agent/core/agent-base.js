/**
 * core/agent-base.js
 * ─────────────────────────────────────────────────────────────────────────
 * Define a "forma" de um agente. Cada agente novo é criado chamando
 * `defineAgent({...})`. O resultado é registrado no agent-pool.
 *
 * CONTRATO DO AGENTE:
 *
 *   nome            (string)   — identificador único (vira prefix de logs/locks)
 *   slots           (number)   — quantos pendentes processar em paralelo
 *   sessionStrategy ('isolada'|'compartilhada')
 *                              — 'isolada':     1 conta dedicada por slot
 *                              — 'compartilhada': todos usam mesma sessão
 *                              — null:          agente não usa Playwright
 *   intervalo       (number)   — ms entre ticks quando fila vazia
 *
 *   buscarPendentes async (pool, limite) → registro[] | null
 *                              — SELECT da fila. DEVE usar
 *                                FOR UPDATE SKIP LOCKED pra suportar
 *                                múltiplos slots concorrentes.
 *
 *   marcarProcessando async (pool, registro) → void
 *                              — UPDATE status = 'processando'.
 *                                Pode ser implícito no buscarPendentes.
 *
 *   processar async (pool, registro, ctx) → void
 *                              — lógica do agente. ctx contém:
 *                                { slotId, log, sessao, ehParaParar }
 *
 *   onErro?  async (pool, registro, err) → void
 *                              — chamado quando processar lança.
 *                                default: marca registro com erro e back-off
 *
 *   habilitado? (() => boolean) — função que decide se agente roda
 *                                 (ex: checa env). default: true
 *
 *   apenasUmTick? (boolean)    — se true, agente roda 1x e para (cron).
 *                                Se false, polling contínuo.
 *
 *   tickGlobal? async (pool, ctx) → void
 *                              — alternativa a buscarPendentes. Em vez de
 *                                processar item por item, roda 1 função
 *                                global por tick. Usado pelo sla-detector.
 */

'use strict';

const { logger } = require('../../../config/logger');

const ESTRATEGIAS_VALIDAS = ['isolada', 'compartilhada', null];

function defineAgent(spec) {
  // ── Validação ────────────────────────────────────────────────────────
  if (!spec || typeof spec !== 'object') {
    throw new Error('defineAgent: spec deve ser objeto');
  }
  if (!spec.nome || typeof spec.nome !== 'string') {
    throw new Error('defineAgent: nome obrigatório');
  }
  if (!Number.isInteger(spec.slots) || spec.slots < 1 || spec.slots > 10) {
    throw new Error(`defineAgent[${spec.nome}]: slots inválido (1-10)`);
  }
  if (spec.sessionStrategy !== undefined && !ESTRATEGIAS_VALIDAS.includes(spec.sessionStrategy)) {
    throw new Error(
      `defineAgent[${spec.nome}]: sessionStrategy inválida ` +
      `(esperado: isolada|compartilhada|null)`
    );
  }

  // Pelo menos uma das duas funções de "trabalho"
  const temItemPorItem = typeof spec.buscarPendentes === 'function' &&
                         typeof spec.processar === 'function';
  const temGlobal      = typeof spec.tickGlobal === 'function';

  if (!temItemPorItem && !temGlobal) {
    throw new Error(
      `defineAgent[${spec.nome}]: defina (buscarPendentes + processar) ` +
      `OU (tickGlobal)`
    );
  }
  if (temItemPorItem && temGlobal) {
    throw new Error(
      `defineAgent[${spec.nome}]: use OU (buscarPendentes + processar) ` +
      `OU (tickGlobal), nunca ambos`
    );
  }

  // Defaults
  const agente = {
    nome:             spec.nome,
    slots:            spec.slots,
    sessionStrategy:  spec.sessionStrategy === undefined ? 'isolada' : spec.sessionStrategy,
    envPrefix:        spec.envPrefix || 'SISTEMA_EXTERNO',
    intervalo:        spec.intervalo || 5_000,
    buscarPendentes:  spec.buscarPendentes || null,
    marcarProcessando:spec.marcarProcessando || null,
    processar:        spec.processar || null,
    tickGlobal:       spec.tickGlobal || null,
    onErro:           spec.onErro || _onErroDefault,
    habilitado:       spec.habilitado || (() => true),
    apenasUmTick:     spec.apenasUmTick === true,
    cronExpression:   spec.cronExpression || null,
    timezone:         spec.timezone || 'America/Bahia',

    // Estado interno (preenchido pelo pool)
    _ativo:    false,
    _slotsAtivos: 0,
    _stats: {
      iniciadoEm:        null,
      ticksTotais:       0,
      ticksComSucesso:   0,
      ticksComErro:      0,
      ultimoTickEm:      null,
      ultimoErroEm:      null,
      ultimoErroMsg:     null,
    },
  };

  return agente;
}

// onErro default — quando o agente não define um próprio
async function _onErroDefault(pool, registro, err) {
  logger.error(`[agent-base] erro padrão (sem onErro custom): ${err.message}`);
  // Não faz nada — espera-se que o próprio service do agente atualize
  // status 'processando' → 'pendente'/'falhou' nos seus catches internos.
}

module.exports = {
  defineAgent,
};
