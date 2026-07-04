/**
 * agents/chat99.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente RPA do Chat 99 (Playwright). A 99Entrega NÃO expõe o chat com o
 * motoboy via API — ele só existe na plataforma web (entrega.99app.com). Este
 * agente espelha as mensagens pro nosso banco e envia as nossas de volta.
 *
 * MODELO (decidido com o Tutts):
 *  - CONTA ÚNICA, SESSÃO ÚNICA, SERIAL. A 99 desloga se logar 2x na mesma conta,
 *    então roda 1 slot só, uma corrida por vez. sessionStrategy: null (a sessão
 *    do 99 é gerenciada aqui na mão, NÃO é o SISTEMA_EXTERNO dos outros agentes).
 *  - tickGlobal em loop de ~25s (CHAT99_LOOP_MS). "estável > rápido".
 *  - Fonte da verdade de "quais corridas vigiar": a NOSSA logistics_deliveries
 *    (provider noventanove, não-finalizada) — não raspamos a tabela da 99 (frágil
 *    por índice de coluna). Pra cada corrida, filtramos por OS = "ID do pedido
 *    externo" na 99, abrimos o chat, capturamos o diff e drenamos a outbox.
 *  - RECONEXÃO: se a sessão cair (humano logou e derrubou o agente), NÃO briga —
 *    entra em cooldown de 5min (CHAT99_RECONNECT_COOLDOWN_MS) e volta depois.
 *
 * SELETORES DA 99 (confirmados via DevTools nos prints do Tutts):
 *  - filtro OS ....... input[placeholder="ID do pedido externo"]
 *  - buscar .......... button "Pesquisar"
 *  - abrir chat ...... na linha da OS, botao/span "Mensagem"
 *  - janela .......... .chat__window
 *  - bolhas .......... li com filho de classe "msg_<id>" (dedup natural)
 *  - lado ............ box com "isSelf" = nós (out) / sem isSelf = motoboy (in)
 *  - horario ......... .content_time visivel (o outro fica display:none)
 *  - lido ............ .content__isread.read
 *  - input ........... .chat__window textarea (placeholder "Insira o texto aqui")
 *  - enviar .......... botao "Enviar" no rodape (.window__main--footer)
 *  - limite .......... 140 caracteres por mensagem
 *  (matchers usam substring de classe pra tolerar content_ vs content__)
 *
 * LOGIN: AUTO-LOGIN por telefone + senha (aba "Entrar com senha" da 99/DiDi).
 * Vars: CHAT99_LOGIN (telefone, ex 71982138159) + CHAT99_SENHA. O checkbox
 * "Aceito Termos" é marcado automaticamente (obrigatório). Se cair OTP/captcha
 * ou o login falhar, o agente entra em cooldown; como fallback opcional ainda
 * dá pra semear CHAT99_STORAGE_STATE_B64. Veja o LEIA-ME.
 */

'use strict';

const fs = require('fs');
const { defineAgent } = require('../core/agent-base');
const { criarBrowserSession } = require('../core/browser-session');
const { initChat99Tables } = require('../../logistics/chat99.migration');

// ── Config via env ──────────────────────────────────────────────────────
const DELIVERS_URL   = process.env.CHAT99_DELIVERS_URL || 'https://entrega.99app.com/v2/delivers';
const LOOP_MS        = Number(process.env.CHAT99_LOOP_MS || 25_000);
const COOLDOWN_MS    = Number(process.env.CHAT99_RECONNECT_COOLDOWN_MS || 300_000); // 5min
const MAX_POR_TICK   = Number(process.env.CHAT99_MAX_POR_TICK || 6);
const TICK_TIMEOUT   = Number(process.env.CHAT99_TICK_TIMEOUT_MS || 300_000); // 5min
const SESSION_FILE   = process.env.CHAT99_SESSION_FILE || '/tmp/tutts-chat99-session.json';
const LIMITE_99      = 140;
const NAV_TIMEOUT    = Number(process.env.CHAT99_NAV_TIMEOUT_MS || 45_000);

const CHAT99_LAUNCH_OPTS = {
  headless: process.env.CHAT99_HEADLESS === 'false' ? false : true,
  timeout: 30_000,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-software-rasterizer', '--disable-background-networking',
    '--disable-default-apps', '--disable-extensions', '--disable-sync', '--disable-translate',
    '--disable-ipc-flooding-protection', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=TranslateUI,IsolateOrigins,site-per-process',
    '--hide-scrollbars', '--metrics-recording-only', '--mute-audio',
    '--no-first-run', '--safebrowsing-disable-auto-update', '--no-default-browser-check',
  ],
};

// ── Estado do módulo (persiste entre ticks) ─────────────────────────────
const CHAT99_BUILD = 'v8-outbox-retry (retenta erro/enviando travados + cap tentativas + log outbox)';
let _cooldownAte = 0;      // timestamp até quando ficar em cooldown
let _tabelasOk = false;    // migration idempotente já rodou neste processo?
let _sessaoSemeada = false;
let _versaoLogada = false; // ja logou o build marker neste processo?

function agora() { return Date.now(); }

// Semeia o storageState (login) a partir do env CHAT99_STORAGE_STATE_B64,
// caso o arquivo de sessão ainda não exista. É o caminho de login da v1.
function semearSessaoSePreciso(log) {
  if (_sessaoSemeada) return;
  _sessaoSemeada = true;
  try {
    if (fs.existsSync(SESSION_FILE)) return;
    let b64 = (process.env.CHAT99_STORAGE_STATE_B64 || '').trim();
    for (let i = 2; i <= 20; i++) {
      const parte = process.env['CHAT99_STORAGE_STATE_B64_' + i];
      if (!parte) break;
      b64 += parte.trim();
    }
    if (!b64) return;
    const raw = Buffer.from(b64, 'base64');
    let json;
    try { json = require('zlib').gunzipSync(raw).toString('utf8'); }
    catch (_) { json = raw.toString('utf8'); }
    JSON.parse(json); // valida
    fs.writeFileSync(SESSION_FILE, json, 'utf8');
    log('🌱 storageState semeado a partir de CHAT99_STORAGE_STATE_B64');
  } catch (e) {
    log(`⚠️ Falha ao semear storageState: ${e.message}`);
  }
}

async function screenshotErro(page, tag) {
  try {
    const p = `/tmp/chat99-${tag}-${Date.now()}.png`;
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch (_) { return null; }
}

function entrarCooldown(log, motivo) {
  _cooldownAte = agora() + COOLDOWN_MS;
  const min = Math.round(COOLDOWN_MS / 60000);
  log(`🟡 Cooldown de ${min}min (${motivo}). Volto às ${new Date(_cooldownAte).toLocaleTimeString('pt-BR')}`);
}

// ── Detecção de login ────────────────────────────────────────────────────
// "logado" = aparece um elemento que só existe na tela de delivers logada.
async function temMarcadoresLogado(page) {
  const marcadores = [
    'button:has-text("Novo pedido")',
    'button:has-text("Pesquisar")',
    'text=ID do pedido externo',
  ];
  for (const sel of marcadores) {
    const ok = await page.locator(sel).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  return false;
}

// Estamos na tela de login da 99/DiDi? (redireciona pra page.didiglobal.com)
async function ehTelaLogin(page) {
  const url = page.url() || '';
  if (url.includes('didiglobal.com') || /\/login\b/.test(url)) return true;
  const campoSenha = await page.locator('input[type="password"]').first()
    .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  return campoSenha;
}

// ── Auto-login: telefone + senha (aba "Entrar com senha") ─────────────────
// A 99 loga por telefone (o número é o próprio login). O <form> real é
// display:none (Vue controla o submit), então preenchemos os inputs e clicamos
// no "Entrar" visível. O checkbox "Aceito Termos" é OBRIGATORIO — sem ele o
// botao fica travado.
async function fazerLogin99(page, log) {
  const telefone = process.env.CHAT99_LOGIN || process.env.CHAT99_TELEFONE;
  const senha = process.env.CHAT99_SENHA;
  if (!telefone || !senha) {
    log('   ⚠️ sem CHAT99_LOGIN/CHAT99_SENHA — auto-login indisponível (use storageState)');
    return false;
  }
  try {
    // Garante a aba "Entrar com senha" (a de código de verificação exige OTP).
    const abaSenha = page.getByText('Entrar com senha', { exact: false }).first();
    if (await abaSenha.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await abaSenha.click().catch(() => {});
      await page.waitForTimeout(400);
    }

    // Telefone: input type=tel; fallback = primeiro input do card que não é senha.
    let tel = page.locator('input[type="tel"]:visible').first();
    if (!(await tel.count())) {
      tel = page.locator('.login-card input:visible:not([type="password"]):not([placeholder="Selecione o país"])').first();
    }
    if (!(await tel.count())) {
      tel = page.locator('.login-right input:visible:not([type="password"])').first();
    }
    await tel.click({ timeout: 10000 });
    await tel.fill('');
    await tel.type(String(telefone), { delay: 40 });

    // Senha
    const pass = page.locator('input[type="password"]').first();
    await pass.click({ timeout: 10000 });
    await pass.fill('');
    await pass.type(String(senha), { delay: 40 });

    // Checkbox "Aceito Termos e Condições" (OBRIGATORIO - trava o botao Entrar).
    // A DiDi usa um checkbox CUSTOM: <span class="checkbox check-default">, nao um
    // <input type="checkbox">. Clicamos no span (ou no wrapper) ate marcar.
    // Checkbox custom (span). Clica UMA vez (clicar 2x DESMARCA). Como a pagina
    // e recarregada a cada tentativa (ver garantirLogado), aqui e sempre estado
    // limpo -> 1 clique = marcado.
    const chkSpan = page.locator('.input-agreement-wrapper .checkbox, span.checkbox').first();
    await chkSpan.click({ force: true, timeout: 5000 }).catch(async () => {
      await page.locator('.input-agreement-wrapper').first().click({ force: true, timeout: 3000 }).catch(() => {});
    });
    // Headless precisa de mais tempo pro Vue propagar o estado (habilitar o botao).
    await page.waitForTimeout(1000);

    // Entrar: e uma <div class="button">, nao <button>.
    const entrar = page.locator('.button-wrap .button, div.button').first();
    await entrar.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await entrar.click({ timeout: 8000 }).catch(async () => {
      await page.getByText('Entrar', { exact: true }).first().click({ timeout: 6000 }).catch(() => {});
    });

    // Confirma: espera o redirect pro delivers OU os marcadores de logado.
    const logou = await page.waitForURL(/entrega\.99app\.com\/v2\/delivers/, { timeout: 18000 })
      .then(() => true).catch(() => false);
    await page.waitForTimeout(1200);
    const ok = logou || await temMarcadoresLogado(page);
    log(ok ? '   🔑 auto-login OK' : '   🔑 auto-login submetido (sem confirmacao)');
    return ok;
  } catch (e) {
    log(`   ❌ auto-login falhou: ${e.message}`);
    return false;
  }
}

// Garante sessão logada: vai pro delivers; se não logado, tenta auto-login;
// se ainda assim não logar (ex: caiu OTP/captcha), retorna false pro cooldown.
async function garantirLogado(page, log) {
  try {
    await page.goto(DELIVERS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (_) { return false; }

  if (await temMarcadoresLogado(page)) return true;

  if (!(await ehTelaLogin(page))) return false;

  // Tenta logar ate 2x. Cada tentativa recarrega a tela de login (estado limpo:
  // checkbox desmarcado), evitando o toggle acidental do checkbox.
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const ok = await fazerLogin99(page, log);
    if (ok) return true;
    // reconfirma pelo delivers (as vezes logou mas o waitForURL nao pegou)
    try { await page.goto(DELIVERS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); } catch (_) {}
    if (await temMarcadoresLogado(page)) return true;
    if (tentativa < 2) {
      log(`   \u21BB login tentativa ${tentativa} falhou, recarregando login...`);
      try { await page.goto(DELIVERS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); } catch (_) {}
      await page.waitForTimeout(1500);
      if (await temMarcadoresLogado(page)) return true; // caso raro: logou no meio
      if (!(await ehTelaLogin(page))) return false;
    }
  }
  return false;
}

// ── Busca as corridas 99 ativas na NOSSA base (+ as com outbox pendente) ──
async function buscarAlvos(pool, limite) {
  const { rows } = await pool.query(`
    WITH ativos AS (
      SELECT DISTINCT codigo_os::text AS os
      FROM logistics_deliveries
      WHERE provider_code = 'noventanove'
        AND COALESCE(status_canonico, '') NOT IN ('DELIVERED','CANCELED','FAILED','RETURNED')
      UNION
      SELECT DISTINCT c.codigo_os AS os
      FROM chat99_conversas c
      JOIN chat99_mensagens m ON m.conversa_id = c.id
      WHERE m.direcao = 'out' AND m.status_envio = 'pendente' AND c.status <> 'encerrada'
    )
    SELECT a.os,
           (SELECT ultima_varredura FROM chat99_conversas cc WHERE cc.codigo_os = a.os) AS lv
    FROM ativos a
    ORDER BY lv ASC NULLS FIRST
    LIMIT $1
  `, [limite]);
  return rows.map(r => String(r.os));
}

// ── Varredura unica da aba "Em andamento" ────────────────────────────────────
// Le a tabela da 99 e retorna as linhas que TEM o botao "Mensagem" (corrida
// aceita, chat ativo) na pagina atual: [{ i (indice da tr), os }].
async function coletarLinhasPagina(page) {
  // Espera o corpo da tabela (SPA carrega o tbody via API, depois do thead).
  await page.waitForSelector('table tbody tr', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(600);
  return await page.evaluate(() => {
    const res = [];
    const tabelas = Array.from(document.querySelectorAll('table'));
    let table = null;
    for (const t of tabelas) {
      const ths = Array.from(t.querySelectorAll('thead th')).map(x => (x.textContent || '').trim());
      const temCol = ths.some(x => /externo/i.test(x));
      const temLinhas = t.querySelectorAll('tbody tr').length > 0;
      if (temCol && temLinhas) { table = t; break; }
    }
    if (!table) {
      table = tabelas.sort((a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length)[0];
    }
    if (!table) return res;
    const ths = Array.from(table.querySelectorAll('thead th')).map(t => (t.textContent || '').trim());
    let idx = ths.findIndex(t => /externo/i.test(t));
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    rows.forEach((tr, i) => {
      const temMsg = Array.from(tr.querySelectorAll('button, a, span'))
        .some(el => /Mensagem/i.test(el.textContent || ''));
      if (!temMsg) return;
      const tds = Array.from(tr.querySelectorAll('td'));
      let os = (idx >= 0 && tds[idx]) ? (tds[idx].textContent || '').trim() : '';
      if (!os) { for (const td of tds) { const t = (td.textContent || '').trim(); if (/^\d{6,8}$/.test(t)) { os = t; break; } } }
      res.push({ i, os });
    });
    return res;
  });
}

// Clica no "Mensagem" da linha. O clique SINTETICO (el.click()) nao dispara o
// handler da 99 (dava "chat nao abriu"), entao usamos so cliques REAIS: normal
// -> fecha overlay + scroll + tenta de novo -> force. O overlay do chat anterior
// (#im-sdk-warper z-1001) e o maior interceptador; fecharChat resolve isso.
async function clicarMensagem(page, btn) {
  if (await btn.click({ timeout: 3500 }).then(() => true).catch(() => false)) return true;
  await fecharChat(page).catch(() => {});
  const h = await btn.elementHandle().catch(() => null);
  if (h) await h.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
  await page.waitForTimeout(200);
  if (await btn.click({ timeout: 3500 }).then(() => true).catch(() => false)) return true;
  return await btn.click({ timeout: 3500, force: true }).then(() => true).catch(() => false);
}

// Processa UMA linha: abre o chat pelo botao da propria linha (sem re-filtrar
// por OS), captura bolhas e drena a outbox.
async function processarLinha(page, pool, linha, log) {
  // Garante que nenhum chat anterior ficou aberto (o overlay #im-sdk-warper
  // z-1001 intercepta o clique de abrir a proxima OS).
  await fecharChat(page).catch(() => {});
  // Abre com verificacao real: se o chat nao aparecer, fecha o painel de
  // detalhes (que sobrepoe as linhas de baixo) e o chat anterior, e tenta de
  // novo (ate 3x). O force do clique pode "acertar" o painel, por isso a
  // confirmacao e a visibilidade do .chat__window, nao o retorno do clique.
  let abriu = false;
  for (let tent = 1; tent <= 3 && !abriu; tent++) {
    await fecharChat(page).catch(() => {});
    const fechouPainel = await fecharDetalhe(page).catch(() => false);
    if (fechouPainel) { log(`   OS ${linha.os}: painel de detalhes fechado (tentativa ${tent})`); await page.waitForTimeout(300); }

    // re-resolve a linha/botao (o DOM pode ter mudado apos fechar overlays)
    const tr = linha.os
      ? page.locator('table tbody tr', { hasText: String(linha.os) }).first()
      : page.locator('table tbody tr').nth(linha.i);
    const btn = tr.getByText(/Mensagem/i).first();
    const vis = await btn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!vis) { log(`   OS ${linha.os}: botao Mensagem sumiu`); return; }

    const h = await btn.elementHandle().catch(() => null);
    if (h) await h.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
    await clicarMensagem(page, btn);

    abriu = await page.locator('.chat__window').first()
      .waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!abriu) await page.waitForTimeout(400);
  }
  if (!abriu) { log(`   OS ${linha.os}: chat nao abriu (apos 3 tentativas)`); return; }
  // Espera as bolhas renderizarem (carregam assincronas, igual o tbody da tabela).
  await page.locator('.chat__window [class*="msg_"]').first()
    .waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(700);
  const info = await extrairInfoMotoboy(page);
  const conversaId = await upsertConversa(pool, linha.os, info);
  const bolhas = await extrairBolhas(page);
  const nIn = bolhas.filter(b => b.direcao === 'in').length;
  const nOut = bolhas.filter(b => b.direcao === 'out').length;
  log(`   \u{1F52C} OS ${linha.os}: ${bolhas.length} bolha(s) lidas (${nIn} in / ${nOut} out)`);
  if (bolhas.length === 0) {
    const arv = await dumpEstrutura(page).catch(() => null);
    if (arv) log(`   \u{1F9ED} [chat99-dump] OS ${linha.os} estrutura do chat:\n${arv}`);
  }
  const novas = await gravarNovas(pool, conversaId, bolhas);
  if (novas > 0) log(`   \u{1F4AC} OS ${linha.os}: ${novas} nova(s) do motoboy`);
  await drenarOutbox(page, pool, conversaId, log);
  await fecharChat(page);
  await page.waitForTimeout(400);
}


// ── Filtra por OS e abre o chat. Retorna true se o chat abriu. ────────────
// Filtrar por OS deixa a corrida como PRIMEIRA (e unica) linha da tabela — que
// e sempre clicavel, sem o painel de detalhes de outra OS sobrepondo.
async function abrirChatDaOS(page, os, log) {
  // limpa overlays que possam cobrir o filtro/tabela
  await fecharChat(page).catch(() => {});
  await fecharDetalhe(page).catch(() => {});

  // 1) limpa e preenche o filtro "ID do pedido externo"
  const filtro = page.locator('input[placeholder="ID do pedido externo"]').first();
  await filtro.click({ timeout: 15000 }).catch(() => {});
  await filtro.fill('').catch(() => {});
  await filtro.fill(String(os)).catch(() => {});

  // 2) Pesquisar
  await page.locator('button:has-text("Pesquisar")').first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2200); // deixa a tabela recarregar (so a OS filtrada)

  // 3) acha a linha da OS e o botao "Mensagem" (agora e a 1a linha)
  const linha = page.locator('table tbody tr', { hasText: String(os) }).first();
  const temLinha = await linha.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!temLinha) { log(`   OS ${os}: linha não encontrada na 99`); return false; }

  const btnMsg = linha.getByText(/Mensagem/i).first();
  const temMsg = await btnMsg.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!temMsg) { log(`   OS ${os}: sem botão Mensagem (aguardando aceite)`); return false; }

  // 4) abre com verificacao real (ate 2x)
  for (let tent = 1; tent <= 2; tent++) {
    const h = await btnMsg.elementHandle().catch(() => null);
    if (h) await h.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
    await clicarMensagem(page, btnMsg);
    const abriu = await page.locator('.chat__window').first()
      .waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    if (abriu) return true;
    await fecharDetalhe(page).catch(() => {});
    await page.waitForTimeout(400);
  }
  return false;
}

// ── Extrai dados do motoboy do modal (nome + foto; rating/telefone best-effort)
async function extrairInfoMotoboy(page) {
  return await page.evaluate(() => {
    const pick = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
    const janela = document.querySelector('.chat__window');
    let nome = null, foto = null;
    if (janela) {
      const nav = janela.querySelector('[class*="nav-bar"]');
      if (nav) nome = nav.textContent.trim() || null;
      const avatarImg = janela.querySelector('[class*="avatar"] img') || janela.querySelector('img');
      if (avatarImg && avatarImg.src) foto = avatarImg.src;
    }
    // Painel de detalhes (se aberto): rating, telefone, ID do pedido
    let rating = null, telefone = null, pedidoId = null;
    const corpo = document.body.innerText || '';
    const mRating = corpo.match(/★?\s*(\d\.\d{1,2})\b/);
    if (mRating) rating = mRating[1];
    const mTel = corpo.match(/\+55\s?\d[\d\s-]{8,}/);
    if (mTel) telefone = mTel[0].replace(/\s+/g, ' ').trim();
    const mPed = corpo.match(/ID do pedido\s*[:：]\s*(\d{6,})/);
    if (mPed) pedidoId = mPed[1];
    return { nome, foto, rating, telefone, pedidoId };
  });
}

// ── Extrai as bolhas do chat ──────────────────────────────────────────────
// A janela real da 99 e Vant/Vue (.chat__window > .window__main--content). As
// bolhas NAO tem, garantidamente, a classe "msg_<id>" que a v1 assumia. Este
// extrator e agnostico de estrutura:
//   1) se existir "msg_<id>" na classe, usa como dedup natural (caminho feliz);
//   2) senao, trata cada elemento-folha com texto util dentro do
//      .window__main--content como uma bolha e infere a direcao por classe
//      (self/other/left/right) OU pela posicao horizontal (bolha a direita do
//      meio do container = nossa/out; a esquerda = motoboy/in);
//   3) dedup por chave estavel: id real da 99, ou
//      "g_<direcao>_<horario|posicao>_<hash(texto)>" (append-only => estavel).
async function extrairBolhas(page) {
  return await page.evaluate(() => {
    const janela = document.querySelector('.chat__window') || document.body;
    if (!janela) return [];
    const cont =
      janela.querySelector('[class*="window__main--content"]') ||
      janela.querySelector('[class*="window__main"]') ||
      janela;

    const cls = (el) => {
      if (!el) return '';
      const c = el.className;
      if (typeof c === 'string') return c;
      if (c && typeof c.baseVal === 'string') return c.baseVal; // svg
      return String(c || '');
    };
    const hashTexto = (s) => {
      let h = 0; s = String(s || '');
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    };
    // id real da 99 vem na classe da bolha: "content__msg msg__65561".
    // ATENCAO: e underscore DUPLO (msg__), por isso "msg_\d+" da v1 nunca casava.
    const idReal = (el) => {
      for (let up = 0, cur = el; up < 5 && cur; up++, cur = cur.parentElement) {
        const m = cls(cur).match(/msg[_-]+(\d{3,})/i);
        if (m) return m[1];
      }
      const inner = el.querySelector && el.querySelector('[class*="msg_"]');
      if (inner) { const m = cls(inner).match(/msg[_-]+(\d{3,})/i); if (m) return m[1]; }
      return null;
    };

    // 1) caminho feliz (DOM real da 99, confirmado): a bolha e div.content__msg
    //    (com msg__<id>); o texto fica num <span class="msg__span"> interno.
    //    Isso ja EXCLUI o lixo do plugin de endereco / botoes de sistema.
    let msgEls = Array.from(cont.querySelectorAll('[class*="content__msg"]'));
    if (msgEls.length === 0) {
      // layouts antigos: qualquer classe msg_<id>/msg__<id> junto de "content"
      msgEls = Array.from(cont.querySelectorAll('[class*="msg_"]'))
        .filter(el => /msg[_-]+\d{3,}/.test(cls(el)) && /content/i.test(cls(el)));
    }

    // 2) fallback generico: folhas com texto util dentro do content
    if (msgEls.length === 0) {
      const cand = [];
      const walker = document.createTreeWalker(cont, NodeFilter.SHOW_ELEMENT, null);
      let n;
      while ((n = walker.nextNode())) {
        const c = cls(n).toLowerCase();
        // pula chrome do rodape/input/scroll/nav/avatar/plugin de endereco/barras
        if (/footer|textarea|van-field|van-cell|van-button|nav-bar|scroll|avatar|__time|isread|plugin|newmsg|content__time/.test(c)) continue;
        const txt = (n.innerText || n.textContent || '').trim();
        if (!txt) continue;
        // pega o no MAIS interno que carrega o texto (evita contar o wrapper e a folha)
        const filhoIgual = Array.from(n.children).some(ch => (ch.innerText || ch.textContent || '').trim() === txt);
        if (filhoIgual) continue;
        if (/^\d{1,2}:\d{2}$/.test(txt)) continue;                 // so horario
        if (/^(enviad[ao]|lida?|read|✓+|✔+)$/i.test(txt)) continue; // status
        if (txt.length > 1200) continue;                            // provavelmente wrapper gigante
        cand.push(n);
      }
      msgEls = cand;
    }

    // centro horizontal do container (pra inferir lado sem classe self)
    let contMid = null;
    try { const r = cont.getBoundingClientRect(); if (r.width) contMid = r.left + r.width / 2; } catch (_) {}

    // filtro de LIXO: o plugin de endereco/rota da 99 e alguns botoes de UI
    // ("Voltar ao mais recente", "Nova mensagem") podem vazar como texto. Barra.
    const ehLixo = (t) => {
      if (!t) return true;
      const s = t.trim();
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return true;        // comeca com data
      if (/destinat[aá]rio\s*:/i.test(s)) return true;              // "Destinatario:Cliente"
      if (/^remetente\s*:/i.test(s)) return true;
      if (/^voltar ao mais recente$/i.test(s)) return true;
      if (/^nova mensagem$/i.test(s)) return true;
      if (/,\s*BR\s*$/i.test(s) && /-\s*[A-Z]{2},/.test(s)) return true; // endereco "..- GO, 00000-000, BR"
      return false;
    };

    const out = [];
    const vistos = new Set();
    let ordem = 0;
    for (const el of msgEls) {
      // texto: prefere o <span class="msg__span"> interno (evita pegar horario/avatar)
      const span = el.querySelector && el.querySelector('[class*="msg__span"], [class*="msg_span"]');
      const txt = ((span ? span.innerText || span.textContent : el.innerText || el.textContent) || '').trim();
      const imgEl = el.querySelector && el.querySelector('img[src]');
      const img = (imgEl && imgEl.src && !/avatar/i.test(cls(imgEl))) ? imgEl.src : null;
      if (!txt && !img) continue;
      if (txt && !img && ehLixo(txt)) continue; // barra endereco/plugin/botoes de UI

      // direcao: 1) classe self/right/mine  2) classe other/left  3) posicao
      let selfCls = false, otherCls = false;
      for (let up = 0, cur = el; up < 6 && cur; up++, cur = cur.parentElement) {
        const c = cls(cur).toLowerCase();
        if (/(isself|--self|_self|--right|--mine|--send|--sent|--me|\bself\b|\bright\b)/.test(c)) { selfCls = true; break; }
        if (/(--other|--left|--friend|--receive|--received|--them|\bother\b|\bleft\b)/.test(c)) { otherCls = true; break; }
      }
      let direcao;
      if (selfCls) direcao = 'out';
      else if (otherCls) direcao = 'in';
      else if (contMid != null) {
        try { const r = el.getBoundingClientRect(); direcao = (r.left + r.width / 2) >= contMid ? 'out' : 'in'; }
        catch (_) { direcao = 'in'; }
      } else direcao = 'in';

      // horario: hh:mm proximo da bolha
      let horario = '';
      for (let up = 0, cur = el; up < 4 && cur; up++, cur = cur.parentElement) {
        const t = Array.from(cur.querySelectorAll('[class*="time"], span, div, p'))
          .map(x => (x.textContent || '').trim())
          .find(v => /^\d{1,2}:\d{2}$/.test(v));
        if (t) { horario = t; break; }
      }

      const idr = idReal(el);
      const msgId = idr || ('g_' + direcao + '_' + (horario || ('p' + ordem)) + '_' + hashTexto(txt));
      if (vistos.has(msgId)) continue;
      vistos.add(msgId);

      out.push({ msgId, direcao, texto: txt, img, horario, lido: false });
      ordem++;
    }
    return out;
  });
}

// ── Diagnostico: dump da estrutura do .window__main--content ──────────────
// Usado so quando extrairBolhas volta vazio, pra revelar o DOM real da 99 no
// log do Railway e travar os seletores definitivos numa proxima passada.
async function dumpEstrutura(page) {
  return await page.evaluate(() => {
    const cls = (el) => {
      const c = el && el.className;
      if (typeof c === 'string') return c;
      if (c && typeof c.baseVal === 'string') return c.baseVal;
      return String(c || '');
    };
    const janela = document.querySelector('.chat__window') || document.body;
    const cont =
      (janela && janela.querySelector('[class*="window__main--content"]')) ||
      (janela && janela.querySelector('[class*="window__main"]')) ||
      janela;
    if (!cont) return '(sem .chat__window / window__main--content)';
    const linhas = [];
    const push = (el, d) => {
      if (linhas.length > 80) return;
      const tag = (el.tagName || '').toLowerCase();
      const c = cls(el).trim().replace(/\s+/g, ' ').slice(0, 90);
      const own = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 45);
      linhas.push('  '.repeat(d) + tag + (c ? '.' + c : '') + (own ? '  » ' + own : ''));
      Array.from(el.children || []).forEach(ch => push(ch, d + 1));
    };
    try { push(cont, 0); } catch (e) { return 'erro no dump: ' + e.message; }
    return 'container=' + cls(cont) + '\n' + linhas.join('\n');
  });
}

// ── Grava mensagens novas do motoboy (dedup por msg_99_id) ────────────────
async function gravarNovas(pool, conversaId, bolhas) {
  let novas = 0, ultimaTexto = null;
  for (const b of bolhas) {
    if (b.direcao !== 'in' || !b.msgId) continue;
    const r = await pool.query(`
      INSERT INTO chat99_mensagens (conversa_id, msg_99_id, direcao, autor, texto, img_url, horario_99, lido, status_envio)
      VALUES ($1, $2, 'in', 'motoboy', $3, $4, $5, false, 'recebida')
      ON CONFLICT (conversa_id, msg_99_id) WHERE msg_99_id IS NOT NULL DO NOTHING
      RETURNING id
    `, [conversaId, b.msgId, b.texto || null, b.img || null, b.horario || null]);
    if (r.rows.length > 0) { novas++; ultimaTexto = b.texto || (b.img ? '[imagem]' : ''); }
  }
  if (novas > 0) {
    await pool.query(`
      UPDATE chat99_conversas
      SET nao_lidas = nao_lidas + $2, ultima_msg_texto = COALESCE($3, ultima_msg_texto),
          ultima_msg_em = now(), atualizado_em = now()
      WHERE id = $1
    `, [conversaId, novas, ultimaTexto]);
  }
  return novas;
}

// ── Envia uma mensagem na janela, fatiando em blocos de 140 ───────────────
// DOM real (confirmado): rodape = .window__main--footer com
//   textarea.van-field__control[placeholder="Insira o texto aqui"]  (input)
//   button.footer__send.van-button--warning                         (enviar)
// O problema classico Vant/Vue: preencher via Playwright nao dispara o input
// que o v-model escuta -> o botao continua "desabilitado" (por classe, sem attr
// disabled) e o clique vira no-op. Solucao: setar o valor pelo NATIVE SETTER e
// disparar 'input'/'change', o que o Vue reconhece e habilita o footer__send.
async function enviarNaJanela(page, texto, log) {
  const _log = typeof log === 'function' ? log : () => {};
  const partes = [];
  let resto = String(texto);
  while (resto.length > LIMITE_99) { partes.push(resto.slice(0, LIMITE_99)); resto = resto.slice(LIMITE_99); }
  if (resto) partes.push(resto);

  const footer = page.locator('.chat__window .window__main--footer').first();
  const temFooter = await footer.count();
  const escopo = temFooter ? footer : page.locator('.chat__window');

  // Input do CHAT (nao a caixa de endereco). Placeholder confirmado no DOM.
  let input = escopo.locator('textarea[placeholder="Insira o texto aqui"]').first();
  if (!(await input.count())) input = escopo.locator('textarea.van-field__control').first();
  if (!(await input.count())) input = escopo.locator('textarea').first();
  if (!(await input.count())) input = page.locator('.chat__window textarea').last();
  if (!(await input.count())) { throw new Error('input do chat (textarea) nao encontrado no rodape'); }

  const acharBotao = async () => {
    let b = footer.locator('button.footer__send, .footer__send').first();
    if (await b.count()) return b;
    b = footer.locator('button.van-button--warning').first();
    if (await b.count()) return b;
    return footer.locator('button').last();
  };

  // Seta o valor de um jeito que o Vue/Vant reconheca (native setter + input).
  const setarValor = async (val) => {
    await input.evaluate((el, v) => {
      const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, val).catch(() => {});
  };

  for (const parte of partes) {
    let enviado = false;

    for (let tent = 1; tent <= 3 && !enviado; tent++) {
      await input.click({ timeout: 10000 }).catch(() => {});
      // limpa e digita (real key events)
      await input.fill('').catch(() => {});
      await input.pressSequentially(parte, { delay: 15 }).catch(() => {});
      await page.waitForTimeout(200);
      // confirma o valor; se nao bateu, aplica o native setter (Vue-friendly)
      let val = ((await input.inputValue().catch(() => '')) || '');
      if (val.trim() !== parte.trim()) { await setarValor(parte); await page.waitForTimeout(150); }
      // reforca o input event mesmo quando o texto ja esta la (habilita o botao)
      await setarValor(((await input.inputValue().catch(() => '')) || '') || parte);
      await page.waitForTimeout(300);

      const sendBtn = await acharBotao();
      const st = await sendBtn.evaluate(el => ({
        disabled: el.hasAttribute('disabled') || /(^|\s)(van-button--disabled|is-disabled|disabled)(\s|$)/i.test(el.className || ''),
        cls: (el.className || '').toString().slice(0, 80),
      })).catch(() => null);

      // tenta enviar: clique normal -> clique via evaluate -> Enter
      await sendBtn.click({ timeout: 6000 }).catch(() => {});
      let limpou = ((await input.inputValue().catch(() => '')) || '').trim() === '';
      if (!limpou) {
        await sendBtn.evaluate(el => el.click()).catch(() => {});
        await page.waitForTimeout(700);
        limpou = ((await input.inputValue().catch(() => '')) || '').trim() === '';
      }
      if (!limpou) {
        await input.press('Enter').catch(() => {});
        await page.waitForTimeout(700);
        limpou = ((await input.inputValue().catch(() => '')) || '').trim() === '';
      }

      enviado = limpou;
      if (!enviado) {
        _log(`      ⚠️ envio tentativa ${tent} falhou · botao={${st ? st.cls : 'nao-achado'}} disabled=${st ? st.disabled : '?'} valorInput="${((await input.inputValue().catch(()=> '')) || '').slice(0,20)}"`);
      }
    }

    if (!enviado) throw new Error('nao consegui enviar (botao footer__send nao respondeu apos 3 tentativas)');
    await page.waitForTimeout(700);
  }
}

// ── Drena a outbox da conversa ────────────────────────────────────────────
// Pega 'pendente' E TAMBEM as que travaram: 'erro' (falha anterior, ja corrigida)
// e 'enviando' orfãs (browser reciclou no meio). Cap de tentativas evita loop
// infinito numa mensagem cronicamente problematica.
const MAX_TENT_ENVIO = 6;
async function drenarOutbox(page, pool, conversaId, log) {
  const { rows } = await pool.query(`
    SELECT id, texto, status_envio, COALESCE(tentativas,0) AS tentativas
    FROM chat99_mensagens
    WHERE conversa_id = $1 AND direcao = 'out'
      AND status_envio IN ('pendente', 'erro', 'enviando')
      AND COALESCE(tentativas,0) < $2
    ORDER BY id ASC
  `, [conversaId, MAX_TENT_ENVIO]);

  if (rows.length) log(`   📤 outbox: ${rows.length} msg(s) para enviar`);
  for (const msg of rows) {
    await pool.query(
      `UPDATE chat99_mensagens SET status_envio='enviando', tentativas=COALESCE(tentativas,0)+1 WHERE id=$1`,
      [msg.id]
    );
    try {
      await enviarNaJanela(page, msg.texto || '', log);
      await pool.query(`UPDATE chat99_mensagens SET status_envio='enviada', enviado_em=now() WHERE id=$1`, [msg.id]);
      log(`   ✉️ enviada msg #${msg.id}`);
    } catch (e) {
      await pool.query(`UPDATE chat99_mensagens SET status_envio='erro', erro_envio=$2 WHERE id=$1`, [msg.id, String(e.message).slice(0, 300)]);
      log(`   ❌ falha ao enviar msg #${msg.id} (tent ${msg.tentativas + 1}/${MAX_TENT_ENVIO}): ${e.message}`);
    }
  }
}

async function fecharChat(page) {
  const cw = page.locator('.chat__window').first();
  if (!(await cw.isVisible().catch(() => false))) return; // ja fechado

  // 1) tenta os X/voltar do nav-bar do chat (Vant: __right / __left / cross)
  const alvos = [
    '.chat__window .van-nav-bar__right',
    '.chat__window .van-nav-bar__left',
    '.chat__window [class*="nav-bar"] [class*="cross"]',
    '.chat__window [class*="nav-bar"] [class*="close"]',
    '.chat__window [class*="nav-bar"] .van-icon',
    '.chat__window [class*="nav-bar"] i',
    '.chat__window [class*="nav-bar"] svg',
  ];
  for (const sel of alvos) {
    const x = page.locator(sel).first();
    if ((await x.count()) && (await x.isVisible().catch(() => false))) {
      await x.click({ timeout: 1500 }).catch(() => {});
      if (!(await cw.isVisible().catch(() => false))) return;
    }
  }

  // 2) Escape
  await page.keyboard.press('Escape').catch(() => {});
  if (await cw.waitFor({ state: 'hidden', timeout: 1500 }).then(() => true).catch(() => false)) return;

  // 3) ultimo recurso: clica no icone de fechar do nav-bar via evaluate (sintetico)
  await page.evaluate(() => {
    const win = document.querySelector('.chat__window');
    const nav = win && win.querySelector('[class*="nav-bar"]');
    const cand = nav && nav.querySelector('[class*="cross"], [class*="close"], .van-icon, i, svg, [role="button"]');
    if (cand) cand.click();
  }).catch(() => {});
  // Espera o overlay (#im-sdk-warper, z-1001) sumir de fato antes de seguir,
  // senao ele intercepta o clique de abrir a proxima OS.
  await cw.waitFor({ state: 'hidden', timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(250);
}

// Fecha o painel de detalhes do pedido (lado direito: "ID do pedido" /
// "Informacoes do entregador" / "Cancelar pedido"). Ele sobrepoe as linhas de
// baixo da tabela e faz o clique de abrir a proxima OS cair no painel (o force
// "clica" mas acerta o painel -> "chat nao abriu"). Best-effort, via ancora de
// texto "ID do pedido". Retorna true se clicou num X de fechar.
async function fecharDetalhe(page) {
  return await page.evaluate(() => {
    const clsOf = (x) => (x && x.className && x.className.baseVal !== undefined)
      ? x.className.baseVal : String((x && x.className) || '');
    const cabs = Array.from(document.querySelectorAll('div, span, p, header, h1, h2, h3'))
      .filter(el => /ID do pedido/i.test(el.textContent || '') && el.children.length <= 4);
    for (const cab of cabs) {
      let cont = cab;
      for (let up = 0; up < 5 && cont; up++, cont = cont.parentElement) {
        const xs = cont.querySelectorAll(
          '[class*="close"], [class*="cross"], [aria-label], .van-icon-cross, i, svg, img, button, span'
        );
        for (const x of xs) {
          const cs = clsOf(x).toLowerCase();
          const al = ((x.getAttribute && (x.getAttribute('aria-label') || '')) || '').toLowerCase();
          const tx = (x.textContent || '').trim();
          const ehXtexto = (tx === '✕' || tx === '×' || tx === 'X' || tx === 'x') && x.children.length === 0;
          if (/close|cross|fechar/.test(cs) || /close|fechar/.test(al) || ehXtexto) {
            try { x.click(); return true; } catch (_) {}
          }
        }
      }
    }
    return false;
  }).catch(() => false);
}

async function upsertConversa(pool, os, info) {
  const r = await pool.query(`
    INSERT INTO chat99_conversas
      (codigo_os, pedido_id_99, motoboy_nome, motoboy_telefone, motoboy_foto_url, motoboy_rating, status, ultima_varredura, atualizado_em)
    VALUES ($1, $2, $3, $4, $5, $6, 'ativa', now(), now())
    ON CONFLICT (codigo_os) DO UPDATE SET
      pedido_id_99     = COALESCE(EXCLUDED.pedido_id_99, chat99_conversas.pedido_id_99),
      motoboy_nome     = COALESCE(EXCLUDED.motoboy_nome, chat99_conversas.motoboy_nome),
      motoboy_telefone = COALESCE(EXCLUDED.motoboy_telefone, chat99_conversas.motoboy_telefone),
      motoboy_foto_url = COALESCE(EXCLUDED.motoboy_foto_url, chat99_conversas.motoboy_foto_url),
      motoboy_rating   = COALESCE(EXCLUDED.motoboy_rating, chat99_conversas.motoboy_rating),
      status           = CASE WHEN chat99_conversas.status='encerrada' THEN chat99_conversas.status ELSE 'ativa' END,
      ultima_varredura = now(),
      atualizado_em    = now()
    RETURNING id
  `, [os, info.pedidoId || null, info.nome || null, info.telefone || null, info.foto || null, info.rating || null]);
  return r.rows[0].id;
}

async function marcarVarredura(pool, os) {
  await pool.query(`
    UPDATE chat99_conversas SET ultima_varredura = now(), atualizado_em = now() WHERE codigo_os = $1
  `, [os]).catch(() => {});
}

// ── Processa 1 conversa (serial, abre via FILTRO -> vira a 1a linha) ───────
async function processarConversa(page, pool, os, log) {
  const abriu = await abrirChatDaOS(page, os, log);
  if (!abriu) {
    // Aguardando aceite (ou linha ausente/nao abriu): registra varredura.
    await marcarVarredura(pool, os);
    log(`   OS ${os}: chat nao abriu`);
    return;
  }
  // Espera as bolhas renderizarem (carregam assincronas).
  await page.locator('.chat__window [class*="content__msg"], .chat__window [class*="msg_"]').first()
    .waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(700);
  const info = await extrairInfoMotoboy(page);
  const conversaId = await upsertConversa(pool, os, info);
  const bolhas = await extrairBolhas(page);
  const nIn = bolhas.filter(b => b.direcao === 'in').length;
  const nOut = bolhas.filter(b => b.direcao === 'out').length;
  log(`   \u{1F52C} OS ${os}: ${bolhas.length} bolha(s) lidas (${nIn} in / ${nOut} out)`);
  if (bolhas.length === 0) {
    const arv = await dumpEstrutura(page).catch(() => null);
    if (arv) log(`   \u{1F9ED} [chat99-dump] OS ${os} estrutura do chat:\n${arv}`);
  }
  const novas = await gravarNovas(pool, conversaId, bolhas);
  if (novas > 0) log(`   \u{1F4AC} OS ${os}: ${novas} nova(s) do motoboy`);
  await drenarOutbox(page, pool, conversaId, log);
  await fecharChat(page);
  await page.waitForTimeout(400);
}

// ═══════════════════════════════════════════════════════════════════════════
// Semeia a sessao a partir do banco (tabela chat99_sessao).
async function semearSessaoDoBanco(pool, log) {
  try {
    if (fs.existsSync(SESSION_FILE)) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS chat99_sessao (id INT PRIMARY KEY DEFAULT 1, storage_json TEXT, atualizado_em TIMESTAMPTZ DEFAULT now())`);
    const r = await pool.query('SELECT storage_json FROM chat99_sessao WHERE id = 1');
    if (r.rows.length && r.rows[0].storage_json) {
      JSON.parse(r.rows[0].storage_json);
      fs.writeFileSync(SESSION_FILE, r.rows[0].storage_json, 'utf8');
      log('\u{1F331} storageState semeado do banco (chat99_sessao)');
    }
  } catch (e) {
    log('\u26A0\uFE0F Falha ao semear do banco: ' + e.message);
  }
}

module.exports = defineAgent({
  nome: 'chat99',
  slots: 1,
  sessionStrategy: null,        // sessão do 99 gerenciada aqui (não é SISTEMA_EXTERNO)
  intervalo: LOOP_MS,           // ~25s entre ticks
  timeoutMs: TICK_TIMEOUT,      // teto por tick

  habilitado: () => process.env.CHAT99_AGENT_ATIVO === 'true',

  tickGlobal: async (pool, ctx) => {
    if (!_versaoLogada) { _versaoLogada = true; ctx.log(`🏷️ chat99 build: ${CHAT99_BUILD}`); }
    // Migration idempotente (garante tabelas mesmo se o backend principal ainda
    // não rodou — os dois serviços compartilham o mesmo Neon).
    if (!_tabelasOk) {
      await initChat99Tables(pool).catch(e => ctx.log(`⚠️ initChat99Tables: ${e.message}`));
      // coluna p/ contar tentativas de envio (retry da outbox sem loop infinito)
      await pool.query(`ALTER TABLE chat99_mensagens ADD COLUMN IF NOT EXISTS tentativas INT DEFAULT 0`).catch(() => {});
      _tabelasOk = true;
    }
    await semearSessaoDoBanco(pool, ctx.log);
    if (false) {
    }

    // Cooldown pós-derrubada: não briga por sessão.
    if (agora() < _cooldownAte) {
      const restante = Math.ceil((_cooldownAte - agora()) / 1000);
      ctx.log(`🟡 Em cooldown (${restante}s restantes)`);
      return;
    }

    semearSessaoSePreciso(ctx.log);

    // Browser persistente lazy no slotState (persiste entre ticks).
    // Recicla o browser antes do reaper (3min) matar no meio do tick.
    if (ctx.slotState.browserSession && ctx.slotState._browserNascidoEm &&
        (Date.now() - ctx.slotState._browserNascidoEm) > 150000) {
      try { await ctx.slotState.browserSession.fechar(); } catch (_) {}
      ctx.slotState.browserSession = null;
      ctx.log('\u267B\uFE0F Browser reciclado (antes do reaper de 3min)');
    }
    if (!ctx.slotState.browserSession) {
      ctx.slotState.browserSession = criarBrowserSession({
        nome: 'chat99-global', launchOpts: CHAT99_LAUNCH_OPTS, protegerDoReaper: true,
      });
      ctx.slotState._browserNascidoEm = Date.now();
      ctx.log('🔧 BrowserSession chat99 criada');
    }
    const bs = ctx.slotState.browserSession;
    const contextOpts = fs.existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {};

    await bs.comContext(async (context) => {
      const page = await context.newPage();
      try {
        const logado = await garantirLogado(page, ctx.log);
        if (!logado) {
          const ss = await screenshotErro(page, 'nao-logado');
          entrarCooldown(ctx.log, 'não foi possível logar na 99');
          ctx.log(`   ⚠️ Não logado na 99 (auto-login falhou ou caiu OTP/captcha). ` +
                  `Confira CHAT99_LOGIN/CHAT99_SENHA ou semeie CHAT99_STORAGE_STATE_B64. Screenshot: ${ss}`);
          return;
        }
        // Persiste a sessão (renova cookies) pro próximo tick.
        await context.storageState({ path: SESSION_FILE }).catch(() => {});
        try {
          const _st = await context.storageState();
          await pool.query(`INSERT INTO chat99_sessao (id, storage_json, atualizado_em) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET storage_json = EXCLUDED.storage_json, atualizado_em = now()`, [JSON.stringify(_st)]);
        } catch (_) {}

        // VARREDURA EM 2 FASES:
        //  FASE 1: coleta TODAS as OSs com chat (todas as paginas da lista).
        //  FASE 2: abre CADA OS pelo FILTRO -> ela vira a 1a (e unica) linha da
        //          tabela, que e sempre clicavel. Isso elimina a sobreposicao do
        //          painel de detalhes de outra OS (que travava a 2a linha+).
        const MAX_PAGINAS = Number(process.env.CHAT99_MAX_PAGINAS || 10);
        const BUDGET_MS = Number(process.env.CHAT99_TICK_BUDGET_MS || 140000);
        const inicioTick = Date.now();
        let processadas = 0, pagina = 1;
        const osSet = new Set();

        // FASE 1 — coletar
        while (pagina <= MAX_PAGINAS) {
          if (ctx.ehParaParar() || (Date.now() - inicioTick) > BUDGET_MS) break;
          await page.waitForTimeout(1200); // deixa a tabela renderizar
          const linhas = await coletarLinhasPagina(page);
          for (const l of linhas) if (l.os) osSet.add(String(l.os));
          if (pagina === 1 && linhas.length === 0) ctx.log('nenhuma corrida 99 com chat ativo');

          const next = page.locator('.ant-pagination-next').first();
          const cls = (await next.getAttribute('class').catch(() => '')) || '';
          const ariaDis = (await next.getAttribute('aria-disabled').catch(() => '')) || '';
          if (cls.includes('disabled') || ariaDis === 'true') break;
          await next.click({ timeout: 5000 }).catch(() => {});
          pagina++;
        }

        const todasOS = Array.from(osSet);
        // FASE 2 — processar cada OS via filtro
        for (const os of todasOS) {
          if (ctx.ehParaParar() || (Date.now() - inicioTick) > BUDGET_MS) break;
          try {
            await processarConversa(page, pool, os, ctx.log);
            processadas++;
          } catch (e) {
            ctx.log(`❌ OS ${os}: ${e.message}`);
            await fecharChat(page).catch(() => {});
          }
        }
        ctx.log(`🔎 varredura: ${todasOS.length} corrida(s) com chat, ${processadas} processada(s)`);
      } finally {
        await page.close().catch(() => {});
      }
    }, contextOpts);
  },
});
