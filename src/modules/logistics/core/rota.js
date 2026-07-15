/**
 * MODULO LOGISTICS - core/rota.js
 *
 * Rota real (por rua) entre coleta e entrega.
 * Marker: PORTAL_MAPA_ROTA_V1
 * Marker: PORTAL_MAPA_ROTA_DIAG_V1  — diagnostico
 * Marker: PORTAL_MAPA_ROTA_OSRM_V1  — ORS -> OSRM
 *
 * POR QUE OSRM E NAO ORS
 * ----------------------
 * A v1 usava OpenRouteService, que exige ORS_API_KEY. Sem a env, ela
 * falhava e o mapa caia na linha reta.
 *
 * O solicitacao.html JA resolvia isso em producao com OSRM
 * (router.project-osrm.org): servidor publico, SEM CHAVE. Nao ha motivo
 * pra este modulo inventar outro caminho — passou a usar o mesmo.
 *
 * Diferencas do ORS que importam aqui:
 *   - GET, nao POST. Coordenadas na URL.
 *   - Sem Authorization.
 *   - Resposta: { code:'Ok', routes:[{ geometry:{coordinates}, distance, duration }] }
 *     (o ORS devolvia features[0].properties.summary)
 *   - EIXO IGUAL: OSRM tambem fala [lng,lat] (GeoJSON). A inversao pro
 *     Leaflet continua necessaria.
 *
 * POR QUE ISSO E BARATO
 * ---------------------
 * A rota COLETA -> ENTREGA nao muda enquanto o motoboy anda: os dois
 * pontos sao fixos desde o despacho. Calculada UMA vez por corrida e
 * gravada em logistics_deliveries.rota_json.
 *
 * O ETA continua por haversine (core/geo.js) — ele mede motoboy -> alvo
 * AGORA, e isso muda a cada refresh. Esta rota e so o DESENHO.
 *
 * O SERVIDOR PUBLICO DO OSRM nao tem SLA e pede uso moderado. Como
 * cacheamos no banco, sao ~1 chamada por OS. Se um dia precisar de
 * garantia, da pra subir um OSRM proprio e trocar so a env OSRM_BASE_URL.
 */

'use strict';

/** Base do OSRM. Publico por padrao; da pra apontar pra um self-hosted. */
const OSRM_BASE = (process.env.OSRM_BASE_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');

/**
 * Quantas rotas calcular por request do /portal/mapa.
 * O servidor publico do OSRM pede uso moderado. Com poll de 30s, 4 por
 * request = no maximo 8/min. E a resposta nao trava.
 * As que sobrarem entram no proximo refresh.
 */
const MAX_ROTAS_POR_REQUEST = (() => {
  const v = Number(process.env.MAPA_MAX_ROTAS_REQ);
  return Number.isFinite(v) && v > 0 ? v : 4;
})();

/**
 * Busca a rota no OSRM. Devolve { pontos, metros, segundos } ou null.
 *
 * ATENCAO AO EIXO: o OSRM fala [lng, lat] (padrao GeoJSON); o Leaflet fala
 * [lat, lng]. Inverter e o bug classico aqui — a rota apareceria no meio
 * do Atlantico. Convertemos na saida.
 */
async function buscarRotaOSRM(httpRequest, coleta, entrega, diag) {
  if (!coleta || !entrega) return null;
  if (coleta.lat == null || coleta.lng == null) return null;
  if (entrega.lat == null || entrega.lng == null) return null;

  // OSRM: /route/v1/driving/{lng},{lat};{lng},{lat}
  const url = OSRM_BASE + '/route/v1/driving/'
    + Number(coleta.lng) + ',' + Number(coleta.lat) + ';'
    + Number(entrega.lng) + ',' + Number(entrega.lat)
    + '?overview=full&geometries=geojson';

  try {
    const resp = await httpRequest(url);
    if (!resp.ok) {
      let corpo = '';
      try { corpo = JSON.stringify(resp.json()).slice(0, 300); } catch (_) { corpo = ''; }
      const msg = 'OSRM HTTP ' + resp.status + ' ' + corpo;
      console.error('[logistics/rota]', msg);
      if (diag) { diag.motivo = msg; diag.erros = (diag.erros || 0) + 1; }
      return null;
    }
    const data = resp.json();
    // OSRM sinaliza problema no campo `code` mesmo com HTTP 200.
    if (!data || data.code !== 'Ok' || !data.routes || !data.routes[0]) {
      const msg = 'OSRM sem rota: ' + JSON.stringify(data).slice(0, 200);
      console.warn('[logistics/rota]', msg);
      if (diag) { diag.motivo = msg; diag.erros = (diag.erros || 0) + 1; }
      return null;
    }
    const rota = data.routes[0];
    const coords = rota.geometry && rota.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      const msg = 'OSRM devolveu geometria vazia';
      console.warn('[logistics/rota]', msg);
      if (diag) { diag.motivo = msg; diag.erros = (diag.erros || 0) + 1; }
      return null;
    }

    // [lng,lat] -> [lat,lng] pro Leaflet
    const pontos = coords
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map((c) => [Number(c[1]), Number(c[0])]);
    if (pontos.length < 2) return null;

    return {
      pontos,
      metros: Number.isFinite(Number(rota.distance)) ? Math.round(Number(rota.distance)) : null,
      segundos: Number.isFinite(Number(rota.duration)) ? Math.round(Number(rota.duration)) : null,
    };
  } catch (e) {
    console.error('[logistics/rota] erro OSRM:', e.message);
    if (diag) { diag.motivo = 'excecao: ' + e.message; diag.erros = (diag.erros || 0) + 1; }
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
  // Diagnostico: vai junto na resposta do /portal/mapa. Abrir o devtools
  // na aba Network e olhar rota_diag responde "por que esta reta?" sem
  // precisar caçar log no Railway.
  const diag = {
    // OSRM nao usa chave. O campo fica pra nao quebrar quem ja le o diag.
    ors_configurado: true,
    motor: 'osrm',
    base: OSRM_BASE,
    total: linhas.length,
    em_cache: 0,
    calculadas: 0,
    pendentes: 0,
    sem_coordenada: 0,
    aguardando_janela: 0,
    erros: 0,
    motivo: null,
  };

  for (const ld of linhas) {
    if (ld.rota_json) {
      let r = ld.rota_json;
      if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { r = null; } }
      if (Array.isArray(r) && r.length > 1) { saida[ld.id] = r; diag.em_cache++; continue; }
    }
    if (ld.latitude_coleta == null || ld.longitude_coleta == null ||
        ld.latitude_entrega == null || ld.longitude_entrega == null) {
      diag.sem_coordenada++;
      continue;
    }
    // Ja tentamos ha pouco e falhou? Deixa quieto ate a janela passar.
    if (ld.rota_calculada_at) {
      const idadeMin = (Date.now() - new Date(ld.rota_calculada_at).getTime()) / 60000;
      if (idadeMin < 30) { diag.aguardando_janela++; continue; }
    }
    pendentes.push(ld);
  }
  diag.pendentes = pendentes.length;

  const lote = pendentes.slice(0, MAX_ROTAS_POR_REQUEST);
  for (const ld of lote) {
    const r = await buscarRotaOSRM(
      httpRequest,
      { lat: ld.latitude_coleta, lng: ld.longitude_coleta },
      { lat: ld.latitude_entrega, lng: ld.longitude_entrega },
      diag
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
    if (pontos) { saida[ld.id] = pontos; diag.calculadas++; }
  }

  if (diag.pendentes > 0 && diag.calculadas === 0 && !diag.motivo) {
    diag.motivo = 'havia rotas pendentes mas nenhuma foi calculada — ver os logs [logistics/rota]';
  }
  return { rotas: saida, diag };
}

// buscarRotaORS sai do export: o ORS nao e mais usado.
module.exports = { buscarRotaOSRM, garantirRotas, reduzirRota, MAX_ROTAS_POR_REQUEST };
