/**
 * agents/sla-detector.agent.js
 *
 * Varre OS em execução a cada 2 min e enfileira em sla_capturas.
 *
 * 2026-05: usa sla-capture-api.js (wrapper sem ciclo) em vez de
 * importar playwright-sla-capture diretamente.
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const slaDetectorService = require('../sla-detector.service');
const slaCaptureApi = require('../sla-capture-api');

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

    // Tenta via getter do sla-capture-api primeiro
    let fnColetar = slaCaptureApi.coletarOsEmExecucao;
    ctx.log('[diag] tipo via getter: ' + typeof fnColetar);

    // Fallback: require direto se getter falhou
    if (typeof fnColetar !== 'function') {
      ctx.log('[diag] getter falhou — require direto');
      try {
        const pw = require('../playwright-sla-capture');
        fnColetar = pw.coletarOsEmExecucao;
        ctx.log('[diag] após require direto: ' + typeof fnColetar);
      } catch (e) {
        ctx.log('[diag] require direto falhou: ' + e.message);
      }
    }

    if (typeof fnColetar !== 'function') {
      ctx.log('[diag] FALHA TOTAL: coletarOsEmExecucao indisponível');
      return;
    }

    const resultado = await slaDetectorService.detectarOsNovas(pool, fnColetar);
    ctx.log('✅ Varredura concluída: ' + JSON.stringify(resultado));
  },
});
