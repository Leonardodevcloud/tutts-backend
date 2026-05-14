/**
 * MÓDULO UBER - Shared
 * Constantes, helpers de formatação e parser de endereço brasileiro
 */

// Base URL da API Uber Direct
const UBER_API_BASE = 'https://api.uber.com/v1/customers';
const UBER_AUTH_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_SCOPE = 'eats.deliveries';

// Defaults para Brasil
const DEFAULT_COUNTRY = 'BR';
const DEFAULT_STATE = 'BA';
const DEFAULT_CITY = 'Salvador';

// Mapeamento de status Uber → ação na Mapp
// (status oficiais documentados: pending, pickup, pickup_complete, dropoff, delivered, canceled, returned)
const UBER_STATUS_MAP = {
  pending:          { descricao: 'Aguardando entregador',          acao_mapp: null },
  pickup:           { descricao: 'Entregador a caminho da coleta', acao_mapp: null },
  pickup_complete:  { descricao: 'Coletou, indo pra entrega',      acao_mapp: 'finalizar_ponto_coleta' },
  dropoff:          { descricao: 'Chegou no destino',              acao_mapp: 'informar_chegada_entrega' },
  delivered:        { descricao: 'Entregue com sucesso',           acao_mapp: 'finalizar_servico' },
  canceled:         { descricao: 'Cancelado',                      acao_mapp: 'cancelar' },
  returned:         { descricao: 'Devolvido ao remetente',         acao_mapp: 'cancelar' },
};

// Status internos do fluxo na Central Tutts
const UBER_FLOW_STATUS = {
  AGUARDANDO_COTACAO: 'aguardando_cotacao',
  COTACAO_RECEBIDA:   'cotacao_recebida',
  ENVIADO_UBER:       'enviado_uber',
  ENTREGADOR_ATRIBUIDO: 'entregador_atribuido',
  EM_COLETA:          'em_coleta',
  COLETADO:           'coletado',
  EM_ENTREGA:         'em_entrega',
  ENTREGUE:           'entregue',
  CANCELADO:          'cancelado',
  ERRO:               'erro',
  FALLBACK_FILA:      'fallback_fila',
};

// Eventos WebSocket do tracking
const WS_EVENTS = {
  UBER_LOCATION_UPDATE: 'UBER_LOCATION_UPDATE',
  UBER_STATUS_UPDATE:   'UBER_STATUS_UPDATE',
  UBER_ENTREGADOR_INFO: 'UBER_ENTREGADOR_INFO',
  UBER_ENTREGA_CRIADA:  'UBER_ENTREGA_CRIADA',
  UBER_ENTREGA_ERRO:    'UBER_ENTREGA_ERRO',
};

// ════════════════════════════════════════════════════════════
// PARSER DE ENDEREÇO BRASILEIRO + helpers de formatação
// ════════════════════════════════════════════════════════════
// Fase 1A: implementação real migrada para
// src/modules/logistics/core/AddressParser.js
// As funções abaixo são facades — re-exportam para manter compatibilidade
// com call sites antigos (uber.service.js linhas 297, 299, 309, 320, etc).

const {
  parsearEnderecoBrasileiro,
  formatarTelefoneE164,
  truncarTexto,
} = require('../logistics/core/AddressParser');

/**
 * Monta o JSON-string que a Uber Direct espera nos campos
 * pickup_address / dropoff_address.
 *
 * A doc oficial é explícita: o campo é uma STRING com JSON dentro,
 * não um objeto. Exemplo do payload esperado:
 *   "pickup_address": "{\"street_address\":[\"425 Market St\"],\"city\":\"San Francisco\",\"state\":\"CA\",\"zip_code\":\"94105\",\"country\":\"US\"}"
 */
function montarEnderecoUber(stringEndereco) {
  const parsed = parsearEnderecoBrasileiro(stringEndereco);
  return JSON.stringify(parsed);
}

// formatarTelefoneE164 e truncarTexto agora vêm do AddressParser (importados no topo)

module.exports = {
  UBER_API_BASE,
  UBER_AUTH_URL,
  UBER_SCOPE,
  UBER_STATUS_MAP,
  UBER_FLOW_STATUS,
  WS_EVENTS,
  DEFAULT_COUNTRY,
  DEFAULT_STATE,
  DEFAULT_CITY,
  parsearEnderecoBrasileiro,
  montarEnderecoUber,
  formatarTelefoneE164,
  truncarTexto,
};
