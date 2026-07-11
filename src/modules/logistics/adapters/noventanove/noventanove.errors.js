/**
 * NINETYNINE ADAPTER — Error Classifier (API 99Entrega)
 *
 * ⚠️ REESCRITO 2026-05 — antes este classificador olhava o formato da "99 Corp
 * API" (`{ errors: [...] }`). A 99Entrega encapsula TUDO em:
 *
 *     { errno, errmsg, data }
 *
 *   - errno === 0  → sucesso
 *   - errno !== 0  → erro; `errmsg` traz a descrição humana
 *
 * Classifica erros da 99Entrega em categorias acionáveis pro Orchestrator
 * decidir retry/fallback/desistir. Mesmo contrato do uber.errors.js.
 *
 * Categorias (iguais ao uber.errors pra o Orchestrator tratar uniforme):
 *   'coverage'    — 99 não cobre / sem entregador (não adianta retry)
 *   'auth'        — OAuth token inválido / client_id-secret errados
 *   'rate_limit'  — muitas requisições (retry com backoff)
 *   'transient'   — erro de rede/5xx (retry 1x)
 *   'validation'  — payload inválido (bug nosso, não-retriable)
 *   'expired'     — estimate_id expirado/já usado (re-cotar)
 *   'unknown'     — desconhecido
 *
 * NOTA: a doc pública da 99Entrega não tabela todos os valores de `errno`.
 * A classificação é feita por: (1) errno conhecido, (2) palavra-chave na
 * errmsg, (3) HTTP status. Conforme novos errno aparecerem no sandbox,
 * adicione-os em ERRNO_MAP.
 */

/**
 * Códigos `errno` conhecidos da 99Entrega → categoria.
 * Lista enxuta — cresce conforme os erros aparecem no sandbox/produção.
 */
const ERRNO_MAP = Object.freeze({
  // 2026-07: tabela OFICIAL de errno da 99Entrega (doc do parceiro).
  // Categorias mapeadas pras conhecidas do Orchestrator (que so usa .retriable
  // pra decidir) + rotulos finos so pra exibicao. Nenhuma corrida re-tenta
  // sozinha em erro nao-retriable (fora de area, credito, horario, etc).
  1001: 'validation',    // parametro invalido
  3004: 'validation',    // tipo de veiculo nao existe
  3005: 'coverage',      // fora da area de entrega
  3006: 'coverage',      // pedido nao pode ser entregue
  3007: 'validation',    // erro nas informacoes do pedido
  3009: 'transient',     // falha temporaria - tente novamente
  3010: 'fora_horario',  // fora do horario de funcionamento
  3102: 'coverage',      // coleta e entrega em cidades diferentes
  4001: 'cancel',        // status mudou, cancelamento nao permitido
  4002: 'expired',       // estimativa desatualizada - re-cotar
  4003: 'cancel',        // pedido nao pode ser cancelado
  6002: 'validation',    // erro nas informacoes do pedido
  6004: 'credito',       // limite de credito insuficiente
  6005: 'credito',       // conta em atraso
  6101: 'validation',    // endereco do pedido difere do cotado
  6102: 'idempotency',   // external_order_id duplicado
  6103: 'validation',    // tipo de veiculo invalido
  6104: 'validation',    // endereco invalido
  6105: 'transient',     // requisicao duplicada - tente mais tarde
  6201: 'not_found',     // pedido nao existe
  6202: 'coverage',      // cidade do remetente fora da area
  6203: 'fora_horario',  // fora do horario de funcionamento
  6204: 'credito',       // taxa excede credito / fatura vencida
});

/**
 * errno → mensagem CLARA em PT-BR pro operador. Substitui o errmsg cru da 99
 * (que as vezes vem generico, vazio ou em ingles). E o texto que aparece no
 * card de falha, na trilha de tentativas e nos detalhes.
 */
const ERRNO_LABEL = Object.freeze({
  1001: 'Parametro invalido na requisicao a 99',
  3004: 'Tipo de veiculo indisponivel na 99',
  3005: 'Fora da area de entrega da 99',
  3006: 'A 99 nao consegue entregar esse pedido (contate o suporte 99)',
  3007: 'Erro nas informacoes do pedido',
  3009: 'Falha temporaria na 99 - tente novamente',
  3010: 'Fora do horario de funcionamento da 99',
  3102: 'Coleta e entrega em cidades diferentes',
  4001: 'Cancelamento nao permitido - o status do pedido ja mudou',
  4002: 'Cotacao desatualizada - refaca a estimativa',
  4003: 'Este pedido nao pode ser cancelado',
  6002: 'Erro nas informacoes do pedido',
  6004: 'Limite de credito da conta 99 insuficiente',
  6005: 'Conta 99 em atraso - pague a fatura primeiro',
  6101: 'Endereco do pedido difere do endereco cotado',
  6102: 'External order id duplicado (cada id so cria um pedido)',
  6103: 'Tipo de veiculo invalido para o pedido',
  6104: 'Endereco de coleta ou entrega invalido',
  6105: 'Requisicao duplicada na 99 - tente novamente em instantes',
  6201: 'Pedido nao existe na 99',
  6202: 'Cidade da coleta fora da area de operacao da 99',
  6203: 'Fora do horario de funcionamento da 99',
  6204: 'Taxa excede o credito da empresa ou a fatura esta vencida',
});

/**
 * Heurística por palavra-chave na errmsg. A 99Entrega devolve errmsg humana;
 * quando não temos o errno tabelado, inferimos pela mensagem.
 * Ordem importa — a primeira que casar vence.
 */
const ERRMSG_KEYWORDS = Object.freeze([
  { re: /(no\s*(driver|courier)|sem\s*entregador|unavailable|not\s*cover|out\s*of\s*(service|range)|fora\s*de\s*(área|cobertura))/i, category: 'coverage' },
  { re: /(unauthorized|invalid\s*(token|client)|forbidden|access\s*denied|credential)/i, category: 'auth' },
  { re: /(rate\s*limit|too\s*many|limite\s*de\s*requisi)/i, category: 'rate_limit' },
  { re: /(estimate.*(expired|invalid|used|not\s*found)|cotação.*(expir|inváli))/i, category: 'expired' },
  { re: /(invalid|required|missing|malformed|inváli|obrigat|formato)/i, category: 'validation' },
]);

/**
 * Classifica um erro da 99Entrega.
 *
 * @param {Object} resp - objeto do httpRequest (.status, .ok, .json())
 * @param {Object} [bodyData] - data já parseado (envelope { errno, errmsg, data })
 * @returns {{ category: string, code: string, message: string, retriable: boolean, httpStatus: number }}
 */
function classify99Error(resp, bodyData = null) {
  const json = bodyData || (typeof resp?.json === 'function' ? resp.json() : null) || {};
  const httpStatus = resp?.status || 0;

  // Envelope 99Entrega: { errno, errmsg, data }
  const errno = json.errno != null ? json.errno : null;
  const errmsg = json.errmsg || json.error_description || json.error
    || json.message || JSON.stringify(json).slice(0, 200);
  const code = errno != null ? String(errno) : '';

  let category = (errno != null && ERRNO_MAP[errno]) || null;

  // 2. Heurística por palavra-chave na errmsg
  if (!category && errmsg) {
    for (const { re, category: cat } of ERRMSG_KEYWORDS) {
      if (re.test(errmsg)) { category = cat; break; }
    }
  }

  // 3. Fallback por HTTP status
  if (!category) {
    if (httpStatus === 401 || httpStatus === 403) category = 'auth';
    else if (httpStatus === 429) category = 'rate_limit';
    else if (httpStatus === 404) category = 'coverage'; // pedido/rota não encontrada
    else if (httpStatus >= 500 && httpStatus < 600) category = 'transient';
    else if (httpStatus >= 400 && httpStatus < 500) category = 'validation';
    else if (httpStatus === 0) category = 'transient'; // rede/timeout
    else category = 'unknown';
  }

  const retriable = ['auth', 'rate_limit', 'transient', 'expired'].includes(category);

  // Mensagem CLARA pro operador: 1o o rotulo do errno (doc oficial), senao um
  // texto por HTTP status, senao o errmsg cru da 99.
  let mensagem = (errno != null && ERRNO_LABEL[errno]) || null;
  if (!mensagem) {
    if (httpStatus === 401 || httpStatus === 403) mensagem = 'Autenticacao com a 99 falhou - verifique as credenciais/token';
    else if (httpStatus >= 500 && httpStatus < 600) mensagem = 'Erro interno da 99 - tente novamente em instantes';
    else if (httpStatus === 0) mensagem = 'Falha de rede ao falar com a 99 - tente novamente';
  }
  const message = mensagem || errmsg;

  return { category, code, message, errmsgRaw: errmsg, retriable, httpStatus };
}

module.exports = {
  ERRNO_MAP,
  ERRNO_LABEL,
  ERRMSG_KEYWORDS,
  classify99Error,
};
