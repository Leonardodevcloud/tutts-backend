/**
 * playwright-performance.js — v10 (batch single-tab)
 * Otimização: abre browser UMA vez, loga UMA vez, e percorre
 * todos os clientes só trocando o campo cliente/CC.
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

const SESSION_FILE_PERF = '/tmp/tutts-perf-session.json';
const SCREENSHOT_DIR    = '/tmp/screenshots';
const TIMEOUT           = 30000;
const EXCEL_URL         = 'https://tutts.com.br/expresso/expressoat/entregasExportarExcel';
const LOGIN_URL         = () => process.env.SISTEMA_EXTERNO_URL;

function log(msg) { logger.info('[playwright-perf] ' + msg); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensureDir(SCREENSHOT_DIR);

// 2026-04 leakfix: helper pra fechar browser sem pendurar
// Se browser.close() travar, mata via SIGKILL pra evitar Chromium zumbi
// consumindo RAM. Sem isso, processos travados acumulam até estourar
// memória do container.
function comTimeout(promise, ms, descricao) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${descricao} excedeu ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fecharBrowserSeguro(browser) {
  if (!browser) return;
  try {
    await comTimeout(browser.close(), 5_000, 'browser.close');
  } catch (e) {
    log(`⚠️ browser.close() pendurou: ${e.message} — SIGKILL`);
    try {
      const proc = browser.process && browser.process();
      if (proc && typeof proc.kill === 'function') {
        proc.kill('SIGKILL');
        log(`💀 Chromium pid=${proc.pid} morto via SIGKILL`);
      }
    } catch (e2) {
      log(`⚠️ Falha no kill: ${e2.message}`);
    }
  }
}

async function screenshotDebug(page, nome) {
  try {
    const file = path.join(SCREENSHOT_DIR, 'perf-' + nome + '-' + Date.now() + '.png');
    await page.screenshot({ path: file, fullPage: false });
    log('📸 ' + path.basename(file));
  } catch (e) { log('⚠️ Screenshot falhou: ' + e.message); }
}

const TABELA_PRAZOS_KM = [
  [0,10,60],[10,15,75],[15,20,90],[20,25,105],[25,30,120],
  [30,35,135],[35,40,150],[40,45,165],[45,50,180],[50,55,195],
  [55,60,210],[60,65,225],[65,70,240],[70,75,255],[75,80,270],
];
const CLIENTES_PRAZO_FIXO = { 767: 120 };

function getPrazoPorKm(km) {
  for (const [de, ate, min] of TABELA_PRAZOS_KM) { if (km >= de && km < ate) return min; }
  return 270 + Math.ceil((km - 80) / 5) * 15;
}

function parseDataBR(texto) {
  if (!texto) return null;
  var m = texto.trim().match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
}

// ══════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════
async function isLoggedIn(page) {
  var url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');
  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1500);
  var temEmail = await page.locator('#loginEmail').isVisible().catch(function() { return false; });
  if (!temEmail) throw new Error('Página de login não carregou. URL: ' + page.url());
  await page.fill('#loginEmail', process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.SISTEMA_EXTERNO_SENHA);
  await page.locator('input[name="logar"]').first().click();
  await page.waitForURL(function(url) { return !url.toString().includes('loginFuncionarioNovo'); }, { timeout: TIMEOUT });
  log('✅ Login OK — URL: ' + page.url());
}

async function navegarParaFiltros(page, context) {
  log('📌 Navegando para entregasExportarExcel');
  await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1000);

  if (!(await isLoggedIn(page))) {
    if (fs.existsSync(SESSION_FILE_PERF)) { fs.unlinkSync(SESSION_FILE_PERF); log('🗑️ Sessão inválida removida'); }
    await fazerLogin(page);
    await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1000);
    await context.storageState({ path: SESSION_FILE_PERF });
    log('💾 Sessão salva');
  } else {
    log('✅ Já logado');
  }

  var temData = await page.evaluate(function() { return !!document.getElementById('data'); });
  if (!temData) { await screenshotDebug(page, 'no-form'); throw new Error('Formulário não encontrado. URL: ' + page.url()); }
  log('✅ Formulário detectado');
}

// ══════════════════════════════════════════════════════════════
// PREENCHER CAMPOS BASE (datas, status, paginação) — SÓ 1 VEZ
// ══════════════════════════════════════════════════════════════
async function preencherCamposBase(page, dataInicio, dataFim) {
  log('📋 Campos base: ' + dataInicio + ' → ' + dataFim);
  await page.evaluate(function(args) {
    var di = args.di, df = args.df;
    if (window.jQuery) { jQuery('#data').val(di); jQuery('#dataF').val(df); }
    else { document.getElementById('data').value = di; document.getElementById('dataF').value = df; }

    var radioEnd = document.querySelector('input[name="endereco"][value="CE"]');
    if (radioEnd) { radioEnd.checked = true; radioEnd.click(); }
    var radioProf = document.querySelector('input[name="profissional"][value="CDP"]');
    if (radioProf) { radioProf.checked = true; radioProf.click(); }

    var sel = document.getElementById('status');
    if (sel) { for (var i = 0; i < sel.options.length; i++) sel.options[i].selected = (sel.options[i].value === 'F'); sel.dispatchEvent(new Event('change', { bubbles: true })); }

    var cbs = document.querySelectorAll('input[name="statusOS"]');
    for (var j = 0; j < cbs.length; j++) {
      var check = (cbs[j].value === 'F');
      cbs[j].checked = check;
      var btn = cbs[j].closest('button.multiselect-option');
      if (btn) { if (check) btn.classList.add('active'); else btn.classList.remove('active'); }
    }
    var msTxt = document.querySelector('.multiselect-selected-text');
    if (msTxt) msTxt.textContent = 'Concluídos';

    var quantSel = document.getElementById('quantLimite');
    if (quantSel) quantSel.value = '10000';
  }, { di: dataInicio, df: dataFim });
}

// ══════════════════════════════════════════════════════════════
// TROCAR CLIENTE/CC — RÁPIDO
// ══════════════════════════════════════════════════════════════
async function trocarCliente(page, codCliente, centroCusto) {
  if (!codCliente) return;
  log('🔄 Trocando → cli=' + codCliente + ' cc=' + (centroCusto || 'todos'));

  await page.evaluate(function() {
    var radio = document.querySelector('input[name="cliente"][value="CE"]');
    if (radio) radio.click();
  });
  await page.waitForTimeout(500);

  // Limpar campos antigos
  await page.evaluate(function() {
    document.getElementById('codCliente').value = '';
    document.getElementById('autocomplet-cliente').value = '';
    var ccSel = document.getElementById('centrocusto-cliente');
    if (ccSel) ccSel.innerHTML = '<option value="">Selecione</option>';
  });

  await page.evaluate(function(cod) { document.getElementById('codCliente').value = String(cod); }, codCliente);
  var input = page.locator('#autocomplet-cliente');
  await input.click();
  await input.fill('');
  await input.type(String(codCliente), { delay: 80 });

  try {
    await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await page.click('ul.ui-autocomplete li.ui-menu-item:first-child');
    log('  ✅ Cliente selecionado');
  } catch (e) {
    log('  ⚠️ Autocomplete timeout, forçando');
    await page.evaluate(function(cod) {
      document.getElementById('codCliente').value = String(cod);
      document.getElementById('autocomplet-cliente').value = String(cod);
    }, codCliente);
  }
  await page.waitForTimeout(800);

  if (centroCusto) {
    try {
      await page.waitForFunction(function() { return document.querySelectorAll('#centrocusto-cliente option').length > 1; }, { timeout: 8000 });
      var matched = await page.evaluate(function(cc) {
        var s = document.getElementById('centrocusto-cliente');
        if (!s) return { found: false };
        var ccLower = cc.toLowerCase().trim();
        var allOpts = [];
        for (var i = 0; i < s.options.length; i++) allOpts.push({ value: s.options[i].value, text: s.options[i].textContent.trim() });
        for (var i = 0; i < s.options.length; i++) { if (s.options[i].value === cc) { s.value = s.options[i].value; s.dispatchEvent(new Event('change', { bubbles: true })); return { found: true }; } }
        for (var i = 0; i < s.options.length; i++) { if (s.options[i].textContent.trim().toLowerCase() === ccLower) { s.value = s.options[i].value; s.dispatchEvent(new Event('change', { bubbles: true })); return { found: true }; } }
        for (var i = 0; i < s.options.length; i++) {
          var oText = s.options[i].textContent.trim().toLowerCase();
          if ((oText.includes(ccLower) || ccLower.includes(oText)) && s.options[i].value && oText) { s.value = s.options[i].value; s.dispatchEvent(new Event('change', { bubbles: true })); return { found: true }; }
        }
        return { found: false, options: allOpts.slice(0, 10) };
      }, centroCusto);

      if (matched.found) { log('  ✅ CC selecionado'); }
      else { log('  ⚠️ CC não encontrado'); }
    } catch (ccErr) { log('  ⚠️ CC não carregou: ' + ccErr.message); }
    await page.waitForTimeout(1000);
  }
}

// ══════════════════════════════════════════════════════════════
// EXECUTAR BUSCA + AGUARDAR TABELA
// ══════════════════════════════════════════════════════════════
async function executarBusca(page) {
  log('🔍 Executando busca...');
  await page.evaluate(function() {
    if (typeof buscaServicoExcel === 'function') buscaServicoExcel(1, 0, '', null);
    else { var b = document.querySelector('input[name="buscarDados"]'); if (b) b.click(); }
  });

  try {
    await page.waitForFunction(function() {
      var d = document.getElementById('divRetornoTable');
      return d && d.querySelectorAll('table tbody tr td').length > 0;
    }, { timeout: 120000 });
  } catch (e) {
    await screenshotDebug(page, 'no-table');
    throw new Error('Tabela não carregou');
  }
  await page.waitForTimeout(2000);
  log('✅ Tabela carregada');
}

// ══════════════════════════════════════════════════════════════
// LER TABELA
// ══════════════════════════════════════════════════════════════
async function lerTabela(page) {
  var todasLinhas = [];
  var pagina = 1;
  while (true) {
    log('📄 Página ' + pagina + '...');
    var linhas = await page.evaluate(function() {
      var ths = Array.from(document.querySelectorAll('#divRetornoTable table thead th'));
      var idx = {};
      ths.forEach(function(th, i) {
        var t = (th.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (t.includes('servic'))     idx.os = i;
        if (t.includes('cliente'))    idx.cliente = i;
        if (t.includes('distanc'))    idx.distancia = i;
        if (t.includes('data'))       idx.data = i;
        if (t.includes('finalizado')) idx.finalizado = i;
      });
      var rows = document.querySelectorAll('#divRetornoTable table tbody tr');
      var dados = [];
      rows.forEach(function(tr) {
        var tds = tr.querySelectorAll('td');
        if (tds.length < 5) return;
        var first = (tds[0].textContent || '').trim();
        if (first.toLowerCase().startsWith('total')) return;
        if (tds[0].getAttribute('colspan')) return;
        dados.push({
          os: first,
          cliente_txt: idx.cliente != null ? (tds[idx.cliente].textContent || '').trim() : '',
          distancia:   idx.distancia != null ? (tds[idx.distancia].textContent || '').trim() : '',
          data_hora:   idx.data != null ? (tds[idx.data].textContent || '').trim() : '',
          finalizado:  idx.finalizado != null ? (tds[idx.finalizado].textContent || '').trim() : '',
        });
      });
      return dados;
    });
    todasLinhas = todasLinhas.concat(linhas);
    log('  → ' + linhas.length + ' linhas');
    var temProxima = await page.evaluate(function() {
      var sels = ['a[data-page][aria-label="Próximo"]', '.pagination li.next:not(.disabled) a'];
      for (var i = 0; i < sels.length; i++) { var el = document.querySelector(sels[i]); if (el && !el.closest('.disabled')) return true; }
      return false;
    });
    if (!temProxima || linhas.length < 10) break;
    await page.evaluate(function() {
      var sels = ['a[data-page][aria-label="Próximo"]', '.pagination li.next:not(.disabled) a'];
      for (var i = 0; i < sels.length; i++) { var el = document.querySelector(sels[i]); if (el) { el.click(); return; } }
    });
    await page.waitForTimeout(2500);
    pagina++;
    if (pagina > 20) break;
  }
  log('📊 Total: ' + todasLinhas.length + ' linhas');
  return todasLinhas;
}

// ── SLA ─────────────────────────────────────────────────────
// codClienteFiltro: quando o job está filtrando por um cliente específico,
// passamos o código aqui — assim garantimos a aplicação da métrica correta
// (ex.: 767 = 120min fixo) mesmo se o regex do cliente_txt falhar por variação
// de formato retornado pelo sistema externo.
function calcularLinhas(linhas, codClienteFiltro) {
  var codFiltro = (codClienteFiltro !== null && codClienteFiltro !== undefined && !isNaN(parseInt(codClienteFiltro)))
    ? parseInt(codClienteFiltro)
    : null;
  return linhas.map(function(linha) {
    var mCli = linha.cliente_txt.match(/^\s*(\d+)\s*[-–]/);
    var codCliRegex = mCli ? parseInt(mCli[1]) : null;
    // Prioridade: código do filtro do job > regex do texto.
    // Isso garante que a métrica por cod_cliente (CLIENTES_PRAZO_FIXO) seja
    // aplicada mesmo quando o texto do cliente vem em formato diferente.
    var codCli = codFiltro != null ? codFiltro : codCliRegex;
    var nomeCli = linha.cliente_txt.replace(/^\s*\d+\s*[-–]\s*/, '').split('\n')[0].trim();
    var linhasTexto = linha.cliente_txt.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    var profissional = linhasTexto.length >= 2 ? linhasTexto[1] : '';
    var mKm = linha.distancia.match(/([\d]+[.,][\d]+)/);
    var km = mKm ? parseFloat(mKm[1].replace(',', '.')) : null;
    var prazo = (codCli !== null && CLIENTES_PRAZO_FIXO[codCli] !== undefined) ? CLIENTES_PRAZO_FIXO[codCli] : (km !== null ? getPrazoPorKm(km) : null);
    var dtCriacao = parseDataBR(linha.data_hora);
    var dtFinal = parseDataBR(linha.finalizado);
    var sla_no_prazo = null, duracao_min = null, delta_min = null;
    var sem_dados = !prazo || !dtCriacao || !dtFinal;
    if (!sem_dados) { duracao_min = Math.round((dtFinal - dtCriacao) / 60000); sla_no_prazo = duracao_min <= prazo; delta_min = Math.abs(duracao_min - prazo); }
    return { os: linha.os, cliente_txt: linha.cliente_txt, cod_cliente: codCli, nome_cliente: nomeCli, profissional: profissional, km: km, prazo_min: prazo, data_criacao: dtCriacao ? dtCriacao.toISOString() : null, finalizado: dtFinal ? dtFinal.toISOString() : null, sla_no_prazo: sla_no_prazo, duracao_min: duracao_min, delta_min: delta_min, sem_dados: sem_dados };
  });
}

function agruparPorCliente(registros) {
  var mapa = {};
  for (var i = 0; i < registros.length; i++) {
    var r = registros[i];
    var key = r.cod_cliente != null ? r.cod_cliente : '__sem__';
    if (!mapa[key]) { mapa[key] = { cod_cliente: r.cod_cliente, nome_cliente: r.nome_cliente, total: 0, no_prazo: 0, fora_prazo: 0, sem_dados: 0 }; }
    mapa[key].total++;
    if (r.sem_dados) mapa[key].sem_dados++;
    else if (r.sla_no_prazo) mapa[key].no_prazo++;
    else mapa[key].fora_prazo++;
  }
  return Object.values(mapa).map(function(c) {
    var analisados = c.total - c.sem_dados;
    c.pct_no_prazo = analisados > 0 ? parseFloat(((c.no_prazo / analisados) * 100).toFixed(2)) : 0;
    return c;
  }).sort(function(a, b) { return b.total - a.total; });
}

// ══════════════════════════════════════════════════════════════
// SINGLE JOB (compatibilidade)
// ══════════════════════════════════════════════════════════════
async function buscarPerformance(opts) {
  var resultados = await buscarPerformanceBatch([opts]);
  return resultados[0];
}

// ══════════════════════════════════════════════════════════════
// BATCH — ABRE BROWSER 1 VEZ, PERCORRE CLIENTES
// ══════════════════════════════════════════════════════════════
async function buscarPerformanceBatch(configs) {
  if (!process.env.SISTEMA_EXTERNO_URL) throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  if (!configs || configs.length === 0) throw new Error('Nenhuma config para processar');

  log('🚀 BATCH: ' + configs.length + ' consulta(s) | ' + configs[0].dataInicio + '→' + configs[0].dataFim);

  var browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-default-apps', '--mute-audio', '--no-first-run'],
  });

  var contextOptions = {};
  if (fs.existsSync(SESSION_FILE_PERF)) { contextOptions = { storageState: SESSION_FILE_PERF }; log('♻️ Sessão encontrada'); }

  var context = await browser.newContext(Object.assign({}, contextOptions, {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  }));
  var page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  var resultados = [];

  try {
    // 1. Login + navegação — UMA VEZ
    await navegarParaFiltros(page, context);

    // 2. Campos base (datas, status, paginação) — UMA VEZ
    await preencherCamposBase(page, configs[0].dataInicio, configs[0].dataFim);

    // 3. Percorrer clientes — SÓ TROCA CLIENTE/CC
    for (var i = 0; i < configs.length; i++) {
      var cfg = configs[i];
      var label = '[' + (i + 1) + '/' + configs.length + '] cli=' + (cfg.codCliente || 'todos') + ' cc=' + (cfg.centroCusto || '—');

      try {
        log('━━━ ' + label + ' ━━━');

        if (cfg.codCliente) {
          await trocarCliente(page, cfg.codCliente, cfg.centroCusto);
        }

        await page.waitForTimeout(300);
        await executarBusca(page);

        var linhasBrutas = await lerTabela(page);
        var registros = calcularLinhas(linhasBrutas, cfg.codCliente);
        var total = registros.length;
        var no_prazo = registros.filter(function(r) { return r.sla_no_prazo === true; }).length;
        var fora_prazo = registros.filter(function(r) { return r.sla_no_prazo === false; }).length;
        var sem_dados = registros.filter(function(r) { return r.sem_dados; }).length;
        var analisados = total - sem_dados;
        var pct_no_prazo = analisados > 0 ? parseFloat(((no_prazo / analisados) * 100).toFixed(2)) : 0;

        log('✅ ' + label + ': ' + total + ' OS | ' + no_prazo + '✓ | ' + fora_prazo + '✗ | ' + pct_no_prazo + '%');

        resultados.push({ success: true, codCliente: cfg.codCliente, centroCusto: cfg.centroCusto, total: total, no_prazo: no_prazo, fora_prazo: fora_prazo, sem_dados: sem_dados, pct_no_prazo: pct_no_prazo, por_cliente: agruparPorCliente(registros), registros: registros });
      } catch (err) {
        log('❌ ' + label + ': ' + err.message);
        await screenshotDebug(page, 'error-' + (cfg.codCliente || 'all'));
        resultados.push({ success: false, codCliente: cfg.codCliente, centroCusto: cfg.centroCusto, error: err.message, total: 0, no_prazo: 0, fora_prazo: 0, sem_dados: 0, pct_no_prazo: 0, por_cliente: [], registros: [] });
      }
    }
  } catch (err) {
    await screenshotDebug(page, 'batch-error');
    throw err;
  } finally {
    // 2026-04 leakfix: usar fecharBrowserSeguro em vez de browser.close()
    // direto, pra que SIGKILL seja aplicado se o close pendurar.
    await fecharBrowserSeguro(browser);
    log('🏁 BATCH finalizado: ' + resultados.filter(function(r) { return r.success; }).length + '/' + configs.length + ' OK');
  }

  return resultados;
}

module.exports = { buscarPerformance: buscarPerformance, buscarPerformanceBatch: buscarPerformanceBatch };
