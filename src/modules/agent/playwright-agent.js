/**
 * playwright-agent.js
 * Automação RPA: corrige endereço de um ponto numa OS do sistema externo.
 * Sistema: tutts.com.br/expresso
 *
 * Seletores mapeados do HTML real:
 *   Botão END.    : button.btn-modal[data-action="funcaoEnderecoServico"]
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

const SESSION_FILE   = '/tmp/tutts-rpa-session.json';
const SCREENSHOT_DIR = '/tmp/screenshots';
const TIMEOUT        = 25000;

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

async function screenshot(page, os, etapa) {
  const file = path.join(SCREENSHOT_DIR, `OS${os}_${etapa}_${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); } catch (_) {}
  log(`📸 ${path.basename(file)}`);
  return path.basename(file);
}

async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');

  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    const ss = await screenshot(page, 'login', 'pagina_nao_carregou');
    throw new Error(`Página de login não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
  }

  await page.fill('#loginEmail', process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.SISTEMA_EXTERNO_SENHA);

  // type="button" com name="logar" (não é submit!)
  await page.locator('input[name="logar"]').first().click();

  // Aguardar sair da página de login
  await page.waitForURL(
    url => !url.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
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

  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE)) {
    contextOptions = { storageState: SESSION_FILE };
    log('♻️  Usando sessão salva');
  }

  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // ── Passo 1: Autenticação + ir para acompanhamento ───────────────────────
    log('📌 Passo 1: Autenticação');

    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    if (!(await isLoggedIn(page))) {
      if (fs.existsSync(SESSION_FILE)) {
        fs.unlinkSync(SESSION_FILE);
        log('🗑️  Sessão inválida removida');
      }
      await fazerLogin(page);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(2000);
      await context.storageState({ path: SESSION_FILE });
      log('💾 Sessão salva');
    } else {
      log('✅ Já logado');
    }

    await screenshot(page, os_numero, 'passo1_acompanhamento');

    // ── Passo 2: Pesquisar OS pelo número ────────────────────────────────────
    log(`📌 Passo 2: Pesquisando OS ${os_numero}`);

    // Clicar na aba/seção "Pesquisar serviços"
    await page.click('#pills-pesquisar-servicos-tab');
    await page.waitForTimeout(800);

    // Selecionar tipo "Serviço" no select
    await page.selectOption('#search-type', 'SE');
    await page.waitForTimeout(600);

    // Campo de texto para digitar o número da OS
    await page.waitForSelector('#search-autocomplete-input', { state: 'visible', timeout: TIMEOUT });
    await page.fill('#search-autocomplete-input', os_numero);
    await page.waitForTimeout(400);
    await page.press('#search-autocomplete-input', 'Enter');

    // Aguardar qualquer botão de endereço aparecer no resultado
    await page.waitForSelector(
      'button.btn-modal[data-action="funcaoEnderecoServico"]',
      { timeout: TIMEOUT }
    );
    await page.waitForTimeout(500);
    await screenshot(page, os_numero, 'passo2_resultado');

    // ── Passo 3: Abrir modal de endereços ────────────────────────────────────
    log('📌 Passo 3: Abrindo modal de endereços');

    // Encontrar a linha (<tr>) que contém o número da OS e clicar no botão END. dela
    // (data-id pode ser ID interno, não o número da OS — buscamos pela linha)
    const linhaOS = page.locator(`tr:has-text("${os_numero}")`).first();
    const btnEnd  = linhaOS.locator('button.btn-modal[data-action="funcaoEnderecoServico"]').first();

    const temBtnNaLinha = await btnEnd.isVisible().catch(() => false);
    if (!temBtnNaLinha) {
      // Fallback: primeiro botão de endereço visível (quando há só 1 resultado)
      log('⚠️  Botão não encontrado na linha, usando primeiro disponível');
      await page.locator('button.btn-modal[data-action="funcaoEnderecoServico"]').first().click();
    } else {
      await btnEnd.click();
    }

    // Aguardar modal abrir
    await page.waitForSelector('.modal.show, .modal.in, #modalPadrao.show, #modalPadrao.in', {
      state: 'visible',
      timeout: TIMEOUT,
    });

    // Aguardar botão do ponto correto aparecer no modal
    await page.waitForSelector(
      `.btn-corrigir-endereco[data-ponto="${ponto}"]`,
      { timeout: TIMEOUT }
    );
    await page.waitForTimeout(800);
    log('✅ Modal carregado');
    await screenshot(page, os_numero, 'passo3_modal');

    // ── Passo 4: Clicar em Corrigir no ponto específico ──────────────────────
    log(`📌 Passo 4: Corrigindo Ponto ${ponto}`);

    // Usa data-ponto para selecionar o ponto exato — sem contar botões!
    await page.click(`.btn-corrigir-endereco[data-ponto="${ponto}"]`);
    await page.waitForTimeout(1000);
    await screenshot(page, os_numero, `passo4_ponto${ponto}_clicado`);

    // ── Passo 5: Preencher lat/lng e validar ─────────────────────────────────
    log('📌 Passo 5: Preenchendo coordenadas');

    // Os inputs ficam dentro do form do ponto — aguarda ficarem visíveis
    // Seletores do HTML real: placeholder="Latitude" e placeholder="Longitude"
    // O form do ponto ativo: div#form-corrigir-{id} que fica visível
    const inputLat = page.locator('input[placeholder="Latitude"]:visible').first();
    const inputLon = page.locator('input[placeholder="Longitude"]:visible').first();

    await inputLat.waitFor({ state: 'visible', timeout: TIMEOUT });
    await inputLon.waitFor({ state: 'visible', timeout: TIMEOUT });

    await inputLat.click({ clickCount: 3 });
    await inputLat.fill(String(latitude));
    await inputLon.click({ clickCount: 3 });
    await inputLon.fill(String(longitude));

    log(`📍 Lat: ${latitude} | Lon: ${longitude}`);

    // Clicar em Validar — classe exata do botão
    await page.locator('button.btn-validar-endereco:visible').first().click();
    await page.waitForTimeout(4000);
    await screenshot(page, os_numero, 'passo5_pos_validar');

    // Verificar se geocoder processou: botão Confirmar fica visível após sucesso
    const confirmarVisivel = await page.locator('button.btn-confirmar-alteracao').isVisible().catch(() => false);
    if (!confirmarVisivel) {
      const ss = await screenshot(page, os_numero, 'passo5_geocoder_vazio');
      return {
        sucesso: false,
        erro: `Coordenadas (${latitude}, ${longitude}) não reconhecidas pelo geocoder.`,
        screenshot: ss,
      };
    }
    log('✅ Geocoder OK — botão Confirmar visível');

    // ── Passo 6: Confirmar alteração ─────────────────────────────────────────
    log('📌 Passo 6: Confirmando alteração');

    // Classe exata do botão: btn-confirmar-alteracao
    await page.locator('button.btn-confirmar-alteracao:visible').first().click();
    await page.waitForTimeout(2000);

    await screenshot(page, os_numero, 'passo6_concluido');
    log(`🎉 OS ${os_numero} Ponto ${ponto} corrigido com sucesso!`);
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
