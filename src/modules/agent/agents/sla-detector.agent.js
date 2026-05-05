/**
 * agents/sla-detector.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente detector — varre listagem de OS em execução e enfileira em
 * sla_capturas as novas. Modo cron (não item-por-item, varredura global).
 *
 * Substitui o `sla-detector-worker.js` antigo.
 *
 * NÃO PARALELIZA — varredura global, 1 slot só faz sentido.
 * Compartilha sessão com sla-capture (mesma conta SLA).
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const slaDetectorService = require('../sla-detector.service');
// Lazy require — evita dependência circular na inicialização do módulo.
// playwright-sla-capture ← sla-capture.service ← sla-capture.agent ← agent-pool
// Resolvendo na hora da execução (dentro de tickGlobal) o ciclo não ocorre.
let _playwrightSlaCapture = null;
function getPlaywrightSlaCapture() {
  if (!_playwrightSlaCapture) {
    _playwrightSlaCapture = require('../playwright-sla-capture');
  }
  return _playwrightSlaCapture;
}

// Cron: a cada 2 minutos, Seg-Sex 08-18h, Sáb 08-12h, TZ Bahia.
// Mesma janela que o worker antigo.
const CRON_DEFAULT = '*/2 8-18 * * 1-5';
// Saturday job adicional precisa de outra entrada — agente cron suporta uma só,
// então usamos uma expressão mais ampla e o filtro fica no service se necessário.
// Por simplicidade vou manter SEG-SEX e adicionar SAB num agente irmão se o usuário pedir.

module.exports = defineAgent({
  nome: 'sla-detector',
  slots: 1,                    // varredura global, sem paralelismo
  sessionStrategy: 'compartilhada',  // mesma conta do sla-capture (slot 0)
  envPrefix: 'SISTEMA_EXTERNO_SLA',  // usa SISTEMA_EXTERNO_SLA_EMAIL/SENHA
  cronExpression: process.env.SLA_DETECTOR_CRON || CRON_DEFAULT,
  timezone: 'America/Bahia',

  habilitado: () => (process.env.SLA_DETECTOR_ATIVO || 'false').toLowerCase() === 'true',

  // tickGlobal em vez de buscarPendentes/processar — 1 função única por execução
  tickGlobal: async (pool, ctx) => {
    ctx.log('🔍 Iniciando varredura de OS em execução');

    // Configura overrides — slot 0 / conta 1 (compartilhada)
    const creds = ctx.sessao.credenciaisDoSlot(0);
    const sessionFile = ctx.sessao.caminhoSessao(0);

    const playwrightSlaCapture = getPlaywrightSlaCapture();
    playwrightSlaCapture.setOverrides({
      sessionFile,
      credentials: { email: creds.email, senha: creds.senha },
    });

    try {
      const resultado = await slaDetectorService.detectarOsNovas(pool);
      ctx.log(`✅ Varredura concluída: ${JSON.stringify(resultado)}`);
    } finally {
      playwrightSlaCapture.clearOverrides();
    }
  },
});
