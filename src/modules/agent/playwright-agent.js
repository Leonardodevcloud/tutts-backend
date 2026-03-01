/**
 * playwright-agent.js
 * Automação RPA: corrige endereço de um ponto numa OS do sistema externo.
 * Sistema: tutts.com.br/expresso
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

const SESSION_FILE   = path.join('/tmp', 'tutts-rpa-session.json');
const SCREENSHOT_DIR = '/tmp/screenshots';
const TIMEOUT        = 20000;

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function log(msg) {
  logger.info(`[playwright-agent] ${msg}`);
}

async function capturarScreenshot(page, osNumero, etapa) {
  const file = path.join(SCREENSHOT_DIR, `erro_OS${osNumero}_${etapa}_${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); } catch (_) {}
  return path.basename(file);
}

// Verifica se está logado: URL deve conter /expresso mas NÃO conter loginFuncionarioNovo
async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');
  const url   = process.env.SISTEMA_EXTERNO_URL;
  const email = process.env.SISTEMA_EXTERNO_EMAIL;
  const senha = process.env.SISTEMA_EXTERNO_SENHA;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  // Seletor correto: id="loginEmail", name="login", type="text"
  await page.waitForSelector('#loginEmail', { timeout: TIMEOUT });
  await page.fill('#loginEmail', email);

  // Campo senha
  await page.fill('input[type="password"]', senha);

  // Botão "Logar" — dentro do form#login para não pegar "Recuperar Senha"
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUT }),
    page.click('form#login input[type="submit"], form#login button[type="submit"], #btnLogar'),
  ]);

  if (!(await isLoggedIn(page))) {
    const ss = await capturarScreenshot(page, 'login', 'falha_login');
    throw new Error(`Login falhou. URL atual: ${page.url()}. Screenshot: ${ss}`);
  }
  log('✅ Login OK');
}

async function executarCorrecaoEndereco({ os_numero, ponto, latitude, longitude }) {
  if (!process.env.SISTEMA_EXTERNO_URL) {
    return { sucesso: false, erro: 'SISTEMA_EXTERNO_URL não configurada.' };
  }
  if (ponto === 1) {
    return { sucesso: false, erro: 'Segurança: Ponto 1 nunca pode ser alterado.' };
  }

  log(`🚀 OS ${os_numero} | Ponto ${ponto} | ${latitude}, ${longitude}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const contextOptions = fs.existsSync(SESSION_FILE)
    ? { storageState: SESSION_FILE }
    : {};

  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // ── Passo 1: Autenticação ───────────────────────────────────────────────
    log('📌 Passo 1: Autenticação');
    await page.goto(process.env.SISTEMA_EXTERNO_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    if (!(await isLoggedIn(page))) {
      await fazerLogin(page);
      await context.storageState({ path: SESSION_FILE });
      log('💾 Sessão salva');
    } else {
      log('♻️  Sessão reutilizada');
    }

    // Screenshot pós-login para diagnóstico
    await capturarScreenshot(page, os_numero, 'passo1_logado');

    // ── Passo 2: Localizar OS ───────────────────────────────────────────────
    log(`📌 Passo 2: Localizar OS ${os_numero}`);

    // Aguardar campo de busca da tela de acompanhamento
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Pesquisar" i], input[placeholder*="serviço" i], input[placeholder*="OS" i], input[type="search"], input[name*="pesquisa" i], input[id*="pesquisa" i]',
      { timeout: TIMEOUT }
    );
    await searchInput.fill(os_numero);
    await searchInput.press('Enter');
    await page.waitForTimeout(2000);

    // Verificar se a OS apareceu
    const osVisivel = await page.locator(`text="${os_numero}"`).first().isVisible().catch(() => false);
    if (!osVisivel) {
      const ss = await capturarScreenshot(page, os_numero, 'passo2_os_nao_encontrada');
      return { sucesso: false, erro: `OS ${os_numero} não encontrada no sistema externo.`, screenshot: ss };
    }

    // ── Passo 3: Abrir modal de endereços ──────────────────────────────────
    log('📌 Passo 3: Abrir modal de endereços');

    const linhaOS = page.locator(`tr:has-text("${os_numero}")`).first();
    
    // Clicar no ícone de endereço (coluna END.)
    const btnEnd = linhaOS.locator(
      'a[title*="ndereço" i], a[title*="END" i], button[title*="ndereço" i], [onclick*="endereco" i], td a, td button'
    ).first();
    await btnEnd.click();

    // Aguardar modal abrir
    await page.waitForSelector(
      '.modal.in, .modal-dialog, [role="dialog"], [id*="modal" i]',
      { state: 'visible', timeout: TIMEOUT }
    );
    log('✅ Modal aberto');
    await capturarScreenshot(page, os_numero, 'passo3_modal_aberto');

    // ── Passo 4: Selecionar ponto ───────────────────────────────────────────
    log(`📌 Passo 4: Ponto ${ponto}`);

    // Buscar todos os botões de corrigir endereço no modal
    const btnCorrigir = page.locator(
      'button:has-text("Corrigir"), a:has-text("Corrigir"), [onclick*="corrigir" i]'
    );
    await page.waitForTimeout(1000);
    const allBtns = await btnCorrigir.all();
    const idx = ponto - 2; // ponto 2 = índice 0

    if (allBtns.length === 0) {
      const ss = await capturarScreenshot(page, os_numero, 'passo4_sem_botoes');
      return { sucesso: false, erro: 'Botões de correção não encontrados no modal.', screenshot: ss };
    }
    if (idx >= allBtns.length) {
      const ss = await capturarScreenshot(page, os_numero, `passo4_ponto${ponto}`);
      return { sucesso: false, erro: `Ponto ${ponto} não existe nesta OS (${allBtns.length} pontos disponíveis).`, screenshot: ss };
    }

    await allBtns[idx].click();
    await page.waitForTimeout(1500);
    await capturarScreenshot(page, os_numero, `passo4_ponto${ponto}_clicado`);

    // ── Passo 5: Preencher coordenadas e validar ───────────────────────────
    log('📌 Passo 5: Preencher coordenadas');

    const inputLat = await page.waitForSelector(
      'input[name="latitude"], input[id*="lat" i], input[placeholder*="atitude" i]',
      { timeout: TIMEOUT }
    );
    const inputLng = await page.waitForSelector(
      'input[name="longitude"], input[id*="lng" i], input[id*="lon" i], input[placeholder*="ongitude" i]',
      { timeout: TIMEOUT }
    );

    await inputLat.click({ clickCount: 3 });
    await inputLat.fill(String(latitude));
    await inputLng.click({ clickCount: 3 });
    await inputLng.fill(String(longitude));

    // Clicar em Validar
    await page.locator('button:has-text("Validar"), input[value="Validar"]').first().click();
    await page.waitForTimeout(4000);

    // Verificar se geocoder preencheu algum campo de endereço
    const campoRua = page.locator(
      'input[name="rua"], input[name="logradouro"], input[id*="rua" i], input[id*="logradouro" i], input[placeholder*="rua" i]'
    ).first();
    const valorRua = await campoRua.inputValue().catch(() => '');

    if (!valorRua.trim()) {
      const ss = await capturarScreenshot(page, os_numero, 'passo5_geocoder_vazio');
      return {
        sucesso: false,
        erro: `Coordenadas (${latitude}, ${longitude}) não reconhecidas pelo geocoder.`,
        screenshot: ss,
      };
    }

    log(`✅ Geocoder: ${valorRua}`);

    // ── Passo 6: Confirmar alteração ───────────────────────────────────────
    log('📌 Passo 6: Confirmar alteração');
    await page.locator(
      'button:has-text("Confirmar"), button:has-text("Salvar"), input[value="Confirmar"]'
    ).first().click();
    await page.waitForTimeout(2000);

    log(`🎉 OS ${os_numero} Ponto ${ponto} corrigido com sucesso!`);
    return { sucesso: true };

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    const ss = await capturarScreenshot(page, os_numero, 'erro_inesperado');
    return { sucesso: false, erro: `Erro inesperado: ${err.message}`, screenshot: ss };
  } finally {
    await browser.close();
  }
}

module.exports = { executarCorrecaoEndereco };
