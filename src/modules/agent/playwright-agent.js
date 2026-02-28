/**
 * playwright-agent.js
 * Automação RPA: corrige endereço de um ponto numa OS do sistema externo.
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

const SESSION_FILE   = path.join('/tmp', 'tutts-rpa-session.json');
const SCREENSHOT_DIR = '/tmp/screenshots';
const TIMEOUT        = 15000;

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function log(msg) {
  logger.info(`[playwright-agent] ${msg}`);
}

async function capturarScreenshot(page, osNumero, etapa) {
  const file = path.join(SCREENSHOT_DIR, `erro_OS${osNumero}_${etapa}_${Date.now()}.png`);
  try { await page.screenshot({ path: file }); } catch (_) {}
  return path.basename(file);
}

async function isLoggedIn(page) {
  const url = page.url();
  return !url.includes('/login') && !url.includes('/auth');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');
  const url   = process.env.SISTEMA_EXTERNO_URL;
  const email = process.env.SISTEMA_EXTERNO_EMAIL;
  const senha = process.env.SISTEMA_EXTERNO_SENHA;

  await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT });
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', senha);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
  if (!(await isLoggedIn(page))) {
    throw new Error('Login falhou: credenciais inválidas ou layout mudou.');
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const contextOptions = fs.existsSync(SESSION_FILE)
    ? { storageState: SESSION_FILE }
    : {};

  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // Passo 1 — Autenticação
    await page.goto(process.env.SISTEMA_EXTERNO_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
    if (!(await isLoggedIn(page))) {
      await fazerLogin(page);
      await context.storageState({ path: SESSION_FILE });
      log('💾 Sessão salva');
    } else {
      log('♻️  Sessão reutilizada');
    }

    // Passo 2 — Localizar OS
    log(`📌 Passo 2: Localizar OS ${os_numero}`);
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Pesquisar" i], input[placeholder*="buscar" i], input[type="search"]',
      { timeout: TIMEOUT }
    );
    await searchInput.fill(os_numero);
    await searchInput.press('Enter');

    try {
      await page.waitForSelector(`text="${os_numero}"`, { timeout: 10000 });
    } catch {
      const ss = await capturarScreenshot(page, os_numero, 'passo2');
      return { sucesso: false, erro: `OS ${os_numero} não encontrada no sistema externo.`, screenshot: ss };
    }

    // Passo 3 — Abrir modal de endereços
    log('📌 Passo 3: Abrir modal');
    const linhaOS = page.locator(`tr:has-text("${os_numero}")`).first();
    const btnEnd = linhaOS.locator(
      '[title*="ndereco" i], [title*="END" i], td:last-child button'
    ).first();
    await btnEnd.click();
    await page.waitForSelector('[role="dialog"], .modal, [class*="modal"]', { timeout: TIMEOUT });
    log('✅ Modal aberto');

    // Passo 4 — Selecionar ponto
    log(`📌 Passo 4: Ponto ${ponto}`);
    const btnCorrigir = page.locator(
      `button:has-text("Corrigir endereço"), button:has-text("Corrigir Endereço")`
    );
    const allBtns = await btnCorrigir.all();
    const idx = ponto - 2;

    if (allBtns.length === 0) {
      const ss = await capturarScreenshot(page, os_numero, 'passo4_sem_botoes');
      return { sucesso: false, erro: 'Botões de correção não encontrados no modal.', screenshot: ss };
    }
    if (idx >= allBtns.length) {
      const ss = await capturarScreenshot(page, os_numero, `passo4_ponto${ponto}`);
      return { sucesso: false, erro: `Ponto ${ponto} não existe nesta OS (${allBtns.length} pontos disponíveis).`, screenshot: ss };
    }

    await allBtns[idx].click();

    // Passo 5 — Preencher coords e validar
    log('📌 Passo 5: Preencher coordenadas');
    const inputLat = await page.waitForSelector(
      'input[name="latitude"], input[placeholder*="atitude" i], input[id*="lat" i]',
      { timeout: TIMEOUT }
    );
    const inputLng = await page.waitForSelector(
      'input[name="longitude"], input[placeholder*="ongitude" i], input[id*="lng" i], input[id*="lon" i]',
      { timeout: TIMEOUT }
    );

    await inputLat.click({ clickCount: 3 });
    await inputLat.fill(String(latitude));
    await inputLng.click({ clickCount: 3 });
    await inputLng.fill(String(longitude));

    await page.locator('button:has-text("Validar")').first().click();
    await page.waitForTimeout(3000);

    const campoRua = page.locator(
      'input[name="rua"], input[name="logradouro"], input[placeholder*="rua" i]'
    ).first();
    const valorRua = await campoRua.inputValue().catch(() => '');

    if (!valorRua.trim()) {
      const ss = await capturarScreenshot(page, os_numero, 'passo5_geocoder');
      return {
        sucesso: false,
        erro: `Coordenadas (${latitude}, ${longitude}) não reconhecidas pelo geocoder.`,
        screenshot: ss,
      };
    }

    log(`✅ Geocoder: ${valorRua}`);

    // Passo 6 — Confirmar
    log('📌 Passo 6: Confirmar alteração');
    await page.locator('button:has-text("Confirmar")').first().click();
    await page.waitForTimeout(2000);

    log(`🎉 OS ${os_numero} Ponto ${ponto} corrigido!`);
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
