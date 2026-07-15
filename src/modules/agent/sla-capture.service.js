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

/**
 * Fallback de pontos: quando o sla_capturas ainda nao capturou (rastreio sai
 * antes do agente), monta os pontos a partir do `pontos` da propria entrega
 * (logistics_deliveries.pontos = enderecos do dispatch, com .rua e .nome).
 * Mapeia pro formato do montarMensagemRastreio e pula a coleta (indice 0).
 */
// CLIENTE_FINAL_NF_V1: fonte unica de nome do cliente final + NF limpa.
const { extrairClienteFinalENota } = require('../logistics/core/ClienteFinalParser');

function montarPontosFallback(enderecos) {
  if (typeof enderecos === 'string') {
    try { enderecos = JSON.parse(enderecos); } catch (_) { return []; }
  }
  if (!Array.isArray(enderecos) || enderecos.length < 2) return [];
  return enderecos.slice(1)
    .map((p) => ({
      endereco: (p && (p.endereco || p.rua)) || '',
      nomeCliente: (p && (p.nomeCliente || p.nome)) || '',
      nota: (p && p.nota) || null,
    }))
    .filter((p) => p.endereco || p.nomeCliente)
    .map((p, i) => ({ numero: i + 2, ...p }));
}

// Janela de graca (min) pra segurar o rastreio do grupo ate o codigo de coleta
// chegar. Passada a janela, envia mesmo sem codigo (a corrida pode nao exigir).
const RASTREIO_CODIGO_GRACE_MIN = parseInt(process.env.RASTREIO_CODIGO_GRACE_MIN || '4', 10);

/**
 * Decide se deve SEGURAR o envio do rastreio ao grupo aguardando o codigo de
 * coleta. Retorna true = segura (nao envia agora); false = pode enviar.
 * Regra: se ja tem codigo -> envia. Se nao tem E a corrida e recente (dentro da
 * janela de graca) -> segura (o poller re-tenta e o codigo costuma chegar). Se
 * nao tem E passou da janela -> envia mesmo assim (evita travar corridas que
 * nunca terao codigo).
 */
function _segurarAteCodigoColeta({ pickup_code, created_at }) {
  if (pickup_code) return false;
  if (!created_at) return false; // sem data confiavel -> nao trava
  const idadeMin = (Date.now() - new Date(created_at).getTime()) / 60000;
  return idadeMin >= 0 && idadeMin < RASTREIO_CODIGO_GRACE_MIN;
}

function montarMensagemRastreio({ os_numero, link_rastreio, pontos, cliente_cod, codigo_coleta }) {
  // 2026-06: os 4 ultimos digitos da OS em *negrito* p/ leitura rapida no grupo.
  const _osStr = String(os_numero == null ? '' : os_numero);
  // WhatsApp só aplica negrito quando o * está separado por espaço ou início/fim de linha.
  // Formato: "123 *0847*" — prefixo + espaço + *sufixo*
  const _osFmt = _osStr.length > 4
    ? `${_osStr.slice(0, -4)} *${_osStr.slice(-4)}*`
    : (_osStr ? `*${_osStr}*` : _osStr);
  const blocos = [`📦 *NOVO RASTREIO*`, `🧾 *OS:* ${_osFmt}`];

  if (link_rastreio) {
    blocos.push(`🔗 *Link:* ${link_rastreio}`);
  }

  // Codigo de coleta do Hub (99) — a loja informa ao motoboy na coleta.
  if (codigo_coleta) {
    blocos.push(`🔑 *Código de coleta:* ${codigo_coleta}`);
  }

  pontos.forEach((pe) => {
    if (pontos.length > 1) blocos.push(`*Ponto ${pe.numero}*`);
    if (pe.endereco) blocos.push(`📍 *Endereço:* ${pe.endereco}`);
    // CLIENTE_FINAL_NF_V1: fonte unica. O parser descarta o "nome" quando o
    // cliente e sabidamente so-NF (1165/1178/1188) ou quando o texto e lixo
    // (sem letras), e devolve a NF ja limpa (01-001148140-1 -> 1148140).
    const _cf = extrairClienteFinalENota({
      texto: pe.textoBruto || pe.endereco || null,
      nome: pe.nomeCliente || null,
      nota: pe.nota || null,
      clienteCod: cliente_cod,
    });
    if (_cf.cliente_final) blocos.push(`🏪 *Cliente:* ${_cf.cliente_final}`);
    if (_cf.nota_fiscal && (!_cf.cliente_final || cliente_cod === '767')) {
      blocos.push(`🧾 *NF:* ${_cf.nota_fiscal}`);
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

  // Guarda anti-duplicata: vira true assim que a mensagem do grupo sai. Se um
  // passo POSTERIOR falhar, o catch NAO reenfileira (reenviar duplicaria o
  // rastreio no grupo — causa real da duplicacao relatada).
  let grupoEnviado = false;

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
    let _hubDeliveryId = null;
    {
      const _ehHub = (await pool.query(
        "SELECT 1 FROM rastreio_clientes_config WHERE cliente_cod = $1 AND ativo = true AND usa_hub = true LIMIT 1",
        [String(cliente_cod)]
      )).rows.length > 0;
      if (_ehHub) {
        // Cliente hibrido: so seguramos quando a OS REALMENTE saiu pelo Hub
        // (existe em logistics_deliveries). Se ja tem token -> link Tutts pro
        // grupo; se ainda nao tem -> segura ate 10 min (entregador aceitar na
        // 99). OS do cliente Hub que NAO passou pelo Hub vai pro legado NA HORA.
        const _ld = (await pool.query(
          'SELECT id, rastreio_token FROM logistics_deliveries WHERE codigo_os = $1 ORDER BY id DESC LIMIT 1',
          [String(os_numero)]
        )).rows[0];
        if (_ld) {
          if (_ld.rastreio_token) {
            _hubDelivery = true;
            _tuttsToken = _ld.rastreio_token;
            _hubDeliveryId = _ld.id;
          } else {
            // 2026-06: NAO espera mais o webhook/aceite criar o token (isso
            // atrasava ate 10 min e fazia o webhook/poller mandarem o fallback
            // ANTES da captura rica). O agente cria o token ele mesmo e segue
            // como entrega Hub -> captura e manda a mensagem RICA + link do Hub
            // na hora. Idempotente: se outro emissor ja criou, reusa o atual.
            const _novoTk = require('crypto').randomBytes(9).toString('hex');
            await pool.query(
              'UPDATE logistics_deliveries SET rastreio_token = $1 WHERE id = $2 AND rastreio_token IS NULL',
              [_novoTk, _ld.id]
            ).catch(() => {});
            const _tkRow = (await pool.query('SELECT rastreio_token FROM logistics_deliveries WHERE id = $1', [_ld.id])).rows[0];
            _hubDelivery = true;
            _tuttsToken = (_tkRow && _tkRow.rastreio_token) || _novoTk;
            _hubDeliveryId = _ld.id;
          }
        }
        // _ld ausente => OS nao saiu pelo Hub (cliente hibrido) => legado imediato.
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
    // Codigo de coleta do Hub (99): busca FRESCO (o poller pode ter capturado
    // depois do lookup inicial do _ld). So p/ entrega Hub; null se ainda nao veio.
    let _codigoColeta = null;
    let _hubCreatedAt = null;
    if (_hubDeliveryId) {
      try {
        const _pc = (await pool.query('SELECT pickup_code, created_at FROM logistics_deliveries WHERE id = $1', [_hubDeliveryId])).rows[0];
        _codigoColeta = (_pc && _pc.pickup_code) || null;
        _hubCreatedAt = (_pc && _pc.created_at) || null;
      } catch (_) {}
    }
    const texto = montarMensagemRastreio({ os_numero, link_rastreio: _linkGrupo, pontos, cliente_cod, codigo_coleta: _codigoColeta });

    // 3. Envia via Evolution — usa grupo do cadastro escolhido (configMatched)
    // ou fallback pra env var legada se não houver match.
    const grupoIdOverride = resultado.configMatched
      ? resultado.configMatched.evolutionGroupId
      : null;
    if (resultado.configMatched && DEBUG_VERBOSE) {
      log(`📤 Enviando OS ${os_numero} pro cadastro "${resultado.configMatched.nomeExibicao || resultado.configMatched.id}" (grupo ${grupoIdOverride})`);
    }
    // Sempre manda pro grupo: Hub com link Tutts, legado com link Mapp.
    // Hub: CLAIM atomico via rastreio_grupo_em (UPDATE ... WHERE IS NULL RETURNING).
    // So um emissor (webhook/poller/agente) ganha; os outros pulam. Legado: sempre.
    let _mandarGrupo = true;
    if (_hubDelivery && _hubDeliveryId) {
      // Segura o rastreio ate o codigo de coleta (janela de graca). Se segurar,
      // NAO reivindica o claim -> o poller re-tenta depois (com o codigo, ou
      // passada a janela). Assim a mensagem ao grupo so sai com o codigo quando
      // aplicavel. A captura rica ja fica salva em pontos_json, entao o poller
      // reaproveita os mesmos pontos.
      if (_segurarAteCodigoColeta({ pickup_code: _codigoColeta, created_at: _hubCreatedAt })) {
        log(`⏳ OS ${os_numero}: segurando rastreio do grupo ate o codigo de coleta (janela de graca)`);
        _mandarGrupo = false;
      } else {
        const _claim = await pool.query(
          'UPDATE logistics_deliveries SET rastreio_grupo_em = NOW() WHERE id = $1 AND rastreio_grupo_em IS NULL RETURNING id',
          [_hubDeliveryId]
        ).catch(() => ({ rows: [] }));
        _mandarGrupo = _claim.rows.length > 0;
        if (!_mandarGrupo) log(`↩️ OS ${os_numero}: grupo ja recebeu o rastreio (outro emissor) - pulando duplicata`);
      }
    }
    if (_mandarGrupo) {
      try {
        await enviarRastreioWhatsApp({ texto, clienteCod: cliente_cod, grupoIdOverride });
      } catch (eGrp) {
        // envio falhou: libera o claim Hub pra um retry/fallback tentar de novo
        if (_hubDelivery && _hubDeliveryId) {
          await pool.query('UPDATE logistics_deliveries SET rastreio_grupo_em = NULL WHERE id = $1', [_hubDeliveryId]).catch(() => {});
        }
        throw eGrp;
      }
    }
    grupoEnviado = true;
    // A mensagem do grupo (acao critica) JA saiu. Persistimos 'enviado' agora,
    // antes de qualquer passo que possa falhar, para que um re-claim/retry
    // nunca reenvie pro grupo. Os passos seguintes sao best-effort.
    await pool.query(
      "UPDATE sla_capturas SET status = 'enviado', enviado_em = COALESCE(enviado_em, NOW()), atualizado_em = NOW() WHERE id = $1",
      [id]
    ).catch(() => {});
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

    // Se a mensagem do grupo JA saiu, o erro foi num passo pos-envio (update de
    // status, rastreio ao cliente final, etc). NAO reenfileira — reenviar
    // duplicaria o rastreio no grupo. Encerra como enviado.
    if (grupoEnviado) {
      logErr(`⚠️ OS ${os_numero}: erro pos-envio (grupo ja recebeu, nao reenvia): ${mensagemErro}`);
      await pool.query(
        "UPDATE sla_capturas SET status = 'enviado', enviado_em = COALESCE(enviado_em, NOW()), erro = $1, atualizado_em = NOW() WHERE id = $2",
        [`pos-envio: ${mensagemErro}`, id]
      ).catch(() => {});
      return { sucesso: true, posEnvioComErro: true };
    }

    logErr(`❌ OS ${os_numero} falhou (tentativa ${tentativaAtual}): ${mensagemErro}`);

    // 🆕 2026-07 anti-Cloudflare: bloqueio CF e TRANSITORIO e NAO e culpa da OS.
    // NAO conta como tentativa (senao esgota MAX e marca 'falhou', perdendo o
    // rastreio do cliente) e usa backoff longo pra dar tempo do IP/challenge
    // normalizar. Ajustavel via env SLA_CLOUDFLARE_BACKOFF_MS.
    if (/cloudflare_bloqueio/i.test(mensagemErro)) {
      const cfBackoff = Number(process.env.SLA_CLOUDFLARE_BACKOFF_MS || 90_000);
      const proximoCf = new Date(Date.now() + cfBackoff);
      await pool.query(
        `UPDATE sla_capturas
         SET status = 'pendente',
             erro = $1,
             proximo_retry_em = $2,
             atualizado_em = NOW()
         WHERE id = $3`,
        [mensagemErro.slice(0, 500), proximoCf, id]
      );
      logErr(`🛑 OS ${os_numero}: bloqueio Cloudflare — re-enfileirada SEM contar tentativa (retry em ${cfBackoff}ms)`);
      return { sucesso: false, esgotado: false, cloudflare: true, erro: mensagemErro };
    }

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

/**
 * Envia o rastreio Tutts (link /r/<token>) AO GRUPO imediatamente — chamado no
 * ACEITE do entregador (webhook courier_update), sem esperar o TrackingPoller
 * (30s). Resolve o grupo Hub via sla_capturas + rastreio_clientes_config (mesmo
 * caminho do poller). Idempotente via rastreio_grupo_em. Se faltar config/dados
 * (ex.: sla_capturas ainda nao pronta), retorna false e o poller cobre depois.
 * @returns {Promise<boolean>} true se enviou ao grupo
 */
async function enviarRastreioGrupoImediato(pool, deliveryId) {
  const { rows } = await pool.query(
    'SELECT id, codigo_os, rastreio_token, rastreio_grupo_em, pontos, pickup_code, created_at FROM logistics_deliveries WHERE id = $1',
    [deliveryId]
  );
  const ent = rows[0];
  if (!ent || ent.rastreio_grupo_em) return false;

  // Segura o rastreio ate o codigo de coleta chegar (janela de graca). Retorna
  // false SEM reivindicar o claim -> o poller re-tenta no proximo ciclo; quando
  // o pickup_code chegar (ou passar a janela), envia.
  if (_segurarAteCodigoColeta({ pickup_code: ent.pickup_code, created_at: ent.created_at })) {
    return false;
  }

  const { rows: capt } = await pool.query(
    'SELECT cliente_cod, pontos_json FROM sla_capturas WHERE os_numero = $1 LIMIT 1',
    [String(ent.codigo_os)]
  );
  const clienteCod0 = capt[0]?.cliente_cod || null;
  let clienteCod = clienteCod0;
  let ptsSolic = null;
  // Fallback: corrida originada no solicitacao.html NAO tem linha em sla_capturas.
  // Resolve o cliente_cod via clientes_solicitacao.tutts_id_cliente e os pontos
  // via solicitacoes_pontos, pra o link do Hub ir pro grupo configurado em
  // rastreio_clientes_config (mesmo formato dos demais).
  if (!clienteCod) {
    const { rows: sol } = await pool.query(
      `SELECT cs.tutts_id_cliente AS cliente_cod
         FROM solicitacoes_corrida sc
         JOIN clientes_solicitacao cs ON cs.id = sc.cliente_id
        WHERE sc.tutts_os_numero = $1
        ORDER BY sc.id DESC LIMIT 1`,
      [String(ent.codigo_os)]
    );
    clienteCod = (sol[0] && sol[0].cliente_cod) ? String(sol[0].cliente_cod).trim() : null;
    if (clienteCod) {
      const { rows: pcs } = await pool.query(
        `SELECT sp.ordem, sp.endereco_completo, sp.procurar_por, sp.numero_nota
           FROM solicitacoes_pontos sp
           JOIN solicitacoes_corrida sc ON sc.id = sp.solicitacao_id
          WHERE sc.tutts_os_numero = $1
          ORDER BY sp.ordem ASC`,
        [String(ent.codigo_os)]
      );
      ptsSolic = pcs.map(p => ({
        numero: p.ordem,
        endereco: p.endereco_completo || null,
        nomeCliente: p.procurar_por || null,
        nota: p.numero_nota || null,
      }));
    }
  }
  if (!clienteCod) return false;

  const { rows: grupos } = await pool.query(
    "SELECT evolution_group_id FROM rastreio_clientes_config WHERE cliente_cod = $1 AND ativo = true AND usa_hub = true AND evolution_group_id IS NOT NULL",
    [String(clienteCod)]
  );
  if (!grupos.length) return false;

  let token = ent.rastreio_token;
  if (!token) {
    token = require('crypto').randomBytes(9).toString('hex');
    await pool.query(
      'UPDATE logistics_deliveries SET rastreio_token = $1 WHERE id = $2 AND rastreio_token IS NULL',
      [token, ent.id]
    ).catch(() => {});
  }
  const base = (process.env.RASTREIO_BASE_URL || 'https://centraltutts.online').replace(/\/+$/, '');
  const linkTutts = `${base}/r/${token}`;

  let pts = capt[0] && capt[0].pontos_json;
  if (typeof pts === 'string') { try { pts = JSON.parse(pts); } catch (_) { pts = []; } }
  // Corrida do solicitacao.html (sem sla_capturas): usa os pontos da solicitacao.
  if ((!Array.isArray(pts) || !pts.length) && ptsSolic && ptsSolic.length) {
    pts = ptsSolic;
  }
  if (!Array.isArray(pts) || !pts.length) {
    // 2026-06: captura rica ainda nao pronta -> o AGENTE e o dono e manda a
    // captura RICA + link Hub. Aqui NAO mandamos o fallback (evita preempcao
    // com endereco do despacho). O poller cobre como rede de seguranca se o
    // agente falhar de vez.
    return false;
  }

  const texto = montarMensagemRastreio({
    os_numero: ent.codigo_os,
    link_rastreio: linkTutts,
    pontos: Array.isArray(pts) ? pts : [],
    cliente_cod: String(clienteCod),
    codigo_coleta: ent.pickup_code || null,
  });

  // CLAIM atomico: so um emissor (webhook/poller/agente) ganha o grupo.
  const _claim = await pool.query(
    'UPDATE logistics_deliveries SET rastreio_grupo_em = NOW() WHERE id = $1 AND rastreio_grupo_em IS NULL RETURNING id',
    [ent.id]
  ).catch(() => ({ rows: [] }));
  if (!_claim.rows.length) return false; // outro emissor ja mandou pro grupo
  let enviou = false;
  for (const g of grupos) {
    try {
      await enviarRastreioWhatsApp({ texto, clienteCod: String(clienteCod), grupoIdOverride: g.evolution_group_id });
      enviou = true;
    } catch (_) {}
  }
  if (!enviou) {
    // envio falhou: libera o claim pra um retry/fallback tentar de novo
    await pool.query('UPDATE logistics_deliveries SET rastreio_grupo_em = NULL WHERE id = $1', [ent.id]).catch(() => {});
  }
  return enviou;
}

module.exports = {
  enfileirarCaptura,
  processarCaptura,
  extrairTelefoneDeNota,
  montarMensagemRastreio,
  montarPontosFallback,
  enviarRastreioWhatsApp,
  enviarRastreioGrupoImediato,
  // expostos pra testes
  _internal: { montarMensagemRastreio, enviarRastreioWhatsApp, getGrupoIdPorCliente },
};
