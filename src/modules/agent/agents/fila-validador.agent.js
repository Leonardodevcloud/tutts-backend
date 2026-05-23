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

// Default: a cada 30s. Ajustável por central via filas_centrais.varredura_intervalo_seg
// (pegamos o MIN das ativas — quem quer mais frequente "ganha").
const INTERVALO_DEFAULT_MS = 30_000;

module.exports = defineAgent({
  nome: 'fila-validador',
  slots: 1,
  sessionStrategy: 'compartilhada',
  envPrefix: 'SISTEMA_EXTERNO_SLA',
  intervalo: INTERVALO_DEFAULT_MS,

  habilitado: () => (process.env.FILA_VALIDADOR_ATIVO || 'false').toLowerCase() === 'true',

  tickGlobal: async (pool, ctx) => {
    const inicio = Date.now();

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
    try {
      mapaCorridas = await coletarCorridasAtivasPorMotoboy(slaCapture, ctx);
    } catch (err) {
      ctx.log(`❌ Falha ao coletar ACOMP: ${err.message}`);
      // Sem dados confiáveis — marca todos como pendente e sai.
      // É melhor não fazer nada do que remover indevidamente.
      return;
    }

    // 4) Aplica resultado
    const resultado = await filaValidadorService.aplicarResultadoVarredura(pool, mapaCorridas);

    const elapsedMs = Date.now() - inicio;
    ctx.log(
      `✅ Varredura completa em ${elapsedMs}ms · ` +
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
  // [{os_numero, cod_profissional, ...}, ...]. Se um dia mudar o nome,
  // ajustar aqui.
  if (typeof slaCapture.coletarOsEmExecucao !== 'function') {
    throw new Error('playwright-sla-capture.coletarOsEmExecucao indisponível');
  }
  const todasOs = await slaCapture.coletarOsEmExecucao();

  const mapa = new Map();
  for (const os of todasOs || []) {
    const cod = String(os.cod_profissional || '').trim();
    if (!cod) continue;
    if (!mapa.has(cod)) mapa.set(cod, []);
    mapa.get(cod).push({ os_numero: os.os_numero || null });
  }
  return mapa;
}
