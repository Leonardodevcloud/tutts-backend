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
const { getWebhookDispatcher } = require('../core/WebhookDispatcher');
const { getEventLogger, EventSource } = require('../core/EventLogger');

// provider que este poller atende. Hoje só a 99Entrega precisa de polling de
// posição (o webhook da Uber já traz lat/lng). Se outro provider sem posição
// no webhook entrar no hub, dá pra generalizar pra uma lista.
const PROVIDER_CODE = 'noventanove';
const WORKER_NAME = 'noventanove_tracking';

const DEFAULT_INTERVALO_SEG = 30;

// Entregas EM TRÂNSITO — courier já atribuído e ainda não finalizou.
// Antes de COURIER_ASSIGNED não há entregador (nada a rastrear); depois de
// DELIVERED/CANCELED/RETURNED/FAILED a entrega saiu do mapa.
const STATUS_EM_TRANSITO = [
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
      SELECT id, codigo_os, external_delivery_id
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

  /**
   * Processa uma entrega: consulta a 99, monta o evento e despacha.
   * Só envia ao dispatcher quando há novidade (1ª vez ou posição mudou) —
   * evita encher logistics_tracking de linhas idênticas com o entregador parado.
   *
   * @returns {Promise<'enviado'|'sem_novidade'|'sem_courier'>}
   */
  async function processarEntrega(adapter, entrega) {
    const det = await adapter.getDelivery(entrega.external_delivery_id);
    const evento = montarEventoCourier(det);

    // Sem courier ainda (a 99 ainda está procurando entregador) — nada a fazer.
    if (!evento.courier && !evento.location) {
      return 'sem_courier';
    }

    const chave = String(entrega.id);
    const posAtual = evento.location
      ? `${evento.location.lat},${evento.location.lng}`
      : null;
    const primeiraVez = !ultimasPosicoes.has(chave);
    const posMudou = posAtual !== ultimasPosicoes.get(chave);

    // Envia quando: 1ª vez vendo a entrega (garante a vinculação do motorista
    // na Mapp) OU a posição mudou. Posição idêntica repetida → ignora.
    if (!primeiraVez && !posMudou) {
      return 'sem_novidade';
    }

    await dispatcher.processarEventoCanonico(PROVIDER_CODE, evento);
    ultimasPosicoes.set(chave, posAtual);
    return 'enviado';
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

      let enviados = 0, semNovidade = 0, semCourier = 0, erros = 0;

      for (const entrega of entregas) {
        if (parado) break;
        try {
          const r = await processarEntrega(adapter, entrega);
          if (r === 'enviado') enviados++;
          else if (r === 'sem_novidade') semNovidade++;
          else semCourier++;
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

      if (enviados > 0 || erros > 0) {
        console.log(`📍 [TrackingPoller] ciclo: ${enviados} posição(ões) atualizada(s), ${semNovidade} sem novidade, ${semCourier} sem entregador, ${erros} erro(s) — ${entregas.length} entrega(s) em trânsito`);
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
