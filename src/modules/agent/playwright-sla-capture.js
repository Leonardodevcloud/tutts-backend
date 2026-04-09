/**
 * playwright-sla-capture.js
 * Captura pontos de uma OS via endpoint AJAX do MAP (sem abrir UI de modal).
 *
 * ARQUITETURA:
 *   - Sessão ISOLADA do agent-worker (arquivo/credencial separados)
 *   - Login com SISTEMA_EXTERNO_SLA_EMAIL / SISTEMA_EXTERNO_SLA_SENHA
 *   - Navega pra /acompanhamento-servicos (mantém cookie de sessão válido)
 *   - Fetch direto em ajaxModalInformacoesServico.php → HTML do modal
 *   - Parseia texto dos pontos e aplica parser 814 ou 767
 *
 * IMPORTANTE:
 *   - Credencial precisa ser diferente da do agent E da do operador,
 *     senão o MAP invalida sessões quando múltiplas abas estão abertas.
 *   - Mutex interno garante 1 captura por vez nesta sessão.
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

const URL_RESUMO_SERVICO =
  'https://tutts.com.br/expresso/expressoat/entregasStatus/ajaxModalInformacoesServico.php';

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
// FETCH AJAX — busca HTML do modal sem abrir UI
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Captura o atributo data-parameters do botão "Resumo Serviço" da row da OS.
 * Esse parâmetro é o que o PHP precisa pra retornar o HTML do modal de info.
 */
async function capturarParametroResumo(page, osNumero) {
  try {
    // Localiza a row pelo botão de endereço (data-text-id = OS)
    const param = await page.evaluate((os) => {
      const btn = document.querySelector(
        `button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="${os}"]`
      );
      if (!btn) return null;
      const row = btn.closest('tr');
      if (!row) return null;
      const link = row.querySelector(
        'a.dropdown-item[data-action="ajaxModalInformacoesServico"], [data-action="ajaxModalInformacoesServico"]'
      );
      if (!link) return null;
      return link.getAttribute('data-parameters') || link.getAttribute('data-parameter') || null;
    }, osNumero);

    return param;
  } catch (_) {
    return null;
  }
}

/**
 * Faz fetch direto no endpoint AJAX do MAP usando o cookie de sessão da page.
 * Retorna o HTML bruto do modal.
 */
async function fetchHtmlModal(page, parametro) {
  if (!parametro) return null;

  const resposta = await page.evaluate(
    async ({ url, param }) => {
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
    },
    { url: URL_RESUMO_SERVICO, param: parametro }
  );

  if (resposta.__erro) {
    throw new Error(`Fetch modal falhou: ${resposta.__erro}`);
  }
  return resposta.__html;
}

// ═════════════════════════════════════════════════════════════════════════════
// PARSERS — HTML → texto → pontos (portados da extensão v7.15)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Converte HTML do modal em texto limpo. Mantém quebras pra separar pontos.
 */
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Extrai blocos de pontos do texto do modal.
 * Retorna [{ numero: Number, texto: String }, ...]
 */
function extrairPontos(textoModal) {
  if (!textoModal) return [];

  // Normaliza em linha única pra regex global
  const linha = textoModal.replace(/\s+/g, ' ').trim();

  // Match todos "Ponto N" (até 9 pontos) e captura o texto até o próximo "Ponto M" ou fim
  const regex = /Ponto\s+(\d+)\s*[-–:]?\s*([\s\S]*?)(?=Ponto\s+\d+\s*[-–:]?|$)/gi;
  const pontos = [];
  let m;
  while ((m = regex.exec(linha)) !== null) {
    const numero = parseInt(m[1], 10);
    const texto = (m[2] || '').trim();
    if (numero >= 1 && numero <= 9 && texto) {
      pontos.push({ numero, texto });
    }
  }
  return pontos;
}

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

    // Navega pra página de acompanhamento
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1000);

    // Confirma sessão — se não, relogin
    if (!(await isLoggedIn(page))) {
      await fazerLogin(page);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(1000);
    }

    // Persiste cookies pra próxima captura reaproveitar
    try {
      await context.storageState({ path: SESSION_FILE });
    } catch (_) {}

    // Precisa localizar a row da OS — por segurança ativa a aba Execução se existir
    try {
      const tabExec = page.locator('#pills-em-execucao-tab');
      if (await tabExec.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tabExec.click();
        await page.waitForTimeout(800);
      }
    } catch (_) {}

    // Busca pela OS — pode precisar aguardar carregamento do tbody
    await page
      .waitForSelector(`tr[data-order-id="${os_numero}"]`, { timeout: 10000 })
      .catch(() => {
        // Pode não estar na tela atual — tenta buscar via search-type
      });

    let parametro = await capturarParametroResumo(page, os_numero);

    // Se não achou, tenta re-buscar usando o campo de busca do sistema
    if (!parametro) {
      try {
        // Seleciona tipo "OS" no custom-select e digita o número
        const searchInput = page.locator('input[type="text"]').first();
        if (await searchInput.isVisible({ timeout: 2000 })) {
          await searchInput.fill(String(os_numero));
          await page.waitForTimeout(1500);
          await page
            .waitForSelector(`tr[data-order-id="${os_numero}"]`, { timeout: 8000 })
            .catch(() => {});
          parametro = await capturarParametroResumo(page, os_numero);
        }
      } catch (_) {}
    }

    if (!parametro) {
      throw new Error(`OS ${os_numero} não encontrada na tela ou sem parâmetro de resumo.`);
    }

    // Fetch direto do HTML do modal (~300ms)
    const html = await fetchHtmlModal(page, parametro);
    const texto = htmlToText(html);
    const pontosBrutos = extrairPontos(texto);

    if (pontosBrutos.length === 0) {
      throw new Error(`Nenhum ponto extraído do HTML do modal (OS ${os_numero}).`);
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
        return { pontos: [], skipped: true, motivo: 'ponto1_nao_bate_767' };
      }
      pontosParsed = pontosBrutos
        .filter((pt) => pt.numero >= 2)
        .map((pt) => ({ numero: pt.numero, ...(parseEntrega767(pt.texto) || {}) }));
    }

    if (pontosParsed.length === 0) {
      return { pontos: [], skipped: true, motivo: 'sem_pontos_entrega' };
    }

    return { pontos: pontosParsed, skipped: false };
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
  _internal: { htmlToText, extrairPontos, parseEntrega814, parseEntrega767, ponto1Bate767 },
};
