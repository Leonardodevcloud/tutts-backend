/**
 * validar-localizacao.js
 * Valida se a foto da fachada corresponde a um estabelecimento real nas proximidades.
 * 
 * Fluxo:
 * 1. Gemini Vision extrai o nome do estabelecimento da foto
 * 2. Google Places API busca estabelecimentos próximos às coordenadas GPS
 * 3. Compara os nomes (fuzzy match)
 * 
 * Resultado: { valido, nome_foto, match_google, confianca, detalhes }
 */

'use strict';

const { logger } = require('../../config/logger');

function log(msg) { logger.info(`[validar-loc] ${msg}`); }

/**
 * Extrai o nome do estabelecimento da foto via Gemini Vision
 */
async function extrairNomeDaFoto(base64Foto) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { log('⚠️ GEMINI_API_KEY não configurada'); return null; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  // Limpar prefixo se existir
  const puro = base64Foto.replace(/^data:image\/[a-z]+;base64,/, '');

  const body = {
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: puro
          }
        },
        {
          text: `Analise esta foto de uma fachada de estabelecimento comercial.

TAREFA: Extrair o NOME do estabelecimento visível na foto.

REGRAS:
- Leia placas, letreiros, faixadas e qualquer texto visível que identifique o nome do local
- Se houver múltiplos textos, priorize o nome principal do estabelecimento
- Ignore números de telefone, endereços, e textos secundários
- Se não conseguir identificar nenhum nome, retorne "NAO_IDENTIFICADO"

Responda APENAS em JSON, sem markdown:
{
  "nome_estabelecimento": "NOME AQUI",
  "confianca": 85,
  "textos_visiveis": ["texto1", "texto2"]
}`
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 300,
    }
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      log(`❌ Gemini erro ${resp.status}: ${err.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    const parsed = JSON.parse(clean);
    log(`📸 Gemini: "${parsed.nome_estabelecimento}" (confiança: ${parsed.confianca}%)`);
    return parsed;
  } catch (err) {
    log(`❌ Gemini exceção: ${err.message}`);
    return null;
  }
}

/**
 * Busca estabelecimentos próximos via Google Places API (New)
 */
async function buscarEstabelecimentosProximos(lat, lng, raioMetros) {
  const apiKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!apiKey) { log('⚠️ GOOGLE_GEOCODING_API_KEY não configurada'); return []; }

  const url = 'https://places.googleapis.com/v1/places:searchNearby';

  const body = {
    includedTypes: ['store', 'car_repair', 'car_parts_store', 'auto_parts_store', 'hardware_store', 'establishment'],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: raioMetros
      }
    }
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.types'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      log(`❌ Places API erro ${resp.status}: ${err.substring(0, 200)}`);
      // Fallback: tentar Text Search
      return await buscarTextSearch(lat, lng, raioMetros, apiKey);
    }

    const data = await resp.json();
    const places = (data.places || []).map(p => ({
      nome: p.displayName?.text || '',
      endereco: p.formattedAddress || '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      tipos: p.types || [],
    }));

    log(`📍 Places API: ${places.length} resultado(s) em ${raioMetros}m`);
    return places;
  } catch (err) {
    log(`❌ Places API exceção: ${err.message}`);
    return [];
  }
}

/**
 * Fallback: Text Search (caso Nearby Search não retorne resultados)
 */
async function buscarTextSearch(lat, lng, raioMetros, apiKey) {
  try {
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const body = {
      textQuery: 'auto peças loja',
      locationBias: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: raioMetros
        }
      },
      maxResultCount: 10,
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.places || []).map(p => ({
      nome: p.displayName?.text || '',
      endereco: p.formattedAddress || '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Normaliza string para comparação fuzzy
 */
function normalizar(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calcula similaridade entre duas strings (Dice coefficient)
 */
function similaridade(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (na === nb) return 1.0;
  if (na.length < 2 || nb.length < 2) return 0;

  // Bigrams
  const bigramsA = new Set();
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.substring(i, i + 2));
  const bigramsB = new Set();
  for (let i = 0; i < nb.length - 1; i++) bigramsB.add(nb.substring(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) { if (bigramsB.has(bg)) intersection++; }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Verifica se alguma palavra-chave do nome da foto aparece nos nomes do Google
 */
function contemPalavrasChave(nomeFoto, nomeGoogle) {
  const palavrasFoto = normalizar(nomeFoto).split(' ').filter(p => p.length > 2);
  const nomeGoogleNorm = normalizar(nomeGoogle);

  let matches = 0;
  for (const palavra of palavrasFoto) {
    if (nomeGoogleNorm.includes(palavra)) matches++;
  }

  return palavrasFoto.length > 0 ? matches / palavrasFoto.length : 0;
}

/**
 * VALIDAÇÃO PRINCIPAL
 * @returns {{ valido, nome_foto, match_google, confianca, lugares_proximos, detalhes }}
 */
async function validarLocalizacao(base64Foto, lat, lng) {
  const RAIO_BUSCA_METROS = 500;
  const LIMIAR_SIMILARIDADE = 0.35; // 35% — tolerante a abreviações
  const LIMIAR_PALAVRAS = 0.5; // 50% das palavras-chave

  log(`🔍 Validando: lat=${lat} lng=${lng}`);

  // 1. Extrair nome da foto via Gemini
  const gemini = await extrairNomeDaFoto(base64Foto);
  if (!gemini || gemini.nome_estabelecimento === 'NAO_IDENTIFICADO') {
    log('⚠️ Não conseguiu identificar nome na foto — aprovando (sem bloqueio)');
    return {
      valido: true,
      nome_foto: null,
      match_google: null,
      confianca: 0,
      motivo: 'Nome não identificável na foto',
      detalhes: { gemini }
    };
  }

  const nomeFoto = gemini.nome_estabelecimento;

  // 2. Buscar estabelecimentos próximos
  const lugares = await buscarEstabelecimentosProximos(lat, lng, RAIO_BUSCA_METROS);
  if (lugares.length === 0) {
    log(`⚠️ Nenhum estabelecimento encontrado em ${RAIO_BUSCA_METROS}m — aprovando`);
    return {
      valido: true,
      nome_foto: nomeFoto,
      match_google: null,
      confianca: 0,
      motivo: 'Nenhum estabelecimento encontrado no Google Maps nesta região',
      lugares_proximos: 0,
      detalhes: { gemini }
    };
  }

  // 3. Comparar nomes
  let melhorMatch = null;
  let melhorScore = 0;

  for (const lugar of lugares) {
    const scoreSimilaridade = similaridade(nomeFoto, lugar.nome);
    const scorePalavras = contemPalavrasChave(nomeFoto, lugar.nome);
    const scoreTotal = Math.max(scoreSimilaridade, scorePalavras);

    if (scoreTotal > melhorScore) {
      melhorScore = scoreTotal;
      melhorMatch = lugar;
    }
  }

  const confiancaPercent = Math.round(melhorScore * 100);
  const valido = melhorScore >= LIMIAR_SIMILARIDADE || melhorScore >= LIMIAR_PALAVRAS;

  if (valido) {
    log(`✅ Match! "${nomeFoto}" ≈ "${melhorMatch.nome}" (${confiancaPercent}%) — ${melhorMatch.endereco}`);
  } else {
    log(`❌ Sem match! "${nomeFoto}" vs melhor: "${melhorMatch?.nome || 'nenhum'}" (${confiancaPercent}%)`);
    log(`   ${lugares.length} lugar(es) próximo(s): ${lugares.slice(0, 5).map(l => l.nome).join(', ')}`);
  }

  return {
    valido,
    nome_foto: nomeFoto,
    match_google: melhorMatch ? { nome: melhorMatch.nome, endereco: melhorMatch.endereco } : null,
    confianca: confiancaPercent,
    lugares_proximos: lugares.length,
    motivo: valido
      ? `Estabelecimento "${melhorMatch.nome}" encontrado próximo (${confiancaPercent}% similaridade)`
      : `Nenhum estabelecimento com nome similar a "${nomeFoto}" encontrado em ${RAIO_BUSCA_METROS}m`,
    detalhes: {
      gemini,
      lugares_top5: lugares.slice(0, 5).map(l => ({ nome: l.nome, endereco: l.endereco })),
    }
  };
}

module.exports = { validarLocalizacao, extrairNomeDaFoto, buscarEstabelecimentosProximos, similaridade };
