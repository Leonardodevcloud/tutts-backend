/**
 * playwright-sla-capture.js
 * Captura pontos de uma OS abrindo o modal de endereços via Playwright headless.
 *
 * ARQUITETURA:
 *   - Sessão ISOLADA do agent-worker (arquivo/credencial separados)
 *   - Login com SISTEMA_EXTERNO_SLA_EMAIL / SISTEMA_EXTERNO_SLA_SENHA
 *   - Navega pra /acompanhamento-servicos, ativa aba "Em execução"
 *   - Localiza OS via botão END. (com fallback pra busca autocomplete jQuery UI)
 *   - Clica no botão, aguarda modal abrir, extrai endereços via DOM:
 *       .btn-corrigir-endereco[data-ponto="N"] + span#end-antigo-{idEndereco}
 *   - Fecha modal e libera recursos
 *
 * IMPORTANTE:
 *   - Credencial precisa ser diferente da do agent E da do operador,
 *     senão o MAP invalida sessões quando múltiplas abas estão abertas.
 *   - Mutex interno garante 1 captura por vez nesta sessão.
 *   - Como roda headless no servidor, abrir modal NÃO causa problema
 *     pro operador (ao contrário da extensão v7.15 que abria no browser dele).
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');
// 2026-04 egress-fix: bloqueia trackers externos quando BLOCK_TRACKERS=1
const { aplicarBloqueio } = require('../../shared/network-blocker');

// getSessionFile() pode ser sobrescrito por chamada (ver setOverrides abaixo).
// Default: arquivo único pra compatibilidade com chamadas legadas (sem pool).
const SESSION_FILE_DEFAULT = '/tmp/tutts-sla-session.json';

// Overrides por chamada — setados pelo agent-pool antes de cada job.
// Seguro porque o browser-pool garante SÓ 1 chamada dessas funções por vez
// dentro do mesmo processo Node.
let _sessionFileOverride = null;
let _credentialsOverride = null;
// 2026-05: browser persistente por slot — quando definido, chromium.launch() é pulado
let _browserOverride = null;

function getSessionFile() {
  return _sessionFileOverride || SESSION_FILE_DEFAULT;
}

function setOverrides(opts) {
  _sessionFileOverride = (opts && opts.sessionFile) || null;
  _credentialsOverride = (opts && opts.credentials) || null;
  _browserOverride     = (opts && opts.browser) || null;
}

function clearOverrides() {
  _sessionFileOverride = null;
  _credentialsOverride = null;
  _browserOverride     = null;
}

// Retorna { browser, _ehOverride }. Se _browserOverride ativo, reutiliza sem fechar.
async function _getBrowser() {
  if (_browserOverride) {
    return { browser: _browserOverride, _ehOverride: true };
  }
  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTS);
  return { browser, _ehOverride: false };
}
const META_FILE    = '/tmp/tutts-sla-meta.json';     // 🆕 payload AJAX do endpoint alvo
const NETWORK_LOG_FILE = '/tmp/tutts-sla-network.json'; // 🆕 dump de TODAS as chamadas pro tutts.com.br
const TIMEOUT      = 25000;

// ═════════════════════════════════════════════════════════════════════════════
// CAPTURA DE PAYLOAD AJAX (pra alimentar o sla-detector)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Intercepta TODAS as chamadas HTTP do navegador pra tutts.com.br durante a
 * sessão Playwright e:
 *
 *   1. Loga um sumário de cada uma (método + URL + tamanho do body)
 *   2. Salva as primeiras N chamadas POST num arquivo /tmp/tutts-sla-network.json
 *      pra inspeção via endpoint admin de debug
 *   3. Quando reconhece a chamada do endpoint de "acompanhamento" (qualquer
 *      endpoint que devolva a lista de OS em execução), salva o payload em
 *      META_FILE pra o sla-detector usar
 *
 * Por que: não tenho 100% de certeza qual endpoint exato a página de
 * acompanhamento usa pra listar as OS — pode ser `viewServicoAcompanhamento`,
 * pode ser outro. Capturando TUDO eu descubro em runtime e o detector usa o
 * endpoint certo, sem hardcode.
 */
function instalarCapturaPayload(context) {
  // Padrões de URL que SUSPEITAMOS serem o endpoint da listagem de OS
  // (ordem importa — o primeiro que matchar vira o META oficial)
  const PADROES_ALVO = [
    /viewServicoAcompanhamento/i,
    /listaServico/i,
    /servicosEmExecucao/i,
    /acompanhamento.*ajax/i,
  ];

  const networkLog = [];
  const MAX_LOG_ENTRIES = 50;
  let metaSalvo = false;

  context.on('request', async (request) => {
    try {
      const url = request.url();
      const method = request.method();

      // Só interessa tutts.com.br
      if (!url.includes('tutts.com.br')) return;

      // Ignora estáticos óbvios
      if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ico)(\?|$)/i.test(url)) return;

      const postData = method === 'POST' ? request.postData() : null;
      const headers = request.headers();
      const contentType = headers['content-type'] || null;
      const isXhr = headers['x-requested-with'] === 'XMLHttpRequest';

      const entry = {
        ts: new Date().toISOString(),
        method,
        url,
        contentType,
        isXhr,
        bodyBytes: postData ? postData.length : 0,
        bodyPreview: postData ? postData.slice(0, 200) : null,
      };

      // Log resumido no console
      log(`🌐 ${method} ${isXhr ? '(XHR)' : '     '} ${url.replace('https://tutts.com.br/expresso/expressoat/', '...')} ${postData ? `[${postData.length}b]` : ''}`);

      // Adiciona ao network log (cap em MAX_LOG_ENTRIES)
      if (networkLog.length < MAX_LOG_ENTRIES) {
        networkLog.push(entry);
        try {
          fs.writeFileSync(
            NETWORK_LOG_FILE,
            JSON.stringify({ capturedAt: new Date().toISOString(), entries: networkLog }, null, 2),
            'utf8'
          );
        } catch (_) {}
      }

      // Se for um POST com body que casa com algum padrão alvo, salva como meta
      if (method === 'POST' && postData && !metaSalvo) {
        const matchPadrao = PADROES_ALVO.find(re => re.test(url));
        if (matchPadrao) {
          let idFuncionario = null;
          try {
            const params = new URLSearchParams(postData);
            idFuncionario = params.get('idFuncionario');
          } catch (_) {}

          const meta = {
            capturedAt: new Date().toISOString(),
            url,
            method,
            postData,
            idFuncionario,
            contentType,
            matchedPattern: matchPadrao.source,
          };
          fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
          metaSalvo = true;
          log(`📋 Payload AJAX capturado — endpoint=${url.split('/').slice(-2).join('/')} | idFuncionario=${idFuncionario || '(vazio)'} | bytes=${postData.length}`);
        }
      }
    } catch (err) {
      log(`⚠️ Listener network: ${err.message}`);
    }
  });
}

const LOGIN_URL = () => process.env.SISTEMA_EXTERNO_URL;
const ACOMP_URL = () =>
  process.env.SISTEMA_EXTERNO_ACOMPANHAMENTO_URL ||
  'https://tutts.com.br/expresso/expressoat/acompanhamento-servicos';
// 🆕 2026-07 sla-monitor: endpoint do modal "Informações do serviço" — é dele
// que sai a distância (km) e o status de retorno. Mesmo endpoint que a
// extensão SLA Monitor v8 consultava do browser do operador; agora o fetch
// roda DENTRO da página Playwright (sessão do worker), com fila e limite.
const MODAL_INFO_URL = () =>
  process.env.SISTEMA_EXTERNO_MODAL_INFO_URL ||
  'https://tutts.com.br/expresso/expressoat/entregasStatus/ajaxModalInformacoesServico.php';

// ── Mutex interno (NEUTRALIZADO 2026-04) ────────────────────────────────────
// Substituído pelo lock global `withBrowserLock` em playwright-lock.js.
// Manter dois sistemas de lock causava deadlock: o lock global liberava
// mas o mutex interno ainda estava preso até timeout (2min).
//
// Estas funções viraram no-op pra não quebrar chamadas existentes. Toda
// serialização de Playwright agora passa pelos workers (sla-capture-worker,
// sla-detector-worker, agent-worker) que já envolvem em withBrowserLock.
async function acquireMutex(_quem) {
  return; // no-op
}

function releaseMutex() {
  return; // no-op
}

/**
 * Watchdog — executa uma promise com timeout absoluto. Se a promise não
 * resolver em `ms` milissegundos, lança erro com a mensagem `nome`.
 *
 * Uso: await comTimeout(operacaoQueTalvezTrave(), 60_000, 'capturarPontosOS')
 *
 * IMPORTANTE: isso NÃO cancela a promise original (JS não tem cancellation).
 * Mas como estamos sempre num try/finally que faz browser.close(), a Promise
 * pendurada vai morrer junto com o browser eventualmente.
 */
function comTimeout(promise, ms, nome) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${nome}: timeout após ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Mata um browser de forma robusta — primeiro tenta close gracioso (5s),
 * depois force-kill no processo. Evita Chromium zombie.
 */
async function fecharBrowserSeguro(browser) {
  if (!browser) return;
  try {
    // Tenta fechar normalmente com timeout curto
    await comTimeout(browser.close(), 5_000, 'browser.close');
  } catch (e) {
    log(`⚠️ browser.close() falhou ou pendurou: ${e.message} — tentando kill`);
    try {
      // Pega o processo subjacente do Chromium e mata
      const proc = browser.process && browser.process();
      if (proc && typeof proc.kill === 'function') {
        proc.kill('SIGKILL');
        log(`💀 Chromium pid=${proc.pid} morto via SIGKILL`);
      }
    } catch (e2) {
      log(`⚠️ Falha no kill do browser: ${e2.message}`);
    }
  }
}

function log(msg) {
  logger.info(`[sla-capture-playwright] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Args do Chromium pra rodar de forma robusta em container Linux
// ─────────────────────────────────────────────────────────────────────────
//
// Em Docker/Railway, Chromium pode acumular processos zombie e vazar
// recursos. Esses args reduzem footprint e desabilitam features que
// frequentemente travam em ambiente headless sem display:
//
//   --no-sandbox             roda sem sandbox (Docker já é sandbox)
//   --disable-dev-shm-usage  não usa /dev/shm (que é só 64MB no Docker)
//   --disable-gpu            sem GPU em headless
//   --disable-software-rasterizer
//   --disable-background-networking  evita XHRs em background
//   --disable-default-apps
//   --disable-extensions
//   --disable-sync
//   --disable-translate
//   --hide-scrollbars
//   --metrics-recording-only
//   --mute-audio
//   --no-first-run
//   --safebrowsing-disable-auto-update
//   --no-default-browser-check
//   --disable-ipc-flooding-protection
//   --disable-renderer-backgrounding
//   --disable-backgrounding-occluded-windows
//   --disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process
//   --single-process          ⚠️ NÃO USAR — instável, mas reduz processos
//
// O `timeout` no launch garante que se o próprio launch travar, lança erro
// em vez de pendurar pra sempre.

const CHROMIUM_LAUNCH_OPTS = {
  headless: true,
  timeout: 30_000, // 30s pra subir o browser, senão erro
  args: [
    '--no-sandbox',
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

// ═════════════════════════════════════════════════════════════════════════════
// LOGIN
// ═════════════════════════════════════════════════════════════════════════════

/**
 * dispensarFeriados — v21 (2026-05-28)
 *
 * O sistema Tutts exibe uma tela obrigatória de notificação de feriados após
 * o login. Se o Playwright não passar por ela, qualquer goto a
 * /acompanhamento-servicos faz um redirect chain:
 *   acompanhamento-servicos → index.php → principal.php   (nunca chega)
 *
 * Esta função:
 *   1. Navega pra /notificacao-feriados (que já está na sessão ou redireciona)
 *   2. Tenta clicar em qualquer botão/link de "fechar/continuar"
 *   3. Aguarda pousar em /principal
 *
 * Depois desta chamada, goto(ACOMP_URL) funciona normalmente.
 */
// 🔧 2026-06-02: usa o helper COMPARTILHADO (fonte unica). A copia local foi
// removida para nao divergir do core/dispensar-feriados.js usado pelos demais agentes.
const { dispensarFeriados } = require('./core/dispensar-feriados');

async function isLoggedIn(page) {
  const url = page.url();
  if (!url.includes('/expresso') || url.includes('loginFuncionarioNovo')) return false;
  try {
    await page
      .locator('#pills-em-execucao-tab, #search-type, button.btn-modal')
      .first()
      .waitFor({ state: 'visible', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function fazerLogin(page, overrides) {
  // overrides opcional: { email, senha } — usado pelo agent-pool quando há
  // múltiplas contas (1 por slot). Se ausente, cai no env padrão (compat).
  const email = (overrides && overrides.email) || process.env.SISTEMA_EXTERNO_SLA_EMAIL;
  const senha = (overrides && overrides.senha) || process.env.SISTEMA_EXTERNO_SLA_SENHA;

  if (!email || !senha) {
    throw new Error(
      'SISTEMA_EXTERNO_SLA_EMAIL / SISTEMA_EXTERNO_SLA_SENHA não configuradas no Railway.'
    );
  }

  log(`🔐 Login SLA (${overrides ? 'override' : 'env padrão'}): ${email}`);

  // 🔧 v17 (2026-05-25): fazerLogin DEFENSIVO.
  // Causa raiz dos erros "Página de login não carregou. URL: principal.php":
  // quando o storageState tem cookies parciais/expirados, o servidor Tutts
  // redireciona o goto(LOGIN_URL) pra principal.php (estado "meio-logado").
  // Aí #loginEmail não existe lá → throw e loop infinito (sessionFile nunca
  // é renovado).
  // Estratégia: tentar 3 vezes com escalada — env normal → URL hardcoded →
  // limpar storage e tentar do zero.
  const LOGIN_URL_FALLBACK = 'https://tutts.com.br/expresso/loginFuncionarioNovo';
  const tentativas = [
    { url: LOGIN_URL(), motivo: 'env_url' },
    { url: LOGIN_URL_FALLBACK, motivo: 'fallback_hardcoded' },
    { url: LOGIN_URL_FALLBACK, motivo: 'pos_limpeza_cookies', limparCookies: true },
  ];

  let ultimoErro = null;
  for (let i = 0; i < tentativas.length; i++) {
    const t = tentativas[i];
    try {
      // Na 3ª tentativa, limpa cookies/storage pra forçar página de login limpa
      if (t.limparCookies) {
        try {
          await page.context().clearCookies();
          log(`🧹 [tentativa ${i + 1}/${tentativas.length}] cookies limpos (storage estava corrompido)`);
          // Apaga sessionFile do disco também
          try {
            const sf = getSessionFile();
            if (fs.existsSync(sf)) {
              fs.unlinkSync(sf);
              log(`🧹 sessionFile removido: ${sf}`);
            }
          } catch (eUnlink) { /* best-effort */ }
        } catch (eClear) {
          log(`⚠️ clearCookies falhou: ${eClear.message}`);
        }
      }

      log(`🔄 [tentativa ${i + 1}/${tentativas.length}] goto → ${t.url} (${t.motivo})`);
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(1500);

      const urlAtual = page.url();
      const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);

      if (!temEmail) {
        // 🔧 v22 (2026-05-28): LÓGICA DE "JÁ LOGADO VIA COOKIE" revisada
        //
        // Problema v18-v21: quando cookie redireciona goto(loginFuncionarioNovo) pra
        // principal.php, o servidor NÃO marcou a sessão como "pós-feriados".
        // Qualquer goto a /acompanhamento-servicos faz redirect chain:
        //   acompanhamento-servicos → index.php → principal.php (loop)
        //
        // Fix: só aceita sessão como "OK" se URL já é /notificacao-feriados ou
        // /acompanhamento-servicos (estados pós-fluxo-de-login correto).
        // Se está em /principal: limpa cookies → próxima tentativa vai direto
        // ao formulário de login e o servidor redireciona para notificacao-feriados,
        // desbloqueando o acompanhamento-servicos.
        const urlOK = urlAtual.includes('/notificacao-feriados') || urlAtual.includes('/acompanhamento-servicos');
        const urlPrincipal = urlAtual.includes('/principal') || (urlAtual.includes('/expressoat/') && !urlOK);

        if (urlOK) {
          // Sessão válida no estado certo — retorna sem navegar
          log(`✅ Login SLA OK (tentativa ${i + 1}/${tentativas.length}, motivo=${t.motivo}_cookie_ok) — URL: ${urlAtual}`);
          return;
        }

        if (urlPrincipal) {
          // Cookie válido mas sessão presa em principal.php sem passar por feriados.
          // Limpa cookies + session file → próxima iteração fará login com credenciais
          // e o servidor vai direcionar para notificacao-feriados naturalmente.
          log(`🗑️ [tentativa ${i + 1}/${tentativas.length}] Sessão em ${urlAtual} sem feriados — limpando cookies, forçando login completo`);
          try {
            await page.context().clearCookies();
            const sf = getSessionFile();
            if (fs.existsSync(sf)) { fs.unlinkSync(sf); log('🧹 Session file removido'); }
          } catch (eLimpa) { log(`⚠️ clearCookies: ${eLimpa.message}`); }
          ultimoErro = 'sessao_principal_sem_feriados';
          continue; // → próxima tentativa vai achar #loginEmail e fazer login completo
        }
        continue; // próxima tentativa
      }

      // #loginEmail encontrado → preenche e submete
      await page.fill('#loginEmail', email);
      await page.fill('input[type="password"]', senha);
      await page.locator('input[name="logar"]').first().click();

      await page.waitForURL((url) => !url.toString().includes('loginFuncionarioNovo'), {
        timeout: TIMEOUT,
      });
      log(`✅ Login SLA OK (tentativa ${i + 1}/${tentativas.length}, motivo=${t.motivo}) — URL: ${page.url()}`);
      return; // sucesso!
    } catch (err) {
      ultimoErro = err.message;
      log(`⚠️ [tentativa ${i + 1}/${tentativas.length}] erro: ${err.message}`);
    }
  }

  // Esgotou as 3 tentativas
  throw new Error(`fazerLogin esgotou tentativas. Último erro: ${ultimoErro}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// PARSERS — HTML → texto → pontos (portados da extensão v7.15)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Parser 814 — endereço até o 1º CEP, nomeCliente após "Nome Cliente:"
 */
function parseEntrega814(texto) {
  if (!texto) return null;
  const t = texto.replace(/\s+/g, ' ').trim();

  let endereco = t;
  const cepMatch = t.match(/\d{5}-?\d{3}/);
  if (cepMatch) {
    endereco = t.substring(0, cepMatch.index + cepMatch[0].length).trim();
  }

  let nomeCliente = null;
  const nomeMatch = t.match(/Nome\s*Cliente:\s*(.+?)(?:,|\s+Peso:|\s+Tel:|$)/i);
  if (nomeMatch) {
    nomeCliente = nomeMatch[1].trim();
  }

  return { endereco, nomeCliente };
}

/**
 * Parser 767 — endereço até o 1º CEP, cliente após o ÚLTIMO CEP, nota após "Nº nota:"
 */
function parseEntrega767(texto) {
  if (!texto) return null;
  const t = texto.replace(/\s+/g, ' ').trim();

  const mNota = t.match(/(?:PARA\s+)?N[ºo°]\s*nota:?\s*(\S+)/i);
  if (!mNota) {
    return { endereco: t, nomeCliente: null, nota: null };
  }

  const nota = mNota[1].replace(/[,.;]+$/, '').trim();
  const antesNotaRaw = t.substring(0, mNota.index).trim();
  const antesNota = antesNotaRaw.replace(/\s*PARA\s*$/i, '').trim();

  const cepRegex = /\d{5}-?\d{3}/g;
  const ceps = [];
  let m;
  while ((m = cepRegex.exec(antesNota)) !== null) {
    ceps.push({ start: m.index, end: m.index + m[0].length });
  }

  if (ceps.length === 0) {
    return { endereco: antesNota, nomeCliente: null, nota };
  }

  const endereco = antesNota.substring(0, ceps[0].end).trim();
  let nomeCliente = antesNota.substring(ceps[ceps.length - 1].end).trim();
  nomeCliente = nomeCliente.replace(/^[\s,\-–]+/, '').trim();

  return { endereco, nomeCliente: nomeCliente || null, nota };
}

// ── Termos discriminativos do Ponto 1 do 767 (legado — só pra retrocompatibilidade) ────────
//
// 2026-05 v3: passou a ser CONFIGURÁVEL via rastreio_clientes_config.termos_filtro.
// Antes era hardcoded só pro 767. Agora qualquer cliente pode ter palavras-chave.
// A função `ponto1Bate767` permanece exportada pra testes legados mas o fluxo
// de captura usa `escolherConfigPorTexto` que é genérica.
const TERMOS_PONTO1_767 = ['GALBA', 'NOVAS DE CASTRO', '57061-510', '57061510'];

function ponto1Bate767(texto) {
  if (!texto) return false;
  const up = String(texto).toUpperCase();
  return TERMOS_PONTO1_767.some((termo) => up.includes(termo.toUpperCase()));
}

/**
 * 🆕 2026-05 v3: Decide qual config (das múltiplas registradas pra esse cliente)
 * uma OS pertence, baseado no texto do Ponto 1.
 *
 * Regras:
 *   - Recebe lista de entries (cada uma com `filtrosBalao` e `evolutionGroupId`).
 *   - Se um cadastro tem `filtrosBalao` vazio → MATCH catch-all (pega tudo deste cliente).
 *     Útil pro 814 que não filtra.
 *   - Se um cadastro tem `filtrosBalao` preenchido → MATCH só se o texto contém
 *     alguma das palavras.
 *   - Premissa do usuário: "palavras-chave não se sobrepõem" — então retorna
 *     o PRIMEIRO match que encontrar (com prioridade pra cadastros com filtros
 *     ANTES de catch-all, pra evitar que catch-all engula tudo).
 *   - Retorna null se nenhum bateu → OS é descartada.
 *
 * @param {string} texto — texto do Ponto 1 (extraído do modal de endereços)
 * @param {Array}  entries — config do cliente (de carregarConfig do detector)
 * @returns {object|null} a entry que bateu, ou null
 */
function escolherConfigPorTexto(texto, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const up = String(texto || '').toUpperCase();

  // Primeiro tenta cadastros COM palavras-chave (mais específicos)
  const comFiltros = entries.filter(e => Array.isArray(e.filtrosBalao) && e.filtrosBalao.length > 0);
  for (const entry of comFiltros) {
    const bateu = entry.filtrosBalao.some(termo => up.includes(String(termo).toUpperCase()));
    if (bateu) return entry;
  }

  // Depois tenta catch-all (sem filtros — pega tudo)
  const semFiltros = entries.find(e => !Array.isArray(e.filtrosBalao) || e.filtrosBalao.length === 0);
  if (semFiltros) return semFiltros;

  // Nenhum bateu
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Captura os pontos de uma OS via Playwright + AJAX direto.
 *
 * @param {Object} params
 * @param {String} params.os_numero - Número da OS (7 dígitos)
 * @param {String} params.cliente_cod - '814' ou '767'
 * @returns {Promise<{ pontos: Array, textoBrutoModal: String }>}
 */
// ═════════════════════════════════════════════════════════════════════════════
// GARANTIR SESSÃO (substitui o hack de capturar OS dummy '0000001')
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Função dedicada a APENAS:
 *   1. Garantir que existe uma sessão Playwright válida em getSessionFile()
 *   2. Garantir que o META_FILE com o payload AJAX está atualizado
 *
 * Sem buscar nenhuma OS, sem clicar em nada, sem ruído.
 *
 * Fluxo:
 *   - Abre browser headless
 *   - Tenta reusar getSessionFile(); se inválido, faz login completo
 *   - Visita /acompanhamento-servicos — isso dispara automaticamente o XHR
 *     pro endpoint viewServicoAcompanhamento, e o listener instalado por
 *     instalarCapturaPayload(context) escreve o META_FILE
 *   - Salva storageState atualizado
 *   - Fecha tudo
 *
 * Usado pelo sla-detector-worker no startup e no auto-relogin, em vez do
 * hack antigo de chamar capturarPontosOS({ os_numero: '0000001' }).
 *
 * Retorna: { ok: true, sessaoSalva: bool, payloadCapturado: bool }
 *          ou throw em caso de falha de login.
 */
async function garantirSessao() {
  await acquireMutex('garantirSessao');

  // 🔧 CRÍTICO (2026-04): browser/context declarados ANTES do try, mas só
  // INICIALIZADOS dentro dele. Se `chromium.launch()` ou `newContext()` falhar
  // (SIGTRAP, EAGAIN, OOM), o finally precisa ter acesso pra fechar o que
  // foi (parcialmente) criado. Antes do fix, launch fora do try deixava
  // Chromium zumbi quando falhava no meio da inicialização.
  let browser = null;
  let _browserEhOverride1 = false;
  let context = null;
  let payloadAntes = null;

  // Snapshot do mtime do META_FILE pra detectar se a captura efetivamente atualizou
  try {
    if (fs.existsSync(META_FILE)) {
      payloadAntes = fs.statSync(META_FILE).mtimeMs;
    }
  } catch (_) {}

  try {
    ({ browser, _ehOverride: _browserEhOverride1 } = await _getBrowser());

    if (fs.existsSync(getSessionFile())) {
      try {
        context = await browser.newContext({ storageState: getSessionFile() });
      } catch {
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
    }

    // 2026-04 egress-fix: bloqueia trackers externos (Facebook, GA, etc)
    await aplicarBloqueio(context, 'sla-capture/capturarPontos');

    // 🔑 Listener de captura de payload — mesma função usada pelo capturarPontosOS
    instalarCapturaPayload(context);

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    log('🔓 garantirSessao: navegando pra acompanhamento-servicos');
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    if (!(await isLoggedIn(page))) {
      log('🔓 garantirSessao: sessão inválida, fazendo login completo');
      await fazerLogin(page, _credentialsOverride);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
    } else {
      log('🔓 garantirSessao: sessão reaproveitada do disco');
    }

    // 🔧 FIX (2026-04): A página de acompanhamento faz LAZY LOAD do XHR
    // viewServicoAcompanhamento — só dispara quando o usuário ativa a aba
    // "Em execução". Sem esse clique, o listener instalarCapturaPayload
    // nunca pega o body e o META_FILE não é gerado.
    log('🖱️ garantirSessao: ativando aba "Em execução" pra disparar o XHR');
    try {
      const abaEmExecucao = page.locator('#pills-em-execucao-tab');
      const visivel = await abaEmExecucao.isVisible({ timeout: 5000 }).catch(() => false);
      if (visivel) {
        await abaEmExecucao.click();
        log('🖱️ garantirSessao: aba clicada, aguardando XHR...');
        // Espera explícita pelo XHR alvo — até 10s.
        // Se vier antes disso, segue em frente. Se não vier, loga aviso.
        try {
          await page.waitForResponse(
            (resp) =>
              /viewServicoAcompanhamento/i.test(resp.url()) &&
              resp.request().method() === 'POST',
            { timeout: 10000 }
          );
          log('🖱️ garantirSessao: XHR viewServicoAcompanhamento detectado');
        } catch (e) {
          log(`⚠️ garantirSessao: XHR não veio em 10s (${e.message})`);
        }
      } else {
        log('⚠️ garantirSessao: aba "Em execução" não visível na página');
      }
    } catch (e) {
      log(`⚠️ garantirSessao: falha ao clicar na aba: ${e.message}`);
    }

    // Tempo extra pra garantir que o listener.on('request') escreveu o META
    await page.waitForTimeout(1500);

    // Persiste storageState atualizado
    try {
      await context.storageState({ path: getSessionFile() });
      log('💾 garantirSessao: storageState salvo');
    } catch (e) {
      log(`⚠️ garantirSessao: falha ao salvar storageState: ${e.message}`);
    }

    // Verifica se o META_FILE foi atualizado pelo listener
    let payloadCapturado = false;
    try {
      if (fs.existsSync(META_FILE)) {
        const novoMtime = fs.statSync(META_FILE).mtimeMs;
        payloadCapturado = !payloadAntes || novoMtime > payloadAntes;
      }
    } catch (_) {}

    if (payloadCapturado) {
      log('✅ garantirSessao: payload AJAX capturado com sucesso');
    } else {
      log('⚠️ garantirSessao: payload AJAX NÃO foi capturado nesta sessão');
      log('    A página de acompanhamento talvez não tenha disparado o XHR no load.');
      log('    Próximo tick do detector vai usar payload antigo (se existir) ou fallback.');
    }

    return { ok: true, sessaoSalva: true, payloadCapturado };

  } finally {
    try {
      if (context) await comTimeout(context.close(), 3_000, 'context.close');
    } catch (_) {}
    if (!_browserEhOverride1) await fecharBrowserSeguro(browser);
    releaseMutex();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COLETAR OS EM EXECUÇÃO — retorna lista pronta de OS pra alimentar o detector
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Abre browser, garante sessão, navega pra acompanhamento, clica na aba
 * "Em execução", e EXTRAI as OS diretamente do DOM (tr[data-order-id]).
 *
 * 🔧 HISTÓRIA DESSA FUNÇÃO (2026-04-13):
 *   Descobri via instrumentação que o endpoint viewServicoAcompanhamento
 *   SEMPRE retorna HTML (content-type: text/html), nunca JSON. Eu tinha
 *   interpretado errado o `instalarCapturaPayload` — ele captura o REQUEST
 *   (postData), não o RESPONSE. O servidor PHP responde com fragmentos HTML
 *   pra serem inseridos na página via $.html().
 *
 *   Então em vez de interceptar rede, a abordagem certa é:
 *   1. Clicar na aba "Em execução" → JS do MAP carrega a tabela no DOM
 *   2. Extrair os <tr[data-order-id]> do DOM com page.evaluate
 *   3. Pra paginar: clicar no link "Próx." do paginador e repetir
 *
 *   Os dados vêm nos atributos HTML:
 *     tr[data-order-id]                        → os_numero
 *     button[data-title-os] (dentro do tr)    → cliente_cod
 *     button[data-motoboy] (dentro do tr)     → cod_profissional
 *     a[href*="rastreamento?cod="]            → cod_rastreio
 *     [data-balloon] attributes concatenados  → _balloon (pra filtros)
 *     div.osEmExecucao.alert text              → total esperado "(149)"
 *
 * Usa o mesmo mutex de capturarPontosOS — sem concorrência de Chromium.
 *
 * Retorna:
 *   { ok, ordens: [...], totalEsperado, paginas, duracaoMs, diag }
 *   ou: { ok: false, motivo, sessaoExpirada, diag }
 */
/**
 * 🆕 2026-07 sla-monitor: aceita opts opcional (retrocompatível — o detector
 * antigo chama sem argumentos e nada muda).
 *
 * @param {Object}  [opts]
 * @param {Object}  [opts.buscarKm]              — se presente, após a paginação
 *                                                 busca km/retorno via modal
 *                                                 (na MESMA página/sessão)
 * @param {string[]}[opts.buscarKm.pular]        — os_numero que JÁ têm km no banco
 * @param {number}  [opts.buscarKm.max=40]       — teto de modais por tick
 * @param {number}  [opts.buscarKm.concorrencia=4] — fetches simultâneos
 *
 * Retorno ganha campo extra `kmPorOs`:
 *   { [os_numero]: { km: 12.4|null, retorno: bool, motivo: string|null } }
 */
async function coletarOsEmExecucao(opts = {}) {
  const TEMPO_MAX_MS = 90_000;
  const MAX_PAGINAS_SANITY = 100; // 1000 OS com 10/página = 100 páginas

  await acquireMutex('coletarOsEmExecucao');
  const t0 = Date.now();

  const diag = { etapas: [], paginasColetadas: [] };
  function etapa(nome, extra) {
    const evento = { etapa: nome, t: Date.now() - t0, ...(extra || {}) };
    diag.etapas.push(evento);
    log(`📍 [coletarOs] ${nome}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  }

  let browser, _browserEhOverride2 = false, context, page;
  const todasOsMap = new Map(); // dedupe por os_numero
  let totalEsperado = null;

  try {
    etapa('start');
    ({ browser, _ehOverride: _browserEhOverride2 } = await _getBrowser());
    etapa('browser_launched');

    if (fs.existsSync(getSessionFile())) {
      try {
        context = await browser.newContext({ storageState: getSessionFile() });
        etapa('context_with_storage');
      } catch (e) {
        etapa('context_storage_failed', { erro: e.message });
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
      etapa('context_no_storage');
    }

    // 2026-04 egress-fix: bloqueia trackers externos (Facebook, GA, etc)
    await aplicarBloqueio(context, 'sla-capture/coletarOs');

    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    etapa('page_created');

    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    etapa('goto_done', { url: page.url() });
    await page.waitForTimeout(800);

    if (!(await isLoggedIn(page))) {
      etapa('login_needed');
      await fazerLogin(page, _credentialsOverride);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
      etapa('login_done');
    }

    // Ativa aba "Em execução"
    const abaEmExecucao = page.locator('#pills-em-execucao-tab');
    if (!(await abaEmExecucao.isVisible({ timeout: 30000 }).catch(() => false))) {
      etapa('aba_nao_visivel');
      const urlDiag = page.url();
      log(`🔍 [aba_nao_visivel] URL = ${urlDiag}`);
      try {
        const ssPath = `/tmp/aba-nao-visivel-diag-${Date.now()}.png`;
        await page.screenshot({ path: ssPath, fullPage: false });
        log(`📸 Screenshot: ${ssPath}`);
      } catch (_) {}
      return { ok: false, motivo: 'aba_nao_visivel', sessaoExpirada: false, urlDiag, diag };
    }
    await abaEmExecucao.click();
    etapa('aba_clicada');

    // Aguarda a tabela de em-execução renderizar (tr com data-order-id)
    try {
      await page.waitForSelector('#pills-em-execucao tr[data-order-id]', { timeout: 25000 });
      etapa('tabela_renderizada');
    } catch (e) {
      etapa('tabela_timeout', { erro: e.message });

      // 🔧 v23 (2026-05-28): detecção de 0 OS mais robusta
      // Antes: regex rígida /Serviço.*execução.*\(0\)/i — não batia em todos os casos.
      // Agora: tenta 3 indicadores de tabela vazia. Se container existe mas sem rows
      // → assumir 0 OS (chegamos na página certa, só não tem OS no momento).
      const containerExiste = await page.locator('#pills-em-execucao').isVisible({ timeout: 3000 }).catch(() => false);
      const texto = containerExiste
        ? await page.locator('#pills-em-execucao').innerText({ timeout: 3000 }).catch(() => '')
        : '';

      log(`🔍 [tabela_timeout] container=${containerExiste} texto="${texto.slice(0, 150).replace(/\n/g, ' ')}"`);

      // Indicadores explícitos de zero
      if (/\(0\)/.test(texto) || /nenhum|empty|vazio|sem servi/i.test(texto) || /Serviço.*execução.*\(0\)/i.test(texto)) {
        etapa('zero_os');
        return { ok: true, ordens: [], totalEsperado: 0, paginas: 0, duracaoMs: Date.now() - t0, diag };
      }

      // Container existe mas sem rows e sem indicador explícito → provavelmente 0 OS
      if (containerExiste) {
        etapa('zero_os_fallback');
        log(`⚠️ [tabela_timeout] container existe mas sem tr[data-order-id] — assumindo 0 OS`);
        return { ok: true, ordens: [], totalEsperado: 0, paginas: 0, duracaoMs: Date.now() - t0, diag };
      }

      // Container não encontrado → página errada ou sessão quebrada
      return { ok: false, motivo: 'tabela_nao_renderizou', sessaoExpirada: false, diag };
    }

    await page.waitForTimeout(500);

    // Salva storageState atualizado
    try { await context.storageState({ path: getSessionFile() }); } catch (_) {}

    // Extrai o total esperado do texto "Serviço(s) em execução (149)"
    try {
      const totalTexto = await page.locator('#pills-em-execucao .osEmExecucao.alert').first().innerText({ timeout: 2000 });
      const m = totalTexto.match(/\((\d+)\)/);
      if (m) totalEsperado = parseInt(m[1], 10);
    } catch (_) {}
    etapa('total_esperado', { totalEsperado });

    // Função que extrai OS do DOM atual e acumula no Map
    async function extrairOsAtuais() {
      const extraidas = await page.evaluate(() => {
        const rows = document.querySelectorAll('#pills-em-execucao tr[data-order-id]');
        return Array.from(rows).map(tr => {
          const os_numero = tr.getAttribute('data-order-id') || '';

          // cliente_cod — button com data-title-os
          let cliente_cod = null;
          const clienteBtn = tr.querySelector('button[data-title-os]');
          if (clienteBtn) cliente_cod = clienteBtn.getAttribute('data-title-os') || null;

          // cod_profissional — button com data-motoboy
          let cod_profissional = null;
          const motoboyBtn = tr.querySelector('button[data-motoboy]');
          if (motoboyBtn) cod_profissional = motoboyBtn.getAttribute('data-motoboy') || null;

          // cod_rastreio + link_rastreio — do link de rastreamento
          // rastLink.href (propriedade) retorna o URL ABSOLUTO resolvido
          // pelo browser. Ex: '../../rastreamento?cod=AAEKJIK-23'
          //              →  'https://tutts.com.br/expresso/rastreamento?cod=AAEKJIK-23'
          let cod_rastreio = null;
          let link_rastreio = null;
          const rastLink = tr.querySelector('a[href*="rastreamento?cod="]');
          if (rastLink) {
            link_rastreio = rastLink.href || null; // URL absoluto resolvido
            const hrefAttr = rastLink.getAttribute('href') || '';
            const m = hrefAttr.match(/cod=([^&"'\s]+)/);
            if (m) cod_rastreio = m[1];
          }

          // _balloon — concatena TODOS os data-balloon dentro do tr + texto visível
          const balloons = Array.from(tr.querySelectorAll('[data-balloon]'))
            .map(el => el.getAttribute('data-balloon') || '')
            .filter(Boolean);
          const textoVisivel = (tr.innerText || '').replace(/\s+/g, ' ').trim();
          const balloon = (balloons.join(' | ') + ' | ' + textoVisivel).toUpperCase();

          // ── 🆕 2026-07 sla-monitor: campos extras pro snapshot SLA ──────────
          // horario_inicio_raw — botão de editar data/hora carrega o horário
          // da OS no atributo data-date-hour (formato BR "DD-MM-YYYY HH:MM:SS")
          let horario_inicio_raw = null;
          const btnHora = tr.querySelector('[data-action="editarDataHoraServico"]');
          if (btnHora) horario_inicio_raw = btnHora.getAttribute('data-date-hour') || null;

          // 🔧 2026-07 hotfix: na página acompanhamento-servicos o botão
          // editarDataHoraServico não existe (data-date-hour vinha null em
          // TODAS as OS → deadline null → "Sem dados"). Fallback: extrai as
          // datas do TEXTO da linha (coluna SOLICIT./AGENDAMENTO):
          //   - solicitação:  "01-07-2026 17:39:38"  (DD-MM-YYYY, ano 4 díg)
          //   - agendamento:  "02/07/26 08:10:00"    (DD/MM/YY, ano 2 díg)
          const txtLinha = tr.innerText || '';
          let horario_solicitacao_raw = null;
          let horario_agendamento_raw = null;
          const mSol = txtLinha.match(/\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}(?::\d{2})?/);
          if (mSol) horario_solicitacao_raw = mSol[0];
          const mAg = txtLinha.match(/\d{2}\/\d{2}\/\d{2,4}\s+\d{2}:\d{2}(?::\d{2})?/);
          if (mAg) horario_agendamento_raw = mAg[0];

          // modal_parametro — parâmetro do modal "Informações do serviço"
          // (usado pra buscar km/retorno via ajaxModalInformacoesServico.php)
          let modal_parametro = null;
          const btnModal = tr.querySelector('[data-action="ajaxModalInformacoesServico"]');
          if (btnModal) modal_parametro = btnModal.getAttribute('data-parameters') || null;

          // nome_profissional_raw — title do botão de trocar motoboy
          // (parse do nome fica no Node, aqui só coleta o atributo bruto)
          let nome_profissional_raw = null;
          const btnMoto = tr.querySelector('[data-action="trocarMotoboyServicoNovo"]');
          if (btnMoto) {
            nome_profissional_raw = (btnMoto.getAttribute('data-text-title')
              || btnMoto.getAttribute('title')
              || btnMoto.textContent
              || '').replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || null;
          }

          // cliente_nome — primeira célula cujo texto casa "NNN - Nome"
          let cliente_nome = null;
          for (const td of tr.querySelectorAll('td')) {
            const txt = (td.textContent || '').trim();
            const mc = txt.match(/^(\d{2,5})\s*[-–]\s*(.+)/);
            if (mc) { cliente_nome = mc[2].trim().slice(0, 200); break; }
          }

          return {
            os_numero, cliente_cod, cod_profissional, cod_rastreio, link_rastreio,
            _balloon: balloon,
            horario_inicio_raw, horario_solicitacao_raw, horario_agendamento_raw,
            modal_parametro, nome_profissional_raw, cliente_nome,
          };
        });
      });

      let novos = 0;
      for (const o of extraidas) {
        if (!o.os_numero) continue;
        if (!todasOsMap.has(o.os_numero)) {
          todasOsMap.set(o.os_numero, o);
          novos++;
        }
      }
      return { extraidas: extraidas.length, novos };
    }

    // Primeira página
    const r1 = await extrairOsAtuais();
    diag.paginasColetadas.push({ pagina: 1, ...r1 });
    etapa('pagina_extraida', { pagina: 1, ...r1, acumulado: todasOsMap.size });

    // 📄 PAGINAÇÃO via clique no "Próx." do paginador
    for (let pagina = 2; pagina <= MAX_PAGINAS_SANITY; pagina++) {
      if (Date.now() - t0 > TEMPO_MAX_MS) {
        etapa('timeout_estourou', { coletado: todasOsMap.size });
        break;
      }

      if (totalEsperado != null && todasOsMap.size >= totalEsperado) {
        etapa('alcancou_total', { coletado: todasOsMap.size, esperado: totalEsperado });
        break;
      }

      // Acha o link "Próx." — link do paginador cujo texto contém "Próx"
      // (ou ordem alternativa: link do paginador com número da página atual+1)
      const proximoHandle = await page.evaluateHandle(() => {
        const paginador = document.querySelector('#em-execucao, #pills-em-execucao .pagination');
        if (!paginador) return null;
        // Primeiro tenta "Próx."
        const links = Array.from(paginador.querySelectorAll('a.page-link'));
        const proxLink = links.find(a => /pr[oó]x/i.test(a.textContent || ''));
        if (proxLink) {
          // Verifica se o <li> pai está disabled
          const li = proxLink.closest('li');
          if (li && li.classList.contains('disabled')) return null;
          return proxLink;
        }
        return null;
      });

      const elemento = proximoHandle.asElement();
      if (!elemento) {
        etapa('sem_proximo', { coletado: todasOsMap.size });
        break;
      }

      // Clica no "Próx."
      try {
        await elemento.click();
      } catch (e) {
        etapa('erro_click_proximo', { erro: e.message });
        break;
      }

      // Aguarda a tabela renderizar novamente — os tr[data-order-id] antigos
      // são substituídos, então espera por re-render (timer simples + DOM check)
      await page.waitForTimeout(1200);
      // Verifica se ainda tem linhas (se não, a paginação quebrou)
      const ainda = await page.locator('#pills-em-execucao tr[data-order-id]').count().catch(() => 0);
      if (ainda === 0) {
        etapa('tabela_vazia_apos_click', { pagina });
        break;
      }

      const rN = await extrairOsAtuais();
      diag.paginasColetadas.push({ pagina, ...rN });
      etapa('pagina_extraida', { pagina, ...rN, acumulado: todasOsMap.size });

      // Se a última página não trouxe nada novo, para
      if (rN.novos === 0) {
        etapa('pagina_sem_novos', { pagina });
        break;
      }
    }

    // ── 🆕 2026-07 sla-monitor: busca km/retorno via modal (mesma sessão) ────
    // Roda DEPOIS da paginação, na mesma page (o fetch não depende do DOM,
    // só dos cookies da sessão). Concorrência limitada + teto por tick —
    // exatamente o que a extensão v8 NÃO fazia (60 POSTs paralelos na
    // sessão do operador).
    if (opts.buscarKm) {
      const TEMPO_MAX_KM_MS = Number(process.env.SLA_MONITOR_KM_TEMPO_MAX_MS || 60_000);
      const pular  = new Set(opts.buscarKm.pular || []);
      const maxKm  = Number(opts.buscarKm.max || 40);
      const conc   = Math.max(1, Math.min(6, Number(opts.buscarKm.concorrencia || 4)));

      const alvos = Array.from(todasOsMap.values())
        .filter(o => o.modal_parametro && !pular.has(o.os_numero))
        .slice(0, maxKm)
        .map(o => ({ os: o.os_numero, parametro: o.modal_parametro }));

      etapa('km_fetch_inicio', { alvos: alvos.length, concorrencia: conc });

      if (alvos.length > 0) {
        try {
          const kmResultados = await page.evaluate(async ({ alvos, url, tempoMaxMs, conc }) => {
            const t0 = Date.now();
            const resultados = {};

            async function buscarUm({ os, parametro }) {
              try {
                const r = await fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                  body: 'parametro=' + encodeURIComponent(parametro),
                });
                const html = await r.text();
                const mKm = html.match(/Dist[aâ]ncia\s*(?:rota)?[:\s]*([\d]+[.,][\d]+)/i);
                const km  = mKm ? parseFloat(mKm[1].replace(',', '.')) : null;
                const ret = html.toLowerCase().includes('com retorno');
                let motivo = null;
                if (ret) {
                  const mr = html.match(/(Produto incorreto|Loja fechada[^<]*|Cliente Ausente|Endere[çc]o n[ãa]o localizado|Favor retornar[^<]*)/i);
                  motivo = mr ? mr[1].trim() : 'Com retorno';
                }
                resultados[os] = { km, retorno: ret, motivo };
              } catch (e) {
                resultados[os] = { km: null, retorno: false, motivo: null, erro: String(e && e.message || e) };
              }
            }

            // Fila com concorrência limitada + respeito ao tempo máximo
            const fila = alvos.slice();
            async function worker() {
              while (fila.length > 0) {
                if (Date.now() - t0 > tempoMaxMs) return;
                const alvo = fila.shift();
                if (!alvo) return;
                await buscarUm(alvo);
              }
            }
            await Promise.all(Array.from({ length: conc }, () => worker()));
            return resultados;
          }, { alvos, url: MODAL_INFO_URL(), tempoMaxMs: TEMPO_MAX_KM_MS, conc });

          diag.kmPorOs = kmResultados;
          const comKm = Object.values(kmResultados).filter(v => v.km != null).length;
          etapa('km_fetch_fim', { consultadas: Object.keys(kmResultados).length, comKm });
        } catch (e) {
          etapa('km_fetch_erro', { erro: e.message });
          diag.kmPorOs = {};
        }
      } else {
        diag.kmPorOs = {};
      }
    }

  } catch (err) {
    log(`❌ [coletarOs] Erro: ${err.message}`);
    return { ok: false, motivo: err.message, sessaoExpirada: false, diag };
  } finally {
    try { if (page) await comTimeout(page.close(), 3_000, 'page.close'); } catch (_) {}
    try { if (context) await comTimeout(context.close(), 3_000, 'context.close'); } catch (_) {}
    if (!_browserEhOverride2) await fecharBrowserSeguro(browser);
    releaseMutex();
  }

  const ordens = Array.from(todasOsMap.values());
  const duracaoMs = Date.now() - t0;
  log(`✅ [coletarOs] ${ordens.length} OS extraídas em ${diag.paginasColetadas.length} página(s) (${duracaoMs}ms)`);

  return {
    ok: true,
    ordens,
    totalEsperado,
    paginas: diag.paginasColetadas.length,
    duracaoMs,
    // 🆕 2026-07 sla-monitor: km/retorno consultados neste tick (se opts.buscarKm)
    kmPorOs: diag.kmPorOs || {},
    diag,
  };
}




/**
 * 🆕 2026-05 v3: nova assinatura aceita `configEntries` opcional, que é o
 * array de cadastros do cliente vindo de carregarConfig() do detector.
 * Quando passado, a função usa as palavras-chave configuradas pra decidir
 * qual cadastro a OS pertence (e portanto qual grupo Evolution receberá
 * a mensagem). Retorna a entry escolhida em `configMatched` do resultado.
 *
 * Retrocompat: se `configEntries` for null/vazio, mantém o comportamento
 * antigo (hardcoded ponto1Bate767 pro 767, sem filtro pro 814).
 */
async function capturarPontosOS({ os_numero, cliente_cod, configEntries }) {
  if (!process.env.SISTEMA_EXTERNO_URL) {
    throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  }
  if (!/^\d{7}$/.test(String(os_numero || ''))) {
    throw new Error(`os_numero inválido: ${os_numero}`);
  }
  // 2026-05 v3: aceita QUALQUER cliente_cod cadastrado em rastreio_clientes_config.
  // Antes era restrito a '814' e '767' hardcoded. Agora 814/767 continuam tendo
  // parsers específicos (parseEntrega814/parseEntrega767), mas se outro cliente
  // aparecer com configEntries definido, usa parseEntrega767 como fallback genérico
  // (que extrai endereço, nome, NF — campos universais).
  const codStr = String(cliente_cod);
  if (!['814', '767'].includes(codStr) && (!configEntries || configEntries.length === 0)) {
    throw new Error(`cliente_cod inválido: ${cliente_cod} (esperado 814 ou 767, ou configEntries pra cliente customizado)`);
  }

  await acquireMutex(`capturarPontosOS(${os_numero})`);

  let browser = null;
  let _browserEhOverride3 = false;
  let context = null;

  try {
    ({ browser, _ehOverride: _browserEhOverride3 } = await _getBrowser());

    // Reusa cookies se possível
    if (fs.existsSync(getSessionFile())) {
      try {
        context = await browser.newContext({ storageState: getSessionFile() });
      } catch {
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
    }

    // 2026-04 egress-fix: bloqueia trackers externos (Facebook, GA, etc)
    await aplicarBloqueio(context, 'sla-capture/3');

    // 🆕 Instala captura de payload AJAX ANTES de qualquer navegação.
    // O listener vive durante toda a sessão do contexto e atualiza
    // /tmp/tutts-sla-meta.json toda vez que a página chamar o endpoint
    // viewServicoAcompanhamento (que acontece automaticamente no load
    // da página de acompanhamento e no clique da aba "Em execução").
    instalarCapturaPayload(context);

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Navega pra página de acompanhamento — timeout maior pro caso de MAP lento
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1000);

    // Confirma sessão — se não, relogin
    if (!(await isLoggedIn(page))) {
      await fazerLogin(page, _credentialsOverride);
      // 🔧 2026-05-31 FIX: passar pela tela de feriados ANTES do acompanhamento.
      // Sem isso o servidor faz redirect chain acompanhamento → index → principal.php,
      // e #search-autocomplete-input nunca aparece (Timeout 25000ms).
      await dispensarFeriados(page, log);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
    }

    // Persiste cookies pra próxima captura reaproveitar
    try {
      await context.storageState({ path: getSessionFile() });
    } catch (_) {}

    // ── Passo 1: ativa aba "Em execução" ──────────────────────────────────
    log(`📌 Localizando OS ${os_numero} — ativando aba Em execução`);
    const abaEmExecucao = page.locator('#pills-em-execucao-tab');
    if (await abaEmExecucao.isVisible({ timeout: 3000 }).catch(() => false)) {
      await abaEmExecucao.click();
      await page.waitForTimeout(800);
    }

    // ── Passo 2: tenta achar o botão da OS no DOM direto ─────────────────
    // (mesmo seletor robusto do playwright-agent: data-id OU data-text-id)
    const btnSelector =
      `button.btn-modal[data-action="funcaoEnderecoServico"][data-id="${os_numero}"], ` +
      `button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="${os_numero}"]`;

    let btnCount = await page.locator(btnSelector).count();

    // ── Passo 3: se não achou, usa a busca do sistema (barra + autocomplete jQuery UI) ──
    if (btnCount === 0) {
      log(`🔍 OS ${os_numero} não está no DOM — usando barra de pesquisa`);

      // Expande a barra "Pesquisar serviços" se estiver recolhida
      const barraPesquisa = page.locator('text=Pesquisar serviços').first();
      if (await barraPesquisa.isVisible({ timeout: 2000 }).catch(() => false)) {
        await barraPesquisa.click();
        await page.waitForTimeout(500);
      }

      // Seleciona "Serviço" no dropdown #search-type
      const selectPesquisa = page.locator('#search-type');
      if (await selectPesquisa.isVisible({ timeout: 3000 }).catch(() => false)) {
        try {
          await selectPesquisa.selectOption({ label: 'Serviço' });
          await page.waitForTimeout(500);
        } catch (_) {
          // Opção pode ter label diferente — ignora e segue
        }
      }

      // Preenche o input do autocomplete
      const inputBusca = page
        .locator('#search-autocomplete-input, input[placeholder*="número do serviço"]')
        .first();

      let inputVisivel = false;
      try {
        await inputBusca.waitFor({ state: 'visible', timeout: 8000 });
        inputVisivel = true;
      } catch {
        inputVisivel = false;
      }

      if (!inputVisivel) {
        // Sessão provavelmente morreu — força re-login e retry
        log('⚠️ Campo de busca não apareceu — forçando re-login');
        try {
          if (fs.existsSync(getSessionFile())) fs.unlinkSync(getSessionFile());
        } catch (_) {}
        await fazerLogin(page, _credentialsOverride);
        // 🔧 2026-05-31 FIX: dispensar feriados antes de reabrir o acompanhamento
        await dispensarFeriados(page, log);
        await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);
        try {
          await context.storageState({ path: getSessionFile() });
        } catch (_) {}

        // Reativa aba execução
        const abaRetry = page.locator('#pills-em-execucao-tab');
        if (await abaRetry.isVisible({ timeout: 3000 }).catch(() => false)) {
          await abaRetry.click();
          await page.waitForTimeout(800);
        }

        // Re-expande barra + seleciona tipo
        const barraRetry = page.locator('text=Pesquisar serviços').first();
        if (await barraRetry.isVisible({ timeout: 2000 }).catch(() => false)) {
          await barraRetry.click();
          await page.waitForTimeout(500);
        }
        const selectRetry = page.locator('#search-type');
        if (await selectRetry.isVisible({ timeout: 3000 }).catch(() => false)) {
          try {
            await selectRetry.selectOption({ label: 'Serviço' });
            await page.waitForTimeout(500);
          } catch (_) {}
        }

        await inputBusca.waitFor({ state: 'visible', timeout: TIMEOUT });
      }

      await inputBusca.fill(String(os_numero));
      await page.waitForTimeout(1500); // aguardar jQuery UI autocomplete

      // Clica no item do autocomplete que bate com a OS
      const autoItem = page
        .locator('.ui-menu-item .ui-menu-item-wrapper')
        .filter({ hasText: String(os_numero) })
        .first();

      if (await autoItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await autoItem.click();
      } else {
        // Fallback: primeiro item visível, ou Enter
        const anyAutoItem = page.locator('.ui-menu-item-wrapper:visible').first();
        if (await anyAutoItem.isVisible({ timeout: 1500 }).catch(() => false)) {
          await anyAutoItem.click();
        } else {
          await inputBusca.press('Enter');
        }
      }

      await page.waitForTimeout(2000);

      // Aguarda o botão aparecer no DOM (não precisa ser visível no viewport)
      try {
        await page.waitForSelector(btnSelector, { state: 'attached', timeout: TIMEOUT });
      } catch (_) {
        throw new Error(
          `OS ${os_numero} não encontrada mesmo após pesquisa por autocomplete. ` +
          `Pode já ter sido finalizada/cancelada no MAP.`
        );
      }

      btnCount = await page.locator(btnSelector).count();
    }

    if (btnCount === 0) {
      throw new Error(`OS ${os_numero} não encontrada na tela mesmo após pesquisa.`);
    }

    // ── Passo 4: scroll + clica no botão END. pra abrir modal de endereços ──
    const btnEnd = page.locator(btnSelector).first();
    await btnEnd.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    log(`📌 Abrindo modal de endereços da OS ${os_numero}`);
    await btnEnd.click({ force: true });

    // Aguarda modal aparecer
    try {
      await page.waitForSelector(
        '.modal.show, .modal.in, #modalPadrao.show, #modalPadrao.in',
        { state: 'visible', timeout: TIMEOUT }
      );
    } catch (_) {
      throw new Error(`Modal de endereços não abriu para OS ${os_numero}`);
    }
    await page.waitForTimeout(600); // aguarda conteúdo terminar de carregar

    // ── Passo 5: extrai pontos via DOM estruturado ────────────────────────
    // Estrutura esperada (do playwright-agent):
    //   <button class="btn-corrigir-endereco"
    //           data-ponto="N"
    //           data-id-endereco="X"
    //           data-lat="..." data-lon="...">
    //   <span id="end-antigo-{X}">{endereço}</span>
    const pontosBrutos = await page.evaluate(() => {
      const btns = document.querySelectorAll('.btn-corrigir-endereco[data-ponto]');
      const resultado = [];
      btns.forEach((btn) => {
        const numero = parseInt(btn.getAttribute('data-ponto') || '0', 10);
        if (!numero || numero < 1 || numero > 9) return;

        const idEnd = btn.getAttribute('data-id-endereco');
        let texto = '';

        // Estratégia 1: span#end-antigo-{id} + contexto completo do container
        if (idEnd) {
          const span = document.getElementById('end-antigo-' + idEnd);
          if (span) {
            // Pega o container do ponto inteiro pra ter NF + nome cliente
            let container = span.parentElement;
            // Sobe até achar um elemento que contenha "Ponto"
            for (let i = 0; i < 5 && container; i++) {
              if ((container.textContent || '').includes('Ponto')) break;
              container = container.parentElement;
            }
            if (container) {
              const full = (container.textContent || '').replace(/\s+/g, ' ').trim();
              // Extrai texto entre "Ponto N" e "Corrigir|Ver ponto|Chegou"
              const pontoRe = new RegExp('Ponto\\s*' + numero + '\\s+([\\s\\S]*?)(?:Corrigir|Ver ponto|Chegou|$)', 'i');
              const pm = full.match(pontoRe);
              if (pm && pm[1].trim().length > 10) {
                texto = pm[1].replace(/\s+/g, ' ').trim();
              }
            }
            // Fallback: só o span se container não deu certo
            if (!texto || texto.length < 5) {
              texto = (span.textContent || '').trim();
            }
          }
        }

        // Estratégia 2: fallback — pega o container do ponto e extrai texto
        if (!texto || texto.length < 5) {
          let container = btn.parentElement;
          while (container && !container.textContent.includes('Ponto')) {
            container = container.parentElement;
            if (container && container.classList.contains('modal-body')) break;
          }
          if (container) {
            const fullText = container.textContent || '';
            const regex = /Ponto\s*\d+\s*([\s\S]*?)(?:PEC|Corrigir|$)/i;
            const m = fullText.match(regex);
            if (m) {
              texto = m[1].replace(/\s+/g, ' ').trim().substring(0, 500);
            }
          }
        }

        if (texto) {
          resultado.push({ numero, texto });
        }
      });
      // Garante ordem por número do ponto
      return resultado.sort((a, b) => a.numero - b.numero);
    });

    // Fecha o modal (pra não deixar lixo visual em debug/screenshots futuros)
    try {
      await page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal.in, #modalPadrao.show, #modalPadrao.in');
        if (modal) {
          const btnClose = modal.querySelector('button[data-dismiss="modal"], .close, .modal-header .close');
          if (btnClose) btnClose.click();
        }
      });
      await page.waitForTimeout(300);
    } catch (_) {}

    log(`📋 OS ${os_numero}: ${pontosBrutos.length} ponto(s) extraído(s) do modal`);

    // Metadata de debug retornado junto com o resultado
    const debugInfo = {
      pontosBrutos,
      fonte: 'modal_enderecos_dom',
    };

    if (pontosBrutos.length === 0) {
      const err = new Error(`Nenhum ponto extraído do modal de endereços (OS ${os_numero}).`);
      err.debugInfo = debugInfo;
      throw err;
    }

    // 🆕 2026-05 v3: filtro genérico via configEntries (palavras-chave do banco).
    //
    // Comportamento:
    //   - Se configEntries foi passado E tem pelo menos uma entry:
    //       Usa escolherConfigPorTexto pra decidir qual cadastro a OS pertence
    //       (baseado no Ponto 1). Se nenhum bater, OS é descartada.
    //       Quando uma config bate, retornamos `configMatched` no payload.
    //   - Se configEntries NÃO foi passado (chamada legada):
    //       Mantém comportamento hardcoded — 814 pega tudo, 767 exige Galba.
    //
    // Justificativa de design: o ponto 1 contém o endereço de coleta. O usuário
    // (Tutts) cadastra palavras-chave que aparecem nesse endereço pra discriminar
    // operações. Ex: '767 + GALBA' (operação A), '767 + JOAO' (operação B).
    const ponto1 = pontosBrutos.find((pt) => pt.numero === 1);

    let pontosParsed;
    let configMatched = null;

    if (Array.isArray(configEntries) && configEntries.length > 0) {
      // Fluxo NOVO: decide via configEntries
      configMatched = escolherConfigPorTexto(ponto1 ? ponto1.texto : '', configEntries);
      if (!configMatched) {
        return {
          pontos: [], skipped: true,
          motivo: 'nenhum_filtro_bateu',
          debugInfo,
        };
      }
      // Escolhe parser apropriado: 814 usa parser próprio, demais (767 e custom)
      // usam parseEntrega767 (que é o mais completo — endereço, nome, NF)
      const parser = cliente_cod === '814' ? parseEntrega814 : parseEntrega767;
      pontosParsed = pontosBrutos
        .filter((pt) => pt.numero >= 2)
        .map((pt) => ({ numero: pt.numero, textoBruto: pt.texto, ...(parser(pt.texto) || {}) }));
    } else {
      // Fluxo LEGADO (retrocompat): 814 sem filtro, 767 com hardcoded Galba
      if (cliente_cod === '814') {
        pontosParsed = pontosBrutos
          .filter((pt) => pt.numero >= 2)
          .map((pt) => ({ numero: pt.numero, textoBruto: pt.texto, ...(parseEntrega814(pt.texto) || {}) }));
      } else {
        if (!ponto1 || !ponto1Bate767(ponto1.texto)) {
          return { pontos: [], skipped: true, motivo: 'ponto1_nao_bate_767', debugInfo };
        }
        pontosParsed = pontosBrutos
          .filter((pt) => pt.numero >= 2)
          .map((pt) => ({ numero: pt.numero, textoBruto: pt.texto, ...(parseEntrega767(pt.texto) || {}) }));
      }
    }

    if (pontosParsed.length === 0) {
      return { pontos: [], skipped: true, motivo: 'sem_pontos_entrega', debugInfo };
    }

    return { pontos: pontosParsed, skipped: false, debugInfo, configMatched };
  } finally {
    try {
      if (context) await comTimeout(context.close(), 3_000, 'context.close');
    } catch (_) {}
    if (!_browserEhOverride3) await fecharBrowserSeguro(browser);
    releaseMutex();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════════════════
//
// 🔧 CRÍTICO (2026-04): Wrappers `*ComWatchdog` REMOVIDOS.
//
// Antes existiam wrappers `comTimeout(fn(), 90s, ...)` que envolviam as funções
// inteiras. O problema: `comTimeout` faz `Promise.race`, e quando o timeout
// dispara, a função INTERNA continua rodando (JS não cancela Promise) — mas
// o lock global `withBrowserLock` libera porque a Promise rejeitou.
//
// Resultado: o próximo job pegava o lock e tentava `chromium.launch()` em
// CIMA do anterior ainda fechando, causando SIGTRAP / "Target page, context
// or browser has been closed".
//
// A garantia de não-trava agora vem de duas camadas:
//   1. Timeouts INTERNOS do Playwright em cada operação (TIMEOUT=25s,
//      NAV_TIMEOUT=45s, page.setDefaultTimeout) — qualquer operação individual
//      lança erro se demorar muito.
//   2. `fecharBrowserSeguro` no `finally` de cada função (close gracioso 5s,
//      depois SIGKILL no processo). Garante que quando a função retorna
//      (sucesso ou erro), o Chromium ESTÁ MORTO.
//
// Resultado: quando o lock global libera, o browser do job anterior já se foi.

module.exports = {
  // Overrides para uso pelo agent-pool (multi-conta)
  setOverrides,
  clearOverrides,
  capturarPontosOS,
  garantirSessao,
  coletarOsEmExecucao,
  // Aliases mantidos pra compatibilidade com import antigo
  _semWatchdog: {
    capturarPontosOS,
    garantirSessao,
    coletarOsEmExecucao,
  },
  // expostos pra testes unitários
  _internal: { parseEntrega814, parseEntrega767, ponto1Bate767, escolherConfigPorTexto },
};
