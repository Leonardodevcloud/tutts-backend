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

// 🆕 2026-07 janela-sabado: detector passa a rodar tambem no sabado.
// Cron ampliado pra 1-6 (seg-sab). A janela fina (sabado ate 13h) e cortada
// pelo guard dentroJanela() no tickGlobal, ja que o cron nao permite horas
// diferentes por dia numa unica expressao.
//   seg-sex: 08h-18h  |  sabado: 08h-13h  |  domingo: nao roda
const CRON_DEFAULT = '*/2 8-18 * * 1-6';

// Janela de operacao (hora local America/Bahia). Fonte de verdade mesmo que
// SLA_DETECTOR_CRON seja sobrescrito no ambiente.
function dentroJanela() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
  const dia  = agora.getDay();   // 0=Dom, 1=Seg ... 6=Sab
  const hora = agora.getHours();
  if (dia === 0) return false;                    // domingo: nunca
  if (dia === 6) return hora >= 8 && hora <= 13;  // sabado: 08h-13h
  return hora >= 8 && hora <= 18;                 // seg-sex: 08h-18h
}

module.exports = defineAgent({
  nome: 'sla-detector',
  slots: 1,
  sessionStrategy: 'compartilhada',
  envPrefix: 'SISTEMA_EXTERNO_SLA',
  cronExpression: process.env.SLA_DETECTOR_CRON || CRON_DEFAULT,
  timezone: 'America/Bahia',
  // 🛡️ 2026-05 fix-deadlock: timeout máximo do tick cron.
  // 🆕 2026-07 v2.1: tick agora inclui aba "Sem profissional" (budget 40s,
  // SLA_MONITOR_SEMPROF_TEMPO_MAX_MS) + busca de km (60s). Timeout default
  // sobe pra 240s. Se passar disso, é certeza que travou.
  timeoutMs: Number(process.env.SLA_DETECTOR_TIMEOUT_MS || 240_000), // 4 min

  habilitado: () => (process.env.SLA_DETECTOR_ATIVO || 'false').toLowerCase() === 'true',

  tickGlobal: async (pool, ctx) => {
    // 🆕 2026-07 janela-sabado: dorme fora da janela (America/Bahia).
    if (!dentroJanela()) {
      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
      ctx.log(`😴 Fora da janela (dia=${agora.getDay()}, ${agora.getHours()}h) — pulando tick.`);
      return;
    }

    ctx.log('🔍 Iniciando tick SLA (snapshot + detecção de rastreio)');
    // 🆕 2026-07: tickCompleto faz UMA coleta que alimenta:
    //   1. sla_monitor_snapshot (SLA server-side — substitui extensão v8)
    //   2. detectarOsNovas (rastreio 814/767 — injeta coleta pronta, sem
    //      abrir um segundo browser)
    const resultado = await slaMonitorService.tickCompleto(pool);
    ctx.log('✅ Tick concluído: ' + JSON.stringify(resultado));
  },
});
