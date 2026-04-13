'use strict';

/**
 * sla-detector.service.js
 *
 * Detector de OS novas no MAP via endpoint viewServicoAcompanhamento.
 * Substitui a extensão Chrome SLA Monitor v8.0 (que dependia do operador).
 *
 * Fluxo:
 *   1. Carrega storageState do Playwright (/tmp/tutts-sla-session.json)
 *   2. Lê payload JSON capturado em runtime do META_FILE
 *      (/tmp/tutts-sla-meta.json — gerado pelo playwright-sla-capture
 *      via interceptação de network durante o login).
 *   3. Atualiza o campo `sessaoAtual` do payload com PHPSESSID corrente
 *   4. POST application/json no endpoint via playwright.request.newContext
 *      (não usar node fetch — sessão depende de cookies + UA)
 *   5. Parse do JSON de resposta — extrai OS de retornoMultiplos["5"]
 *   6. Filtra clientes ativos em rastreio_clientes_config
 *   7. INSERT ON CONFLICT DO NOTHING em sla_capturas
 *   8. Worker existente (sla-capture-worker) captura pontos via Playwright
 *      e envia WhatsApp
 *
 * 🔧 HISTÓRICO DE FIXES (2026-04-13):
 *   1. Antes usava node-fetch direto com header Cookie montado manualmente
 *      e User-Agent "Tutts-Detector/1.0" — não funcionava por session pinning.
 *      Agora usa playwright.request.newContext({ storageState }).
 *
 *   2. Antes mandava form-urlencoded com payload hardcoded (idFuncionario=65,
 *      ~27 campos). O endpoint na verdade espera application/json com ~40+
 *      campos incluindo dadosQuery, sessaoAtual, HTTP_HOST, timezone, etc.
 *      Agora o payload completo é capturado em runtime pelo
 *      playwright-sla-capture interceptando o XHR real do navegador.
 *
 *   3. Antes esperava resposta em HTML com regex `<tr data-order-id=>`.
 *      O endpoint retorna JSON. Agora parseia JSON e itera retornoMultiplos.
 */

const fs = require('fs');
const { chromium, request: playwrightRequest } = require('playwright');

const SESSION_FILE = '/tmp/tutts-sla-session.json';
const META_FILE = '/tmp/tutts-sla-meta.json';
const MAP_BASE = 'https://tutts.com.br/expresso/expressoat';
const ENDPOINT = `${MAP_BASE}/entregasDia/acompanhamento/ajax/viewServicoAcompanhamento`;
const REFERER = `${MAP_BASE}/acompanhamento-servicos`;

// 🔬 Debug — ativado por padrão durante troubleshooting do detector.
// Pra desativar depois que o pipeline estabilizar, setar SLA_DETECTOR_DEBUG=false
const DEBUG_HTTP = process.env.SLA_DETECTOR_DEBUG !== 'false';
const DEBUG_DUMP_FILE = '/tmp/sla-detector-last.json';

function log(msg) {
  console.log(`[sla-detector] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Cache de config (TTL 60s) — lê de rastreio_clientes_config
// ─────────────────────────────────────────────────────────────────────────
let _configCache = null;
let _configExpira = 0;

async function carregarConfig(pool) {
  const agora = Date.now();
  if (_configCache && agora < _configExpira) return _configCache;
  try {
    const { rows } = await pool.query(
      'SELECT cliente_cod, termos_filtro FROM rastreio_clientes_config WHERE ativo = TRUE'
    );
    _configCache = rows.map(r => ({
      cliente_cod: String(r.cliente_cod),
      termos_filtro: Array.isArray(r.termos_filtro)
        ? r.termos_filtro.map(t => String(t).toUpperCase())
        : null,
    }));
    _configExpira = agora + 60_000;
    return _configCache;
  } catch (e) {
    log('⚠️ Falha lendo config, usando cache antigo: ' + e.message);
    return _configCache || [];
  }
}

function invalidarCacheConfig() { _configCache = null; _configExpira = 0; }

// ─────────────────────────────────────────────────────────────────────────
// PAYLOAD JSON — montagem a partir do meta capturado em runtime
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lê o PHPSESSID atual do storageState do Playwright.
 * Usado pra atualizar o campo `sessaoAtual` do payload JSON em runtime,
 * porque o valor capturado no META_FILE pode estar stale após relogin.
 */
function lerPhpSessIdAtual() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
    const phpSess = cookies.find(c => c.name === 'PHPSESSID');
    return phpSess ? phpSess.value : null;
  } catch (_) {
    return null;
  }
}

/**
 * Lê a URL exata do endpoint capturado em runtime (META_FILE).
 * Permite que o sistema mude a URL sem precisar deploy.
 */
function obterEndpointUrl() {
  try {
    if (!fs.existsSync(META_FILE)) return ENDPOINT;
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    if (meta && typeof meta.url === 'string' && meta.url.length > 0) {
      return meta.url;
    }
  } catch (_) {}
  return ENDPOINT;
}

/**
 * Monta o body JSON do POST pro endpoint viewServicoAcompanhamento.
 *
 * Lê o META_FILE (payload capturado em runtime pelo playwright-sla-capture)
 * e atualiza:
 *   - `sessaoAtual` com o PHPSESSID corrente
 *   - `offset` / `pagina` para paginação (limite preservado do meta)
 *
 * 🔧 FIX (2026-04-13): Inicialmente eu sobrescrevia `limite` pra 200 tentando
 * reduzir requisições, mas o servidor PHP do tutts.com.br parece validar que
 * o `limite` no body bate com o que a sessão "autorizou" quando o usuário
 * clicou na aba — qualquer valor diferente faz o parse JSON falhar (servidor
 * retorna HTML de erro). Então agora preservamos o `limite` original (tipicamente
 * 10) e paginamos só por offset. É mais requisições mas funciona.
 *
 * @param {Object} opts
 * @param {number} opts.offset - deslocamento (default 0)
 * @returns {Object} { bodyJson: string, limite: number }
 */
function montarPayload({ offset = 0 } = {}) {
  if (!fs.existsSync(META_FILE)) {
    throw new Error(
      `META_FILE ausente em ${META_FILE} — execute garantirSessao() pelo menos uma vez`
    );
  }

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`META_FILE corrompido: ${e.message}`);
  }
  if (!meta || typeof meta.postData !== 'string' || meta.postData.length === 0) {
    throw new Error('META_FILE sem postData válido');
  }

  // Aviso se o meta tá muito velho
  if (meta.capturedAt) {
    const idadeHoras = Math.floor(
      (Date.now() - new Date(meta.capturedAt).getTime()) / 3_600_000
    );
    if (idadeHoras > 24) {
      log(`⚠️ Meta de payload tem ${idadeHoras}h — pode estar desatualizado`);
    }
  }

  // Parse do payload JSON
  let payload;
  try {
    payload = JSON.parse(meta.postData);
  } catch (e) {
    throw new Error(`postData no META_FILE não é JSON válido: ${e.message}`);
  }

  // Atualiza sessaoAtual com PHPSESSID corrente
  const phpSessIdAtual = lerPhpSessIdAtual();
  if (phpSessIdAtual && payload.sessaoAtual !== phpSessIdAtual) {
    if (DEBUG_HTTP) {
      log(`🔄 Atualizando sessaoAtual: ${payload.sessaoAtual} → ${phpSessIdAtual}`);
    }
    payload.sessaoAtual = phpSessIdAtual;
  }

  // Preserva o limite original do meta (não sobrescrever — o servidor valida)
  const limite = parseInt(payload.limite, 10) || 10;

  // Atualiza só offset e pagina pra navegar entre páginas
  payload.offset = offset;
  payload.pagina = Math.floor(offset / limite);

  return { bodyJson: JSON.stringify(payload), limite };
}

// ─────────────────────────────────────────────────────────────────────────
// FETCH — POST application/json e parse da resposta
// ─────────────────────────────────────────────────────────────────────────

/**
 * Faz UMA requisição ao endpoint — uma página.
 * Usado por fetchAllPages em loop.
 *
 * Retorna também o `limite` efetivamente usado (lido do meta),
 * pra que fetchAllPages saiba quanto avançar no offset.
 */
async function fetchPage({ offset = 0 } = {}) {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Sessão Playwright não encontrada em ${SESSION_FILE}`);
  }

  // Validação rápida do storageState
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
    if (cookies.length === 0) throw new Error('Arquivo de sessão sem cookies');
  } catch (e) {
    if (e.message.includes('Arquivo de sessão')) throw e;
    throw new Error(`storageState inválido: ${e.message}`);
  }

  const { bodyJson, limite } = montarPayload({ offset });
  const endpointUrl = obterEndpointUrl();

  let ctx;
  try {
    ctx = await playwrightRequest.newContext({
      storageState: SESSION_FILE,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': REFERER,
        'Origin': 'https://tutts.com.br',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    });

    const resp = await ctx.post(endpointUrl, {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
      },
      data: bodyJson,
      maxRedirects: 0,
      failOnStatusCode: false,
      timeout: 30_000,
    });

    const statusCode = resp.status();
    const respHeaders = resp.headers();
    const rawText = await resp.text();

    let data = null;
    let parseErr = null;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      parseErr = e.message;
    }

    // 🔬 Debug rico — loga header + body raw quando parse falha
    // Também dumpa em arquivo pra inspecionar via /debug/ultimo-html
    if (parseErr || DEBUG_HTTP) {
      try {
        const dumpPath = parseErr ? DEBUG_DUMP_FILE : DEBUG_DUMP_FILE;
        fs.writeFileSync(dumpPath, rawText, 'utf8');
      } catch (_) {}
    }
    if (parseErr) {
      log(`❌ [offset=${offset}] HTTP ${statusCode} | bytes=${rawText.length} | ct=${respHeaders['content-type'] || '(none)'}`);
      log(`❌ parseErr: ${parseErr}`);
      const preview = rawText.slice(0, 500).replace(/\s+/g, ' ').trim();
      log(`❌ raw preview: ${preview || '(vazio)'}`);
      // Dumpa headers completos pra ajudar no diagnóstico
      const headerList = Object.entries(respHeaders)
        .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
        .join(' | ');
      log(`❌ headers: ${headerList}`);
    }

    return { ok: resp.ok(), data, statusCode, rawText, parseErr, limite };
  } finally {
    if (ctx) {
      try { await ctx.dispose(); } catch (_) {}
    }
  }
}

/**
 * Fetch paginado usando browser real (Chromium) + page.evaluate(fetch).
 *
 * 🔧 FIX (2026-04-13): A versão anterior usava `playwright.request.newContext`
 * (HTTP puro sem browser). O servidor PHP do tutts.com.br retorna HTML em vez
 * de JSON quando o request não tem os headers Sec-Fetch-* automáticos do
 * browser, e replicar esses headers manualmente é frágil.
 *
 * Solução: abrir Chromium uma vez por tick, navegar pra página de
 * acompanhamento (pro origin/referer ficarem corretos), e fazer todos os
 * fetches via `page.evaluate(fetch(...))`. Assim o request sai literalmente
 * do JavaScript da página com TODOS os headers automáticos.
 *
 * Custo: ~2s pra abrir browser + ~300ms por página HTTP. Pra 30 páginas =
 * ~12s total. Dentro do budget de 90s e do cron de 2min.
 *
 * Critérios de parada:
 *   1. Página retornou < limite OS → última página
 *   2. Já coletou >= totalEsperado
 *   3. Sessão expirada → aborta e sinaliza relogin
 *   4. HTTP error ou parse error → aborta com o que tem
 *   5. Timeout total de 90s
 *   6. MAX_PAGINAS_SANITY = 1000 (proteção absoluta)
 */
async function fetchAllPages() {
  const TEMPO_MAX_MS = 90_000;
  const MAX_PAGINAS_SANITY = 1000;

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Sessão Playwright não encontrada em ${SESSION_FILE}`);
  }

  // Validação rápida do storageState
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
    if (cookies.length === 0) throw new Error('Arquivo de sessão sem cookies');
    if (DEBUG_HTTP) {
      const tuttsCookies = cookies.filter(c => c.domain && c.domain.includes('tutts.com.br'));
      log(`🔎 storageState: ${cookies.length} cookies (${tuttsCookies.length} de tutts)`);
    }
  } catch (e) {
    if (e.message.includes('Arquivo de sessão')) throw e;
    throw new Error(`storageState inválido: ${e.message}`);
  }

  const todasOs = [];
  let paginas = 0;
  let ultimoStatus = null;
  let ultimaResposta = null;
  let totalEsperado = null;
  let limiteReal = null;
  let offsetAtual = 0;
  const t0 = Date.now();

  let browser, context, page;
  try {
    if (DEBUG_HTTP) log(`🌐 Abrindo Chromium pra fetchAllPages...`);
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    context = await browser.newContext({
      storageState: SESSION_FILE,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // Navega pra página de acompanhamento — isso garante:
    //   - Origin/Referer corretos pra qualquer fetch posterior
    //   - Sessão PHP "ativa" (algumas versões marcam timestamp no $_SESSION)
    //   - Cookies de tracking/analytics atualizados
    if (DEBUG_HTTP) log(`🧭 Navegando pra ${REFERER}`);
    await page.goto(REFERER, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(500);

    // Loop de paginação — cada iteração faz 1 fetch via page.evaluate
    for (let pagina = 0; pagina < MAX_PAGINAS_SANITY; pagina++) {
      if (Date.now() - t0 > TEMPO_MAX_MS) {
        log(`⏱️  Timeout de ${TEMPO_MAX_MS}ms estourado — abortando com ${todasOs.length} OS coletadas`);
        break;
      }

      const { bodyJson, limite } = montarPayload({ offset: offsetAtual });

      if (limiteReal == null) {
        limiteReal = limite;
        if (DEBUG_HTTP) log(`📏 Limite ditado pelo meta: ${limiteReal} por página`);
      }

      // 🔑 CHAVE: fetch dentro do JS da página, não via HTTP puro.
      // Headers Sec-Fetch-* + cookies + credentials são automáticos.
      const result = await page.evaluate(
        async ({ url, body }) => {
          try {
            const resp = await fetch(url, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body,
            });
            const text = await resp.text();
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            return { ok: resp.ok, status: resp.status, headers, text };
          } catch (e) {
            return { error: e.message };
          }
        },
        { url: ENDPOINT, body: bodyJson }
      );

      paginas++;

      if (result.error) {
        log(`⚠️ Página ${pagina + 1}: erro no fetch: ${result.error}`);
        break;
      }

      ultimoStatus = result.status;

      // Parse JSON
      let data = null;
      let parseErr = null;
      try {
        data = JSON.parse(result.text);
      } catch (e) {
        parseErr = e.message;
      }
      ultimaResposta = data;

      // Debug rico se houver erro
      if (parseErr || (DEBUG_HTTP && pagina === 0)) {
        try {
          fs.writeFileSync(DEBUG_DUMP_FILE, result.text, 'utf8');
        } catch (_) {}
      }
      if (parseErr) {
        log(`❌ [offset=${offsetAtual}] HTTP ${result.status} | bytes=${result.text.length} | ct=${result.headers['content-type'] || '(none)'}`);
        log(`❌ parseErr: ${parseErr}`);
        const preview = result.text.slice(0, 500).replace(/\s+/g, ' ').trim();
        log(`❌ raw preview: ${preview || '(vazio)'}`);
        log(`⚠️ Página ${pagina + 1}: JSON parse falhou — abortando`);
        break;
      }

      if (!result.ok) {
        log(`⚠️ Página ${pagina + 1}: HTTP ${result.status} — abortando`);
        break;
      }

      // Primeira página: pega totalEsperado
      if (pagina === 0) {
        const qtdCampo = data?.retornoMultiplos?.['4']?.[0]?.quantidade;
        if (qtdCampo != null) {
          totalEsperado = parseInt(qtdCampo, 10);
          if (DEBUG_HTTP) log(`📄 Total esperado segundo servidor: ${totalEsperado}`);
        }
      }

      if (ehSessaoExpirada(data)) {
        if (DEBUG_HTTP) log(`🔑 Página ${pagina + 1}: sessão expirada`);
        return {
          ok: false,
          data,
          statusCode: result.status,
          paginas,
          totalColetado: todasOs.length,
          sessaoExpirada: true,
        };
      }

      const lista = Array.isArray(data?.retornoMultiplos?.['5'])
        ? data.retornoMultiplos['5']
        : [];

      if (DEBUG_HTTP) {
        log(`📄 Página ${pagina + 1} (offset=${offsetAtual}): +${lista.length} OS (acumulado: ${todasOs.length + lista.length}${totalEsperado != null ? `/${totalEsperado}` : ''})`);
      }

      todasOs.push(...lista);

      // Critérios de parada
      if (lista.length < limiteReal) break;
      if (totalEsperado != null && todasOs.length >= totalEsperado) break;
      if (lista.length === 0) {
        log(`⚠️ Página ${pagina + 1} veio vazia inesperadamente — abortando`);
        break;
      }

      offsetAtual += limiteReal;
    }

    if (paginas >= MAX_PAGINAS_SANITY) {
      log(`🚨 BUG: bateu ${MAX_PAGINAS_SANITY} páginas — provável loop infinito`);
    }
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
  }

  const dataAgregada = ultimaResposta
    ? { ...ultimaResposta, retornoMultiplos: { ...ultimaResposta.retornoMultiplos, '5': todasOs } }
    : { retornoMultiplos: { '5': todasOs } };

  const duracaoMs = Date.now() - t0;
  if (DEBUG_HTTP) {
    log(`✅ Paginação concluída: ${todasOs.length} OS em ${paginas} página(s) de ${limiteReal || '?'} (${duracaoMs}ms)`);
  }

  return {
    ok: true,
    data: dataAgregada,
    statusCode: ultimoStatus || 200,
    paginas,
    totalColetado: todasOs.length,
    totalEsperado,
    duracaoMs,
    limiteReal,
  };
}

/**
 * @deprecated mantido só pra compatibilidade. Use fetchAllPages().
 */
async function fetchData() {
  return fetchAllPages();
}

// ─────────────────────────────────────────────────────────────────────────
// PARSER JSON — extrai OS do retornoMultiplos["5"]
// ─────────────────────────────────────────────────────────────────────────

/**
 * Verifica se a resposta indica sessão expirada / não-autenticada.
 */
function ehSessaoExpirada(data) {
  if (!data || typeof data !== 'object') return true;
  if (data.erro && /sess[aã]o|login|autentic/i.test(String(data.erro))) return true;
  if (data.redirect && /login/i.test(String(data.redirect))) return true;
  if (!data.retornoMultiplos || typeof data.retornoMultiplos !== 'object') return true;
  return false;
}

/**
 * Extrai as OS do JSON de resposta.
 *
 * Estrutura observada:
 *   data.retornoMultiplos["5"] = [
 *     {
 *       "s.id": "1126214",            ← os_numero
 *       "s.idSolicitante": "767",     ← cliente_cod
 *       "s.idMotoboy": "9055",        ← cod_profissional
 *       "cc.descricao": "BR Autoparts Goiânia",
 *       "so.empresa": "Pellegrino/...",
 *       "m.nome": "Leonardo Vaz...",
 *       "s.numeroPedido": "211048",
 *       ...
 *     },
 *     ...
 *   ]
 *
 * Para o filtro `_balloon`, sintetiza uma string concatenando todos os
 * valores string do objeto da OS — assim `termos_filtro` continua
 * funcionando para qualquer termo que apareça em qualquer campo.
 */
function parseOsDoJson(data) {
  const ordens = [];
  const lista = Array.isArray(data?.retornoMultiplos?.['5'])
    ? data.retornoMultiplos['5']
    : [];

  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;

    const osNumero = String(item['s.id'] || '').trim();
    if (!osNumero) continue;

    const clienteCod = String(item['s.idSolicitante'] || '').trim() || null;
    const codProfissional = String(item['s.idMotoboy'] || '').trim() || null;

    // Sintetiza um "_balloon" concatenando todos os valores string do item
    // pra que o filtro por termos continue funcionando
    const balloonParts = [];
    for (const v of Object.values(item)) {
      if (v == null) continue;
      if (typeof v === 'string' || typeof v === 'number') {
        balloonParts.push(String(v));
      }
    }
    const balloonText = balloonParts.join(' | ').toUpperCase();

    ordens.push({
      os_numero: osNumero,
      cliente_cod: clienteCod,
      cod_rastreio: null, // não vem nesse endpoint, capture worker pega depois
      cod_profissional: codProfissional,
      _balloon: balloonText,
    });
  }

  return ordens;
}

function filtrarMonitorados(ordens, config) {
  return ordens.filter(o => {
    if (!o.cliente_cod) return false;
    const cfg = config.find(c => c.cliente_cod === o.cliente_cod);
    if (!cfg) return false;
    if (!cfg.termos_filtro || cfg.termos_filtro.length === 0) return true;
    const balloonUpper = (o._balloon || '').toUpperCase();
    return cfg.termos_filtro.some(termo => balloonUpper.includes(termo));
  });
}

async function inserirNaFila(pool, ordens) {
  let inseridas = 0;
  let ignoradas = 0;

  for (const o of ordens) {
    try {
      const result = await pool.query(
        `INSERT INTO sla_capturas (os_numero, cliente_cod, cod_rastreio, profissional, status, criado_em)
         VALUES ($1, $2, $3, $4, 'pendente', NOW())
         ON CONFLICT (os_numero) DO NOTHING
         RETURNING id`,
        [o.os_numero, o.cliente_cod, o.cod_rastreio || null, o.cod_profissional || null]
      );
      if (result.rowCount > 0) {
        inseridas++;
        log(`✅ Enfileirada OS ${o.os_numero} (cliente ${o.cliente_cod})`);
      } else {
        ignoradas++;
      }
    } catch (err) {
      log(`⚠️ Erro ao inserir OS ${o.os_numero}: ${err.message}`);
    }
  }

  return { inseridas, ignoradas };
}

// ─────────────────────────────────────────────────────────────────────────
// Função principal
// ─────────────────────────────────────────────────────────────────────────

async function detectarOsNovas(pool) {
  try {
    const result = await fetchAllPages();

    // fetchAllPages pode retornar sessaoExpirada direto
    if (result.sessaoExpirada) {
      log('🔑 Sessão expirada detectada durante paginação — relogin necessário');
      return { ok: false, sessaoExpirada: true, motivo: 'sessao_expirada' };
    }

    const { ok, data, statusCode, paginas, totalColetado, totalEsperado } = result;

    if (!ok && statusCode !== 200) {
      log(`⚠️ HTTP ${statusCode} no fetch`);
      const sessaoExpirada = [401, 403, 302].includes(statusCode);
      return { ok: false, sessaoExpirada, motivo: `http_${statusCode}` };
    }

    if (ehSessaoExpirada(data)) {
      log('🔑 Sessão expirada (ou resposta inválida) — relogin necessário');
      return { ok: false, sessaoExpirada: true, motivo: 'sessao_expirada' };
    }

    const ordens = parseOsDoJson(data);
    const config = await carregarConfig(pool);
    const monitoradas = filtrarMonitorados(ordens, config);
    const { inseridas, ignoradas } = await inserirNaFila(pool, monitoradas);

    log(`📊 ${ordens.length} OS (${paginas}p${totalEsperado != null ? `, esperado=${totalEsperado}` : ''}) | ${monitoradas.length} monitoradas | ${inseridas} novas, ${ignoradas} já conhecidas`);

    return {
      ok: true,
      sessaoExpirada: false,
      total: ordens.length,
      paginas,
      totalEsperado,
      monitoradas: monitoradas.length,
      inseridas,
      ignoradas,
    };
  } catch (err) {
    log(`❌ Erro no detector: ${err.message}`);
    const isSessaoFaltando =
      err.message.includes('Sessão Playwright não encontrada') ||
      err.message.includes('Arquivo de sessão sem cookies') ||
      err.message.includes('META_FILE ausente') ||
      err.message.includes('META_FILE corrompido') ||
      err.message.includes('META_FILE sem postData') ||
      err.message.includes('postData no META_FILE não é JSON') ||
      err.message.includes('ENOENT');
    return {
      ok: false,
      sessaoExpirada: isSessaoFaltando,
      motivo: err.message,
    };
  }
}

module.exports = {
  detectarOsNovas,
  invalidarCacheConfig,
  // expostos pra testes unitários
  _internal: {
    parseOsDoJson,
    filtrarMonitorados,
    ehSessaoExpirada,
    montarPayload,
    obterEndpointUrl,
    lerPhpSessIdAtual,
  },
};
