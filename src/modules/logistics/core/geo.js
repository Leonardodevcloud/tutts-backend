/**
 * MODULO LOGISTICS - core/geo.js
 *
 * Helpers geograficos compartilhados. Marker: PORTAL_MAPA_GEO_V1
 *
 * SOBRE A DUPLICACAO DO haversineKm:
 *   O DispatchOrchestrator tem uma copia identica desta funcao, privada
 *   (nao exportada). NAO refatorei ele pra importar daqui de proposito: o
 *   orquestrador e o caminho critico de despacho, e mexer nele pra ganhar
 *   uma linha nao paga o risco. Se um dia o DispatchOrchestrator for
 *   tocado por outro motivo, a hora de unificar e essa.
 *
 * SOBRE O ETA:
 *   Nenhum provedor (99 ou Uber) devolve tempo estimado ao vivo:
 *     - 99: /v2/order/detail traz driver_info.location, mas nao ETA.
 *           O delivery_duration so aparece no /estimate (cotacao).
 *     - Uber: o webhook traz posicao, nao ETA.
 *   Logo, o ETA e CALCULADO aqui. E uma ESTIMATIVA, nao promessa:
 *   linha reta * fator de desvio urbano / velocidade media.
 *
 *   Erra em cidade com rio, viaduto, mao unica ou obra. Serve pra dar
 *   ordem de grandeza ("~11 min"), nao pra cobrar SLA.
 */

'use strict';

/**
 * Distancia em km entre dois pontos (Haversine).
 * Retorna null se algum ponto for invalido.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  // Number(null) === 0 e Number('') === 0 (finitos!) — rejeita explicitamente
  // antes, senao coordenada ausente viraria 0 e calcularia distancia lixo.
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || v === '')) return null;
  const a1 = Number(lat1), o1 = Number(lon1), a2 = Number(lat2), o2 = Number(lon2);
  if (![a1, o1, a2, o2].every((n) => Number.isFinite(n))) return null;
  const R = 6371; // raio da Terra em km
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(a2 - a1);
  const dLon = rad(o2 - o1);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Fator de desvio urbano: rua nao e linha reta. Multiplica a distancia
 * geodesica pra aproximar a distancia rodada de verdade.
 * ~1.35 e o valor tipico pra malha urbana brasileira.
 */
const FATOR_RUA = (() => {
  const v = Number(process.env.MAPA_FATOR_RUA);
  return Number.isFinite(v) && v > 0 ? v : 1.35;
})();

/**
 * Velocidade media de moto em cidade, porta a porta (ja embute semaforo,
 * transito e o tempo de achar o endereco).
 */
const VEL_MOTO_KMH = (() => {
  const v = Number(process.env.MAPA_VEL_MOTO_KMH);
  return Number.isFinite(v) && v > 0 ? v : 22;
})();

/**
 * ETA em minutos a partir da distancia em LINHA RETA.
 * Retorna null se a distancia for invalida.
 * Piso de 1 min: "0 min" e pior que inutil, parece bug.
 */
function estimarEtaMin(kmLinhaReta) {
  if (kmLinhaReta == null || !Number.isFinite(Number(kmLinhaReta))) return null;
  const kmRua = Number(kmLinhaReta) * FATOR_RUA;
  const min = (kmRua / VEL_MOTO_KMH) * 60;
  if (!Number.isFinite(min)) return null;
  return Math.max(1, Math.round(min));
}

/**
 * Reduz uma lista de pontos [[lat,lng],...] pra no maximo `max`, mantendo
 * SEMPRE o primeiro e o ultimo. Um tracado de 1h com poll de 30s tem ~120
 * pontos; com 7 entregas isso vira payload a toa, e no zoom do mapa a
 * diferenca nem aparece.
 */
function reduzirPontos(pontos, max = 60) {
  if (!Array.isArray(pontos) || pontos.length <= max) return pontos || [];
  const passo = (pontos.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(pontos[Math.round(i * passo)]);
  // Garante o ultimo exato (Math.round pode cair 1 antes).
  out[out.length - 1] = pontos[pontos.length - 1];
  return out;
}

module.exports = {
  haversineKm,
  estimarEtaMin,
  reduzirPontos,
  FATOR_RUA,
  VEL_MOTO_KMH,
};
