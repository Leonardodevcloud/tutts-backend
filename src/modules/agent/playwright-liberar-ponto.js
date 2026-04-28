/**
 * playwright-liberar-ponto.js
 * Automação RPA: libera Ponto 1 de uma OS no sistema externo.
 * Reusa massa de código do playwright-agent.js (login, busca OS, screenshot).
 *
 * Fluxo:
 *   1. Login no sistema externo (conta dedicada via SISTEMA_EXTERNO_LIBERACAO_*)
 *   2. Vai pra acompanhamento-servicos
 *   3. Busca a OS pelo autocomplete (jQuery UI)
 *   4. Localiza a row da OS, clica na engrenagem (.btn-grupo-acoes ou similar)
 *   5. Clica no item "Liberar App" do dropdown
 *   6. Modal #modalPadrao abre com lista de pontos
 *   7. Marca o checkbox do "Liberar ponto 1" (primeiro input[name="liberar"])
 *   8. Clica botão "Liberar"
 *   9. Aguarda texto "Enviado" aparecer em #divRetornoModal
 *  10. Sucesso!
 *
 * Seletores baseados em inspeção do HTML real:
 *   Modal           : #modalPadrao
 *   Checkboxes      : #modalPadrao input[type="checkbox"][name="liberar"]
 *   Botão Liberar   : #modalPadrao button:has-text("Liberar"):not(:has-text("Liberar ponto"))
 *   Confirmação     : #divRetornoModal contém texto "Enviado"
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

// ── Reuso de helpers do playwright-agent.js ──────────────────────────────
// Mantemos sessão SEPARADA pra liberar-ponto (conta diferente do agent-correcao)
const SESSION_FILE_DEFAULT = '/tmp/tutts-rpa-liberacao-session.json';

let _sessionFileOverride = null;
let _credentialsOverride = null;

function getSessionFile() { return _sessionFileOverride || SESSION_FILE_DEFAULT; }
function setOverrides(opts) {
  _sessionFileOverride = (opts && opts.sessionFile) || null;
  _credentialsOverride = (opts && opts.credentials) || null;
}
function clearOverrides() { _sessionFileOverride = null; _credentialsOverride = null; }

const SCREENSHOT_DIR = '/tmp/screenshots';
const TIMEOUT        = 25000;
const NAV_TIMEOUT    = 45000;

const LOGIN_URL = () => process.env.SISTEMA_EXTERNO_URL;
const ACOMP_URL = () =>
  process.env.SISTEMA_EXTERNO_ACOMPANHAMENTO_URL ||
  'https://tutts.com.br/expresso/expressoat/acompanhamento-servicos';

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function log(msg) { logger.info(`[playwright-liberacao] ${msg}`); }

function comTimeout(promise, ms, nome) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${nome}`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

async function fecharBrowserSeguro(browser) {
  if (!browser) return;
  // 2026-04 v2: tenta close gracioso com timeout. Se pendurar, mata via SIGKILL.
  // Sem o SIGKILL, processos Chromium ficavam zumbi consumindo RAM até estourar
  // o limite do container e dar "spawn EAGAIN" nos próximos launches.
  try {
    await comTimeout(browser.close(), 5000, 'browser.close');
    return;
  } catch (e) {
    log(`⚠️ browser.close() pendurou (${e.message}) — tentando SIGKILL`);
  }
  try {
    const proc = browser.process && browser.process();
    if (proc && typeof proc.kill === 'function') {
      proc.kill('SIGKILL');
      log(`💀 Chromium pid=${proc.pid} morto via SIGKILL`);
    }
  } catch (e2) {
    log(`⚠️ SIGKILL falhou: ${e2.message}`);
  }
}

async function screenshot(page, os, etapa) {
  try {
    const filename = `OS${os}_LIB_${etapa}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false }).catch(() => {});
    log(`📸 ${filename}`);
    return filepath;
  } catch { return null; }
}

async function isLoggedIn(page) {
  try {
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1000);
    const url = page.url();
    return !url.includes('loginFuncionarioNovo') && !url.includes('login');
  } catch { return false; }
}

async function fazerLogin(page, overrides) {
  const email = (overrides && overrides.email) ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_EMAIL_1 ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_EMAIL ||
                process.env.SISTEMA_EXTERNO_EMAIL; // último fallback (compat)
  const senha = (overrides && overrides.senha) ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_SENHA_1 ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_SENHA ||
                process.env.SISTEMA_EXTERNO_SENHA;

  if (!email || !senha) {
    throw new Error('SISTEMA_EXTERNO_LIBERACAO_EMAIL_1 / SENHA_1 não configuradas.');
  }

  log(`🔐 Login (${overrides ? 'override' : 'env'}): ${email}`);
  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    const ss = await screenshot(page, 'login', 'pagina_nao_carregou');
    throw new Error(`Página de login não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
  }

  await page.fill('#loginEmail', email);
  await page.fill('input[type="password"]', senha);
  await page.locator('input[name="logar"]').first().click();

  await page.waitForURL(
    url => !url.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log(`✅ Login OK — URL: ${page.url()}`);
}

/**
 * Busca a OS no sistema externo via autocomplete da barra de pesquisa.
 * Reusa lógica de playwright-agent.js mas inline (sem import circular).
 * Retorna true se encontrou, false caso contrário.
 */
async function localizarOS(page, os_numero) {
  log(`📌 Localizando OS ${os_numero}`);

  // Garantir que estamos na aba "Em execução"
  const abaExec = page.locator('#pills-em-execucao-tab');
  if (await abaExec.isVisible().catch(() => false)) {
    await abaExec.click();
    await page.waitForTimeout(800);
  }

  // Verificar se a OS já está visível na tela atual (aba aberta)
  // Usamos um seletor que pega QUALQUER row contendo o número da OS
  const rowOS = page.locator(`tr:has-text("${os_numero}"), .row:has-text("${os_numero}")`).first();
  const jaVisivel = await rowOS.isVisible().catch(() => false);
  if (jaVisivel) {
    log('✅ OS encontrada diretamente na lista');
    return true;
  }

  // Não está visível — usa pesquisa
  log('🔍 OS não visível, usando pesquisa');

  const barraPesquisa = page.locator('text=Pesquisar serviços').first();
  if (await barraPesquisa.isVisible().catch(() => false)) {
    await barraPesquisa.click();
    await page.waitForTimeout(500);
  }

  const selectPesquisa = page.locator('#search-type');
  if (await selectPesquisa.isVisible().catch(() => false)) {
    await selectPesquisa.selectOption({ label: 'Serviço' });
    await page.waitForTimeout(500);
  }

  const inputBusca = page.locator('#search-autocomplete-input, input[placeholder*="número do serviço"]').first();
  await inputBusca.waitFor({ state: 'visible', timeout: TIMEOUT });

  await inputBusca.fill(String(os_numero));
  await page.waitForTimeout(1500);

  const autoItem = page.locator('.ui-menu-item .ui-menu-item-wrapper').filter({ hasText: String(os_numero) }).first();
  if (await autoItem.isVisible().catch(() => false)) {
    await autoItem.click();
    log('✅ Item autocomplete clicado');
    await page.waitForTimeout(2000);
    return true;
  }

  // Fallback: pressionar Enter direto
  await inputBusca.press('Enter');
  await page.waitForTimeout(2000);

  // Confirma se OS apareceu
  return await rowOS.isVisible().catch(() => false);
}

/**
 * Clica na engrenagem da row da OS e depois em "Liberar App".
 * O dropdown da engrenagem tem item "Liberar App" (visto no print).
 */
async function abrirModalLiberarApp(page, os_numero) {
  log(`⚙️  Abrindo menu engrenagem da OS ${os_numero}`);

  // Localiza a row da OS — geralmente <tr> que contém o número
  const rowSelector = `tr:has-text("${os_numero}")`;
  const row = page.locator(rowSelector).first();
  await row.waitFor({ state: 'visible', timeout: TIMEOUT });

  // Clica na engrenagem dentro dessa row
  // Padrão: button com classe contendo "btn-grupo-acoes" ou ícone de gear
  // Fallback: dropdown-toggle com data-toggle="dropdown"
  const engrenagemSelectores = [
    'button[data-toggle="dropdown"]',
    '.dropdown-toggle',
    'button:has(i.fa-cog)',
    'button:has(.fa-gear)',
    '.btn-grupo-acoes',
  ];

  let clicou = false;
  for (const sel of engrenagemSelectores) {
    const btn = row.locator(sel).last();  // last() porque pode ter outros dropdowns na row
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      clicou = true;
      log(`✅ Engrenagem clicada (${sel})`);
      break;
    }
  }
  if (!clicou) {
    const ss = await screenshot(page, os_numero, 'engrenagem_nao_achada');
    throw new Error(`Engrenagem não encontrada na row da OS. Screenshot: ${ss}`);
  }

  await page.waitForTimeout(500);

  // Clica no item "Liberar App" do dropdown
  const liberarApp = page.locator('a:has-text("Liberar App"), button:has-text("Liberar App")').first();
  await liberarApp.waitFor({ state: 'visible', timeout: 5000 });
  await liberarApp.click();
  log(`✅ "Liberar App" clicado`);

  // Aguarda modal aparecer
  await page.locator('#modalPadrao').waitFor({ state: 'visible', timeout: 10000 });
  // Aguarda conteúdo do modal carregar (lista de pontos)
  await page.locator('#modalPadrao input[type="checkbox"][name="liberar"]').first().waitFor({
    state: 'visible',
    timeout: 10000,
  });
  log(`✅ Modal "Liberar App" aberto`);
}

/**
 * Marca o checkbox do Ponto 1 e clica "Liberar".
 * Aguarda texto "Enviado" aparecer no #divRetornoModal.
 */
async function executarLiberacaoPonto1(page, os_numero) {
  log(`☑️  Marcando checkbox do Ponto 1`);

  // Estratégia robusta: pegar TODOS os checkboxes name="liberar" e clicar no primeiro
  // (modal sempre lista pontos em ordem 1, 2, 3...)
  const checkboxes = page.locator('#modalPadrao input[type="checkbox"][name="liberar"]');
  const total = await checkboxes.count();
  log(`🔎 Total de checkboxes no modal: ${total}`);

  if (total === 0) {
    const ss = await screenshot(page, os_numero, 'sem_checkbox');
    throw new Error(`Nenhum checkbox de liberação no modal. Screenshot: ${ss}`);
  }

  const checkboxPonto1 = checkboxes.first();
  // Confirma que é mesmo do Ponto 1 — vê o texto vizinho
  const containerCheckbox = checkboxPonto1.locator('xpath=ancestor::div[contains(@class,"checkbox")][1]');
  let textoVizinho = '';
  try {
    textoVizinho = (await containerCheckbox.innerText().catch(() => '')).trim();
  } catch { /* ignora */ }
  if (textoVizinho && !textoVizinho.toLowerCase().includes('ponto 1')) {
    log(`⚠️ Texto vizinho do primeiro checkbox: "${textoVizinho}" — esperado "Liberar ponto 1"`);
    // Não bloqueia — first() ainda é a aposta segura, mas registra alerta
  }

  // Marca o checkbox (se já estiver marcado, não faz nada)
  const jaMarcado = await checkboxPonto1.isChecked().catch(() => false);
  if (!jaMarcado) {
    await checkboxPonto1.check();
    log(`✅ Checkbox Ponto 1 marcado`);
  } else {
    log(`ℹ️ Checkbox Ponto 1 já estava marcado`);
  }

  await page.waitForTimeout(300);

  // Clica no botão "Liberar"
  // 2026-04 fix: o "botão" é na verdade <input type="button" value="Liberar" class="btn btn-primary">
  // (não é <button>!) — por isso uso seletor que pega ambos.
  // Estratégia em cascata, do mais específico ao mais genérico:
  const seletoresBtnLiberar = [
    // 1) input[value="Liberar"] dentro do modal — match exato com o HTML real
    '#modalPadrao input[type="button"][value="Liberar"]',
    // 2) input com classe btn-primary (geralmente é o botão de ação)
    '#modalPadrao input[type="button"].btn-primary',
    // 3) qualquer input/button com texto "Liberar" — mais flexível
    '#modalPadrao input[value*="Liberar"]:not([value*="ponto"])',
    // 4) button (caso mudem no futuro)
    '#modalPadrao button.btn-primary',
  ];

  let clicouLiberar = false;
  for (const sel of seletoresBtnLiberar) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      log(`✅ Botão "Liberar" clicado (seletor: ${sel})`);
      clicouLiberar = true;
      break;
    }
  }
  if (!clicouLiberar) {
    const ss = await screenshot(page, os_numero, 'btn_liberar_nao_achado');
    throw new Error(`Botão "Liberar" não encontrado no modal. Screenshot: ${ss}`);
  }

  // Aguarda texto "Enviado" no #divRetornoModal — pode demorar segundos
  log(`⏳ Aguardando confirmação "Enviado"...`);
  try {
    await page.locator('#divRetornoModal:has-text("Enviado"), #divRetornoModal:has-text("enviado")').waitFor({
      state: 'visible',
      timeout: 30000,
    });
    log(`✅ "Enviado" detectado — liberação confirmada pelo sistema externo`);
  } catch (err) {
    // Se não veio "Enviado", captura screenshot e conteúdo do retorno-modal pra diagnóstico
    const conteudoRetorno = await page.locator('#divRetornoModal').innerText().catch(() => '');
    const ss = await screenshot(page, os_numero, 'sem_confirmacao');
    throw new Error(`Sistema externo não confirmou "Enviado" em 30s. Conteúdo: "${conteudoRetorno}". Screenshot: ${ss}`);
  }

  return { sucesso: true, mensagem_retorno: 'Enviado' };
}

/**
 * FUNÇÃO PRINCIPAL — exportada e chamada pelo agente.
 */
async function executarLiberacaoOS({ os_numero, onProgresso }) {
  const reportar = typeof onProgresso === 'function'
    ? (etapa, pct) => { try { onProgresso(etapa, pct); } catch (_) {} }
    : () => {};

  if (!process.env.SISTEMA_EXTERNO_URL) {
    return { sucesso: false, erro: 'SISTEMA_EXTERNO_URL não configurada.' };
  }

  let browser = null;
  let context = null;
  let page = null;

  try {
    log(`🚀 OS ${os_numero} | Iniciando liberação`);
    reportar('iniciando', 5);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    // Reusa sessão se existir
    const sessionPath = getSessionFile();
    const sessionExiste = fs.existsSync(sessionPath);
    context = await browser.newContext(
      sessionExiste ? { storageState: sessionPath } : {}
    );
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Passo 1: garantir login
    reportar('login', 15);
    let logado = false;
    if (sessionExiste) {
      logado = await isLoggedIn(page);
      if (!logado) {
        log(`⚠️ Sessão expirada — relogando`);
        try { fs.unlinkSync(sessionPath); } catch (_) {}
      }
    }
    if (!logado) {
      await fazerLogin(page, _credentialsOverride);
      await context.storageState({ path: sessionPath });
      log(`💾 Sessão salva`);
      // Após login, ir pra acompanhamento
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(1500);
    }

    // Passo 2: localizar OS
    reportar('localizando', 35);
    const achou = await localizarOS(page, os_numero);
    if (!achou) {
      const ss = await screenshot(page, os_numero, 'os_nao_encontrada');
      return {
        sucesso: false,
        erro: `OS ${os_numero} não encontrada na aba "Em execução". Verifique se ela existe e está nesse status.`,
        screenshot_path: ss,
      };
    }

    // Passo 3: abrir modal "Liberar App"
    reportar('abrindo_modal', 60);
    await abrirModalLiberarApp(page, os_numero);

    // Passo 4: executar liberação
    reportar('liberando', 80);
    const resultado = await executarLiberacaoPonto1(page, os_numero);

    reportar('concluido', 100);
    log(`✅ OS ${os_numero} liberada com sucesso`);
    return resultado;

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    let ss = null;
    if (page) {
      ss = await screenshot(page, os_numero, 'erro_inesperado');
    }
    return {
      sucesso: false,
      erro: err.message.slice(0, 500),
      screenshot_path: ss,
    };
  } finally {
    await fecharBrowserSeguro(browser);
  }
}

module.exports = { executarLiberacaoOS, setOverrides, clearOverrides };
