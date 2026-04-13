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

const SESSION_FILE = '/tmp/tutts-sla-session.json';
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

// ── Mutex interno (serializa capturas nesta sessão) ──────────────────────────
let _mutexBusy = false;
const _mutexQueue = [];

async function acquireMutex() {
  if (!_mutexBusy) {
    _mutexBusy = true;
    return;
  }
  await new Promise((resolve) => _mutexQueue.push(resolve));
  _mutexBusy = true;
}

function releaseMutex() {
  _mutexBusy = false;
  const next = _mutexQueue.shift();
  if (next) next();
}

function log(msg) {
  logger.info(`[sla-capture-playwright] ${msg}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// LOGIN
// ═════════════════════════════════════════════════════════════════════════════

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

async function fazerLogin(page) {
  const email = process.env.SISTEMA_EXTERNO_SLA_EMAIL;
  const senha = process.env.SISTEMA_EXTERNO_SLA_SENHA;

  if (!email || !senha) {
    throw new Error(
      'SISTEMA_EXTERNO_SLA_EMAIL / SISTEMA_EXTERNO_SLA_SENHA não configuradas no Railway.'
    );
  }

  log('🔐 Login SLA (credencial dedicada)...');

  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    throw new Error(`Página de login não carregou. URL: ${page.url()}`);
  }

  await page.fill('#loginEmail', email);
  await page.fill('input[type="password"]', senha);
  await page.locator('input[name="logar"]').first().click();

  await page.waitForURL((url) => !url.toString().includes('loginFuncionarioNovo'), {
    timeout: TIMEOUT,
  });
  log(`✅ Login SLA OK — URL: ${page.url()}`);
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

// ── Termos discriminativos do Ponto 1 do 767 (Galba Novas de Castro) ────────
const TERMOS_PONTO1_767 = ['GALBA', 'NOVAS DE CASTRO', '57061-510', '57061510'];

function ponto1Bate767(texto) {
  if (!texto) return false;
  const up = String(texto).toUpperCase();
  return TERMOS_PONTO1_767.some((termo) => up.includes(termo.toUpperCase()));
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
 *   1. Garantir que existe uma sessão Playwright válida em SESSION_FILE
 *   2. Garantir que o META_FILE com o payload AJAX está atualizado
 *
 * Sem buscar nenhuma OS, sem clicar em nada, sem ruído.
 *
 * Fluxo:
 *   - Abre browser headless
 *   - Tenta reusar SESSION_FILE; se inválido, faz login completo
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
  await acquireMutex();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let context;
  let payloadAntes = null;

  // Snapshot do mtime do META_FILE pra detectar se a captura efetivamente atualizou
  try {
    if (fs.existsSync(META_FILE)) {
      payloadAntes = fs.statSync(META_FILE).mtimeMs;
    }
  } catch (_) {}

  try {
    if (fs.existsSync(SESSION_FILE)) {
      try {
        context = await browser.newContext({ storageState: SESSION_FILE });
      } catch {
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
    }

    // 🔑 Listener de captura de payload — mesma função usada pelo capturarPontosOS
    instalarCapturaPayload(context);

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    log('🔓 garantirSessao: navegando pra acompanhamento-servicos');
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    if (!(await isLoggedIn(page))) {
      log('🔓 garantirSessao: sessão inválida, fazendo login completo');
      await fazerLogin(page);
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
      await context.storageState({ path: SESSION_FILE });
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
      if (context) await context.close();
    } catch (_) {}
    try { await browser.close(); } catch (_) {}
    releaseMutex();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COLETAR OS EM EXECUÇÃO — retorna lista pronta de OS pra alimentar o detector
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Abre browser, garante sessão, navega pra acompanhamento, clica na aba
 * "Em execução", e captura TODAS as responses do XHR viewServicoAcompanhamento
 * (página inicial + cliques no paginador da UI).
 *
 * Reúne tudo numa lista deduplicada e retorna.
 *
 * 🔧 Por que essa função existe (2026-04-13):
 *   Tentativas de fazer o detector chamar o endpoint diretamente (com node
 *   fetch, playwright.request.newContext, ou page.evaluate(fetch)) sempre
 *   resultaram em HTML em vez de JSON. O servidor PHP do tutts.com.br só
 *   responde JSON quando o request vem de um clique natural na UI dentro
 *   de uma sessão "ativada". Então a única forma robusta é deixar o
 *   navegador fazer naturalmente e interceptar a resposta.
 *
 * Esta função usa o MESMO mutex do capturarPontosOS, então não há
 * concorrência por Chromium quando o sla-capture-worker está processando
 * fila ao mesmo tempo.
 *
 * Retorna:
 *   {
 *     ok: true,
 *     ordens: [{ os_numero, cliente_cod, cod_profissional, _balloon, raw }],
 *     totalEsperado: number | null,
 *     paginas: number,
 *     duracaoMs: number,
 *   }
 *   ou em caso de erro:
 *   { ok: false, motivo: string, sessaoExpirada: boolean }
 */
async function coletarOsEmExecucao() {
  const TEMPO_MAX_MS = 90_000;
  const MAX_PAGINAS_SANITY = 1000;
  const DEBUG_DUMP_FILE = '/tmp/tutts-coletar-debug.json';

  await acquireMutex();
  const t0 = Date.now();

  // 🔬 Diagnóstico completo — tudo isso vai pro retorno pra ver no /debug endpoint
  const diag = {
    etapas: [],
    xhrsVistos: [],      // TODOS os responses do endpoint, mesmo HTML
    lastResponseText: null,
    lastResponseHeaders: null,
    lastResponseUrl: null,
  };
  function etapa(nome, extra) {
    const evento = { etapa: nome, t: Date.now() - t0, ...(extra || {}) };
    diag.etapas.push(evento);
    log(`📍 [coletarOs] ${nome}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  }

  let browser, context, page;
  const respostasCapturadas = [];

  try {
    etapa('start');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    etapa('browser_launched');

    if (fs.existsSync(SESSION_FILE)) {
      try {
        context = await browser.newContext({ storageState: SESSION_FILE });
        etapa('context_created_with_storage');
      } catch (e) {
        etapa('context_storage_failed', { erro: e.message });
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
      etapa('context_created_no_storage');
    }

    // 🎯 Listener de RESPOSTA — captura TODOS os responses do endpoint
    // (mesmo HTML), pra diagnosticar o que o servidor está retornando
    context.on('response', async (resp) => {
      try {
        if (resp.request().method() !== 'POST') return;
        if (!/viewServicoAcompanhamento/i.test(resp.url())) return;

        const status = resp.status();
        const headers = resp.headers();
        const ct = headers['content-type'] || '';
        const text = await resp.text();
        const len = text.length;

        // Sempre registra no diagnóstico
        const xhrInfo = {
          url: resp.url(),
          status,
          contentType: ct,
          bytes: len,
          preview: text.slice(0, 300).replace(/\s+/g, ' ').trim(),
        };
        diag.xhrsVistos.push(xhrInfo);
        diag.lastResponseText = text;
        diag.lastResponseHeaders = headers;
        diag.lastResponseUrl = resp.url();

        log(`🔎 [coletarOs] XHR interceptado: HTTP ${status} | bytes=${len} | ct=${ct}`);

        // Tenta parsear como JSON mesmo que content-type não seja JSON
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          log(`⚠️ [coletarOs] Response NÃO é JSON parsável: ${e.message}`);
          log(`⚠️ [coletarOs] Preview: ${xhrInfo.preview}`);
          return;
        }

        respostasCapturadas.push(data);
        const numOs = Array.isArray(data?.retornoMultiplos?.['5'])
          ? data.retornoMultiplos['5'].length
          : 0;
        log(`📨 [coletarOs] XHR #${respostasCapturadas.length} PARSED: ${numOs} OS`);
      } catch (e) {
        log(`⚠️ [coletarOs] erro no listener: ${e.message}`);
      }
    });

    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    etapa('page_created');

    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    etapa('page_goto_done', { url: page.url() });
    await page.waitForTimeout(800);

    const loggedIn = await isLoggedIn(page);
    etapa('logged_in_check', { loggedIn });

    if (!loggedIn) {
      await fazerLogin(page);
      etapa('login_done');
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      etapa('page_goto_after_login', { url: page.url() });
      await page.waitForTimeout(1500);
    }

    // Verifica existência da aba ANTES de tentar clicar
    const abaEmExecucao = page.locator('#pills-em-execucao-tab');
    const abaCount = await abaEmExecucao.count().catch(() => 0);
    const abaVisivel = abaCount > 0
      ? await abaEmExecucao.first().isVisible({ timeout: 3000 }).catch(() => false)
      : false;
    etapa('aba_check', { count: abaCount, visivel: abaVisivel });

    if (!abaVisivel) {
      // Vamos olhar o HTML da página pra diagnosticar
      const bodyPreview = await page.evaluate(() => {
        const b = document.body ? document.body.innerText : '';
        return b.slice(0, 500);
      }).catch(() => '(falha ao ler body)');
      diag.bodyPreview = bodyPreview;
      etapa('aba_nao_visivel_body', { preview: bodyPreview });
      return { ok: false, motivo: 'aba_nao_visivel', sessaoExpirada: false, diag };
    }

    // Clica e aguarda QUALQUER response do endpoint
    await abaEmExecucao.first().click();
    etapa('aba_clicada');

    try {
      await page.waitForResponse(
        (r) => /viewServicoAcompanhamento/i.test(r.url()) && r.request().method() === 'POST',
        { timeout: 15_000 }
      );
      etapa('waitForResponse_ok');
    } catch (e) {
      etapa('waitForResponse_timeout', { erro: e.message });
    }

    // Dá tempo extra pro listener processar
    await page.waitForTimeout(2000);
    etapa('wait_extra_done', {
      xhrsVistos: diag.xhrsVistos.length,
      respostasParsed: respostasCapturadas.length,
    });

    // Salva contexto atualizado
    try {
      await context.storageState({ path: SESSION_FILE });
    } catch (_) {}

    // Dump do último response pra inspeção
    if (diag.lastResponseText) {
      try {
        fs.writeFileSync(DEBUG_DUMP_FILE, JSON.stringify({
          url: diag.lastResponseUrl,
          headers: diag.lastResponseHeaders,
          bodyPreview: diag.lastResponseText.slice(0, 5000),
        }, null, 2));
      } catch (_) {}
    }

    if (respostasCapturadas.length === 0) {
      return {
        ok: false,
        motivo: 'nenhum_xhr_capturado',
        sessaoExpirada: true,
        diag,
      };
    }

    // Total esperado do primeiro XHR
    let totalEsperado = null;
    const qtdCampo = respostasCapturadas[0]?.retornoMultiplos?.['4']?.[0]?.quantidade;
    if (qtdCampo != null) {
      totalEsperado = parseInt(qtdCampo, 10);
      etapa('total_esperado', { totalEsperado });
    }

    // 📄 PAGINAÇÃO via cliques na UI
    const seletoresProximo = [
      'a.proxima:not(.disabled)',
      'a.next:not(.disabled)',
      'button.proxima:not([disabled])',
      'button.next:not([disabled])',
      '.pagination li:not(.disabled) a[rel="next"]',
      '.pagination .next:not(.disabled) a',
      '.pagination .next:not(.disabled)',
      'a[onclick*="proximaPagina"]',
      'a[onclick*="pagina+1"]',
      'a[onclick*="paginar"]',
      'a[data-action="proxima"]',
      '#btnProximaPagina:not([disabled])',
      'li.next:not(.disabled) a',
      '[aria-label="Próxima"]:not([disabled])',
      '[aria-label="Next"]:not([disabled])',
    ];

    let paginasNavegadas = 1;
    while (paginasNavegadas < MAX_PAGINAS_SANITY) {
      if (Date.now() - t0 > TEMPO_MAX_MS) {
        log(`⏱️  [coletarOs] Timeout estourado — abortando com ${respostasCapturadas.length} XHRs`);
        break;
      }

      // Conta OS coletadas até agora
      const totalColetado = respostasCapturadas.reduce((acc, r) => {
        const lista = Array.isArray(r?.retornoMultiplos?.['5']) ? r.retornoMultiplos['5'] : [];
        return acc + lista.length;
      }, 0);

      if (totalEsperado != null && totalColetado >= totalEsperado) {
        log(`✅ [coletarOs] Coletado ${totalColetado}/${totalEsperado} — fim`);
        break;
      }

      // Tenta achar e clicar no botão "próxima"
      let clicou = false;
      for (const sel of seletoresProximo) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
            log(`🖱️ [coletarOs] Clicando paginador: ${sel}`);
            await el.click().catch(() => {});
            clicou = true;
            break;
          }
        } catch (_) {}
      }

      if (!clicou) {
        log(`⚠️ [coletarOs] Nenhum paginador encontrado — encerrando (coletadas ${totalColetado}${totalEsperado != null ? '/' + totalEsperado : ''})`);
        break;
      }

      // Aguarda novo XHR
      const xhrCountAntes = respostasCapturadas.length;
      try {
        await page.waitForResponse(
          (r) => /viewServicoAcompanhamento/i.test(r.url()) && r.request().method() === 'POST',
          { timeout: 10_000 }
        );
      } catch (e) {
        log(`⚠️ [coletarOs] Timeout esperando XHR pós-clique: ${e.message}`);
        break;
      }
      await page.waitForTimeout(800);

      // Se o número de respostas não aumentou, o clique não disparou nada novo
      if (respostasCapturadas.length === xhrCountAntes) {
        log('⚠️ [coletarOs] Clique não disparou novo XHR — encerrando');
        break;
      }

      paginasNavegadas++;
    }

    // Agrega + dedup
    const todasOsRaw = [];
    for (const resp of respostasCapturadas) {
      const lista = Array.isArray(resp?.retornoMultiplos?.['5']) ? resp.retornoMultiplos['5'] : [];
      todasOsRaw.push(...lista);
    }

    const vistos = new Set();
    const todasOs = [];
    for (const item of todasOsRaw) {
      const id = String(item['s.id'] || '');
      if (!id || vistos.has(id)) continue;
      vistos.add(id);

      // Sintetiza _balloon concatenando valores string do item
      const balloonParts = [];
      for (const v of Object.values(item)) {
        if (v == null) continue;
        if (typeof v === 'string' || typeof v === 'number') balloonParts.push(String(v));
      }

      todasOs.push({
        os_numero: id,
        cliente_cod: String(item['s.idSolicitante'] || '').trim() || null,
        cod_profissional: String(item['s.idMotoboy'] || '').trim() || null,
        cod_rastreio: null,
        _balloon: balloonParts.join(' | ').toUpperCase(),
        raw: item,
      });
    }

    const duracaoMs = Date.now() - t0;
    log(`✅ [coletarOs] ${todasOs.length} OS únicas em ${respostasCapturadas.length} XHR(s) (${duracaoMs}ms)`);

    return {
      ok: true,
      ordens: todasOs,
      totalEsperado,
      paginas: respostasCapturadas.length,
      duracaoMs,
      diag,
    };

  } catch (err) {
    log(`❌ [coletarOs] Erro: ${err.message}`);
    return { ok: false, motivo: err.message, sessaoExpirada: false, diag };
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
    releaseMutex();
  }
}


async function capturarPontosOS({ os_numero, cliente_cod }) {
  if (!process.env.SISTEMA_EXTERNO_URL) {
    throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  }
  if (!/^\d{7}$/.test(String(os_numero || ''))) {
    throw new Error(`os_numero inválido: ${os_numero}`);
  }
  if (!['814', '767'].includes(String(cliente_cod))) {
    throw new Error(`cliente_cod inválido: ${cliente_cod} (esperado 814 ou 767)`);
  }

  await acquireMutex();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let context;
  try {
    // Reusa cookies se possível
    if (fs.existsSync(SESSION_FILE)) {
      try {
        context = await browser.newContext({ storageState: SESSION_FILE });
      } catch {
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
    }

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
      await fazerLogin(page);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
    }

    // Persiste cookies pra próxima captura reaproveitar
    try {
      await context.storageState({ path: SESSION_FILE });
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
          if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
        } catch (_) {}
        await fazerLogin(page);
        await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);
        try {
          await context.storageState({ path: SESSION_FILE });
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

    // Aplica parser específico do cliente
    let pontosParsed;
    if (cliente_cod === '814') {
      pontosParsed = pontosBrutos
        .filter((pt) => pt.numero >= 2)
        .map((pt) => ({ numero: pt.numero, ...(parseEntrega814(pt.texto) || {}) }));
    } else {
      // 767: só dispara se Ponto 1 bater com Galba
      const ponto1 = pontosBrutos.find((pt) => pt.numero === 1);
      if (!ponto1 || !ponto1Bate767(ponto1.texto)) {
        return { pontos: [], skipped: true, motivo: 'ponto1_nao_bate_767', debugInfo };
      }
      pontosParsed = pontosBrutos
        .filter((pt) => pt.numero >= 2)
        .map((pt) => ({ numero: pt.numero, ...(parseEntrega767(pt.texto) || {}) }));
    }

    if (pontosParsed.length === 0) {
      return { pontos: [], skipped: true, motivo: 'sem_pontos_entrega', debugInfo };
    }

    return { pontos: pontosParsed, skipped: false, debugInfo };
  } finally {
    try {
      if (context) await context.close();
    } catch (_) {}
    try {
      await browser.close();
    } catch (_) {}
    releaseMutex();
  }
}

module.exports = {
  capturarPontosOS,
  garantirSessao,
  coletarOsEmExecucao,
  // expostos pra testes unitários
  _internal: { parseEntrega814, parseEntrega767, ponto1Bate767 },
};
