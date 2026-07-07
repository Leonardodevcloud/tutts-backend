/**
 * NINETYNINE ADAPTER — Status Map (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 — antes este map cobria a "99 Corp API" (corridas de
 * passageiro). A 99Entrega (delivery) tem dois vocabulários DIFERENTES:
 *
 *  1. STATUS DO PEDIDO — campo `status` em GET /v2/order/detail. São 7:
 *       finding     — buscando entregador
 *       waiting     — entregador atribuído, a caminho da coleta
 *       delivering  — pacote coletado, a caminho da entrega
 *       completed   — entregue
 *       canceled    — cancelado
 *       closed      — pedido encerrado/liquidado (estado administrativo final)
 *       sendback    — devolução em andamento ao remetente
 *
 *  2. EVENTOS DE WEBHOOK — marcos do ciclo. São 9 (CamelCase):
 *       DriverAccepted     — entregador aceitou
 *       DriverArrived      — entregador chegou na COLETA
 *       DriverBeginCharge  — entregador pegou o pacote (coletou)
 *       DriverCanceled     — entregador desistiu (pode trazer new_order_id → reatribuição)
 *       BroadcastTimeout   — ninguém aceitou no tempo limite
 *       OrderCompleted     — entregue
 *       OrderClosed        — pedido encerrado (administrativo, pós-conclusão)
 *       SendBack           — devolução iniciada
 *       SendBackCompleted  — devolução concluída
 *
 * Os dois vocabulários mapeiam pro mesmo CanonicalStatus do hub.
 *
 * Doc: https://entrega-api.99app.com/docs/en/
 *
 * IMPORTANTE — diferença conceitual vs Uber:
 * A 99Entrega NÃO tem evento de "chegou no destino" separado — `OrderCompleted`
 * já é a entrega. Por isso não há ARRIVED_DROPOFF no ciclo da 99. Mapeamento:
 *   - DriverArrived      = chegou na COLETA  → ARRIVED_PICKUP
 *   - DriverBeginCharge  = coletou           → PICKED_UP
 *   - OrderCompleted     = ENTREGUE          → DELIVERED
 */

const { CanonicalStatus } = require('../../contracts/CanonicalStatus');

/**
 * Mapa dos STATUS de pedido (GET /v2/order/detail.status) → canônico.
 * Usado pelo getDelivery (sync manual) e pelo polling de tracking.
 */
const ORDER_STATUS_TO_CANONICAL = Object.freeze({
  'finding':    CanonicalStatus.DISPATCHED,
  'waiting':    CanonicalStatus.COURIER_ASSIGNED,
  'delivering': CanonicalStatus.PICKED_UP,
  'completed':  CanonicalStatus.DELIVERED,
  'canceled':   CanonicalStatus.CANCELED,
  'cancelled':  CanonicalStatus.CANCELED,   // variante britânica, defensivo
  'closed':     CanonicalStatus.FAILED,     // doc 99: overdue/sem courier OU fechado pelo suporte — NAO e entrega
  'sendback':   CanonicalStatus.RETURNING,   // devolucao EM ANDAMENTO (nao-terminal; poller segue capturando codigo/posicao)
  'sendbackcompleted': CanonicalStatus.RETURNED,  // devolucao concluida (doc: sendbackCompleted)
});

/**
 * Mapa dos EVENTOS de webhook (os 9 nomes CamelCase) → canônico.
 * É o que o noventanove.webhook consome.
 *
 * Observação sobre DriverCanceled: o evento mapeia pra CANCELED por padrão,
 * MAS quando o payload traz `new_order_id` a 99 está reatribuindo o pedido a
 * outro entregador — nesse caso o noventanove.webhook sobrescreve pra
 * DISPATCHED (o pedido continua vivo). Ver noventanove.webhook.js.
 */
const WEBHOOK_EVENT_TO_CANONICAL = Object.freeze({
  'driveraccepted':    CanonicalStatus.COURIER_ASSIGNED,
  'driverarrived':     CanonicalStatus.ARRIVED_PICKUP,
  'driverbegincharge': CanonicalStatus.PICKED_UP,
  'drivercanceled':    CanonicalStatus.CANCELED,
  'broadcasttimeout':  CanonicalStatus.FAILED,
  'ordercompleted':    CanonicalStatus.DELIVERED,
  'orderclosed':       CanonicalStatus.DELIVERED,
  'sendback':          CanonicalStatus.RETURNING,
  // SendBackCompleted = devolução CONCLUÍDA — item já voltou ao remetente.
  // Mapeamos pra DELIVERED (e não RETURNED) pra finalizar o serviço via
  // finalizarEndereco(2) em vez de reabrir a OS na fila interna.
  // RETURNED (sendback = devolução iniciada) continua reabrindo a fila —
  // nesse ponto o item ainda está com o entregador voltando.
  'sendbackcompleted': CanonicalStatus.DELIVERED,
});

/**
 * Eventos de webhook que SÃO marcos terminais do ponto de vista do hub.
 * Útil pra idempotência e pra saber quando parar de esperar updates.
 */
const WEBHOOK_EVENTOS_FINAIS = Object.freeze([
  'DriverCanceled',     // só é final quando NÃO há new_order_id (ver webhook)
  'BroadcastTimeout',
  'OrderCompleted',
  'OrderClosed',
  'SendBackCompleted',
]);

/**
 * Eventos meramente informativos — NÃO disparam ação na Mapp.
 *  - OrderClosed: chega depois de OrderCompleted/DriverCanceled, é administrativo.
 * (SendBack saiu daqui em 2026-07: agora grava RETURNED pra refletir a coluna
 *  "Devolução" do kanban assim que a devolução inicia — ver noventanove.webhook.)
 * O noventanove.webhook classifica esses como eventType 'other'.
 */
const WEBHOOK_EVENTOS_INFORMATIVOS = Object.freeze([
  'OrderClosed',
]);

/**
 * Converte um status nativo da 99Entrega (status de pedido OU nome de evento
 * de webhook) → CanonicalStatus. Tenta os dois mapas.
 *
 * Retorna DISPATCHED para desconhecido (conservador — não dispara finalização
 * Mapp por algo que não entendemos).
 *
 * @param {string} nativo - status de pedido ('finding', ...) ou evento ('DriverAccepted', ...)
 * @returns {string} valor de CanonicalStatus
 */
function nativeToCanonical(nativo) {
  if (!nativo || typeof nativo !== 'string') {
    return CanonicalStatus.DISPATCHED;
  }
  const chave = nativo.toLowerCase().trim();

  // 1. Status de pedido (lowercase: finding/waiting/delivering/...)
  const porStatus = ORDER_STATUS_TO_CANONICAL[chave];
  if (porStatus) return porStatus;

  // 2. Evento de webhook (lookup case-insensitive)
  const porEvento = WEBHOOK_EVENT_TO_CANONICAL[chave];
  if (porEvento) return porEvento;

  console.warn(`[NinetyNineAdapter] status/evento nativo desconhecido: "${nativo}" — assumindo DISPATCHED`);
  return CanonicalStatus.DISPATCHED;
}

module.exports = {
  ORDER_STATUS_TO_CANONICAL,
  WEBHOOK_EVENT_TO_CANONICAL,
  WEBHOOK_EVENTOS_FINAIS,
  WEBHOOK_EVENTOS_INFORMATIVOS,
  nativeToCanonical,
};
