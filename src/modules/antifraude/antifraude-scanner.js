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
    // Selecionar rows do container correto baseado no status
    const containerId = statusOs === 'em_execucao' ? '#pills-em-execucao' : '#pills-concluidos';
    const container = document.querySelector(containerId);
    const rows = container
      ? container.querySelectorAll('tr[data-order-id]')
      : document.querySelectorAll('tr[data-order-id]');
    const resultados = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 6) return;

      const orderId = row.getAttribute('data-order-id') || '';

      // ── CÓDIGO DA OS ──
      // Link <a> com classe btn-outline-primary, title contém "Número do pedido =XXXXX"
      const linkCodigo = row.querySelector('a.btn-outline-primary, a.btn.btn-sm');
      let osCodigo = orderId;
      if (!osCodigo && linkCodigo) {
        osCodigo = (linkCodigo.textContent || '').trim().replace(/[^\d]/g, '');
      }
      if (!osCodigo) return;

      // ── NÚMERO DO PEDIDO / NF ──
      // No title do link: "Clique para editar - Número do pedido =563873873 8."
      let numeroPedidoNf = '';
      const titleCodigo = linkCodigo?.getAttribute('title') || '';
      const matchPedido = titleCodigo.match(/[Nn]úmero\s+do\s+pedido\s*[=:]\s*(\d+)/);
      if (matchPedido) numeroPedidoNf = matchPedido[1].trim();

      // ── SOLICITANTE (CLIENTE) ──
      // button com data-action="popAlterarSolicitanteServico"
      const btnSolic = row.querySelector('button[data-action="popAlterarSolicitanteServico"]');
      const solicitanteTexto = (btnSolic?.textContent || '').trim();
      const solicitanteCod = solicitanteTexto.match(/^(\d+)/)?.[1] || '';
      const solicitanteNome = solicitanteTexto.replace(/^\d+\s*-\s*/, '').trim();
      // data-balloon tem info completa: "União,FeiraAtacarejoCliente: UNIAO 1541..."
      const solicitanteBalloon = btnSolic?.getAttribute('data-balloon') || '';

      // ── PROFISSIONAL (MOTOBOY) ──
      // button com data-action="trocaMotoboyServicoNovo" e atributo data-motoboy
      const btnProf = row.querySelector('button[data-action="trocaMotoboyServicoNovo"]');
      const profCod = btnProf?.getAttribute('data-motoboy') || '';
      // data-text-title tem: "Dados profissional: 110-Edmilson luz de carvalho(71) 98747-5348..."
      const profDataTitle = btnProf?.getAttribute('data-text-title') || btnProf?.getAttribute('data-text') || '';
      let profNome = (btnProf?.textContent || '').trim().replace(/^\d+-?/, '').trim();
      // Fallback: extrair nome do data-text-title
      if (!profNome && profDataTitle) {
        const matchNome = profDataTitle.match(/profissional:\s*\d+-?([\w\s]+?)(?:\(|$)/i);
        if (matchNome) profNome = matchNome[1].trim();
      }

      // ── DATA / HORA ──
      // link <a> com classe linkPoint e atributo data-date-hour
      const linkData = row.querySelector('a.linkPoint[data-date-hour]');
      const dataHora = linkData?.getAttribute('data-date-hour') || '';
      let dataSolicitacao = null;
      if (dataHora) {
        // Formato: "2026-03-07 08:47:07"
        dataSolicitacao = dataHora.replace(' ', 'T');
      }

      // ── VALORES ──
      // Texto "R$ XX.XX | R$XX.XX" em alguma célula
      let valorServico = null, valorProfissional = null;
      for (const cell of cells) {
        const txt = (cell.textContent || '').trim();
        const valMatch = txt.match(/R\$\s*([\d.,]+)\s*\|?\s*R?\$?\s*([\d.,]+)?/);
        if (valMatch) {
          valorServico = parseFloat(valMatch[1].replace('.', '').replace(',', '.'));
          if (valMatch[2]) valorProfissional = parseFloat(valMatch[2].replace('.', '').replace(',', '.'));
          break;
        }
      }

      // ── CATEGORIA ──
      const btnCat = row.querySelector('button[data-action="alterarCategoriaServico"], button:not([data-action])');
      let categoria = '';
      for (const cell of cells) {
        const txt = (cell.textContent || '').trim();
        if (txt.includes('Motofrete') || txt.includes('Expresso') || txt.includes('Moto')) {
          categoria = txt;
          break;
        }
      }

      resultados.push({
        os_codigo: osCodigo,
        numero_pedido_nf: numeroPedidoNf || null,
        solicitante_cod: solicitanteCod || null,
        solicitante_nome: solicitanteNome || null,
        profissional_cod: profCod || null,
        profissional_nome: profNome || null,
        categoria: categoria || null,
        centro_custo: null,
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
    // Seletor do botão END. — classe btn-mudarclss, data-action funcaoEnderecoServico
    const btnSelector = `button.btn-mudarclss[data-action="funcaoEnderecoServico"][data-id="${osCodigo}"], button[data-action="funcaoEnderecoServico"][data-id="${osCodigo}"], button[data-action="funcaoEnderecoServico"][data-text-id="${osCodigo}"]`;
    const btnCount = await page.locator(btnSelector).count();
    if (btnCount === 0) return [];

    // Clicar via JS (ignora visibilidade — botões podem estar ocultos na tabela paginada)
    const clicked = await page.evaluate((osCod) => {
      // Tentar múltiplos seletores
      const btn = document.querySelector(`button[data-action="funcaoEnderecoServico"][data-id="${osCod}"]`)
                || document.querySelector(`button[data-action="funcaoEnderecoServico"][data-text-id="${osCod}"]`);
      if (btn) { btn.click(); return true; }
      return false;
    }, osCodigo);

    if (!clicked) return [];

    await page.waitForSelector('#modalPadrao.show, #modalPadrao[style*="block"], .modal.show, .modal.in', {
      state: 'visible', timeout: 10000,
    }).catch(() => null);
    await page.waitForTimeout(800);

    // Extrair dados de cada ponto no modal
    const pontos = await page.evaluate(() => {
      const result = [];
      // O modal é #modalPadrao
      const modalBody = document.querySelector('#modalPadrao .modal-body, .modal.show .modal-body, .modal.in .modal-body');
      if (!modalBody) return result;

      const texto = modalBody.innerText || '';

      // Buscar padrões: "Nº nota: XXXXX" — formato real do HTML
      const nfMatches = texto.match(/[Nn][º°]?\s*nota[:\s]+(\d+)/g) || [];
      const notas = new Set();
      nfMatches.forEach(m => {
        const num = m.match(/(\d+)\s*$/);
        if (num) notas.add(num[1]);
      });

      // Buscar botões de corrigir endereço para extrair dados dos pontos
      const btns = modalBody.querySelectorAll('.btn-corrigir-endereco, button[class*="btn-corrigir-endereco"]');
      btns.forEach(btn => {
        const ponto = btn.getAttribute('data-ponto');
        const idEnd = btn.getAttribute('data-id-endereco');
        let endereco = '';
        if (idEnd) {
          const span = document.getElementById('end-antigo-' + idEnd);
          if (span) endereco = (span.textContent || '').trim();
        }

        // Extrair NF do texto próximo ao ponto
        // Formato real: "Avenida... BA - 40370-006 Nº nota: 28224"
        let nfPonto = '';
        // Subir no DOM até encontrar o bloco do ponto
        let container = btn.parentElement;
        for (let i = 0; i < 5 && container; i++) {
          const ctxTexto = container.textContent || '';
          const nfMatch = ctxTexto.match(/[Nn][º°]?\s*nota[:\s]+(\d+)/);
          if (nfMatch) { nfPonto = nfMatch[1]; break; }
          container = container.parentElement;
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

    // Fechar modal — botão X ou tecla Escape
    await page.evaluate(() => {
      const closeBtn = document.querySelector('#modalPadrao .close, .modal.show .close, button[data-dismiss="modal"]');
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(500);

    return pontos;
  } catch (err) {
    log(`⚠️ Erro ao extrair modal OS ${osCodigo}: ${err.message}`);
    // Tentar fechar modal caso aberto
    await page.evaluate(() => {
      const closeBtn = document.querySelector('#modalPadrao .close, .modal.show .close, button[data-dismiss="modal"]');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    await page.waitForTimeout(300);
    return [];
  }
}

/**
 * Executa a varredura completa: login, varre execução + concluídos, extrai NFs.
 * OTIMIZAÇÃO: só abre modal de OSs NOVAS (não conhecidas no banco).
 * OSs antigas: atualiza dados básicos (status, profissional) sem abrir modal.
 * @param {object} pool - Pool do PostgreSQL
 * @param {number} varreduraId - ID do registro em antifraude_varreduras
 * @param {object} config - { janela_dias, max_paginas_concluidos }
 */
async function executarVarredura(pool, varreduraId, config = {}) {
  const maxPaginasConcluidos = parseInt(config.max_paginas_concluidos) || 3;

  if (!process.env.SISTEMA_EXTERNO_URL) {
    throw new Error('SISTEMA_EXTERNO_URL não configurada.');
  }

  // Carregar OSs já conhecidas no banco para pular o modal (operação lenta)
  let osConhecidas = new Set();
  try {
    const { rows } = await pool.query('SELECT DISTINCT os_codigo FROM antifraude_os_dados');
    rows.forEach(r => osConhecidas.add(r.os_codigo));
    log(`📋 ${osConhecidas.size} OS(s) já conhecidas no banco — modal será pulado para estas`);
  } catch (err) {
    log(`⚠️ Erro ao carregar OSs conhecidas: ${err.message}`);
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

    // Helper para atualizar progresso no banco (visível via polling do frontend)
    const atualizarProgresso = async (detalhes) => {
      try {
        await pool.query(
          `UPDATE antifraude_varreduras SET detalhes = $1, os_analisadas = $2 WHERE id = $3`,
          [detalhes, todasOs.length, varreduraId]
        );
      } catch {}
    };

    // Helper: fechar qualquer modal aberto (segurança)
    const fecharModal = async () => {
      await page.evaluate(() => {
        const modal = document.querySelector('#modalPadrao');
        if (modal) { modal.classList.remove('show'); modal.style.display = 'none'; }
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
        document.body.classList.remove('modal-open');
        document.body.style.overflow = '';
      }).catch(() => {});
    };

    // ══════════════════════════════════════════════════
    // ESTRATÉGIA OTIMIZADA: ZERO MODAIS
    // NF/pedido é extraída direto do tooltip do link da OS na tabela
    // (~2s por página vs ~2s por modal = 100x mais rápido)
    // ══════════════════════════════════════════════════

    // ── Aba "Em execução" ──
    log('📌 Varrendo aba "Em execução"...');
    await atualizarProgresso('Abrindo aba Em Execução...');
    await fecharModal();
    await page.evaluate(() => {
      const tab = document.querySelector('#pills-em-execucao-tab');
      if (tab) tab.click();
    }).catch(() => {});
    await page.waitForTimeout(1500);
    await screenshot(page, 'exec_aba');

    const osExec = await extrairOsDaTabela(page, 'em_execucao');
    log(`📊 Em execução: ${osExec.length} OS(s) extraídas (sem modal)`);
    todasOs.push(...osExec);
    await atualizarProgresso(`Em Execução: ${osExec.length} OS(s) extraídas`);

    // ── Aba "Concluídos" ──
    log('📌 Varrendo aba "Concluídos"...');
    await atualizarProgresso('Abrindo aba Concluídos...');
    await fecharModal();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const tab = document.querySelector('#pills-concluidos-tab');
      if (tab) tab.click();
    }).catch(() => {});
    await page.waitForTimeout(2000);
    await screenshot(page, 'concluidos_aba');

    // Paginar concluídos — TODAS as páginas (rápido, sem modal)
    for (let pag = 1; pag <= maxPaginasConcluidos; pag++) {
      log(`📄 Concluídos — página ${pag}/${maxPaginasConcluidos}`);
      await atualizarProgresso(`Concluídos: extraindo página ${pag}/${maxPaginasConcluidos} (${todasOs.length} OSs até agora)...`);
      const osConcl = await extrairOsDaTabela(page, 'concluido');
      log(`  → ${osConcl.length} OS(s) nesta página`);

      todasOs.push(...osConcl);

      // Navegar para próxima página se não é a última
      if (pag < maxPaginasConcluidos) {
        const temProx = await page.evaluate((pagAtual) => {
          // Buscar link da próxima página na paginação
          const proxPage = pagAtual + 1;
          const link = document.querySelector(`ul#concluido a.page-link[data-page="${proxPage}"]`)
                    || document.querySelector(`.pagination a.page-link[data-page="${proxPage}"]`);
          if (link) { link.click(); return true; }
          // Fallback: botão "Próx." ou "›"
          const allLinks = document.querySelectorAll('.pagination a.page-link');
          for (const l of allLinks) {
            if (l.textContent.includes('›') || l.textContent.includes('Próx')) { l.click(); return true; }
          }
          return false;
        }, pag);
        if (temProx) {
          await page.waitForTimeout(2000);
          await atualizarProgresso(`Concluídos: navegando para página ${pag + 1}...`);
        } else {
          log('📄 Sem mais páginas de concluídos');
          break;
        }
      }
    }

    totalOs = todasOs.length;
    log(`📊 Total: ${totalOs} OS(s) extraídas (${todasOs.filter(os => !osConhecidas.has(os.os_codigo)).length} novas)`);

    // ── Salvar no banco ──
    await atualizarProgresso(`Salvando ${totalOs} OS(s) no banco...`);
    // OSs NOVAS: INSERT | OSs ANTIGAS: UPDATE dados básicos (status, profissional)
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
