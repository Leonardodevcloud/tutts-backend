/**
 * playwright-bi-export.js
 * RPA: vai em entregasExportarExcel, configura filtros pra D-1, clica em
 * "Buscar dados" → depois em "Excel Relatório Power BI" (#button-excel-bi),
 * espera o link de download aparecer (#retorno-excel-link a[href]),
 * baixa o .xlsx e retorna o caminho local.
 *
 * Reusa muita lógica do playwright-performance.js (login, navegação),
 * mas muda credencial pra SISTEMA_EXTERNO_LIBERACAO_* (mesma conta do liberar-ponto).
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const { logger } = require('../../config/logger');
// 2026-04 egress-fix: bloqueia trackers externos quando BLOCK_TRACKERS=1
const { aplicarBloqueio } = require('../../shared/network-blocker');

const SESSION_FILE_DEFAULT = '/tmp/tutts-rpa-bi-import-session.json';
const SCREENSHOT_DIR = '/tmp/screenshots';
const DOWNLOAD_DIR   = '/tmp/bi-imports';
const TIMEOUT        = 25000;
const NAV_TIMEOUT    = 60000;
const BUSCA_TIMEOUT  = 300000;  // 5min — buscar com 1000-10000 registros pode demorar (era 180s mas estava timing out)
const EXCEL_TIMEOUT  = 240000;  // 4min — gerar Excel BI demora MAIS

const LOGIN_URL = () => process.env.SISTEMA_EXTERNO_URL;
const EXCEL_URL = 'https://tutts.com.br/expresso/expressoat/entregasExportarExcel';

[SCREENSHOT_DIR, DOWNLOAD_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

let _sessionFileOverride = null;
let _credentialsOverride = null;
function getSessionFile() { return _sessionFileOverride || SESSION_FILE_DEFAULT; }
function setOverrides(opts) {
  _sessionFileOverride = (opts && opts.sessionFile) || null;
  _credentialsOverride = (opts && opts.credentials) || null;
}
function clearOverrides() { _sessionFileOverride = null; _credentialsOverride = null; }

function log(msg) { logger.info(`[playwright-bi-export] ${msg}`); }

function comTimeout(promise, ms, nome) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${nome}`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

async function fecharBrowserSeguro(browser) {
  if (!browser) return;
  // 2026-04 v2: tenta close gracioso com timeout. Se pendurar, mata via SIGKILL.
  // Sem o SIGKILL, processos Chromium ficavam zumbi consumindo RAM até estourar
  // o limite do container e dar "spawn EAGAIN" nos próximos launches.
  try {
    await comTimeout(browser.close(), 5000, 'browser.close');
    return;
  } catch (e) {
    log(`⚠️ browser.close() pendurou (${e.message}) — tentando SIGKILL`);
  }
  try {
    const proc = browser.process && browser.process();
    if (proc && typeof proc.kill === 'function') {
      proc.kill('SIGKILL');
      log(`💀 Chromium pid=${proc.pid} morto via SIGKILL`);
    }
  } catch (e2) {
    log(`⚠️ SIGKILL falhou: ${e2.message}`);
  }
}

async function screenshot(page, etapa) {
  // 2026-04 egress-fix: skip se SCREENSHOTS_ENABLED=0
  // Screenshots consomem CPU + Volume + Egress (quando admin abre).
  // Desligar economiza recurso sem afetar funcionalidade.
  if (process.env.SCREENSHOTS_ENABLED === '0' ||
      process.env.SCREENSHOTS_ENABLED === 'false') {
    return null;
  }
  try {
    const filename = `BI_${etapa}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false }).catch(() => {});
    log(`📸 ${filename}`);
    return filepath;
  } catch { return null; }
}

async function isLoggedIn(page) {
  try {
    await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1000);
    const url = page.url();
    return !url.includes('loginFuncionarioNovo') && !url.includes('login');
  } catch { return false; }
}

async function fazerLogin(page, overrides) {
  const email = (overrides && overrides.email) ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_EMAIL_1 ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_EMAIL ||
                process.env.SISTEMA_EXTERNO_EMAIL;
  const senha = (overrides && overrides.senha) ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_SENHA_1 ||
                process.env.SISTEMA_EXTERNO_LIBERACAO_SENHA ||
                process.env.SISTEMA_EXTERNO_SENHA;

  if (!email || !senha) {
    throw new Error('SISTEMA_EXTERNO_LIBERACAO_EMAIL_1/SENHA_1 não configuradas.');
  }

  log(`🔐 Login: ${email}`);
  await page.goto(LOGIN_URL(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(1500);

  const temEmail = await page.locator('#loginEmail').isVisible().catch(() => false);
  if (!temEmail) {
    const ss = await screenshot(page, 'login_falhou');
    throw new Error(`Login não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
  }

  await page.fill('#loginEmail', email);
  await page.fill('input[type="password"]', senha);
  await page.locator('input[name="logar"]').first().click();

  await page.waitForURL(
    u => !u.toString().includes('loginFuncionarioNovo'),
    { timeout: TIMEOUT }
  );
  log(`✅ Login OK`);
}

/**
 * Configura todos os filtros conforme o uso manual:
 *  - Datas: D-1 (igual data inicial e final), Buscar data = "Data Serviço"
 *  - Escopo: Todos clientes (T)
 *  - Endereços: Com endereços (CE) — ⚠️ modal de seleção é tratado SEPARADAMENTE
 *  - Retorno: Todos (T)
 *  - Status: Em execução (A) + Concluídos (F)
 *  - Tipo veículo: 5 selecionados (sem Carro Utilitário Expresso UC)
 *  - Tipo serviço (multa): Todos (T)
 *  - Serviço dinâmico: Todos (T)
 *  - Dados cliente: "Com dados do cliente"
 *  - Dados profissional: "Com dados do profissional"
 *  - Registros: 10000 (maior valor disponível)
 *
 * 2026-04 BUGFIX MASSIVO: a versão anterior tinha múltiplos bugs descobertos
 * via inspeção real no console do navegador:
 *   1. Status: usava input[name="statusOS"] mas é select#status name="status[]"
 *   2. Status: values eram "E"/"F" mas reais são "A"/"F"
 *   3. Tipo veículo: usava input[name="T"] mas é select#listaTipoVeiculo
 *   4. Cliente dados: id era "cliente_dados" ou "cliente" mas é "dadosCliente"
 *   5. Buscar data: nem era setado (fica em "Data Serviço" por sorte)
 *   6. Escopo: nem era setado (fica em "Todos" por sorte)
 *   7. Sem validação pós-set: se algum filtro falha, ninguém percebe
 *
 * Esta versão corrige TUDO + adiciona logs de validação por filtro.
 */
async function configurarFiltros(page, dataReferencia /* 'YYYY-MM-DD' */) {
  log(`📋 Configurando filtros pra data ${dataReferencia}`);

  // Converter YYYY-MM-DD → DD/MM/YYYY (formato do input)
  const [ano, mes, dia] = dataReferencia.split('-');
  const dataBR = `${dia}/${mes}/${ano}`;

  const validacoes = await page.evaluate((dt) => {
    // ─── Helpers ─────────────────────────────────────────────────────────
    // Marca opções por value num <select multiple> Bootstrap multiselect.
    //
    // 2026-04 BUGFIX V3: a estratégia antiga manipulava .selected do <option>
    // nativo + adicionava/removia class "active" do botão visual. ISSO NÃO
    // FUNCIONA pra Bootstrap multiselect. O Bootstrap mantém estado interno
    // próprio que só sincroniza quando você CLICA no botão (porque o handler
    // de click do plugin atualiza o <option> nativo + estado interno + UI).
    //
    // Manipular .selected sem clicar = form submit não vê o filtro aplicado
    // = sistema retorna 0 resultados = timeout em 180s.
    //
    // Estratégia correta: simular CLICK do usuário em cada botão que precisa
    // mudar de estado. O handler do Bootstrap faz todo o resto (atualiza
    // <select>, atualiza estado interno, atualiza UI, dispara change).
    function setMultiselectByValues(selectId, valoresDesejados) {
      const sel = document.getElementById(selectId);
      if (!sel) return { ok: false, motivo: 'select_nao_encontrado', selectId };

      // Acha o container de botões Bootstrap (irmão do <span> que contém o <select>)
      // Estrutura típica:
      //   <span class="multiselect-native-select">
      //     <select id="..." multiple>...</select>
      //     <div class="btn-group">
      //       <button class="multiselect">...</button>  ← botão dropdown principal
      //       <div class="multiselect-container dropdown-menu">
      //         <button class="multiselect-option" title="...">...</button>
      //         ...
      //       </div>
      //     </div>
      //   </span>
      const span = sel.closest('span.multiselect-native-select');
      const btnGroup = span?.querySelector('.btn-group') || span?.parentElement?.querySelector('.btn-group');

      if (!btnGroup) {
        // Sem container Bootstrap → não é multiselect, fallback pro <select> nativo
        const valoresAplicados = [];
        [...sel.options].forEach(opt => {
          opt.selected = valoresDesejados.includes(opt.value);
          if (opt.selected) valoresAplicados.push(opt.value);
        });
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, valoresAplicados, qtd: valoresAplicados.length, estrategia: 'select_nativo' };
      }

      // Estratégia: para cada <option>, ver se o botão Bootstrap correspondente
      // está no estado certo. Se não está, CLICAR no botão (deixa o Bootstrap
      // gerenciar tudo: option.selected, class active, estado interno).
      const buttons = [...btnGroup.querySelectorAll('.multiselect-option')];
      const valoresAplicados = [];

      [...sel.options].forEach((opt, idx) => {
        const queroSelecionado = valoresDesejados.includes(opt.value);
        const taSelecionado = opt.selected;

        if (queroSelecionado !== taSelecionado) {
          // Estado errado — clica no botão pro Bootstrap toggle
          // Bootstrap multiselect mantém botões na MESMA ordem das options
          const btn = buttons[idx];
          if (btn) {
            // Click pode disparar event handler que faz toggle.
            // Note: usamos .click() que é síncrono no DOM e dispara o
            // event listener do Bootstrap.
            btn.click();
          } else {
            // Sem botão visual — fallback: muda .selected diretamente
            opt.selected = queroSelecionado;
          }
        }

        if (opt.selected) valoresAplicados.push(opt.value);
      });

      // Re-lê estado APÓS clicks pra log preciso
      const valoresFinais = [...sel.options].filter(o => o.selected).map(o => o.value);

      // Dispara change pra qualquer outro código JS reagir
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      return {
        ok: true,
        valoresAplicados: valoresFinais,
        qtd: valoresFinais.length,
        estrategia: 'click_bootstrap'
      };
    }

    // Marca radio por name+value, dispara click pra sistema reagir
    function setRadioByValue(name, value) {
      const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
      if (!radio) return { ok: false, motivo: 'radio_nao_encontrado', name, value };
      radio.checked = true;
      // Click ativa qualquer JS atrelado ao radio (mostrar/esconder seções, etc)
      radio.click();
      return { ok: true };
    }

    // Marca <select> por substring no texto da option (case-insensitive)
    function setSelectBySubstring(selectId, substringsExigidas) {
      const sel = document.getElementById(selectId);
      if (!sel) return { ok: false, motivo: 'select_nao_encontrado', selectId };

      // Acha primeira option cujo texto contém TODAS as substrings exigidas
      let opcaoEscolhida = null;
      for (const opt of sel.options) {
        const txt = (opt.textContent || '').toLowerCase().trim();
        const matches = substringsExigidas.every(s => txt.includes(s.toLowerCase()));
        if (matches) { opcaoEscolhida = opt; break; }
      }
      if (!opcaoEscolhida) return { ok: false, motivo: 'option_nao_encontrada', substringsExigidas };

      sel.value = opcaoEscolhida.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, valor: opcaoEscolhida.value, texto: opcaoEscolhida.textContent.trim() };
    }

    // Resultado das validações pra logar fora do evaluate
    const resultados = {};

    // ─── 1. Datas ────────────────────────────────────────────────────────
    if (window.jQuery) {
      jQuery('#data').val(dt);
      jQuery('#dataF').val(dt);
    } else {
      const di = document.getElementById('data');
      const df = document.getElementById('dataF');
      if (di) di.value = dt;
      if (df) df.value = dt;
    }
    resultados.datas = {
      ok: true,
      dataInicial: document.getElementById('data')?.value,
      dataFinal: document.getElementById('dataF')?.value,
    };

    // ─── 2. Buscar data: "Data Serviço" ──────────────────────────────────
    // Default geralmente já é "Data Serviço" mas garantir.
    resultados.buscarData = setSelectBySubstring('dataOS', ['data', 'serv']);

    // ─── 3. Escopo: Todos clientes (T) ───────────────────────────────────
    resultados.escopo = setRadioByValue('cliente', 'T');

    // ─── 4. Endereços: Com endereços (CE) ────────────────────────────────
    // Apenas marca o radio. O modal de seleção (que abre depois) é tratado
    // por outra função especializada — modalEnderecos() — chamada após este
    // configurarFiltros() retornar. Isso porque o modal precisa de
    // interação real do Playwright (esperar modal abrir, clicar botões,
    // confirmar) — não dá pra fazer dentro de page.evaluate().
    resultados.enderecos = setRadioByValue('endereco', 'CE');

    // ─── 5. Retorno: Todos (T) ───────────────────────────────────────────
    resultados.retorno = setRadioByValue('enderecoRetorno', 'T');

    // ─── 6. Tipo serviço (multa cancelamento): Todos (T) ─────────────────
    resultados.servicoMulta = setRadioByValue('servico-multa-cancelamento', 'T');

    // ─── 7. Serviço dinâmico: Todos (T) ──────────────────────────────────
    resultados.servicoDinamico = setRadioByValue('servicoDinamico', 'T');

    // ─── 8. Status: Em execução (A) + Concluídos (F) ────────────────────
    // 🔴 BUG CRÍTICO da versão anterior: usava name="statusOS" e values "E"/"F"
    //    mas o real é select#status com values "A" (Em execução) e "F" (Concluídos)
    //    Por isso o filtro NUNCA pegou — a planilha vinha com TODOS os status.
    resultados.status = setMultiselectByValues('status', ['A', 'F']);

    // ─── 9. Tipo veículo: tudo MENOS Carro Utilitário Expresso (UC) ──────
    // 🔴 BUG da versão anterior: usava input[name="T"] mas é select#listaTipoVeiculo
    // Values reais: M=Motofrete, MC=Motofrete(Expresso), U=Carro Util,
    //               UC=Carro Util(Expresso), D=Tutts Fast, DC=Motofrete-C
    // Quero todos exceto UC.
    {
      const sel = document.getElementById('listaTipoVeiculo');
      if (sel) {
        const valoresDesejados = [...sel.options]
          .filter(o => o.value !== 'UC')
          .map(o => o.value);
        resultados.tipoVeiculo = setMultiselectByValues('listaTipoVeiculo', valoresDesejados);
      } else {
        resultados.tipoVeiculo = { ok: false, motivo: 'select_listaTipoVeiculo_nao_encontrado' };
      }
    }

    // ─── 10. Dados cliente: "Com dados do cliente" ───────────────────────
    // 🟡 BUG da versão anterior: id era "cliente_dados" ou "cliente" — mas
    // o real é "dadosCliente". Default já é "Com dados", mas garantir.
    resultados.dadosCliente = setSelectBySubstring('dadosCliente', ['com', 'dado', 'cliente']);

    // ─── 11. Dados profissional: "Com dados do profissional" ─────────────
    // ✅ Já corrigido em sessão anterior, mantendo.
    resultados.dadosProfissional = setSelectBySubstring('profissional', ['com', 'dado', 'profissional']);

    // ─── 12. Registros por página: 1000 (não 10000 que estourava timeout) ───
    // 2026-04 BUGFIX: a versão anterior tentava pegar o MAIOR valor (10000),
    // mas isso fazia o sistema externo demorar >180s pra renderizar a tabela
    // ("Busca não retornou dados em 180s"). 1000 é o sweet spot:
    //   - Cobre 99% dos dias (média 100-500 OS/dia, máximo histórico ~800)
    //   - Renderiza em ~30-60s
    //   - Se algum dia tiver >1000, o sistema ainda mostra os primeiros 1000
    //     e podemos paginar via botão "Próximo" se necessário (extensão futura)
    {
      const sel = document.getElementById('quantLimite');
      if (sel) {
        // Tenta valor balanceado: 1000 > 500 > maior disponível
        const VALORES_PREFERIDOS = ['1000', '500', '100'];
        let escolhido = null;
        for (const pref of VALORES_PREFERIDOS) {
          const opt = [...sel.options].find(o => o.value === pref);
          if (opt) { escolhido = opt; break; }
        }
        // Fallback: maior disponível
        if (!escolhido) {
          let maior = 0;
          for (const opt of sel.options) {
            const n = parseInt(opt.value, 10);
            if (!isNaN(n) && n > maior) { maior = n; escolhido = opt; }
          }
        }
        if (escolhido) {
          sel.value = escolhido.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          resultados.registrosPorPagina = { ok: true, valor: escolhido.value };
        } else {
          resultados.registrosPorPagina = { ok: false, motivo: 'sem_options' };
        }
      } else {
        resultados.registrosPorPagina = { ok: false, motivo: 'select_nao_encontrado' };
      }
    }

    return resultados;
  }, dataBR);

  // Aguarda Bootstrap multiselect renderizar atualizações de UI
  await page.waitForTimeout(800);

  // Loga estado de cada filtro pra debug. Se alguma falhou, fica visível
  // no log do Railway sem precisar abrir DevTools.
  log('📊 Estado dos filtros:');
  log(`  • Datas: ${validacoes.datas.dataInicial} → ${validacoes.datas.dataFinal}`);
  log(`  • Buscar data: ${validacoes.buscarData.ok ? '✅ ' + validacoes.buscarData.texto : '❌ ' + validacoes.buscarData.motivo}`);
  log(`  • Escopo: ${validacoes.escopo.ok ? '✅ Todos clientes' : '❌ ' + validacoes.escopo.motivo}`);
  log(`  • Endereços: ${validacoes.enderecos.ok ? '✅ Com endereços' : '❌ ' + validacoes.enderecos.motivo}`);
  log(`  • Retorno: ${validacoes.retorno.ok ? '✅ Todos' : '❌ ' + validacoes.retorno.motivo}`);
  log(`  • Tipo serviço (multa): ${validacoes.servicoMulta.ok ? '✅ Todos' : '❌ ' + validacoes.servicoMulta.motivo}`);
  log(`  • Serviço dinâmico: ${validacoes.servicoDinamico.ok ? '✅ Todos' : '❌ ' + validacoes.servicoDinamico.motivo}`);
  log(`  • Status: ${validacoes.status.ok ? '✅ ' + validacoes.status.qtd + ' selecionados (' + validacoes.status.valoresAplicados.join(',') + ')' : '❌ ' + validacoes.status.motivo}`);
  log(`  • Tipo veículo: ${validacoes.tipoVeiculo.ok ? '✅ ' + validacoes.tipoVeiculo.qtd + ' selecionados (' + validacoes.tipoVeiculo.valoresAplicados.join(',') + ')' : '❌ ' + validacoes.tipoVeiculo.motivo}`);
  log(`  • Dados cliente: ${validacoes.dadosCliente.ok ? '✅ ' + validacoes.dadosCliente.texto : '❌ ' + validacoes.dadosCliente.motivo}`);
  log(`  • Dados profissional: ${validacoes.dadosProfissional.ok ? '✅ ' + validacoes.dadosProfissional.texto : '❌ ' + validacoes.dadosProfissional.motivo}`);
  log(`  • Registros/página: ${validacoes.registrosPorPagina.ok ? '✅ ' + validacoes.registrosPorPagina.valor : '❌ ' + validacoes.registrosPorPagina.motivo}`);

  // Detecta falhas críticas e loga warning
  const falhasCriticas = [];
  if (!validacoes.status.ok || validacoes.status.qtd !== 2) falhasCriticas.push('status');
  if (!validacoes.tipoVeiculo.ok) falhasCriticas.push('tipoVeiculo');
  if (!validacoes.dadosProfissional.ok) falhasCriticas.push('dadosProfissional');
  if (falhasCriticas.length > 0) {
    log(`⚠️  ATENÇÃO: filtros críticos com problema: ${falhasCriticas.join(', ')}`);
  }

  log(`✅ Filtros configurados`);
  return validacoes;
}

/**
 * Clica "Buscar dados" e espera tabela aparecer.
 */
async function executarBusca(page) {
  log('🔍 Clicando "Buscar dados"');
  await page.evaluate(() => {
    if (typeof buscaServicoExcel === 'function') {
      buscaServicoExcel(1, 0, '', null);
    } else {
      const b = document.querySelector('input[name="buscarDados"]');
      if (b) b.click();
    }
  });

  // Espera tabela ter algum conteúdo
  try {
    await page.waitForFunction(() => {
      const d = document.getElementById('divRetornoTable');
      return d && d.querySelectorAll('table tbody tr td').length > 0;
    }, { timeout: BUSCA_TIMEOUT });
  } catch (e) {
    const ss = await screenshot(page, 'busca_sem_resultado');
    throw new Error(`Busca não retornou dados em ${BUSCA_TIMEOUT/1000}s. Screenshot: ${ss}`);
  }
  await page.waitForTimeout(1500);
  log(`✅ Busca completa`);
}

/**
 * Clica em "Excel Relatório Power BI" (#button-excel-bi),
 * aguarda processamento, captura URL de download em #retorno-excel-link a[href].
 */
async function gerarELinkParaBI(page) {
  log('📊 Clicando "Excel Relatório Power BI"');

  const btnBi = page.locator('#button-excel-bi');
  if (!(await btnBi.isVisible().catch(() => false))) {
    const ss = await screenshot(page, 'sem_botao_bi');
    throw new Error(`Botão #button-excel-bi não visível (faltou clicar Buscar?). Screenshot: ${ss}`);
  }
  await btnBi.click();

  log(`⏳ Aguardando link de download em #retorno-excel-link a[href] (até ${EXCEL_TIMEOUT/1000}s)`);
  let downloadUrl = null;
  try {
    await page.waitForFunction(() => {
      const link = document.querySelector('#retorno-excel-link a[href]');
      return link && link.href && link.href.includes('http');
    }, { timeout: EXCEL_TIMEOUT });

    downloadUrl = await page.evaluate(() => {
      const link = document.querySelector('#retorno-excel-link a[href]');
      return link ? link.href : null;
    });
  } catch (e) {
    const ss = await screenshot(page, 'sem_link_download');
    throw new Error(`Sistema não gerou link de download em ${EXCEL_TIMEOUT/1000}s. Screenshot: ${ss}`);
  }

  if (!downloadUrl) {
    throw new Error(`Link de download capturado, mas href vazio.`);
  }

  log(`✅ URL do arquivo: ${downloadUrl.substring(0, 100)}...`);
  return downloadUrl;
}

/**
 * Baixa o arquivo da URL e salva em DOWNLOAD_DIR.
 * Retorna caminho local.
 */
function baixarArquivo(url, dataReferencia) {
  return new Promise((resolve, reject) => {
    const filename = `bi_${dataReferencia}_${Date.now()}.xlsx`;
    const filepath = path.join(DOWNLOAD_DIR, filename);
    const file = fs.createWriteStream(filepath);

    log(`⬇️  Baixando arquivo → ${filepath}`);
    const request = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(filepath); } catch (_) {}
        return reject(new Error(`Download HTTP ${res.statusCode} — ${url.substring(0, 100)}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          const stats = fs.statSync(filepath);
          log(`✅ Download concluído: ${(stats.size / 1024).toFixed(1)} KB`);
          resolve(filepath);
        });
      });
    });
    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(filepath); } catch (_) {}
      reject(err);
    });
    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error('Timeout 120s baixando arquivo'));
    });
  });
}

/**
 * FUNÇÃO PRINCIPAL — exportada e chamada pelo agente.
 * dataReferencia: 'YYYY-MM-DD' (ex: '2026-04-25' = D-1)
 *
 * Retorna: { sucesso, arquivo_path, erro?, screenshot_path? }
 */
async function executarExportBI({ dataReferencia, onProgresso }) {
  const reportar = typeof onProgresso === 'function'
    ? (etapa, pct) => { try { onProgresso(etapa, pct); } catch (_) {} }
    : () => {};

  if (!process.env.SISTEMA_EXTERNO_URL) {
    return { sucesso: false, erro: 'SISTEMA_EXTERNO_URL não configurada.' };
  }

  let browser = null;
  let context = null;
  let page = null;

  try {
    log(`🚀 Export BI | data=${dataReferencia}`);
    reportar('iniciando', 5);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const sessionPath = getSessionFile();
    const sessionExiste = fs.existsSync(sessionPath);
    context = await browser.newContext(sessionExiste ? { storageState: sessionPath } : {});

    // 2026-04 egress-fix: bloqueia trackers externos (Facebook, GA, etc)
    await aplicarBloqueio(context, 'bi-export');

    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Passo 1: Login
    reportar('login', 10);
    let logado = false;
    if (sessionExiste) {
      logado = await isLoggedIn(page);
      if (!logado) { try { fs.unlinkSync(sessionPath); } catch (_) {} }
    }
    if (!logado) {
      await fazerLogin(page, _credentialsOverride);
      await context.storageState({ path: sessionPath });
      log(`💾 Sessão salva`);
    }

    // Passo 2: Vai pra exportação Excel
    reportar('navegando', 20);
    await page.goto(EXCEL_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500);
    const temForm = await page.evaluate(() => !!document.getElementById('data'));
    if (!temForm) {
      const ss = await screenshot(page, 'sem_form');
      throw new Error(`Página de filtros não carregou. URL: ${page.url()}. Screenshot: ${ss}`);
    }

    // Passo 3: Configurar filtros
    reportar('configurando_filtros', 30);
    await configurarFiltros(page, dataReferencia);

    // Passo 4: Buscar
    reportar('buscando', 45);
    await executarBusca(page);

    // Passo 5: Gerar Excel BI
    reportar('gerando_excel', 65);
    const downloadUrl = await gerarELinkParaBI(page);

    // Passo 6: Baixar
    reportar('baixando', 85);
    const arquivoPath = await baixarArquivo(downloadUrl, dataReferencia);

    reportar('concluido', 100);
    log(`✅ Export concluído: ${arquivoPath}`);
    return { sucesso: true, arquivo_path: arquivoPath };

  } catch (err) {
    log(`❌ Erro: ${err.message}`);
    let ss = null;
    if (page) ss = await screenshot(page, 'erro_inesperado');
    return {
      sucesso: false,
      erro: err.message.slice(0, 500),
      screenshot_path: ss,
    };
  } finally {
    await fecharBrowserSeguro(browser);
  }
}

module.exports = { executarExportBI, setOverrides, clearOverrides };
