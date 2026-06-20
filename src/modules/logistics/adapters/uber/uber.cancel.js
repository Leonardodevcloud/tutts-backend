/**
 * UBER ADAPTER — Cancelamento (cancelation_reason)
 *
 * A Uber Direct EXIGE, na certificação de produção, que o POST .../cancel
 * inclua no corpo um `cancelation_reason` (grafia com 1 L) com um dos valores
 * predefinidos. Para "other" o `additional_description` é OBRIGATÓRIO; para os
 * demais é opcional (mas pode dar contexto).
 *
 * Valores válidos (ATENÇÃO à ortografia e maiúsculas/minúsculas):
 *   out_of_items | store_closed | customer_called_to_cancel | store_too_busy |
 *   courier_delayed_en_route_to_pickup | too_expensive |
 *   customer_changed_order_requirements | delivery_vehicle_too_small |
 *   no_courier_assigned | other
 *
 * Este helper transforma um motivo interno do hub (enum explícito OU texto livre
 * em PT/EN) num par { cancelationReason, additionalDescription } SEMPRE válido —
 * o fallback é 'other' + descrição obrigatória, garantindo que o body nunca vá
 * sem motivo (que é o que reprova a certificação).
 */

const UBER_CANCEL_REASONS = Object.freeze([
  'out_of_items',
  'store_closed',
  'customer_called_to_cancel',
  'store_too_busy',
  'courier_delayed_en_route_to_pickup',
  'too_expensive',
  'customer_changed_order_requirements',
  'delivery_vehicle_too_small',
  'no_courier_assigned',
  'other',
]);

/**
 * @param {Object} [params]
 * @param {string} [params.reason] - enum Uber explícito (tem precedência se válido)
 * @param {string} [params.motivo] - texto livre do hub (vira additional_description ou heurística)
 * @returns {{ cancelationReason: string, additionalDescription: (string|null) }}
 */
function montarMotivoCancelamentoUber(params = {}) {
  const { reason, motivo } = params || {};
  const descLivre = (motivo != null && String(motivo).trim()) ? String(motivo).trim().slice(0, 280) : null;

  // 1) enum explícito válido tem precedência
  if (reason && UBER_CANCEL_REASONS.includes(String(reason))) {
    const r = String(reason);
    if (r === 'other') {
      return { cancelationReason: 'other', additionalDescription: descLivre || 'Canceled by operator' };
    }
    return { cancelationReason: r, additionalDescription: descLivre };
  }

  // 2) heurística por texto livre (PT/EN) — mapeia os casos mais comuns do hub
  const m = String(motivo || '').toLowerCase();
  if (/timeout|sem\s*entregad|no[_\s-]?courier|nenhum\s*entregad|sem\s*motor/.test(m)) {
    return { cancelationReason: 'no_courier_assigned', additionalDescription: null };
  }
  if (/loja\s*fechad|store\s*closed|fechad/.test(m)) {
    return { cancelationReason: 'store_closed', additionalDescription: null };
  }
  if (/cliente.*cancel|customer.*cancel|cancelad[oa]\s*pelo\s*cliente/.test(m)) {
    return { cancelationReason: 'customer_called_to_cancel', additionalDescription: null };
  }
  if (/muito\s*caro|too\s*expensive|caro/.test(m)) {
    return { cancelationReason: 'too_expensive', additionalDescription: null };
  }
  if (/loja.*ocupad|store.*busy|muito\s*moviment/.test(m)) {
    return { cancelationReason: 'store_too_busy', additionalDescription: null };
  }
  if (/mudou.*pedid|changed.*order|alterou.*pedid/.test(m)) {
    return { cancelationReason: 'customer_changed_order_requirements', additionalDescription: null };
  }

  // 3) fallback seguro: 'other' SEMPRE com descrição (exigência da Uber)
  return { cancelationReason: 'other', additionalDescription: descLivre || 'Canceled by operator' };
}

module.exports = {
  UBER_CANCEL_REASONS,
  montarMotivoCancelamentoUber,
};
