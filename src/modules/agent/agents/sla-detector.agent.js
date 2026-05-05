/**
 * agents/sla-detector.agent.js
 *
 * Varre OS em execução a cada 2 min e enfileira em sla_capturas.
 *
 * 2026-05: coletarOsEmExecucao é injetada pelo index.js via wrapper
 * do tickGlobal — zero imports de playwright-sla-capture aqui.
 * Elimina dependência circular definitivamente.
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

  // coletarOsEmExecucao é injetada pelo index.js como 3o parâmetro
  tickGlobal: async (pool, ctx, coletarOsEmExecucao) => {
    ctx.log('🔍 Iniciando varredura de OS em execução');
    const resultado = await slaDetectorService.detectarOsNovas(pool, coletarOsEmExecucao);
    ctx.log(`✅ Varredura concluída: ${JSON.stringify(resultado)}`);
  },
});
