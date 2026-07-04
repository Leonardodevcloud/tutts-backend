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
let _cooldownAte = 0;      // timestamp até quando ficar em cooldown
let _tabelasOk = false;    // migration idempotente já rodou neste processo?
let _sessaoSemeada = false;

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
    // Checkbox custom (span). PERIGO: clicar 2x DESMARCA. Entao clicamos UMA vez
    // e usamos o estado do BOTAO ENTRAR como prova (nao a classe do checkbox, que
    // e ambigua). Se o Entrar nao habilitar, clicamos o checkbox +1 vez (toggle).
    const chkSpan = page.locator('.input-agreement-wrapper .checkbox, span.checkbox').first();
    const entrar = page.locator('.button-wrap .button, div.button').first();

    // habilitado = a div NAO tem "disabled" nem opacidade de desabilitado.
    // A DiDi usa "button actived" quando pode clicar; desabilitado costuma ter
    // classe com "disabled" ou faltar "actived".
    async function entrarHabilitado() {
      const cls = (await entrar.getAttribute('class').catch(() => '')) || '';
      if (/disabled/i.test(cls)) return false;
      return /actived|active|enabled/i.test(cls) || !/disabled/i.test(cls);
    }

    for (let i = 0; i < 3; i++) {
      if (await entrarHabilitado()) break;            // ja pode entrar -> nao mexe mais
      await chkSpan.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Entrar: e uma <div class="button">, nao <button>.
    await page.waitForTimeout(300);
    const okEntrar = await entrar.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (okEntrar) {
      await entrar.click({ timeout: 10000 }).catch(() => {});
    } else {
      await page.getByText('Entrar', { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
    }

    // Aguarda voltar pro delivers logado.
    await page.waitForURL(/entrega\.99app\.com\/v2\/delivers/, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    log('   🔑 auto-login submetido');
    return true;
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

  const tentou = await fazerLogin99(page, log);
  if (!tentou) return false;

  // Reconfirma no delivers.
  try {
    await page.goto(DELIVERS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (_) {}
  return await temMarcadoresLogado(page);
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
  return await page.evaluate(() => {
    const res = [];
    const table = document.querySelector('table');
    if (!table) return res;
    const ths = Array.from(table.querySelectorAll('thead th')).map(t => (t.textContent || '').trim());
    // coluna "ID do pedido externo" = nossa OS
    let idx = ths.findIndex(t => /externo/i.test(t));
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    rows.forEach((tr, i) => {
      const temMsg = Array.from(tr.querySelectorAll('button, a, span'))
        .some(el => (el.textContent || '').trim() === 'Mensagem');
      if (!temMsg) return;
      const tds = Array.from(tr.querySelectorAll('td'));
      let os = (idx >= 0 && tds[idx]) ? (tds[idx].textContent || '').trim() : '';
      if (!os) { // fallback: primeiro td que parece OS numerica de 6-8 digitos
        for (const td of tds) { const t = (td.textContent || '').trim(); if (/^\d{6,8}$/.test(t)) { os = t; break; } }
      }
      res.push({ i, os });
    });
    return res;
  });
}

// Processa UMA linha: abre o chat pelo botao da propria linha (sem re-filtrar
// por OS), captura bolhas e drena a outbox.
async function processarLinha(page, pool, linha, log) {
  const tr = page.locator('tbody tr').nth(linha.i);
  const btn = tr.getByText('Mensagem', { exact: true }).first();
  const ok = await btn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!ok) { log(`   OS ${linha.os}: botao Mensagem sumiu`); return; }
  await btn.click({ timeout: 10000 });
  const abriu = await page.locator('.chat__window').first()
    .waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (!abriu) { log(`   OS ${linha.os}: chat nao abriu`); return; }
  await page.waitForTimeout(800);
  const info = await extrairInfoMotoboy(page);
  const conversaId = await upsertConversa(pool, linha.os, info);
  const bolhas = await extrairBolhas(page);
  const novas = await gravarNovas(pool, conversaId, bolhas);
  if (novas > 0) log(`   \u{1F4AC} OS ${linha.os}: ${novas} nova(s) do motoboy`);
  await drenarOutbox(page, pool, conversaId, log);
  await fecharChat(page);
  await page.waitForTimeout(400);
}


// ── Filtra por OS e abre o chat. Retorna true se o chat abriu. ────────────
async function abrirChatDaOS(page, os, log) {
  // 1) limpa e preenche o filtro "ID do pedido externo"
  const filtro = page.locator('input[placeholder="ID do pedido externo"]').first();
  await filtro.click({ timeout: 15000 });
  await filtro.fill('');
  await filtro.fill(String(os));

  // 2) Pesquisar
  await page.locator('button:has-text("Pesquisar")').first().click({ timeout: 15000 });
  await page.waitForTimeout(2500); // deixa a tabela recarregar

  // 3) acha a linha da OS e o botao "Mensagem"
  const linha = page.locator('tr', { hasText: String(os) }).first();
  const temLinha = await linha.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!temLinha) { log(`   OS ${os}: linha não encontrada na 99`); return false; }

  const btnMsg = linha.getByText('Mensagem', { exact: true }).first();
  const temMsg = await btnMsg.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!temMsg) { log(`   OS ${os}: sem botão Mensagem (aguardando aceite)`); return false; }

  await btnMsg.click({ timeout: 10000 });
  const abriu = await page.locator('.chat__window').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  return abriu;
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

// ── Extrai as bolhas do chat (tolerante a content_ vs content__) ──────────
async function extrairBolhas(page) {
  return await page.evaluate(() => {
    const janela = document.querySelector('.chat__window');
    if (!janela) return [];
    const msgEls = Array.from(janela.querySelectorAll('[class*="msg_"]'))
      .filter(el => /(?:^|\s)msg_\d+/.test(el.className || '') && /content/.test(el.className || ''));
    const out = [];
    for (const el of msgEls) {
      const m = String(el.className).match(/msg_(\d+)/);
      const msgId = m ? m[1] : null;
      if (!msgId) continue;
      const li = el.closest('li') || el.parentElement;
      const box = el.closest('[class*="box"]') || li || el;
      const isSelf = /isSelf/.test((box && box.className) || '') ||
                     (li && !!li.querySelector('[class*="isSelf"]'));
      let horario = '';
      if (li) {
        const times = Array.from(li.querySelectorAll('[class*="content_time"], [class*="content__time"]'))
          .filter(t => (t.style.display || '') !== 'none' && t.textContent.trim());
        if (times.length) horario = times[times.length - 1].textContent.trim();
      }
      const lido = li ? !!li.querySelector('[class*="isread"][class*="read"], [class*="isread"].read') : false;
      const imgEl = el.querySelector('img');
      const img = imgEl && imgEl.src ? imgEl.src : null;
      const texto = (el.textContent || '').trim();
      out.push({ msgId, direcao: isSelf ? 'out' : 'in', texto, img, horario, lido });
    }
    return out;
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
      ON CONFLICT (conversa_id, msg_99_id) DO NOTHING
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
async function enviarNaJanela(page, texto) {
  const partes = [];
  let resto = String(texto);
  while (resto.length > LIMITE_99) { partes.push(resto.slice(0, LIMITE_99)); resto = resto.slice(LIMITE_99); }
  if (resto) partes.push(resto);

  const input = page.locator('.chat__window textarea').first();
  const btnEnviar = page.locator('.chat__window').getByRole('button', { name: 'Enviar' }).last();

  for (const parte of partes) {
    await input.click({ timeout: 10000 });
    await input.fill(parte);
    await page.waitForTimeout(300);
    await btnEnviar.click({ timeout: 10000 });
    await page.waitForTimeout(900);
  }
}

// ── Drena a outbox (out + pendente) da conversa ───────────────────────────
async function drenarOutbox(page, pool, conversaId, log) {
  const { rows } = await pool.query(`
    SELECT id, texto FROM chat99_mensagens
    WHERE conversa_id = $1 AND direcao = 'out' AND status_envio = 'pendente'
    ORDER BY id ASC
  `, [conversaId]);

  for (const msg of rows) {
    await pool.query(`UPDATE chat99_mensagens SET status_envio='enviando' WHERE id=$1`, [msg.id]);
    try {
      await enviarNaJanela(page, msg.texto || '');
      await pool.query(`UPDATE chat99_mensagens SET status_envio='enviada', enviado_em=now() WHERE id=$1`, [msg.id]);
      log(`   ✉️ enviada msg #${msg.id}`);
    } catch (e) {
      await pool.query(`UPDATE chat99_mensagens SET status_envio='erro', erro_envio=$2 WHERE id=$1`, [msg.id, String(e.message).slice(0, 300)]);
      log(`   ❌ falha ao enviar msg #${msg.id}: ${e.message}`);
    }
  }
}

async function fecharChat(page) {
  try {
    const x = page.locator('.chat__window [class*="nav-bar"] [class*="close"], .chat__window [class*="nav-bar"] i').first();
    if (await x.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) { await x.click({ timeout: 3000 }); return; }
  } catch (_) {}
  await page.keyboard.press('Escape').catch(() => {});
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

// ── Processa 1 conversa (serial) ──────────────────────────────────────────
async function processarConversa(page, pool, os, log) {
  const abriu = await abrirChatDaOS(page, os, log);
  if (!abriu) {
    // Aguardando aceite (ou linha ausente): registra varredura mas não zera nada.
    await marcarVarredura(pool, os);
    return;
  }
  await page.waitForTimeout(800); // deixa as bolhas renderizarem
  const info = await extrairInfoMotoboy(page);
  const conversaId = await upsertConversa(pool, os, info);
  const bolhas = await extrairBolhas(page);
  const novas = await gravarNovas(pool, conversaId, bolhas);
  if (novas > 0) log(`   💬 OS ${os}: ${novas} nova(s) do motoboy`);
  await drenarOutbox(page, pool, conversaId, log);
  await fecharChat(page);
  await page.waitForTimeout(500);
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
    // Migration idempotente (garante tabelas mesmo se o backend principal ainda
    // não rodou — os dois serviços compartilham o mesmo Neon).
    if (!_tabelasOk) {
      await initChat99Tables(pool).catch(e => ctx.log(`⚠️ initChat99Tables: ${e.message}`));
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
        nome: 'chat99-global', launchOpts: CHAT99_LAUNCH_OPTS,
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

        // VARREDURA UNICA: le a aba "Em andamento" da 99 e processa so as linhas
        // com botao "Mensagem" (corrida aceita). Pagina a pagina, com orcamento
        // de tempo pra nao passar do reaper (3min).
        const MAX_PAGINAS = Number(process.env.CHAT99_MAX_PAGINAS || 10);
        const BUDGET_MS = Number(process.env.CHAT99_TICK_BUDGET_MS || 140000);
        const inicioTick = Date.now();
        let processadas = 0, totalComChat = 0, pagina = 1;

        while (pagina <= MAX_PAGINAS) {
          if (ctx.ehParaParar() || (Date.now() - inicioTick) > BUDGET_MS) break;
          await page.waitForTimeout(1200); // deixa a tabela renderizar
          const linhas = await coletarLinhasPagina(page);
          totalComChat += linhas.length;
          if (pagina === 1 && linhas.length === 0) ctx.log('nenhuma corrida 99 com chat ativo');

          for (const linha of linhas) {
            if (ctx.ehParaParar() || (Date.now() - inicioTick) > BUDGET_MS) break;
            try {
              await processarLinha(page, pool, linha, ctx.log);
              processadas++;
            } catch (e) {
              ctx.log(`❌ OS ${linha.os}: ${e.message}`);
              await fecharChat(page).catch(() => {});
            }
          }

          // proxima pagina (Ant): para se o botao "next" estiver desabilitado
          const next = page.locator('.ant-pagination-next').first();
          const cls = (await next.getAttribute('class').catch(() => '')) || '';
          const ariaDis = (await next.getAttribute('aria-disabled').catch(() => '')) || '';
          if (cls.includes('disabled') || ariaDis === 'true') break;
          await next.click({ timeout: 5000 }).catch(() => {});
          pagina++;
        }
        ctx.log(`🔎 varredura: ${totalComChat} corrida(s) com chat, ${processadas} processada(s)`);
      } finally {
        await page.close().catch(() => {});
      }
    }, contextOpts);
  },
});
