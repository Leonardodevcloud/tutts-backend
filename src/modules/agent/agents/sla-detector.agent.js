/**
 * agents/sla-detector.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente detector — varre listagem de OS em execução e enfileira em
 * sla_capturas as novas. Modo cron (não item-por-item, varredura global).
 *
 * NÃO PARALELIZA — varredura global, 1 slot só faz sentido.
 * Compartilha sessão com sla-capture (mesma conta SLA).
 *
 * 2026-05: removido setOverrides daqui.
 * coletarOsEmExecucao() já usa SISTEMA_EXTERNO_SLA_EMAIL/SENHA do env
 * diretamente quando não há override — não precisa de acoplamento com
 * playwright-sla-capture aqui, o que causava dependência circular.
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
    // coletarOsEmExecucao() usa SISTEMA_EXTERNO_SLA_EMAIL/SENHA do env.
    // Não precisa de setOverrides — sem acoplamento direto com playwright-sla-capture.
    const resultado = await slaDetectorService.detectarOsNovas(pool);
    ctx.log(`✅ Varredura concluída: ${JSON.stringify(resultado)}`);
  },
});
