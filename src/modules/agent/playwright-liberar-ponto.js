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
// 🆕 2026-05-31: helper compartilhado (codigo, NAO login) p/ dispensar tela de feriados
const { dispensarFeriados } = require('./core/dispensar-feriados');

// ── Reuso de helpers do playwright-agent.js ──────────────────────────────
// Mantemos sessão SEPARADA pra liberar-ponto (conta diferente do agent-correcao)
const SESSION_FILE_DEFAULT = '/tmp/tutts-rpa-liberacao-session.json';

let _sessionFileOverride = null;
let _credentialsOverride = null;
// 2026-05 fix-eagain: browser persistente por slot — quando setado,
// chromium.launch() é pulado e o close() vira no-op.
let _browserOverride = null;

function getSessionFile() { return _sessionFileOverride || SESSION_FILE_DEFAULT; }
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
  // 2026-04 egress-fix: skip se SCREENSHOTS_ENABLED=0
  if (process.env.SCREENSHOTS_ENABLED === '0' ||
      process.env.SCREENSHOTS_ENABLED === 'false') {
    return null;
  }
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
  // ⚠️ 2026-06-01: o acompanhamento da MAPP NÃO usa <table>/<tr> — é layout de
  // divs (div.row.styleBorde / col-*). Por isso casamos tr OU div.row OU qualquer
  // elemento que contenha o número da OS.
  const rowOS = localizarRowOS(page, os_numero);
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
  return await localizarRowOS(page, os_numero).isVisible().catch(() => false);
}

/**
 * Localiza o container da OS de forma robusta ao layout.
 * A MAPP usa layout de DIVS (div.row.styleBorde / col-*), não <table>/<tr>.
 * Estratégia: o número da OS aparece dentro de um input editável (código) na
 * linha; subimos até o container de linha (div.row mais próximo) — com fallback
 * pra <tr> caso a estrutura mude.
 */
function localizarRowOS(page, os_numero) {
  const os = String(os_numero);
  // Casa, em ordem de preferência:
  //  - <tr> contendo o número (layout de tabela, se existir)
  //  - div.row / div com classe styleBorde contendo o número
  //  - qualquer linha de lista (li / div[class*=row]) contendo o número
  return page.locator(
    `tr:has-text("${os}"), ` +
    `div.row:has-text("${os}"), ` +
    `div[class*="styleBorde"]:has-text("${os}"), ` +
    `div[class*="row"]:has-text("${os}")`
  ).first();
}

/**
 * Clica na engrenagem da row da OS e depois em "Liberar App".
 * O dropdown da engrenagem tem item "Liberar App" (visto no print).
 */
async function abrirModalLiberarApp(page, os_numero) {
  log(`\u2699\ufe0f  Abrindo menu engrenagem da OS ${os_numero}`);

  // Localiza a row da OS \u2014 layout de DIVS (nao <tr>), via helper robusto
  const row = localizarRowOS(page, os_numero);
  await row.waitFor({ state: 'visible', timeout: TIMEOUT });

  // \ud83d\udd27 2026-06 dropdown-fix: em vez de chutar UM gear com .last() e procurar
  // "Liberar App" no documento inteiro, iteramos TODOS os toggles candidatos
  // da row. Pra cada um: clica, espera o menu, e so aceita se "Liberar App"
  // estiver VISIVEL num menu aberto. Se nao, fecha (Escape) e tenta o proximo.
  const candidatos = [
    'button[data-toggle="dropdown"]',
    'a[data-toggle="dropdown"]',
    'button[data-bs-toggle="dropdown"]',
    'a[data-bs-toggle="dropdown"]',
    '.dropdown-toggle',
    'button:has(i.fa-cog)',
    'button:has(i.fa-gear)',
    'a:has(i.fa-cog)',
    '.btn-grupo-acoes',
  ];

  const itemSel =
    '.dropdown-menu.show a:has-text("Liberar App"), ' +
    '.dropdown-menu.show button:has-text("Liberar App"), ' +
    '.dropdown-menu.show li:has-text("Liberar App"), ' +
    '.dropdown-menu:visible a:has-text("Liberar App"), ' +
    '.dropdown-menu:visible li:has-text("Liberar App"), ' +
    'ul[role="menu"]:visible a:has-text("Liberar App")';
  const itemLiberar = () => page.locator(itemSel).first();

  let abriu = false;
  const togglesTentados = [];
  for (const sel of candidatos) {
    const toggles = row.locator(sel);
    const n = await toggles.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const btn = toggles.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      try { await btn.click({ timeout: 4000 }); } catch (_) { continue; }
      togglesTentados.push(sel);
      // Espera curta: o item so aparece se este foi o menu certo
      const ok = await itemLiberar().waitFor({ state: 'visible', timeout: 2500 })
        .then(() => true).catch(() => false);
      if (ok) {
        await itemLiberar().click();
        log(`\u2705 "Liberar App" clicado (toggle: ${sel})`);
        abriu = true;
        break;
      }
      // Menu errado \u2014 fecha e tenta o proximo toggle
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    }
    if (abriu) break;
  }

  if (!abriu) {
    // \ud83d\udd0e Auto-diagnostico: captura o texto de QUALQUER menu aberto, mesmo com
    // SCREENSHOTS_ENABLED=0 (o screenshot vinha null e te deixava cego). Assim o
    // proprio erro ja diz O QUE a engrenagem mostrou \u2014 sem depender de print.
    let menusTxt = '';
    try {
      const menus = page.locator('.dropdown-menu.show, .dropdown-menu:visible, ul[role="menu"]:visible');
      const qm = await menus.count().catch(() => 0);
      for (let i = 0; i < qm && i < 3; i++) {
        const t = (await menus.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (t) menusTxt += `[menu ${i}] ${t.slice(0, 200)} | `;
      }
    } catch (_) {}
    const ss = await screenshot(page, os_numero, 'liberar_app_nao_achado');
    throw new Error(
      `Item "Liberar App" nao apareceu. Toggles tentados: ${togglesTentados.join(', ') || 'nenhum visivel'}. ` +
      `Menu(s) aberto(s): ${menusTxt || 'nenhum'}. Screenshot: ${ss}`
    );
  }

  // Aguarda modal aparecer
  await page.locator('#modalPadrao').waitFor({ state: 'visible', timeout: 10000 });
  // Aguarda conteudo do modal carregar (lista de pontos)
  await page.locator('#modalPadrao input[type="checkbox"][name="liberar"]').first().waitFor({
    state: 'visible',
    timeout: 10000,
  });
  log(`\u2705 Modal "Liberar App" aberto`);
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

  // 🎯 SEGURANCA/IDEMPOTENCIA: o objetivo do agente e SO o Ponto 1.
  // Em vez de pegar cegamente o first() (que vira o Ponto 2 se o Ponto 1 ja
  // sumiu da lista por estar liberado!), procuramos o checkbox cujo texto
  // vizinho menciona "ponto 1". Se nao existir, NAO tocamos em nenhum outro
  // ponto e avisamos que o Ponto 1 ja esta liberado.
  let checkboxPonto1 = null;
  let textoVizinho = '';
  for (let i = 0; i < total; i++) {
    const cb = checkboxes.nth(i);
    const cont = cb.locator('xpath=ancestor::div[contains(@class,"checkbox")][1]');
    const txt = (await cont.innerText().catch(() => '')).trim();
    if (txt.toLowerCase().includes('ponto 1')) {
      checkboxPonto1 = cb;
      textoVizinho = txt;
      break;
    }
  }

  const MSG_JA_LIBERADO = 'O Ponto 1 ja esta liberado. Se voce precisa liberar o Ponto 2, entre em contato com o suporte!';

  if (!checkboxPonto1) {
    // Nenhum checkbox de "Ponto 1" no modal — quase sempre porque o Ponto 1
    // JA esta liberado (sumiu da lista). Nao liberamos Ponto 2/3 por engano.
    log(`ℹ️ Nenhum checkbox de "Ponto 1" no modal — Ponto 1 ja liberado. Nada a fazer.`);
    return { sucesso: true, ja_liberado: true, mensagem_retorno: MSG_JA_LIBERADO };
  }

  // Se o checkbox do Ponto 1 esta desabilitado, ja foi liberado — idempotente.
  const desabilitado = await checkboxPonto1.isDisabled().catch(() => false);
  if (desabilitado) {
    log(`ℹ️ Checkbox do Ponto 1 desabilitado — ja liberado. Nada a fazer.`);
    return { sucesso: true, ja_liberado: true, mensagem_retorno: MSG_JA_LIBERADO };
  }

  log(`☑️  Checkbox do Ponto 1 localizado (texto: "${textoVizinho}")`);

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
  // 2026-05 fix-eagain: rastreia se browser veio de override
  let browserEhOverride = false;

  try {
    log(`🚀 OS ${os_numero} | Iniciando liberação`);
    reportar('iniciando', 5);

    if (_browserOverride) {
      browser = _browserOverride;
      browserEhOverride = true;
      log('♻️ Usando browser persistente (BrowserSession)');
    } else {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    }

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
    }

    // 🔧 2026-06-01 FIX: dispensar feriados SEMPRE (não só após login novo).
    // Com browser persistente, a sessão salva pode estar "logada" porém presa na
    // tela de feriados — isLoggedIn dá true, o if acima é pulado e a OS nunca
    // carrega (#search-autocomplete-input some → Timeout 25000ms). Chamar aqui,
    // incondicionalmente, garante que saímos de principal.php antes de localizar.
    await dispensarFeriados(page, log);
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500);

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
    // 2026-05 fix-eagain: se browser veio de override, fecha apenas o context.
    if (browserEhOverride) {
      if (context) {
        try {
          await comTimeout(context.close(), 3_000, 'context.close');
        } catch (e) {
          log(`⚠️ context.close pendurou: ${e.message}`);
        }
      }
    } else {
      await fecharBrowserSeguro(browser);
    }
  }
}

/**
 * 2026-07 auto-liberacao — versao GENERICA por ponto (2-7).
 * Espelha executarLiberacaoPonto1 (que fica intacta pro fluxo do app), mas
 * procura o checkbox do "ponto N" informado. Idempotente: se o ponto ja estiver
 * liberado (checkbox sumiu/desabilitado), retorna ja_liberado sem tocar em outros.
 */
async function executarLiberacaoPontoN(page, os_numero, ponto) {
  const pontoNum = parseInt(ponto, 10);
  if (!Number.isInteger(pontoNum) || pontoNum < 1) {
    throw new Error(`Ponto invalido para liberacao: ${ponto}`);
  }
  if (pontoNum === 1) {
    // Seguranca: ponto 1 sempre pela funcao imutavel dedicada.
    return executarLiberacaoPonto1(page, os_numero);
  }

  log(`☑️  Marcando checkbox do Ponto ${pontoNum}`);

  const checkboxes = page.locator('#modalPadrao input[type="checkbox"][name="liberar"]');
  const total = await checkboxes.count();
  log(`🔎 Total de checkboxes no modal: ${total}`);

  if (total === 0) {
    const ss = await screenshot(page, os_numero, 'sem_checkbox');
    throw new Error(`Nenhum checkbox de liberação no modal. Screenshot: ${ss}`);
  }

  // Procura o checkbox cujo texto vizinho menciona "ponto N". So marca esse.
  let checkboxPontoN = null;
  let textoVizinho = '';
  for (let i = 0; i < total; i++) {
    const cb = checkboxes.nth(i);
    const cont = cb.locator('xpath=ancestor::div[contains(@class,"checkbox")][1]');
    const txt = (await cont.innerText().catch(() => '')).trim();
    if (txt.toLowerCase().includes(`ponto ${pontoNum}`)) {
      checkboxPontoN = cb;
      textoVizinho = txt;
      break;
    }
  }

  const MSG_JA_LIBERADO = `O Ponto ${pontoNum} ja esta liberado (ou nao consta como liberavel). Nada a fazer.`;

  if (!checkboxPontoN) {
    log(`ℹ️ Nenhum checkbox de "Ponto ${pontoNum}" no modal — provavelmente ja liberado. Nada a fazer.`);
    return { sucesso: true, ja_liberado: true, mensagem_retorno: MSG_JA_LIBERADO };
  }

  const desabilitado = await checkboxPontoN.isDisabled().catch(() => false);
  if (desabilitado) {
    log(`ℹ️ Checkbox do Ponto ${pontoNum} desabilitado — ja liberado. Nada a fazer.`);
    return { sucesso: true, ja_liberado: true, mensagem_retorno: MSG_JA_LIBERADO };
  }

  log(`☑️  Checkbox do Ponto ${pontoNum} localizado (texto: "${textoVizinho}")`);

  const jaMarcado = await checkboxPontoN.isChecked().catch(() => false);
  if (!jaMarcado) {
    await checkboxPontoN.check();
    log(`✅ Checkbox Ponto ${pontoNum} marcado`);
  } else {
    log(`ℹ️ Checkbox Ponto ${pontoNum} já estava marcado`);
  }

  await page.waitForTimeout(300);

  const seletoresBtnLiberar = [
    '#modalPadrao input[type="button"][value="Liberar"]',
    '#modalPadrao input[type="button"].btn-primary',
    '#modalPadrao input[value*="Liberar"]:not([value*="ponto"])',
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

  log(`⏳ Aguardando confirmação "Enviado"...`);
  try {
    await page.locator('#divRetornoModal:has-text("Enviado"), #divRetornoModal:has-text("enviado")').waitFor({
      state: 'visible',
      timeout: 30000,
    });
    log(`✅ "Enviado" detectado — Ponto ${pontoNum} liberado`);
  } catch (err) {
    const conteudoRetorno = await page.locator('#divRetornoModal').innerText().catch(() => '');
    const ss = await screenshot(page, os_numero, 'sem_confirmacao');
    throw new Error(`Sistema externo não confirmou "Enviado" em 30s. Conteúdo: "${conteudoRetorno}". Screenshot: ${ss}`);
  }

  return { sucesso: true, mensagem_retorno: 'Enviado', ponto: pontoNum };
}

/**
 * 2026-07 auto-liberacao — fluxo INLINE, chamado no MESMO job da correcao.
 *
 * Diferente de executarLiberacaoOS (que usa o estado global via setOverrides e o
 * worker da fila), esta funcao recebe TUDO por parametro (sem estado global, sem
 * race entre slots) e reaproveita:
 *   - o browser persistente do slot da correcao (params.browser)
 *   - a sessao que a correcao acabou de salvar (params.sessionFile) -> login
 *     instantaneo; so faz login de fato se a sessao expirou.
 *
 * Assim nao reenfileira nem faz relogin caro: apenas abre um context novo, busca
 * a OS (sessao ja valida) e libera o ponto informado.
 *
 * @param {object} params { browser, sessionFile, credentials, os_numero, ponto, onProgresso }
 * @returns {object} { sucesso, mensagem_retorno?, ja_liberado?, erro?, screenshot_path? }
 */
async function executarLiberacaoInline(params) {
  params = params || {};
  const { os_numero, ponto, onProgresso } = params;
  const reportar = typeof onProgresso === 'function'
    ? (etapa, pct) => { try { onProgresso(etapa, pct); } catch (_) {} }
    : () => {};

  if (!process.env.SISTEMA_EXTERNO_URL) {
    return { sucesso: false, erro: 'SISTEMA_EXTERNO_URL não configurada.' };
  }

  // 🔒 fontes por parametro (sem global) — mesmo principio do fix de concorrencia.
  const _sessionFileLocal = params.sessionFile || getSessionFile();
  const _credentialsLocal = params.credentials || _credentialsOverride;
  const _browserLocal     = params.browser || _browserOverride;

  let browser = null;
  let context = null;
  let page = null;
  let browserEhOverride = false;

  try {
    log(`🚀 [inline] OS ${os_numero} | Liberando Ponto ${ponto}`);
    reportar('liberacao_iniciando', 5);

    if (_browserLocal) {
      browser = _browserLocal;
      browserEhOverride = true;
      log('♻️ [inline] Usando browser persistente do slot');
    } else {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    }

    const sessionExiste = fs.existsSync(_sessionFileLocal);
    context = await browser.newContext(
      sessionExiste ? { storageState: _sessionFileLocal } : {}
    );
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Login (quase sempre reusa a sessao que a correcao acabou de salvar)
    reportar('liberacao_login', 15);
    let logado = false;
    if (sessionExiste) {
      logado = await isLoggedIn(page);
      if (!logado) {
        log(`⚠️ [inline] Sessão expirada — relogando`);
        try { fs.unlinkSync(_sessionFileLocal); } catch (_) {}
      }
    }
    if (!logado) {
      await fazerLogin(page, _credentialsLocal);
      await context.storageState({ path: _sessionFileLocal });
      log(`💾 [inline] Sessão salva`);
    }

    await dispensarFeriados(page, log);
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500);

    // Localizar OS
    reportar('liberacao_localizando', 40);
    const achou = await localizarOS(page, os_numero);
    if (!achou) {
      const ss = await screenshot(page, os_numero, 'inline_os_nao_encontrada');
      return {
        sucesso: false,
        erro: `OS ${os_numero} não encontrada para liberar o Ponto ${ponto}.`,
        screenshot_path: ss,
      };
    }

    // Abrir "Liberar App" e liberar o ponto informado
    reportar('liberacao_abrindo_modal', 65);
    await abrirModalLiberarApp(page, os_numero);

    reportar('liberacao_liberando', 85);
    const resultado = await executarLiberacaoPontoN(page, os_numero, ponto);

    reportar('liberacao_concluido', 100);
    log(`✅ [inline] OS ${os_numero} Ponto ${ponto} — liberação concluída`);
    return resultado;

  } catch (err) {
    log(`❌ [inline] Erro: ${err.message}`);
    let ss = null;
    if (page) { ss = await screenshot(page, os_numero, 'inline_erro').catch(() => null); }
    // browser morto deve subir pro orquestrador recriar o BrowserSession
    if (/Target (page|frame)?.*closed|browser.*closed|Connection closed/i.test(err.message || '')) {
      throw err;
    }
    return { sucesso: false, erro: err.message.slice(0, 500), screenshot_path: ss };
  } finally {
    if (browserEhOverride) {
      if (context) {
        try { await comTimeout(context.close(), 3_000, 'context.close'); }
        catch (e) { log(`⚠️ [inline] context.close pendurou: ${e.message}`); }
      }
    } else {
      await fecharBrowserSeguro(browser);
    }
  }
}

module.exports = { executarLiberacaoOS, executarLiberacaoInline, setOverrides, clearOverrides };
