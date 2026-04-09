/**
 * sla-capture.service.js
 * Orquestra o fluxo de captura de SLA:
 *   1. Recebe trigger da extensão (via route)
 *   2. Enfileira em sla_capturas (UNIQUE os_numero = dedup automático)
 *   3. Worker pega pendentes e chama processarCaptura()
 *   4. processarCaptura: Playwright → parse pontos → Evolution → WhatsApp
 *   5. Retry 3x com backoff (2s / 5s / 10s), depois marca 'falhou' e alerta admin
 */

'use strict';

const { logger } = require('../../config/logger');
const { capturarPontosOS } = require('./playwright-sla-capture');

// ── Config ───────────────────────────────────────────────────────────────────
const MAX_TENTATIVAS = 3;
const BACKOFF_DELAYS_MS = [2_000, 5_000, 10_000]; // após tentativa 1, 2, 3

function log(msg) {
  logger.info(`[sla-capture-service] ${msg}`);
}

function logErr(msg) {
  logger.error(`[sla-capture-service] ${msg}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// ENFILEIRAMENTO (chamado pela route)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Insere um registro pendente de captura.
 * UNIQUE em os_numero garante idempotência — se já existir, retorna o existente.
 *
 * @returns { inserido: boolean, registro: Object }
 */
async function enfileirarCaptura(pool, payload) {
  const { os_numero, cliente_cod, cod_rastreio, link_rastreio, profissional, origem_ip } = payload;

  // Validação mínima
  if (!/^\d{7}$/.test(String(os_numero || ''))) {
    throw new Error('os_numero deve ter exatamente 7 dígitos');
  }
  if (!['814', '767'].includes(String(cliente_cod))) {
    throw new Error('cliente_cod deve ser 814 ou 767');
  }

  const { rows } = await pool.query(
    `
    INSERT INTO sla_capturas
      (os_numero, cliente_cod, cod_rastreio, link_rastreio, profissional, origem_ip, status, proximo_retry_em)
    VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW())
    ON CONFLICT (os_numero) DO NOTHING
    RETURNING *;
    `,
    [
      String(os_numero).trim(),
      String(cliente_cod).trim(),
      cod_rastreio || null,
      link_rastreio || null,
      profissional || null,
      origem_ip || null,
    ]
  );

  if (rows.length > 0) {
    log(`📥 Enfileirada OS ${os_numero} (cliente ${cliente_cod})`);
    return { inserido: true, registro: rows[0] };
  }

  // Já existe — retorna o existente
  const { rows: existentes } = await pool.query(
    `SELECT * FROM sla_capturas WHERE os_numero = $1`,
    [String(os_numero).trim()]
  );
  return { inserido: false, registro: existentes[0] || null };
}

// ═════════════════════════════════════════════════════════════════════════════
// EVOLUTION API — envio WhatsApp
// ═════════════════════════════════════════════════════════════════════════════

function getGrupoIdPorCliente(clienteCod) {
  if (clienteCod === '814') return process.env.EVOLUTION_GROUP_ID_814;
  if (clienteCod === '767') return process.env.EVOLUTION_GROUP_ID_767;
  return null;
}

async function enviarRastreioWhatsApp({ texto, clienteCod }) {
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  const grupoId = getGrupoIdPorCliente(clienteCod);

  if (!baseUrl || !apiKey || !instancia) {
    throw new Error('EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE não configuradas');
  }
  if (!grupoId) {
    throw new Error(`Grupo não configurado pra cliente ${clienteCod} (EVOLUTION_GROUP_ID_${clienteCod})`);
  }

  const url = `${baseUrl}/message/sendText/${instancia}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
    body: JSON.stringify({ number: grupoId, text: texto }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Evolution API erro ${response.status}: ${JSON.stringify(data)}`);
  }

  return { ok: true, data };
}

// ═════════════════════════════════════════════════════════════════════════════
// MONTAGEM DA MENSAGEM (mesmo formato da extensão v7.15)
// ═════════════════════════════════════════════════════════════════════════════

function montarMensagemRastreio({ os_numero, link_rastreio, pontos, cliente_cod }) {
  const blocos = [`📦 *NOVO RASTREIO*`, `🧾 *OS:* ${os_numero}`];

  if (link_rastreio) {
    blocos.push(`🔗 *Link:* ${link_rastreio}`);
  }

  pontos.forEach((pe) => {
    if (pontos.length > 1) blocos.push(`*Ponto ${pe.numero}*`);
    if (pe.endereco) blocos.push(`📍 *Endereço:* ${pe.endereco}`);
    if (pe.nomeCliente) blocos.push(`🏪 *Cliente:* ${pe.nomeCliente}`);
    if (cliente_cod === '767' && pe.nota) {
      blocos.push(`🧾 *NF:* ${pe.nota}`);
    }
  });

  return blocos.join('\n\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// PROCESSAMENTO (chamado pelo worker)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Processa UM registro pendente. Já vem marcado como 'processando'.
 * Atualiza pra 'enviado' ou re-enfileira com backoff.
 */
async function processarCaptura(pool, registro) {
  const { id, os_numero, cliente_cod, link_rastreio, tentativas } = registro;
  const tentativaAtual = (tentativas || 0) + 1;

  log(`🔍 Processando OS ${os_numero} (cliente ${cliente_cod}, tentativa ${tentativaAtual}/${MAX_TENTATIVAS})`);

  try {
    // 1. Captura pontos via Playwright
    const resultado = await capturarPontosOS({ os_numero, cliente_cod });

    // Cliente 767 pode ser pulado se Ponto 1 não bater com Galba
    if (resultado.skipped) {
      log(`⊘ OS ${os_numero} pulada: ${resultado.motivo}`);
      await pool.query(
        `UPDATE sla_capturas
         SET status = 'ignorado',
             erro = $1,
             tentativas = $2,
             pontos_json = $3,
             atualizado_em = NOW()
         WHERE id = $4`,
        [
          resultado.motivo,
          tentativaAtual,
          resultado.debugInfo ? JSON.stringify(resultado.debugInfo) : null,
          id,
        ]
      );
      return { sucesso: true, ignorado: true };
    }

    const pontos = resultado.pontos;
    if (!pontos || pontos.length === 0) {
      throw new Error('Sem pontos de entrega (Ponto >= 2) encontrados.');
    }

    // 2. Monta mensagem
    const texto = montarMensagemRastreio({ os_numero, link_rastreio, pontos, cliente_cod });

    // 3. Envia via Evolution
    await enviarRastreioWhatsApp({ texto, clienteCod: cliente_cod });

    // 4. Marca como enviado
    await pool.query(
      `UPDATE sla_capturas
       SET status = 'enviado',
           tentativas = $1,
           pontos_json = $2,
           mensagem_enviada = $3,
           enviado_em = NOW(),
           atualizado_em = NOW()
       WHERE id = $4`,
      [tentativaAtual, JSON.stringify(pontos), texto, id]
    );

    log(`✅ OS ${os_numero} enviada no grupo ${cliente_cod}`);
    return { sucesso: true };
  } catch (err) {
    const mensagemErro = err.message || String(err);
    logErr(`❌ OS ${os_numero} falhou (tentativa ${tentativaAtual}): ${mensagemErro}`);

    if (tentativaAtual >= MAX_TENTATIVAS) {
      // Esgotou retries — marca como falhou e alerta admin
      await pool.query(
        `UPDATE sla_capturas
         SET status = 'falhou',
             erro = $1,
             tentativas = $2,
             atualizado_em = NOW()
         WHERE id = $3`,
        [mensagemErro, tentativaAtual, id]
      );

      // Notifica admins via WebSocket (se disponível)
      try {
        if (typeof global.broadcastToAdmins === 'function') {
          global.broadcastToAdmins('sla_capture_falhou', {
            os_numero,
            cliente_cod,
            erro: mensagemErro,
            tentativas: tentativaAtual,
          });
        }
      } catch (_) {}

      return { sucesso: false, esgotado: true, erro: mensagemErro };
    }

    // Ainda tem retry — reenfileira com backoff
    const delayMs = BACKOFF_DELAYS_MS[Math.min(tentativaAtual - 1, BACKOFF_DELAYS_MS.length - 1)];
    const proximoRetry = new Date(Date.now() + delayMs);

    await pool.query(
      `UPDATE sla_capturas
       SET status = 'pendente',
           erro = $1,
           tentativas = $2,
           proximo_retry_em = $3,
           atualizado_em = NOW()
       WHERE id = $4`,
      [mensagemErro, tentativaAtual, proximoRetry, id]
    );

    log(`⏳ OS ${os_numero} re-enfileirada (próximo retry em ${delayMs}ms)`);
    return { sucesso: false, esgotado: false, erro: mensagemErro };
  }
}

module.exports = {
  enfileirarCaptura,
  processarCaptura,
  // expostos pra testes
  _internal: { montarMensagemRastreio, enviarRastreioWhatsApp, getGrupoIdPorCliente },
};
