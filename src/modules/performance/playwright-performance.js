/**
 * playwright-performance.js
 * Automação RPA: acessa entregasExportarExcel, aplica filtros,
 * lê a tabela e retorna array de entregas para cálculo de SLA.
 *
 * ═══════════════════════════════════════════════════════════════
 * SELETORES MAPEADOS DO HTML REAL (dump 13/03/2026):
 *
 *   Data inicial      : #data          (type=text, readonly, jQuery UI datepicker)
 *   Data final        : #dataF         (type=text, readonly, jQuery UI datepicker)
 *   Com endereços     : input[name="endereco"][value="CE"]    (radio)
 *   Com dados prof    : input[name="profissional"][value="CDP"] (radio)
 *   Status multiselect: #status (select-multiple) + plugin bootstrap-multiselect
 *                        checkboxes: input[name="statusOS"][value="F"]
 *   Cliente específico: input[name="cliente"][value="CE"]     (radio)
 *   Input cliente vis : #autocomplet-cliente      (text, jQuery UI autocomplete)
 *   Input cliente hid : #codCliente               (hidden)
 *   Centro de custo   : #centrocusto-cliente      (select-one)
 *   Qtd por página    : #quantLimite              (select)
 *   Botão buscar      : input[name="buscarDados"] (type=button)
 *
 *   COLUNAS DA TABELA (com endereço + com dados prof):
 *   [0] Serviço  [1] Cliente  [2] Profissional  [3] Endereço
 *   [4] Distância  [5] Data/Agendado  [6] Categoria
 *   [7] Info  [8] Valor/V.prof  [9] Tipo Pagamento
 *   [10] Status  [11] Finalizado
 *
 *   COLUNAS DA TABELA (com endereço, SEM dados prof):
 *   [0] Serviço  [1] Cliente  [2] Endereço  [3] Distância
 *   [4] Data/Agendado  [5] Categoria  [6] Info
 *   [7] Valor/V.prof  [8] Tipo Pagamento  [9] Status  [10] Finalizado
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

const SESSION_FILE_PERF = '/tmp/tutts-perf-session.json';
const TIMEOUT           = 45_000;
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
  await page.waitForTimeout(2000);

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
// PREENCHER FILTROS VIA JAVASCRIPT (bypassa datepicker/readonly)
// ─────────────────────────────────────────────────────────────
async function preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto }) {
  log('📋 Preenchendo filtros...');

  // ── Datas (campos readonly com jQuery UI datepicker) ──
  // Não dá pra usar page.fill() em readonly. Setar via JS.
  await page.evaluate(({ di, df }) => {
    const dataEl = document.getElementById('data');
    const dataFEl = document.getElementById('dataF');
    if (dataEl) {
      dataEl.removeAttribute('readonly');
      dataEl.value = di;
      dataEl.setAttribute('readonly', 'readonly');
    }
    if (dataFEl) {
      dataFEl.removeAttribute('readonly');
      dataFEl.value = df;
      dataFEl.setAttribute('readonly', 'readonly');
    }
  }, { di: dataInicio, df: dataFim });
  log(`  📅 Datas: ${dataInicio} → ${dataFim}`);

  // ── Com endereços (radio CE) ──
  await page.evaluate(() => {
    const radio = document.querySelector('input[name="endereco"][value="CE"]');
    if (radio) { radio.checked = true; radio.click(); }
  });
  log('  ✅ Com endereços');

  // ── Com dados profissional (radio CDP) ──
  await page.evaluate(() => {
    const radio = document.querySelector('input[name="profissional"][value="CDP"]');
    if (radio) { radio.checked = true; radio.click(); }
  });
  log('  ✅ Com dados profissional');

  // ── Status = Concluído ──
  // O select usa bootstrap-multiselect plugin.
  // Estratégia: setar o select nativo + sincronizar checkboxes do plugin.
  await page.evaluate(() => {
    // 1. Select nativo
    const sel = document.getElementById('status');
    if (sel) {
      for (const opt of sel.options) opt.selected = (opt.value === 'F');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // 2. Checkboxes do plugin bootstrap-multiselect
    document.querySelectorAll('input[name="statusOS"]').forEach(cb => {
      cb.checked = (cb.value === 'F');
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 3. Atualizar texto do botão do multiselect
    const btn = document.querySelector('#status + .btn-group .multiselect-selected-text');
    if (btn) btn.textContent = 'Concluídos';
  });
  log('  ✅ Status = Concluído (F)');

  // ── Qtd por página = 500 ──
  await page.evaluate(() => {
    const sel = document.getElementById('quantLimite');
    if (sel) {
      sel.value = '500';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  log('  ✅ Qtd/página: 500');

  // ── Cliente específico ──
  if (codCliente) {
    // Clicar no radio "Cliente específico"
    await page.evaluate(() => {
      const radio = document.querySelector('input[name="cliente"][value="CE"]');
      if (radio) { radio.checked = true; radio.click(); }
    });
    await page.waitForTimeout(500);

    // Setar código do cliente via JS (campo hidden + autocomplete visível)
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

    // Centro de custo — aguarda select ser populado pelo AJAX do cliente
    if (centroCusto) {
      await page.waitForFunction(
        () => document.querySelectorAll('#centrocusto-cliente option').length > 1,
        { timeout: 8000 }
      ).catch(() => log('  ⚠️  CC: select não populado'));

      await page.evaluate((cc) => {
        const sel = document.getElementById('centrocusto-cliente');
        if (sel) {
          sel.value = cc;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, centroCusto);
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

    // Detectar dinamicamente as colunas pelo thead
    const linhas = await page.evaluate(() => {
      // Mapear índices das colunas pelo texto do thead
      const ths = Array.from(document.querySelectorAll('table thead th'));
      const colMap = {};
      ths.forEach((th, i) => {
        const txt = (th.textContent || '').trim().toLowerCase();
        if (txt.includes('servi'))       colMap.servico = i;
        if (txt.includes('cliente'))     colMap.cliente = i;
        if (txt.includes('distân') || txt.includes('distan')) colMap.distancia = i;
        if (txt.includes('data'))        colMap.data = i;
        if (txt.includes('finalizado'))  colMap.finalizado = i;
      });

      // Procurar coluna profissional (pode não existir)
      const profIdx = ths.findIndex(th => {
        const t = (th.textContent || '').trim().toLowerCase();
        return t.includes('profissional') || t.includes('prof.');
      });
      if (profIdx >= 0) colMap.profissional = profIdx;

      const rows = document.querySelectorAll('table tbody tr');
      const dados = [];
      rows.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 6) return; // pula linhas de total/resumo

        // Ignorar linhas de total (geralmente tem colspan ou "Total" no texto)
        const firstText = (tds[0]?.textContent || '').trim();
        if (firstText.toLowerCase().startsWith('total')) return;
        if (tds[0]?.getAttribute('colspan')) return;

        dados.push({
          os:           (tds[colMap.servico]?.textContent || '').trim(),
          cliente_txt:  (tds[colMap.cliente]?.textContent || '').trim(),
          distancia:    colMap.distancia != null ? (tds[colMap.distancia]?.textContent || '').trim() : '',
          profissional: colMap.profissional != null ? (tds[colMap.profissional]?.textContent || '').trim() : '',
          data_hora:    colMap.data != null ? (tds[colMap.data]?.textContent || '').trim() : '',
          finalizado:   colMap.finalizado != null ? (tds[colMap.finalizado]?.textContent || '').trim() : '',
        });
      });
      return dados;
    });

    todasLinhas.push(...linhas);
    log(`  → ${linhas.length} linhas`);

    // Verifica próxima página
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

    await page.waitForTimeout(2000);
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
    // Extrair cod_cliente do texto "949 - Nome Fantasia\nProfissional..."
    const mCli    = linha.cliente_txt.match(/^\s*(\d+)\s*[-–]/);
    const codCli  = mCli ? parseInt(mCli[1]) : null;
    const nomeCli = linha.cliente_txt.replace(/^\s*\d+\s*[-–]\s*/, '').split('\n')[0].trim();

    // Extrair KM
    const mKm = linha.distancia.match(/([\d]+[.,][\d]+)/);
    const km  = mKm ? parseFloat(mKm[1].replace(',', '.')) : null;

    const prazo = (codCli !== null && CLIENTES_PRAZO_FIXO[codCli] !== undefined)
      ? CLIENTES_PRAZO_FIXO[codCli]
      : (km !== null ? getPrazoPorKm(km) : null);

    // data_hora pode vir como "DD/MM/YYYY HH:MM:SS" ou com agendamento
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
    await page.waitForTimeout(2000);

    if (!(await isLoggedIn(page))) {
      if (fs.existsSync(SESSION_FILE_PERF)) { fs.unlinkSync(SESSION_FILE_PERF); log('🗑️  Sessão inválida'); }
      await fazerLogin(page);
      await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(2000);
      await context.storageState({ path: SESSION_FILE_PERF });
      log('💾 Sessão salva');
    } else {
      log('✅ Já logado');
    }

    // Esperar o formulário de filtros estar disponível
    await page.waitForSelector('#data', { timeout: TIMEOUT });
    log('✅ Formulário carregado');

    // 2. Filtros
    await preencherFiltros(page, { dataInicio, dataFim, codCliente, centroCusto });

    // 3. Busca — o botão é input[type=button][name=buscarDados]
    log('🔍 Clicando Buscar dados...');
    await page.click('input[name="buscarDados"]');

    // Aguardar a tabela renderizar (o AJAX preenche #divRetornoTable)
    await page.waitForFunction(
      () => {
        const trs = document.querySelectorAll('#divRetornoTable table tbody tr');
        return trs.length > 0;
      },
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
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
