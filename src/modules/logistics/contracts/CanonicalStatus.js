/**
 * MÓDULO LOGISTICS — Canonical Status
 *
 * Enum único de status que o hub usa internamente. Cada adapter mantém
 * seu próprio mapeamento `nativeToCanonical()` para traduzir status
 * específicos do provider (delivered, RIDE_COMPLETED, etc) para este enum.
 *
 * REGRA DE OURO: o core e o frontend só conhecem estes valores.
 * Status nativo do provider fica na coluna logistics_deliveries.status_native
 * para auditoria, mas nunca dispara lógica de negócio.
 *
 * Quando um status nativo não tem equivalente direto, mapear para o mais
 * próximo conservadoramente — na dúvida, NÃO avançar o ciclo na Mapp.
 */

const CanonicalStatus = Object.freeze({
  // ─── Estados antes do despacho ────────────────────────────
  /** Registrado no hub, aguardando cotação ou despacho manual. */
  PENDING: 'PENDING',

  /** Cotação obtida do provider, aguardando confirmação de despacho. */
  QUOTED: 'QUOTED',

  // ─── Estados em andamento no provider ─────────────────────
  /** Delivery criada no provider, sem entregador atribuído ainda. */
  DISPATCHED: 'DISPATCHED',

  /** Provider atribuiu um entregador. Dispara vincularMotorista na Mapp. */
  COURIER_ASSIGNED: 'COURIER_ASSIGNED',

  /** Entregador a caminho da coleta. */
  PICKUP_EN_ROUTE: 'PICKUP_EN_ROUTE',

  /**
   * Entregador chegou no local de coleta (alguns providers expõem,
   * outros pulam direto para PICKED_UP).
   */
  ARRIVED_PICKUP: 'ARRIVED_PICKUP',

  /** Coletou. Dispara informarChegada(1) + finalizarEndereco(1) na Mapp. */
  PICKED_UP: 'PICKED_UP',

  /** A caminho da entrega. */
  DROPOFF_EN_ROUTE: 'DROPOFF_EN_ROUTE',

  /** Entregador chegou no destino. Dispara informarChegada(2) na Mapp. */
  ARRIVED_DROPOFF: 'ARRIVED_DROPOFF',

  // ─── Estados terminais ────────────────────────────────────
  /** Entregue com sucesso. Dispara finalizarEndereco(2) na Mapp. */
  DELIVERED: 'DELIVERED',

  /** Cancelado (por operador, cliente, ou provider). Reabre OS na Mapp. */
  CANCELED: 'CANCELED',

  /** Devolvido ao remetente (Uber expõe; 99 normalmente trata como CANCELED). */
  RETURNED: 'RETURNED',

  /**
   * Devolução EM ANDAMENTO — o entregador está levando o pacote de volta ao
   * remetente (99: SendBack / sendback). NÃO é terminal: o hub continua
   * acompanhando (poller ativo) pra capturar o código de devolução e a posição.
   * Vira RETURNED quando a devolução CONCLUI (SendBackCompleted).
   */
  RETURNING: 'RETURNING',

  /** Falha técnica (OAuth expirou, provider não criou, etc). */
  FAILED: 'FAILED',

  /**
   * Timeout sem entregador no provider — OS reaberta para fila interna
   * de motoboys Tutts. Estado terminal do ponto de vista do hub.
   */
  FALLBACK_QUEUE: 'FALLBACK_QUEUE',
});

/** Array de todos os valores (útil pra validação e migrations). */
const CANONICAL_STATUS_VALUES = Object.values(CanonicalStatus);

/** Estados terminais (não geram mais transições). */
const TERMINAL_STATUSES = Object.freeze([
  CanonicalStatus.DELIVERED,
  CanonicalStatus.CANCELED,
  CanonicalStatus.RETURNED,
  CanonicalStatus.FAILED,
  CanonicalStatus.FALLBACK_QUEUE,
]);

/** Estados que indicam delivery ativa no provider (cancelamento ainda faz sentido). */
const ACTIVE_STATUSES = Object.freeze([
  CanonicalStatus.PENDING,
  CanonicalStatus.QUOTED,
  CanonicalStatus.DISPATCHED,
  CanonicalStatus.COURIER_ASSIGNED,
  CanonicalStatus.PICKUP_EN_ROUTE,
  CanonicalStatus.ARRIVED_PICKUP,
  CanonicalStatus.PICKED_UP,
  CanonicalStatus.DROPOFF_EN_ROUTE,
  CanonicalStatus.ARRIVED_DROPOFF,
  // Devolucao em andamento: ainda ativa (poller acompanha ate concluir).
  CanonicalStatus.RETURNING,
]);

/**
 * Mapeamento de status canônico → ação na Mapp.
 * Centraliza a lógica que hoje vive em uber.service.js:processarWebhookStatus.
 * Cada adapter traduz seu status nativo para canônico; o core consulta
 * este map para decidir o que fazer na Mapp.
 *
 * Retorna null se não há ação Mapp associada (estados intermediários).
 *
 * Formato da ação:
 *   { type: 'informar_chegada' | 'finalizar_endereco' | 'finalizar_servico' |
 *           'alterar_status' | 'vincular_motorista',
 *     args: { ... } }
 */
const STATUS_TO_MAPP_ACTION = Object.freeze({
  [CanonicalStatus.PENDING]:           null,
  [CanonicalStatus.QUOTED]:            null,
  [CanonicalStatus.DISPATCHED]:        null,
  [CanonicalStatus.COURIER_ASSIGNED]:  { type: 'vincular_motorista' },
  [CanonicalStatus.PICKUP_EN_ROUTE]:   null,
  [CanonicalStatus.ARRIVED_PICKUP]:    null,  // só log
  [CanonicalStatus.PICKED_UP]:         { type: 'finalizar_ponto_coleta', ponto: 1 },
  [CanonicalStatus.DROPOFF_EN_ROUTE]:  null,
  [CanonicalStatus.ARRIVED_DROPOFF]:   { type: 'informar_chegada', ponto: 2 },
  [CanonicalStatus.DELIVERED]:         { type: 'finalizar_servico', ponto: 2 },
  [CanonicalStatus.CANCELED]:          { type: 'alterar_status', status: 0 },
  [CanonicalStatus.RETURNED]:          { type: 'alterar_status', status: 0 },
  [CanonicalStatus.RETURNING]:         null,  // devolucao em andamento — sem acao Mapp (so no SendBackCompleted)
  [CanonicalStatus.FAILED]:            { type: 'alterar_status', status: 0 },
  [CanonicalStatus.FALLBACK_QUEUE]:    { type: 'alterar_status', status: 0 },
});

/**
 * Helper: dado um status canônico, retorna se é terminal.
 */
function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Helper: valida que uma string é um status canônico válido.
 */
function isValidStatus(status) {
  return CANONICAL_STATUS_VALUES.includes(status);
}

module.exports = {
  CanonicalStatus,
  CANONICAL_STATUS_VALUES,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  STATUS_TO_MAPP_ACTION,
  isTerminal,
  isValidStatus,
};
