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

    // Capturar endereço antigo do ponto antes de corrigir
    let enderecoAntigo = '';
    try {
      // O endereço do ponto geralmente está no card/row do ponto, próximo ao botão Corrigir
      const btnCorrigir = page.locator(`.btn-corrigir-endereco[data-ponto="${ponto}"]`).first();
      enderecoAntigo = await btnCorrigir.evaluate((btn, p) => {
        // Subir até o container do ponto (card, row, tr, div pai)
        const container = btn.closest('tr') || btn.closest('.card') || btn.closest('.card-body') || btn.closest('[class*="ponto"]') || btn.parentElement?.parentElement;
        if (!container) return '';
        // Procurar texto que pareça endereço
        const els = container.querySelectorAll('td, span, p, div, small');
        for (const el of els) {
          const txt = (el.textContent || '').trim();
          if (txt.length > 10 && txt.includes(',') && !txt.includes('Corrigir') && !txt.includes('Ponto') && el !== btn) {
            return txt;
          }
        }
        // Fallback: pegar o texto inteiro do container e limpar
        const full = container.textContent || '';
        const cleaned = full.replace(/Corrigir|Ponto \d/g, '').trim();
        return cleaned.length > 10 ? cleaned.substring(0, 200) : '';
      }, ponto).catch(() => '');
      if (enderecoAntigo) {
        log(`📍 Endereço antigo capturado: ${enderecoAntigo}`);
      }
    } catch (e) {
      log(`⚠️ Não foi possível capturar endereço antigo: ${e.message}`);
    }

    // ── Passo 4: Clicar em Corrigir no ponto específico ──────────────────────
    log(`📌 Passo 4: Corrigindo Ponto ${ponto}`);

    // Usa data-ponto para selecionar o ponto exato — sem contar botões!
    await page.click(`.btn-corrigir-endereco[data-ponto="${ponto}"]`);
    await page.waitForTimeout(1000);
    await screenshot(page, os_numero, `passo4_ponto${ponto}_clicado`);

    // ── Passo 5: Preencher lat/lng e validar ─────────────────────────────────
    log('📌 Passo 5: Preenchendo coordenadas');

    // Os inputs ficam dentro do form do ponto — aguarda ficarem visíveis
    // Seletores do HTML real: placeholder="Latitude" e placeholder="Longitude"
    // O form do ponto ativo: div#form-corrigir-{id} que fica visível
    const inputLat = page.locator('input[placeholder="Latitude"]:visible').first();
    const inputLon = page.locator('input[placeholder="Longitude"]:visible').first();

    await inputLat.waitFor({ state: 'visible', timeout: TIMEOUT });
    await inputLon.waitFor({ state: 'visible', timeout: TIMEOUT });

    await inputLat.click({ clickCount: 3 });
    await inputLat.fill(String(latitude));
    await inputLon.click({ clickCount: 3 });
    await inputLon.fill(String(longitude));

    log(`📍 Lat: ${latitude} | Lon: ${longitude}`);

    // Clicar em Validar — classe exata do botão
    await page.locator('button.btn-validar-endereco:visible').first().click();
    await page.waitForTimeout(4000);
    await screenshot(page, os_numero, 'passo5_pos_validar');

    // Verificar se geocoder processou: botão Confirmar fica visível após sucesso
    const confirmarVisivel = await page.locator('button.btn-confirmar-alteracao').isVisible().catch(() => false);
    if (!confirmarVisivel) {
      const ss = await screenshot(page, os_numero, 'passo5_geocoder_vazio');
      return {
        sucesso: false,
        erro: `Coordenadas (${latitude}, ${longitude}) não reconhecidas pelo geocoder.`,
        screenshot: ss,
      };
    }
    log('✅ Geocoder OK — botão Confirmar visível');

    // Capturar endereço resolvido pelo geocoder (antes de confirmar)
    let enderecoResolvido = '';
    try {
      // Tentar capturar o texto do endereço exibido no form de correção
      // Seletores comuns: .endereco-resolvido, .endereco-geocoder, texto próximo ao botão confirmar
      const possiveisSeletores = [
        '.endereco-resolvido',
        '.endereco-geocoder',
        '.endereco-resultado',
        '.resultado-geocoder',
        '.text-success:visible',
        '.alert-success:visible',
      ];
      for (const sel of possiveisSeletores) {
        const el = page.locator(sel).first();
        const visivel = await el.isVisible().catch(() => false);
        if (visivel) {
          enderecoResolvido = (await el.innerText().catch(() => '')).trim();
          if (enderecoResolvido) {
            log(`📍 Endereço resolvido (${sel}): ${enderecoResolvido}`);
            break;
          }
        }
      }

      // Fallback: capturar qualquer texto que pareça endereço próximo ao botão confirmar
      if (!enderecoResolvido) {
        const formTexto = await page.locator('button.btn-confirmar-alteracao:visible').first()
          .evaluate(btn => {
            const parent = btn.closest('.card-body') || btn.closest('.modal-body') || btn.parentElement?.parentElement;
            if (!parent) return '';
            // Procurar elementos de texto que contenham vírgula (padrão de endereço)
            const textos = parent.querySelectorAll('p, span, div, small, label');
            for (const t of textos) {
              const txt = t.textContent?.trim() || '';
              // Endereço geralmente tem vírgula e mais de 15 chars
              if (txt.length > 15 && txt.includes(',') && !txt.includes('Latitude') && !txt.includes('Longitude')) {
                return txt;
              }
            }
            return '';
          }).catch(() => '');
        if (formTexto) {
          enderecoResolvido = formTexto;
          log(`📍 Endereço resolvido (fallback DOM): ${enderecoResolvido}`);
        }
      }
    } catch (e) {
      log(`⚠️ Não foi possível capturar endereço resolvido: ${e.message}`);
    }

    // ── Passo 6: Confirmar alteração ─────────────────────────────────────────
    log('📌 Passo 6: Confirmando alteração');

    // Classe exata do botão: btn-confirmar-alteracao
    await page.locator('button.btn-confirmar-alteracao:visible').first().click();
    await page.waitForTimeout(2000);

    await screenshot(page, os_numero, 'passo6_concluido');
    log(`🎉 OS ${os_numero} Ponto ${ponto} corrigido com sucesso!`);
    return { sucesso: true, endereco_corrigido: enderecoResolvido || null, endereco_antigo: enderecoAntigo || null };

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    const ss = await screenshot(page, os_numero, 'erro_inesperado');
    return { sucesso: false, erro: `Erro inesperado: ${err.message}`, screenshot: ss };
  } finally {
    await browser.close();
  }
}

module.exports = { executarCorrecaoEndereco };
