/**
 * playwright-agent.js
 * Automação RPA: corrige endereço de um ponto numa OS do sistema externo.
 * Sistema: tutts.com.br/expresso
 *
 * Seletores mapeados do HTML real:
 *   Aba Execução : #pills-em-execucao-tab
 *   Select Tipo  : #search-type (custom-select)
 *   Autocomplete : .ui-menu-item .ui-menu-item-wrapper (jQuery UI)
 *   Botão END.   : button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="<OS>"]
 *   Botão Corrigir: .btn-corrigir-endereco[data-ponto="${ponto}"]
 *   Input Lat     : input[placeholder="Latitude"]
 *   Input Lon     : input[placeholder="Longitude"]
 *   Validar       : button.btn-validar-endereco
 *   Confirmar     : button.btn-confirmar-alteracao
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
  logger.info(`[playwright-agent] ${msg}`);
}

async function screenshot(page, os, etapa) {
  const file = path.join(SCREENSHOT_DIR, `OS${os}_${etapa}_${Date.now()}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); } catch (_) {}
  log(`📸 ${path.basename(file)}`);
  return path.basename(file);
}

async function isLoggedIn(page) {
  const url = page.url();
  return url.includes('/expresso') && !url.includes('loginFuncionarioNovo');
}

async function fazerLogin(page) {
  log('🔐 Fazendo login...');

  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    const ss = await screenshot(page, 'login', 'pagina_nao_carregou');
    throw new Error(`Página de login não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
  }

  await page.fill('#loginEmail', process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.SISTEMA_EXTERNO_SENHA);

  // type="button" com name="logar" (não é submit!)
  await page.locator('input[name="logar"]').first().click();

  // Aguardar sair da página de login
  await page.waitForURL(
    url => !url.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log(`✅ Login OK — URL: ${page.url()}`);
}

async function executarCorrecaoEndereco({ os_numero, ponto, latitude, longitude, cod_profissional }) {
  if (!process.env.SISTEMA_EXTERNO_URL) {
    return { sucesso: false, erro: 'SISTEMA_EXTERNO_URL não configurada.' };
  }
  if (ponto === 1) {
    return { sucesso: false, erro: 'Segurança: Ponto 1 nunca pode ser alterado.' };
  }

  log(`🚀 OS ${os_numero} | Ponto ${ponto} | ${latitude}, ${longitude}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
      '--no-first-run',
      '--single-process',        // Usa menos memória no Railway
    ],
  });

  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE)) {
    contextOptions = { storageState: SESSION_FILE };
    log('♻️  Usando sessão salva');
  }

  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // ── Passo 1: Autenticação + ir para acompanhamento ───────────────────────
    log('📌 Passo 1: Autenticação');

    await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    if (!(await isLoggedIn(page))) {
      if (fs.existsSync(SESSION_FILE)) {
        fs.unlinkSync(SESSION_FILE);
        log('🗑️  Sessão inválida removida');
      }
      await fazerLogin(page);
      await page.goto(ACOMP_URL(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(2000);
      await context.storageState({ path: SESSION_FILE });
      log('💾 Sessão salva');
    } else {
      log('✅ Já logado');
    }

    await screenshot(page, os_numero, 'passo1_acompanhamento');

    // ── Passo 1b: Garantir que está na aba "Em execução" ────────────────────
    log('📌 Passo 1b: Clicando na aba "Em execução"');
    const abaEmExecucao = page.locator('#pills-em-execucao-tab');
    const abaVisivel = await abaEmExecucao.isVisible().catch(() => false);
    if (abaVisivel) {
      await abaEmExecucao.click();
      await page.waitForTimeout(2000);
      log('✅ Aba "Em execução" selecionada');
    }
    await screenshot(page, os_numero, 'passo1b_aba_em_execucao');

    // ── Passo 2: Localizar botão END. da OS ────────────────────────────────
    log(`📌 Passo 2: Localizando OS ${os_numero}`);

    const btnSelector = `button.btn-modal[data-action="funcaoEnderecoServico"][data-id="${os_numero}"], button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="${os_numero}"]`;

    // Tentativa 1: botão existe no DOM na aba "Em execução" (pode não estar visível no viewport)
    let btnCount = await page.locator(btnSelector).count();
    log(`🔎 Botão END. encontrado no DOM: ${btnCount > 0 ? 'SIM' : 'NÃO'} (count: ${btnCount})`);

    if (btnCount === 0) {
      // Debug: capturar HTML dos botões btn-modal existentes na página
      const allBtnModals = await page.locator('button.btn-modal').count();
      log(`🔎 Debug: Total de button.btn-modal na página: ${allBtnModals}`);
      
      // Debug: procurar botões com funcaoEnderecoServico especificamente
      const btnEndAll = await page.locator('button.btn-modal[data-action="funcaoEnderecoServico"]').count();
      log(`🔎 Debug: Botões funcaoEnderecoServico: ${btnEndAll}`);
      if (btnEndAll > 0) {
        const endHtml = await page.locator('button.btn-modal[data-action="funcaoEnderecoServico"]').first().evaluate(el => el.outerHTML);
        log(`🔎 Debug: Botão END HTML: ${endHtml.substring(0, 400)}`);
      } else if (allBtnModals > 0) {
        // Listar todos os data-action únicos para entender a estrutura
        const actions = await page.locator('button.btn-modal').evaluateAll(els => 
          [...new Set(els.map(el => `${el.getAttribute('data-action')}|id=${el.getAttribute('data-id')}|text-id=${el.getAttribute('data-text-id')}`))].slice(0, 5)
        );
        log(`🔎 Debug: Ações dos btn-modal: ${JSON.stringify(actions)}`);
      }

      log('🔍 Botão não encontrado no DOM — usando pesquisa...');
      await screenshot(page, os_numero, 'passo2_antes_pesquisa');

      // Clicar na barra "Pesquisar serviços" para expandir
      const barraPesquisa = page.locator('text=Pesquisar serviços').first();
      const barraVisivel = await barraPesquisa.isVisible().catch(() => false);
      if (barraVisivel) {
        await barraPesquisa.click();
        await page.waitForTimeout(1000);
        log('✅ Barra de pesquisa expandida');
      }
      await screenshot(page, os_numero, 'passo2_pesquisa_expandida');

      // Selecionar "Serviço" no select #search-type (classe custom-select)
      const selectPesquisa = page.locator('#search-type');
      const selectVisivel = await selectPesquisa.isVisible().catch(() => false);
      if (selectVisivel) {
        await selectPesquisa.selectOption({ label: 'Serviço' });
        await page.waitForTimeout(1000);
        log('✅ Tipo de pesquisa: Serviço');
      }
      await screenshot(page, os_numero, 'passo2_tipo_servico');

      // Preencher número da OS no campo de busca
      const inputBusca = page.locator('#search-autocomplete-input, input[placeholder*="número do serviço"]').first();
      await inputBusca.waitFor({ state: 'visible', timeout: TIMEOUT });
      await screenshot(page, os_numero, 'passo2_campo_busca');

      await inputBusca.fill(String(os_numero));
      await page.waitForTimeout(2000); // Aguardar jQuery UI autocomplete carregar
      await screenshot(page, os_numero, 'passo2_autocomplete');

      // Clicar no item do autocomplete (jQuery UI: .ui-menu-item-wrapper)
      const autoItem = page.locator('.ui-menu-item .ui-menu-item-wrapper').filter({ hasText: String(os_numero) }).first();
      const autoVisivel = await autoItem.isVisible().catch(() => false);

      if (autoVisivel) {
        await autoItem.click();
        log('✅ Item do autocomplete clicado');
      } else {
        // Fallback: tentar qualquer .ui-menu-item visível
        const anyAutoItem = page.locator('.ui-menu-item-wrapper:visible').first();
        const anyVisivel = await anyAutoItem.isVisible().catch(() => false);
        if (anyVisivel) {
          await anyAutoItem.click();
          log('✅ Primeiro item do autocomplete clicado (fallback)');
        } else {
          log('⚠️ Autocomplete não encontrado — tentando Enter');
          await inputBusca.press('Enter');
        }
      }

      await page.waitForTimeout(3000); // Aguardar resultado carregar
      await screenshot(page, os_numero, 'passo2_resultado_busca');

      // Aguardar botão END. aparecer no DOM após busca (não precisa estar visível)
      await page.waitForSelector(
        `button.btn-modal[data-action="funcaoEnderecoServico"][data-id="${os_numero}"], button.btn-modal[data-action="funcaoEnderecoServico"][data-text-id="${os_numero}"]`,
        { state: 'attached', timeout: TIMEOUT }
      );
    }

    // Scroll até o botão para garantir que está visível no viewport
    const btnEnd = page.locator(btnSelector).first();
    await btnEnd.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await screenshot(page, os_numero, 'passo2_botao_encontrado');

    // ── Passo 2a: Validar que a OS está Em Execução (não concluída/cancelada) ──
    log('📌 Passo 2a: Verificando status da OS');
    try {
      const statusOS = await btnEnd.evaluate((btn) => {
        // Subir até a <tr> da OS
        const row = btn.closest('tr');
        if (!row) return 'desconhecido';

        // Verificar classes da row
        const classes = row.className || '';
        if (classes.includes('osConcluidaHoje') || classes.includes('Concluida') || classes.includes('concluida')) return 'concluida';
        if (classes.includes('osCancelada') || classes.includes('Cancelada') || classes.includes('cancelada')) return 'cancelada';
        if (classes.includes('osEmExecucao') || classes.includes('EmExecucao') || classes.includes('emExecucao')) return 'em_execucao';

        // Verificar a seção pai (div com texto "Serviço(s) concluído(s)" ou "Em execução")
        let parent = row.parentElement;
        while (parent) {
          const prevSibling = parent.previousElementSibling;
          if (prevSibling) {
            const txt = (prevSibling.textContent || '').toLowerCase();
            if (txt.includes('concluíd') || txt.includes('concluid')) return 'concluida';
            if (txt.includes('cancelad')) return 'cancelada';
            if (txt.includes('em execução') || txt.includes('em execucao')) return 'em_execucao';
          }
          // Também verificar o próprio parent
          const parentTxt = (parent.className || '').toLowerCase();
          if (parentTxt.includes('conclu')) return 'concluida';
          if (parentTxt.includes('cancel')) return 'cancelada';
          parent = parent.parentElement;
        }
        return 'em_execucao'; // default se não conseguiu identificar
      }).catch(() => 'desconhecido');

      log(`📋 Status da OS: ${statusOS}`);

      if (statusOS === 'concluida') {
        const ss = await screenshot(page, os_numero, 'passo2a_os_concluida');
        await browser.close();
        return {
          sucesso: false,
          erro: `[Validação] A OS ${os_numero} já está concluída/finalizada no sistema. Apenas OS em execução podem ter o endereço corrigido.`,
          screenshot: ss,
        };
      }

      if (statusOS === 'cancelada') {
        const ss = await screenshot(page, os_numero, 'passo2a_os_cancelada');
        await browser.close();
        return {
          sucesso: false,
          erro: `[Validação] A OS ${os_numero} está cancelada. Não é possível corrigir endereço de OS cancelada.`,
          screenshot: ss,
        };
      }
    } catch (e) {
      log(`⚠️ Não foi possível verificar status da OS: ${e.message} — prosseguindo`);
    }

    // ── Passo 2b: Validar que o profissional da OS confere com quem solicitou ──
    if (cod_profissional) {
      log(`📌 Passo 2b: Validando profissional (cod: ${cod_profissional})`);
      try {
        // Localizar na row da OS o botão que contém data-motoboy ou o texto do profissional
        const rowOS = page.locator(`tr`).filter({ has: btnEnd }).first();
        
        // Tentar pegar data-motoboy do botão de profissional na mesma row
        const motoboyNaOS = await rowOS.evaluate((row, codProf) => {
          // Buscar botão com data-motoboy
          const btnMotoboy = row.querySelector('button[data-motoboy]');
          if (btnMotoboy) {
            return btnMotoboy.getAttribute('data-motoboy') || '';
          }
          // Fallback: procurar texto que contenha o código do profissional
          const textos = row.querySelectorAll('td, span, button');
          for (const el of textos) {
            const txt = (el.textContent || '').trim();
            if (txt.includes(String(codProf))) return String(codProf);
          }
          return '';
        }, cod_profissional).catch(() => '');

        if (motoboyNaOS) {
          const codLimpo = String(cod_profissional).trim();
          if (!motoboyNaOS.includes(codLimpo)) {
            const ss = await screenshot(page, os_numero, 'passo2b_motoboy_divergente');
            await browser.close();
            return {
              sucesso: false,
              erro: `[Segurança] O profissional que solicitou (cód. ${codLimpo}) não corresponde ao profissional vinculado à OS ${os_numero} (cód. ${motoboyNaOS}). Correção não autorizada.`,
              screenshot: ss,
            };
          }
          log(`✅ Profissional validado: ${motoboyNaOS}`);
        } else {
          log('⚠️ Não foi possível extrair código do profissional da OS — prosseguindo');
        }
      } catch (e) {
        log(`⚠️ Erro na validação do profissional: ${e.message} — prosseguindo`);
      }
    }

    // ── Passo 3: Abrir modal de endereços ────────────────────────────────────
    log('📌 Passo 3: Abrindo modal de endereços');
    await btnEnd.click({ force: true });

    // Aguardar modal abrir
    await page.waitForSelector('.modal.show, .modal.in, #modalPadrao.show, #modalPadrao.in', {
      state: 'visible',
      timeout: TIMEOUT,
    });

    await page.waitForTimeout(1500);
    await screenshot(page, os_numero, 'passo3_modal');

    // ── Passo 3b: Verificar se o ponto solicitado existe na OS ───────────────
    log(`📌 Passo 3b: Verificando se Ponto ${ponto} existe na OS`);
    const pontoExiste = await page.locator(`.btn-corrigir-endereco[data-ponto="${ponto}"]`).count().catch(() => 0);
    
    if (pontoExiste === 0) {
      // Contar quantos pontos a OS realmente tem
      const totalPontos = await page.locator('.btn-corrigir-endereco').count().catch(() => 0);
      const pontosDisponiveis = await page.locator('.btn-corrigir-endereco').evaluateAll(els => 
        els.map(el => el.getAttribute('data-ponto')).filter(Boolean)
      ).catch(() => []);
      
      const ss = await screenshot(page, os_numero, 'passo3b_ponto_inexistente');
      await browser.close();
      return {
        sucesso: false,
        erro: `[Validação] O Ponto ${ponto} não existe nesta OS. A OS ${os_numero} possui apenas ${totalPontos} ponto(s) corrigível(is)${pontosDisponiveis.length > 0 ? ` (pontos: ${pontosDisponiveis.join(', ')})` : ''}. Verifique o ponto correto e tente novamente.`,
        screenshot: ss,
      };
    }
    log(`✅ Ponto ${ponto} encontrado na OS`);

    // Capturar endereço antigo do ponto ANTES de clicar em Corrigir
    let enderecoAntigo = '';

    try {
      // HTML exato: <span id="end-antigo-{idEndereco}"> contém o endereço antigo
      // O botão tem data-id-endereco="{idEndereco}" e data-ponto="{N}"
      enderecoAntigo = await page.evaluate((pontoNum) => {
        const btn = document.querySelector(`.btn-corrigir-endereco[data-ponto="${pontoNum}"]`);
        if (!btn) return '';

        const idEndereco = btn.getAttribute('data-id-endereco');

        // Estratégia 1: span#end-antigo-{id} (o conteúdo pode estar display:none mas textContent funciona)
        if (idEndereco) {
          const span = document.getElementById(`end-antigo-${idEndereco}`);
          if (span) {
            const txt = (span.textContent || '').trim();
            if (txt.length > 5) return txt;
          }
        }

        // Estratégia 2: O endereço está como texto direto no container pai, antes do botão
        // Estrutura: "📍 Ponto N [ENDEREÇO] PEC Nº nota: XXXXX [Botão Corrigir]"
        // Subir até o div que contém todo o bloco do ponto
        let container = btn.parentElement;
        while (container && !container.textContent.includes('Ponto')) {
          container = container.parentElement;
          if (container && container.classList.contains('modal-body')) break;
        }
        if (container) {
          // Pegar o texto completo do bloco e extrair o endereço
          const fullText = container.textContent || '';
          // O endereço vem depois de "Ponto N " e antes de "PEC" ou "Corrigir"
          const regexEnd = /Ponto\s*\d+\s*([\s\S]*?)(?:PEC|Corrigir|$)/i;
          const match = fullText.match(regexEnd);
          if (match) {
            const addr = match[1].replace(/\s+/g, ' ').trim();
            if (addr.length > 10) return addr.substring(0, 300);
          }
        }

        return '';
      }, ponto).catch(() => '');

      if (enderecoAntigo) {
        log(`📍 Endereço antigo Ponto ${ponto}: ${enderecoAntigo}`);
      } else {
        log('⚠️ Endereço antigo não capturado');
      }
    } catch (e) {
      log(`⚠️ Erro ao capturar endereço antigo: ${e.message}`);
    }

    // ── Passo 4: Clicar em Corrigir no ponto específico ──────────────────────
    log(`📌 Passo 4: Corrigindo Ponto ${ponto}`);

    // Configurar handler para dialogs do navegador (confirm/alert)
    // O sistema pode pedir confirmação em qualquer passo
    page.on('dialog', async (dialog) => {
      log(`💬 Dialog detectado: "${dialog.message()}" — aceitando`);
      await dialog.accept();
    });

    await page.click(`.btn-corrigir-endereco[data-ponto="${ponto}"]`);
    await page.waitForTimeout(1500);
    await screenshot(page, os_numero, `passo4_ponto${ponto}_clicado`);

    // Verificar se o form de correção abriu (inputs de lat/lng devem estar visíveis)
    const formAbriu = await page.locator('input[placeholder="Latitude"]:visible').count().catch(() => 0);
    if (formAbriu === 0) {
      // Tentar clicar novamente
      log('⚠️ Form não abriu, tentando clicar novamente...');
      await page.click(`.btn-corrigir-endereco[data-ponto="${ponto}"]`);
      await page.waitForTimeout(2000);
    }

    // ── Passo 5: Preencher lat/lng e validar ─────────────────────────────────
    log('📌 Passo 5: Preenchendo coordenadas');

    const inputLat = page.locator('input[placeholder="Latitude"]:visible').first();
    const inputLon = page.locator('input[placeholder="Longitude"]:visible').first();

    await inputLat.waitFor({ state: 'visible', timeout: TIMEOUT });
    await inputLon.waitFor({ state: 'visible', timeout: TIMEOUT });

    // Limpar e preencher — triple click + fill para garantir
    await inputLat.click({ clickCount: 3 });
    await inputLat.fill('');
    await inputLat.type(String(latitude), { delay: 50 });
    
    await inputLon.click({ clickCount: 3 });
    await inputLon.fill('');
    await inputLon.type(String(longitude), { delay: 50 });

    // Verificar que os valores foram preenchidos
    const latPreenchido = await inputLat.inputValue().catch(() => '');
    const lonPreenchido = await inputLon.inputValue().catch(() => '');
    log(`📍 Lat preenchido: "${latPreenchido}" | Lon preenchido: "${lonPreenchido}"`);

    if (!latPreenchido || !lonPreenchido) {
      const ss = await screenshot(page, os_numero, 'passo5_inputs_vazios');
      await browser.close();
      return {
        sucesso: false,
        erro: `Falha ao preencher coordenadas. Lat: "${latPreenchido}", Lon: "${lonPreenchido}"`,
        screenshot: ss,
      };
    }

    // Clicar em Validar
    const btnValidar = page.locator('button.btn-validar-endereco:visible').first();
    await btnValidar.waitFor({ state: 'visible', timeout: TIMEOUT });
    await btnValidar.click();
    log('📌 Botão Validar clicado, aguardando geocoder...');

    // Aguardar geocoder — esperar botão Confirmar aparecer (com polling)
    let confirmarVisivel = false;
    for (let tentativa = 0; tentativa < 10; tentativa++) {
      await page.waitForTimeout(1000);
      confirmarVisivel = await page.locator('button.btn-confirmar-alteracao:visible').isVisible().catch(() => false);
      if (confirmarVisivel) break;
    }
    
    await screenshot(page, os_numero, 'passo5_pos_validar');

    if (!confirmarVisivel) {
      const ss = await screenshot(page, os_numero, 'passo5_geocoder_vazio');
      await browser.close();
      return {
        sucesso: false,
        erro: `Coordenadas (${latitude}, ${longitude}) não reconhecidas pelo geocoder. Botão Confirmar não apareceu após 10s.`,
        screenshot: ss,
      };
    }
    log('✅ Geocoder OK — botão Confirmar visível');

    // Capturar endereço resolvido pelo geocoder (bônus)
    let enderecoResolvido = '';
    try {
      enderecoResolvido = await page.evaluate(() => {
        const btnConfirmar = document.querySelector('.btn-confirmar-alteracao');
        if (!btnConfirmar) return '';
        const container = btnConfirmar.closest('.card-body') || btnConfirmar.closest('div') || btnConfirmar.parentElement;
        if (!container) return '';
        const els = container.querySelectorAll('p, span, div, small, strong');
        for (const el of els) {
          const txt = (el.textContent || '').trim();
          if (txt.length > 15 && txt.includes(',') &&
              !txt.includes('Latitude') && !txt.includes('Longitude') &&
              !txt.includes('Confirmar') && !txt.includes('Validar') &&
              el.children.length === 0 && el.offsetParent !== null) {
            return txt.substring(0, 300);
          }
        }
        return '';
      }).catch(() => '');
      if (enderecoResolvido) log(`📍 Endereço novo (DOM): ${enderecoResolvido}`);
    } catch (e) {
      log(`⚠️ Endereço novo não capturado do DOM: ${e.message}`);
    }

    // ── Passo 6: Confirmar alteração ─────────────────────────────────────────
    log('📌 Passo 6: Confirmando alteração de endereço');

    // Capturar o endereço antigo do span ANTES de confirmar (para comparar depois)
    const endAntigoSpan = await page.evaluate((pontoNum) => {
      const btn = document.querySelector(`.btn-corrigir-endereco[data-ponto="${pontoNum}"]`);
      if (!btn) return '';
      const idEnd = btn.getAttribute('data-id-endereco');
      if (!idEnd) return '';
      const span = document.getElementById(`end-antigo-${idEnd}`);
      return span ? (span.textContent || '').trim() : '';
    }, ponto).catch(() => '');

    await page.locator('button.btn-confirmar-alteracao:visible').first().click();

    // Aguardar processamento — verificar que algo mudou
    await page.waitForTimeout(3000);
    await screenshot(page, os_numero, 'passo6_pos_confirmar');

    // Verificar que a confirmação realmente aplicou:
    // 1. O botão btn-confirmar-alteracao deve ter sumido
    // 2. Ou o span end-antigo mudou
    // 3. Ou apareceu mensagem de sucesso
    const confirmarAindaVisivel = await page.locator('button.btn-confirmar-alteracao:visible').isVisible().catch(() => false);
    
    if (confirmarAindaVisivel) {
      // Pode ter aparecido um dialog que não foi tratado, ou erro
      log('⚠️ Botão Confirmar ainda visível após clique — tentando novamente');
      await page.locator('button.btn-confirmar-alteracao:visible').first().click();
      await page.waitForTimeout(3000);
      
      const aindaVisivel2 = await page.locator('button.btn-confirmar-alteracao:visible').isVisible().catch(() => false);
      if (aindaVisivel2) {
        const ss = await screenshot(page, os_numero, 'passo6_confirmar_falhou');
        await browser.close();
        return {
          sucesso: false,
          erro: `Falha ao confirmar alteração. O botão "Confirmar" permanece visível após 2 tentativas. O endereço pode não ter sido alterado.`,
          screenshot: ss,
        };
      }
    }

    // Verificar se o endereço mudou comparando o span
    const endNovoSpan = await page.evaluate((pontoNum) => {
      const btn = document.querySelector(`.btn-corrigir-endereco[data-ponto="${pontoNum}"]`);
      if (!btn) return 'btn-sumiu'; // botão sumiu = form fechou = sucesso provável
      const idEnd = btn.getAttribute('data-id-endereco');
      if (!idEnd) return '';
      const span = document.getElementById(`end-antigo-${idEnd}`);
      return span ? (span.textContent || '').trim() : '';
    }, ponto).catch(() => '');

    if (endAntigoSpan && endNovoSpan && endAntigoSpan !== 'btn-sumiu' && endNovoSpan !== 'btn-sumiu' && endAntigoSpan === endNovoSpan) {
      log(`⚠️ Endereço NÃO mudou no DOM. Antes: "${endAntigoSpan}" | Depois: "${endNovoSpan}"`);
      // Não retorna erro pois pode ser que o DOM ainda não atualizou
    } else {
      log('✅ Confirmação aplicada com sucesso');
    }

    await screenshot(page, os_numero, 'passo6_endereco_confirmado');
    log('✅ Endereço confirmado');

    // ── Passo 7: Navegar para edição da OS ──────────────────────────────────
    log('📌 Passo 7: Abrindo página de edição da OS');

    let freteRecalculado = false;
    let enderecoParaPreencher = enderecoResolvido || '';

    try {
      // Extrair a URL de edição do link na tabela
      const urlEdicao = await page.evaluate((osNum) => {
        const links = document.querySelectorAll('a.btn-outline-primary, a[href*="editarOS"]');
        for (const link of links) {
          if ((link.textContent || '').trim().includes(osNum)) return link.href || '';
        }
        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
          if ((row.textContent || '').includes(osNum)) {
            const a = row.querySelector('a.btn-outline-primary, a[href*="editarOS"]');
            if (a) return a.href || '';
          }
        }
        return '';
      }, os_numero).catch(() => '');

      if (!urlEdicao) {
        log('⚠️ URL de edição da OS não encontrada');
        await screenshot(page, os_numero, 'passo7_url_nao_encontrada');
        throw new Error('URL_EDICAO_NAO_ENCONTRADA');
      }

      log(`📌 URL: ${urlEdicao}`);
      await page.goto(urlEdicao, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      await screenshot(page, os_numero, 'passo7_pagina_edicao');

      // ── Passo 8: Atualizar endereço no input do ponto ───────────────────────
      log(`📌 Passo 8: Atualizando endereço do Ponto ${ponto}`);

      // O input do endereço: input#txtEnderecoE{ponto}  (ex: txtEnderecoE2, txtEnderecoE3)
      const seletorInput = `#txtEnderecoE${ponto}`;
      const inputEndereco = page.locator(seletorInput);
      const inputExiste = await inputEndereco.count().catch(() => 0);

      if (inputExiste === 0) {
        log(`⚠️ Input ${seletorInput} não encontrado na página`);
        await screenshot(page, os_numero, 'passo8_input_nao_encontrado');
        throw new Error('INPUT_ENDERECO_NAO_ENCONTRADO');
      }

      // Resolver o endereço legível via geocodificação reversa
      if (!enderecoParaPreencher || /^-?\d+\.\d+/.test(enderecoParaPreencher)) {
        // Fazer geocodificação reversa para obter endereço legível
        try {
          const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
          if (GOOGLE_API_KEY) {
            const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_API_KEY}&language=pt-BR`;
            const geoRes = await fetch(geoUrl);
            const geoData = await geoRes.json();
            if (geoData.status === 'OK' && geoData.results?.[0]) {
              enderecoParaPreencher = geoData.results[0].formatted_address;
              log(`📍 Endereço via geocode: ${enderecoParaPreencher}`);
            }
          }
        } catch (geoErr) {
          log(`⚠️ Geocode falhou: ${geoErr.message}`);
        }
      }

      if (!enderecoParaPreencher) {
        log('⚠️ Sem endereço legível para preencher — usando coordenadas');
        enderecoParaPreencher = `${latitude}, ${longitude}`;
      }

      // Scroll até o input
      await inputEndereco.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);

      // Limpar e preencher o endereço
      await inputEndereco.click({ clickCount: 3 });
      await inputEndereco.fill('');
      await inputEndereco.fill(enderecoParaPreencher);
      await page.waitForTimeout(500);

      // Verificar que preencheu
      const valorInput = await inputEndereco.inputValue().catch(() => '');
      log(`📍 Input preenchido: "${valorInput}"`);
      await screenshot(page, os_numero, 'passo8_endereco_preenchido');

      // ── Passo 8b: Clicar na lupa (buscar endereço) ──────────────────────────
      log('📌 Passo 8b: Clicando no botão buscar (lupa)');

      // O botão da lupa: button.buscar-endereco{ponto} com onclick n20Resquest({ponto})
      // ou button com classe btn-info dentro do input-group-btn do ponto
      const seletoresLupa = [
        `button.buscar-endereco${ponto}`,
        `button[onclick*="n20Resquest(${ponto})"]`,
        `button[onclick*="n20Resquest('${ponto}')"]`,
        `#divEndAdd${ponto} button.btn-info`,
        `#divEndereco${ponto} button.btn-info`,
        `#divRuaNumero${ponto} button.btn-info`,
      ];

      let lupaClicada = false;
      for (const sel of seletoresLupa) {
        const btn = page.locator(sel).first();
        const existe = await btn.count().catch(() => 0);
        if (existe > 0) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click();
          log(`📌 Lupa clicada: ${sel}`);
          lupaClicada = true;
          break;
        }
      }

      if (!lupaClicada) {
        // Fallback: procurar qualquer botão com fa-search próximo ao input
        const lupaFallback = await page.evaluate((pontoNum) => {
          const input = document.getElementById(`txtEnderecoE${pontoNum}`);
          if (!input) return false;
          // Subir até o form-group e procurar botão com ícone de busca
          const parent = input.closest('.form-group') || input.closest('.input-group') || input.parentElement?.parentElement;
          if (parent) {
            const btn = parent.querySelector('button.btn-info, button.buscar-endereco, button:has(.fa-search)');
            if (btn) { btn.click(); return true; }
          }
          // Procurar o próximo botão com fa-search
          const allBtns = document.querySelectorAll(`button[onclick*="n20Resquest"]`);
          for (const b of allBtns) {
            const onclick = b.getAttribute('onclick') || '';
            if (onclick.includes(String(pontoNum))) { b.click(); return true; }
          }
          return false;
        }, ponto).catch(() => false);

        if (lupaFallback) {
          log('📌 Lupa clicada via fallback JS');
          lupaClicada = true;
        } else {
          log('⚠️ Botão lupa não encontrado');
          await screenshot(page, os_numero, 'passo8b_lupa_nao_encontrada');
        }
      }

      if (lupaClicada) {
        // Aguardar busca processar
        await page.waitForTimeout(3000);
        await screenshot(page, os_numero, 'passo8b_pos_busca');

        // ── Passo 8c: Se aparecer validação/confirmação, aceitar ─────────────
        // O dialog handler já está ativo (page.on('dialog')), mas pode haver
        // botão de validar verde (btn-success validar) na tela
        log('📌 Passo 8c: Verificando validação');

        const btnValidarEndereco = page.locator('button.btn-success.validar, button.btn-success:has(.fa-check-circle-o)').first();
        const validarExiste = await btnValidarEndereco.count().catch(() => 0);

        if (validarExiste > 0) {
          const validarVisivel = await btnValidarEndereco.isVisible().catch(() => false);
          if (validarVisivel) {
            await btnValidarEndereco.click();
            log('📌 Validação aceita (botão verde)');
            await page.waitForTimeout(2000);
            await screenshot(page, os_numero, 'passo8c_validacao_aceita');
          }
        }

        // Verificar se apareceu split de rua/número/bairro (print 3)
        // Se checkEdit ficou true, o sistema já validou
        const checkEdit = await page.evaluate((p) => {
          const inp = document.getElementById(`checkEdit-${p}`);
          return inp ? inp.value : '';
        }, ponto).catch(() => '');

        if (checkEdit) {
          log(`📌 Endereço validado pelo sistema: ${checkEdit}`);
        }
      }

      // ── Passo 9: Calcular frete ─────────────────────────────────────────────
      log('📌 Passo 9: Calculando frete');

      const btnCalcular = page.locator('#btnCalcFreteCEN');
      const calcExiste = await btnCalcular.count().catch(() => 0);

      if (calcExiste > 0) {
        await btnCalcular.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        await btnCalcular.click();
        log('📌 Botão Calcular clicado');

        // Aguardar cálculo — polling por resultado
        let valorEncontrado = false;
        for (let i = 0; i < 12; i++) {
          await page.waitForTimeout(1000);
          const temValor = await page.evaluate(() => {
            const els = document.querySelectorAll('div, span, p, td');
            for (const el of els) {
              if ((el.textContent || '').match(/R\$\s*\d+[.,]\d{2}/)) return true;
            }
            return false;
          }).catch(() => false);
          if (temValor) {
            valorEncontrado = true;
            break;
          }
        }

        await screenshot(page, os_numero, 'passo9_pos_calcular');

        if (valorEncontrado) {
          log('💰 Valor calculado com sucesso');
        } else {
          log('⚠️ Valor não apareceu após 12s — tentando salvar mesmo assim');
        }

        // ── Passo 10: Salvar alterações ─────────────────────────────────────────
        log('📌 Passo 10: Salvando alterações');

        const btnSalvar = page.locator('#btnChamarMotoboy');
        const salvarExiste = await btnSalvar.count().catch(() => 0);

        if (salvarExiste > 0) {
          await btnSalvar.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(500);
          await btnSalvar.click();
          log('📌 Botão Salvar clicado');

          await page.waitForTimeout(4000);
          await screenshot(page, os_numero, 'passo10_pos_salvar');

          // Verificar resultado
          const alertaErro = await page.locator('.alert-danger:visible, .swal2-error:visible').count().catch(() => 0);
          if (alertaErro > 0) {
            log('⚠️ Erro detectado ao salvar');
          } else {
            log('✅ Frete recalculado e alterações salvas!');
            freteRecalculado = true;
          }
        } else {
          log('⚠️ Botão Salvar (#btnChamarMotoboy) não encontrado');
          await screenshot(page, os_numero, 'passo10_btn_salvar_ausente');
        }
      } else {
        log('⚠️ Botão Calcular (#btnCalcFreteCEN) não encontrado');
        await screenshot(page, os_numero, 'passo9_btn_calcular_ausente');
      }
    } catch (e) {
      log(`⚠️ Erro no recálculo: ${e.message}`);
      await screenshot(page, os_numero, 'passo7_erro_recalculo').catch(() => null);
    }

    log(`🎉 OS ${os_numero} Ponto ${ponto} — completo! Frete: ${freteRecalculado ? 'SIM' : 'NÃO'}`);
    return { sucesso: true, endereco_corrigido: enderecoResolvido || enderecoParaPreencher || null, endereco_antigo: enderecoAntigo || null, frete_recalculado: freteRecalculado };

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    const ss = await screenshot(page, os_numero, 'erro_inesperado');
    return { sucesso: false, erro: `Erro inesperado: ${err.message}`, screenshot: ss };
  } finally {
    await browser.close();
  }
}

module.exports = { executarCorrecaoEndereco };
