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

  // 2. Cancela a entrega atual (sem reabrir Mapp ainda — vamos redespachar já)
  if (!NAO_CANCELAVEIS.includes(original.status_native)) {
    await orch.cancel(entregaId, {
      motivo: motivo || 'Redespacho solicitado',
      canceladoPor: 'operador',
      reabrirMapp: false,        // não reabre — vamos despachar de novo agora
      eventSource: EventSource.API,
    });
  }

  // 3. Busca o serviço atualizado na Mapp e despacha de novo
  const servicos = await getMappClient(pool).listarServicos(0, 0);
  const servico = servicos.find(s => Number(s.codigoOS) === Number(codigoOS));
  if (!servico) {
    // A OS não está mais aberta na Mapp — reabre só pra registrar e avisa
    await getMappClient(pool).alterarStatus(codigoOS, 0).catch(() => {});
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
    regraId: original.regra_id || null,
    eventSource: EventSource.API,
  });

  if (!novoRegistro) {
    return {
      ok: false,
      status: 409,
      error: 'Redespacho falhou (OS já tem entrega ativa ou erro no despacho)',
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
