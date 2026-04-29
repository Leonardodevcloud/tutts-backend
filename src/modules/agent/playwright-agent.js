/**
 * playwright-agent.js
 * Automação RPA: corrige endereço de um ponto numa OS do sistema externo.
 * Sistema: tutts.com.br/expresso
 *
 * Seletores mapeados do HTML real:
 *   Aba Execução : #pills-em-execucao-tab
 *   Select Tipo  : #search-type (custom-select)
 *   Autocomplete : .ui-menu-item .ui-menu-item-wrapper (jQuery UI)
 *   Botão END.   : button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="<OS>"]
 *   Botão Corrigir: .btn-corrigir-endereco[data-ponto="${ponto}"]
 *   Input Lat     : input[placeholder="Latitude"]
 *   Input Lon     : input[placeholder="Longitude"]
 *   Validar       : button.btn-validar-endereco
 *   Confirmar     : button.btn-confirmar-alteracao
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');
// 2026-04 egress-fix: bloqueia trackers externos quando BLOCK_TRACKERS=1
const { aplicarBloqueio } = require('../../shared/network-blocker');

// getSessionFile() pode ser sobrescrito via setOverrides (usado pelo agent-pool
// quando há múltiplas contas com 1 sessão por slot).
const SESSION_FILE_DEFAULT = '/tmp/tutts-rpa-session.json';

let _sessionFileOverride = null;
let _credentialsOverride = null;

function getSessionFile() {
  return _sessionFileOverride || SESSION_FILE_DEFAULT;
}

function setOverrides(opts) {
  _sessionFileOverride = (opts && opts.sessionFile) || null;
  _credentialsOverride = (opts && opts.credentials) || null;
}

function clearOverrides() {
  _sessionFileOverride = null;
  _credentialsOverride = null;
}

const SCREENSHOT_DIR = '/tmp/screenshots';
const TIMEOUT        = 25000;
// Timeout mais largo só para page.goto() — navegação pro sistema externo
// pode ter picos de latência e 25s sem margem derrubava jobs
const NAV_TIMEOUT    = 45000;

const LOGIN_URL = () => process.env.SISTEMA_EXTERNO_URL;
const ACOMP_URL = () =>
  process.env.SISTEMA_EXTERNO_ACOMPANHAMENTO_URL ||
  'https://tutts.com.br/expresso/expressoat/acompanhamento-servicos';

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function log(msg) {
  logger.info(`[playwright-agent] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Gestão de recursos: watchdog de promises + fechamento seguro de browser
// Mesmo padrão usado em playwright-sla-capture.js — evita Chromium zombie
// que leva a "pthread_create: Resource temporarily unavailable" em containers
// ─────────────────────────────────────────────────────────────────────────
function comTimeout(promise, ms, nome) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${nome}: timeout após ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fecha browser de forma robusta: tenta close() gracioso com timeout curto,
 * e se pendurar, mata o processo subjacente via SIGKILL.
 * Nunca lança — sempre retorna, para não mascarar o erro original.
 */
async function fecharBrowserSeguro(browser) {
  if (!browser) return;
  try {
    await comTimeout(browser.close(), 5_000, 'browser.close');
  } catch (e) {
    log(`⚠️ browser.close() pendurou: ${e.message} — SIGKILL`);
    try {
      const proc = browser.process && browser.process();
      if (proc && typeof proc.kill === 'function') {
        proc.kill('SIGKILL');
        log(`💀 Chromium pid=${proc.pid} morto via SIGKILL`);
      }
    } catch (e2) {
      log(`⚠️ Falha no kill: ${e2.message}`);
    }
  }
}

/**
 * Limpa screenshots antigos em /tmp/screenshots (> SCREENSHOT_MAX_AGE_MS).
 * Roda best-effort; não bloqueia o fluxo principal se falhar.
 */
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const SCREENSHOT_MAX_FILES  = 200; // teto absoluto por segurança

function limparScreenshotsAntigos() {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) return;
    const agora = Date.now();
    const arquivos = fs.readdirSync(SCREENSHOT_DIR)
      .map(nome => {
        const full = path.join(SCREENSHOT_DIR, nome);
        try {
          const st = fs.statSync(full);
          return { nome, full, mtime: st.mtimeMs, size: st.size };
        } catch { return null; }
      })
      .filter(Boolean);

    let removidos = 0;
    // 1. Remove por idade
    for (const f of arquivos) {
      if (agora - f.mtime > SCREENSHOT_MAX_AGE_MS) {
        try { fs.unlinkSync(f.full); removidos++; } catch {}
      }
    }
    // 2. Se ainda sobrar muito arquivo, remove os mais antigos
    const restantes = arquivos.filter(f => agora - f.mtime <= SCREENSHOT_MAX_AGE_MS)
      .sort((a, b) => a.mtime - b.mtime);
    if (restantes.length > SCREENSHOT_MAX_FILES) {
      const excesso = restantes.slice(0, restantes.length - SCREENSHOT_MAX_FILES);
      for (const f of excesso) {
        try { fs.unlinkSync(f.full); removidos++; } catch {}
      }
    }
    if (removidos > 0) log(`🧹 ${removidos} screenshot(s) antigo(s) removido(s)`);
  } catch (e) {
    log(`⚠️ Falha ao limpar screenshots: ${e.message}`);
  }
}

async function screenshot(page, os, etapa) {
  // 2026-04 egress-fix: skip se SCREENSHOTS_ENABLED=0
  if (process.env.SCREENSHOTS_ENABLED === '0' ||
      process.env.SCREENSHOTS_ENABLED === 'false') {
    return null;
  }
  const file = path.join(SCREENSHOT_DIR, `OS${os}_${etapa}_${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); } catch (_) {}
  log(`📸 ${path.basename(file)}`);
  return path.basename(file);
}

// ─────────────────────────────────────────────────────────────────────────
// Resumo Serviço — fetch direto no endpoint AJAX (~300ms vs ~25s via UI)
// URL descoberta via SLA Monitor extension v7.7
// ─────────────────────────────────────────────────────────────────────────
const URL_RESUMO_SERVICO = 'https://tutts.com.br/expresso/expressoat/entregasStatus/ajaxModalInformacoesServico.php';

function parseResumoHTML(html) {
  if (!html || typeof html !== 'string') {
    return { km: null, valor_servico: null, valor_profissional: null };
  }
  const mKm = html.match(/Dist[aâ]ncia\s*rota[:\s]*(\d+[.,]?\d*)/i);
  const km = mKm ? mKm[1].replace(',', '.') : null;

  const mServ = html.match(/Valor\s*(?:deste|do)\s*servi[çc]o[:\s]*(\d+[.,]?\d*)/i);
  const valorServico = mServ ? mServ[1].replace(',', '.') : null;

  const mProf = html.match(/Valor\s*do\s*profissional[:\s]*(\d+[.,]?\d*)/i);
  const valorProf = mProf ? mProf[1].replace(',', '.') : null;

  return { km, valor_servico: valorServico, valor_profissional: valorProf };
}

/**
 * Captura o atributo data-parameters do botão "Resumo Serviço" da row de uma OS.
 * Esse parametro é o que o backend PHP precisa pra retornar o HTML do modal.
 */
async function capturarParametroResumo(page, btnLocator) {
  try {
    const rowOS = page.locator('tr').filter({ has: btnLocator }).first();
    const parametro = await rowOS.evaluate((row) => {
      const link = row.querySelector('a.dropdown-item[data-action="ajaxModalInformacoesServico"], [data-action="ajaxModalInformacoesServico"]');
      if (!link) return null;
      return link.getAttribute('data-parameters') || link.getAttribute('data-parameter') || null;
    });
    return parametro || null;
  } catch (_) {
    return null;
  }
}

/**
 * Faz fetch direto no endpoint AJAX do MAP usando o cookie de sessão da page.
 * Retorna { km, valor_servico, valor_profissional } parseados do HTML do modal.
 */
async function fetchResumoServico(page, parametro) {
  if (!parametro) {
    return { km: null, valor_servico: null, valor_profissional: null, _erro: 'sem_parametro' };
  }
  try {
    const html = await page.evaluate(async ({ url, param }) => {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: 'parametro=' + encodeURIComponent(param),
          credentials: 'include',
        });
        if (!r.ok) return { __erro: 'http_' + r.status };
        return { __html: await r.text() };
      } catch (e) {
        return { __erro: 'fetch_' + e.message };
      }
    }, { url: URL_RESUMO_SERVICO, param: parametro });

    if (html.__erro) {
      return { km: null, valor_servico: null, valor_profissional: null, _erro: html.__erro };
    }
    const parsed = parseResumoHTML(html.__html);
    return parsed;
  } catch (e) {
    return { km: null, valor_servico: null, valor_profissional: null, _erro: 'evaluate_' + e.message };
  }
}

async function isLoggedIn(page) {
  const url = page.url();
  if (!url.includes('/expresso') || url.includes('loginFuncionarioNovo')) return false;
  // Validar presença de elemento real da página (não só URL)
  try {
    await page.locator('#pills-em-execucao-tab, #search-type, button.btn-modal').first().waitFor({ state: 'visible', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function fazerLogin(page, overrides) {
  const email = (overrides && overrides.email) || process.env.SISTEMA_EXTERNO_EMAIL;
  const senha = (overrides && overrides.senha) || process.env.SISTEMA_EXTERNO_SENHA;

  if (!email || !senha) {
    throw new Error('SISTEMA_EXTERNO_EMAIL / SISTEMA_EXTERNO_SENHA não configuradas.');
  }

  log(`🔐 Login (${overrides ? 'override' : 'env padrão'}): ${email}`);

  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    const ss = await screenshot(page, 'login', 'pagina_nao_carregou');
    throw new Error(`Página de login não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
  }

  await page.fill('#loginEmail', email);
  await page.fill('input[type="password"]', senha);

  // type="button" com name="logar" (não é submit!)
  await page.locator('input[name="logar"]').first().click();

  // Aguardar sair da página de login
  await page.waitForURL(
    url => !url.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log(`✅ Login OK — URL: ${page.url()}`);
}

async function executarCorrecaoEndereco({ os_numero, ponto, latitude, longitude, cod_profissional, onProgresso }) {
  // onProgresso(etapa, percentual) — callback opcional chamado em marcos significativos
  // para reportar avanço ao frontend via banco. Etapas: login, localizando, codificando,
  // confirmando, recalculando, finalizando. Percentual: 0-100.
  // Se não passado, é no-op — mantém compatibilidade com chamadores antigos.
  const reportar = typeof onProgresso === 'function'
    ? (etapa, pct) => { try { onProgresso(etapa, pct); } catch (_) {} }
    : () => {};
  if (!process.env.SISTEMA_EXTERNO_URL) {
    return { sucesso: false, erro: 'SISTEMA_EXTERNO_URL não configurada.' };
  }
  if (ponto === 1) {
    return { sucesso: false, erro: 'Segurança: Ponto 1 nunca pode ser alterado.' };
  }

  // Limpeza de screenshots antigos a cada execução (fire-and-forget, não bloqueia)
  setImmediate(limparScreenshotsAntigos);

  log(`🚀 OS ${os_numero} | Ponto ${ponto} | ${latitude}, ${longitude}`);

  // IMPORTANTE: declaramos browser/context/page ANTES do try, mas só inicializamos DENTRO dele.
  // Motivo: se `chromium.launch()`, `browser.newContext()` ou `context.newPage()` falhar,
  // o `finally` precisa ter acesso a essas variáveis pra fechar o que foi criado.
  // Antes do fix, browser era criado com `const browser = await chromium.launch()` FORA do try,
  // e uma falha em newContext/newPage deixava o Chromium zumbi no sistema.
  let browser = null;
  let context = null;
  let page = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
        '--no-first-run',
      ],
    });

    let contextOptions = {};
    if (fs.existsSync(getSessionFile())) {
      contextOptions = { storageState: getSessionFile() };
      log('♻️  Usando sessão salva');
    }

    context = await browser.newContext({
      ...contextOptions,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    // 2026-04 egress-fix: bloqueia trackers externos (Facebook, GA, etc)
    await aplicarBloqueio(context, 'agent-correcao');

    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // ── Passo 1: Autenticação + ir para acompanhamento ───────────────────────
    log('📌 Passo 1: Autenticação');
    reportar('login', 15);

    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(2000);

    if (!(await isLoggedIn(page))) {
      if (fs.existsSync(getSessionFile())) {
        fs.unlinkSync(getSessionFile());
        log('🗑️  Sessão inválida removida');
      }
      await fazerLogin(page, _credentialsOverride);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(2000);
      await context.storageState({ path: getSessionFile() });
      log('💾 Sessão salva');
    } else {
      log('✅ Já logado');
    }


    // ── Passo 1b: Garantir que está na aba "Em execução" ────────────────────
    log('📌 Passo 1b: Clicando na aba "Em execução"');
    const abaEmExecucao = page.locator('#pills-em-execucao-tab');
    const abaVisivel = await abaEmExecucao.isVisible().catch(() => false);
    if (abaVisivel) {
      await abaEmExecucao.click();
      await page.waitForTimeout(800);
      log('✅ Aba "Em execução" selecionada');
    }

    // ── Passo 2: Localizar botão END. da OS ────────────────────────────────
    log(`📌 Passo 2: Localizando OS ${os_numero}`);
    reportar('localizando', 30);

    const btnSelector = `button.btn-modal[data-action="funcaoEnderecoServico"][data-id="${os_numero}"], button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="${os_numero}"]`;

    // Tentativa 1: botão existe no DOM na aba "Em execução" (pode não estar visível no viewport)
    let btnCount = await page.locator(btnSelector).count();
    log(`🔎 Botão END. encontrado no DOM: ${btnCount > 0 ? 'SIM' : 'NÃO'} (count: ${btnCount})`);

    if (btnCount === 0) {
      // Debug: capturar HTML dos botões btn-modal existentes na página
      const allBtnModals = await page.locator('button.btn-modal').count();
      log(`🔎 Debug: Total de button.btn-modal na página: ${allBtnModals}`);
      
      // Debug: procurar botões com funcaoEnderecoServico especificamente
      const btnEndAll = await page.locator('button.btn-modal[data-action="funcaoEnderecoServico"]').count();
      log(`🔎 Debug: Botões funcaoEnderecoServico: ${btnEndAll}`);
      if (btnEndAll > 0) {
        const endHtml = await page.locator('button.btn-modal[data-action="funcaoEnderecoServico"]').first().evaluate(el => el.outerHTML);
        log(`🔎 Debug: Botão END HTML: ${endHtml.substring(0, 400)}`);
      } else if (allBtnModals > 0) {
        // Listar todos os data-action únicos para entender a estrutura
        const actions = await page.locator('button.btn-modal').evaluateAll(els => 
          [...new Set(els.map(el => `${el.getAttribute('data-action')}|id=${el.getAttribute('data-id')}|text-id=${el.getAttribute('data-text-id')}`))].slice(0, 5)
        );
        log(`🔎 Debug: Ações dos btn-modal: ${JSON.stringify(actions)}`);
      }

      log('🔍 Botão não encontrado no DOM — usando pesquisa...');

      // Clicar na barra "Pesquisar serviços" para expandir
      const barraPesquisa = page.locator('text=Pesquisar serviços').first();
      const barraVisivel = await barraPesquisa.isVisible().catch(() => false);
      if (barraVisivel) {
        await barraPesquisa.click();
        await page.waitForTimeout(500);
        log('✅ Barra de pesquisa expandida');
      }

      // Selecionar "Serviço" no select #search-type (classe custom-select)
      const selectPesquisa = page.locator('#search-type');
      const selectVisivel = await selectPesquisa.isVisible().catch(() => false);
      if (selectVisivel) {
        await selectPesquisa.selectOption({ label: 'Serviço' });
        await page.waitForTimeout(500);
        log('✅ Tipo de pesquisa: Serviço');
      }

      // Preencher número da OS no campo de busca
      const inputBusca = page.locator('#search-autocomplete-input, input[placeholder*="número do serviço"]').first();
      let inputVisivel = false;
      try {
        await inputBusca.waitFor({ state: 'visible', timeout: 8000 });
        inputVisivel = true;
      } catch { inputVisivel = false; }
      
      if (!inputVisivel) {
        // Sessão pode ter expirado — forçar re-login
        log('⚠️ Campo de busca não apareceu — forçando re-login...');
        if (fs.existsSync(getSessionFile())) {
          fs.unlinkSync(getSessionFile());
          log('🗑️  Sessão removida');
        }
        await fazerLogin(page, _credentialsOverride);
        await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(2000);
        await context.storageState({ path: getSessionFile() });
        log('💾 Sessão renovada');

        // Re-clicar na aba Em execução
        const abaRetry = page.locator('#pills-em-execucao-tab');
        if (await abaRetry.isVisible().catch(() => false)) {
          await abaRetry.click();
          await page.waitForTimeout(800);
        }

        // Re-expandir pesquisa
        const barraRetry = page.locator('text=Pesquisar serviços').first();
        if (await barraRetry.isVisible().catch(() => false)) {
          await barraRetry.click();
          await page.waitForTimeout(500);
        }
        const selectRetry = page.locator('#search-type');
        if (await selectRetry.isVisible().catch(() => false)) {
          await selectRetry.selectOption({ label: 'Serviço' });
          await page.waitForTimeout(500);
        }

        // Agora sim esperar o campo de busca (timeout completo)
        await inputBusca.waitFor({ state: 'visible', timeout: TIMEOUT });
        log('✅ Campo de busca visível após re-login');
      }

      await inputBusca.fill(String(os_numero));
      await page.waitForTimeout(1500); // Aguardar jQuery UI autocomplete carregar

      // Clicar no item do autocomplete (jQuery UI: .ui-menu-item-wrapper)
      const autoItem = page.locator('.ui-menu-item .ui-menu-item-wrapper').filter({ hasText: String(os_numero) }).first();
      const autoVisivel = await autoItem.isVisible().catch(() => false);

      if (autoVisivel) {
        await autoItem.click();
        log('✅ Item do autocomplete clicado');
      } else {
        // Fallback: tentar qualquer .ui-menu-item visível
        const anyAutoItem = page.locator('.ui-menu-item-wrapper:visible').first();
        const anyVisivel = await anyAutoItem.isVisible().catch(() => false);
        if (anyVisivel) {
          await anyAutoItem.click();
          log('✅ Primeiro item do autocomplete clicado (fallback)');
        } else {
          log('⚠️ Autocomplete não encontrado — tentando Enter');
          await inputBusca.press('Enter');
        }
      }

      await page.waitForTimeout(2000); // Aguardar resultado carregar

      // Aguardar botão END. aparecer no DOM após busca (não precisa estar visível)
      await page.waitForSelector(
        `button.btn-modal[data-action="funcaoEnderecoServico"][data-id="${os_numero}"], button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="${os_numero}"]`,
        { state: 'attached', timeout: TIMEOUT }
      );
    }

    // Scroll até o botão para garantir que está visível no viewport
    const btnEnd = page.locator(btnSelector).first();
    await btnEnd.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // ── Passo 2a: Validar que a OS está Em Execução (não concluída/cancelada) ──
    log('📌 Passo 2a: Verificando status da OS');
    try {
      const statusOS = await btnEnd.evaluate((btn) => {
        // Subir até a <tr> da OS
        const row = btn.closest('tr');
        if (!row) return 'desconhecido';

        // Verificar classes da row
        const classes = row.className || '';
        if (classes.includes('osConcluidaHoje') || classes.includes('Concluida') || classes.includes('concluida')) return 'concluida';
        if (classes.includes('osCancelada') || classes.includes('Cancelada') || classes.includes('cancelada')) return 'cancelada';
        if (classes.includes('osEmExecucao') || classes.includes('EmExecucao') || classes.includes('emExecucao')) return 'em_execucao';

        // Verificar a seção pai (div com texto "Serviço(s) concluído(s)" ou "Em execução")
        let parent = row.parentElement;
        while (parent) {
          const prevSibling = parent.previousElementSibling;
          if (prevSibling) {
            const txt = (prevSibling.textContent || '').toLowerCase();
            if (txt.includes('concluíd') || txt.includes('concluid')) return 'concluida';
            if (txt.includes('cancelad')) return 'cancelada';
            if (txt.includes('em execução') || txt.includes('em execucao')) return 'em_execucao';
          }
          // Também verificar o próprio parent
          const parentTxt = (parent.className || '').toLowerCase();
          if (parentTxt.includes('conclu')) return 'concluida';
          if (parentTxt.includes('cancel')) return 'cancelada';
          parent = parent.parentElement;
        }
        return 'em_execucao'; // default se não conseguiu identificar
      }).catch(() => 'desconhecido');

      log(`📋 Status da OS: ${statusOS}`);

      if (statusOS === 'concluida') {
        const ss = await screenshot(page, os_numero, 'passo2a_os_concluida');
        // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
        return {
          sucesso: false,
          erro: `[Validação] A OS ${os_numero} já está concluída/finalizada no sistema. Apenas OS em execução podem ter o endereço corrigido.`,
          screenshot: ss,
        };
      }

      if (statusOS === 'cancelada') {
        const ss = await screenshot(page, os_numero, 'passo2a_os_cancelada');
        // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
        return {
          sucesso: false,
          erro: `[Validação] A OS ${os_numero} está cancelada. Não é possível corrigir endereço de OS cancelada.`,
          screenshot: ss,
        };
      }
    } catch (e) {
      log(`⚠️ Não foi possível verificar status da OS: ${e.message} — prosseguindo`);
    }

    // ── Passo 2b: Validar que o profissional da OS confere com quem solicitou ──
    if (cod_profissional) {
      log(`📌 Passo 2b: Validando profissional (cod: ${cod_profissional})`);
      try {
        // Localizar na row da OS o botão que contém data-motoboy ou o texto do profissional
        const rowOS = page.locator(`tr`).filter({ has: btnEnd }).first();
        
        // Tentar pegar data-motoboy do botão de profissional na mesma row
        const motoboyNaOS = await rowOS.evaluate((row, codProf) => {
          // Buscar botão com data-motoboy
          const btnMotoboy = row.querySelector('button[data-motoboy]');
          if (btnMotoboy) {
            return btnMotoboy.getAttribute('data-motoboy') || '';
          }
          // Fallback: procurar texto que contenha o código do profissional
          const textos = row.querySelectorAll('td, span, button');
          for (const el of textos) {
            const txt = (el.textContent || '').trim();
            if (txt.includes(String(codProf))) return String(codProf);
          }
          return '';
        }, cod_profissional).catch(() => '');

        if (motoboyNaOS) {
          const codLimpo = String(cod_profissional).trim();
          if (!motoboyNaOS.includes(codLimpo)) {
            const ss = await screenshot(page, os_numero, 'passo2b_motoboy_divergente');
            // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
            return {
              sucesso: false,
              erro: `[Segurança] O profissional que solicitou (cód. ${codLimpo}) não corresponde ao profissional vinculado à OS ${os_numero} (cód. ${motoboyNaOS}). Correção não autorizada.`,
              screenshot: ss,
            };
          }
          log(`✅ Profissional validado: ${motoboyNaOS}`);
        } else {
          log('⚠️ Não foi possível extrair código do profissional da OS — prosseguindo');
        }
      } catch (e) {
        log(`⚠️ Erro na validação do profissional: ${e.message} — prosseguindo`);
      }
    }

    // ── Passo 2c: Capturar valores ANTES via fetch direto (otimizado) ──
    // Usa o endpoint AJAX descoberto na extensão SLA Monitor v7.7 — pula
    // dropdown/modal/screenshot, fica em ~300ms em vez de ~8s.
    let valoresAntes = { km: null, valor_servico: null, valor_profissional: null };
    let parametroResumoOS = null;
    try {
      log('📌 Passo 2c: Capturando valores antigos (fetch direto)');
      parametroResumoOS = await capturarParametroResumo(page, btnEnd);
      log(`📌 [2c] data-parameters: ${parametroResumoOS || '(não encontrado)'}`);

      if (parametroResumoOS) {
        valoresAntes = await fetchResumoServico(page, parametroResumoOS);
        log(`📊 ANTES: km=${valoresAntes.km} | serviço=R$${valoresAntes.valor_servico} | profissional=R$${valoresAntes.valor_profissional}${valoresAntes._erro ? ' | ERRO: ' + valoresAntes._erro : ''}`);
      } else {
        // Fallback: fluxo UI antigo (caso a row não tenha o link de resumo no DOM)
        log('⚠️ [2c] Sem data-parameters — fallback para fluxo UI');
        const rowOS = page.locator('tr').filter({ has: btnEnd }).first();
        const dropdownBtn = rowOS.locator('button.dropdown-toggle, button#dropdownMenuButton').first();
        const temDropdown = await dropdownBtn.count().catch(() => 0);
        if (temDropdown > 0) {
          await dropdownBtn.scrollIntoViewIfNeeded().catch(() => {});
          await dropdownBtn.click();
          await page.waitForTimeout(500);

          const resumoLink = page.locator('a.dropdown-item[data-action="ajaxModalInformacoesServico"], a.dropdown-item:has-text("Resumo Serviço"), a.dropdown-item:has-text("Resumo do Serviço")').first();
          const temResumo = await resumoLink.count().catch(() => 0);

          if (temResumo > 0) {
            // Re-tentar capturar o parametro agora que o dropdown abriu
            parametroResumoOS = await resumoLink.getAttribute('data-parameters').catch(() => null);
            log(`📌 [2c] data-parameters (após dropdown): ${parametroResumoOS || '(ainda não)'}`);
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(300);

            if (parametroResumoOS) {
              valoresAntes = await fetchResumoServico(page, parametroResumoOS);
              log(`📊 ANTES (fallback): km=${valoresAntes.km} | serviço=R$${valoresAntes.valor_servico} | profissional=R$${valoresAntes.valor_profissional}`);
            }
          }
        }
      }
    } catch (e) {
      log(`⚠️ Erro Passo 2c: ${e.message} — prosseguindo`);
    }

    // ── Passo 3: Abrir modal de endereços ────────────────────────────────────
    log('📌 Passo 3: Abrindo modal de endereços');
    await btnEnd.click({ force: true });

    // Aguardar modal abrir
    await page.waitForSelector('.modal.show, .modal.in, #modalPadrao.show, #modalPadrao.in', {
      state: 'visible',
      timeout: TIMEOUT,
    });

    await page.waitForTimeout(800);

    // ── Passo 3b: Verificar se o ponto solicitado existe na OS ───────────────
    log(`📌 Passo 3b: Verificando se Ponto ${ponto} existe na OS`);
    const pontoExiste = await page.locator(`.btn-corrigir-endereco[data-ponto="${ponto}"]`).count().catch(() => 0);
    
    if (pontoExiste === 0) {
      // Contar quantos pontos a OS realmente tem
      const totalPontos = await page.locator('.btn-corrigir-endereco').count().catch(() => 0);
      const pontosDisponiveis = await page.locator('.btn-corrigir-endereco').evaluateAll(els => 
        els.map(el => el.getAttribute('data-ponto')).filter(Boolean)
      ).catch(() => []);
      
      const ss = await screenshot(page, os_numero, 'passo3b_ponto_inexistente');
      // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
      return {
        sucesso: false,
        erro: `[Validação] O Ponto ${ponto} não existe nesta OS. A OS ${os_numero} possui apenas ${totalPontos} ponto(s) corrigível(is)${pontosDisponiveis.length > 0 ? ` (pontos: ${pontosDisponiveis.join(', ')})` : ''}. Verifique o ponto correto e tente novamente.`,
        screenshot: ss,
      };
    }
    log(`✅ Ponto ${ponto} encontrado na OS`);

    // Capturar endereço antigo do ponto ANTES de clicar em Corrigir
    let enderecoAntigo = '';
    let ponto1Info = { lat: null, lng: null, endereco: '' };

    // Capturar coordenadas e endereço do Ponto 1
    try {
      ponto1Info = await page.evaluate(() => {
        const btn1 = document.querySelector('.btn-corrigir-endereco[data-ponto="1"]');
        if (!btn1) return { lat: null, lng: null, endereco: '' };
        const lat = parseFloat(btn1.getAttribute('data-lat'));
        const lon = parseFloat(btn1.getAttribute('data-lon'));
        const idEnd = btn1.getAttribute('data-id-endereco');
        let endereco = '';
        if (idEnd) {
          const span = document.getElementById('end-antigo-' + idEnd);
          if (span) endereco = (span.textContent || '').trim();
        }
        return {
          lat: isNaN(lat) ? null : lat,
          lng: isNaN(lon) ? null : lon,
          endereco: endereco || '',
        };
      }).catch(() => ({ lat: null, lng: null, endereco: '' }));
      if (ponto1Info.lat) log('Ponto 1 capturado: ' + ponto1Info.lat + ', ' + ponto1Info.lng + ' — ' + ponto1Info.endereco);
    } catch (e) {
      log('Ponto 1 nao capturado: ' + e.message);
    }

    try {
      // HTML exato: <span id="end-antigo-{idEndereco}"> contém o endereço antigo
      // O botão tem data-id-endereco="{idEndereco}" e data-ponto="{N}"
      enderecoAntigo = await page.evaluate((pontoNum) => {
        const btn = document.querySelector(`.btn-corrigir-endereco[data-ponto="${pontoNum}"]`);
        if (!btn) return '';

        const idEndereco = btn.getAttribute('data-id-endereco');

        // Estratégia 1: span#end-antigo-{id} (o conteúdo pode estar display:none mas textContent funciona)
        if (idEndereco) {
          const span = document.getElementById(`end-antigo-${idEndereco}`);
          if (span) {
            const txt = (span.textContent || '').trim();
            if (txt.length > 5) return txt;
          }
        }

        // Estratégia 2: O endereço está como texto direto no container pai, antes do botão
        // Estrutura: "📍 Ponto N [ENDEREÇO] PEC Nº nota: XXXXX [Botão Corrigir]"
        // Subir até o div que contém todo o bloco do ponto
        let container = btn.parentElement;
        while (container && !container.textContent.includes('Ponto')) {
          container = container.parentElement;
          if (container && container.classList.contains('modal-body')) break;
        }
        if (container) {
          // Pegar o texto completo do bloco e extrair o endereço
          const fullText = container.textContent || '';
          // O endereço vem depois de "Ponto N " e antes de "PEC" ou "Corrigir"
          const regexEnd = /Ponto\s*\d+\s*([\s\S]*?)(?:PEC|Corrigir|$)/i;
          const match = fullText.match(regexEnd);
          if (match) {
            const addr = match[1].replace(/\s+/g, ' ').trim();
            if (addr.length > 10) return addr.substring(0, 300);
          }
        }

        return '';
      }, ponto).catch(() => '');

      if (enderecoAntigo) {
        log(`📍 Endereço antigo Ponto ${ponto}: ${enderecoAntigo}`);
      } else {
        log('⚠️ Endereço antigo não capturado');
      }
    } catch (e) {
      log(`⚠️ Erro ao capturar endereço antigo: ${e.message}`);
    }

    // ── Passo 4: Clicar em Corrigir no ponto específico ──────────────────────
    log(`📌 Passo 4: Corrigindo Ponto ${ponto}`);

    // Configurar handler para dialogs do navegador (confirm/alert)
    // O sistema pode pedir confirmação em qualquer passo
    page.on('dialog', async (dialog) => {
      log(`💬 Dialog detectado: "${dialog.message()}" — aceitando`);
      await dialog.accept();
    });

    await page.click(`.btn-corrigir-endereco[data-ponto="${ponto}"]`);
    await page.waitForTimeout(800);

    // Verificar se o form de correção abriu (inputs de lat/lng devem estar visíveis)
    const formAbriu = await page.locator('input[placeholder="Latitude"]:visible').count().catch(() => 0);
    if (formAbriu === 0) {
      // Tentar clicar novamente
      log('⚠️ Form não abriu, tentando clicar novamente...');
      await page.click(`.btn-corrigir-endereco[data-ponto="${ponto}"]`);
      await page.waitForTimeout(1000);
    }

    // ── Passo 5: Preencher lat/lng e validar ─────────────────────────────────
    log('📌 Passo 5: Preenchendo coordenadas');
    reportar('codificando', 55);

    const inputLat = page.locator('input[placeholder="Latitude"]:visible').first();
    const inputLon = page.locator('input[placeholder="Longitude"]:visible').first();

    await inputLat.waitFor({ state: 'visible', timeout: TIMEOUT });
    await inputLon.waitFor({ state: 'visible', timeout: TIMEOUT });

    // Limpar e preencher — triple click + fill para garantir
    await inputLat.click({ clickCount: 3 });
    await inputLat.fill('');
    await inputLat.type(String(latitude), { delay: 50 });
    
    await inputLon.click({ clickCount: 3 });
    await inputLon.fill('');
    await inputLon.type(String(longitude), { delay: 50 });

    // Verificar que os valores foram preenchidos
    const latPreenchido = await inputLat.inputValue().catch(() => '');
    const lonPreenchido = await inputLon.inputValue().catch(() => '');
    log(`📍 Lat preenchido: "${latPreenchido}" | Lon preenchido: "${lonPreenchido}"`);

    if (!latPreenchido || !lonPreenchido) {
      const ss = await screenshot(page, os_numero, 'passo5_inputs_vazios');
      // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
      return {
        sucesso: false,
        erro: `Falha ao preencher coordenadas. Lat: "${latPreenchido}", Lon: "${lonPreenchido}"`,
        screenshot: ss,
      };
    }

    // Clicar em Validar
    const btnValidar = page.locator('button.btn-validar-endereco:visible').first();
    await btnValidar.waitFor({ state: 'visible', timeout: TIMEOUT });
    await btnValidar.click();
    log('📌 Botão Validar clicado, aguardando geocoder...');

    // Aguardar geocoder — esperar botão Confirmar aparecer (com polling)
    let confirmarVisivel = false;
    let jaCorrigidoAntes = false;
    for (let tentativa = 0; tentativa < 10; tentativa++) {
      await page.waitForTimeout(700);

      // Detectar alerta "Este endereço já foi corrigido anteriormente"
      jaCorrigidoAntes = await page.evaluate(() => {
        const alertas = document.querySelectorAll('.alert-danger, .alert-warning');
        for (const a of alertas) {
          const txt = (a.textContent || '').toLowerCase();
          if (txt.includes('já foi corrigido') || txt.includes('ja foi corrigido') || txt.includes('corrigido anteriormente')) {
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (jaCorrigidoAntes) break;

      confirmarVisivel = await page.locator('button.btn-confirmar-alteracao:visible').isVisible().catch(() => false);
      if (confirmarVisivel) break;
    }
    

    // Se endereço já foi corrigido anteriormente — abortar com erro específico
    if (jaCorrigidoAntes) {
      const ss = await screenshot(page, os_numero, 'passo5_ja_corrigido');
      log('⚠️ Endereço já foi corrigido anteriormente no sistema externo');
      // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
      return {
        sucesso: false,
        erro: 'ENDERECO_JA_CORRIGIDO',
        detalhe: 'Este endereço já foi corrigido anteriormente no sistema. Por favor, refaça a solicitação diretamente com o suporte Tutts.',
        screenshot: ss,
      };
    }

    if (!confirmarVisivel) {
      const ss = await screenshot(page, os_numero, 'passo5_geocoder_vazio');
      // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
      return {
        sucesso: false,
        erro: `Coordenadas (${latitude}, ${longitude}) não reconhecidas pelo geocoder. Botão Confirmar não apareceu após 10s.`,
        screenshot: ss,
      };
    }
    log('✅ Geocoder OK — botão Confirmar visível');

    // Capturar endereço resolvido pelo geocoder (bônus)
    let enderecoResolvido = '';
    try {
      enderecoResolvido = await page.evaluate(() => {
        const btnConfirmar = document.querySelector('.btn-confirmar-alteracao');
        if (!btnConfirmar) return '';
        const container = btnConfirmar.closest('.card-body') || btnConfirmar.closest('div') || btnConfirmar.parentElement;
        if (!container) return '';
        const els = container.querySelectorAll('p, span, div, small, strong');
        for (const el of els) {
          const txt = (el.textContent || '').trim();
          if (txt.length > 15 && txt.includes(',') &&
              !txt.includes('Latitude') && !txt.includes('Longitude') &&
              !txt.includes('Confirmar') && !txt.includes('Validar') &&
              el.children.length === 0 && el.offsetParent !== null) {
            return txt.substring(0, 300);
          }
        }
        return '';
      }).catch(() => '');
      if (enderecoResolvido) log(`📍 Endereço novo (DOM): ${enderecoResolvido}`);
    } catch (e) {
      log(`⚠️ Endereço novo não capturado do DOM: ${e.message}`);
    }

    // ── Passo 6: Confirmar alteração ─────────────────────────────────────────
    log('📌 Passo 6: Confirmando alteração de endereço');
    reportar('confirmando', 75);

    // Capturar o endereço antigo do span ANTES de confirmar (para comparar depois)
    const endAntigoSpan = await page.evaluate((pontoNum) => {
      const btn = document.querySelector(`.btn-corrigir-endereco[data-ponto="${pontoNum}"]`);
      if (!btn) return '';
      const idEnd = btn.getAttribute('data-id-endereco');
      if (!idEnd) return '';
      const span = document.getElementById(`end-antigo-${idEnd}`);
      return span ? (span.textContent || '').trim() : '';
    }, ponto).catch(() => '');

    await page.locator('button.btn-confirmar-alteracao:visible').first().click();

    // Aguardar processamento — verificar que algo mudou
    await page.waitForTimeout(1500);

    // Verificar que a confirmação realmente aplicou:
    // 1. O botão btn-confirmar-alteracao deve ter sumido
    // 2. Ou o span end-antigo mudou
    // 3. Ou apareceu mensagem de sucesso
    const confirmarAindaVisivel = await page.locator('button.btn-confirmar-alteracao:visible').isVisible().catch(() => false);
    
    if (confirmarAindaVisivel) {
      // Pode ter aparecido um dialog que não foi tratado, ou erro
      log('⚠️ Botão Confirmar ainda visível após clique — tentando novamente');
      await page.locator('button.btn-confirmar-alteracao:visible').first().click();
      await page.waitForTimeout(1500);
      
      const aindaVisivel2 = await page.locator('button.btn-confirmar-alteracao:visible').isVisible().catch(() => false);
      if (aindaVisivel2) {
        const ss = await screenshot(page, os_numero, 'passo6_confirmar_falhou');
        // [refactor] browser.close() aqui foi removido; finally faz fecharBrowserSeguro
        return {
          sucesso: false,
          erro: `Falha ao confirmar alteração. O botão "Confirmar" permanece visível após 2 tentativas. O endereço pode não ter sido alterado.`,
          screenshot: ss,
        };
      }
    }

    // Verificar se o endereço mudou comparando o span
    const endNovoSpan = await page.evaluate((pontoNum) => {
      const btn = document.querySelector(`.btn-corrigir-endereco[data-ponto="${pontoNum}"]`);
      if (!btn) return 'btn-sumiu'; // botão sumiu = form fechou = sucesso provável
      const idEnd = btn.getAttribute('data-id-endereco');
      if (!idEnd) return '';
      const span = document.getElementById(`end-antigo-${idEnd}`);
      return span ? (span.textContent || '').trim() : '';
    }, ponto).catch(() => '');

    if (endAntigoSpan && endNovoSpan && endAntigoSpan !== 'btn-sumiu' && endNovoSpan !== 'btn-sumiu' && endAntigoSpan === endNovoSpan) {
      log(`⚠️ Endereço NÃO mudou no DOM. Antes: "${endAntigoSpan}" | Depois: "${endNovoSpan}"`);
      // Não retorna erro pois pode ser que o DOM ainda não atualizou
    } else {
      log('✅ Confirmação aplicada com sucesso');
    }

    log('✅ Endereço confirmado');

    // ── Passo 7: Navegar para edição da OS ──────────────────────────────────
    log('📌 Passo 7: Abrindo página de edição da OS');

    let freteRecalculado = false;
    let valoresDepois = { km: null, valor_servico: null, valor_profissional: null };
    let enderecoParaPreencher = enderecoResolvido || '';

    try {
      // Extrair a URL de edição do link na tabela
      const urlEdicao = await page.evaluate((osNum) => {
        const links = document.querySelectorAll('a.btn-outline-primary, a[href*="editarOS"]');
        for (const link of links) {
          if ((link.textContent || '').trim().includes(osNum)) return link.href || '';
        }
        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
          if ((row.textContent || '').includes(osNum)) {
            const a = row.querySelector('a.btn-outline-primary, a[href*="editarOS"]');
            if (a) return a.href || '';
          }
        }
        return '';
      }, os_numero).catch(() => '');

      if (!urlEdicao) {
        log('⚠️ URL de edição da OS não encontrada');
        await screenshot(page, os_numero, 'passo7_url_nao_encontrada');
        throw new Error('URL_EDICAO_NAO_ENCONTRADA');
      }

      log(`📌 URL: ${urlEdicao}`);
      await page.goto(urlEdicao, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);

      // ── Passo 8: Atualizar endereço no input do ponto ───────────────────────
      log(`📌 Passo 8: Atualizando endereço do Ponto ${ponto}`);

      // O input do endereço: input#txtEnderecoE{ponto}  (ex: txtEnderecoE2, txtEnderecoE3)
      const seletorInput = `#txtEnderecoE${ponto}`;
      const inputEndereco = page.locator(seletorInput);
      const inputExiste = await inputEndereco.count().catch(() => 0);

      if (inputExiste === 0) {
        log(`⚠️ Input ${seletorInput} não encontrado na página`);
        await screenshot(page, os_numero, 'passo8_input_nao_encontrado');
        throw new Error('INPUT_ENDERECO_NAO_ENCONTRADO');
      }

      // Resolver o endereço legível via geocodificação reversa
      if (!enderecoParaPreencher || /^-?\d+\.\d+/.test(enderecoParaPreencher)) {
        // Fazer geocodificação reversa para obter endereço legível
        try {
          const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
          if (GOOGLE_API_KEY) {
            const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_API_KEY}&language=pt-BR`;
            const geoRes = await fetch(geoUrl);
            const geoData = await geoRes.json();
            if (geoData.status === 'OK' && geoData.results?.[0]) {
              enderecoParaPreencher = geoData.results[0].formatted_address;
              log(`📍 Endereço via geocode: ${enderecoParaPreencher}`);
            }
          }
        } catch (geoErr) {
          log(`⚠️ Geocode falhou: ${geoErr.message}`);
        }
      }

      if (!enderecoParaPreencher) {
        log('⚠️ Sem endereço legível para preencher — usando coordenadas');
        enderecoParaPreencher = `${latitude}, ${longitude}`;
      }

      // Scroll até o input
      await inputEndereco.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);

      // Limpar e preencher o endereço
      await inputEndereco.click({ clickCount: 3 });
      await inputEndereco.fill('');
      await inputEndereco.fill(enderecoParaPreencher);
      await page.waitForTimeout(500);

      // Verificar que preencheu
      const valorInput = await inputEndereco.inputValue().catch(() => '');
      log(`📍 Input preenchido: "${valorInput}"`);

      // ── Passo 8b: Clicar na lupa (buscar endereço) ──────────────────────────
      log('📌 Passo 8b: Clicando no botão buscar (lupa)');

      // O botão da lupa: button.buscar-endereco{ponto} com onclick n20Resquest({ponto})
      // ou button com classe btn-info dentro do input-group-btn do ponto
      const seletoresLupa = [
        `button.buscar-endereco${ponto}`,
        `button[onclick*="n20Resquest(${ponto})"]`,
        `button[onclick*="n20Resquest('${ponto}')"]`,
        `#divEndAdd${ponto} button.btn-info`,
        `#divEndereco${ponto} button.btn-info`,
        `#divRuaNumero${ponto} button.btn-info`,
      ];

      let lupaClicada = false;
      for (const sel of seletoresLupa) {
        const btn = page.locator(sel).first();
        const existe = await btn.count().catch(() => 0);
        if (existe > 0) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click();
          log(`📌 Lupa clicada: ${sel}`);
          lupaClicada = true;
          break;
        }
      }

      if (!lupaClicada) {
        // Fallback: procurar qualquer botão com fa-search próximo ao input
        const lupaFallback = await page.evaluate((pontoNum) => {
          const input = document.getElementById(`txtEnderecoE${pontoNum}`);
          if (!input) return false;
          // Subir até o form-group e procurar botão com ícone de busca
          const parent = input.closest('.form-group') || input.closest('.input-group') || input.parentElement?.parentElement;
          if (parent) {
            const btn = parent.querySelector('button.btn-info, button.buscar-endereco, button:has(.fa-search)');
            if (btn) { btn.click(); return true; }
          }
          // Procurar o próximo botão com fa-search
          const allBtns = document.querySelectorAll(`button[onclick*="n20Resquest"]`);
          for (const b of allBtns) {
            const onclick = b.getAttribute('onclick') || '';
            if (onclick.includes(String(pontoNum))) { b.click(); return true; }
          }
          return false;
        }, ponto).catch(() => false);

        if (lupaFallback) {
          log('📌 Lupa clicada via fallback JS');
          lupaClicada = true;
        } else {
          log('⚠️ Botão lupa não encontrado');
          await screenshot(page, os_numero, 'passo8b_lupa_nao_encontrada');
        }
      }

      if (lupaClicada) {
        // Aguardar busca processar
        await page.waitForTimeout(2000);

        // ── Passo 8c: Se aparecer validação/confirmação, aceitar ─────────────
        // O dialog handler já está ativo (page.on('dialog')), mas pode haver
        // botão de validar verde (btn-success validar) na tela
        log('📌 Passo 8c: Verificando validação');

        const btnValidarEndereco = page.locator('button.btn-success.validar, button.btn-success:has(.fa-check-circle-o)').first();
        const validarExiste = await btnValidarEndereco.count().catch(() => 0);

        if (validarExiste > 0) {
          const validarVisivel = await btnValidarEndereco.isVisible().catch(() => false);
          if (validarVisivel) {
            await btnValidarEndereco.click();
            log('📌 Validação aceita (botão verde)');
            await page.waitForTimeout(1000);
          }
        }

        // Verificar se apareceu split de rua/número/bairro (print 3)
        // Se checkEdit ficou true, o sistema já validou
        const checkEdit = await page.evaluate((p) => {
          const inp = document.getElementById(`checkEdit-${p}`);
          return inp ? inp.value : '';
        }, ponto).catch(() => '');

        if (checkEdit) {
          log(`📌 Endereço validado pelo sistema: ${checkEdit}`);
        }
      }

      // ── Passo 9: Calcular frete ─────────────────────────────────────────────
      log('📌 Passo 9: Calculando frete');
      reportar('recalculando', 90);

      // Aguardar spinners da lupa sumirem COMPLETAMENTE
      for (let sw = 0; sw < 15; sw++) {
        const spinnerAtivo = await page.evaluate(() => {
          const spinners = document.querySelectorAll('.fa-spinner, .fa-spin, .loading, img[src*="loading"], .spinner-border');
          for (const s of spinners) { if (s.offsetParent !== null) return true; }
          // Verificar se algum overlay está ativo
          const overlays = document.querySelectorAll('.modal-backdrop, .loading-overlay, .blockUI');
          for (const o of overlays) { if (o.offsetParent !== null) return true; }
          return false;
        }).catch(() => false);
        if (!spinnerAtivo) break;
        log('\u23f3 Spinner/loading ativo, aguardando...');
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(1000); // Folga extra após spinner sumir

      // Procurar botão Calcular — múltiplos seletores incluindo fallbacks
      const seletoresCalc = [
        '#btnCalcFreteCEN',
        '#btnCalcular',
        '#btnCalcularFrete',
        'button#btnCalcFreteCEN',
        'input#btnCalcFreteCEN',
        'input[value="Calcular"]',
        'input[value="Calcular Frete"]',
        'button:has-text("Calcular")',
        'button:has-text("Calc. Frete")',
        'a:has-text("Calcular")',
      ];

      let btnCalcEncontrado = null;
      for (const sel of seletoresCalc) {
        try {
          const btn = page.locator(sel).first();
          const existe = await btn.count().catch(() => 0);
          if (existe > 0) {
            const visivel = await btn.isVisible().catch(() => false);
            if (visivel) {
              btnCalcEncontrado = btn;
              log('\u{1f4cc} Botao Calcular encontrado: ' + sel);
              break;
            }
          }
        } catch (e) { /* seletor inválido, ignora */ }
      }

      // Fallback: buscar via JavaScript qualquer botão com texto "calcular"
      if (!btnCalcEncontrado) {
        log('\u{1f50d} Tentando fallback JS para botão Calcular...');
        const encontrouFallback = await page.evaluate(() => {
          // Procurar inputs e buttons com valor/texto "Calcular"
          const candidates = document.querySelectorAll('input[type="button"], input[type="submit"], button, a.btn');
          for (const el of candidates) {
            const texto = (el.value || el.textContent || '').toLowerCase().trim();
            if (texto.includes('calcular') && el.offsetParent !== null) {
              return { tag: el.tagName, id: el.id, value: el.value || el.textContent?.trim() };
            }
          }
          return null;
        }).catch(() => null);

        if (encontrouFallback) {
          log(`\u{1f4cc} Fallback: ${encontrouFallback.tag}#${encontrouFallback.id} "${encontrouFallback.value}"`);
          if (encontrouFallback.id) {
            btnCalcEncontrado = page.locator('#' + encontrouFallback.id).first();
          }
        }
      }

      if (btnCalcEncontrado) {
        await btnCalcEncontrado.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);

        // Verificar se está disabled
        const estaDisabled = await btnCalcEncontrado.isDisabled().catch(() => false);
        if (estaDisabled) {
          log('\u26a0\ufe0f Botão Calcular está desabilitado — tentando habilitar via JS');
          await page.evaluate(() => {
            const btns = document.querySelectorAll('#btnCalcFreteCEN, #btnCalcular, input[value="Calcular"]');
            btns.forEach(b => { b.disabled = false; b.removeAttribute('disabled'); });
          }).catch(() => {});
          await page.waitForTimeout(500);
        }

        // Clicar com retry
        for (let tentCalc = 0; tentCalc < 3; tentCalc++) {
          try {
            await btnCalcEncontrado.click({ force: true, timeout: 5000 });
            log('\u{1f4cc} Botao Calcular clicado (tentativa ' + (tentCalc + 1) + ')');
            break;
          } catch (clickErr) {
            log('\u26a0\ufe0f Clique falhou (tentativa ' + (tentCalc + 1) + '): ' + clickErr.message);
            if (tentCalc < 2) {
              // Tentar via JS direto
              await page.evaluate(() => {
                const btn = document.querySelector('#btnCalcFreteCEN') || document.querySelector('#btnCalcular') || document.querySelector('input[value="Calcular"]');
                if (btn) btn.click();
              }).catch(() => {});
              await page.waitForTimeout(1000);
            }
          }
        }

        // Aguardar cálculo — polling por valor R$ E botão Salvar
        let valorEncontrado = false;
        let salvarApareceu = false;
        for (let i = 0; i < 25; i++) {
          await page.waitForTimeout(1000);

          // Tratar dialogs que possam aparecer durante o cálculo
          const alertaVisivel = await page.locator('.swal2-popup:visible, .bootbox:visible').count().catch(() => 0);
          if (alertaVisivel > 0) {
            log('\u{1f4ac} Dialog detectado durante cálculo — aceitando');
            await page.locator('.swal2-confirm, .bootbox .btn-primary, .bootbox .btn-success').first().click().catch(() => {});
            await page.waitForTimeout(1000);
          }

          const status = await page.evaluate(() => {
            const bodyText = document.body.textContent || '';
            const temValor = !!/R\$\s*\d+[.,]\d{2}/.test(bodyText);
            const temFrete = !!/frete.*R\$/i.test(bodyText) || !!/R\$.*frete/i.test(bodyText);
            const btnSalvar = document.getElementById('btnChamarMotoboy');
            const salvarVisivel = btnSalvar && btnSalvar.offsetParent !== null;
            // Verificar spinner ainda ativo
            const spinnerAtivo = !!(document.querySelector('.fa-spinner:not([style*="display: none"])') || document.querySelector('.fa-spin'));
            return { temValor, temFrete, salvarVisivel, spinnerAtivo };
          }).catch(() => ({ temValor: false, temFrete: false, salvarVisivel: false, spinnerAtivo: false }));

          if (status.temValor || status.temFrete) valorEncontrado = true;
          if (status.salvarVisivel) { salvarApareceu = true; break; }
          if (status.spinnerAtivo && i < 20) continue; // Ainda calculando, aguardar

          if (i === 5) log('\u23f3 Aguardando calculo do frete...');
          if (i === 10) log('\u23f3 Ainda aguardando (10s)...');
          if (i === 15) log('\u23f3 Aguardando (15s)...');

          // Se não tem spinner e já passou 15s, provavelmente algo deu errado
          if (!status.spinnerAtivo && i >= 15 && !valorEncontrado) {
            log('\u26a0\ufe0f Sem spinner e sem valor após 15s — possível falha silenciosa');
            break;
          }
        }

        if (valorEncontrado) {
          log('\u{1f4b0} Valor calculado com sucesso');
        } else {
          log('\u26a0\ufe0f Valor R$ nao detectado apos polling');
          // Tentar clicar calcular de novo
          log('\u{1f501} Tentando recalcular...');
          await btnCalcEncontrado.click({ force: true }).catch(() => {});
          await page.waitForTimeout(5000);
          const retryStatus = await page.evaluate(() => {
            const temValor = !!/R\$\s*\d+[.,]\d{2}/.test(document.body.textContent || '');
            const salvarVisivel = !!(document.getElementById('btnChamarMotoboy')?.offsetParent);
            return { temValor, salvarVisivel };
          }).catch(() => ({ temValor: false, salvarVisivel: false }));
          if (retryStatus.temValor) { valorEncontrado = true; log('\u{1f4b0} Valor encontrado no retry!'); }
          if (retryStatus.salvarVisivel) salvarApareceu = true;
        }

        // ── Passo 9b: Capturar km + valor_servico dos hidden inputs ──
        // Inputs identificados via DevTools:
        //   #distanciaRota (value="6.65")
        //   #valorFrete    (value="22.5")
        // Valores brutos, sem R$/Km/vírgula brasileira — muito mais robusto
        // que parsear texto. Capturado AQUI (antes do save) porque depois do
        // save a página é redirecionada.
        try {
          const valoresEdicao = await page.evaluate(() => {
            const dist = document.getElementById('distanciaRota');
            const valor = document.getElementById('valorFrete');
            return {
              km: dist ? (dist.value || '').toString().replace(',', '.').trim() : null,
              valor_servico: valor ? (valor.value || '').toString().replace(',', '.').trim() : null,
            };
          }).catch(() => ({ km: null, valor_servico: null }));

          if (valoresEdicao.km) valoresDepois.km = valoresEdicao.km;
          if (valoresEdicao.valor_servico) valoresDepois.valor_servico = valoresEdicao.valor_servico;
          log(`📊 [9b] Capturado da edição: km=${valoresEdicao.km} | serviço=R$${valoresEdicao.valor_servico}`);
        } catch (eCap) {
          log(`⚠️ [9b] Erro capturando hidden inputs: ${eCap.message}`);
        }

        // Passo 10: Salvar alteracoes
        log('\u{1f4cc} Passo 10: Salvando alteracoes');

        if (!salvarApareceu) {
          for (let j = 0; j < 10; j++) {
            await page.waitForTimeout(1000);
            const visivel = await page.locator('#btnChamarMotoboy').isVisible().catch(() => false);
            if (visivel) { salvarApareceu = true; break; }
            if (j === 3) log('\u23f3 Aguardando botao Salvar aparecer...');
          }
        }

        if (salvarApareceu) {
          const btnSalvar = page.locator('#btnChamarMotoboy');
          await btnSalvar.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(500);
          await btnSalvar.click();
          log('\u{1f4cc} Botao Salvar clicado');

          await page.waitForTimeout(5000);

          const alertaErro = await page.locator('.alert-danger:visible, .swal2-error:visible').count().catch(() => 0);
          if (alertaErro > 0) {
            log('\u26a0\ufe0f Erro detectado ao salvar');
          } else {
            log('\u2705 Frete recalculado e alteracoes salvas!');
            freteRecalculado = true;
          }
        } else {
          log('\u26a0\ufe0f Botao Salvar (#btnChamarMotoboy) nao apareceu apos polling');
          await screenshot(page, os_numero, 'passo10_btn_salvar_ausente');
        }
      } else {
        log('\u26a0\ufe0f Botao Calcular nao encontrado');
        await screenshot(page, os_numero, 'passo9_btn_calcular_ausente');
      }
    } catch (e) {
      log(`⚠️ Erro no recálculo: ${e.message}`);
      await screenshot(page, os_numero, 'passo7_erro_recalculo').catch(() => null);
    }

    // ── Passo 11: Capturar valor_profissional via fetch direto ──
    // km e valor_servico já foram capturados no Passo 9b dos hidden inputs
    // da página de edição. Aqui só pegamos o valor_profissional, que o
    // backend AJAX retorna do banco corretamente (já confirmado em produção).
    // O valor_servico do fetch é IGNORADO porque o backend só ecoa o que
    // foi passado no parametro (que é o valor antigo).
    try {
      log('📌 Passo 11: Capturando valor_profissional (fetch direto)');

      if (parametroResumoOS) {
        // Pequeno delay pra garantir que o backend processou o save
        await page.waitForTimeout(800);

        const respFetch = await fetchResumoServico(page, parametroResumoOS);
        log(`📊 DEPOIS [fetch]: km=${respFetch.km} | serviço=R$${respFetch.valor_servico} (ignorado) | profissional=R$${respFetch.valor_profissional}${respFetch._erro ? ' | ERRO: ' + respFetch._erro : ''}`);

        // Atribui SÓ o valor_profissional (preserva km e valor_servico do Passo 9b)
        if (respFetch.valor_profissional) {
          valoresDepois.valor_profissional = respFetch.valor_profissional;
        }

        // Retry uma vez se profissional vier null E save deu certo
        if (freteRecalculado && !valoresDepois.valor_profissional) {
          log('⚠️ [11] valor_profissional vazio — retry após 1.5s');
          await page.waitForTimeout(1500);
          const retry = await fetchResumoServico(page, parametroResumoOS);
          if (retry.valor_profissional) valoresDepois.valor_profissional = retry.valor_profissional;
          log(`📊 DEPOIS (retry): profissional=R$${valoresDepois.valor_profissional}`);
        }
      } else {
        log('⚠️ [11] Sem parametroResumoOS do Passo 2c — fallback');
        // Fallback de último caso: tentar pegar o parametro recarregando a página de acompanhamento
        try {
          // Higienizar contexto se houve nova guia
          const pages = context.pages();
          if (pages.length > 1) {
            for (let i = 1; i < pages.length; i++) {
              await pages[i].close().catch(() => {});
            }
            page = context.pages()[0];
            await page.bringToFront().catch(() => {});
          }

          await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          await page.waitForTimeout(1500);

          const abaExec = page.locator('#pills-em-execucao-tab');
          if (await abaExec.isVisible().catch(() => false)) {
            await abaExec.click().catch(() => {});
            await page.waitForTimeout(1000);
          }

          // Tentar localizar o data-parameters direto na página atual (sem precisar pesquisar)
          let parametroFallback = await page.evaluate((osNum) => {
            const links = document.querySelectorAll('[data-action="ajaxModalInformacoesServico"]');
            for (const link of links) {
              const row = link.closest('tr');
              if (row && (row.textContent || '').includes(osNum)) {
                return link.getAttribute('data-parameters') || link.getAttribute('data-parameter') || null;
              }
            }
            return null;
          }, String(os_numero)).catch(() => null);

          if (parametroFallback) {
            log(`📌 [11] data-parameters via fallback: ${parametroFallback}`);
            const respFb = await fetchResumoServico(page, parametroFallback);
            if (respFb.valor_profissional) valoresDepois.valor_profissional = respFb.valor_profissional;
            log(`📊 DEPOIS (fallback): profissional=R$${valoresDepois.valor_profissional}`);
          } else {
            log('⚠️ [11] Fallback também não encontrou data-parameters');
          }
        } catch (eFb) {
          log(`⚠️ [11] Erro no fallback: ${eFb.message}`);
        }
      }
    } catch (e) {
      log(`⚠️ Erro Passo 11: ${e.message} — stack: ${e.stack?.substring(0, 200)}`);
    }

    log(`🎉 OS ${os_numero} Ponto ${ponto} — completo! Frete: ${freteRecalculado ? 'SIM' : 'NÃO'}`);
    reportar('finalizando', 100);
    return { sucesso: true, endereco_corrigido: enderecoResolvido || enderecoParaPreencher || null, endereco_antigo: enderecoAntigo || null, frete_recalculado: freteRecalculado, ponto1: ponto1Info, valores_antes: valoresAntes, valores_depois: valoresDepois || null };

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    // Screenshot com timeout — se a página estiver morta não queremos pendurar aqui
    let ss = null;
    try {
      ss = await comTimeout(
        screenshot(page, os_numero, 'erro_inesperado'),
        5_000,
        'screenshot_erro'
      );
    } catch (e) {
      log(`⚠️ Screenshot de erro falhou: ${e.message}`);
    }
    return { sucesso: false, erro: `Erro inesperado: ${err.message}`, screenshot: ss };
  } finally {
    await fecharBrowserSeguro(browser);
  }
}

module.exports = { executarCorrecaoEndereco, setOverrides, clearOverrides };
