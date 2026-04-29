/**
 * Tutts Backend — src/shared/network-blocker.js
 * ─────────────────────────────────────────────────────────────────────────
 * Bloqueia requests de trackers externos (Facebook Pixel, Google Analytics,
 * etc) nos contextos Playwright. Reduz consumo de Egress da Railway sem
 * afetar funcionalidade (esses domínios são analytics passivos que o
 * sistema externo NÃO precisa pra funcionar).
 *
 * Por que isso existe?
 * ───────────────────
 * Os agents do Playwright abrem páginas do tutts.com.br dezenas de vezes
 * por minuto. Cada vez baixam:
 *   - Facebook Pixel (~5 KB)
 *   - Google Analytics (~1 KB)
 *   - tracker.tolvnow.com (~2 KB)
 *   - Google Tag Manager (~3 KB)
 *
 * Em runtime de 24h, isso vira ~3-5 GB/mês de egress puro DESPERDÍCIO.
 * Bloquear esses domínios externos:
 *   - NÃO afeta o site da Tutts (são analytics passivos, sem dependência)
 *   - NÃO afeta sessão (cookies da Tutts não passam por esses domínios)
 *   - Reduz ~30-40% do egress total
 *
 * Como usar
 * ─────────
 *   const { aplicarBloqueio } = require('./shared/network-blocker');
 *   const context = await browser.newContext(...);
 *   await aplicarBloqueio(context, 'sla-capture');  // ← chamada única
 *   const page = await context.newPage();
 *   // resto continua igual
 *
 * Flag de ativação
 * ────────────────
 * Default: DESLIGADO (sem efeito). Só ativa se env BLOCK_TRACKERS=1.
 * Isso permite ligar/desligar sem rebuild — basta mudar a env var
 * no Railway e reiniciar o serviço.
 *
 * Telemetria
 * ──────────
 * Mantém contadores em memória de quantos requests foram bloqueados por
 * tipo de domínio. Logado a cada N bloqueios pra você confirmar que
 * está funcionando.
 */

'use strict';

// Domínios que serão bloqueados quando BLOCK_TRACKERS=1.
// LISTA CONSERVADORA (Nível 1): apenas trackers externos comprovadamente
// seguros de bloquear. NÃO inclui:
//   - tutts.com.br/cdn-cgi/rum (Cloudflare, pode validar sessão)
//   - CSS/imagens da Tutts (podem afetar seletores Playwright)
//   - APIs externas que o sistema legítimo usa
const DOMINIOS_BLOQUEADOS = [
  'connect.facebook.net',           // Facebook Pixel
  'www.google-analytics.com',       // Google Analytics (envia eventos)
  'www.googletagmanager.com',       // GTM (carrega snippets)
  'analytics.google.com',           // GA (variação)
  'stats.g.doubleclick.net',        // DoubleClick (Google Ads)
  'tracker.tolvnow.com',            // Tracker tolvnow
  'fonts.googleapis.com',           // Google Fonts CSS
  'fonts.gstatic.com',              // Google Fonts arquivos
  // Vídeos embedados na home da Tutts. Causam erros net::ERR_ABORTED quando
  // o Playwright tenta carregar com waitUntil:'load'. Bloqueio elimina o
  // ruído nos logs e economiza egress (vídeo embed pesa MB).
  'www.youtube.com',
  'youtube.com',
  'i.ytimg.com',                    // thumbnails do YouTube
  's.ytimg.com',                    // assets do player
];

// Contadores globais por tipo (pra log periódico)
const _stats = {
  bloqueados: 0,           // total bloqueado desde startup
  porDominio: {},          // { 'connect.facebook.net': 123, ... }
  ultimoLog: 0,            // timestamp do último log
};

const LOG_A_CADA = 100;    // loga estatística a cada N bloqueios

const TAG = '[net-blocker]';

function log(msg) {
  console.log(`${TAG} ${msg}`);
}

/**
 * Verifica se a flag está ligada. Lê env var dinamicamente pra permitir
 * mudança sem reiniciar (caso queira no futuro). Por ora, mudar requer
 * restart do serviço no Railway.
 */
function bloqueioAtivo() {
  return process.env.BLOCK_TRACKERS === '1' ||
         process.env.BLOCK_TRACKERS === 'true';
}

/**
 * Determina se uma URL deve ser bloqueada.
 * Match por hostname (não regex pra evitar pegadinhas).
 */
function deveBloquear(url) {
  try {
    const hostname = new URL(url).hostname;
    // Match exato
    if (DOMINIOS_BLOQUEADOS.includes(hostname)) return hostname;
    // Match por subdomínio (ex: "www.google-analytics.com" cobre "stats.g..."?)
    // Nope, lista é exata pra ser conservador
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Aplica route handler num context Playwright. Idempotente (chamar 2 vezes
 * no mesmo context não quebra, mas só o primeiro tem efeito).
 *
 * @param {BrowserContext} context  - context do Playwright (await browser.newContext())
 * @param {string} agentName        - nome pro log (ex: 'sla-capture')
 */
async function aplicarBloqueio(context, agentName) {
  if (!bloqueioAtivo()) {
    return;  // flag off → não faz nada
  }
  if (!context || typeof context.route !== 'function') {
    log(`⚠️ ${agentName}: context inválido, pulando`);
    return;
  }

  try {
    // route('**/*') pega TODO request. Chamamos abort() apenas nos bloqueados;
    // os outros chamamos continue() pra deixar passar.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      const hostnameBloqueado = deveBloquear(url);
      if (hostnameBloqueado) {
        _stats.bloqueados++;
        _stats.porDominio[hostnameBloqueado] = (_stats.porDominio[hostnameBloqueado] || 0) + 1;
        // Log periódico
        if (_stats.bloqueados - _stats.ultimoLog >= LOG_A_CADA) {
          _stats.ultimoLog = _stats.bloqueados;
          const top = Object.entries(_stats.porDominio)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([d, n]) => `${d}=${n}`)
            .join(', ');
          log(`🚫 ${_stats.bloqueados} requests bloqueados (top: ${top})`);
        }
        // abort() — não baixa, não conta como egress
        return route.abort('blockedbyclient');
      }
      // Tudo o que não é tracker, deixa passar
      return route.continue();
    });
  } catch (e) {
    log(`⚠️ ${agentName}: falha ao aplicar route: ${e.message}`);
  }
}

/**
 * Retorna estatísticas pra inspeção via endpoint de diagnóstico.
 */
function obterEstatisticas() {
  return {
    ativo: bloqueioAtivo(),
    totalBloqueado: _stats.bloqueados,
    porDominio: { ..._stats.porDominio },
    dominiosConfigurados: [...DOMINIOS_BLOQUEADOS],
  };
}

module.exports = {
  aplicarBloqueio,
  obterEstatisticas,
  bloqueioAtivo,
  // Expostos pra teste
  _DOMINIOS_BLOQUEADOS: DOMINIOS_BLOQUEADOS,
  _deveBloquear: deveBloquear,
};
