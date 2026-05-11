/**
 * agents/liberar-ponto.agent.js
 * Worker do pool — processa fila liberacoes_pontos.
 * 1 slot, conta exclusiva (SISTEMA_EXTERNO_LIBERACAO_*).
 *
 * 2026-05 fix-eagain: BROWSER PERSISTENTE
 * Mesmo padrão do sla-capture e agent-correcao. Reduz chromium.launch()
 * de ~N por hora para 1 por vida do worker, eliminando acúmulo de zumbis
 * que causava "spawn EAGAIN".
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const { criarBrowserSession } = require('../core/browser-session');
const playwrightLib   = require('../playwright-liberar-ponto');

const SLOTS = Number(process.env.POOL_LIBERACAO_SLOTS || 1);

const LIBERACAO_LAUNCH_OPTS = {
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
  nome: 'liberar-ponto',
  slots: SLOTS,
  sessionStrategy: 'isolada',  // 1 sessão por slot (mesmo padrão do agent-correcao)
  intervalo: 10_000,

  // 2026-05 fix-eagain: BrowserSession persistente por slot
  onSlotStart: async (_pool, ctx) => {
    ctx.log('🔧 Criando BrowserSession persistente...');
    const browserSession = criarBrowserSession({
      nome: `liberar-ponto-slot-${ctx.slotIdx}`,
      launchOpts: LIBERACAO_LAUNCH_OPTS,
    });
    ctx.log('✅ BrowserSession pronta');
    return { browserSession };
  },

  onSlotStop: async (_pool, ctx) => {
    const { browserSession } = ctx.slotState || {};
    if (browserSession) {
      try { await browserSession.fechar(); } catch (_) {}
    }
  },

  buscarPendentes: async (pool, _limite) => {
    const { rows } = await pool.query(`
      SELECT * FROM liberacoes_pontos
      WHERE status = 'pendente'
      ORDER BY criado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return rows[0] || null;
  },

  marcarProcessando: async (pool, registro) => {
    await pool.query(
      `UPDATE liberacoes_pontos SET status = 'processando' WHERE id = $1`,
      [registro.id]
    );
  },

  processar: async (pool, registro, ctx) => {
    ctx.log(`📋 OS ${registro.os_numero}`);

    // Aplica credenciais e session file por slot (gerenciado por core/agent-base)
    const overrides = ctx.overrides || {};

    // 2026-05 fix-eagain: recupera o browser persistente do slot
    const { browserSession } = ctx.slotState || {};
    let browserVivo = null;
    if (browserSession) {
      try {
        browserVivo = await browserSession.obterBrowser();
      } catch (e) {
        ctx.log(`⚠️ BrowserSession.obterBrowser falhou: ${e.message} — fallback pra launch direto`);
      }
    }

    if (overrides.credentials || overrides.sessionFile || browserVivo) {
      playwrightLib.setOverrides({
        ...overrides,
        browser: browserVivo,
      });
    }

    let resultado;
    try {
      resultado = await playwrightLib.executarLiberacaoOS({
        os_numero: registro.os_numero,
        onProgresso: (etapa, pct) => {
          pool.query(
            `UPDATE liberacoes_pontos SET etapa_atual = $1, progresso = $2 WHERE id = $3`,
            [etapa, pct, registro.id]
          ).catch(() => {});
        },
      });
    } catch (err) {
      // Se browser persistente morreu durante job, marca pra recriação
      if (browserSession && browserVivo && !browserVivo.isConnected()) {
        ctx.log('⚠️ Browser morreu durante job — BrowserSession vai recriar');
        browserSession._marcarMorto();
      }
      throw err;
    } finally {
      playwrightLib.clearOverrides();
    }

    if (resultado && resultado.sucesso) {
      await pool.query(`
        UPDATE liberacoes_pontos
           SET status = 'sucesso',
               finalizado_em = NOW(),
               etapa_atual = 'concluido',
               progresso = 100,
               mensagem_retorno = $1
         WHERE id = $2
      `, [resultado.mensagem_retorno || 'Enviado', registro.id]);
      ctx.log(`✅ OS ${registro.os_numero} liberada`);
    } else {
      await pool.query(`
        UPDATE liberacoes_pontos
           SET status = 'falhou',
               erro = $1,
               finalizado_em = NOW(),
               screenshot_path = $2
         WHERE id = $3
      `, [
        ((resultado && resultado.erro) || 'Erro desconhecido').slice(0, 500),
        (resultado && resultado.screenshot_path) || null,
        registro.id,
      ]);
      ctx.log(`❌ OS ${registro.os_numero} falhou: ${resultado && resultado.erro}`);
    }
  },

  onErro: async (pool, registro, err) => {
    if (registro?.id) {
      try {
        await pool.query(`
          UPDATE liberacoes_pontos
             SET status = 'falhou',
                 erro = $1,
                 finalizado_em = NOW()
           WHERE id = $2 AND status = 'processando'
        `, [`pool_exception: ${err.message}`.slice(0, 500), registro.id]);
      } catch (_) {}
    }
  },
});
