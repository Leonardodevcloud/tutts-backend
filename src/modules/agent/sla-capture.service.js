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
const { enviarRastreioCliente, normalizarTelefoneBR } = require('../solicitacao/whatsapp-rastreio.service');
// Lazy require — quebra dependência circular:
// sla-capture.service → playwright-sla-capture → (resolve tudo antes)
// Sem lazy: no boot o módulo ainda não terminou de exportar → capturarPontosOS = undefined
let _capturarPontosOS = null;
function getCapturarPontosOS() {
  if (!_capturarPontosOS) {
    _capturarPontosOS = require('./playwright-sla-capture').capturarPontosOS;
  }
  return _capturarPontosOS;
}

// ── Config ───────────────────────────────────────────────────────────────────
const MAX_TENTATIVAS = 3;
const BACKOFF_DELAYS_MS = [2_000, 5_000, 10_000]; // após tentativa 1, 2, 3
// 🆕 2026-05 v3: liga logs verbosos do fluxo de configEntries / configMatched
const DEBUG_VERBOSE = String(process.env.SLA_CAPTURE_DEBUG || '').toLowerCase() === 'true';

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

/**
 * 2026-05 v3: aceita `grupoIdOverride` opcional. Quando passado, ignora
 * env vars e usa o ID fornecido (vem do cadastro em rastreio_clientes_config).
 * Fallback pras env vars antigas (EVOLUTION_GROUP_ID_814/767) pra retrocompat.
 */
function getGrupoIdPorCliente(clienteCod, grupoIdOverride) {
  if (grupoIdOverride && String(grupoIdOverride).trim()) {
    return String(grupoIdOverride).trim();
  }
  if (clienteCod === '814') return process.env.EVOLUTION_GROUP_ID_814;
  if (clienteCod === '767') return process.env.EVOLUTION_GROUP_ID_767;
  return null;
}

async function enviarRastreioWhatsApp({ texto, clienteCod, grupoIdOverride }) {
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  const grupoId = getGrupoIdPorCliente(clienteCod, grupoIdOverride);

  if (!baseUrl || !apiKey || !instancia) {
    throw new Error('EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE não configuradas');
  }
  if (!grupoId) {
    throw new Error(`Grupo não configurado pra cliente ${clienteCod} (cadastre em rastreio_clientes_config ou defina EVOLUTION_GROUP_ID_${clienteCod})`);
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
    // 1165: o nome do cliente vem corrompido pelo parser de endereço
    // (vira lixo tipo "1 - 9834"); mostra a NF no lugar.
    if (['1165', '1178'].includes(cliente_cod)) {
      if (pe.nota) blocos.push(`🧾 *NF:* ${pe.nota}`);
    } else {
      if (pe.nomeCliente) blocos.push(`🏪 *Cliente:* ${pe.nomeCliente}`);
      if (cliente_cod === '767' && pe.nota) {
        blocos.push(`🧾 *NF:* ${pe.nota}`);
      }
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
// ═════════════════════════════════════════════════════════════════════════════
// EXTRAÇÃO DE TELEFONE DA NOTA DO PONTO
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tenta extrair um telefone celular do campo `nota` de um ponto de entrega.
 * O campo nota pode conter: NF, CNPJ, códigos e telefones em formatos variados.
 *
 * Padrões reconhecidos (exemplos reais):
 *   "05-000034696-5 061-98202-0023"  → 06198202-0023 → 5561982020023
 *   "61-98202-0023"                   → 5561982020023
 *   "(71) 9 8765-4321"               → 5571987654321
 *   "71987654321"                     → 5571987654321
 *   "998765432 NF123456"             → sem DDD → tenta com heurística
 *
 * Retorna o número normalizado (5571XXXXXXXXX) ou null se não encontrar.
 */
function extrairTelefoneDeNota(nota) {
  if (!nota || typeof nota !== 'string') return null;

  // Limpa NFs óbvias: padrão "DD-DDDDDDDDD-D" com 2-1-1 hífens (NF fiscal)
  // Remove sequências que claramente são NFs antes de buscar telefones
  const semNF = nota
    .replace(/\b\d{2}-\d{9}-\d\b/g, ' ')   // 05-000034696-5
    .replace(/\b\d{9,11}\/\d{4}-\d{2}\b/g, ' ') // CNPJ formato
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, ' ') // CPF
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, ' '); // CNPJ

  // Regex principal: captura sequências que parecem telefone com DDD
  // Aceita: 061-98202-0023 | (61) 98202-0023 | 61 982020023 | 61-98202-0023
  const regexes = [
    // Com DDD explícito 2-3 dígitos: 061-98202-0023 ou 61-98202-0023
    /(?<!\d)0?([1-9]{1}[1-9]{1})\s*[-.\s]?\s*9\s*(\d{4})\s*[-.\s]?\s*(\d{4})(?!\d)/g,
    // Com parênteses: (71) 9 8765-4321
    /\(0?([1-9]{1}[1-9]{1})\)\s*9?\s*(\d{4})\s*[-.\s]?\s*(\d{4})/g,
    // 11 dígitos colados: 71987654321
    /(?<!\d)((?:0?[1-9]{2})9\d{8})(?!\d)/g,
  ];

  for (const regex of regexes) {
    regex.lastIndex = 0;
    const matches = [...semNF.matchAll(regex)];
    for (const m of matches) {
      // Reconstruir número com todos os grupos capturados
      let candidato;
      if (m[3]) {
        // Grupos: DDD + parte1(4) + parte2(4)
        const ddd = m[1].padStart(2, '0').slice(-2);
        candidato = ddd + '9' + m[2] + m[3];
      } else if (m[1] && m[1].length >= 10) {
        // Número colado
        candidato = m[1].replace(/^0+/, '');
      } else {
        continue;
      }
      const normalizado = normalizarTelefoneBR(candidato);
      if (normalizado) return normalizado;
    }
  }

  return null;
}


async function processarCaptura(pool, registro) {
  const { id, os_numero, cliente_cod, link_rastreio, tentativas } = registro;
  const tentativaAtual = (tentativas || 0) + 1;

  log(`🔍 Processando OS ${os_numero} (cliente ${cliente_cod}, tentativa ${tentativaAtual}/${MAX_TENTATIVAS})`);

  try {
    // 🆕 2026-05 v3: carrega configEntries do cliente ANTES de capturar pontos.
    // Vem como array (1+ cadastros) — passado pro playwright pra ele decidir
    // qual cadastro a OS pertence (baseado em palavras-chave do ponto 1).
    let configEntries = null;
    try {
      const carregarConfig = require('./sla-detector.service').carregarConfig;
      const config = await carregarConfig(pool);
      configEntries = Array.isArray(config[cliente_cod]) ? config[cliente_cod] : null;
      if (DEBUG_VERBOSE) {
        log(`📋 configEntries pra ${cliente_cod}: ${configEntries ? configEntries.length + ' cadastro(s)' : 'nenhum'}`);
      }
    } catch (e) {
      logErr(`⚠️ Falha ao carregar configEntries de ${cliente_cod}: ${e.message}. Seguindo com fluxo legado.`);
    }

    // Cliente Hub: decide POR OS. Se a OS ja saiu pelo Hub, captura mas NAO
    // envia o legado (o Hub manda o link Tutts). Se ainda nao saiu, segura ate
    // 10 min apos a captura pra dar tempo do Hub assumir; passada a janela,
    // segue o legado normal. Cliente sem usa_hub nao entra aqui.
    let _hubDelivery = false;
    let _tuttsToken = null;
    {
      const _ehHub = (await pool.query(
        "SELECT 1 FROM rastreio_clientes_config WHERE cliente_cod = $1 AND ativo = true AND usa_hub = true LIMIT 1",
        [String(cliente_cod)]
      )).rows.length > 0;
      if (_ehHub) {
        // Hub: so consideramos "entregue pelo Hub" quando ja existe o token de
        // rastreio Tutts (entregador aceitou na 99 -> tracking_link -> token).
        // Ai mandamos o link Tutts pro MESMO grupo do rastreio-clientes.
        const _tok = (await pool.query(
          'SELECT rastreio_token FROM logistics_deliveries WHERE codigo_os = $1 AND rastreio_token IS NOT NULL ORDER BY id DESC LIMIT 1',
          [String(os_numero)]
        )).rows[0];
        if (_tok && _tok.rastreio_token) {
          _hubDelivery = true;
          _tuttsToken = _tok.rastreio_token;
        } else {
          // Sem token ainda: segura ate 10 min apos a captura pra dar tempo do
          // entregador aceitar e o token nascer. Passada a janela, cai no legado.
          const JANELA_HUB_MS = 10 * 60 * 1000;
          const _cap = (await pool.query('SELECT criado_em FROM sla_capturas WHERE id = $1', [id])).rows[0];
          const _criadoMs = _cap && _cap.criado_em ? new Date(_cap.criado_em).getTime() : Date.now();
          if (Date.now() - _criadoMs < JANELA_HUB_MS) {
            await pool.query(
              "UPDATE sla_capturas SET status = 'pendente', proximo_retry_em = NOW() + INTERVAL '15 seconds', atualizado_em = NOW() WHERE id = $1",
              [id]
            );
            log(`⏳ OS ${os_numero}: cliente Hub, aguardando link Tutts (janela 10min)`);
            return { sucesso: true, adiado: true };
          }
          // Janela passou sem token Tutts: cai no legado (link Mapp pro grupo).
        }
      }
    }

    // 1. Captura pontos via Playwright
    // Nota: o browser persistente (2026-05) é injetado via setOverrides({ browser })
    // pelo sla-capture.agent.js ANTES desta chamada. O service não precisa saber.
    const resultado = await getCapturarPontosOS()({
      os_numero,
      cliente_cod,
      configEntries,  // 🆕 2026-05 v3
    });

    // Cliente 767 (ou cliente customizado) pode ser pulado se Ponto 1 não bater
    // com nenhuma palavra-chave configurada
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

    // 2. Monta mensagem. OS do Hub (com token) usa o link de rastreio Tutts
    // (centraltutts.online/r/<token>) no lugar do link Mapp — mesmo grupo.
    let _linkGrupo = link_rastreio;
    if (_hubDelivery && _tuttsToken) {
      const _base = (process.env.RASTREIO_BASE_URL || 'https://centraltutts.online').replace(/\/+$/, '');
      _linkGrupo = `${_base}/r/${_tuttsToken}`;
    }
    const texto = montarMensagemRastreio({ os_numero, link_rastreio: _linkGrupo, pontos, cliente_cod });

    // 3. Envia via Evolution — usa grupo do cadastro escolhido (configMatched)
    // ou fallback pra env var legada se não houver match.
    const grupoIdOverride = resultado.configMatched
      ? resultado.configMatched.evolutionGroupId
      : null;
    if (resultado.configMatched && DEBUG_VERBOSE) {
      log(`📤 Enviando OS ${os_numero} pro cadastro "${resultado.configMatched.nomeExibicao || resultado.configMatched.id}" (grupo ${grupoIdOverride})`);
    }
    // Sempre manda pro grupo: Hub com link Tutts, legado com link Mapp.
    await enviarRastreioWhatsApp({ texto, clienteCod: cliente_cod, grupoIdOverride });
    if (_hubDelivery) log(`📍 OS ${os_numero}: link de rastreio Tutts enviado ao grupo`);

    // 3b. Rastreio direto ao cliente final (se habilitado no cadastro)
    if (!_hubDelivery && resultado.configMatched && resultado.configMatched.rastreioClienteAtivo) {
      // Tenta extrair telefone de cada ponto (do ponto de entrega, não coleta)
      const pontosEntrega = pontos.filter(p => p.numero >= 2);
      let telefoneEncontrado = null;
      for (const ponto of pontosEntrega) {
        // 2026-06 FIX: o telefone do cliente final fica no MEIO do texto do ponto
        // (depois do endereco, antes do "No nota:"). O parseEntrega767 joga esse
        // trecho no campo `nomeCliente` (e as vezes o picota com um CEP falso),
        // entao olhar so `nota`/`endereco` nunca acha o numero. Varremos o texto
        // bruto integro do ponto (preservado em `textoBruto`), que sempre contem
        // o telefone original; campos parseados ficam como fallback retrocompat.
        const fonteTelefone = ponto.textoBruto
          || [ponto.nota, ponto.endereco, ponto.nomeCliente].filter(Boolean).join(' ');
        const tel = extrairTelefoneDeNota(fonteTelefone);
        if (tel) { telefoneEncontrado = tel; break; }
      }

      if (telefoneEncontrado) {
        try {
          const nomeDestinatario = resultado.configMatched.rastreioClienteNomeExibicao ||
            (pontosEntrega[0] && pontosEntrega[0].nomeCliente) || null;
          const envio = await enviarRastreioCliente({
            telefone: telefoneEncontrado,
            nomeDestinatario,
            osNumero: os_numero,
            urlRastreamento: link_rastreio,
          });
          log(envio.enviado
            ? 'WhatsApp cliente enviado: ' + telefoneEncontrado + ' OS ' + os_numero
            : 'WhatsApp cliente nao enviado: ' + (envio.motivo || '') + ' — ' + telefoneEncontrado
          );
        } catch (e) {
          logErr('Erro ao enviar rastreio ao cliente (nao-bloqueante): ' + e.message);
        }
      } else {
        log('Rastreio cliente ativo mas nenhum telefone encontrado nos pontos da OS ' + os_numero);
      }
    }

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
  extrairTelefoneDeNota,
  montarMensagemRastreio,
  enviarRastreioWhatsApp,
  // expostos pra testes
  _internal: { montarMensagemRastreio, enviarRastreioWhatsApp, getGrupoIdPorCliente },
};
