/**
 * agents/fila-validador.agent.js
 *
 * Agente Playwright que valida a fila auto-gerenciável.
 *
 * O QUE FAZ:
 *   - A cada N segundos (configurável por central, default 30s)
 *   - Lista motoboys aguardando em filas_posicoes (centrais tipo='auto')
 *   - Navega na ACOMP do sistema Tutts (reusa código do sla-capture)
 *   - Extrai <tr[data-order-id]> com cod_profissional (button[data-motoboy])
 *   - Cruza: motoboys com OS aberta → marca/remove (config remover_ao_pegar_corrida)
 *   - Compacta posições e grava logs
 *
 * COMO RODA:
 *   - tickGlobal (não slot por slot) — uma varredura por ciclo
 *   - Browser persistente reaproveitado (padrão pós-fix EAGAIN do agent-correcao)
 *   - cron-like via setTimeout encadeado (intervalo dinâmico baseado em
 *     min(varredura_intervalo_seg) das centrais ativas)
 *
 * HABILITAÇÃO:
 *   - Variável FILA_VALIDADOR_ATIVO=true
 *   - Pelo menos 1 central com tipo='auto' AND validacao_agente_ativa=true
 *
 * MESMO PADRÃO do sla-detector (defineAgent + tickGlobal), mas usa
 * sessionStrategy 'compartilhada' (uma sessão login serve pra todas centrais).
 */
'use strict';

const { defineAgent } = require('../core/agent-base');
const filaValidadorService = require('../../filas/fila-validador.service');

// 🔧 v2 (2026-05-25): intervalo 5min pra reduzir pressão de memória.
// 🔧 v3 (2026-05-28): janela de operação 07h–18h (America/Bahia).
//   Fora da janela: tick retorna imediatamente sem subir browser.
//   Login reutiliza a mesma sessão do sla-capture (SISTEMA_EXTERNO_SLA).
const INTERVALO_DEFAULT_MS = 5 * 60_000; // 5 minutos

// Janela de operação (hora local America/Bahia)
const HORA_INICIO = 7;   // 07:00
const HORA_FIM    = 18;  // 18:00 (exclusive)

function dentroJanela() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
  const hora  = agora.getHours();
  return hora >= HORA_INICIO && hora < HORA_FIM;
}

// Cache do último resultado bem-sucedido (compartilhado entre ticks).
// Se a coleta foi feita há <4min, REUSA em vez de subir browser novo.
// Default propositalmente menor que INTERVALO_DEFAULT_MS pra garantir
// que SEMPRE rodemos uma coleta nova no início do tick (a menos que
// outro processo tenha acabado de coletar — improvável mas defensivo).
const CACHE_TTL_MS = 4 * 60_000; // 4 minutos
let _cacheUltimaColeta = null; // { timestampMs, mapaCorridas }

// Circuit breaker: se N falhas seguidas, pausa por COOLDOWN_MS.
// Evita loop infinito de OOM quando algo tá fundamentalmente quebrado.
const CIRCUIT_BREAKER_LIMITE = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60_000; // 10 minutos
let _falhasConsecutivas = 0;
let _circuitAbertoAte = 0; // timestamp em ms

module.exports = defineAgent({
  nome: 'fila-validador',
  slots: 1,
  sessionStrategy: 'compartilhada',
  envPrefix: 'SISTEMA_EXTERNO_SLA',
  intervalo: INTERVALO_DEFAULT_MS,

  habilitado: () => (process.env.FILA_VALIDADOR_ATIVO || 'false').toLowerCase() === 'true',

  tickGlobal: async (pool, ctx) => {
    const inicio = Date.now();

    // 🔧 v3: Janela de operação — dorme fora de 07h-18h (America/Bahia)
    if (!dentroJanela()) {
      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
      ctx.log(`😴 Fora da janela de operação (${agora.getHours()}h) — aguardando 07h. Pulando.`);
      return;
    }

    // 🔧 v2: Circuit breaker — se quebrou demais, pausa
    if (_circuitAbertoAte > inicio) {
      const restanteMin = Math.ceil((_circuitAbertoAte - inicio) / 60_000);
      ctx.log(`⏸️ Circuit breaker ABERTO — pulando varredura (volta em ~${restanteMin}min)`);
      return;
    }

    // 1) Tem centrais ativas auto?
    const centrais = await filaValidadorService.listarCentraisAtivasAuto(pool);
    if (centrais.length === 0) {
      ctx.log('Nenhuma central auto ativa — pulando varredura');
      return;
    }

    // 2) Tem motoboys aguardando?
    const motoboys = await filaValidadorService.listarMotoboysParaValidar(pool);
    if (motoboys.length === 0) {
      ctx.log(`${centrais.length} central(is) ativa(s), 0 motoboys aguardando — pulando`);
      return;
    }

    ctx.log(`🔍 Varredura: ${motoboys.length} motoboy(s) em ${centrais.length} central(is)`);

    // 3) Coleta corridas ativas via Playwright (lazy-require pra evitar
    //    circular — sla-capture pode requisitar coisas deste arquivo no futuro)
    const slaCapture = require('../playwright-sla-capture');
    let mapaCorridas;
    let usouCache = false;
    try {
      // 🔧 v2: tenta usar cache antes de subir chromium novo
      const agora = Date.now();
      if (_cacheUltimaColeta && (agora - _cacheUltimaColeta.timestampMs) < CACHE_TTL_MS) {
        const idadeSec = Math.round((agora - _cacheUltimaColeta.timestampMs) / 1000);
        ctx.log(`♻️ Usando cache da coleta anterior (idade: ${idadeSec}s) — pulando chromium`);
        mapaCorridas = _cacheUltimaColeta.mapaCorridas;
        usouCache = true;
      } else {
        mapaCorridas = await coletarCorridasAtivasPorMotoboy(slaCapture, ctx);
        _cacheUltimaColeta = { timestampMs: agora, mapaCorridas };
      }
      _falhasConsecutivas = 0; // sucesso reseta contador
    } catch (err) {
      _falhasConsecutivas++;
      ctx.log(`❌ Falha ao coletar ACOMP (${_falhasConsecutivas}/${CIRCUIT_BREAKER_LIMITE}): ${err.message}`);

      // 🔧 v2: ativa circuit breaker se passou do limite
      if (_falhasConsecutivas >= CIRCUIT_BREAKER_LIMITE) {
        _circuitAbertoAte = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        const cooldownMin = Math.round(CIRCUIT_BREAKER_COOLDOWN_MS / 60_000);
        ctx.log(`🔥 Circuit breaker ATIVADO após ${_falhasConsecutivas} falhas consecutivas. Pausando por ${cooldownMin}min.`);

        // 🔧 v3 (2026-05-25): alerta WhatsApp pro Tutts saber em segundos
        try {
          const { enviarAlerta } = require('../../../shared/alert-whatsapp');
          enviarAlerta(
            'fila-validador-circuit',
            `🔥 *Fila validador parou*\n\n` +
            `O agente que remove motoboys da fila quando pegam corrida ` +
            `falhou ${_falhasConsecutivas} vezes seguidas.\n\n` +
            `Último erro: _${err.message}_\n\n` +
            `Pausado por ${cooldownMin} minutos. Operação manual pode ser necessária.`
          ).catch(() => {});
        } catch (e) { /* alert-whatsapp pode não estar disponível */ }

        _falhasConsecutivas = 0; // reseta pra próxima janela
      }
      // Sem dados confiáveis — sai. É melhor não fazer nada do que remover indevidamente.
      return;
    }

    // 4) Aplica resultado
    const resultado = await filaValidadorService.aplicarResultadoVarredura(pool, mapaCorridas);

    const elapsedMs = Date.now() - inicio;
    ctx.log(
      `✅ Varredura completa em ${elapsedMs}ms${usouCache ? ' (cache)' : ''} · ` +
      `${resultado.validados} validados, ${resultado.removidos} removidos, ${resultado.erros} erros`
    );
  },
});

/**
 * Coleta as corridas ativas da ACOMP e agrupa por cod_profissional.
 * Retorna Map<string, Array<{os_numero}>>
 *
 * Reaproveita a função do sla-capture que já sabe navegar na ACOMP
 * (em-execucao + entregando) e extrair os <tr[data-order-id]> com seus
 * cod_profissional. Aqui só agrupamos.
 *
 * @param {object} slaCapture módulo playwright-sla-capture
 * @param {object} ctx ctx.log, ctx.sessao
 * @returns {Promise<Map<string, Array<{os_numero}>>>}
 */
async function coletarCorridasAtivasPorMotoboy(slaCapture, ctx) {
  // O sla-capture expõe uma função coletarOsEmExecucao() que retorna
  // 🔄 2026-05-24: um OBJETO { ok, ordens, totalEsperado, ... } — NÃO array direto.
  // Antes: `for (const os of todasOs || [])` quebrava com "is not iterable".
  if (typeof slaCapture.coletarOsEmExecucao !== 'function') {
    throw new Error('playwright-sla-capture.coletarOsEmExecucao indisponível');
  }
  const resultado = await slaCapture.coletarOsEmExecucao();
  if (!resultado || !resultado.ok) {
    throw new Error(
      `coletarOsEmExecucao falhou: motivo=${resultado?.motivo || 'desconhecido'}` +
      `${resultado?.sessaoExpirada ? ' (sessão expirada)' : ''}`
    );
  }
  const todasOs = resultado.ordens || [];

  const mapa = new Map();
  for (const os of todasOs) {
    const cod = String(os.cod_profissional || '').trim();
    if (!cod) continue;
    if (!mapa.has(cod)) mapa.set(cod, []);
    mapa.get(cod).push({ os_numero: os.os_numero || null });
  }
  return mapa;
}
