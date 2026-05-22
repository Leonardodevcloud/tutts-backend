/**
 * agents/sla-detector.agent.js
 *
 * Varre OS em execução a cada 2 min e enfileira em sla_capturas.
 *
 * 2026-05: sla-detector.service faz o require de playwright-sla-capture
 * internamente dentro de detectarOsNovas(), quando o módulo já está
 * 100% no cache — sem dependência circular.
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
  // 🛡️ 2026-05 fix-deadlock: timeout máximo do tick cron.
  // Detector só faz varredura de OS em execução — é rápido (page.goto + parse).
  // 90s já cobre folgado + retries. Se passar disso, é certeza que travou.
  timeoutMs: Number(process.env.SLA_DETECTOR_TIMEOUT_MS || 90_000), // 1.5 min

  habilitado: () => (process.env.SLA_DETECTOR_ATIVO || 'false').toLowerCase() === 'true',

  tickGlobal: async (pool, ctx) => {
    ctx.log('🔍 Iniciando varredura de OS em execução');
    // Não passa coletarOsEmExecucao — o service faz o require internamente
    // quando o módulo playwright-sla-capture já está completo no cache.
    const resultado = await slaDetectorService.detectarOsNovas(pool);
    ctx.log('✅ Varredura concluída: ' + JSON.stringify(resultado));
  },
});
