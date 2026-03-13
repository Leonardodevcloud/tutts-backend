/**
 * playwright-performance.js — v7
 * Navegação via sidebar: hamburger → Serviços → Relatórios
 * Seletores confirmados:
 *   Hamburger:  a.dashboard (no header)
 *   Serviços:   sidebar a com texto "Serviços" → expande ul#sidebar_servicos
 *   Relatórios: a[href="entregasExportarExcel"] dentro de #sidebar_servicos
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const { logger } = require('../../config/logger');

const SESSION_FILE_PERF = '/tmp/tutts-perf-session.json';
const SCREENSHOT_DIR    = '/tmp/screenshots';
const TIMEOUT           = 60_000;
const EXCEL_URL         = 'https://tutts.com.br/expresso/expressoat/entregasExportarExcel';
const LOGIN_URL         = () => process.env.SISTEMA_EXTERNO_URL;

function log(msg) { logger.info(`[playwright-perf] ${msg}`); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

const TABELA_PRAZOS_KM = [
  [0,10,60],[10,15,75],[15,20,90],[20,25,105],[25,30,120],
  [30,35,135],[35,40,150],[40,45,165],[45,50,180],[50,55,195],
  [55,60,210],[60,65,225],[65,70,240],[70,75,255],[75,80,270],
];
const CLIENTES_PRAZO_FIXO = { 767: 120 };

function getPrazoPorKm(km) {
  for (const [de, ate, min] of TABELA_PRAZOS_KM) {
    if (km >= de && km < ate) return min;
  }
  return 270 + Math.ceil((km - 80) / 5) * 15;
}

function parseDataBR(texto) {
  if (!texto) return null;
  const m = texto.trim().match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, a, h, mi, s] = m;
  return new Date(+a, +mo - 1, +d, +h, +mi, +(s || 0));
}

async function screenshotDebug(page, nome) {
  try {
    ensureDir(SCREENSHOT_DIR);
    const file = `${SCREENSHOT_DIR}/perf-${nome}-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: false });
    log(`📸 Screenshot: ${file}`);
  } catch (e) { log(`⚠️ Screenshot falhou: ${e.message}`); }
}

// ── LOGIN ───────────────────────────────────────────────────
async function fazerLogin(page) {
  log('🔐 Fazendo login...');
  await page.goto(LOGIN_URL(), { waitUntil: 'networkidle', timeout: TIMEOUT });
  await page.waitForTimeout(2000);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) throw new Error(`Página de login não carregou. URL: ${page.url()}`);

  await page.fill('#loginEmail', process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.SISTEMA_EXTERNO_SENHA);
  await page.locator('input[name="logar"]').first().click();

  // Esperar redirect pós-login (vai pra principal.php)
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT }).catch(() => {});
  await page.waitForTimeout(3000);

  if (page.url().includes('loginFuncionarioNovo')) {
    throw new Error('Login falhou — ainda na página de login');
  }
  log(`✅ Login OK → ${page.url()}`);
}

// ── NAVEGAR VIA SIDEBAR ─────────────────────────────────────
async function navegarViaMenu(page) {
  log('📂 Navegando via menu lateral...');

  // 1. Abrir sidebar — clicar no hamburger (a.dashboard no header)
  await page.evaluate(() => {
    const hamburger = document.querySelector('a.dashboard');
    if (hamburger) hamburger.click();
  });
  await page.waitForTimeout(1500);
  log('  ✅ Sidebar aberto');

  // 2. Clicar em "Serviços" pra expandir submenu
  await page.evaluate(() => {
    // Procurar o link "Serviços" na sidebar
    const links = document.querySelectorAll('.sidebar-menu a');
    for (const a of links) {
      if (a.textContent.trim().toLowerCase().includes('serviço')) {
        a.click();
        return;
      }
    }
  });
  await page.waitForTimeout(1000);
  log('  ✅ Serviços expandido');

  // 3. Clicar em "Relatórios" (href="entregasExportarExcel")
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      const link = document.querySelector('a[href="entregasExportarExcel"]')
                || document.querySelector('#sidebar_servicos a[href*="entregasExportarExcel"]');
      if (link) { link.click(); return true; }
      // Fallback: navegar direto
      window.location.href = 'entregasExportarExcel';
      return false;
    }),
  ]);
  await page.waitForTimeout(3000);
  log(`  📍 URL: ${page.url()}`);
}

// ── CHEGAR NA PÁGINA DE FILTROS ─────────────────────────────
async function navegarParaFiltros(page, context) {

  // TENTATIVA 1: URL direta (funciona se sessão salva válida)
  log('🌐 Tentativa 1: URL direta...');
  await page.goto(EXCEL_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
  await page.waitForTimeout(2000);
  let url = page.url();
  log(`📍 URL: ${url}`);

  // Se caiu no login
  if (url.includes('loginFuncionarioNovo') || url.includes('login')) {
    log('🔒 Precisa login');
    if (fs.existsSync(SESSION_FILE_PERF)) {
      fs.unlinkSync(SESSION_FILE_PERF);
      log('🗑️ Sessão removida');
    }
    await fazerLogin(page);
    await context.storageState({ path: SESSION_FILE_PERF });
    log('💾 Sessão salva');

    // Após login estamos em principal.php — navegar via menu
    await navegarViaMenu(page);
    url = page.url();
  }

  // Se não chegou na página certa (redirecionou pra principal.php)
  if (!url.includes('entregasExportarExcel')) {
    log('⚠️ Não na página certa, tentando via menu...');
    await navegarViaMenu(page);
    url = page.url();
  }

  // TENTATIVA FINAL: goto direto (agora já está logado, pode funcionar)
  if (!url.includes('entregasExportarExcel')) {
    log('🔄 Última tentativa: goto direto...');
    await page.goto(EXCEL_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    url = page.url();
    log(`📍 URL final: ${url}`);
  }

  // Verificar formulário
  const temData = await page.evaluate(() => !!document.getElementById('data'));
  if (temData) {
    log('✅ Formulário detectado');
    return;
  }

  await screenshotDebug(page, 'no-form');
  const info = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    body: document.body?.innerText?.slice(0, 200) || '',
  }));
  throw new Error(`Formulário não encontrado. URL=${info.url} | Title=${info.title} | Body=${info.body.slice(0, 100)}`);
}

// ── PREENCHER FILTROS ───────────────────────────────────────
async function preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto }) {
  log('📋 Preenchendo filtros...');

  await page.evaluate(({ di, df }) => {
    if (window.jQuery) { jQuery('#data').val(di); jQuery('#dataF').val(df); }
    else { document.getElementById('data').value = di; document.getElementById('dataF').value = df; }

    const radioEnd = document.querySelector('input[name="endereco"][value="CE"]');
    if (radioEnd) { radioEnd.checked = true; radioEnd.click(); }

    const radioProf = document.querySelector('input[name="profissional"][value="CDP"]');
    if (radioProf) { radioProf.checked = true; radioProf.click(); }

    const sel = document.getElementById('status');
    if (sel) {
      for (const opt of sel.options) opt.selected = (opt.value === 'F');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelectorAll('input[name="statusOS"]').forEach(cb => {
      const check = (cb.value === 'F');
      cb.checked = check;
      const btn = cb.closest('button.multiselect-option');
      if (btn) { if (check) btn.classList.add('active'); else btn.classList.remove('active'); }
    });
    const msTxt = document.querySelector('.multiselect-selected-text');
    if (msTxt) msTxt.textContent = 'Concluídos';

    const quantSel = document.getElementById('quantLimite');
    if (quantSel) quantSel.value = '10000';
  }, { di: dataInicio, df: dataFim });

  log(`  📅 ${dataInicio} → ${dataFim} | End=CE | Prof=CDP | Status=F | Pag=10000`);

  if (codCliente) {
    await page.evaluate(() => {
      const radio = document.querySelector('input[name="cliente"][value="CE"]');
      if (radio) radio.click();
    });
    await page.waitForTimeout(800);

    await page.evaluate((cod) => {
      document.getElementById('codCliente').value = String(cod);
    }, codCliente);

    const input = page.locator('#autocomplet-cliente');
    await input.click();
    await input.fill('');
    await input.type(String(codCliente), { delay: 100 });
    log(`  ⌨️ Digitou "${codCliente}"`);

    try {
      await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 10000 });
      await page.click('ul.ui-autocomplete li.ui-menu-item:first-child');
      log('  ✅ Cliente selecionado');
    } catch {
      log('  ⚠️ Autocomplete timeout, forçando');
      await page.evaluate((cod) => {
        document.getElementById('codCliente').value = String(cod);
        document.getElementById('autocomplet-cliente').value = String(cod);
      }, codCliente);
    }
    await page.waitForTimeout(1000);

    if (centroCusto) {
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('#centrocusto-cliente option').length > 1,
          { timeout: 10000 }
        );
        await page.evaluate((cc) => {
          const s = document.getElementById('centrocusto-cliente');
          if (s) { s.value = cc; s.dispatchEvent(new Event('change', { bubbles: true })); }
        }, centroCusto);
        log(`  ✅ CC: ${centroCusto}`);
      } catch { log('  ⚠️ CC não carregou'); }
    }
    log(`  ✅ Cliente: ${codCliente}`);
  }
}

// ── LER TABELA ──────────────────────────────────────────────
async function lerTabela(page) {
  const todasLinhas = [];
  let pagina = 1;
  while (true) {
    log(`📄 Página ${pagina}...`);
    const linhas = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('#divRetornoTable table thead th'));
      const idx = {};
      ths.forEach((th, i) => {
        const t = (th.textContent || '').trim().toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (t.includes('servic'))     idx.os = i;
        if (t.includes('cliente'))    idx.cliente = i;
        if (t.includes('distanc'))    idx.distancia = i;
        if (t.includes('data'))       idx.data = i;
        if (t.includes('finalizado')) idx.finalizado = i;
      });
      const rows = document.querySelectorAll('#divRetornoTable table tbody tr');
      const dados = [];
      rows.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 5) return;
        const first = (tds[0]?.textContent || '').trim();
        if (first.toLowerCase().startsWith('total')) return;
        if (tds[0]?.getAttribute('colspan')) return;
        dados.push({
          os: first,
          cliente_txt: idx.cliente != null ? (tds[idx.cliente]?.textContent || '').trim() : '',
          distancia:   idx.distancia != null ? (tds[idx.distancia]?.textContent || '').trim() : '',
          data_hora:   idx.data != null ? (tds[idx.data]?.textContent || '').trim() : '',
          finalizado:  idx.finalizado != null ? (tds[idx.finalizado]?.textContent || '').trim() : '',
        });
      });
      return dados;
    });
    todasLinhas.push(...linhas);
    log(`  → ${linhas.length} linhas`);
    const temProxima = await page.evaluate(() => {
      for (const s of ['a[data-page][aria-label="Próximo"]', '.pagination li.next:not(.disabled) a']) {
        const el = document.querySelector(s); if (el && !el.closest('.disabled')) return true;
      }
      return false;
    });
    if (!temProxima || linhas.length < 10) break;
    await page.evaluate(() => {
      for (const s of ['a[data-page][aria-label="Próximo"]', '.pagination li.next:not(.disabled) a']) {
        const el = document.querySelector(s); if (el) { el.click(); return; }
      }
    });
    await page.waitForTimeout(2500);
    pagina++;
    if (pagina > 20) break;
  }
  log(`📊 Total: ${todasLinhas.length} linhas`);
  return todasLinhas;
}

// ── SLA ─────────────────────────────────────────────────────
function calcularLinhas(linhas) {
  return linhas.map(linha => {
    const mCli = linha.cliente_txt.match(/^\s*(\d+)\s*[-–]/);
    const codCli = mCli ? parseInt(mCli[1]) : null;
    const nomeCli = linha.cliente_txt.replace(/^\s*\d+\s*[-–]\s*/, '').split('\n')[0].trim();
    const linhasTexto = linha.cliente_txt.split('\n').map(l => l.trim()).filter(Boolean);
    const profissional = linhasTexto.length >= 2 ? linhasTexto[1] : '';
    const mKm = linha.distancia.match(/([\d]+[.,][\d]+)/);
    const km = mKm ? parseFloat(mKm[1].replace(',', '.')) : null;
    const prazo = (codCli !== null && CLIENTES_PRAZO_FIXO[codCli] !== undefined)
      ? CLIENTES_PRAZO_FIXO[codCli] : (km !== null ? getPrazoPorKm(km) : null);
    const dtCriacao = parseDataBR(linha.data_hora);
    const dtFinal = parseDataBR(linha.finalizado);
    let sla_no_prazo = null, duracao_min = null, delta_min = null;
    const sem_dados = !prazo || !dtCriacao || !dtFinal;
    if (!sem_dados) {
      duracao_min = Math.round((dtFinal - dtCriacao) / 60000);
      sla_no_prazo = duracao_min <= prazo;
      delta_min = Math.abs(duracao_min - prazo);
    }
    return { os: linha.os, cliente_txt: linha.cliente_txt, cod_cliente: codCli,
      nome_cliente: nomeCli, profissional, km, prazo_min: prazo,
      data_criacao: dtCriacao?.toISOString() ?? null,
      finalizado: dtFinal?.toISOString() ?? null,
      sla_no_prazo, duracao_min, delta_min, sem_dados };
  });
}

function agruparPorCliente(registros) {
  const mapa = {};
  for (const r of registros) {
    const key = r.cod_cliente ?? '__sem__';
    if (!mapa[key]) {
      mapa[key] = { cod_cliente: r.cod_cliente, nome_cliente: r.nome_cliente,
        total: 0, no_prazo: 0, fora_prazo: 0, sem_dados: 0 };
    }
    mapa[key].total++;
    if (r.sem_dados) mapa[key].sem_dados++;
    else if (r.sla_no_prazo) mapa[key].no_prazo++;
    else mapa[key].fora_prazo++;
  }
  return Object.values(mapa)
    .map(c => ({ ...c,
      pct_no_prazo: (c.total - c.sem_dados) > 0
        ? parseFloat(((c.no_prazo / (c.total - c.sem_dados)) * 100).toFixed(2)) : 0 }))
    .sort((a, b) => b.total - a.total);
}

// ══════════════════════════════════════════════════════════════
async function buscarPerformance({ dataInicio, dataFim, codCliente, centroCusto }) {
  if (!process.env.SISTEMA_EXTERNO_URL) throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  log(`🚀 ${dataInicio}→${dataFim} | cli=${codCliente ?? 'todos'} | cc=${centroCusto ?? '—'}`);

  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE_PERF)) {
    contextOptions = { storageState: SESSION_FILE_PERF };
    log('♻️ Sessão encontrada');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    await navegarParaFiltros(page, context);
    await preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto });
    await page.waitForTimeout(500);

    log('🔍 Executando busca...');
    await page.evaluate(() => {
      if (typeof buscaServicoExcel === 'function') buscaServicoExcel(1, 0, '', null);
      else { const b = document.querySelector('input[name="buscarDados"]'); if (b) b.click(); }
    });

    log('⏳ Aguardando resultado...');
    try {
      await page.waitForFunction(
        () => { const d = document.getElementById('divRetornoTable');
          return d && d.querySelectorAll('table tbody tr td').length > 0; },
        { timeout: 120_000 }
      );
    } catch {
      await screenshotDebug(page, 'no-table');
      const html = await page.evaluate(() => {
        const d = document.getElementById('divRetornoTable');
        return d ? d.innerHTML.slice(0, 300) : 'div não encontrado';
      });
      throw new Error(`Tabela não carregou. Content: ${html.slice(0, 200)}`);
    }
    await page.waitForTimeout(2000);
    log('✅ Tabela carregada');

    const linhasBrutas = await lerTabela(page);
    const registros = calcularLinhas(linhasBrutas);
    const total = registros.length;
    const no_prazo = registros.filter(r => r.sla_no_prazo === true).length;
    const fora_prazo = registros.filter(r => r.sla_no_prazo === false).length;
    const sem_dados = registros.filter(r => r.sem_dados).length;
    const analisados = total - sem_dados;
    const pct_no_prazo = analisados > 0
      ? parseFloat(((no_prazo / analisados) * 100).toFixed(2)) : 0;
    log(`✅ ${total} OS | ${no_prazo}✓ | ${fora_prazo}✗ | ${sem_dados}? | ${pct_no_prazo}%`);

    return { total, no_prazo, fora_prazo, sem_dados, pct_no_prazo,
      por_cliente: agruparPorCliente(registros), registros };

  } catch (err) {
    await screenshotDebug(page, 'error');
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { buscarPerformance };
