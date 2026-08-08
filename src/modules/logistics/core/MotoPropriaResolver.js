// MotoPropriaResolver.js
// MOTO_PROPRIA_V1 — surfacea no painel (admin + portal) as corridas que sairam
// com MOTO PROPRIA do cliente (nao passaram pelo Hub) e por isso nunca criaram
// linha em logistics_deliveries — logo ficavam invisiveis no painel/rastreio.
//
// FONTE DO DADO (o robo ja coleta tudo isto, nao criamos captura nova):
//   - sla_monitor_snapshot : motoboy (nome/cod), link_rastreio (rastreio nativo
//                            Tutts), deadline/prazo, em_execucao, situacao, centro.
//   - sla_capturas         : pontos_json (cliente final + NF + endereco entrega)
//                            e coleta_texto (ponto 1 = endereco de coleta, usado
//                            pra casar a regra IGUAL ao despacho faz).
//
// QUEM E "MOTO PROPRIA":
//   snapshot em_execucao=TRUE, situacao='em_execucao' (JA tem motoboy) E a OS
//   NAO existe em logistics_deliveries (nao passou pelo Hub). O JOIN com
//   sla_capturas garante que so entram OS de cliente rastreado (com dado rico).
//
// CASAMENTO DE REGRA (portal): reusa normalizarEnderecoParaMatch + a MESMA
// regra de substring do DispatchRuleMatcher (cliente_identificador >=4 /
// trecho_endereco >=5 no endereco de COLETA). Uma implementacao so — nunca
// diverge do despacho.
//
// READ-ONLY: nao escreve nada. Nao toca em metricas/financeiro do Hub (esses
// leem logistics_deliveries direto).

'use strict';

const { extrairClienteFinalENota } = require('./ClienteFinalParser');
const { normalizarEnderecoParaMatch } = require('./DispatchRuleMatcher');

// Teto defensivo — o painel raramente tem tantas corridas proprias em execucao.
const LIMITE = 500;

/**
 * Resolve a regra de despacho de uma OS de moto propria pelo endereco de coleta,
 * usando EXATAMENTE o casamento do DispatchRuleMatcher (substring normalizado).
 * @param {string|null} coletaTexto  texto do ponto 1 (coleta)
 * @param {Array<{id:number, cliente_identificador?:string, trecho_endereco?:string, cliente_nome?:string}>} regras
 * @returns {{regra_id:number|null, cliente_nome_regra:string|null}}
 */
function resolverRegraPorColeta(coletaTexto, regras) {
  const vazio = { regra_id: null, cliente_nome_regra: null };
  const coleta = normalizarEnderecoParaMatch(coletaTexto || '');
  if (!coleta || !Array.isArray(regras) || regras.length === 0) return vazio;
  for (const regra of regras) {
    const trechoEnd = normalizarEnderecoParaMatch(regra.trecho_endereco || regra.cliente_nome || '');
    const trechoIdent = normalizarEnderecoParaMatch(regra.cliente_identificador || '');
    if (trechoIdent && trechoIdent.length >= 4 && coleta.includes(trechoIdent)) {
      return { regra_id: regra.id, cliente_nome_regra: regra.cliente_nome || null };
    }
    if (trechoEnd && trechoEnd.length >= 5 && coleta.includes(trechoEnd)) {
      return { regra_id: regra.id, cliente_nome_regra: regra.cliente_nome || null };
    }
  }
  return vazio;
}

// Extrai o ultimo ponto de entrega (numero >= 2) do pontos_json ja normalizado.
function ultimoPontoEntrega(pontosJson) {
  let pts = pontosJson;
  if (typeof pts === 'string') { try { pts = JSON.parse(pts); } catch (_) { pts = null; } }
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const entrega = pts.filter((p) => Number(p && p.numero) >= 2);
  const base = entrega.length > 0 ? entrega[entrega.length - 1] : pts[pts.length - 1];
  return base || null;
}

/**
 * Lista as corridas de moto propria (nao-Hub) no formato do card do painel.
 * Quando `regraId` e passado (portal da loja), retorna SO as que casam com ela.
 *
 * @param {import('pg').Pool} pool
 * @param {Object} [opts]
 * @param {number|null} [opts.regraId]  filtra pela regra efetiva (portal)
 * @returns {Promise<Array<Object>>}  objetos no shape do card (provider_code:'proprio')
 */
async function listarMotoProprias(pool, opts = {}) {
  const regraId = opts.regraId != null ? Number(opts.regraId) : null;
  if (!pool) return [];

  let regras = [];
  try {
    const r = await pool.query(
      `SELECT id, cliente_nome, trecho_endereco, cliente_identificador
         FROM logistics_dispatch_rules
        WHERE ativo = true
        ORDER BY id ASC`
    );
    regras = r.rows || [];
  } catch (e) {
    // Sem regras nao quebra o painel admin (regra_id fica null); o portal, que
    // depende da regra, simplesmente nao acha nada.
    console.warn('[MotoPropriaResolver] regras indisponiveis:', e.message);
  }

  let candidatos = [];
  try {
    const q = await pool.query(
      `SELECT s.os_numero, s.cliente_cod, s.cliente_nome, s.nome_profissional,
              s.cod_profissional, s.link_rastreio, s.cod_rastreio,
              s.deadline, s.prazo_min, s.distancia_km, s.centro_custo,
              s.horario_inicio, s.primeira_vista_em, s.ultima_vista_em,
              c.pontos_json, c.coleta_texto
         FROM sla_monitor_snapshot s
         JOIN sla_capturas c ON c.os_numero = s.os_numero
        WHERE s.em_execucao = TRUE
          AND s.situacao = 'em_execucao'
          AND s.cod_profissional IS NOT NULL
          AND s.cod_profissional <> ''
          AND NOT EXISTS (
            SELECT 1 FROM logistics_deliveries ld
             WHERE ld.codigo_os::text = s.os_numero
          )
        ORDER BY s.primeira_vista_em DESC
        LIMIT ${LIMITE}`
    );
    candidatos = q.rows || [];
  } catch (e) {
    console.warn('[MotoPropriaResolver] consulta de candidatos falhou:', e.message);
    return [];
  }

  const saida = [];
  for (const row of candidatos) {
    const reg = resolverRegraPorColeta(row.coleta_texto, regras);

    // Portal: descarta o que nao casa com a regra logada.
    if (regraId != null && reg.regra_id !== regraId) continue;

    const ponto = ultimoPontoEntrega(row.pontos_json);
    const cf = extrairClienteFinalENota({
      texto: (ponto && (ponto.textoBruto || ponto.endereco)) || null,
      nome: (ponto && (ponto.nomeCliente || ponto.nome)) || null,
      nota: (ponto && ponto.nota) || null,
      clienteCod: row.cliente_cod || null,
    });

    const enderecoEntrega = (ponto && (ponto.endereco || ponto.textoBruto)) || null;

    saida.push({
      // marcadores da moto propria
      is_moto_propria:    true,
      provider_code:      'proprio',

      // id sintetico (nao ha linha em logistics_deliveries) — key estavel no
      // React; nenhuma acao de Hub aceita este id (o front esconde as acoes).
      id:                 'mp-' + String(row.os_numero),
      codigo_os:          row.os_numero,

      // cliente final + NF (mesma fonte/parso do card do Hub)
      cliente_final:      cf.cliente_final,
      nota_fiscal:        cf.nota_fiscal,

      // status: tem motoboy e esta rodando -> cai na coluna "Aguardando coleta".
      // O badge "Moto propria" no card distingue.
      status_canonico:    'COURIER_ASSIGNED',
      status_uber:        'entregador_atribuido',

      // rastreio: SEM token Tutts do Hub -> o card usa tracking_url (link nativo
      // Tutts) e abre a pagina de rastreamento da Tutts.
      tracking_url:       row.link_rastreio || null,
      rastreio_token:     null,
      cod_rastreio:       row.cod_rastreio || null,

      // enderecos / pontos
      endereco_entrega:   enderecoEntrega,
      endereco_coleta:    row.coleta_texto || null,

      // motoboy proprio
      entregador_nome:      row.nome_profissional || null,
      entregador_telefone:  null,
      entregador_placa:     null,
      entregador_veiculo:   null,
      cod_profissional:     row.cod_profissional || null,

      // SLA / contexto
      sla_deadline:       row.deadline || null,
      prazo_min:          row.prazo_min != null ? Number(row.prazo_min) : null,
      distancia_km:       row.distancia_km != null ? Number(row.distancia_km) : null,
      centro_custo:       row.centro_custo || null,
      cliente_nome_regra: reg.cliente_nome_regra || row.cliente_nome || null,
      regra_id:           reg.regra_id,

      // sem valores (moto propria nao passa pelo Hub) — mantem o shape do card
      valor_servico:      null,
      valor_uber:         null,
      valor_provider:     null,
      valor_profissional: null,

      created_at:         row.horario_inicio || row.primeira_vista_em || null,
      updated_at:         row.ultima_vista_em || null,
    });
  }

  return saida;
}

module.exports = { listarMotoProprias, resolverRegraPorColeta };
