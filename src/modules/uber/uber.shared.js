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
// PARSER DE ENDEREÇO BRASILEIRO
// ════════════════════════════════════════════════════════════

/**
 * Tenta extrair {street, cidade, uf, cep} de uma string única vinda da Mapp.
 * Best-effort — formato varia muito entre lojistas.
 *
 * Exemplos reais que precisa lidar:
 *   "Rua do Níquel, Parque Oeste Industrial, Goiânia- GO - 74670-490"
 *   "Av. Pedro Miranda, 2018 - Terrabela Cerrado II, Sen. Canedo - GO, 75262-553, Brasil Nº nota: 515959"
 *   "AV.PEDRO LUDOVICO TEIXEIRA NR.100 QUADRA 142,, PARQUE OESTE INDUSTR, 5208707- GO - 74375400 N° nota: 07-002707611-7"
 *   "AV CASTELO BRANCO 6217 QD 36 LT 09, IPIRANGA, GOIANIA - GO - 74453386 SL1-44067025 062-39916090 - Nº nota: 07-002707611-7"
 */
function parsearEnderecoBrasileiro(str) {
  if (!str || typeof str !== 'string') {
    return {
      street_address: ['Endereço não informado'],
      city: DEFAULT_CITY,
      state: DEFAULT_STATE,
      zip_code: '',
      country: DEFAULT_COUNTRY,
    };
  }

  let limpo = str.trim();

  // 1. Cortar sufixos "Nº nota:..." e "Brasil"
  limpo = limpo.replace(/\s*N[°ºo°]?\s*nota\s*:.*$/i, '').trim();
  limpo = limpo.replace(/[,\s\-]+Brasil\s*$/i, '').trim();

  const UFS = '(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)';

  // 2. Tentar achar o padrão UF imediatamente seguida de CEP — é o caso típico:
  //    "Goiânia - GO - 74670-490", "GO, 75262-553", "- GO - 74445360"
  let uf = DEFAULT_STATE;
  let cep = '';
  let posCorte = limpo.length;

  const padraoUfCep = new RegExp(`[\\s,\\-]${UFS}[\\s,\\-]+(\\d{5})-?(\\d{3})(?!\\d)`);
  const matchUfCep = limpo.match(padraoUfCep);

  if (matchUfCep) {
    uf = matchUfCep[1];
    cep = `${matchUfCep[2]}-${matchUfCep[3]}`;
    posCorte = matchUfCep.index;
  } else {
    // Fallback: extrair CEP e UF separadamente
    const cepRegex = /(\d{5})-?(\d{3})(?!\d)/g;
    const todosCeps = [...limpo.matchAll(cepRegex)];
    if (todosCeps.length > 0) {
      const escolhido = todosCeps[0];
      cep = `${escolhido[1]}-${escolhido[2]}`;
      posCorte = Math.min(posCorte, escolhido.index);
    }
    const ufRegex = new RegExp(`[\\s,\\-]${UFS}(?=[\\s,\\-]|$)`, 'g');
    const todasUfs = [...limpo.matchAll(ufRegex)];
    if (todasUfs.length > 0) {
      const escolhida = todasUfs[todasUfs.length - 1];
      uf = escolhida[1];
      posCorte = Math.min(posCorte, escolhida.index);
    }
  }

  // 3. Tudo antes do corte é o "endereço bruto" (rua + bairro + cidade)
  let antes = limpo.slice(0, posCorte).trim();
  antes = antes.replace(/[,\-\s]+$/g, '').replace(/\s{2,}/g, ' ').trim();

  // 4. Separar cidade do resto — última parte por vírgula que pareça um nome
  //    (ignora segmentos só de números/lixo). Só tenta extrair cidade se houver
  //    pelo menos 2 segmentos — caso contrário tudo vira street e city = default.
  let cidade = DEFAULT_CITY;
  const partes = antes.split(',').map(p => p.trim()).filter(Boolean);

  if (partes.length >= 2) {
    while (partes.length > 0) {
      const candidata = partes[partes.length - 1].replace(/^[\d\-\s]+/, '').trim();
      if (candidata.length >= 3 && /[a-zA-Zà-úÀ-Ú]/.test(candidata)) {
        cidade = candidata;
        partes.pop();
        break;
      }
      partes.pop();
    }
  }

  const street = partes.length > 0 ? partes.join(', ') : antes;

  return {
    street_address: [street || 'Endereço não informado'],
    city: cidade,
    state: uf,
    zip_code: cep,
    country: DEFAULT_COUNTRY,
  };
}

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

/**
 * Formata telefone para o padrão E.164 exigido pela Uber Direct.
 * Aceita: "71999999999", "(71) 99999-9999", "+5571999999999", etc.
 * Retorna: "+5571999999999" (sempre com +55 se não tiver código do país)
 */
function formatarTelefoneE164(tel, ddiPadrao = '55') {
  if (!tel) return null;
  let digitos = String(tel).replace(/\D/g, '');
  if (!digitos) return null;
  // Se já começa com 55 e tem 12 ou 13 dígitos (DDI+DDD+número), assume que tá certo
  if (digitos.startsWith(ddiPadrao) && digitos.length >= 12) {
    return `+${digitos}`;
  }
  // Se tem 10 ou 11 dígitos (DDD + número), adiciona DDI
  if (digitos.length >= 10) {
    return `+${ddiPadrao}${digitos}`;
  }
  return null;
}

/**
 * Limita uma string (para campos como notes/instructions que tem cap em 280 chars)
 */
function truncarTexto(str, max = 280) {
  if (!str) return null;
  const s = String(str).trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

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
