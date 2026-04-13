'use strict';

/**
 * sla-detector.service.js
 *
 * Detector de OS novas no MAP via endpoint viewServicoAcompanhamento.
 * Substitui a extensão Chrome SLA Monitor v8.0 (que dependia do operador).
 *
 * Fluxo:
 *   1. Carrega storageState do Playwright (/tmp/tutts-sla-session.json)
 *   2. POST no endpoint AJAX usando playwright.request (NÃO node fetch) —
 *      isso garante que TODA a sessão Playwright (cookies httpOnly, UA,
 *      session pinning por User-Agent etc.) seja replicada fielmente.
 *   3. Parse regex pra extrair OS + cliente_cod + cod_rastreio
 *   4. Filtra clientes ativos em rastreio_clientes_config
 *   5. INSERT ON CONFLICT DO NOTHING em sla_capturas
 *   6. Worker existente captura pontos via Playwright e envia WhatsApp
 *
 * Auto-relogin: se a resposta vier como HTML de login OU se o arquivo de
 * sessão estiver ausente/inválido, sinaliza sessaoExpirada=true pra que o
 * caller (worker) dispare relogin via playwright-sla-capture.
 *
 * 🔧 FIX (2026-04): Antes usava node-fetch direto com header Cookie montado
 *     manualmente — não funcionava porque o tutts.com.br faz session pinning
 *     por User-Agent e o detector usava UA "Tutts-Detector/1.0". Agora usa
 *     playwright.request.newContext({ storageState }) que preserva tudo.
 */

const fs = require('fs');
const { request: playwrightRequest } = require('playwright');

const SESSION_FILE = '/tmp/tutts-sla-session.json';
const META_FILE = '/tmp/tutts-sla-meta.json';  // 🆕 payload capturado pelo playwright-sla-capture
const MAP_BASE = 'https://tutts.com.br/expresso/expressoat';
const ENDPOINT = `${MAP_BASE}/entregasDia/acompanhamento/ajax/viewServicoAcompanhamento`;
const REFERER = `${MAP_BASE}/acompanhamento-servicos`;

// 🔬 Debug — ativado por padrão durante troubleshooting do detector.
// Pra desativar depois que o pipeline estabilizar, setar SLA_DETECTOR_DEBUG=false
const DEBUG_HTTP = process.env.SLA_DETECTOR_DEBUG !== 'false';
const DEBUG_DUMP_FILE = '/tmp/sla-detector-last.html';

function log(msg) {
  console.log(`[sla-detector] ${msg}`);
}

// Cache de config (TTL 60s) - lê de rastreio_clientes_config
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
      termos_filtro: Array.isArray(r.termos_filtro) ? r.termos_filtro.map(t => String(t).toUpperCase()) : null,
    }));
    _configExpira = agora + 60_000;
    return _configCache;
  } catch (e) {
    log('⚠️ Falha lendo config, usando cache antigo: ' + e.message);
    return _configCache || [];
  }
}
function invalidarCacheConfig() { _configCache = null; _configExpira = 0; }


/**
 * Retorna a URL do endpoint AJAX a usar no fetch.
 * Prefere a URL capturada em runtime (META_FILE) sobre a hardcoded.
 */
function obterEndpointUrl() {
  if (fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta && typeof meta.url === 'string' && meta.url.includes('tutts.com.br')) {
        return meta.url;
      }
    } catch (_) {}
  }
  return ENDPOINT;
}

async function fetchHtml() {
  // 🔧 FIX: usa playwright.request.newContext em vez de node fetch.
  // Isso carrega o storageState completo (cookies httpOnly, secure, etc.)
  // E o Playwright internamente usa o mesmo User-Agent que usaria num browser
  // real, evitando session pinning por UA do tutts.com.br.

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Sessão Playwright não encontrada em ${SESSION_FILE}`);
  }

  // Validação rápida do storageState + log de debug dos cookies
  let cookieNames = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
    if (cookies.length === 0) throw new Error('Arquivo de sessão sem cookies');
    cookieNames = cookies
      .filter(c => c.domain && c.domain.includes('tutts.com.br'))
      .map(c => `${c.name}@${c.domain}`);
    if (DEBUG_HTTP) {
      log(`🔎 storageState: ${cookies.length} cookies totais, ${cookieNames.length} de tutts`);
      log(`🔎 cookies tutts: ${cookieNames.join(', ') || '(nenhum!)'}`);
    }
  } catch (e) {
    if (e.message.includes('Arquivo de sessão')) throw e;
    throw new Error(`storageState inválido: ${e.message}`);
  }

  const body = montarPayload();
  const endpointUrl = obterEndpointUrl();  // 🆕 URL do meta se existir, senão hardcoded

  if (DEBUG_HTTP && endpointUrl !== ENDPOINT) {
    log(`🔎 usando endpoint do meta: ${endpointUrl}`);
  }

  let ctx;
  try {
    ctx = await playwrightRequest.newContext({
      storageState: SESSION_FILE,
      // UA realista de Chrome — bate com o que o playwright-sla-capture usa
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept': 'text/html, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': REFERER,
        'Origin': 'https://tutts.com.br',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    });

    const resp = await ctx.post(endpointUrl, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      data: body,
      maxRedirects: 0, // se redirecionar, é login = sessão morta
      failOnStatusCode: false,
      timeout: 30_000,
    });

    const statusCode = resp.status();
    const html = await resp.text();
    const respHeaders = resp.headers();

    // 🔬 DEBUG RICO — dump completo pra disco + sumário no log
    if (DEBUG_HTTP) {
      try {
        fs.writeFileSync(DEBUG_DUMP_FILE, html, 'utf8');
        log(`💾 HTML salvo em ${DEBUG_DUMP_FILE} (${html.length} bytes)`);
      } catch (e) {
        log(`⚠️ Falha ao salvar dump: ${e.message}`);
      }
      log(`🔎 HTTP ${statusCode} | bytes=${html.length} | content-type=${respHeaders['content-type'] || '(none)'}`);
      log(`🔎 location=${respHeaders['location'] || '(none)'}`);
      const preview = html.slice(0, 500).replace(/\s+/g, ' ').trim();
      log(`🔎 preview: ${preview}`);
      // Quais regras de ehTelaLogin matcharam?
      const motivos = [];
      if (!html || html.length < 100) motivos.push('html<100bytes');
      if (/<input[^>]+type=["']password/i.test(html)) motivos.push('temPasswordInput');
      if (/name=["']senha/i.test(html)) motivos.push('temNomeSenha');
      if (!/data-order-id=/.test(html)) motivos.push('semDataOrderId');
      log(`🔎 ehTelaLogin motivos: [${motivos.join(', ') || 'nenhum (não é login)'}]`);
    }

    return { ok: resp.ok(), html, statusCode };
  } finally {
    if (ctx) {
      try { await ctx.dispose(); } catch (_) {}
    }
  }
}

/**
 * @deprecated mantido só pra compatibilidade — não usar.
 * Substituído por playwright.request.newContext em fetchHtml().
 */
function lerCookiesParaHeader() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Sessão Playwright não encontrada em ${SESSION_FILE}`);
  }
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
  if (cookies.length === 0) throw new Error('Arquivo de sessão sem cookies');
  const tuttsCookies = cookies.filter(c =>
    c.domain && (c.domain.includes('tutts.com.br') || c.domain.includes('.tutts.com.br'))
  );
  return tuttsCookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Monta o body do POST pro endpoint viewServicoAcompanhamento.
 *
 * Estratégia em ordem de preferência:
 *
 *   1. 🥇 META_FILE (/tmp/tutts-sla-meta.json) — payload capturado em
 *      runtime pelo playwright-sla-capture interceptando o XHR real do
 *      navegador. É a única forma robusta porque captura o idFuncionario
 *      correto da sessão atual + qualquer campo novo que o sistema adicionar.
 *
 *   2. 🥈 process.env.SLA_DETECTOR_ID_FUNCIONARIO — fallback manual caso o
 *      META_FILE não exista ainda (ex: primeiro tick antes do primeiro
 *      relogin completar). Permite override emergencial sem deploy.
 *
 *   3. 🥉 Hardcoded com idFuncionario vazio — última saída. Vai dar erro
 *      provavelmente, mas não trava o serviço.
 */
function montarPayload() {
  // 🥇 Prioridade 1: payload capturado em runtime
  if (fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta && typeof meta.postData === 'string' && meta.postData.length > 0) {
        // Idade do meta — se for muito velho (>24h), avisa
        if (meta.capturedAt) {
          const idadeMs = Date.now() - new Date(meta.capturedAt).getTime();
          const idadeHoras = Math.floor(idadeMs / 3_600_000);
          if (idadeHoras > 24) {
            log(`⚠️ Meta de payload tem ${idadeHoras}h — pode estar desatualizado`);
          }
        }
        return meta.postData;
      }
    } catch (e) {
      log(`⚠️ Falha ao ler ${META_FILE}: ${e.message} — usando fallback`);
    }
  }

  // 🥈/🥉 Fallback: payload montado manualmente
  const idFuncionarioFallback = process.env.SLA_DETECTOR_ID_FUNCIONARIO || '';
  log(`⚠️ Usando payload fallback (idFuncionario=${idFuncionarioFallback || '(vazio)'}) — META_FILE ausente`);

  const params = new URLSearchParams();
  // Campos descobertos via Network do MAP — manter como fallback
  const fields = {
    aux: '', aux1: '', aux2: '', aux3: '', contrato: '',
    btnPag: 'N', buscaData: '', calculoCEP: 'N', calculoRegiao: 'N',
    checkedSostemaRotasPorCod: 'false', codCliente: '', codPlanRotas: '',
    dataFinal: '', dataInicial: '', erroFaixaCep: 'N',
    estadoCidadePermissao: 'N', formaPagamento: '',
    idFuncionario: idFuncionarioFallback,
    iniciou: '', limite: '150', listaClientes: '',
    offset: '0', opcao: '', ordenarPor: 'DD',
    osAgAnali: 'false', osAgPag: 'false', osagaut: 'false',
  };
  for (const [k, v] of Object.entries(fields)) params.append(k, v);
  return params.toString();
}

// fetchHtml() definida acima — usa playwright.request em vez de node fetch.

function ehTelaLogin(html) {
  if (!html || html.length < 100) return true;
  if (/<input[^>]+type=["']password/i.test(html)) return true;
  if (/name=["']senha/i.test(html)) return true;
  if (!/data-order-id=/.test(html)) return true;
  return false;
}

/**
 * Parse regex das <tr data-order-id="..."> pra extrair OS + cliente + rastreio.
 * Padrão real do MAP (extraído do response):
 *   <tr class="osEmExecucao letra75" data-order-id="1125832">
 *     <td>...>1046 -  O Varej... (cliente_cod no texto)
 *     <a href="../../rastreamento?cod=AAEZMIE-22"> (cod_rastreio)
 *     data-motoboy="15021" (cod_profissional)
 */
function parseOsDoHtml(html) {
  const ordens = [];
  const trRegex = /<tr[^>]+class="[^"]*osEmExecucao[^"]*"[^>]+data-order-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = trRegex.exec(html)) !== null) {
    const osNumero = match[1];
    const trConteudo = match[2];

    // cliente_cod: texto do botão "1046 -  O Varej..." ou "814 -  Cobra r..."
    const clienteMatch = trConteudo.match(/>\s*(\d{2,5})\s*-\s+[A-Za-z(]/);
    const clienteCod = clienteMatch ? clienteMatch[1] : null;

    // cod_rastreio do href
    const rastreioMatch = trConteudo.match(/rastreamento\?cod=([A-Za-z0-9_-]+)/);
    const codRastreio = rastreioMatch ? rastreioMatch[1] : null;

    // cod_profissional (motoboy)
    const profMatch = trConteudo.match(/data-motoboy=["'](\d+)["']/);
    const codProfissional = profMatch ? profMatch[1] : null;

    // Pega TODOS os data-balloon do bloco (vai usar pro filtro 767)
    const balloonMatches = trConteudo.match(/data-balloon="[^"]+"/g) || [];
    const balloonText = balloonMatches.join(' ');

    ordens.push({
      os_numero: osNumero,
      cliente_cod: clienteCod,
      cod_rastreio: codRastreio,
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

async function detectarOsNovas(pool) {
  try {
    const { ok, html, statusCode } = await fetchHtml();

    if (!ok && statusCode !== 200) {
      log(`⚠️ HTTP ${statusCode} no fetch`);
      // Considera relogin se 401/403/302
      const sessaoExpirada = [401, 403, 302].includes(statusCode);
      return { ok: false, sessaoExpirada, motivo: `http_${statusCode}` };
    }

    if (ehTelaLogin(html)) {
      log('🔑 Sessão expirada — relogin necessário');
      return { ok: false, sessaoExpirada: true, motivo: 'sessao_expirada' };
    }

    const ordens = parseOsDoHtml(html);
    const config = await carregarConfig(pool);
    const monitoradas = filtrarMonitorados(ordens, config);
    const { inseridas, ignoradas } = await inserirNaFila(pool, monitoradas);

    log(`📊 ${ordens.length} OS na tela | ${monitoradas.length} monitoradas | ${inseridas} novas, ${ignoradas} já conhecidas`);

    return {
      ok: true,
      sessaoExpirada: false,
      total: ordens.length,
      monitoradas: monitoradas.length,
      inseridas,
      ignoradas,
    };
  } catch (err) {
    log(`❌ Erro no detector: ${err.message}`);
    // 🔧 FIX: erro de sessão ausente/inválida no disco também conta como
    // "sessão expirada" — caso contrário o worker nunca dispara o auto-relogin
    // e fica preso em loop de erro a cada tick (até 2min).
    const isSessaoFaltando =
      err.message.includes('Sessão Playwright não encontrada') ||
      err.message.includes('Arquivo de sessão sem cookies') ||
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
  _internal: { parseOsDoHtml, filtrarMonitorados, ehTelaLogin, montarPayload },
};
