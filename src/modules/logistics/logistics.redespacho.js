/**
 * MODULO LOGISTICS - Redespacho (extraido)
 *
 * REDESPACHO_EXTRAIR_V1
 *
 * Extraido de logistics.routes.js (POST /deliveries/:id/redispatch), onde
 * vivia inline. Motivo: o portal da loja precisa do MESMO comportamento, e
 * duplicar um caminho que cancela e recontrata corrida e como as duas copias
 * divergem — o sintoma seria corrida cobrada em dobro.
 *
 * Esta funcao NAO conhece req/res. Ela devolve um resultado e quem chamou
 * traduz pra HTTP. Assim admin e loja compartilham a regra e divergem so na
 * autorizacao, que e onde eles DEVEM divergir.
 *
 * RETORNO:
 *   { ok: true,  entregaAnterior, entregaNova, registro }
 *   { ok: false, status, error, entregaCancelada? }
 *
 * A extracao e LITERAL: mesmo comportamento, mesmas mensagens, mesma ordem.
 * Nada de novo entrou aqui de proposito — o pacote seguinte usa esta funcao.
 */

const { getDispatchOrchestrator } = require('./core/DispatchOrchestrator');
const { getMappClient } = require('./core/MappClient');
const { EventSource } = require('./core/EventLogger');

// Doc oficial da 99 (Cancel Order): "If the courier has picked up the package,
// order cancellation is not supported." Depois da COLETA a 99 recusa o
// cancelamento e a corrida segue viva SENDO COBRADA — um redespacho ali
// pagaria DUAS corridas.
//
// A fronteira e a coleta, nao o aceite: entre COURIER_ASSIGNED e
// ARRIVED_PICKUP ainda da pra cancelar.
const ANTES_DA_COLETA = ['PENDING', 'QUOTED', 'DISPATCHED', 'COURIER_ASSIGNED', 'PICKUP_EN_ROUTE', 'ARRIVED_PICKUP'];

// Status em que a entrega ja nao precisa (ou nao pode) ser cancelada.
const NAO_CANCELAVEIS = ['cancelado', 'canceled', 'delivered', 'fallback_fila'];

/**
 * REDESPACHO_MAPP_REABRE_V1 (servicoDoRegistro) — reconstroi o servico Mapp.
 *
 * dispatch() precisa de: codigoOS, endereco[] (>= 2 pontos), valorServico,
 * valorProfissional e obs. Tudo isso ja esta gravado na entrega original:
 * `pontos` e o array de enderecos como a Mapp mandou.
 *
 * Usa os *_mapp_original de proposito: valor_servico pode ter sido REESCRITO
 * pela tabela de preco da regra no despacho anterior. Reusar ele aqui
 * precificaria em cima do ja precificado a cada redespacho.
 *
 * @param {object} reg - linha de logistics_deliveries
 * @returns {object|null} servico no formato Mapp, ou null se nao der pra montar
 */
function servicoDoRegistro(reg) {
  let pontos = reg.pontos;
  if (typeof pontos === 'string') {
    try { pontos = JSON.parse(pontos); } catch (e) { pontos = null; }
  }
  if (!Array.isArray(pontos) || pontos.length < 2) return null;

  const num = (v) => (v == null ? null : Number(v));
  const vServico = num(reg.valor_servico_mapp_original);
  const vProf = num(reg.valor_profissional_mapp_original);

  return {
    codigoOS: reg.codigo_os,
    endereco: pontos,
    valorServico: vServico != null ? vServico : num(reg.valor_servico),
    valorProfissional: vProf != null ? vProf : num(reg.valor_profissional),
    obs: reg.obs || '',
  };
}

/**
 * @param {object} pool
 * @param {number} entregaId
 * @param {object} opts
 * @param {?string} opts.providerCode  null = usa o provedor da propria entrega
 * @param {?string} opts.vehicleType
 * @param {?string} opts.motivo
 * @param {boolean} opts.excluirEntregador
 * @param {string}  opts.criadoPor      quem pediu (auditoria da exclusao)
 */
async function redespacharEntrega(pool, entregaId, opts = {}) {
  const {
    providerCode: provReq = null,
    vehicleType = null,
    motivo = null,
    excluirEntregador = false,
    criadoPor = 'sistema',
  } = opts;

  const orch = getDispatchOrchestrator(pool);

  // 1. Busca a entrega original
  const { rows } = await pool.query('SELECT * FROM logistics_deliveries WHERE id = $1', [entregaId]);
  if (rows.length === 0) {
    return { ok: false, status: 404, error: 'Entrega não encontrada' };
  }
  const original = rows[0];
  const codigoOS = original.codigo_os;

  // REDESPACHO_EXCLUSAO_V1: providerCode NAO tem default 'uber'.
  //
  // Era bug: uma corrida despachada na 99 e redespachada sem body ia parar na
  // Uber, em silencio. O redespacho tem que ir pro MESMO provedor que foi
  // pedido — 99 continua 99, Uber continua Uber.
  const providerCode = provReq || original.provider_code || 'uber';

  // Trava de estagio.
  if (!ANTES_DA_COLETA.includes(original.status_canonico)) {
    return {
      ok: false,
      status: 409,
      error: `Redespacho indisponivel: a corrida ja passou da coleta (${original.status_canonico}). O provedor nao cancela depois da coleta — a corrida seria cobrada e voce pagaria duas.`,
    };
  }

  // REDESPACHO_EXCLUSAO_V1 — exclui o entregador atual DESTA OS.
  //
  // Sem isso o provedor pode devolver o mesmo cara e o botao vira enfeite:
  // nem a 99 nem a Uber aceitam "nao mande o Fulano" no pedido. A checagem e
  // reativa, no WebhookDispatcher: quando o provedor atribuir, se for um
  // excluido desta OS, cancela e relanca (com teto, ver REDESPACHO_EXCLUSAO_MAX).
  if (excluirEntregador !== false && original.courier_data) {
    const { excluirCourierDaOS } = require('./logistics.bloqueados');
    await excluirCourierDaOS(pool, codigoOS, original.courier_data, {
      motivo: motivo || 'redespacho manual',
      criadoPor,
    }).catch((e) => console.warn('[redispatch] falha ao excluir entregador da OS:', e.message));
  }

  // 2. Cancela a entrega atual (sem reabrir a Mapp aqui — quem reabre e o passo
  //    2.1, de proposito: assim o reabre acontece UMA vez e SEMPRE, inclusive
  //    quando o status ja era nao-cancelavel e este if nao roda)
  if (!NAO_CANCELAVEIS.includes(original.status_native)) {
    await orch.cancel(entregaId, {
      motivo: motivo || 'Redespacho solicitado',
      canceladoPor: 'operador',
      reabrirMapp: false,
      eventSource: EventSource.API,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // REDESPACHO_MAPP_REABRE_V1 (reabre) — a causa do botao dar erro.
  //
  // O despacho RESERVA a OS na Mapp (alterarStatus 0 -> 1) e, quando o
  // entregador e atribuido, ela vai pra vinculada. O cancelamento acima nao
  // reabria (reabrirMapp:false). So que o passo 3 procurava a OS em
  // listarServicos(0) — e o `status=0` e um FILTRO da propria Mapp: ela so
  // devolve OS na fila. A OS redespachada nunca estava la, entao TODO
  // redespacho caia em `409 OS nao esta mais disponivel na Mapp`.
  //
  // E nao era so a busca: mesmo achando o servico, o dispatch() faz a reserva
  // 0 -> 1, que a Mapp recusa numa OS que ja esta em 1 — cairia no outro 409
  // ("Redespacho falhou"). Os dois sintomas tem a mesma raiz: ninguem devolvia
  // a OS pro estado 0 antes de despachar de novo.
  //
  // Reabrir aqui conserta os dois. E o mesmo alterarStatus(0) que o cancel
  // normal faz — caminho ja estabelecido, nao e novidade nenhuma pra Mapp.
  // ══════════════════════════════════════════════════════════════════════
  const mapp = getMappClient(pool);
  await mapp.alterarStatus(codigoOS, 0).catch((e) =>
    console.warn(`[redispatch] falha ao reabrir OS ${codigoOS} na Mapp: ${e.message}`));

  // 3. Busca o servico atualizado na Mapp e despacha de novo.
  //
  //    FALLBACK: se a listagem ainda nao trouxer a OS (propagacao da Mapp, ou o
  //    poller reservou ela no meio do caminho), reconstroi o servico do proprio
  //    registro. Nao e chute: pontos, valores originais e obs foram gravados no
  //    despacho justamente porque sao a copia do que a Mapp mandou.
  const servicos = await mapp.listarServicos(0, 0).catch(() => []);
  let servico = servicos.find(s => Number(s.codigoOS) === Number(codigoOS));
  if (!servico) servico = servicoDoRegistro(original);
  if (!servico) {
    return {
      ok: false,
      status: 409,
      error: `OS ${codigoOS} não está mais disponível na Mapp para redespacho`,
      entregaCancelada: entregaId,
    };
  }

  const novoRegistro = await orch.dispatch(servico, {
    providerCode,
    vehicleType,
    // CLIENTE_MANUAL_V1: a atribuicao manual vence o regra_id, igual ao resto do
    // modulo. Sem isso o redespacho jogava fora o cliente atribuido na mao — e
    // com ele a tabela de preco daquela loja.
    regraId: original.regra_id_manual || original.regra_id || null,
    eventSource: EventSource.API,
  });

  if (!novoRegistro) {
    // dispatch() devolve null quando a OS ja tem entrega ativa. Depois do
    // reabre, isso pode ser o POLLER tendo despachado a OS no meio do caminho:
    // o redespacho ACONTECEU, so nao por esta chamada. Dizer "falhou" aqui faria
    // o operador clicar de novo numa corrida que ja esta viva — e ai sim seriam
    // duas.
    const { rows: ativa } = await pool.query(
      `SELECT id FROM logistics_deliveries
        WHERE codigo_os = $1 AND id <> $2
          AND status_canonico NOT IN ('CANCELED','DELIVERED','FAILED')
        ORDER BY id DESC LIMIT 1`,
      [codigoOS, entregaId]
    );
    if (ativa.length > 0) {
      return { ok: true, entregaAnterior: entregaId, entregaNova: ativa[0].id, registro: null };
    }
    return {
      ok: false,
      status: 409,
      error: 'Redespacho falhou (erro no despacho). A OS foi reaberta na Mapp e volta pra fila.',
      entregaCancelada: entregaId,
    };
  }

  return {
    ok: true,
    entregaAnterior: entregaId,
    entregaNova: novoRegistro.id,
    registro: novoRegistro,
  };
}

module.exports = { redespacharEntrega, ANTES_DA_COLETA };
