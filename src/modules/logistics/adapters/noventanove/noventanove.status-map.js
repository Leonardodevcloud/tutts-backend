/**
 * NINETYNINE ADAPTER — Status Map
 *
 * A 99 tem DOIS conjuntos de status diferentes:
 *
 *  1. Status de WEBHOOK (subscription 'ride-status') — texto kebab-case:
 *     finding, no-drivers-available, canceled-by-passenger, canceled-by-driver,
 *     on-the-way, arrived, in-progress, finished
 *
 *  2. Status de GET /rides (campo running.status) — UPPER_SNAKE_CASE:
 *     WAITING_DRIVERS_ANSWERS, COULDNT_FIND_AVAILABLE_DRIVERS, DRIVERS_REJECTED,
 *     CAR_ON_THE_WAY, WAITING_FOR_PASSENGER, CAR_ARRIVED, CANCELED_BY_DRIVER,
 *     CANCELED_BY_PASSENGER, RIDE_ENDED
 *
 * Os dois mapeiam pro mesmo CanonicalStatus, mas vêm de lugares diferentes.
 *
 * IMPORTANTE — diferença conceitual vs Uber:
 * A 99 é uma API de "corrida" (passageiro) adaptada pra entrega. O ciclo dela
 * não tem os status intermediários de delivery que a Uber tem (chegou no
 * destino, etc). Mapeamento conceitual:
 *   - "arrived"     = motorista chegou na COLETA (não no destino)
 *   - "in-progress" = corrida rolando = item COLETADO, a caminho do destino
 *   - "finished"    = ENTREGUE (não há evento separado de "chegou no destino")
 *
 * Doc: https://github.com/99Taxis/corp-api-v2-documentation#status-de-corridas
 */

const { CanonicalStatus } = require('../../contracts/CanonicalStatus');

/**
 * Mapa dos status de WEBHOOK (ride-status) → canônico.
 * É o que o WebhookDispatcher consome.
 */
const WEBHOOK_STATUS_TO_CANONICAL = Object.freeze({
  'finding':                CanonicalStatus.DISPATCHED,
  'no-drivers-available':   CanonicalStatus.FAILED,
  'canceled-by-passenger':  CanonicalStatus.CANCELED,
  'canceled-by-driver':     CanonicalStatus.CANCELED,
  'on-the-way':             CanonicalStatus.PICKUP_EN_ROUTE,
  'arrived':                CanonicalStatus.ARRIVED_PICKUP,
  'in-progress':            CanonicalStatus.PICKED_UP,
  'finished':               CanonicalStatus.DELIVERED,
});

/**
 * Mapa dos status de GET /rides (running.status) → canônico.
 * Usado pelo getDelivery (sync manual).
 */
const RIDE_STATUS_TO_CANONICAL = Object.freeze({
  'WAITING_DRIVERS_ANSWERS':        CanonicalStatus.DISPATCHED,
  'COULDNT_FIND_AVAILABLE_DRIVERS': CanonicalStatus.FAILED,
  'DRIVERS_REJECTED':               CanonicalStatus.FAILED,
  'CAR_ON_THE_WAY':                 CanonicalStatus.PICKUP_EN_ROUTE,
  'WAITING_FOR_PASSENGER':          CanonicalStatus.ARRIVED_PICKUP,
  'CAR_ARRIVED':                    CanonicalStatus.PICKED_UP,
  'CANCELED_BY_DRIVER':             CanonicalStatus.CANCELED,
  'CANCELED_BY_PASSENGER':          CanonicalStatus.CANCELED,
  'RIDE_ENDED':                     CanonicalStatus.DELIVERED,
});

/**
 * Status finais (não sofrem mais alteração) — vindos do webhook.
 * Útil pra idempotência e pra saber quando parar de esperar updates.
 */
const WEBHOOK_STATUS_FINAIS = Object.freeze([
  'no-drivers-available',
  'canceled-by-passenger',
  'canceled-by-driver',
  'finished',
]);

/**
 * Converte status nativo da 99 (de webhook OU de GET /rides) → canônico.
 * Tenta os dois mapas. Retorna DISPATCHED pra desconhecido (conservador).
 *
 * @param {string} nativeStatus
 * @returns {string} valor de CanonicalStatus
 */
function nativeToCanonical(nativeStatus) {
  if (!nativeStatus || typeof nativeStatus !== 'string') {
    return CanonicalStatus.DISPATCHED;
  }
  // Webhook status (kebab-case, lowercase)
  const porWebhook = WEBHOOK_STATUS_TO_CANONICAL[nativeStatus.toLowerCase()];
  if (porWebhook) return porWebhook;

  // Ride status (UPPER_SNAKE)
  const porRide = RIDE_STATUS_TO_CANONICAL[nativeStatus.toUpperCase()];
  if (porRide) return porRide;

  console.warn(`[NinetyNineAdapter] status nativo desconhecido: "${nativeStatus}" — assumindo DISPATCHED`);
  return CanonicalStatus.DISPATCHED;
}

module.exports = {
  WEBHOOK_STATUS_TO_CANONICAL,
  RIDE_STATUS_TO_CANONICAL,
  WEBHOOK_STATUS_FINAIS,
  nativeToCanonical,
};
