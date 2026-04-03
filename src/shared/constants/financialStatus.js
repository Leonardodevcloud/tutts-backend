/**
 * src/shared/constants/financialStatus.js
 * 🔒 SECURITY FIX (AUDIT-12/13): Status financeiros centralizados
 * 
 * Elimina strings heterogêneas espalhadas pelo código (approved/aprovado/pago_stark/etc).
 * Fonte única de verdade para todos os status de saques, lotes e itens de lote.
 * 
 * USO:
 *   const { WITHDRAWAL_STATUS, LOTE_STATUS, LOTE_ITEM_STATUS, isValidStatus } = require('../../shared/constants/financialStatus');
 *   
 *   // Em vez de: if (status === 'aprovado') ...
 *   // Usar:      if (status === WITHDRAWAL_STATUS.APROVADO) ...
 *   
 *   // Validar status: isValidStatus('aprovado', 'withdrawal') → true
 *   //                 isValidStatus('xpto', 'withdrawal') → false
 */

// ══════════════════════════════════════════════════════════
// STATUS DE SAQUES (withdrawal_requests)
// ══════════════════════════════════════════════════════════
const WITHDRAWAL_STATUS = Object.freeze({
  // Solicitação inicial
  PENDING: 'pending',
  AGUARDANDO_APROVACAO: 'aguardando_aprovacao',
  
  // Aprovações
  APROVADO: 'aprovado',
  APROVADO_GRATUIDADE: 'aprovado_gratuidade',
  
  // Rejeitados / Cancelados
  REJEITADO: 'rejeitado',
  CANCELADO: 'cancelado',
  INATIVO: 'inactive',
  
  // Stark Bank pipeline
  AGUARDANDO_PAGAMENTO_STARK: 'aguardando_pagamento_stark',
  PAGO_STARK: 'pago_stark',
});

// Status que indicam "pendente de ação admin"
const WITHDRAWAL_PENDING_STATUSES = Object.freeze([
  WITHDRAWAL_STATUS.PENDING,
  WITHDRAWAL_STATUS.AGUARDANDO_APROVACAO,
]);

// Status que indicam "aprovado e aguardando pagamento"
const WITHDRAWAL_APPROVED_STATUSES = Object.freeze([
  WITHDRAWAL_STATUS.APROVADO,
  WITHDRAWAL_STATUS.APROVADO_GRATUIDADE,
  WITHDRAWAL_STATUS.AGUARDANDO_PAGAMENTO_STARK,
]);

// Status terminais (sem mais transições)
const WITHDRAWAL_FINAL_STATUSES = Object.freeze([
  WITHDRAWAL_STATUS.PAGO_STARK,
  WITHDRAWAL_STATUS.REJEITADO,
  WITHDRAWAL_STATUS.CANCELADO,
  WITHDRAWAL_STATUS.INATIVO,
]);

// ══════════════════════════════════════════════════════════
// STARK STATUS (campo stark_status em withdrawal_requests)
// ══════════════════════════════════════════════════════════
const STARK_STATUS = Object.freeze({
  EM_LOTE: 'em_lote',
  PROCESSANDO: 'processando',
  PAGO: 'pago',
  ERRO: 'erro',
  FALHOU: 'falhou',
});

// ══════════════════════════════════════════════════════════
// STATUS DE LOTES (stark_lotes)
// ══════════════════════════════════════════════════════════
const LOTE_STATUS = Object.freeze({
  AGUARDANDO: 'aguardando',
  PROCESSANDO: 'processando',
  CONCLUIDO: 'concluido',
  PARCIAL: 'parcial',
  ERRO: 'erro',
  EXPIRADO: 'expirado', // 🔒 AUDIT-05: TTL de lotes
});

// ══════════════════════════════════════════════════════════
// STATUS DE ITENS DE LOTE (stark_lote_itens)
// ══════════════════════════════════════════════════════════
const LOTE_ITEM_STATUS = Object.freeze({
  EM_LOTE: 'em_lote',
  PROCESSANDO: 'processando',
  PAGO: 'pago',
  REJEITADO: 'rejeitado',
  ERRO: 'erro',
});

// ══════════════════════════════════════════════════════════
// STATUS DE RESTRIÇÕES (restricted_professionals)
// ══════════════════════════════════════════════════════════
const RESTRICTION_STATUS = Object.freeze({
  ATIVO: 'ativo',
  REMOVIDO: 'removido',
});

// ══════════════════════════════════════════════════════════
// STATUS DE GRATUIDADES (gratuities)
// ══════════════════════════════════════════════════════════
const GRATUITY_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  USED: 'used',
});

// ══════════════════════════════════════════════════════════
// TRANSIÇÕES VÁLIDAS (state machine)
// Define quais transições de status são permitidas.
// Qualquer transição fora deste mapa é inválida.
// ══════════════════════════════════════════════════════════
const WITHDRAWAL_TRANSITIONS = Object.freeze({
  [WITHDRAWAL_STATUS.PENDING]: [
    WITHDRAWAL_STATUS.AGUARDANDO_APROVACAO,
    WITHDRAWAL_STATUS.APROVADO,
    WITHDRAWAL_STATUS.APROVADO_GRATUIDADE,
    WITHDRAWAL_STATUS.REJEITADO,
    WITHDRAWAL_STATUS.CANCELADO,
  ],
  [WITHDRAWAL_STATUS.AGUARDANDO_APROVACAO]: [
    WITHDRAWAL_STATUS.APROVADO,
    WITHDRAWAL_STATUS.APROVADO_GRATUIDADE,
    WITHDRAWAL_STATUS.REJEITADO,
    WITHDRAWAL_STATUS.CANCELADO,
  ],
  [WITHDRAWAL_STATUS.APROVADO]: [
    WITHDRAWAL_STATUS.AGUARDANDO_PAGAMENTO_STARK,
    WITHDRAWAL_STATUS.PAGO_STARK,
    WITHDRAWAL_STATUS.REJEITADO,
  ],
  [WITHDRAWAL_STATUS.APROVADO_GRATUIDADE]: [
    WITHDRAWAL_STATUS.AGUARDANDO_PAGAMENTO_STARK,
    WITHDRAWAL_STATUS.PAGO_STARK,
    WITHDRAWAL_STATUS.REJEITADO,
  ],
  [WITHDRAWAL_STATUS.AGUARDANDO_PAGAMENTO_STARK]: [
    WITHDRAWAL_STATUS.PAGO_STARK,
    WITHDRAWAL_STATUS.APROVADO,         // retry
    WITHDRAWAL_STATUS.APROVADO_GRATUIDADE, // retry
  ],
  // Terminais — nenhuma transição permitida
  [WITHDRAWAL_STATUS.PAGO_STARK]: [],
  [WITHDRAWAL_STATUS.REJEITADO]: [],
  [WITHDRAWAL_STATUS.CANCELADO]: [],
  [WITHDRAWAL_STATUS.INATIVO]: [],
});

const LOTE_TRANSITIONS = Object.freeze({
  [LOTE_STATUS.AGUARDANDO]: [
    LOTE_STATUS.PROCESSANDO,
    LOTE_STATUS.ERRO,
    LOTE_STATUS.EXPIRADO,
  ],
  [LOTE_STATUS.PROCESSANDO]: [
    LOTE_STATUS.CONCLUIDO,
    LOTE_STATUS.PARCIAL,
    LOTE_STATUS.ERRO,
  ],
  // Terminais
  [LOTE_STATUS.CONCLUIDO]: [],
  [LOTE_STATUS.PARCIAL]: [],
  [LOTE_STATUS.ERRO]: [LOTE_STATUS.AGUARDANDO], // pode recriar
  [LOTE_STATUS.EXPIRADO]: [],
});

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

/**
 * Valida se um status é válido para um dado domínio
 * @param {string} status - Status a validar
 * @param {string} domain - 'withdrawal' | 'stark' | 'lote' | 'lote_item' | 'restriction' | 'gratuity'
 * @returns {boolean}
 */
function isValidStatus(status, domain) {
  const maps = {
    withdrawal: WITHDRAWAL_STATUS,
    stark: STARK_STATUS,
    lote: LOTE_STATUS,
    lote_item: LOTE_ITEM_STATUS,
    restriction: RESTRICTION_STATUS,
    gratuity: GRATUITY_STATUS,
  };
  const map = maps[domain];
  if (!map) return false;
  return Object.values(map).includes(status);
}

/**
 * Verifica se uma transição de status é válida
 * @param {string} from - Status atual
 * @param {string} to - Status destino
 * @param {string} domain - 'withdrawal' | 'lote'
 * @returns {boolean}
 */
function isValidTransition(from, to, domain) {
  const transitions = domain === 'lote' ? LOTE_TRANSITIONS : WITHDRAWAL_TRANSITIONS;
  const allowed = transitions[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Retorna todos os status válidos para um domínio
 * @param {string} domain
 * @returns {string[]}
 */
function getAllStatuses(domain) {
  const maps = {
    withdrawal: WITHDRAWAL_STATUS,
    stark: STARK_STATUS,
    lote: LOTE_STATUS,
    lote_item: LOTE_ITEM_STATUS,
    restriction: RESTRICTION_STATUS,
    gratuity: GRATUITY_STATUS,
  };
  const map = maps[domain];
  if (!map) return [];
  return Object.values(map);
}

module.exports = {
  // Status enums
  WITHDRAWAL_STATUS,
  STARK_STATUS,
  LOTE_STATUS,
  LOTE_ITEM_STATUS,
  RESTRICTION_STATUS,
  GRATUITY_STATUS,
  
  // Agrupamentos úteis
  WITHDRAWAL_PENDING_STATUSES,
  WITHDRAWAL_APPROVED_STATUSES,
  WITHDRAWAL_FINAL_STATUSES,
  
  // State machine
  WITHDRAWAL_TRANSITIONS,
  LOTE_TRANSITIONS,
  
  // Helpers
  isValidStatus,
  isValidTransition,
  getAllStatuses,
};
