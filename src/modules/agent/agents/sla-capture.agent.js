/**
 * agents/sla-capture.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente de captura de pontos de OS (rastreio WhatsApp).
 * Paralelizado: N slots, 1 conta SLA por slot.
 *
 * 2026-05: BROWSER PERSISTENTE
 * ─────────────────────────────
 * PROBLEMA: a cada job, playwright-sla-capture.js abria E fechava um
 * Chromium. Com ~270 ticks/2h, esgotava recursos IPC do kernel Linux
 * (semáforos POSIX, pipes) → próximo launch recebia SIGTRAP.
 *
 * SOLUÇÃO: BrowserSession — 1 browser por slot, vivo durante toda a
 * vida do processo. A cada job, cria um context novo (leve) em vez de
 * um browser novo (pesado). Máximo de POOL_SLA_CAPTURE_SLOTS browsers
 * ativos no sistema (default 2) em vez de centenas por hora.
 *
 * O browser é injetado no playwright-sla-capture via setOverrides({ browser })
 * — o mesmo mecanismo que já existe para sessionFile e credentials.
 * A função _getBrowser() no playwright-sla-capture verifica _browserOverride
 * e, quando presente, pula o chromium.launch() e usa o browser persistente.
 * O finally de cada função checa _browserEhOverride* e pula o close().
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const { criarBrowserSession } = require('../core/browser-session');
const slaCaptureService = require('../sla-capture.service');
// Lazy require — quebra dependência circular com playwright-sla-capture
let _playwrightSlaCapture = null;
function getPlaywrightSlaCapture() {
  if (!_playwrightSlaCapture) {
    _playwrightSlaCapture = require('../playwright-sla-capture');
  }
  return _playwrightSlaCapture;
}

const SLOTS = Number(process.env.POOL_SLA_CAPTURE_SLOTS || 3);

const SLA_LAUNCH_OPTS = {
  headless: true,
  timeout: 30_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=TranslateUI,IsolateOrigins,site-per-process',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--no-default-browser-check',
  ],
};

module.exports = defineAgent({
  nome: 'sla-capture',
  slots: SLOTS,
  sessionStrategy: 'isolada',
  envPrefix: 'SISTEMA_EXTERNO_SLA',
  intervalo: 5_000,
  // 🛡️ 2026-05 fix-deadlock: timeout máximo por job.
  // Captura inclui login (se sessão inválida) + busca OS + leitura de pontos.
  // 2.5 min é folgado mas evita slot zumbi se BrowserSession travar.
  timeoutMs: Number(process.env.POOL_SLA_CAPTURE_TIMEOUT_MS || 150_000), // 2.5 min

  habilitado: () => (process.env.SLA_CAPTURE_ATIVO || 'false').toLowerCase() === 'true',

  // Chamado 1x por slot ao entrar no loop. Cria o browser persistente.
  onSlotStart: async (_pool, ctx) => {
    ctx.log('🔧 Criando BrowserSession persistente...');
    const browserSession = criarBrowserSession({
      nome: `sla-capture-slot-${ctx.slotIdx}`,
      launchOpts: SLA_LAUNCH_OPTS,
      // 🛡️ Browser persistente vive >3min → sem isso o chromium-reaper o mata
      // no meio da coleta (Target page closed) e derruba SLA/detector em cascata.
      protegerDoReaper: true,
    });
    ctx.log('✅ BrowserSession pronta (browser lancado no 1o job)');
    return { browserSession };
  },

  // Chamado ao encerrar o loop (shutdown). Fecha o browser do slot.
  onSlotStop: async (_pool, ctx) => {
    const { browserSession } = ctx.slotState || {};
    if (browserSession) {
      try { await browserSession.fechar(); } catch (_) {}
    }
  },

  buscarPendentes: async (pool, _limite) => {
    // CLAIM ATOMICO (2026-06): um unico UPDATE seleciona a proxima pendente
    // com FOR UPDATE SKIP LOCKED e ja marca 'processando' na MESMA transacao.
    // Sem isso, o FOR UPDATE de um pool.query solto libera o lock na hora
    // (cada pool.query e auto-commit), entao 2+ slots pegavam a MESMA linha
    // e cada um enviava o rastreio -> WhatsApp DUPLICADO no grupo do cliente.
    // Com o claim atomico, so um slot vence a linha; os outros pulam (SKIP
    // LOCKED) para a proxima OS. O marcarProcessando seguinte vira no-op.
    const { rows } = await pool.query(`
      UPDATE sla_capturas
      SET status = 'processando', atualizado_em = NOW()
      WHERE id = (
        SELECT id FROM sla_capturas
        WHERE status = 'pendente'
          AND proximo_retry_em <= NOW()
        ORDER BY criado_em ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
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

    const creds = ctx.sessao.credenciaisDoSlot(ctx.slotIdx);
    const sessionFile = ctx.sessao.caminhoSessao(ctx.slotIdx);

    // Recupera o browser persistente deste slot
    const { browserSession } = ctx.slotState || {};

    // O BrowserSession garante que o browser está vivo (relança se crashou)
    // e expõe o objeto browser interno via .obterBrowser()
    let browserVivo = null;
    if (browserSession) {
      browserVivo = await browserSession.obterBrowser();
    }

    // Injeta browser persistente + credenciais + sessionFile via overrides
    getPlaywrightSlaCapture().setOverrides({
      sessionFile,
      credentials: { email: creds.email, senha: creds.senha },
      browser: browserVivo,  // null = modo legado (usa chromium.launch normal)
    });

    try {
      await slaCaptureService.processarCaptura(pool, registro);
      ctx.log(`✅ OS ${registro.os_numero} processada`);
    } catch (err) {
      // Se o browser morreu durante o job, notifica o BrowserSession
      // pra recriar no próximo uso
      if (browserSession && browserVivo && !browserVivo.isConnected()) {
        ctx.log('⚠️ Browser morreu durante job — BrowserSession vai recriar');
        browserSession._marcarMorto();
      }
      throw err;
    } finally {
      getPlaywrightSlaCapture().clearOverrides();
    }
  },

  onErro: async (pool, registro, err) => {
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
