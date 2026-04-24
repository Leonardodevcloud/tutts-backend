/**
 * agents/sla-capture.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente de captura de pontos de OS (rastreio WhatsApp).
 * Paralelizado: N slots, 1 conta SLA por slot.
 *
 * Substitui o `sla-capture-worker.js` antigo.
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const slaCaptureService = require('../sla-capture.service');
const playwrightSlaCapture = require('../playwright-sla-capture');

const SLOTS = Number(process.env.POOL_SLA_CAPTURE_SLOTS || 3);

module.exports = defineAgent({
  nome: 'sla-capture',
  slots: SLOTS,
  sessionStrategy: 'isolada',  // 1 conta SLA por slot
  envPrefix: 'SISTEMA_EXTERNO_SLA',  // usa SISTEMA_EXTERNO_SLA_EMAIL_N
  intervalo: 5_000,            // 5s entre ticks quando fila vazia

  habilitado: () => (process.env.SLA_CAPTURE_ATIVO || 'false').toLowerCase() === 'true',

  buscarPendentes: async (pool, _limite) => {
    // FOR UPDATE SKIP LOCKED garante que slots não pegam mesmo registro
    const { rows } = await pool.query(`
      SELECT * FROM sla_capturas
      WHERE status = 'pendente'
        AND proximo_retry_em <= NOW()
      ORDER BY criado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return rows[0] || null;
  },

  marcarProcessando: async (pool, registro) => {
    await pool.query(
      `UPDATE sla_capturas SET status = 'processando', atualizado_em = NOW() WHERE id = $1`,
      [registro.id]
    );
  },

  processar: async (pool, registro, ctx) => {
    ctx.log(`📨 Processando OS ${registro.os_numero} (cliente ${registro.cliente_cod})`);

    // Configura overrides ANTES de chamar — credenciais e arquivo de sessão
    // do slot atual (slotIdx 0 → conta 1, slotIdx 1 → conta 2, etc.)
    const creds = ctx.sessao.credenciaisDoSlot(ctx.slotIdx);
    const sessionFile = ctx.sessao.caminhoSessao(ctx.slotIdx);

    playwrightSlaCapture.setOverrides({
      sessionFile,
      credentials: { email: creds.email, senha: creds.senha },
    });

    try {
      // O service interno faz: garantirSessao + capturarPontosOS + enviar WhatsApp + atualizar DB
      await slaCaptureService.processarCaptura(pool, registro);
      ctx.log(`✅ OS ${registro.os_numero} processada`);
    } finally {
      // Limpa overrides pra não vazar pro próximo job (defensivo, embora o
      // browser-pool garanta serialização dentro do slot)
      playwrightSlaCapture.clearOverrides();
    }
  },

  onErro: async (pool, registro, err) => {
    // Devolve pra fila com retry conservativo (10s).
    // A lógica de retry/falha definitiva fica no service — aqui é só rede de segurança.
    if (registro?.id) {
      try {
        await pool.query(
          `UPDATE sla_capturas
           SET status = 'pendente',
               erro = $1,
               proximo_retry_em = NOW() + INTERVAL '10 seconds',
               atualizado_em = NOW()
           WHERE id = $2 AND status = 'processando'`,
          [`pool_exception: ${err.message}`.slice(0, 500), registro.id]
        );
      } catch (_) {}
    }
  },
});
