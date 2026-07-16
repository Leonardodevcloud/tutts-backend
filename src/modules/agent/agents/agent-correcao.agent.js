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
// SEM_AUTO_LIBERACAO_V1: o import do playwright-liberar-ponto saiu. Ele so era
// usado pela auto-liberacao, removida deste agente. O ARQUIVO continua existindo
// e a liberacao MANUAL (app do motoboy + aba "Liberação de OS") segue intacta.
const { haversineKm, RAIO_MAXIMO_KM } = require('../routes/correcao.routes');
const { checarClienteBloqueado } = require('../clientes-bloqueados.service'); // 2026-07

// SEM_AUTO_LIBERACAO_V1 — PADROES_NAO_LIBERAR e deveAutoLiberar() removidos.
//
// A regra deles era: "correcao falhou, mas a IA validou a foto da fachada e o
// ponto e >= 2 -> libera o ponto sozinho". A porta de entrada era a linha
//     if (!vloc || !vloc.valido) return false;
// onde vloc = registro.validacao_localizacao, ou seja, o JSON do Gemini lendo a
// FOTO. Desde o AGENTE_BCE_V1 essa coluna nasce NULL: a auto-liberacao ja tinha
// parado sozinha, por efeito colateral, no dia em que a foto saiu do fluxo.
//
// Isto aqui torna a parada explicita. Um comportamento que libera ponto na
// producao nao pode depender de um campo ter parado de ser preenchido por
// acidente — se a coluna voltasse a ser gravada um dia, ele ressuscitaria sem
// ninguem pedir.
//
// O que NAO foi removido: a liberacao MANUAL. liberar-ponto.routes.js,
// liberar-ponto.agent.js, playwright-liberar-ponto.js, a tabela
// liberacoes_pontos, a aba "🔓 Liberação de OS" do admin e a tela do motoboy
// continuam funcionando igual. Some so o disparo automatico.

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
  // 🛡️ 2026-05 fix-deadlock: timeout máximo por job.
  // Correção pode envolver login + busca de OS + modal endereços + recálculo
  // de frete (várias chamadas Playwright). 4 min é folgado mas evita slot
  // preso pra sempre quando BrowserSession fica zumbi (caso observado em log:
  // travou após "Usando sessão salva" em browser.newContext sem timeout).
  // 🔁 2026-07 retry: com retentativas por reload (default 2), um job pode
  // encadear 2 execuções completas. 6 min dá folga sem deixar slot preso.
  // Ajustável por POOL_AGENT_CORRECAO_TIMEOUT_MS.
  timeoutMs: Number(process.env.POOL_AGENT_CORRECAO_TIMEOUT_MS || 360_000), // 6 min

  // 2026-05 fix-eagain: cria BrowserSession persistente por slot.
  // Browser sobe lazy no 1o job (não bloqueia o startup do worker).
  onSlotStart: async (_pool, ctx) => {
    ctx.log('🔧 Criando BrowserSession persistente...');
    const browserSession = criarBrowserSession({
      nome: `agent-correcao-slot-${ctx.slotIdx}`,
      launchOpts: CORRECAO_LAUNCH_OPTS,
      // 🛡️ Browser persistente vive >3min → sem isso o chromium-reaper o mata
      // no meio da correção de endereço (Target page closed).
      protegerDoReaper: true,
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

    // 🔒 fix-concorrencia: setOverrides mantido como fallback, MAS as fontes vao
    // via parametros abaixo (que tem prioridade e sao isolados por chamada). Isso
    // impede que dois slots simultaneos cruzem sessao/credencial/browser pelo
    // estado global do modulo.
    playwrightAgent.setOverrides({
      sessionFile,
      credentials: { email: creds.email, senha: creds.senha },
      browser: browserVivo,  // null = fallback pra launch normal
    });

    let resultado;
    try {
      resultado = await playwrightAgent.executarCorrecaoEnderecoComRetry({
        os_numero:        registro.os_numero,
        ponto:            registro.ponto,
        latitude:         coords.latitude,
        longitude:        coords.longitude,
        cod_profissional: registro.cod_profissional || null,
        // 🔒 fontes isoladas por chamada (nao dependem do global):
        sessionFile:      sessionFile,
        credentials:      { email: creds.email, senha: creds.senha },
        browser:          browserVivo,  // null = fallback pra launch normal
        verificarBloqueio: async (p1) => checarClienteBloqueado(pool, p1 && p1.endereco),
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

    // 2026-07: cliente bloqueado — marca status especial e NAO ajusta.
    if (resultado && resultado.bloqueado_cliente) {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'bloqueado_cliente',
             bloqueio_loja = $1,
             erro = $2,
             etapa_atual = 'bloqueado',
             progresso = 100,
             finalizado_em = NOW()
         WHERE id = $3`,
        [resultado.loja_bloqueada || null, 'Cliente bloqueado para ajuste de localizacao', registro.id]
      );
      ctx.log(`🚫 OS ${registro.os_numero} bloqueada (cliente sem ajuste): ${resultado.loja_bloqueada || ''}`);
      return;
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

      // SEM_AUTO_LIBERACAO_V1 — o bloco de auto-liberacao saiu daqui.
      //
      // Ele rodava logo depois de gravar status='falhou': abria um INSERT em
      // liberacoes_pontos com origem 'auto_correcao' e chamava
      // executarLiberacaoInline() reusando o browser/sessao do job.
      //
      // Correcao que falha agora termina em 'falhou' e ponto final. Se o ponto
      // precisar ser liberado, alguem libera — pela aba "🔓 Liberação de OS" ou
      // pelo app. A decisao de liberar ponto volta a ter dono.
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
