'use strict';

/**
 * sla-detector.service.js
 *
 * Detector HTTP-only de OS novas no MAP via endpoint viewServicoAcompanhamento.
 * Substitui a extensão Chrome SLA Monitor v8.0 (que dependia do operador).
 *
 * Fluxo:
 *   1. Lê cookies da sessão Playwright existente (/tmp/tutts-sla-session.json)
 *   2. POST no endpoint AJAX que devolve HTML com <tr data-order-id="...">
 *   3. Parse regex pra extrair OS + cliente_cod + cod_rastreio
 *   4. Filtra 814 e 767 (configurável)
 *   5. INSERT ON CONFLICT DO NOTHING em sla_capturas
 *   6. Worker existente captura pontos via Playwright e envia WhatsApp
 *
 * Auto-relogin: se a resposta vier como HTML de login, sinaliza sessaoExpirada
 * pra que o caller (worker) dispare relogin via playwright-sla-capture.
 */

const fs = require('fs');

const SESSION_FILE = '/tmp/tutts-sla-session.json';
const MAP_BASE = 'https://tutts.com.br/expresso/expressoat';
const ENDPOINT = `${MAP_BASE}/entregasDia/acompanhamento/ajax/viewServicoAcompanhamento`;
const REFERER = `${MAP_BASE}/acompanhamento-servicos`;

const CLIENTES_MONITORADOS = ['814', '767'];
const TERMOS_767 = ['GALBA', 'NOVAS DE CASTRO', '57061-510'];

function log(msg) {
  console.log(`[sla-detector] ${msg}`);
}

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

function montarPayload() {
  const params = new URLSearchParams();
  // Campos descobertos via Network do MAP
  const fields = {
    aux: '', aux1: '', aux2: '', aux3: '', contrato: '',
    btnPag: 'N', buscaData: '', calculoCEP: 'N', calculoRegiao: 'N',
    checkedSostemaRotasPorCod: 'false', codCliente: '', codPlanRotas: '',
    dataFinal: '', dataInicial: '', erroFaixaCep: 'N',
    estadoCidadePermissao: 'N', formaPagamento: '',
    idFuncionario: '65', iniciou: '', limite: '150', listaClientes: '',
    offset: '0', opcao: '', ordenarPor: 'DD',
    osAgAnali: 'false', osAgPag: 'false', osagaut: 'false',
  };
  for (const [k, v] of Object.entries(fields)) params.append(k, v);
  return params.toString();
}

async function fetchHtml() {
  const cookieHeader = lerCookiesParaHeader();
  const body = montarPayload();

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'text/html, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': REFERER,
      'Origin': 'https://tutts.com.br',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Tutts-Detector/1.0',
      'Cookie': cookieHeader,
    },
    body,
    redirect: 'manual',
  });

  const html = await resp.text();
  return { ok: resp.ok, html, statusCode: resp.status };
}

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

function filtrarMonitorados(ordens) {
  return ordens.filter(o => {
    if (!o.cliente_cod || !CLIENTES_MONITORADOS.includes(o.cliente_cod)) return false;
    if (o.cliente_cod === '814') return true;
    if (o.cliente_cod === '767') {
      const balloonUpper = (o._balloon || '').toUpperCase();
      return TERMOS_767.some(termo => balloonUpper.includes(termo));
    }
    return false;
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
    const monitoradas = filtrarMonitorados(ordens);
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
    return { ok: false, sessaoExpirada: false, motivo: err.message };
  }
}

module.exports = {
  detectarOsNovas,
  _internal: { parseOsDoHtml, filtrarMonitorados, ehTelaLogin, montarPayload },
};
