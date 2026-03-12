/**
 * playwright-performance.js
 * Automação RPA: acessa entregasExportarExcel, aplica filtros,
 * lê a tabela e retorna array de entregas para cálculo de SLA.
 *
 * Seletores 100% mapeados do HTML real (console dump):
 *   Data inicial      : #data                    (type=text, value="12/03/2026")
 *   Data final        : #dataF                   (type=text)
 *   Com endereços     : input[name="endereco"][value="CE"]    (radio)
 *   Com dados prof    : input[name="profissional"][value="CDP"] (radio)
 *   Status multiselect: #status (select-multiple) + checkboxes name=statusOS value=F
 *   Cliente específico: input[name="cliente"][value="CE"]     (radio)
 *   Input cliente vis : #autocomplet-cliente      (text)
 *   Input cliente hid : #codCliente               (hidden)
 *   Centro de custo   : #centrocusto-cliente      (select-one)
 *   Qtd por página    : #quantLimite → "500"
 *   Botão buscar      : input[name="buscarDados"] (type=button)
 *
 *   Colunas tabela:
 *   [0] Serviço  [1] Cliente  [3] Distância  [4] Profissional
 *   [5] Data/Agendado  [11] Finalizado
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

const SESSION_FILE_PERF = '/tmp/tutts-perf-session.json';
const TIMEOUT           = 30_000;
const EXCEL_URL         = 'https://tutts.com.br/expresso/expressoat/entregasExportarExcel';
const LOGIN_URL         = () => process.env.SISTEMA_EXTERNO_URL;

function log(msg) { logger.info(`[playwright-perf] ${msg}`); }

// ─────────────────────────────────────────────────────────────
// TABELA DE PRAZOS (espelho do bookmarklet v5.4)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// LOGIN (reutiliza padrão do playwright-agent.js)
// ─────────────────────────────────────────────────────────────
async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');
  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) throw new Error(`Página de login não carregou. URL: ${page.url()}`);

  await page.fill('#loginEmail', process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.SISTEMA_EXTERNO_SENHA);
  await page.locator('input[name="logar"]').first().click();
  await page.waitForURL(
    url => !url.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log('✅ Login OK');
}

// ─────────────────────────────────────────────────────────────
// PREENCHER FILTROS
// ─────────────────────────────────────────────────────────────
async function preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto }) {
  log('📋 Preenchendo filtros...');

  // Datas — triple-click para selecionar tudo antes de digitar
  await page.click('#data', { clickCount: 3 });
  await page.fill('#data',  dataInicio);   // formato DD/MM/YYYY
  await page.click('#dataF', { clickCount: 3 });
  await page.fill('#dataF', dataFim);
  log(`  📅 Datas: ${dataInicio} → ${dataFim}`);

  // Com endereços (radio CE)
  await page.check('input[name="endereco"][value="CE"]');
  log('  ✅ Com endereços');

  // Com dados profissional (radio CDP)
  await page.check('input[name="profissional"][value="CDP"]');
  log('  ✅ Com dados profissional');

  // Status = Concluído — select-multiple com plugin multiselect
  // Estratégia: setar via JS direto no select nativo + checkboxes do plugin
  await page.evaluate(() => {
    const sel = document.getElementById('status');
    if (!sel) return;
    for (const opt of sel.options) opt.selected = (opt.value === 'F');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // Sincroniza os checkboxes visuais do plugin multiselect
    document.querySelectorAll('input[name="statusOS"]').forEach(cb => {
      cb.checked = cb.value === 'F';
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  log('  ✅ Status = Concluído (F)');

  // Qtd por página = 500
  await page.selectOption('#quantLimite', '500');
  log('  ✅ Qtd/página: 500');

  // Cliente específico
  if (codCliente) {
    await page.check('input[name="cliente"][value="CE"]');
    await page.waitForTimeout(400);

    await page.evaluate((cod) => {
      const hidden = document.getElementById('codCliente');
      if (hidden) hidden.value = String(cod);
      const txt = document.getElementById('autocomplet-cliente');
      if (txt) {
        txt.value = String(cod);
        txt.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, codCliente);
    log(`  ✅ Cliente: ${codCliente}`);

    // Centro de custo — aguarda select ser populado pelo cliente
    if (centroCusto) {
      await page.waitForFunction(
        () => document.querySelectorAll('#centrocusto-cliente option').length > 1,
        { timeout: 5000 }
      ).catch(() => log('  ⚠️  CC: select não populado'));

      await page.selectOption('#centrocusto-cliente', centroCusto).catch(() => {
        log(`  ⚠️  CC "${centroCusto}" não encontrado`);
      });
      log(`  ✅ Centro de custo: ${centroCusto}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// LER TABELA (todas as páginas)
// ─────────────────────────────────────────────────────────────
async function lerTabela(page) {
  const todasLinhas = [];
  let pagina = 1;

  while (true) {
    log(`📄 Lendo página ${pagina}...`);

    const linhas = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const dados = [];
      rows.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 12) return;
        dados.push({
          os:           tds[0]?.textContent?.trim() || '',
          cliente_txt:  tds[1]?.textContent?.trim() || '',
          distancia:    tds[3]?.textContent?.trim() || '',
          profissional: tds[4]?.textContent?.trim() || '',
          data_hora:    tds[5]?.textContent?.trim() || '',
          finalizado:   tds[11]?.textContent?.trim() || '',
        });
      });
      return dados;
    });

    todasLinhas.push(...linhas);
    log(`  → ${linhas.length} linhas`);

    // Verifica próxima página (Bootstrap pagination padrão)
    const temProxima = await page.evaluate(() => {
      const sels = [
        'a[data-page][aria-label="Próximo"]',
        '.pagination li.next:not(.disabled) a',
        '.pagination a[rel="next"]',
        '.paginate_button.next:not(.disabled)',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && !el.closest('.disabled')) return true;
      }
      return false;
    });

    if (!temProxima || linhas.length < 10) break;

    await page.locator([
      'a[data-page][aria-label="Próximo"]',
      '.pagination li.next:not(.disabled) a',
      '.paginate_button.next:not(.disabled)',
    ].join(', ')).first().click();

    await page.waitForTimeout(1500);
    pagina++;
    if (pagina > 20) { log('⚠️  Limite de 20 páginas'); break; }
  }

  log(`📊 Total: ${todasLinhas.length} linhas lidas`);
  return todasLinhas;
}

// ─────────────────────────────────────────────────────────────
// CALCULAR SLA POR LINHA
// ─────────────────────────────────────────────────────────────
function calcularLinhas(linhas) {
  return linhas.map(linha => {
    const mCli    = linha.cliente_txt.match(/^\s*(\d+)\s*[-–]/);
    const codCli  = mCli ? parseInt(mCli[1]) : null;
    const nomeCli = linha.cliente_txt.replace(/^\s*\d+\s*[-–]\s*/, '').trim();

    const mKm = linha.distancia.match(/([\d]+[.,][\d]+)/);
    const km  = mKm ? parseFloat(mKm[1].replace(',', '.')) : null;

    const prazo = (codCli !== null && CLIENTES_PRAZO_FIXO[codCli] !== undefined)
      ? CLIENTES_PRAZO_FIXO[codCli]
      : (km !== null ? getPrazoPorKm(km) : null);

    // col[5] pode vir como "DD/MM/YYYY HH:MM" ou "DD/MM/YYYY HH:MM / DD/MM/YYYY HH:MM" (agendado)
    // parseDataBR extrai a PRIMEIRA data encontrada
    const dtCriacao = parseDataBR(linha.data_hora);
    const dtFinal   = parseDataBR(linha.finalizado);

    let sla_no_prazo = null;
    let duracao_min  = null;
    let delta_min    = null;
    const sem_dados  = !prazo || !dtCriacao || !dtFinal;

    if (!sem_dados) {
      duracao_min  = Math.round((dtFinal - dtCriacao) / 60000);
      sla_no_prazo = duracao_min <= prazo;
      delta_min    = Math.abs(duracao_min - prazo);
    }

    return {
      os: linha.os,
      cliente_txt:  linha.cliente_txt,
      cod_cliente:  codCli,
      nome_cliente: nomeCli,
      profissional: linha.profissional,
      km,
      prazo_min:   prazo,
      data_criacao: dtCriacao?.toISOString() ?? null,
      finalizado:   dtFinal?.toISOString() ?? null,
      sla_no_prazo,
      duracao_min,
      delta_min,
      sem_dados,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// AGRUPAMENTO POR CLIENTE
// ─────────────────────────────────────────────────────────────
function agruparPorCliente(registros) {
  const mapa = {};
  for (const r of registros) {
    const key = r.cod_cliente ?? '__sem__';
    if (!mapa[key]) {
      mapa[key] = {
        cod_cliente:  r.cod_cliente,
        nome_cliente: r.nome_cliente,
        total: 0, no_prazo: 0, fora_prazo: 0, sem_dados: 0,
      };
    }
    mapa[key].total++;
    if (r.sem_dados)         mapa[key].sem_dados++;
    else if (r.sla_no_prazo) mapa[key].no_prazo++;
    else                     mapa[key].fora_prazo++;
  }

  return Object.values(mapa)
    .map(c => ({
      ...c,
      pct_no_prazo: (c.total - c.sem_dados) > 0
        ? parseFloat(((c.no_prazo / (c.total - c.sem_dados)) * 100).toFixed(2))
        : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

// ─────────────────────────────────────────────────────────────
// EXPORTAÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────
async function buscarPerformance({ dataInicio, dataFim, codCliente, centroCusto }) {
  if (!process.env.SISTEMA_EXTERNO_URL) {
    throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  }

  log(`🚀 Iniciando: ${dataInicio}→${dataFim} | cli=${codCliente ?? 'todos'} | cc=${centroCusto ?? '—'}`);

  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE_PERF)) {
    contextOptions = { storageState: SESSION_FILE_PERF };
    log('♻️  Usando sessão salva');
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
    // 1. Navega + login
    await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1000);

    if (!(await isLoggedIn(page))) {
      if (fs.existsSync(SESSION_FILE_PERF)) { fs.unlinkSync(SESSION_FILE_PERF); log('🗑️  Sessão inválida'); }
      await fazerLogin(page);
      await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(1000);
      await context.storageState({ path: SESSION_FILE_PERF });
      log('💾 Sessão salva');
    } else {
      log('✅ Já logado');
    }

    // 2. Filtros
    await preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto });

    // 3. Busca
    log('🔍 Clicando Buscar dados...');
    await page.click('input[name="buscarDados"]');
    await page.waitForSelector('table tbody tr td', { timeout: TIMEOUT });
    await page.waitForTimeout(1500);
    log('✅ Tabela carregada');

    // 4. Lê páginas
    const linhasBrutas = await lerTabela(page);

    // 5. Calcula
    const registros  = calcularLinhas(linhasBrutas);
    const total      = registros.length;
    const no_prazo   = registros.filter(r => r.sla_no_prazo === true).length;
    const fora_prazo = registros.filter(r => r.sla_no_prazo === false).length;
    const sem_dados  = registros.filter(r => r.sem_dados).length;
    const analisados = total - sem_dados;
    const pct_no_prazo = analisados > 0
      ? parseFloat(((no_prazo / analisados) * 100).toFixed(2)) : 0;

    log(`✅ ${total} OS | ${no_prazo}✓ | ${fora_prazo}✗ | ${sem_dados} s/dados | ${pct_no_prazo}%`);

    return { total, no_prazo, fora_prazo, sem_dados, pct_no_prazo,
             por_cliente: agruparPorCliente(registros), registros };

  } finally {
    await browser.close();
  }
}

module.exports = { buscarPerformance };
