/**
 * playwright-performance.js — v4
 * Seletores 100% confirmados por Inspect Element (13/03/2026)
 *
 * ════════════════════════════════════════════════════════════
 * MAPA DE SELETORES:
 *
 * DATA INICIAL:   input#data[type=text][readonly] — jQuery UI datepicker
 * DATA FINAL:     input#dataF[type=text][readonly] — jQuery UI datepicker
 * COM ENDEREÇO:   input[name="endereco"][value="CE"] (radio)
 * COM DADOS PROF: input[name="profissional"][value="CDP"] (radio)
 * STATUS:         select#status[multiple] + bootstrap-multiselect
 *                 → checkboxes: input.form-check-input[name="statusOS"]
 * CLIENTE ESPEC:  input#cliente[name="cliente"][value="CE"]
 *                 → onclick="abrirDivLentamente('divCodCliente')"
 *                 → abre div#divCodCliente
 * AUTOCOMPLETE:   input#autocomplet-cliente (jQuery UI autocomplete)
 * COD CLIENTE:    input#codCliente[type=hidden]
 * CENTRO CUSTO:   select#centrocusto-cliente (AJAX via buscarCentroCusto)
 * PAGINAÇÃO:      select#quantLimite → value="10000"
 * BUSCAR:         input[name="buscarDados"][type=button]
 *                 → onclick="buscaServicoExcel(1, 0, '', this)"
 * RESULTADO:      div#divRetornoTable > table > tbody > tr
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const { logger } = require('../../config/logger');

const SESSION_FILE_PERF = '/tmp/tutts-perf-session.json';
const TIMEOUT           = 60_000;
const EXCEL_URL         = 'https://tutts.com.br/expresso/expressoat/entregasExportarExcel';
const LOGIN_URL         = () => process.env.SISTEMA_EXTERNO_URL;

function log(msg) { logger.info(`[playwright-perf] ${msg}`); }

// ── TABELA DE PRAZOS ────────────────────────────────────────
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

// ── LOGIN ───────────────────────────────────────────────────
async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');
  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(2000);
  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) throw new Error(`Página de login não carregou. URL: ${page.url()}`);
  await page.fill('#loginEmail', process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.SISTEMA_EXTERNO_SENHA);
  await page.locator('input[name="logar"]').first().click();
  await page.waitForURL(url => !url.toString().includes('loginFuncionarioNovo'), { timeout: TIMEOUT });
  log('✅ Login OK');
}

// ══════════════════════════════════════════════════════════════
// PREENCHER FILTROS — 100% via page.evaluate (zero page.click)
// ══════════════════════════════════════════════════════════════
async function preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto }) {
  log('📋 Preenchendo filtros...');

  // ── PASSO 1: Datas + radios + status + paginação (tudo junto) ──
  await page.evaluate(({ di, df }) => {
    // DATAS — jQuery UI datepicker, readonly. Setar via jQuery.val()
    if (window.jQuery) {
      jQuery('#data').val(di);
      jQuery('#dataF').val(df);
    } else {
      document.getElementById('data').value = di;
      document.getElementById('dataF').value = df;
    }

    // COM ENDEREÇOS
    const radioEnd = document.querySelector('input[name="endereco"][value="CE"]');
    if (radioEnd) { radioEnd.checked = true; radioEnd.click(); }

    // COM DADOS PROF
    const radioProf = document.querySelector('input[name="profissional"][value="CDP"]');
    if (radioProf) { radioProf.checked = true; radioProf.click(); }

    // STATUS = CONCLUÍDO (select nativo + checkboxes do plugin)
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

    // PAGINAÇÃO = 10000
    const quantSel = document.getElementById('quantLimite');
    if (quantSel) quantSel.value = '10000';

  }, { di: dataInicio, df: dataFim });

  log(`  📅 ${dataInicio} → ${dataFim} | End=CE | Prof=CDP | Status=F | Pag=10000`);

  // ── PASSO 2: Cliente específico (se informado) ──
  if (codCliente) {
    // 2a. Clicar radio "Cliente específico" — tem onclick que abre divCodCliente
    await page.evaluate(() => {
      const radio = document.querySelector('input[name="cliente"][value="CE"]');
      if (radio) radio.click();
    });
    // Esperar div#divCodCliente ficar visível
    await page.waitForTimeout(800);

    // 2b. Setar codCliente no hidden + digitar no autocomplete
    await page.evaluate((cod) => {
      document.getElementById('codCliente').value = String(cod);
    }, codCliente);

    // 2c. Digitar no autocomplete para acionar a busca jQuery UI
    const autocompleteInput = page.locator('#autocomplet-cliente');
    await autocompleteInput.click();
    await autocompleteInput.fill('');
    await autocompleteInput.type(String(codCliente), { delay: 100 });
    log(`  ⌨️  Digitou "${codCliente}" no autocomplete`);

    // 2d. Esperar dropdown do autocomplete aparecer e selecionar
    try {
      await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 10000 });
      await page.click('ul.ui-autocomplete li.ui-menu-item:first-child');
      log('  ✅ Cliente selecionado do autocomplete');
    } catch {
      // Se autocomplete não aparecer, forçar o valor via JS
      log('  ⚠️  Autocomplete não abriu, forçando valor via JS');
      await page.evaluate((cod) => {
        document.getElementById('codCliente').value = String(cod);
        document.getElementById('autocomplet-cliente').value = String(cod);
      }, codCliente);
    }

    await page.waitForTimeout(1000);

    // 2e. Centro de custo (carrega via AJAX após selecionar cliente)
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
        log(`  ✅ Centro de custo: ${centroCusto}`);
      } catch {
        log('  ⚠️  Centro de custo não carregou a tempo');
      }
    }

    log(`  ✅ Cliente: ${codCliente}`);
  }
}

// ══════════════════════════════════════════════════════════════
// LER TABELA (com paginação)
// ══════════════════════════════════════════════════════════════
async function lerTabela(page) {
  const todasLinhas = [];
  let pagina = 1;

  while (true) {
    log(`📄 Lendo página ${pagina}...`);

    const linhas = await page.evaluate(() => {
      // Mapear colunas pelo texto do thead
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
        // Pular linhas de total/resumo
        if (first.toLowerCase().startsWith('total')) return;
        if (tds[0]?.getAttribute('colspan')) return;

        dados.push({
          os:          first,
          cliente_txt: idx.cliente != null    ? (tds[idx.cliente]?.textContent || '').trim()    : '',
          distancia:   idx.distancia != null  ? (tds[idx.distancia]?.textContent || '').trim()  : '',
          data_hora:   idx.data != null       ? (tds[idx.data]?.textContent || '').trim()       : '',
          finalizado:  idx.finalizado != null ? (tds[idx.finalizado]?.textContent || '').trim() : '',
        });
      });
      return dados;
    });

    todasLinhas.push(...linhas);
    log(`  → ${linhas.length} linhas`);

    // Próxima página?
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

    // Clicar próxima via evaluate
    await page.evaluate(() => {
      const sels = [
        'a[data-page][aria-label="Próximo"]',
        '.pagination li.next:not(.disabled) a',
        '.paginate_button.next:not(.disabled)',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && !el.closest('.disabled')) { el.click(); return; }
      }
    });
    await page.waitForTimeout(2500);
    pagina++;
    if (pagina > 20) { log('⚠️  Limite de 20 páginas'); break; }
  }

  log(`📊 Total: ${todasLinhas.length} linhas`);
  return todasLinhas;
}

// ══════════════════════════════════════════════════════════════
// CALCULAR SLA
// ══════════════════════════════════════════════════════════════
function calcularLinhas(linhas) {
  return linhas.map(linha => {
    const mCli   = linha.cliente_txt.match(/^\s*(\d+)\s*[-–]/);
    const codCli = mCli ? parseInt(mCli[1]) : null;
    const nomeCli = linha.cliente_txt.replace(/^\s*\d+\s*[-–]\s*/, '').split('\n')[0].trim();
    // Profissional vem na 2ª linha do texto da célula cliente
    const linhasTexto = linha.cliente_txt.split('\n').map(l => l.trim()).filter(Boolean);
    const profissional = linhasTexto.length >= 2 ? linhasTexto[1] : '';

    const mKm = linha.distancia.match(/([\d]+[.,][\d]+)/);
    const km  = mKm ? parseFloat(mKm[1].replace(',', '.')) : null;

    const prazo = (codCli !== null && CLIENTES_PRAZO_FIXO[codCli] !== undefined)
      ? CLIENTES_PRAZO_FIXO[codCli]
      : (km !== null ? getPrazoPorKm(km) : null);

    const dtCriacao = parseDataBR(linha.data_hora);
    const dtFinal   = parseDataBR(linha.finalizado);

    let sla_no_prazo = null, duracao_min = null, delta_min = null;
    const sem_dados = !prazo || !dtCriacao || !dtFinal;

    if (!sem_dados) {
      duracao_min  = Math.round((dtFinal - dtCriacao) / 60000);
      sla_no_prazo = duracao_min <= prazo;
      delta_min    = Math.abs(duracao_min - prazo);
    }

    return {
      os: linha.os, cliente_txt: linha.cliente_txt,
      cod_cliente: codCli, nome_cliente: nomeCli, profissional,
      km, prazo_min: prazo,
      data_criacao: dtCriacao?.toISOString() ?? null,
      finalizado:   dtFinal?.toISOString() ?? null,
      sla_no_prazo, duracao_min, delta_min, sem_dados,
    };
  });
}

// ── AGRUPAR POR CLIENTE ─────────────────────────────────────
function agruparPorCliente(registros) {
  const mapa = {};
  for (const r of registros) {
    const key = r.cod_cliente ?? '__sem__';
    if (!mapa[key]) {
      mapa[key] = { cod_cliente: r.cod_cliente, nome_cliente: r.nome_cliente,
        total: 0, no_prazo: 0, fora_prazo: 0, sem_dados: 0 };
    }
    mapa[key].total++;
    if (r.sem_dados)         mapa[key].sem_dados++;
    else if (r.sla_no_prazo) mapa[key].no_prazo++;
    else                     mapa[key].fora_prazo++;
  }
  return Object.values(mapa)
    .map(c => ({ ...c,
      pct_no_prazo: (c.total - c.sem_dados) > 0
        ? parseFloat(((c.no_prazo / (c.total - c.sem_dados)) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

// ══════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL
// ══════════════════════════════════════════════════════════════
async function buscarPerformance({ dataInicio, dataFim, codCliente, centroCusto }) {
  if (!process.env.SISTEMA_EXTERNO_URL) {
    throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  }

  log(`🚀 ${dataInicio}→${dataFim} | cli=${codCliente ?? 'todos'} | cc=${centroCusto ?? '—'}`);

  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE_PERF)) {
    contextOptions = { storageState: SESSION_FILE_PERF };
    log('♻️  Sessão salva encontrada');
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
    // 1. NAVEGAR
    log('🌐 Navegando...');
    await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    // 2. LOGIN
    if (!(await isLoggedIn(page))) {
      if (fs.existsSync(SESSION_FILE_PERF)) {
        fs.unlinkSync(SESSION_FILE_PERF);
        log('🗑️  Sessão inválida removida');
      }
      await fazerLogin(page);
      await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(3000);
      await context.storageState({ path: SESSION_FILE_PERF });
      log('💾 Sessão salva');
    } else {
      log('✅ Já logado');
    }

    // 3. ESPERAR FORMULÁRIO
    await page.waitForFunction(() => !!document.getElementById('data'), { timeout: 15000 });
    log('✅ Formulário detectado');

    // 4. PREENCHER FILTROS
    await preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto });
    await page.waitForTimeout(500);

    // 5. BUSCAR DADOS — chamar a função JS diretamente
    log('🔍 Executando buscaServicoExcel()...');
    await page.evaluate(() => {
      // Chamar a mesma função que o onclick do botão chama
      if (typeof buscaServicoExcel === 'function') {
        buscaServicoExcel(1, 0, '', null);
      } else {
        // Fallback: clicar o botão
        const btn = document.querySelector('input[name="buscarDados"]');
        if (btn) btn.click();
      }
    });

    // 6. ESPERAR TABELA (AJAX → #divRetornoTable)
    log('⏳ Aguardando resultado...');
    await page.waitForFunction(
      () => {
        const div = document.getElementById('divRetornoTable');
        if (!div) return false;
        // Esperar que tenha pelo menos uma <tr> com <td> na tabela
        const tds = div.querySelectorAll('table tbody tr td');
        return tds.length > 0;
      },
      { timeout: 120_000 }  // 2 min — pode ter muitos registros com 10000/página
    );
    await page.waitForTimeout(2000);
    log('✅ Tabela carregada');

    // 7. LER DADOS
    const linhasBrutas = await lerTabela(page);

    // 8. CALCULAR SLA
    const registros  = calcularLinhas(linhasBrutas);
    const total      = registros.length;
    const no_prazo   = registros.filter(r => r.sla_no_prazo === true).length;
    const fora_prazo = registros.filter(r => r.sla_no_prazo === false).length;
    const sem_dados  = registros.filter(r => r.sem_dados).length;
    const analisados = total - sem_dados;
    const pct_no_prazo = analisados > 0
      ? parseFloat(((no_prazo / analisados) * 100).toFixed(2)) : 0;

    log(`✅ ${total} OS | ${no_prazo}✓ | ${fora_prazo}✗ | ${sem_dados}? | ${pct_no_prazo}%`);

    return { total, no_prazo, fora_prazo, sem_dados, pct_no_prazo,
             por_cliente: agruparPorCliente(registros), registros };

  } finally {
    await browser.close();
  }
}

module.exports = { buscarPerformance };
