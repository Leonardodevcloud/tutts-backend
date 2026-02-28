/**
 * location-normalizer.js
 * Normaliza strings de localização em { latitude, longitude }.
 *
 * Formatos suportados:
 *   A) Link curto:    https://maps.app.goo.gl/XXXXX
 *   B) Link completo: https://www.google.com/maps?q=LAT,LNG  (ou @LAT,LNG)
 *   C) Coordenadas:   -16.738952, -49.293811
 */

'use strict';

const RE_AT  = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/;
const RE_Q   = /[?&]q=(-?\d+\.?\d*)(?:%2C|,)(-?\d+\.?\d*)/i;
const RE_RAW = /^\s*(-?\d{1,3}\.?\d*)\s*,\s*(-?\d{1,3}\.?\d*)\s*$/;

function validateCoords(lat, lng) {
  if (isNaN(lat) || isNaN(lng))
    throw new Error('Coordenadas inválidas: não são números.');
  if (lat < -90 || lat > 90)
    throw new Error(`Latitude inválida: ${lat}. Deve estar entre -90 e 90.`);
  if (lng < -180 || lng > 180)
    throw new Error(`Longitude inválida: ${lng}. Deve estar entre -180 e 180.`);
}

function extractFromUrl(url) {
  let m = RE_AT.exec(url);
  if (m) return { latitude: parseFloat(m[1]), longitude: parseFloat(m[2]) };
  m = RE_Q.exec(url);
  if (m) return { latitude: parseFloat(m[1]), longitude: parseFloat(m[2]) };
  return null;
}

async function resolveShortLink(shortUrl) {
  try {
    const res = await fetch(shortUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TuttsAgent/1.0)' },
    });
    return res.url;
  } catch {
    const res = await fetch(shortUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TuttsAgent/1.0)' },
    });
    return res.url;
  }
}

async function normalizeLocation(raw) {
  if (!raw || typeof raw !== 'string')
    throw new Error('Localização não informada.');

  const trimmed = raw.trim();

  // Formato C: Coordenadas brutas
  const rawMatch = RE_RAW.exec(trimmed);
  if (rawMatch) {
    const lat = parseFloat(rawMatch[1]);
    const lng = parseFloat(rawMatch[2]);
    validateCoords(lat, lng);
    return { latitude: lat, longitude: lng };
  }

  if (!trimmed.startsWith('http')) {
    throw new Error(
      'Formato não reconhecido. Use um link do Google Maps ou coordenadas "-16.73, -49.29".'
    );
  }

  let urlStr = trimmed;

  // Formato A: Link curto
  if (/maps\.app\.goo\.gl/i.test(urlStr)) {
    urlStr = await resolveShortLink(urlStr);
  }

  // Formato B: Link completo
  const coords = extractFromUrl(urlStr);
  if (coords) {
    validateCoords(coords.latitude, coords.longitude);
    return coords;
  }

  throw new Error(
    `Não foi possível extrair coordenadas da URL: ${urlStr}`
  );
}

module.exports = { normalizeLocation };
