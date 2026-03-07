/**
 * antifraude-scanner.js
 * Playwright: loga no MAP, varre OSs em execução e concluídas,
 * extrai NF/pedido, motoboy, cliente e salva no banco.
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
  logger.info(`[antifraude-scanner] ${msg}`);
}

async function screenshot(page, etapa) {
  const file = path.join(SCREENSHOT_DIR, `AF_${etapa}_${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); } catch (_) {}
  return path.basename(file);
}

async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login no MAP...');
  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    throw new Error(`Página de login não carregou. URL: ${page.url()}`);
  }

  await page.fill('#loginEmail', process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.SISTEMA_EXTERNO_SENHA);
  await page.locator('input[name="logar"]').first().click();

  await page.waitForURL(
    url => !url.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log('✅ Login OK');
}

/**
 * Extrai dados de todas as OSs visíveis na tabela atual.
 * Retorna array de objetos com os campos de cada OS.
 */
async function extrairOsDaTabela(page, statusOs) {
  return await page.evaluate((statusOs) => {
    const rows = document.querySelectorAll('table tbody tr, .table tbody tr');
    const resultados = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 6) return;

      // Coluna CÓDIGO — o botão dentro contém o código da OS
      const btnCodigo = cells[0]?.querySelector('button, a');
      const osCodigo = btnCodigo ? (btnCodigo.textContent || '').trim().replace(/[^\d]/g, '') : '';
      if (!osCodigo) return;

      // Tooltip do código contém "Número do pedido =XXXXX"
      // Extrair do title ou data-original-title
      const tooltip = btnCodigo?.getAttribute('title') ||
                      btnCodigo?.getAttribute('data-original-title') || '';
      let numeroPedidoNf = '';
      const matchPedido = tooltip.match(/[Nn]úmero\s+do\s+pedido\s*[=:]\s*(\S+)/);
      if (matchPedido) numeroPedidoNf = matchPedido[1].trim();

      // Se não tem no tooltip, tentar extrair via texto da célula (fallback)
      if (!numeroPedidoNf) {
        const cellText = (cells[0]?.textContent || '').trim();
        const matchAlt = cellText.match(/pedido[:\s=]+(\S+)/i);
        if (matchAlt) numeroPedidoNf = matchAlt[1].trim();
      }

      // Coluna SOLICITANTE
      const solicitanteBtn = cells[1]?.querySelector('button, a');
      const solicitanteTexto = (solicitanteBtn?.textContent || cells[1]?.textContent || '').trim();
      const solicitanteCod = solicitanteTexto.match(/^(\d+)/)?.[1] || '';
      const solicitanteNome = solicitanteTexto.replace(/^\d+\s*-\s*/, '').trim();

      // Coluna C.CUSTO
      const centroCusto = (cells[2]?.textContent || '').trim();

      // Coluna CATEGORIA
      const categoriaBtn = cells[4]?.querySelector('button, a');
      const categoria = (categoriaBtn?.textContent || cells[4]?.textContent || '').trim();

      // Coluna PROFISSIONAL
      const profBtn = cells[5]?.querySelector('button, a');
      const profTexto = (profBtn?.textContent || cells[5]?.textContent || '').trim();
      const profCod = profTexto.match(/^(\d+)/)?.[1] || '';
      const profNome = profTexto.replace(/^\d+\s*-?\s*/, '').trim();

      // Coluna SOLICIT/AGENDAMENTO (data)
      const dataCell = cells[6]?.textContent || '';
      const dataMatch = dataCell.match(/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/);
      let dataSolicitacao = null;
      if (dataMatch) {
        const parts = dataMatch[1].split(/[\s-:]/);
        if (parts.length >= 5) {
          dataSolicitacao = `${parts[2]}-${parts[1]}-${parts[0]}T${parts[3]}:${parts[4]}:${parts[5] || '00'}`;
        }
      }

      // Coluna VALORES
      const valoresTexto = (cells[7]?.textContent || '').trim();
      const valoresMatch = valoresTexto.match(/R\$\s*([\d.,]+)\s*\|\s*R\$\s*([\d.,]+)/);
      let valorServico = null, valorProfissional = null;
      if (valoresMatch) {
        valorServico = parseFloat(valoresMatch[1].replace('.', '').replace(',', '.'));
        valorProfissional = parseFloat(valoresMatch[2].replace('.', '').replace(',', '.'));
      }

      resultados.push({
        os_codigo: osCodigo,
        numero_pedido_nf: numeroPedidoNf || null,
        solicitante_cod: solicitanteCod || null,
        solicitante_nome: solicitanteNome || null,
        profissional_cod: profCod || null,
        profissional_nome: profNome || null,
        categoria: categoria || null,
        centro_custo: centroCusto || null,
        status_os: statusOs,
        data_solicitacao: dataSolicitacao,
        valor_servico: valorServico,
        valor_profissional: valorProfissional,
      });
    });

    return resultados;
  }, statusOs);
}

/**
 * Extrai NF/pedido do modal de endereços de uma OS.
 * Abre o modal END., captura textos de cada ponto, fecha o modal.
 */
async function extrairNfDoModal(page, osCodigo) {
  try {
    const btnSelector = `button.btn-modal[data-action="funcaoEnderecoServico"][data-id="${osCodigo}"], button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="${osCodigo}"]`;
    const btnCount = await page.locator(btnSelector).count();
    if (btnCount === 0) return [];

    await page.locator(btnSelector).first().click({ force: true });
    await page.waitForSelector('.modal.show, .modal.in, #modalPadrao.show', {
      state: 'visible', timeout: 10000,
    }).catch(() => null);
    await page.waitForTimeout(800);

    // Extrair dados de cada ponto no modal
    const pontos = await page.evaluate(() => {
      const result = [];
      const modalBody = document.querySelector('.modal.show .modal-body, .modal.in .modal-body, #modalPadrao .modal-body');
      if (!modalBody) return result;

      const texto = modalBody.innerText || '';
      // Buscar padrões: "Nº nota: XXXXX", "PEC Nº nota: XXXXX", "NF: XXXXX"
      const nfMatches = texto.match(/[Nn][\u00ba°]?\s*nota[:\s]+(\d+)/g) || [];
      const pecMatches = texto.match(/PEC\s+[^\n]*?[Nn][\u00ba°]?\s*nota[:\s]+(\d+)/g) || [];

      // Extrair todos os números de nota encontrados
      const notas = new Set();
      [...nfMatches, ...pecMatches].forEach(m => {
        const num = m.match(/(\d+)\s*$/);
        if (num) notas.add(num[1]);
      });

      // Buscar botões de corrigir endereço para extrair dados dos pontos
      const btns = modalBody.querySelectorAll('.btn-corrigir-endereco');
      btns.forEach(btn => {
        const ponto = btn.getAttribute('data-ponto');
        const idEnd = btn.getAttribute('data-id-endereco');
        let endereco = '';
        if (idEnd) {
          const span = document.getElementById('end-antigo-' + idEnd);
          if (span) endereco = (span.textContent || '').trim();
        }

        // Extrair NF do texto próximo ao ponto
        let nfPonto = '';
        const container = btn.closest('div') || btn.parentElement;
        if (container) {
          const ctxTexto = container.textContent || '';
          const nfMatch = ctxTexto.match(/[Nn][\u00ba°]?\s*nota[:\s]+(\d+)/);
          if (nfMatch) nfPonto = nfMatch[1];
        }

        result.push({
          ponto: ponto,
          endereco: endereco,
          nf: nfPonto || null,
        });
      });

      // Se não encontrou via botões, retornar as notas genéricas
      if (result.length === 0 && notas.size > 0) {
        notas.forEach(nf => result.push({ ponto: null, endereco: '', nf }));
      }

      return result;
    });

    // Fechar modal
    await page.locator('.modal.show .close, .modal.in .close, button[data-dismiss="modal"]').first().click().catch(() => {});
    await page.waitForTimeout(500);

    return pontos;
  } catch (err) {
    log(`⚠️ Erro ao extrair modal OS ${osCodigo}: ${err.message}`);
    // Tentar fechar modal caso aberto
    await page.locator('.modal.show .close, button[data-dismiss="modal"]').first().click().catch(() => {});
    await page.waitForTimeout(300);
    return [];
  }
}

/**
 * Executa a varredura completa: login, varre execução + concluídos, extrai NFs.
 * @param {object} pool - Pool do PostgreSQL
 * @param {number} varreduraId - ID do registro em antifraude_varreduras
 * @param {object} config - { janela_dias, max_paginas_concluidos }
 */
async function executarVarredura(pool, varreduraId, config = {}) {
  const maxPaginasConcluidos = parseInt(config.max_paginas_concluidos) || 3;

  if (!process.env.SISTEMA_EXTERNO_URL) {
    throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  }

  log('🚀 Iniciando varredura anti-fraude...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--single-process',
    ],
  });

  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE)) {
    contextOptions = { storageState: SESSION_FILE };
    log('♻️ Usando sessão salva');
  }

  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  let totalOs = 0;
  const todasOs = [];

  try {
    // ── Login ──
    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1000);

    if (!(await isLoggedIn(page))) {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      await fazerLogin(page);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(1000);
      await context.storageState({ path: SESSION_FILE });
    }

    // ── Aba "Em execução" ──
    log('📌 Varrendo aba "Em execução"...');
    const abaExec = page.locator('#pills-em-execucao-tab, button:has-text("Em execução"), a:has-text("Em execução")').first();
    if (await abaExec.isVisible().catch(() => false)) {
      await abaExec.click();
      await page.waitForTimeout(1500);
    }
    await screenshot(page, 'exec_aba');

    const osExec = await extrairOsDaTabela(page, 'em_execucao');
    log(`📊 Em execução: ${osExec.length} OS(s) encontrada(s)`);
    todasOs.push(...osExec);

    // Extrair NFs dos modais (amostra: pegar detalhes de cada OS)
    for (const os of osExec) {
      const pontos = await extrairNfDoModal(page, os.os_codigo);
      os.pontos_dados = pontos;
      // Se encontrou NF no modal e não tinha da tabela
      if (!os.numero_pedido_nf && pontos.length > 0) {
        const primeiraNf = pontos.find(p => p.nf);
        if (primeiraNf) os.numero_pedido_nf = primeiraNf.nf;
      }
    }

    // ── Aba "Concluídos" ──
    log('📌 Varrendo aba "Concluídos"...');
    const abaConcl = page.locator('text=Concluídos').first();
    if (await abaConcl.isVisible().catch(() => false)) {
      await abaConcl.click();
      await page.waitForTimeout(2000);
    }
    await screenshot(page, 'concluidos_aba');

    // Paginar concluídos
    for (let pag = 1; pag <= maxPaginasConcluidos; pag++) {
      log(`📄 Concluídos — página ${pag}/${maxPaginasConcluidos}`);
      const osConcl = await extrairOsDaTabela(page, 'concluido');
      log(`  → ${osConcl.length} OS(s) nesta página`);

      // Extrair NFs dos modais (amostra das primeiras 10 por página para não demorar demais)
      const amostra = osConcl.slice(0, 10);
      for (const os of amostra) {
        const pontos = await extrairNfDoModal(page, os.os_codigo);
        os.pontos_dados = pontos;
        if (!os.numero_pedido_nf && pontos.length > 0) {
          const primeiraNf = pontos.find(p => p.nf);
          if (primeiraNf) os.numero_pedido_nf = primeiraNf.nf;
        }
      }

      todasOs.push(...osConcl);

      // Navegar para próxima página se não é a última
      if (pag < maxPaginasConcluidos) {
        const btnProx = page.locator('a:has-text("Próx."), a:has-text("Prox"), .pagination .next a, .pagination a:has-text("›")').first();
        const proxVisivel = await btnProx.isVisible().catch(() => false);
        if (proxVisivel) {
          await btnProx.click();
          await page.waitForTimeout(2000);
        } else {
          log('📄 Sem mais páginas de concluídos');
          break;
        }
      }
    }

    totalOs = todasOs.length;
    log(`📊 Total: ${totalOs} OS(s) extraídas`);

    // ── Salvar no banco ──
    let inseridos = 0;
    for (const os of todasOs) {
      try {
        await pool.query(
          `INSERT INTO antifraude_os_dados
           (os_codigo, numero_pedido_nf, solicitante_cod, solicitante_nome,
            profissional_cod, profissional_nome, categoria, centro_custo,
            status_os, data_solicitacao, valor_servico, valor_profissional,
            pontos_dados, varredura_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (os_codigo, numero_pedido_nf) DO UPDATE SET
             profissional_cod = EXCLUDED.profissional_cod,
             profissional_nome = EXCLUDED.profissional_nome,
             status_os = EXCLUDED.status_os,
             pontos_dados = COALESCE(EXCLUDED.pontos_dados, antifraude_os_dados.pontos_dados),
             varredura_id = EXCLUDED.varredura_id,
             extraido_em = NOW()`,
          [
            os.os_codigo, os.numero_pedido_nf, os.solicitante_cod, os.solicitante_nome,
            os.profissional_cod, os.profissional_nome, os.categoria, os.centro_custo,
            os.status_os, os.data_solicitacao, os.valor_servico, os.valor_profissional,
            os.pontos_dados ? JSON.stringify(os.pontos_dados) : null, varreduraId,
          ]
        );
        inseridos++;
      } catch (err) {
        log(`⚠️ Erro ao salvar OS ${os.os_codigo}: ${err.message}`);
      }
    }
    log(`💾 ${inseridos}/${totalOs} OS(s) salvas no banco`);

    await browser.close();
    return { totalOs, inseridos };

  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = { executarVarredura, extrairOsDaTabela, extrairNfDoModal };
