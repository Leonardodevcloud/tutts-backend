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
const TIMEOUT      = 25000;

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

        // Estratégia 1: span#end-antigo-{id} (textContent funciona mesmo se display:none)
        if (idEnd) {
          const span = document.getElementById('end-antigo-' + idEnd);
          if (span) {
            texto = (span.textContent || '').trim();
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
  // expostos pra testes unitários
  _internal: { parseEntrega814, parseEntrega767, ponto1Bate767 },
};
