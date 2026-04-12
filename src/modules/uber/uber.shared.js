/**
 * MÓDULO UBER - Shared
 * Constantes e mapeamentos de status
 */

// Base URL da API Uber Direct
const UBER_API_BASE = 'https://api.uber.com/v1/customers';
const UBER_AUTH_URL = 'https://login.uber.com/oauth/v2/token';

// Mapeamento de status Uber → ação na Mapp
const UBER_STATUS_MAP = {
  pending:          { descricao: 'Aguardando entregador',    acao_mapp: null },
  pickup:           { descricao: 'Entregador a caminho da coleta', acao_mapp: null },
  pickup_complete:  { descricao: 'Coletou, indo pra entrega', acao_mapp: 'finalizar_ponto_coleta' },
  dropoff:          { descricao: 'Chegou no destino',         acao_mapp: 'informar_chegada_entrega' },
  delivered:        { descricao: 'Entregue com sucesso',       acao_mapp: 'finalizar_servico' },
  canceled:         { descricao: 'Cancelado',                  acao_mapp: 'cancelar' },
  returned:         { descricao: 'Devolvido ao remetente',     acao_mapp: 'cancelar' },
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

module.exports = {
  UBER_API_BASE,
  UBER_AUTH_URL,
  UBER_STATUS_MAP,
  UBER_FLOW_STATUS,
  WS_EVENTS,
};
