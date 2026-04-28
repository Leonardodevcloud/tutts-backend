/**
 * playwright-bi-export.js
 * RPA: vai em entregasExportarExcel, configura filtros pra D-1, clica em
 * "Buscar dados" → depois em "Excel Relatório Power BI" (#button-excel-bi),
 * espera o link de download aparecer (#retorno-excel-link a[href]),
 * baixa o .xlsx e retorna o caminho local.
 *
 * Reusa muita lógica do playwright-performance.js (login, navegação),
 * mas muda credencial pra SISTEMA_EXTERNO_LIBERACAO_* (mesma conta do liberar-ponto).
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const { logger } = require('../../config/logger');

const SESSION_FILE_DEFAULT = '/tmp/tutts-rpa-bi-import-session.json';
const SCREENSHOT_DIR = '/tmp/screenshots';
const DOWNLOAD_DIR   = '/tmp/bi-imports';
const TIMEOUT        = 25000;
const NAV_TIMEOUT    = 60000;
const BUSCA_TIMEOUT  = 180000;  // 3min — buscar 1 dia inteiro pode demorar
const EXCEL_TIMEOUT  = 240000;  // 4min — gerar Excel BI demora MAIS

const LOGIN_URL = () => process.env.SISTEMA_EXTERNO_URL;
const EXCEL_URL = 'https://tutts.com.br/expresso/expressoat/entregasExportarExcel';

[SCREENSHOT_DIR, DOWNLOAD_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

let _sessionFileOverride = null;
let _credentialsOverride = null;
function getSessionFile() { return _sessionFileOverride || SESSION_FILE_DEFAULT; }
function setOverrides(opts) {
  _sessionFileOverride = (opts && opts.sessionFile) || null;
  _credentialsOverride = (opts && opts.credentials) || null;
}
function clearOverrides() { _sessionFileOverride = null; _credentialsOverride = null; }

function log(msg) { logger.info(`[playwright-bi-export] ${msg}`); }

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

async function screenshot(page, etapa) {
  try {
    const filename = `BI_${etapa}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false }).catch(() => {});
    log(`📸 ${filename}`);
    return filepath;
  } catch { return null; }
}

async function isLoggedIn(page) {
  try {
    await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1000);
    const url = page.url();
    return !url.includes('loginFuncionarioNovo') && !url.includes('login');
  } catch { return false; }
}

async function fazerLogin(page, overrides) {
  const email = (overrides && overrides.email) ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_EMAIL_1 ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_EMAIL ||
                process.env.SISTEMA_EXTERNO_EMAIL;
  const senha = (overrides && overrides.senha) ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_SENHA_1 ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_SENHA ||
                process.env.SISTEMA_EXTERNO_SENHA;

  if (!email || !senha) {
    throw new Error('SISTEMA_EXTERNO_LIBERACAO_EMAIL_1/SENHA_1 não configuradas.');
  }

  log(`🔐 Login: ${email}`);
  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    const ss = await screenshot(page, 'login_falhou');
    throw new Error(`Login não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
  }

  await page.fill('#loginEmail', email);
  await page.fill('input[type="password"]', senha);
  await page.locator('input[name="logar"]').first().click();

  await page.waitForURL(
    u => !u.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log(`✅ Login OK`);
}

/**
 * Configura todos os filtros conforme o uso manual:
 *  - Datas: D-1 (igual data inicial e final)
 *  - Status: Em execução + Concluídos
 *  - Endereços: Com endereços (CE)
 *  - Dados cliente: Com (CDC)
 *  - Dados profissional: Com (CDP)
 *  - Tipo veículo: 5 selecionados (sem Carro Utilitário Expresso)
 *  - Registros: 100 (mas pra puxar tudo, vou usar maior valor disponível)
 */
async function configurarFiltros(page, dataReferencia /* 'YYYY-MM-DD' */) {
  log(`📋 Configurando filtros pra data ${dataReferencia}`);

  // Converter YYYY-MM-DD → DD/MM/YYYY (formato do input)
  const [ano, mes, dia] = dataReferencia.split('-');
  const dataBR = `${dia}/${mes}/${ano}`;

  await page.evaluate((dt) => {
    // === Datas ===
    if (window.jQuery) {
      jQuery('#data').val(dt);
      jQuery('#dataF').val(dt);
    } else {
      const di = document.getElementById('data');
      const df = document.getElementById('dataF');
      if (di) di.value = dt;
      if (df) df.value = dt;
    }

    // === Endereços: Com endereços (CE) ===
    const radioEnd = document.querySelector('input[name="endereco"][value="CE"]');
    if (radioEnd) { radioEnd.checked = true; radioEnd.click(); }

    // === Dados profissional: Com (CDP) ===
    const radioProf = document.querySelector('input[name="profissional"][value="CDP"]');
    if (radioProf) { radioProf.checked = true; radioProf.click(); }

    // === Dados cliente: Com (CDC) — pode estar em select OU radio ===
    const radioCli = document.querySelector('input[name="cliente_dados"][value="CDC"]');
    if (radioCli) { radioCli.checked = true; radioCli.click(); }

    // === Status (serviço): Em execução (E) + Concluídos (F) ===
    const cbsStatus = document.querySelectorAll('input[name="statusOS"]');
    let temAlgumStatusMarcado = false;
    cbsStatus.forEach(cb => {
      const deveMarcar = (cb.value === 'E' || cb.value === 'F');
      cb.checked = deveMarcar;
      if (deveMarcar) temAlgumStatusMarcado = true;
      const btn = cb.closest('button.multiselect-option');
      if (btn) {
        if (deveMarcar) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });
    // Atualiza texto do multiselect se houver
    const multiTxts = document.querySelectorAll('.multiselect-selected-text');
    multiTxts.forEach(t => {
      // só mexe nos relevantes
      if (t.closest && t.closest('.btn-group')) {
        const dropdown = t.closest('.btn-group').querySelector('input[name="statusOS"]');
        if (dropdown) t.textContent = '2 selecionados';
      }
    });

    // === Tipo veículo (name="T") — desmarcar APENAS Carro Utilitário (Expresso) ===
    // Descobertas via DevTools (HTML real do sistema):
    //   - Os checkboxes têm name="T", NÃO "tipoVeiculo"
    //   - Carro Utilitário (Expresso) tem value="UC"
    //   - Motofrete (Expresso) tem value="MC"
    //   - O <label> fica em <label class="form-check-label"> dentro de <span class="form-check">
    const cbsVeiculo = document.querySelectorAll('input[name="T"]');
    cbsVeiculo.forEach(cb => {
      // Pega texto da label (irmã do input dentro do span.form-check)
      const label = cb.parentElement?.querySelector('label.form-check-label');
      const txt = (label?.textContent || '').toLowerCase().trim();
      const ehCarroUtilExpresso =
        cb.value === 'UC' ||
        (txt.includes('carro') && txt.includes('utilit') && txt.includes('expresso'));

      cb.checked = !ehCarroUtilExpresso;
      const btn = cb.closest('button.multiselect-option');
      if (btn) {
        if (!ehCarroUtilExpresso) btn.classList.add('active');
        else btn.classList.remove('active');
      }
      // Dispara evento change pra Bootstrap multiselect atualizar
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Atualiza texto do dropdown tipo veículo
    const tvBtnGroup = document.querySelectorAll('input[name="T"]')[0]?.closest('.btn-group');
    if (tvBtnGroup) {
      const txtSel = tvBtnGroup.querySelector('.multiselect-selected-text');
      if (txtSel) {
        const marcados = tvBtnGroup.querySelectorAll('input[name="T"]:checked').length;
        txtSel.textContent = marcados + ' selecionados';
      }
    }

    // === Registros por página ===
    const quantSel = document.getElementById('quantLimite');
    if (quantSel) {
      // Tenta pegar a maior opção (geralmente 10000 ou 1000 ou 100)
      let maior = '100';
      for (const opt of quantSel.options) {
        if (parseInt(opt.value, 10) > parseInt(maior, 10)) maior = opt.value;
      }
      quantSel.value = maior;
    }
  }, dataBR);

  await page.waitForTimeout(500);
  log(`✅ Filtros configurados`);
}

/**
 * Clica "Buscar dados" e espera tabela aparecer.
 */
async function executarBusca(page) {
  log('🔍 Clicando "Buscar dados"');
  await page.evaluate(() => {
    if (typeof buscaServicoExcel === 'function') {
      buscaServicoExcel(1, 0, '', null);
    } else {
      const b = document.querySelector('input[name="buscarDados"]');
      if (b) b.click();
    }
  });

  // Espera tabela ter algum conteúdo
  try {
    await page.waitForFunction(() => {
      const d = document.getElementById('divRetornoTable');
      return d && d.querySelectorAll('table tbody tr td').length > 0;
    }, { timeout: BUSCA_TIMEOUT });
  } catch (e) {
    const ss = await screenshot(page, 'busca_sem_resultado');
    throw new Error(`Busca não retornou dados em ${BUSCA_TIMEOUT/1000}s. Screenshot: ${ss}`);
  }
  await page.waitForTimeout(1500);
  log(`✅ Busca completa`);
}

/**
 * Clica em "Excel Relatório Power BI" (#button-excel-bi),
 * aguarda processamento, captura URL de download em #retorno-excel-link a[href].
 */
async function gerarELinkParaBI(page) {
  log('📊 Clicando "Excel Relatório Power BI"');

  const btnBi = page.locator('#button-excel-bi');
  if (!(await btnBi.isVisible().catch(() => false))) {
    const ss = await screenshot(page, 'sem_botao_bi');
    throw new Error(`Botão #button-excel-bi não visível (faltou clicar Buscar?). Screenshot: ${ss}`);
  }
  await btnBi.click();

  log(`⏳ Aguardando link de download em #retorno-excel-link a[href] (até ${EXCEL_TIMEOUT/1000}s)`);
  let downloadUrl = null;
  try {
    await page.waitForFunction(() => {
      const link = document.querySelector('#retorno-excel-link a[href]');
      return link && link.href && link.href.includes('http');
    }, { timeout: EXCEL_TIMEOUT });

    downloadUrl = await page.evaluate(() => {
      const link = document.querySelector('#retorno-excel-link a[href]');
      return link ? link.href : null;
    });
  } catch (e) {
    const ss = await screenshot(page, 'sem_link_download');
    throw new Error(`Sistema não gerou link de download em ${EXCEL_TIMEOUT/1000}s. Screenshot: ${ss}`);
  }

  if (!downloadUrl) {
    throw new Error(`Link de download capturado, mas href vazio.`);
  }

  log(`✅ URL do arquivo: ${downloadUrl.substring(0, 100)}...`);
  return downloadUrl;
}

/**
 * Baixa o arquivo da URL e salva em DOWNLOAD_DIR.
 * Retorna caminho local.
 */
function baixarArquivo(url, dataReferencia) {
  return new Promise((resolve, reject) => {
    const filename = `bi_${dataReferencia}_${Date.now()}.xlsx`;
    const filepath = path.join(DOWNLOAD_DIR, filename);
    const file = fs.createWriteStream(filepath);

    log(`⬇️  Baixando arquivo → ${filepath}`);
    const request = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(filepath); } catch (_) {}
        return reject(new Error(`Download HTTP ${res.statusCode} — ${url.substring(0, 100)}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          const stats = fs.statSync(filepath);
          log(`✅ Download concluído: ${(stats.size / 1024).toFixed(1)} KB`);
          resolve(filepath);
        });
      });
    });
    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(filepath); } catch (_) {}
      reject(err);
    });
    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error('Timeout 120s baixando arquivo'));
    });
  });
}

/**
 * FUNÇÃO PRINCIPAL — exportada e chamada pelo agente.
 * dataReferencia: 'YYYY-MM-DD' (ex: '2026-04-25' = D-1)
 *
 * Retorna: { sucesso, arquivo_path, erro?, screenshot_path? }
 */
async function executarExportBI({ dataReferencia, onProgresso }) {
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
    log(`🚀 Export BI | data=${dataReferencia}`);
    reportar('iniciando', 5);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const sessionPath = getSessionFile();
    const sessionExiste = fs.existsSync(sessionPath);
    context = await browser.newContext(sessionExiste ? { storageState: sessionPath } : {});
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Passo 1: Login
    reportar('login', 10);
    let logado = false;
    if (sessionExiste) {
      logado = await isLoggedIn(page);
      if (!logado) { try { fs.unlinkSync(sessionPath); } catch (_) {} }
    }
    if (!logado) {
      await fazerLogin(page, _credentialsOverride);
      await context.storageState({ path: sessionPath });
      log(`💾 Sessão salva`);
    }

    // Passo 2: Vai pra exportação Excel
    reportar('navegando', 20);
    await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500);
    const temForm = await page.evaluate(() => !!document.getElementById('data'));
    if (!temForm) {
      const ss = await screenshot(page, 'sem_form');
      throw new Error(`Página de filtros não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
    }

    // Passo 3: Configurar filtros
    reportar('configurando_filtros', 30);
    await configurarFiltros(page, dataReferencia);

    // Passo 4: Buscar
    reportar('buscando', 45);
    await executarBusca(page);

    // Passo 5: Gerar Excel BI
    reportar('gerando_excel', 65);
    const downloadUrl = await gerarELinkParaBI(page);

    // Passo 6: Baixar
    reportar('baixando', 85);
    const arquivoPath = await baixarArquivo(downloadUrl, dataReferencia);

    reportar('concluido', 100);
    log(`✅ Export concluído: ${arquivoPath}`);
    return { sucesso: true, arquivo_path: arquivoPath };

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    let ss = null;
    if (page) ss = await screenshot(page, 'erro_inesperado');
    return {
      sucesso: false,
      erro: err.message.slice(0, 500),
      screenshot_path: ss,
    };
  } finally {
    await fecharBrowserSeguro(browser);
  }
}

module.exports = { executarExportBI, setOverrides, clearOverrides };
