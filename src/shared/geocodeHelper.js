/**
 * src/shared/geocodeHelper.js
 *
 * Helper unificado de geocoding com cache central (enderecos_geocodificados).
 *
 * Substitui chamadas diretas a `https://maps.googleapis.com/maps/api/geocode/json`
 * espalhadas pelo backend. Todo consumidor passa por aqui → garantia de cache hit.
 *
 * Exports:
 *   geocodeForward(pool, endereco)
 *     → { latitude, longitude, endereco_formatado, fonte: 'cache'|'google' } | null
 *
 *   geocodeReverse(pool, lat, lng, opts?)
 *     → { latitude, longitude, endereco_formatado, fonte } | null
 *     opts.tolerancia_graus: default 0.0005 (~55m) — quanto maior, mais cache hit
 *
 * Por que centralizar:
 *   1. Um cache só (enderecos_geocodificados) servindo todo o sistema
 *   2. Telemetria opcional pra rastrear quem está chamando mais
 *   3. Fácil de adicionar TTL/retry futuramente em um lugar só
 */
'use strict';

/**
 * Normaliza endereço para chave de cache (igual ao /api/geocode/google).
 * Mantém compatibilidade com cache existente.
 */
function normalizarEndereco(endereco) {
  if (!endereco) return '';
  return String(endereco)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Forward geocoding: endereço → lat/lng
 * @returns {Promise<{latitude, longitude, endereco_formatado, fonte}|null>}
 */
async function geocodeForward(pool, endereco, opts = {}) {
  const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!endereco || !endereco.trim()) return null;

  const enderecoNorm = normalizarEndereco(endereco);
  const source = opts.source || 'unknown';

  // 1) Cache hit
  try {
    const r = await pool.query(
      `SELECT id, endereco_formatado, latitude, longitude, fonte
         FROM enderecos_geocodificados
        WHERE endereco_busca_normalizado = $1
        LIMIT 1`,
      [enderecoNorm]
    );
    if (r.rows.length > 0) {
      const c = r.rows[0];
      // Atualiza contador (best-effort, não bloqueia)
      pool.query(
        `UPDATE enderecos_geocodificados
            SET acessos = acessos + 1, ultimo_acesso = NOW()
          WHERE id = $1`,
        [c.id]
      ).catch(() => {});
      return {
        latitude: parseFloat(c.latitude),
        longitude: parseFloat(c.longitude),
        endereco_formatado: c.endereco_formatado,
        fonte: 'cache',
      };
    }
  } catch (e) {
    console.warn(`[geocodeHelper:${source}] cache read falhou:`, e.message);
  }

  // 2) Cache miss → Google
  if (!GOOGLE_API_KEY) {
    console.warn(`[geocodeHelper:${source}] GOOGLE_GEOCODING_API_KEY não configurada`);
    return null;
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endereco)}&key=${GOOGLE_API_KEY}&region=br&language=pt-BR&components=country:br`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      if (data.status === 'REQUEST_DENIED') {
        console.error(`[geocodeHelper:${source}] REQUEST_DENIED — billing pode estar inativo`);
      }
      return null;
    }
    const r0 = data.results[0];
    const lat = r0.geometry.location.lat;
    const lng = r0.geometry.location.lng;
    const formatado = r0.formatted_address;

    // 3) Popula cache (best-effort)
    pool.query(
      `INSERT INTO enderecos_geocodificados
         (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [endereco, enderecoNorm, formatado, lat, lng, 'google']
    ).catch(() => {});

    console.log(`[geocodeHelper:${source}] 💸 Google call — ${endereco.slice(0, 60)}`);

    return {
      latitude: lat,
      longitude: lng,
      endereco_formatado: formatado,
      fonte: 'google',
    };
  } catch (e) {
    console.warn(`[geocodeHelper:${source}] google falhou:`, e.message);
    return null;
  }
}

/**
 * Reverse geocoding: lat/lng → endereço
 * Tenta cache primeiro com tolerância de N metros (default ~55m).
 * @returns {Promise<{latitude, longitude, endereco_formatado, fonte}|null>}
 */
async function geocodeReverse(pool, lat, lng, opts = {}) {
  const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

  const tol = opts.tolerancia_graus || 0.0005; // ~55m
  const source = opts.source || 'unknown';

  // 1) Cache hit (busca por proximidade)
  try {
    const r = await pool.query(
      `SELECT endereco_formatado, latitude, longitude, fonte
         FROM enderecos_geocodificados
        WHERE latitude BETWEEN $1 - $3 AND $1 + $3
          AND longitude BETWEEN $2 - $3 AND $2 + $3
        ORDER BY (POWER(latitude - $1, 2) + POWER(longitude - $2, 2)) ASC
        LIMIT 1`,
      [latNum, lngNum, tol]
    );
    if (r.rows.length > 0) {
      const c = r.rows[0];
      return {
        latitude: parseFloat(c.latitude),
        longitude: parseFloat(c.longitude),
        endereco_formatado: c.endereco_formatado,
        fonte: 'cache',
      };
    }
  } catch (e) {
    console.warn(`[geocodeHelper:${source}] reverse cache read falhou:`, e.message);
  }

  // 2) Cache miss → Google
  if (!GOOGLE_API_KEY) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latNum},${lngNum}&key=${GOOGLE_API_KEY}&language=pt-BR`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results || data.results.length === 0) return null;
    const formatado = data.results[0].formatted_address;
    const latlngKey = `${latNum.toFixed(6)},${lngNum.toFixed(6)}`;

    pool.query(
      `INSERT INTO enderecos_geocodificados
         (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [latlngKey, latlngKey, formatado, latNum, lngNum, 'google-reverse']
    ).catch(() => {});

    console.log(`[geocodeHelper:${source}] 💸 Google reverse call — ${latlngKey}`);

    return {
      latitude: latNum,
      longitude: lngNum,
      endereco_formatado: formatado,
      fonte: 'google',
    };
  } catch (e) {
    console.warn(`[geocodeHelper:${source}] google reverse falhou:`, e.message);
    return null;
  }
}

module.exports = {
  geocodeForward,
  geocodeReverse,
  normalizarEndereco,
};
