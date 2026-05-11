/**
 * agents/agent-correcao.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente de correção automática de endereços (RPA via Playwright).
 *
 * IMPORTANTE: FOR UPDATE SKIP LOCKED na query pra paralelismo seguro entre slots.
 *
 * 2026-05 fix-eagain: BROWSER PERSISTENTE
 * ─────────────────────────────────────────
 * Antes, cada job chamava chromium.launch() / browser.close(). Em containers
 * Linux, cada ciclo deixa filhos órfãos do Chromium; se Node estiver como
 * PID 1 sem dumb-init, os zumbis acumulam até estourar pids.max do cgroup
 * e dar "spawn EAGAIN". Mesmo com dumb-init, picos de carga consomem PIDs
 * desnecessariamente.
 *
 * Solução: 1 browser por slot, vivo durante toda a vida do worker (mesmo
 * padrão já validado no sla-capture). A cada job cria-se um context novo
 * (leve), em vez de um browser novo (pesado). Reduz launches/hora de ~N
 * pra ~1, eliminando a fonte do EAGAIN.
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const { criarBrowserSession } = require('../core/browser-session');
const { normalizeLocation } = require('../location-normalizer');
const playwrightAgent = require('../playwright-agent');
const { haversineKm, RAIO_MAXIMO_KM } = require('../routes/correcao.routes');

const SLOTS = Number(process.env.POOL_AGENT_CORRECAO_SLOTS || 2);

// Mesmas opções de launch do sla-capture (conservadoras pra container)
const CORRECAO_LAUNCH_OPTS = {
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
  nome: 'agent-correcao',
  slots: SLOTS,
  sessionStrategy: 'isolada',  // 1 conta por slot
  intervalo: 10_000,           // 10s entre ticks quando fila vazia

  // 2026-05 fix-eagain: cria BrowserSession persistente por slot.
  // Browser sobe lazy no 1o job (não bloqueia o startup do worker).
  onSlotStart: async (_pool, ctx) => {
    ctx.log('🔧 Criando BrowserSession persistente...');
    const browserSession = criarBrowserSession({
      nome: `agent-correcao-slot-${ctx.slotIdx}`,
      launchOpts: CORRECAO_LAUNCH_OPTS,
    });
    ctx.log('✅ BrowserSession pronta (browser lancado no 1o job)');
    return { browserSession };
  },

  // Encerra browser ao parar o slot (shutdown graceful)
  onSlotStop: async (_pool, ctx) => {
    const { browserSession } = ctx.slotState || {};
    if (browserSession) {
      try { await browserSession.fechar(); } catch (_) {}
    }
  },

  buscarPendentes: async (pool, _limite) => {
    const { rows } = await pool.query(`
      SELECT * FROM ajustes_automaticos
      WHERE status = 'pendente'
      ORDER BY criado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return rows[0] || null;
  },

  marcarProcessando: async (pool, registro) => {
    await pool.query(
      `UPDATE ajustes_automaticos SET status = 'processando' WHERE id = $1`,
      [registro.id]
    );
  },

  processar: async (pool, registro, ctx) => {
    ctx.log(`📋 OS ${registro.os_numero} ponto ${registro.ponto}`);

    // 1. Normalizar localização
    let coords;
    try {
      coords = await normalizeLocation(registro.localizacao_raw);
      ctx.log(`📍 Coords: ${coords.latitude}, ${coords.longitude}`);
    } catch (err) {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'falhou', erro = $1, finalizado_em = NOW()
         WHERE id = $2`,
        [`Normalização: ${err.message}`.slice(0, 500), registro.id]
      );
      return;
    }

    await pool.query(
      `UPDATE ajustes_automaticos SET latitude = $1, longitude = $2 WHERE id = $3`,
      [coords.latitude, coords.longitude, registro.id]
    );

    // 2. Validação de raio (se OS tem coords originais)
    if (registro.endereco_antigo_lat && registro.endereco_antigo_lng) {
      const distKm = haversineKm(
        coords.latitude, coords.longitude,
        registro.endereco_antigo_lat, registro.endereco_antigo_lng
      );
      if (distKm > RAIO_MAXIMO_KM) {
        await pool.query(
          `UPDATE ajustes_automaticos
           SET status = 'falhou',
               erro = $1,
               finalizado_em = NOW()
           WHERE id = $2`,
          [`Distância ${distKm.toFixed(2)}km > ${RAIO_MAXIMO_KM}km`, registro.id]
        );
        return;
      }
    }

    await pool.query(
      `UPDATE ajustes_automaticos SET etapa_atual = 'iniciando', progresso = 5 WHERE id = $1`,
      [registro.id]
    );

    // 3. Configura overrides do Playwright (credenciais, sessão deste slot, browser persistente)
    const creds = ctx.sessao.credenciaisDoSlot(ctx.slotIdx);
    const sessionFile = ctx.sessao.caminhoSessao(ctx.slotIdx);

    // 2026-05 fix-eagain: recupera o browser persistente do slot
    const { browserSession } = ctx.slotState || {};
    let browserVivo = null;
    if (browserSession) {
      try {
        browserVivo = await browserSession.obterBrowser();
      } catch (e) {
        // Falha no launch da sessão — segue sem override (modo legado)
        ctx.log(`⚠️ BrowserSession.obterBrowser falhou: ${e.message} — fallback pra launch direto`);
      }
    }

    playwrightAgent.setOverrides({
      sessionFile,
      credentials: { email: creds.email, senha: creds.senha },
      browser: browserVivo,  // null = fallback pra launch normal
    });

    let resultado;
    try {
      resultado = await playwrightAgent.executarCorrecaoEndereco({
        os_numero:        registro.os_numero,
        ponto:            registro.ponto,
        latitude:         coords.latitude,
        longitude:        coords.longitude,
        cod_profissional: registro.cod_profissional || null,
        onProgresso: (etapa, pct) => {
          pool.query(
            `UPDATE ajustes_automaticos SET etapa_atual = $1, progresso = $2 WHERE id = $3`,
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
      playwrightAgent.clearOverrides();
    }

    // 4. Atualizar resultado final
    if (resultado && resultado.sucesso) {
      const updates = [
        `status = 'sucesso'`,
        `finalizado_em = NOW()`,
        `etapa_atual = 'concluido'`,
        `progresso = 100`,
      ];
      const params = [];
      if (resultado.endereco_corrigido) {
        updates.push(`endereco_corrigido = $${params.length + 1}`);
        params.push(resultado.endereco_corrigido);
      }
      if (resultado.endereco_antigo) {
        updates.push(`endereco_antigo = $${params.length + 1}`);
        params.push(resultado.endereco_antigo);
      }
      if (typeof resultado.frete_recalculado === 'boolean') {
        updates.push(`frete_recalculado = $${params.length + 1}`);
        params.push(resultado.frete_recalculado);
      }
      if (resultado.valores_antes) {
        updates.push(`valores_antes = $${params.length + 1}`);
        params.push(JSON.stringify(resultado.valores_antes));
      }
      if (resultado.valores_depois) {
        updates.push(`valores_depois = $${params.length + 1}`);
        params.push(JSON.stringify(resultado.valores_depois));
      }
      params.push(registro.id);

      await pool.query(
        `UPDATE ajustes_automaticos SET ${updates.join(', ')} WHERE id = $${params.length}`,
        params
      );

      if (resultado.endereco_antigo_lat && resultado.endereco_antigo_lng) {
        await pool.query(
          `UPDATE ajustes_automaticos SET endereco_antigo_lat = $1, endereco_antigo_lng = $2 WHERE id = $3`,
          [resultado.endereco_antigo_lat, resultado.endereco_antigo_lng, registro.id]
        ).catch(() => {});
      }

      ctx.log(`✅ OS ${registro.os_numero} corrigida`);
    } else {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'falhou',
             erro = $1,
             finalizado_em = NOW(),
             screenshot_path = $2
         WHERE id = $3`,
        [
          (resultado && resultado.erro || 'Erro desconhecido').slice(0, 500),
          resultado && resultado.screenshot_path || null,
          registro.id,
        ]
      );
      ctx.log(`❌ OS ${registro.os_numero} falhou: ${resultado && resultado.erro}`);
    }
  },

  onErro: async (pool, registro, err) => {
    if (registro?.id) {
      try {
        await pool.query(
          `UPDATE ajustes_automaticos
           SET status = 'falhou',
               erro = $1,
               finalizado_em = NOW()
           WHERE id = $2 AND status = 'processando'`,
          [`pool_exception: ${err.message}`.slice(0, 500), registro.id]
        );
      } catch (_) {}
    }
  },
});
