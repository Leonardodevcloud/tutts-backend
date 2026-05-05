/**
 * agents/sla-detector.agent.js
 *
 * Varre OS em execução a cada 2 min e enfileira em sla_capturas.
 *
 * 2026-05: dependência circular resolvida por injeção.
 * Este agente faz o lazy require de playwright-sla-capture e passa
 * coletarOsEmExecucao como parâmetro pro service — o service não importa
 * playwright-sla-capture de forma alguma, cortando o ciclo na raiz.
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const slaDetectorService = require('../sla-detector.service');

const CRON_DEFAULT = '*/2 8-18 * * 1-5';

module.exports = defineAgent({
  nome: 'sla-detector',
  slots: 1,
  sessionStrategy: 'compartilhada',
  envPrefix: 'SISTEMA_EXTERNO_SLA',
  cronExpression: process.env.SLA_DETECTOR_CRON || CRON_DEFAULT,
  timezone: 'America/Bahia',

  habilitado: () => (process.env.SLA_DETECTOR_ATIVO || 'false').toLowerCase() === 'true',

  tickGlobal: async (pool, ctx) => {
    ctx.log('🔍 Iniciando varredura de OS em execução');

    // Lazy require aqui — único ponto de contato com playwright-sla-capture.
    // Executado dentro do tickGlobal (não no topo do módulo), quando todos os
    // módulos já estão 100% carregados, sem risco de ciclo.
    const { coletarOsEmExecucao } = require('../playwright-sla-capture');

    // Injeta a função no service — sem acoplamento de import lá
    const resultado = await slaDetectorService.detectarOsNovas(pool, coletarOsEmExecucao);
    ctx.log(`✅ Varredura concluída: ${JSON.stringify(resultado)}`);
  },
});
