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
const slaMonitorService = require('../sla-monitor.service');

const CRON_DEFAULT = '*/2 8-18 * * 1-5';

module.exports = defineAgent({
  nome: 'sla-detector',
  slots: 1,
  sessionStrategy: 'compartilhada',
  envPrefix: 'SISTEMA_EXTERNO_SLA',
  cronExpression: process.env.SLA_DETECTOR_CRON || CRON_DEFAULT,
  timezone: 'America/Bahia',
  // 🛡️ 2026-05 fix-deadlock: timeout máximo do tick cron.
  // 🆕 2026-07 sla-monitor: tick agora inclui busca de km via modal
  // (teto SLA_MONITOR_KM_MAX_POR_TICK, tempo máx SLA_MONITOR_KM_TEMPO_MAX_MS
  // default 60s). Timeout default sobe pra 180s pra acomodar a coleta +
  // km-fetch + upserts. Se passar disso, é certeza que travou.
  timeoutMs: Number(process.env.SLA_DETECTOR_TIMEOUT_MS || 180_000), // 3 min

  habilitado: () => (process.env.SLA_DETECTOR_ATIVO || 'false').toLowerCase() === 'true',

  tickGlobal: async (pool, ctx) => {
    ctx.log('🔍 Iniciando tick SLA (snapshot + detecção de rastreio)');
    // 🆕 2026-07: tickCompleto faz UMA coleta que alimenta:
    //   1. sla_monitor_snapshot (SLA server-side — substitui extensão v8)
    //   2. detectarOsNovas (rastreio 814/767 — injeta coleta pronta, sem
    //      abrir um segundo browser)
    const resultado = await slaMonitorService.tickCompleto(pool);
    ctx.log('✅ Tick concluído: ' + JSON.stringify(resultado));
  },
});
