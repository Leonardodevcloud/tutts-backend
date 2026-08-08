// MotoPropriaResolver.js
// MOTO_PROPRIA_V3 — surfacea no painel (admin + portal) as corridas que sairam
// com MOTO PROPRIA do cliente (nao passaram pelo Hub, ou passaram e cairam) e
// por isso nao tem uma linha ATIVA em logistics_deliveries.
//
// FONTES:
//   - sla_monitor_snapshot : motoboy (nome/cod), link_rastreio (rastreio nativo
//                            Tutts), deadline/prazo, em_execucao, situacao, centro.
//                            O detector coleta TODOS os clientes (nao so os
//                            rastreados), entao o snapshot cobre qualquer cliente.
//   - logistics_deliveries : quando a OS JA passou pelo Hub e foi cancelada/
//                            falhou, a ULTIMA linha ja tem regra, enderecos,
//                            pontos (cliente final + NF). Fonte primaria.
//   - sla_capturas         : fallback pros clientes RASTREADOS que nunca
//                            passaram pelo Hub (pontos_json + coleta_texto).
//
// QUEM E "MOTO PROPRIA":
//   snapshot em_execucao=TRUE, situacao='em_execucao' (JA tem motoboy) E a OS
//   NAO tem uma corrida do Hub ATIVA. Se a unica linha do Hub e terminal
//   (CANCELED/FAILED/RETURNED) ou foi cancelada por admin -> veio_do_hub=TRUE
//   e a OS volta como moto propria. LEFT JOIN (nao INNER) em sla_capturas:
//   cliente nao-rastreado tambem aparece, usando os dados do Hub.
//
// READ-ONLY: nao escreve nada. Nao toca em metricas/financeiro do Hub.

'use strict';

const { extrairClienteFinalENota } = require('./ClienteFinalParser');
const { normalizarEnderecoParaMatch } = require('./DispatchRuleMatcher');

const LIMITE = 500;

/**
 * Casa a regra pelo endereco de coleta (mesmo match do DispatchRuleMatcher).
 * Usado so no fallback (cliente rastreado que nunca passou pelo Hub).
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

// Ultimo ponto de entrega (numero >= 2) de um pontos_json/pontos ja normalizado.
function ultimoPontoEntrega(pontos) {
  let pts = pontos;
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
 * @param {number|null} [opts.regraId]
 * @returns {Promise<Array<Object>>}
 */
async function listarMotoProprias(pool, opts = {}) {
  const regraId = opts.regraId != null ? Number(opts.regraId) : null;
  if (!pool) return [];

  let regras = [];
  try {
    const r = await pool.query(
      `SELECT id, cliente_nome, trecho_endereco, cliente_identificador
         FROM logistics_dispatch_rules WHERE ativo = true ORDER BY id ASC`
    );
    regras = r.rows || [];
  } catch (e) {
    console.warn('[MotoPropriaResolver] regras indisponiveis:', e.message);
  }

  let candidatos = [];
  try {
    const q = await pool.query(
      `SELECT s.os_numero, s.cliente_cod, s.cliente_nome, s.nome_profissional,
              s.cod_profissional, s.link_rastreio, s.cod_rastreio,
              s.deadline, s.prazo_min, s.distancia_km, s.centro_custo,
              s.horario_inicio, s.primeira_vista_em, s.ultima_vista_em,
              c.pontos_json, c.coleta_texto,
              hub.codigo_os        AS hub_codigo_os,
              hub.regra_id         AS hub_regra_id,
              hub.endereco_coleta  AS hub_end_coleta,
              hub.endereco_entrega AS hub_end_entrega,
              hub.pontos           AS hub_pontos,
              hub.cliente_nome_regra AS hub_cliente_nome_regra
         FROM sla_monitor_snapshot s
         LEFT JOIN sla_capturas c ON c.os_numero = s.os_numero
         LEFT JOIN LATERAL (
           SELECT d.codigo_os,
                  COALESCE(d.regra_id_manual, d.regra_id) AS regra_id,
                  d.endereco_coleta, d.endereco_entrega, d.pontos,
                  r.cliente_nome AS cliente_nome_regra
             FROM logistics_deliveries d
             LEFT JOIN logistics_dispatch_rules r ON r.id = COALESCE(d.regra_id_manual, d.regra_id)
            WHERE d.codigo_os::text = s.os_numero
            ORDER BY d.id DESC
            LIMIT 1
         ) hub ON true
        WHERE s.em_execucao = TRUE
          AND s.situacao = 'em_execucao'
          AND s.cod_profissional IS NOT NULL
          AND s.cod_profissional <> ''
          -- Exclui apenas se ha corrida do Hub ATIVA (ou entregue pelo Hub).
          -- Se a linha do Hub e CANCELED/FAILED/RETURNED (ou cancelada por
          -- admin), a OS caiu no moto proprio -> ELEGIVEL. Como sobreviventes
          -- so tem linha do Hub terminal, hub.codigo_os != null => veio do Hub.
          AND NOT EXISTS (
            SELECT 1 FROM logistics_deliveries ld
             WHERE ld.codigo_os::text = s.os_numero
               AND ld.cancelado_por IS NULL
               AND COALESCE(ld.status_canonico,'') NOT IN ('CANCELED','FAILED','RETURNED')
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
    const veioDoHub = row.hub_codigo_os != null;

    // regra: 1) do Hub (linha cancelada ja tem) 2) casada pela coleta capturada
    let regra_id = row.hub_regra_id != null ? Number(row.hub_regra_id) : null;
    let cliente_nome_regra = row.hub_cliente_nome_regra || null;
    if (regra_id == null && row.coleta_texto) {
      const reg = resolverRegraPorColeta(row.coleta_texto, regras);
      regra_id = reg.regra_id;
      cliente_nome_regra = cliente_nome_regra || reg.cliente_nome_regra;
    }

    // Portal: descarta o que nao casa com a regra logada.
    if (regraId != null && regra_id !== regraId) continue;

    // cliente final + NF + endereco: prioridade Hub (pontos da linha cancelada),
    // depois a captura (pontos_json). Uma fonte OU outra — a que existir.
    const pontoHub = ultimoPontoEntrega(row.hub_pontos);
    const pontoCap = ultimoPontoEntrega(row.pontos_json);
    const ponto = pontoHub || pontoCap;

    const cf = extrairClienteFinalENota({
      texto: (ponto && (ponto.textoBruto || ponto.endereco || ponto.rua)) || row.hub_end_entrega || null,
      nome: (ponto && (ponto.nomeCliente || ponto.nome)) || null,
      nota: (ponto && ponto.nota) || null,
      clienteCod: row.cliente_cod || null,
    });

    const enderecoEntrega = row.hub_end_entrega
      || (ponto && (ponto.endereco || ponto.rua || ponto.textoBruto)) || null;
    const enderecoColeta = row.hub_end_coleta || row.coleta_texto || null;

    saida.push({
      is_moto_propria:    true,
      provider_code:      'proprio',
      veio_do_hub:        veioDoHub,

      id:                 'mp-' + String(row.os_numero),
      codigo_os:          row.os_numero,

      cliente_final:      cf.cliente_final,
      nota_fiscal:        cf.nota_fiscal,

      status_canonico:    'COURIER_ASSIGNED',
      status_uber:        'entregador_atribuido',

      tracking_url:       row.link_rastreio || null,
      rastreio_token:     null,
      cod_rastreio:       row.cod_rastreio || null,

      endereco_entrega:   enderecoEntrega,
      endereco_coleta:    enderecoColeta,

      entregador_nome:      row.nome_profissional || null,
      entregador_telefone:  null,
      entregador_placa:     null,
      entregador_veiculo:   null,
      cod_profissional:     row.cod_profissional || null,

      sla_deadline:       row.deadline || null,
      prazo_min:          row.prazo_min != null ? Number(row.prazo_min) : null,
      distancia_km:       row.distancia_km != null ? Number(row.distancia_km) : null,
      centro_custo:       row.centro_custo || null,
      cliente_nome_regra: cliente_nome_regra || row.cliente_nome || null,
      regra_id:           regra_id,

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
