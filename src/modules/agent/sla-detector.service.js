'use strict';

/**
 * sla-detector.service.js
 *
 * Detector de OS novas no MAP.
 *
 * ARQUITETURA (2026-04-13 — versão final):
 *   Este módulo é um CLIENTE FINO de playwright-sla-capture.coletarOsEmExecucao().
 *   Toda a orquestração de browser + sessão + interceptação de XHR fica lá.
 *   Aqui a gente só:
 *     1. Chama coletarOsEmExecucao() → recebe lista pronta de OS em execução
 *     2. Carrega config de clientes monitorados do banco
 *     3. Filtra as OS pelos clientes monitorados (e pelos filtros_balao)
 *     4. INSERT ON CONFLICT DO NOTHING em sla_capturas
 *     5. Worker existente (sla-capture-worker) pega a fila e dispara WhatsApp
 *
 * 🔧 HISTÓRICO (2026-04-13):
 *   Tentativas anteriores de fazer o detector rodar seu próprio HTTP request
 *   (node fetch, playwright.request.newContext, browser + page.evaluate) todas
 *   falharam porque o servidor PHP do tutts.com.br só responde JSON quando o
 *   XHR vem de um clique natural na aba "Em execução" dentro de uma sessão
 *   ativada. Por cima disso, abrir dois Chromiums no mesmo processo Node
 *   (um do detector + um do capture-worker) causava travas.
 *
 *   Solução: consolidar TUDO no playwright-sla-capture, usando o mesmo mutex,
 *   e o detector só chama a função pronta.
 */

const { coletarOsEmExecucao } = require('./playwright-sla-capture');
const { logger } = require('../../config/logger');

const DEBUG = process.env.SLA_DETECTOR_DEBUG === 'true';

function log(msg) {
  logger.info(`[sla-detector] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────
// REGRAS DE EXCLUSÃO POR CLIENTE
// ─────────────────────────────────────────────────────────────────────────
// Regras que o detector aplica ANTES de enfileirar OS. Se uma OS bater em
// qualquer padrão aqui, é ignorada com log de motivo.
//
// Formato:
//   '<cliente_cod>': [
//     { regex: /PADRAO/i, motivo: 'descrição legível' },
//     ...
//   ]
//
// Matching: o regex é testado contra o `_balloon` da OS (que é o innerText
// do <tr> inteiro concatenado com todos os data-balloon, em maiúsculas).
//
// Adicionar nova regra aqui é o caminho mais rápido. Se a regra virar complexa
// ou específica por cliente de forma dinâmica, migrar pra coluna nova no
// rastreio_clientes_config.
// ─────────────────────────────────────────────────────────────────────────

const REGRAS_EXCLUSAO_POR_CLIENTE = {
  // Cliente 814 (Cobra Center) — não rastreia corridas de carro utilitário
  // (regra histórica que veio da extensão Chrome SLA Monitor v8)
  '814': [
    {
      regex: /CARRO[\s\-]*UTILIT/i,
      motivo: 'carro utilitário / carro utilitário expresso',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// CONFIG — carregada do banco
// ─────────────────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS = 60_000;
let _configCache = null;
let _configCacheAt = 0;

/**
 * Carrega config de clientes monitorados + filtros de _balloon.
 * Cache de 1 minuto pra evitar hit no banco a cada tick.
 *
 * Schema da tabela rastreio_clientes_config (confirmado 2026-04-13):
 *   id, cliente_cod, nome_exibicao, ativo, evolution_group_id,
 *   termos_filtro (ARRAY), observacoes, criado_em, atualizado_em
 *
 * Tolerante a variações de schema: se a coluna `termos_filtro` não existir,
 * tenta descobrir dinamicamente (pode ser filtros_balao, filtros, etc).
 */
async function carregarConfig(pool) {
  const agora = Date.now();
  if (_configCache && (agora - _configCacheAt) < CONFIG_CACHE_TTL_MS) {
    return _configCache;
  }

  // Descobre o nome real da coluna de filtros
  const { rows: cols } = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = 'rastreio_clientes_config'`
  );
  const colNames = cols.map(c => c.column_name);

  // Ordem de preferência: termos_filtro (schema atual) → qualquer filtr+bal → qualquer filtr → qualquer termos
  const colFiltros =
    (colNames.includes('termos_filtro') ? 'termos_filtro' : null)
    || colNames.find(c => /filtr/i.test(c) && /bal/i.test(c))
    || colNames.find(c => /filtr/i.test(c))
    || colNames.find(c => /termo/i.test(c))
    || null;

  if (DEBUG) {
    log(`⚙️ Colunas da tabela: [${colNames.join(', ')}] | coluna de filtros: ${colFiltros || '(nenhuma)'}`);
  }

  // Monta a query — inclui nome_exibicao se existir (útil pros logs)
  const selectCols = ['cliente_cod', 'ativo'];
  if (colNames.includes('nome_exibicao')) selectCols.push('nome_exibicao');
  if (colFiltros) selectCols.push(`${colFiltros} AS filtros_balao`);

  const { rows } = await pool.query(
    `SELECT ${selectCols.join(', ')}
       FROM rastreio_clientes_config
      WHERE ativo = true`
  );

  const config = {};
  for (const row of rows) {
    const cod = String(row.cliente_cod);
    let filtros = [];
    const raw = row.filtros_balao;
    if (Array.isArray(raw)) {
      filtros = raw.map(f => String(f).toUpperCase().trim()).filter(Boolean);
    } else if (typeof raw === 'string' && raw.length > 0) {
      // Pode ser JSON stringificado ou CSV
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          filtros = parsed.map(f => String(f).toUpperCase().trim()).filter(Boolean);
        }
      } catch {
        filtros = raw.split(',').map(f => f.toUpperCase().trim()).filter(Boolean);
      }
    }
    config[cod] = {
      ativo: row.ativo,
      nomeExibicao: row.nome_exibicao || null,
      filtrosBalao: filtros,
    };
  }

  _configCache = config;
  _configCacheAt = agora;

  if (DEBUG) {
    const codigos = Object.keys(config);
    log(`⚙️ Config carregada: ${codigos.length} cliente(s) ativo(s) — [${codigos.join(', ')}]`);
    for (const [cod, cfg] of Object.entries(config)) {
      const nome = cfg.nomeExibicao ? ` (${cfg.nomeExibicao})` : '';
      log(`   • ${cod}${nome}: filtros=[${cfg.filtrosBalao.join(', ') || '(nenhum — pega todas)'}]`);
    }
  }

  return config;
}

// ─────────────────────────────────────────────────────────────────────────
// FILTRO — decide se uma OS deve ser enfileirada
// ─────────────────────────────────────────────────────────────────────────

function filtrarMonitorados(ordens, config) {
  const monitoradas = [];
  const excluidasPorRegra = []; // pra log agregado
  let contadoresExclusao = {}; // { motivo: count }

  for (const ordem of ordens) {
    const clienteCod = String(ordem.cliente_cod || '');
    const cfg = config[clienteCod];
    if (!cfg || !cfg.ativo) continue;

    const balloon = String(ordem._balloon || '').toUpperCase();

    // 1. Filtros de INCLUSÃO por termo (da config do banco — termos_filtro)
    //    Se há termos, a OS precisa bater pelo menos UM
    if (cfg.filtrosBalao && cfg.filtrosBalao.length > 0) {
      const bate = cfg.filtrosBalao.some(termo => balloon.includes(termo));
      if (!bate) continue;
    }

    // 2. Regras de EXCLUSÃO hardcoded por cliente (REGRAS_EXCLUSAO_POR_CLIENTE)
    //    Se a OS bate em qualquer regra de exclusão, é descartada
    const regrasCliente = REGRAS_EXCLUSAO_POR_CLIENTE[clienteCod] || [];
    let excluida = false;
    for (const regra of regrasCliente) {
      if (regra.regex.test(balloon)) {
        excluida = true;
        contadoresExclusao[regra.motivo] = (contadoresExclusao[regra.motivo] || 0) + 1;
        if (DEBUG) {
          log(`🚫 OS ${ordem.os_numero} (cliente ${clienteCod}) excluída: ${regra.motivo}`);
        }
        excluidasPorRegra.push({ os: ordem.os_numero, cliente: clienteCod, motivo: regra.motivo });
        break;
      }
    }
    if (excluida) continue;

    monitoradas.push(ordem);
  }

  // Log agregado das exclusões pra visibilidade (mesmo sem DEBUG)
  if (excluidasPorRegra.length > 0) {
    const resumo = Object.entries(contadoresExclusao)
      .map(([motivo, count]) => `${count}× ${motivo}`)
      .join(', ');
    log(`🚫 ${excluidasPorRegra.length} OS excluídas por regra: ${resumo}`);
  }

  return monitoradas;
}

// ─────────────────────────────────────────────────────────────────────────
// INSERT — enfileira na sla_capturas
// ─────────────────────────────────────────────────────────────────────────

async function inserirNaFila(pool, ordens) {
  let inseridas = 0;
  let ignoradas = 0;

  for (const ordem of ordens) {
    try {
      // Schema real da sla_capturas (confirmado 2026-04-13):
      //   os_numero, cliente_cod, cod_rastreio, link_rastreio, profissional,
      //   status, tentativas, erro, pontos_json, mensagem_enviada, origem_ip,
      //   criado_em, atualizado_em, proximo_retry_em, enviado_em
      //
      // OBS: `_balloon` é campo interno (só usado pra filtro no service) —
      // não é persistido. A coluna do banco se chama `profissional`,
      // não `cod_profissional`.
      const result = await pool.query(
        `INSERT INTO sla_capturas
           (os_numero, cliente_cod, cod_rastreio, profissional, status, criado_em)
         VALUES ($1, $2, $3, $4, 'pendente', NOW())
         ON CONFLICT (os_numero) DO NOTHING
         RETURNING id`,
        [
          ordem.os_numero,
          ordem.cliente_cod,
          ordem.cod_rastreio,
          ordem.cod_profissional, // nome interno cod_profissional → coluna `profissional`
        ]
      );
      if (result.rowCount > 0) {
        inseridas++;
        if (DEBUG) log(`✅ Enfileirada OS ${ordem.os_numero} (cliente ${ordem.cliente_cod})`);
      } else {
        ignoradas++;
      }
    } catch (e) {
      log(`❌ Erro ao inserir OS ${ordem.os_numero}: ${e.message}`);
    }
  }

  return { inseridas, ignoradas };
}

// ─────────────────────────────────────────────────────────────────────────
// DETECTOR PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────

/**
 * Função principal chamada pelo sla-detector-worker a cada tick.
 *
 * Retorna:
 *   { ok: true,  sessaoExpirada: false, total, monitoradas, inseridas, ignoradas, paginas }
 *   { ok: false, sessaoExpirada: true,  motivo }  ← worker vai forçar relogin
 *   { ok: false, sessaoExpirada: false, motivo }  ← outro erro
 */
async function detectarOsNovas(pool) {
  try {
    const result = await coletarOsEmExecucao();

    if (!result.ok) {
      log(`⚠️ coletarOsEmExecucao falhou: ${result.motivo}`);
      return {
        ok: false,
        sessaoExpirada: !!result.sessaoExpirada,
        motivo: result.motivo,
      };
    }

    const { ordens, totalEsperado, paginas, duracaoMs } = result;

    const config = await carregarConfig(pool);
    const monitoradas = filtrarMonitorados(ordens, config);
    const { inseridas, ignoradas } = await inserirNaFila(pool, monitoradas);

    log(
      `📊 ${ordens.length} OS (${paginas}p${totalEsperado != null ? `, esperado=${totalEsperado}` : ''}, ${duracaoMs}ms) | ` +
      `${monitoradas.length} monitoradas | ${inseridas} novas, ${ignoradas} já conhecidas`
    );

    return {
      ok: true,
      sessaoExpirada: false,
      total: ordens.length,
      paginas,
      totalEsperado,
      duracaoMs,
      monitoradas: monitoradas.length,
      inseridas,
      ignoradas,
    };
  } catch (err) {
    log(`❌ Erro no detector: ${err.message}`);
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

// Limpa cache (útil pra admin forçar refresh)
function limparCacheConfig() {
  _configCache = null;
  _configCacheAt = 0;
}

module.exports = {
  detectarOsNovas,
  carregarConfig,
  limparCacheConfig,
  // expostos pra testes
  _internal: {
    filtrarMonitorados,
    inserirNaFila,
  },
};
