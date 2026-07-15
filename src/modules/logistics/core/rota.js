/**
 * MODULO LOGISTICS - core/rota.js
 *
 * Rota real (por rua) entre coleta e entrega, via OpenRouteService.
 * Marker: PORTAL_MAPA_ROTA_V1
 *
 * POR QUE ISSO E BARATO
 * ---------------------
 * A rota COLETA -> ENTREGA nao muda enquanto o motoboy anda. Os dois
 * pontos sao fixos desde o despacho. Entao ela e calculada UMA VEZ por
 * corrida e gravada em logistics_deliveries.rota_json.
 *
 * Isso e o oposto do cenario caro que eu tinha estimado antes (rota do
 * MOTOBOY ate o alvo, que muda a cada 30s e daria ~840 chamadas/hora).
 * Aqui e ~1 chamada por OS, pra sempre. Com ~100 OS/dia, fica bem abaixo
 * do free tier do ORS (2.000/dia).
 *
 * O ETA continua por haversine (core/geo.js). Nao troquei: o ETA e do
 * motoboy ate o alvo AGORA, e isso sim mudaria a cada refresh.
 * Esta rota e so o DESENHO da corrida.
 */

'use strict';

const ORS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car/geojson';

/**
 * Quantas rotas calcular por request do /portal/mapa.
 * O ORS free tier permite ~40 directions/min. Com poll de 30s, 4 por
 * request = no maximo 8/min. Folga grande, e a resposta nao trava.
 * As que sobrarem entram no proximo refresh.
 */
const MAX_ROTAS_POR_REQUEST = (() => {
  const v = Number(process.env.MAPA_MAX_ROTAS_REQ);
  return Number.isFinite(v) && v > 0 ? v : 4;
})();

/**
 * Busca a rota no ORS. Devolve { pontos, metros, segundos } ou null.
 *
 * ATENCAO AO EIXO: o ORS fala [lng, lat] (padrao GeoJSON); o Leaflet fala
 * [lat, lng]. Inverter e o bug classico aqui — a rota apareceria no meio
 * do Atlantico. Convertemos na saida.
 */
async function buscarRotaORS(httpRequest, coleta, entrega) {
  const key = process.env.ORS_API_KEY;
  if (!key) return null;
  if (!coleta || !entrega) return null;
  if (coleta.lat == null || coleta.lng == null) return null;
  if (entrega.lat == null || entrega.lng == null) return null;

  try {
    const resp = await httpRequest(ORS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({
        coordinates: [
          [Number(coleta.lng), Number(coleta.lat)],   // ORS: [lng, lat]
          [Number(entrega.lng), Number(entrega.lat)],
        ],
      }),
    });
    if (!resp.ok) {
      console.warn('[logistics/rota] ORS respondeu', resp.status);
      return null;
    }
    const data = resp.json();
    const feat = data && data.features && data.features[0];
    if (!feat || !feat.geometry || !Array.isArray(feat.geometry.coordinates)) return null;

    // [lng,lat] -> [lat,lng] pro Leaflet
    const pontos = feat.geometry.coordinates
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map((c) => [Number(c[1]), Number(c[0])]);
    if (pontos.length < 2) return null;

    const sum = (feat.properties && feat.properties.summary) || {};
    return {
      pontos,
      metros: Number.isFinite(Number(sum.distance)) ? Math.round(Number(sum.distance)) : null,
      segundos: Number.isFinite(Number(sum.duration)) ? Math.round(Number(sum.duration)) : null,
    };
  } catch (e) {
    console.warn('[logistics/rota] erro ORS:', e.message);
    return null;
  }
}

/**
 * Reduz a rota a no maximo `max` pontos, preservando primeiro e ultimo.
 * O ORS devolve geometria detalhada (centenas de vertices por km); no zoom
 * de cidade isso e payload puro. 120 pontos ja desenha uma curva suave.
 */
function reduzirRota(pontos, max = 120) {
  if (!Array.isArray(pontos) || pontos.length <= max) return pontos || [];
  const passo = (pontos.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(pontos[Math.round(i * passo)]);
  out[out.length - 1] = pontos[pontos.length - 1];
  return out;
}

/**
 * Garante a rota das entregas passadas, calculando SO as que faltam e
 * gravando no banco. Devolve um mapa { [delivery_id]: pontos }.
 *
 * Regra de recalculo: so tenta se rota_json e NULL e a ultima tentativa
 * foi ha mais de 30 min (ou nunca houve). Sem isso, uma OS com coordenada
 * ruim faria o ORS ser chamado a cada 30s pra sempre.
 */
async function garantirRotas(pool, httpRequest, linhas) {
  const saida = {};
  const pendentes = [];

  for (const ld of linhas) {
    if (ld.rota_json) {
      let r = ld.rota_json;
      if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { r = null; } }
      if (Array.isArray(r) && r.length > 1) { saida[ld.id] = r; continue; }
    }
    if (ld.latitude_coleta == null || ld.longitude_coleta == null) continue;
    if (ld.latitude_entrega == null || ld.longitude_entrega == null) continue;
    // Ja tentamos ha pouco e falhou? Deixa quieto ate a janela passar.
    if (ld.rota_calculada_at) {
      const idadeMin = (Date.now() - new Date(ld.rota_calculada_at).getTime()) / 60000;
      if (idadeMin < 30) continue;
    }
    pendentes.push(ld);
  }

  const lote = pendentes.slice(0, MAX_ROTAS_POR_REQUEST);
  for (const ld of lote) {
    const r = await buscarRotaORS(
      httpRequest,
      { lat: ld.latitude_coleta, lng: ld.longitude_coleta },
      { lat: ld.latitude_entrega, lng: ld.longitude_entrega }
    );
    const pontos = r ? reduzirRota(r.pontos, 120) : null;
    try {
      await pool.query(
        `UPDATE logistics_deliveries
            SET rota_json = $1, rota_metros = $2, rota_segundos = $3, rota_calculada_at = NOW()
          WHERE id = $4`,
        [pontos ? JSON.stringify(pontos) : null, r ? r.metros : null, r ? r.segundos : null, ld.id]
      );
    } catch (e) {
      console.warn('[logistics/rota] erro ao gravar rota da OS', ld.codigo_os, e.message);
    }
    if (pontos) saida[ld.id] = pontos;
  }

  return saida;
}

module.exports = { buscarRotaORS, garantirRotas, reduzirRota, MAX_ROTAS_POR_REQUEST };
