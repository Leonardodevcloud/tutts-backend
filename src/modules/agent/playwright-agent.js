/**
 * playwright-agent.js
 * Automação RPA: corrige endereço de um ponto numa OS do sistema externo.
 * Sistema: tutts.com.br/expresso
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

const SESSION_FILE   = '/tmp/tutts-rpa-session.json';
const SCREENSHOT_DIR = '/tmp/screenshots';
const TIMEOUT        = 25000;

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function log(msg) {
  logger.info(`[playwright-agent] ${msg}`);
}

async function screenshot(page, os, etapa) {
  const file = path.join(SCREENSHOT_DIR, `OS${os}_${etapa}_${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); } catch (_) {}
  log(`📸 Screenshot: ${path.basename(file)}`);
  return path.basename(file);
}

async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');
  const loginUrl = process.env.SISTEMA_EXTERNO_URL;
  const email    = process.env.SISTEMA_EXTERNO_EMAIL;
  const senha    = process.env.SISTEMA_EXTERNO_SENHA;

  // Sempre vai direto para a URL de login configurada
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1500);

  // Verificar se a página de login carregou
  const temCampoEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temCampoEmail) {
    const ss = await screenshot(page, 'login', 'pagina_nao_carregou');
    throw new Error(`Página de login não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
  }

  await page.fill('#loginEmail', email);
  await page.fill('input[type="password"]', senha);

  // Clicar no botão "Logar" — evita pegar "Recuperar Senha"
  await page.locator('input[type="submit"][value="Logar"]').first().click();

  // Aguardar URL mudar (sair da página de login)
  await page.waitForURL(url => !url.includes('loginFuncionarioNovo'), { timeout: TIMEOUT });

  await screenshot(page, 'login', 'pos_login');
  log(`✅ Login OK — URL: ${page.url()}`);
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

  // Tentar reutilizar sessão salva; se falhar, apaga e recomeça sem ela
  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE)) {
    try {
      contextOptions = { storageState: SESSION_FILE };
    } catch (_) {
      fs.unlinkSync(SESSION_FILE);
      log('⚠️  Sessão corrompida removida');
    }
  }

  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // ── Passo 1: Autenticação ────────────────────────────────────────────────
    log('📌 Passo 1: Autenticação');
    await page.goto(process.env.SISTEMA_EXTERNO_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1000);

    if (!(await isLoggedIn(page))) {
      // Sessão inválida — apaga e faz login fresh
      if (fs.existsSync(SESSION_FILE)) {
        fs.unlinkSync(SESSION_FILE);
        log('🗑️  Sessão inválida removida');
      }
      await fazerLogin(page);
      await context.storageState({ path: SESSION_FILE });
      log('💾 Sessão salva');
    } else {
      log('♻️  Sessão reutilizada');
    }

    await screenshot(page, os_numero, 'passo1_logado');

    // ── Passo 2: Pesquisar OS ────────────────────────────────────────────────
    log(`📌 Passo 2: Pesquisando OS ${os_numero}`);

    await page.click('#pills-pesquisar-servicos-tab');
    await page.waitForTimeout(800);

    await page.selectOption('#search-type', 'SE');
    await page.waitForTimeout(600);

    await page.waitForSelector('#search-autocomplete-input', { state: 'visible', timeout: TIMEOUT });
    await page.fill('#search-autocomplete-input', os_numero);
    await page.waitForTimeout(400);
    await page.press('#search-autocomplete-input', 'Enter');

    await page.waitForFunction(
      () => (document.querySelector('#search-response')?.innerHTML?.trim().length ?? 0) > 100,
      { timeout: TIMEOUT }
    );
    await page.waitForTimeout(1500);
    await screenshot(page, os_numero, 'passo2_resultado');

    // ── Passo 3: Abrir modal de endereços ────────────────────────────────────
    log('📌 Passo 3: Abrindo modal de endereços');

    const seletorBtnEnd = '#search-response .btn-modal[data-action="funcaoEnderecoServico"]';
    const btnCount = await page.locator(seletorBtnEnd).count();
    log(`🔍 Botões de endereço encontrados: ${btnCount}`);

    if (btnCount === 0) {
      const ss = await screenshot(page, os_numero, 'passo3_sem_botao');
      return {
        sucesso: false,
        erro: `OS ${os_numero} não encontrada ou botão de endereço ausente.`,
        screenshot: ss,
      };
    }

    await page.locator(seletorBtnEnd).first().click();
    await page.waitForSelector('#modalPadrao', { state: 'visible', timeout: TIMEOUT });
    await page.waitForFunction(
      () => (document.querySelector('#retorno-modal')?.innerHTML?.trim().length ?? 0) > 50,
      { timeout: TIMEOUT }
    );
    await page.waitForTimeout(1200);
    log('✅ Modal carregado');
    await screenshot(page, os_numero, 'passo3_modal');

    // ── Passo 4: Clicar no botão Corrigir do ponto ───────────────────────────
    log(`📌 Passo 4: Selecionando Ponto ${ponto}`);

    const seletorCorrigir = '#retorno-modal button:has-text("Corrigir"), #retorno-modal a:has-text("Corrigir")';
    const totalCorrigir   = await page.locator(seletorCorrigir).count();
    log(`🔍 Botões Corrigir no modal: ${totalCorrigir}`);

    if (totalCorrigir === 0) {
      const ss = await screenshot(page, os_numero, 'passo4_sem_corrigir');
      return { sucesso: false, erro: 'Botões de Corrigir não encontrados no modal.', screenshot: ss };
    }

    const idx = ponto - 1; // ponto 1 = idx 0, ponto 2 = idx 1...
    if (idx >= totalCorrigir) {
      const ss = await screenshot(page, os_numero, 'passo4_ponto_invalido');
      return {
        sucesso: false,
        erro: `Ponto ${ponto} não existe (total: ${totalCorrigir}).`,
        screenshot: ss,
      };
    }

    await page.locator(seletorCorrigir).nth(idx).click();
    await page.waitForTimeout(2000);
    await screenshot(page, os_numero, `passo4_ponto${ponto}_clicado`);

    // ── Passo 5: Preencher coordenadas e validar ─────────────────────────────
    log('📌 Passo 5: Preenchendo coordenadas');

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
    log(`📍 Preenchido: ${latitude}, ${longitude}`);

    await page.locator('button:has-text("Validar"), input[value="Validar"]').first().click();
    await page.waitForTimeout(4000);
    await screenshot(page, os_numero, 'passo5_pos_validar');

    const campoRua = page.locator(
      'input[name="rua"], input[name="logradouro"], input[id*="rua" i], input[id*="logradouro" i]'
    ).first();
    const valorRua = await campoRua.inputValue().catch(() => '');

    if (!valorRua.trim()) {
      const ss = await screenshot(page, os_numero, 'passo5_geocoder_vazio');
      return {
        sucesso: false,
        erro: `Coordenadas (${latitude}, ${longitude}) não reconhecidas pelo geocoder.`,
        screenshot: ss,
      };
    }
    log(`✅ Geocoder: ${valorRua}`);

    // ── Passo 6: Confirmar ───────────────────────────────────────────────────
    log('📌 Passo 6: Confirmando');
    await page.locator(
      'button:has-text("Confirmar"), input[value="Confirmar"], button:has-text("Salvar")'
    ).first().click();
    await page.waitForTimeout(2000);

    await screenshot(page, os_numero, 'passo6_concluido');
    log(`🎉 OS ${os_numero} Ponto ${ponto} corrigido!`);
    return { sucesso: true };

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    const ss = await screenshot(page, os_numero, 'erro_inesperado');
    return { sucesso: false, erro: `Erro inesperado: ${err.message}`, screenshot: ss };
  } finally {
    await browser.close();
  }
}

module.exports = { executarCorrecaoEndereco };
