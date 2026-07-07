/**
 * MÓDULO LOGISTICS — TrackingPoller
 *
 * Worker de polling de POSIÇÃO do entregador. Existe pra cobrir providers cujo
 * webhook NÃO traz lat/lng — caso da 99Entrega: os 9 eventos de webhook dela
 * são só marcos de status, sem coordenada. A posição ao vivo só sai do
 * GET /v2/order/detail (driver_info.location).
 *
 * Como funciona:
 *  - A cada N segundos, lista as entregas EM TRÂNSITO de um provider
 *    (status entre COURIER_ASSIGNED e ARRIVED_DROPOFF — courier já existe).
 *  - Pra cada entrega: adapter.getDelivery(externalDeliveryId) → pega a posição
 *    do entregador no driver_info.
 *  - Monta um CanonicalEvent 'courier_update' e entrega ao WebhookDispatcher
 *    via processarEventoCanonico() — exatamente o mesmo pipeline dos webhooks:
 *    grava em logistics_tracking, vincula o motorista na Mapp (1ª vez) e faz
 *    broadcast WebSocket. Zero duplicação de lógica.
 *
 * CONTROLE POR BANCO (igual ao PollingWorker, sem deploy):
 *  logistics_worker_state.worker_name = 'noventanove_tracking'
 *    ativo = false → worker dorme (loga "standby" esporádico, não chama a API)
 *    ativo = true  → faz o polling de posição
 *  intervalo_segundos controla o ritmo (default 30s).
 *
 * Ligar/desligar é UPDATE SQL:
 *   UPDATE logistics_worker_state SET ativo = true
 *    WHERE worker_name = 'noventanove_tracking';
 *
 * NÃO mexe em status: as transições de status da 99 continuam 100% via webhook
 * (DriverAccepted, OrderCompleted, etc.). Este worker só cuida da POSIÇÃO.
 *
 * setTimeout recursivo (não setInterval) — mudança de intervalo pega em runtime.
 */

const { getProviderRegistry } = require('../core/ProviderRegistry');
const { resolverDestinoViaPonte } = require('../core/PonteRastreioCliente');
const { enviarCodigoColeta, enviarCodigoEntrega, enviarRastreioCliente, normalizarTelefone } = require('../logistics.whatsapp');
const crypto = require('crypto');
const RASTREIO_BASE_URL = (process.env.RASTREIO_BASE_URL || 'https://centraltutts.online').replace(/\/+$/, '');
const { getWebhookDispatcher } = require('../core/WebhookDispatcher');
const { getEventLogger, EventSource } = require('../core/EventLogger');

// provider que este poller atende. Hoje só a 99Entrega precisa de polling de
// posição (o webhook da Uber já traz lat/lng). Se outro provider sem posição
// no webhook entrar no hub, dá pra generalizar pra uma lista.
const PROVIDER_CODE = 'noventanove';
const WORKER_NAME = 'noventanove_tracking';

const DEFAULT_INTERVALO_SEG = 30;

// Status que o poller acompanha. Inclui DISPATCHED de propósito: a doc da 99
// avisa que o webhook NÃO tem entrega garantida ("use the order details API").
// Se o DriverAccepted se perder, a entrega ficaria presa em DISPATCHED pra
// sempre. Pollando o /detail desde DISPATCHED, o poller descobre o courier
// (status waiting/delivering) e avança a entrega mesmo sem o webhook — vira a
// rede de segurança do webhook, não só rastreador de posição.
// Antes de DISPATCHED (PENDING/QUOTED) não há pedido na 99 — nada a consultar.
// Depois de DELIVERED/CANCELED/RETURNED/FAILED a entrega saiu do mapa.
const STATUS_EM_TRANSITO = [
  'DISPATCHED',
  'COURIER_ASSIGNED',
  'PICKUP_EN_ROUTE',
  'ARRIVED_PICKUP',
  'PICKED_UP',
  'DROPOFF_EN_ROUTE',
  'ARRIVED_DROPOFF',
];

/**
 * Inicia o TrackingPoller.
 *
 * @param {import('pg').Pool} pool
 * @returns {{ parar: Function }}
 */
function startTrackingPoller(pool) {
  let timeoutRef = null;
  let rodando = false;
  let parado = false;
  let logStandbyContador = 0;

  const registry = getProviderRegistry(pool);
  const dispatcher = getWebhookDispatcher(pool);
  const events = getEventLogger(pool);

  // Última posição enviada por entrega — evita inserir linha idêntica em
  // logistics_tracking quando o entregador está parado. Chave: delivery_id.
  // Valor: "lat,lng" ou null. In-memory: após restart, no máximo reenvía uma
  // posição (inofensivo).
  const ultimasPosicoes = new Map();

  /**
   * Lê estado do worker em logistics_worker_state. Cria a linha se faltar.
   * @returns {Promise<{ativo: boolean, intervalo_segundos: number}>}
   */
  async function lerEstado() {
    try {
      const { rows } = await pool.query(`
        SELECT ativo, intervalo_segundos
        FROM logistics_worker_state
        WHERE worker_name = $1
      `, [WORKER_NAME]);

      if (rows.length === 0) {
        // Linha não existe (migration não rodou?) — cria desativada
        await pool.query(`
          INSERT INTO logistics_worker_state (worker_name, ativo, intervalo_segundos)
          VALUES ($1, false, $2)
          ON CONFLICT (worker_name) DO NOTHING
        `, [WORKER_NAME, DEFAULT_INTERVALO_SEG]);
        return { ativo: false, intervalo_segundos: DEFAULT_INTERVALO_SEG };
      }
      return rows[0];
    } catch (err) {
      console.error('❌ [TrackingPoller] erro ao ler estado:', err.message);
      // Fail-safe: inativo se não consegue ler estado
      return { ativo: false, intervalo_segundos: DEFAULT_INTERVALO_SEG };
    }
  }

  /** Atualiza o timestamp do último ciclo (telemetria). */
  async function marcarCiclo() {
    try {
      await pool.query(`
        UPDATE logistics_worker_state
        SET ultimo_ciclo_em = NOW(), updated_at = NOW()
        WHERE worker_name = $1
      `, [WORKER_NAME]);
    } catch (err) { /* silencioso — só telemetria */ }
  }

  /**
   * Busca as entregas da 99 que estão em trânsito.
   * @returns {Promise<Array<{id, codigo_os, external_delivery_id}>>}
   */
  async function buscarEntregasEmTransito() {
    const { rows } = await pool.query(`
      SELECT id, codigo_os, external_delivery_id, pickup_code, dropoff_code, return_code, codigo_wpp_enviado, rastreio_wpp_enviado, telefone_entrega, rastreio_grupo_em
      FROM logistics_deliveries
      WHERE provider_code = $1
        AND status_canonico = ANY($2)
        AND external_delivery_id IS NOT NULL
      ORDER BY id ASC
    `, [PROVIDER_CODE, STATUS_EM_TRANSITO]);
    return rows;
  }

  /**
   * Converte o retorno de adapter.getDelivery() num CanonicalEvent
   * 'courier_update' — o formato que o WebhookDispatcher já sabe processar.
   *
   * @param {import('../contracts/CanonicalTypes').CanonicalDelivery} det
   * @returns {import('../contracts/CanonicalTypes').CanonicalEvent}
   */
  function montarEventoCourier(det) {
    const c = det.courier || {};
    const temLoc = c.lat != null && c.lng != null;
    return {
      eventType: 'courier_update',
      externalDeliveryId: det.externalDeliveryId,
      statusCanonico: det.statusCanonico,
      statusNative: det.statusNative,
      trackingUrl: det.trackingUrl || null,
      courier: (c.name || c.phone) ? {
        name:    c.name || null,
        phone:   c.phone || null,
        plate:   c.plate || null,
        vehicle: c.vehicle || null,
        photo:   c.photo || null,
        rating:  c.rating != null ? c.rating : null,
      } : null,
      location: temLoc ? { lat: c.lat, lng: c.lng } : null,
    };
  }

  // Ordem dos status canônicos — usada pra saber se o /detail revelou um
  // avanço em relação ao que o hub tem. Só avançamos pra frente; o poller
  // nunca regride status (regressão é responsabilidade do webhook/cancelamento).
  const ORDEM_STATUS = [
    'PENDING', 'QUOTED', 'DISPATCHED', 'COURIER_ASSIGNED',
    'PICKUP_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP',
    'DROPOFF_EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED',
  ];
  function indiceStatus(s) {
    const i = ORDEM_STATUS.indexOf(s);
    return i === -1 ? -1 : i;
  }

  /**
   * Processa uma entrega: consulta a 99 e despacha o que for novidade.
   *
   * Faz DUAS coisas (a 99 não garante entrega do webhook — a doc manda usar o
   * /detail como fonte de verdade):
   *  1. STATUS: se o /detail revela um status mais avançado que o do hub,
   *     emite um 'status_change' — isso dispara a ação Mapp correspondente.
   *     É a rede de segurança pra webhook perdido.
   *  2. POSIÇÃO: se há courier com lat/lng nova, emite 'courier_update'.
   *
   * Só envia ao dispatcher quando há novidade real — evita ação Mapp repetida
   * e linha de tracking duplicada.
   *
   * @returns {Promise<'avancou'|'posicao'|'avancou_posicao'|'sem_novidade'|'sem_courier'>}
   */
  async function processarEntrega(adapter, entrega) {
    const det = await adapter.getDelivery(entrega.external_delivery_id);

    let avancou = false;

    // ─── 1. STATUS — rede de segurança do webhook ───
    // Se o /detail reporta status mais à frente do que o hub registrou,
    // emite status_change. O WebhookDispatcher cuida da idempotência e da
    // ação Mapp. Terminais (DELIVERED) também passam por aqui.
    const idxDetail = indiceStatus(det.statusCanonico);
    const idxHub = indiceStatus(entrega.status_canonico);
    // Terminais RETURNED/CANCELED/FAILED NAO estao na ORDEM_STATUS (indice -1),
    // entao o avanco normal nunca os alcanca e a entrega fica presa no poll pra
    // sempre (99 reporta sendbackCompleted/canceled/closed mas o hub nunca
    // sincroniza -> poller vivo 24/7). Detectamos esses terminais e sincronizamos
    // o status local (a entrega sai do STATUS_EM_TRANSITO). Usamos skipMappAction:
    // a acao Mapp (finalizar/reabrir) e do webhook em tempo real; nao a refazemos
    // aqui pra nao reabrir OS antigas. DELIVERED continua pelo avanco normal (esta
    // na ORDEM) e mantem a acao Mapp de finalizacao.
    const TERMINAIS_FORA_ORDEM = ['CANCELED', 'RETURNED', 'FAILED'];
    const TERMINAIS = ['DELIVERED', 'CANCELED', 'RETURNED', 'FAILED'];
    const avancoNormal = det.statusCanonico && idxDetail > idxHub && idxDetail !== -1;
    const avancoTerminal = TERMINAIS_FORA_ORDEM.includes(det.statusCanonico)
      && !TERMINAIS.includes(entrega.status_canonico);
    if (avancoNormal || avancoTerminal) {
      await dispatcher.processarEventoCanonico(PROVIDER_CODE, {
        eventType: 'status_change',
        externalDeliveryId: det.externalDeliveryId,
        statusCanonico: det.statusCanonico,
        statusNative: det.statusNative,
        trackingUrl: det.trackingUrl || null,
        rawProvider: det.rawProvider || null,
        skipMappAction: avancoTerminal,
      });
      avancou = true;
    }

    // ─── 1b. RECONCILIACAO DE PRECO (99) ───
    // O /detail traz price_info (preco + taxas). Em status terminal isso e o
    // valor final. Grava uma vez (a entrega sai do polling depois disso).
    if (det.precoProvider && det.precoProvider.fee != null
        && ['DELIVERED', 'CANCELED', 'RETURNED', 'FAILED'].includes(det.statusCanonico)) {
      await pool.query(
        `UPDATE logistics_deliveries SET
           valor_provider_final = $1, taxa_entrega_99 = $2,
           taxa_devolucao_99 = $3, taxa_sendback_99 = $4, updated_at = NOW()
         WHERE id = $5`,
        [det.precoProvider.fee, det.precoProvider.deliveryFee,
         det.precoProvider.returnFee, det.precoProvider.sendbackFee, entrega.id]
      ).catch((e) => console.error('[TrackingPoller] erro ao persistir preco 99:', e.message));
    }

    // ─── 2. POSIÇÃO / courier ───
    const evento = montarEventoCourier(det);
    if (!evento.courier && !evento.location) {
      // Sem entregador ainda (a 99 ainda procura) — status pode ter avançado.
      return avancou ? 'avancou' : 'sem_courier';
    }

    const chave = String(entrega.id);
    const posAtual = evento.location
      ? `${evento.location.lat},${evento.location.lng}`
      : null;
    const primeiraVez = !ultimasPosicoes.has(chave);
    const posMudou = posAtual !== ultimasPosicoes.get(chave);

    // Envia courier_update quando: 1ª vez vendo o courier (vincula motorista
    // na Mapp) OU a posição mudou. Posição idêntica repetida → ignora.
    if (primeiraVez || posMudou) {
      await dispatcher.processarEventoCanonico(PROVIDER_CODE, evento);
      ultimasPosicoes.set(chave, posAtual);
      return avancou ? 'avancou_posicao' : 'posicao';
    }

    return avancou ? 'avancou' : 'sem_novidade';
  }

  /** Um ciclo completo do poller. */
  async function executarCiclo() {
    if (rodando || parado) return;
    rodando = true;

    let intervaloProximo = DEFAULT_INTERVALO_SEG;

    try {
      const estado = await lerEstado();
      intervaloProximo = estado.intervalo_segundos || DEFAULT_INTERVALO_SEG;

      // ─── Desligado: dorme ───
      if (!estado.ativo) {
        logStandbyContador++;
        if (logStandbyContador % 20 === 1) {
          console.log('🛌 [TrackingPoller] standby (logistics_worker_state.ativo=false)');
        }
        rodando = false;
        agendarProximo(intervaloProximo);
        return;
      }

      // ─── Adapter da 99 precisa estar ativo no registry ───
      const adapter = registry.get(PROVIDER_CODE);
      if (!adapter) {
        // Provider 99 inativo — nada a rastrear. Loga esporádico.
        logStandbyContador++;
        if (logStandbyContador % 20 === 1) {
          console.log(`🛌 [TrackingPoller] provider '${PROVIDER_CODE}' inativo — nada a rastrear`);
        }
        await marcarCiclo();
        rodando = false;
        agendarProximo(intervaloProximo);
        return;
      }

      // ─── Busca entregas em trânsito e poolea cada uma ───
      const entregas = await buscarEntregasEmTransito();

      // Limpa do cache as entregas que já saíram do trânsito (finalizadas)
      const idsAtivos = new Set(entregas.map(e => String(e.id)));
      for (const chave of ultimasPosicoes.keys()) {
        if (!idsAtivos.has(chave)) ultimasPosicoes.delete(chave);
      }

      if (entregas.length === 0) {
        await marcarCiclo();
        rodando = false;
        agendarProximo(intervaloProximo);
        return;
      }

      let avancos = 0, posicoes = 0, semNovidade = 0, semCourier = 0, erros = 0;

      for (const entrega of entregas) {
        if (parado) break;
        try {
          const r = await processarEntrega(adapter, entrega);
          if (r === 'avancou') avancos++;
          else if (r === 'posicao') posicoes++;
          else if (r === 'avancou_posicao') { avancos++; posicoes++; }
          else if (r === 'sem_novidade') semNovidade++;
          else semCourier++;

          // Para 99Entrega: quando getDelivery retorna código pela 1ª vez,
          // salva no banco e envia WhatsApp (a 99 não tem evento de webhook pra isso)
          if (PROVIDER_CODE === 'noventanove' && r !== 'erro') {
            try {
              const det = await adapter.getDelivery(entrega.external_delivery_id);
              console.log(`🔎 [TrackingPoller] OS ${entrega.codigo_os} detail: pickup=${det.pickupCode || 'null'} dropoff=${det.dropoffCode || 'null'} courier=${det.courier ? (det.courier.name || 'sem-nome') : 'null'} tel=${entrega.telefone_entrega || 'null'} wppEnviado=${entrega.codigo_wpp_enviado || false}`);
              const temNovoCodigo = (
                (det.pickupCode  && !entrega.pickup_code)  ||
                (det.dropoffCode && !entrega.dropoff_code) ||
                (det.returnCode  && !entrega.return_code)
              );
              if (temNovoCodigo) {
                await pool.query(
                  'UPDATE logistics_deliveries SET pickup_code = COALESCE($1, pickup_code), dropoff_code = COALESCE($2, dropoff_code), return_code = COALESCE($3, return_code), updated_at = NOW() WHERE id = $4',
                  [det.pickupCode || null, det.dropoffCode || null, det.returnCode || null, entrega.id]
                );
                // Envia WhatsApp do dropoff_code se ainda não enviado
                if (det.dropoffCode && !entrega.dropoff_code && !entrega.codigo_wpp_enviado) {
                  const { rows: r2 } = await pool.query(
                    'SELECT telefone_entrega, pontos FROM logistics_deliveries WHERE id = $1',
                    [entrega.id]
                  );
                  const telEntrega = r2[0]?.telefone_entrega || null;
                  if (telEntrega) {
                    const pts = r2[0]?.pontos || [];
                    const ultimo = Array.isArray(pts) ? pts[pts.length - 1] : null;
                    enviarCodigoEntrega(telEntrega, {
                      codigoOS: entrega.codigo_os,
                      codigo: det.dropoffCode,
                      providerNome: '99Entrega',
                      nomeDestinatario: ultimo?.nome || '',
                    }).then(wppR => {
                      if (wppR.enviado) {
                        pool.query(
                          'UPDATE logistics_deliveries SET codigo_wpp_enviado = TRUE WHERE id = $1',
                          [entrega.id]
                        ).catch(() => {});
                      }
                    }).catch(() => {});
                  }
                }
                console.log(`🔑 [TrackingPoller] OS ${entrega.codigo_os}: código(s) 99 detectado(s) e salvos`);
              }

              // 🆕 Rastreio Tutts: quando a 99 expoe o link (waiting+, prova de que
              // o entregador aceitou), geramos o token proprio e mandamos o link da
              // Tutts (centraltutts.online/r/<token>) UMA vez pro destinatario E pra
              // loja. O cliente nunca ve a 99.
              if (det.trackingUrl && !entrega.rastreio_wpp_enviado) {
                const { rows: r3 } = await pool.query(
                  'SELECT telefone_entrega, pontos, rastreio_token FROM logistics_deliveries WHERE id = $1',
                  [entrega.id]
                );
                let token = r3[0]?.rastreio_token || null;
                if (!token) {
                  token = crypto.randomBytes(9).toString('hex');
                  await pool.query(
                    'UPDATE logistics_deliveries SET rastreio_token = $1 WHERE id = $2 AND rastreio_token IS NULL',
                    [token, entrega.id]
                  ).catch(() => {});
                }
                const linkTutts = `${RASTREIO_BASE_URL}/r/${token}`;

                // Cliente Hub: o link Tutts tambem vai pro GRUPO, no mesmo template
                // do rastreio-cliente. (O link legado desses clientes ja foi
                // suprimido no RPA via flag usa_hub.)
                if (!entrega.rastreio_grupo_em) try {
                  const { rows: capt } = await pool.query(
                    'SELECT cliente_cod, pontos_json, status FROM sla_capturas WHERE os_numero = $1 LIMIT 1',
                    [String(entrega.codigo_os)]
                  );
                  const clienteCodHub = capt[0]?.cliente_cod || null;
                  if (clienteCodHub) {
                    const { rows: gruposHub } = await pool.query(
                      "SELECT evolution_group_id FROM rastreio_clientes_config WHERE cliente_cod = $1 AND ativo = true AND usa_hub = true AND evolution_group_id IS NOT NULL",
                      [String(clienteCodHub)]
                    );
                    if (gruposHub.length) {
                      const sla = require('../../agent/sla-capture.service');
                      let ptsHub = capt[0].pontos_json;
                      if (typeof ptsHub === 'string') { try { ptsHub = JSON.parse(ptsHub); } catch (_) { ptsHub = []; } }
                      // 2026-06: o AGENTE e o dono do rastreio Hub (manda a captura
                      // RICA + link Hub). Se a captura ainda nao esta pronta, so
                      // mandamos aqui como REDE DE SEGURANCA quando o agente ja
                      // FALHOU de vez (status 'falhou'); senao deferimos pro agente.
                      if (!Array.isArray(ptsHub) || !ptsHub.length) {
                        if (capt[0] && capt[0].status === 'falhou') {
                          ptsHub = sla.montarPontosFallback(r3[0] && r3[0].pontos);
                        } else {
                          ptsHub = [];
                        }
                      }
                      if (Array.isArray(ptsHub) && ptsHub.length) {
                        const textoHub = sla.montarMensagemRastreio({
                          os_numero: entrega.codigo_os,
                          link_rastreio: linkTutts,
                          pontos: ptsHub,
                          cliente_cod: String(clienteCodHub),
                        });
                        // CLAIM atomico (consistente com webhook/agente): so manda se ganhar.
                        const _claimP = await pool.query(
                          'UPDATE logistics_deliveries SET rastreio_grupo_em = NOW() WHERE id = $1 AND rastreio_grupo_em IS NULL RETURNING id',
                          [entrega.id]
                        ).catch(() => ({ rows: [] }));
                        if (_claimP.rows.length) {
                          let enviouGrupo = false;
                          for (const g of gruposHub) {
                            try {
                              await sla.enviarRastreioWhatsApp({ texto: textoHub, clienteCod: String(clienteCodHub), grupoIdOverride: g.evolution_group_id });
                              enviouGrupo = true;
                            } catch (_) {}
                          }
                          if (enviouGrupo) {
                            await pool.query('UPDATE logistics_deliveries SET rastreio_wpp_enviado = TRUE WHERE id = $1', [entrega.id]).catch(() => {});
                          } else {
                            await pool.query('UPDATE logistics_deliveries SET rastreio_grupo_em = NULL WHERE id = $1', [entrega.id]).catch(() => {});
                          }
                        }
                      }
                    }
                  }
                } catch (e) { console.warn(`grupo Hub OS ${entrega.codigo_os}:`, e.message); }
                const pts = Array.isArray(r3[0]?.pontos) ? r3[0].pontos
                          : (r3[0]?.pontos ? JSON.parse(r3[0].pontos) : []);
                let telDestino = r3[0]?.telefone_entrega || null;
                if (!telDestino) {
                  try {
                    telDestino = (await resolverDestinoViaPonte(pool, entrega.codigo_os)).telefone || null;
                    if (telDestino) {
                      await pool.query(
                        'UPDATE logistics_deliveries SET telefone_entrega = $1 WHERE id = $2 AND telefone_entrega IS NULL',
                        [telDestino, entrega.id]
                      ).catch(() => {});
                    }
                  } catch (_) {}
                }
                const telLoja    = (pts[0]?.telefone || pts[0]?.fone) || null;
                const nomeDestino = pts.length ? (pts[pts.length - 1]?.nome || '') : '';
                const destinos = [];
                if (telDestino) destinos.push({ tel: telDestino, papel: 'destinatario', nome: nomeDestino });
                if (telLoja && normalizarTelefone(telLoja) !== normalizarTelefone(telDestino)) {
                  destinos.push({ tel: telLoja, papel: 'loja', nome: '' });
                }
                if (destinos.length) {
                  Promise.all(destinos.map((dst) =>
                    enviarRastreioCliente(dst.tel, {
                      codigoOS: entrega.codigo_os,
                      link: linkTutts,
                      providerNome: 'Tutts',
                      nomeDestinatario: dst.nome,
                      papel: dst.papel,
                      codigoColeta: entrega.pickup_code || '',
                    }).catch(() => ({ enviado: false }))
                  )).then((resultados) => {
                    if (resultados.some((x) => x && x.enviado)) {
                      pool.query(
                        'UPDATE logistics_deliveries SET rastreio_wpp_enviado = TRUE WHERE id = $1',
                        [entrega.id]
                      ).catch(() => {});
                      console.log(`📍 [TrackingPoller] OS ${entrega.codigo_os}: link de rastreio Tutts enviado (${destinos.map(d=>d.papel).join('+')})`);
                    }
                  }).catch(() => {});
                }
              }
            } catch (_e) { console.warn(`⚠️ [TrackingPoller] codigo/wpp OS ${entrega.codigo_os}: ${_e.message}`); }
          }
        } catch (err) {
          erros++;
          console.error(`❌ [TrackingPoller] OS ${entrega.codigo_os} (delivery ${entrega.id}):`, err.message);
          events.logError(PROVIDER_CODE, err, {
            eventSource: EventSource.WORKER,
            codigoOS: entrega.codigo_os,
            deliveryId: entrega.id,
            externalDeliveryId: entrega.external_delivery_id,
          }).catch(() => {});
        }
      }

      await marcarCiclo();

      if (avancos > 0 || posicoes > 0 || erros > 0) {
        console.log(`📍 [TrackingPoller] ciclo: ${avancos} status avançado(s), ${posicoes} posição(ões) nova(s), ${semNovidade} sem novidade, ${semCourier} sem entregador, ${erros} erro(s) — ${entregas.length} entrega(s) acompanhada(s)`);
      }

    } catch (error) {
      console.error('❌ [TrackingPoller] erro no ciclo:', error.message);
      events.logError(PROVIDER_CODE, error, { eventSource: EventSource.WORKER }).catch(() => {});
    }

    rodando = false;
    agendarProximo(intervaloProximo);
  }

  function agendarProximo(seg) {
    if (parado) return;
    timeoutRef = setTimeout(executarCiclo, Math.max(5, seg) * 1000);
    if (typeof timeoutRef.unref === 'function') timeoutRef.unref();
  }

  async function iniciar() {
    try {
      const estado = await lerEstado();
      console.log(`🚀 [TrackingPoller] iniciado (ativo=${estado.ativo}, intervalo=${estado.intervalo_segundos || DEFAULT_INTERVALO_SEG}s, provider=${PROVIDER_CODE})`);
      await executarCiclo();
    } catch (error) {
      console.error('❌ [TrackingPoller] erro ao iniciar:', error.message);
      setTimeout(() => iniciar(), 60_000);
    }
  }

  iniciar();

  return {
    parar: () => {
      parado = true;
      if (timeoutRef) clearTimeout(timeoutRef);
      console.log('🛑 [TrackingPoller] parado');
    },
  };
}

module.exports = { startTrackingPoller };
