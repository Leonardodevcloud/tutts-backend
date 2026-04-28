/**
 * playwright-crm-leads.js
 * Agente RPA: acessa tutts.com.br/expresso/expressoat/profissionais
 * e captura leads cadastrados no período D-1 a D0.
 *
 * Usa o MESMO padrão de login do playwright-agent.js e playwright-performance.js.
 *
 * Seletores mapeados do HTML real:
 *   Exibir filtros : button com text "Exibir filtros" (toggleCollapse)
 *   Status         : select#filtros-status → value="todos"
 *   Toggle período : input#filtro-data-cadastro (checkbox)
 *   Container      : div#container-periodo-cadastro
 *   Data inicial   : input#filtro-data-cadastro-inicial (type="date")
 *   Data final     : input#filtro-data-cadastro-final (type="date")
 *   Aplicar        : button[onclick="buscarProfissionais()"]
 *   Tabela         : CÓD | NOME | TELEFONES | EMAIL | CATEGORIA | CADASTRO | STATUS
 *   Paginação      : links numéricos + "Próx."
 */

'use strict';

const { chromium } = require('playwright');
// 2026-04: helper unificado de launch + close robusto (com SIGKILL fallback).
// Resolve "spawn EAGAIN" causado por processos Chromium que ficam zumbi
// quando browser.close() pendura sob pressão de memória.
const { lancarChromiumSeguro } = require('../../shared/playwright-launch');
const fs   = require('fs');
const path = require('path');
const { logger } = require('../../config/logger');

const SESSION_FILE   = '/tmp/tutts-crm-session.json';
const SCREENSHOT_DIR = '/tmp/screenshots';
const TIMEOUT        = 30_000;
const PROF_URL       = 'https://tutts.com.br/expresso/expressoat/profissionais';
const LOGIN_URL      = () => process.env.CRM_EXTERNO_URL || process.env.SISTEMA_EXTERNO_URL;

function log(msg) { logger.info(`[playwright-crm] ${msg}`); }

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensureDir(SCREENSHOT_DIR);

async function screenshotDebug(page, nome) {
  try {
    const file = path.join(SCREENSHOT_DIR, `crm-${nome}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log(`📸 ${path.basename(file)}`);
    return path.basename(file);
  } catch (e) { log(`⚠️ Screenshot falhou: ${e.message}`); return null; }
}

// ══════════════════════════════════════════════════════════════
// MAPA DDD → CIDADE/ESTADO
// ══════════════════════════════════════════════════════════════
const DDD_MAPA = {
  '71': { cidade: 'SALVADOR', estado: 'BA' },
  '73': { cidade: 'ILHÉUS', estado: 'BA' },
  '74': { cidade: 'JUAZEIRO', estado: 'BA' },
  '75': { cidade: 'FEIRA DE SANTANA', estado: 'BA' },
  '77': { cidade: 'BARREIRAS', estado: 'BA' },
  '79': { cidade: 'ARACAJU', estado: 'SE' },
  '81': { cidade: 'RECIFE', estado: 'PE' },
  '82': { cidade: 'MACEIÓ', estado: 'AL' },
  '83': { cidade: 'JOÃO PESSOA', estado: 'PB' },
  '84': { cidade: 'NATAL', estado: 'RN' },
  '85': { cidade: 'FORTALEZA', estado: 'CE' },
  '86': { cidade: 'TERESINA', estado: 'PI' },
  '87': { cidade: 'PETROLINA', estado: 'PE' },
  '88': { cidade: 'JUAZEIRO DO NORTE', estado: 'CE' },
  '89': { cidade: 'PICOS', estado: 'PI' },
  '91': { cidade: 'BELÉM', estado: 'PA' },
  '92': { cidade: 'MANAUS', estado: 'AM' },
  '93': { cidade: 'SANTARÉM', estado: 'PA' },
  '94': { cidade: 'MARABÁ', estado: 'PA' },
  '95': { cidade: 'BOA VISTA', estado: 'RR' },
  '96': { cidade: 'MACAPÁ', estado: 'AP' },
  '97': { cidade: 'COARI', estado: 'AM' },
  '98': { cidade: 'SÃO LUÍS', estado: 'MA' },
  '99': { cidade: 'IMPERATRIZ', estado: 'MA' },
  '11': { cidade: 'SÃO PAULO', estado: 'SP' },
  '12': { cidade: 'SÃO JOSÉ DOS CAMPOS', estado: 'SP' },
  '13': { cidade: 'SANTOS', estado: 'SP' },
  '14': { cidade: 'BAURU', estado: 'SP' },
  '15': { cidade: 'SOROCABA', estado: 'SP' },
  '16': { cidade: 'RIBEIRÃO PRETO', estado: 'SP' },
  '17': { cidade: 'SÃO JOSÉ DO RIO PRETO', estado: 'SP' },
  '18': { cidade: 'PRESIDENTE PRUDENTE', estado: 'SP' },
  '19': { cidade: 'CAMPINAS', estado: 'SP' },
  '21': { cidade: 'RIO DE JANEIRO', estado: 'RJ' },
  '22': { cidade: 'CAMPOS DOS GOYTACAZES', estado: 'RJ' },
  '24': { cidade: 'VOLTA REDONDA', estado: 'RJ' },
  '27': { cidade: 'VITÓRIA', estado: 'ES' },
  '28': { cidade: 'CACHOEIRO DE ITAPEMIRIM', estado: 'ES' },
  '31': { cidade: 'BELO HORIZONTE', estado: 'MG' },
  '32': { cidade: 'JUIZ DE FORA', estado: 'MG' },
  '33': { cidade: 'GOVERNADOR VALADARES', estado: 'MG' },
  '34': { cidade: 'UBERLÂNDIA', estado: 'MG' },
  '35': { cidade: 'POÇOS DE CALDAS', estado: 'MG' },
  '37': { cidade: 'DIVINÓPOLIS', estado: 'MG' },
  '38': { cidade: 'MONTES CLAROS', estado: 'MG' },
  '41': { cidade: 'CURITIBA', estado: 'PR' },
  '42': { cidade: 'PONTA GROSSA', estado: 'PR' },
  '43': { cidade: 'LONDRINA', estado: 'PR' },
  '44': { cidade: 'MARINGÁ', estado: 'PR' },
  '45': { cidade: 'FOZ DO IGUAÇU', estado: 'PR' },
  '46': { cidade: 'FRANCISCO BELTRÃO', estado: 'PR' },
  '47': { cidade: 'JOINVILLE', estado: 'SC' },
  '48': { cidade: 'FLORIANÓPOLIS', estado: 'SC' },
  '49': { cidade: 'CHAPECÓ', estado: 'SC' },
  '51': { cidade: 'PORTO ALEGRE', estado: 'RS' },
  '53': { cidade: 'PELOTAS', estado: 'RS' },
  '54': { cidade: 'CAXIAS DO SUL', estado: 'RS' },
  '55': { cidade: 'SANTA MARIA', estado: 'RS' },
  '61': { cidade: 'BRASÍLIA', estado: 'DF' },
  '62': { cidade: 'GOIÂNIA', estado: 'GO' },
  '63': { cidade: 'PALMAS', estado: 'TO' },
  '64': { cidade: 'RIO VERDE', estado: 'GO' },
  '65': { cidade: 'CUIABÁ', estado: 'MT' },
  '66': { cidade: 'RONDONÓPOLIS', estado: 'MT' },
  '67': { cidade: 'CAMPO GRANDE', estado: 'MS' },
  '68': { cidade: 'RIO BRANCO', estado: 'AC' },
  '69': { cidade: 'PORTO VELHO', estado: 'RO' },
};

function extrairDDD(telefone) {
  const numeros = (telefone || '').replace(/\D/g, '');
  // Com DDI (55)
  if (numeros.length >= 12 && numeros.startsWith('55')) return numeros.substring(2, 4);
  // Sem DDI
  if (numeros.length >= 10) return numeros.substring(0, 2);
  return '';
}

function obterRegiaoFromTelefone(telefone) {
  const ddd = extrairDDD(telefone);
  const info = DDD_MAPA[ddd];
  return info || { cidade: `DDD ${ddd}`, estado: '' };
}

function normalizarTelefone(telefone) {
  if (!telefone) return '';
  let numeros = telefone.replace(/\D/g, '');
  if (numeros.length >= 12 && numeros.startsWith('55')) numeros = numeros.substring(2);
  if (numeros.length === 10) numeros = numeros.substring(0, 2) + '9' + numeros.substring(2);
  return numeros;
}

// ══════════════════════════════════════════════════════════════
// LOGIN — cópia exata do playwright-agent.js
// ══════════════════════════════════════════════════════════════
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

  await page.fill('#loginEmail', process.env.CRM_EXTERNO_EMAIL || process.env.SISTEMA_EXTERNO_EMAIL);
  await page.fill('input[type="password"]', process.env.CRM_EXTERNO_SENHA || process.env.SISTEMA_EXTERNO_SENHA);
  await page.locator('input[name="logar"]').first().click();

  await page.waitForURL(
    url => !url.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log(`✅ Login OK — URL: ${page.url()}`);
}

// ══════════════════════════════════════════════════════════════
// NAVEGAÇÃO
// ══════════════════════════════════════════════════════════════
async function navegarParaProfissionais(page, context) {
  log('📌 Passo 1: Navegando para Lista de Profissionais');

  await page.goto(PROF_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(3000); // Página leva ~5s pra carregar

  if (!(await isLoggedIn(page))) {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      log('🗑️ Sessão inválida removida');
    }
    await fazerLogin(page);
    await page.goto(PROF_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    await context.storageState({ path: SESSION_FILE });
    log('💾 Sessão salva');
  } else {
    log('✅ Já logado');
  }

  // Aguardar tabela inicial carregar (página pesada com 7600+ profissionais)
  await page.waitForFunction(
    () => document.querySelector('table') && document.querySelectorAll('table tbody tr').length > 0,
    { timeout: 60_000 }
  ).catch(() => {
    log('⚠️ Tabela não carregou no timeout, tentando continuar...');
  });
  await page.waitForTimeout(2000);

  log(`📍 URL: ${page.url()}`);
}

// ══════════════════════════════════════════════════════════════
// PREENCHER FILTROS
// ══════════════════════════════════════════════════════════════
async function preencherFiltros(page, { dataInicio, dataFim }) {
  log('📋 Preenchendo filtros...');

  // Passo 2: Clicar em "Exibir filtros"
  log('📌 Passo 2: Abrindo painel de filtros');
  const btnFiltros = page.locator('button:has-text("Exibir filtros")').first();
  const filtroVisivel = await btnFiltros.isVisible().catch(() => false);
  if (filtroVisivel) {
    await btnFiltros.click();
    await page.waitForTimeout(800);
    log('✅ Filtros expandidos');
  } else {
    // Fallback: tentar o botão pelo ícone
    const btnAlt = page.locator('button:has(.fa-chevron-down)').first();
    if (await btnAlt.isVisible().catch(() => false)) {
      await btnAlt.click();
      await page.waitForTimeout(800);
    }
  }

  // Passo 3: Filtro de status → "Todos os profissionais"
  log('📌 Passo 3: Status → Todos os profissionais');
  await page.evaluate(() => {
    const sel = document.getElementById('filtros-status');
    if (sel) {
      sel.value = 'todos';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);
  log('  ✅ Status: todos');

  // Passo 4: Ativar toggle de período (Bootstrap custom-switch — label intercepta clique)
  log('📌 Passo 4: Ativando filtro por período');
  await page.evaluate(() => {
    const checkbox = document.getElementById('filtro-data-cadastro');
    if (checkbox && !checkbox.checked) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      // Chamar a função que o onchange original invoca
      if (typeof containerPeriodoCadastro === 'function') containerPeriodoCadastro();
    }
  });
  await page.waitForTimeout(800);
  log('  ✅ Toggle período ativado (via JS)');

  // Aguardar container expandir
  await page.waitForSelector('#container-periodo-cadastro[style*="display: block"], #container-periodo-cadastro.show', { timeout: 5000 }).catch(() => {
    log('  ⚠️ Container não expandiu pelo CSS, tentando forçar...');
  });

  // Forçar exibição do container se collapse não abriu
  await page.evaluate(() => {
    const container = document.getElementById('container-periodo-cadastro');
    if (container) {
      container.style.display = 'block';
      container.classList.add('show');
    }
  });
  await page.waitForTimeout(500);

  // Passo 5: Data inicial (formato YYYY-MM-DD para input type="date")
  log(`📌 Passo 5: Data inicial → ${dataInicio}`);
  await page.evaluate((val) => {
    const input = document.getElementById('filtro-data-cadastro-inicial');
    if (input) {
      // input type="date" aceita YYYY-MM-DD via .value
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, dataInicio);
  await page.waitForTimeout(300);

  // Passo 6: Data final
  log(`📌 Passo 6: Data final → ${dataFim}`);
  await page.evaluate((val) => {
    const input = document.getElementById('filtro-data-cadastro-final');
    if (input) {
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, dataFim);
  await page.waitForTimeout(300);

  // Registros por página → máximo (300)
  await page.evaluate(() => {
    const selectors = ['#registros-pagina', 'select[name="registros"]'];
    for (const s of selectors) {
      const sel = document.querySelector(s);
      if (sel) {
        // Selecionar maior opção disponível
        const options = Array.from(sel.options);
        const maxOpt = options.reduce((max, opt) => {
          const val = parseInt(opt.value);
          return (!isNaN(val) && val > parseInt(max.value)) ? opt : max;
        }, options[0]);
        if (maxOpt) {
          sel.value = maxOpt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  });

  log(`  📅 Período: ${dataInicio} → ${dataFim}`);

  // Passo 7: Clicar em "Aplicar filtros"
  log('📌 Passo 7: Aplicando filtros');
  await page.evaluate(() => {
    // Tenta a função JS direta primeiro
    if (typeof buscarProfissionais === 'function') {
      buscarProfissionais();
      return;
    }
    // Fallback: clicar no botão
    const btn = document.querySelector('button[onclick*="buscarProfissionais"]');
    if (btn) btn.click();
  });

  // Aguardar a tabela recarregar
  log('⏳ Aguardando tabela recarregar...');
  await page.waitForTimeout(3000);

  // Polling: aguardar que a tabela tenha dados ou "Total: N" apareça
  let tabelaCarregou = false;
  for (let i = 0; i < 30; i++) {
    const status = await page.evaluate(() => {
      const totalEl = document.body.textContent.match(/Total:\s*(\d+)/);
      const rows = document.querySelectorAll('table tbody tr');
      return {
        total: totalEl ? parseInt(totalEl[1]) : -1,
        rows: rows.length,
      };
    }).catch(() => ({ total: -1, rows: 0 }));

    if (status.total >= 0) {
      tabelaCarregou = true;
      log(`✅ Tabela carregada — Total: ${status.total} | Linhas: ${status.rows}`);
      break;
    }
    if (i === 10) log('⏳ Ainda aguardando (10s)...');
    if (i === 20) log('⏳ Ainda aguardando (20s)...');
    await page.waitForTimeout(1000);
  }

  if (!tabelaCarregou) {
    log('⚠️ Tabela pode não ter carregado completamente');
  }

  await page.waitForTimeout(1000);
}

// ══════════════════════════════════════════════════════════════
// LER TABELA (com paginação)
// ══════════════════════════════════════════════════════════════
async function lerTabela(page) {
  const todosRegistros = [];
  let pagina = 1;

  while (true) {
    log(`📄 Lendo página ${pagina}...`);

    const linhas = await page.evaluate(() => {
      // Mapear colunas pelo header
      const ths = Array.from(document.querySelectorAll('table thead th'));
      const idx = {};
      ths.forEach((th, i) => {
        const t = (th.textContent || '').trim().toUpperCase();
        if (t.includes('CÓD') || t === 'COD' || t === 'CÓD')  idx.cod = i;
        if (t === 'NOME')                                        idx.nome = i;
        if (t.includes('TELEFONE'))                               idx.telefones = i;
        if (t === 'EMAIL')                                        idx.email = i;
        if (t.includes('CATEGORIA'))                              idx.categoria = i;
        if (t.includes('CADASTRO'))                               idx.cadastro = i;
        if (t === 'STATUS')                                       idx.status = i;
      });

      const rows = document.querySelectorAll('table tbody tr');
      const dados = [];

      rows.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 5) return;

        // Detectar toggle de status (verde = ativo)
        let statusTexto = 'desconhecido';
        if (idx.status != null && tds[idx.status]) {
          const toggle = tds[idx.status].querySelector('input[type="checkbox"], .custom-switch input');
          if (toggle) {
            statusTexto = toggle.checked ? 'ativo' : 'inativo';
          } else {
            // Fallback: cor do toggle visual
            const badge = tds[idx.status].querySelector('.badge, [class*="toggle"]');
            if (badge) {
              const classes = badge.className || '';
              statusTexto = classes.includes('success') || classes.includes('primary') ? 'ativo' : 'inativo';
            }
          }
        }

        dados.push({
          cod:        idx.cod != null        ? (tds[idx.cod]?.textContent || '').trim()        : '',
          nome:       idx.nome != null       ? (tds[idx.nome]?.textContent || '').trim()       : '',
          telefones:  idx.telefones != null  ? (tds[idx.telefones]?.textContent || '').trim()  : '',
          email:      idx.email != null      ? (tds[idx.email]?.textContent || '').trim()      : '',
          categoria:  idx.categoria != null  ? (tds[idx.categoria]?.textContent || '').trim()  : '',
          cadastro:   idx.cadastro != null   ? (tds[idx.cadastro]?.textContent || '').trim()   : '',
          status:     statusTexto,
        });
      });

      return dados;
    });

    todosRegistros.push(...linhas);
    log(`  → ${linhas.length} linhas na página ${pagina}`);

    // Verificar paginação
    const temProxima = await page.evaluate(() => {
      // Procurar link "Próx." ou ">" que não esteja desabilitado
      const links = document.querySelectorAll('.pagination a, a[aria-label="Próximo"]');
      for (const a of links) {
        const texto = (a.textContent || '').trim();
        if ((texto === 'Próx.' || texto === '>' || texto === '›' || a.getAttribute('aria-label') === 'Próximo') &&
            !a.closest('.disabled') && !a.classList.contains('disabled')) {
          return true;
        }
      }
      return false;
    });

    if (!temProxima || linhas.length === 0) break;

    // Clicar próxima página
    await page.evaluate(() => {
      const links = document.querySelectorAll('.pagination a, a[aria-label="Próximo"]');
      for (const a of links) {
        const texto = (a.textContent || '').trim();
        if (texto === 'Próx.' || texto === '>' || texto === '›' || a.getAttribute('aria-label') === 'Próximo') {
          if (!a.closest('.disabled') && !a.classList.contains('disabled')) {
            a.click();
            return;
          }
        }
      }
    });

    await page.waitForTimeout(3000);
    pagina++;

    if (pagina > 50) {
      log('⚠️ Limite de 50 páginas atingido');
      break;
    }
  }

  log(`📊 Total capturado: ${todosRegistros.length} registros em ${pagina} página(s)`);
  return todosRegistros;
}

// ══════════════════════════════════════════════════════════════
// PROCESSAR DADOS
// ══════════════════════════════════════════════════════════════
function processarRegistros(registrosBrutos) {
  return registrosBrutos.map(r => {
    // Extrair celular e telefone fixo da string "telefones"
    // Formato: "(71) 98761-5380 /" ou "(79) 99814-8928 / (55) 79998-1489"
    const telefones = (r.telefones || '').split('/').map(t => t.trim()).filter(Boolean);
    const celular = telefones[0] || '';
    const telefoneFixo = telefones.length > 1 ? telefones[1] : '';
    const telefoneNorm = normalizarTelefone(celular);

    // Região pelo DDD do celular
    const { cidade, estado } = obterRegiaoFromTelefone(celular);

    // Data de cadastro: DD/MM/YYYY → YYYY-MM-DD
    let dataCadastro = null;
    if (r.cadastro) {
      const m = r.cadastro.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) dataCadastro = `${m[3]}-${m[2]}-${m[1]}`;
    }

    return {
      cod: r.cod,
      nome: r.nome,
      telefones_raw: r.telefones,
      celular,
      telefone_fixo: telefoneFixo,
      telefone_normalizado: telefoneNorm,
      email: r.email,
      categoria: r.categoria,
      data_cadastro: dataCadastro,
      cidade,
      estado,
      regiao: cidade,
      status_sistema: r.status,
    };
  }).filter(r => r.cod); // Remover linhas sem código
}

// ══════════════════════════════════════════════════════════════
// VERIFICAR STATUS VIA API TUTTS
// ══════════════════════════════════════════════════════════════
async function verificarStatusAPI(registros) {
  // Tenta ambas as variáveis — TUTTS_TOKEN_PROF_STATUS é o padrão do backend
  const TUTTS_TOKEN = process.env.TUTTS_TOKEN_PROF_STATUS || process.env.TUTTS_INTEGRACAO_TOKEN;
  if (!TUTTS_TOKEN) {
    log('⚠️ TUTTS_TOKEN_PROF_STATUS não configurado — pulando verificação API');
    return registros;
  }

  log(`🔍 Verificando ${registros.length} leads na API Tutts...`);

  let verificados = 0;
  let ativos = 0;
  let inativos = 0;

  for (const reg of registros) {
    if (!reg.celular) continue;

    try {
      // Formatar telefone para API Tutts
      const numeros = reg.celular.replace(/\D/g, '');
      let celularFormatado = numeros;
      if (numeros.length === 11) {
        celularFormatado = `(${numeros.slice(0, 2)}) ${numeros.slice(2, 7)}-${numeros.slice(7)}`;
      } else if (numeros.length === 10) {
        celularFormatado = `(${numeros.slice(0, 2)}) ${numeros.slice(2, 6)}-${numeros.slice(6)}`;
      }

      const response = await fetch('https://tutts.com.br/integracao', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TUTTS_TOKEN}`,
          'identificador': 'prof-status',
        },
        body: JSON.stringify({ celular: celularFormatado }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.Sucesso && data.Sucesso[0]) {
          reg.status_api = data.Sucesso[0].ativo === 'S' ? 'ativo' : 'inativo';
          if (reg.status_api === 'ativo') ativos++;
          else inativos++;
        } else {
          reg.status_api = 'nao_encontrado';
        }
      } else {
        reg.status_api = 'erro';
      }

      reg.api_verificado_em = new Date().toISOString();
      verificados++;

      // Delay entre chamadas (não sobrecarregar API)
      await new Promise(r => setTimeout(r, 150));
    } catch (err) {
      log(`⚠️ Erro API para cod ${reg.cod}: ${err.message}`);
      reg.status_api = 'erro';
    }
  }

  log(`🔍 API: ${verificados} verificados | ${ativos} ativos | ${inativos} inativos`);
  return registros;
}

// ══════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL
// ══════════════════════════════════════════════════════════════
async function capturarLeadsCadastrados({ dataInicio, dataFim }) {
  if (!process.env.CRM_EXTERNO_URL && !process.env.SISTEMA_EXTERNO_URL) {
    throw new Error('CRM_EXTERNO_URL ou SISTEMA_EXTERNO_URL não configurada.');
  }

  log(`🚀 Capturando leads cadastrados: ${dataInicio} → ${dataFim}`);

  const screenshots = [];

  // 2026-04: launch + close robusto (com SIGKILL fallback se browser.close pendurar)
  const { browser, fechar } = await lancarChromiumSeguro({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-default-apps', '--mute-audio', '--no-first-run',
    ],
  });

  let contextOptions = {};
  if (fs.existsSync(SESSION_FILE)) {
    contextOptions = { storageState: SESSION_FILE };
    log('♻️ Sessão encontrada');
  }

  const context = await browser.newContext({
    ...contextOptions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // Aceitar qualquer dialog (alert/confirm)
    page.on('dialog', d => d.accept().catch(() => {}));

    await navegarParaProfissionais(page, context);
    const ss1 = await screenshotDebug(page, 'pos-navegacao');
    if (ss1) screenshots.push(ss1);

    await preencherFiltros(page, { dataInicio, dataFim });
    const ss2 = await screenshotDebug(page, 'pos-filtros');
    if (ss2) screenshots.push(ss2);

    const registrosBrutos = await lerTabela(page);
    const ss3 = await screenshotDebug(page, 'pos-tabela');
    if (ss3) screenshots.push(ss3);

    // Processar dados (normalizar telefones, extrair cidade/estado, converter datas)
    const registros = processarRegistros(registrosBrutos);
    log(`✅ ${registros.length} registros processados`);

    // Verificar status via API Tutts
    const registrosComStatus = await verificarStatusAPI(registros);

    return {
      sucesso: true,
      registros: registrosComStatus,
      total: registrosComStatus.length,
      screenshots,
    };
  } catch (err) {
    const ss = await screenshotDebug(page, 'erro');
    if (ss) screenshots.push(ss);
    throw Object.assign(err, { screenshots });
  } finally {
    await fechar();
  }
}

module.exports = { capturarLeadsCadastrados };
