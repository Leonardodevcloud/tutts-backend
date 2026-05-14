/**
 * UBER ADAPTER — Status Map
 *
 * Mapeia status nativo da Uber Direct → CanonicalStatus do hub.
 *
 * Status oficiais documentados pela Uber Direct:
 *   pending          — delivery created, no courier assigned
 *   pickup           — courier en route to pickup
 *   pickup_complete  — courier picked up, en route to dropoff
 *   dropoff          — courier arrived at dropoff location
 *   delivered        — successfully delivered
 *   canceled         — canceled (any reason)
 *   returned         — returned to sender
 *
 * Doc: https://developer.uber.com/docs/deliveries/references/api/webhooks
 *
 * Outros valores que podem aparecer (mapeados conservadoramente):
 *   - sem entregador no timeout → tratado fora do map (ver Orchestrator.verifyTimeouts)
 *   - failed (não documentado, mas eventualmente aparece) → FAILED
 *   - qualquer outro desconhecido → DISPATCHED (estado seguro, NÃO finaliza Mapp)
 */

const { CanonicalStatus } = require('../../contracts/CanonicalStatus');

/**
 * Tabela de tradução.
 * Cobre TODOS os status documentados + alguns variantes vistos em produção.
 */
const UBER_TO_CANONICAL = Object.freeze({
  // Pré-coleta
  pending:          CanonicalStatus.DISPATCHED,
  pickup:           CanonicalStatus.PICKUP_EN_ROUTE,

  // Pós-coleta
  pickup_complete:  CanonicalStatus.PICKED_UP,
  dropoff:          CanonicalStatus.ARRIVED_DROPOFF,

  // Terminais
  delivered:        CanonicalStatus.DELIVERED,
  canceled:         CanonicalStatus.CANCELED,
  cancelled:        CanonicalStatus.CANCELED,  // variante britânica vista em alguns payloads
  returned:         CanonicalStatus.RETURNED,
  failed:           CanonicalStatus.FAILED,
});

/**
 * Converte status nativo Uber → canônico.
 * Retorna DISPATCHED para status desconhecido (conservador — não dispara
 * finalização Mapp por status que não entendemos).
 *
 * @param {string} nativeStatus
 * @returns {string}  Valor de CanonicalStatus
 */
function nativeToCanonical(nativeStatus) {
  if (!nativeStatus || typeof nativeStatus !== 'string') {
    return CanonicalStatus.DISPATCHED;
  }
  const mapped = UBER_TO_CANONICAL[nativeStatus.toLowerCase()];
  if (mapped) return mapped;
  console.warn(`[UberAdapter] status nativo desconhecido: "${nativeStatus}" — assumindo DISPATCHED`);
  return CanonicalStatus.DISPATCHED;
}

module.exports = {
  UBER_TO_CANONICAL,
  nativeToCanonical,
};
