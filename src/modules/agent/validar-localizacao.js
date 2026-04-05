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
 * Valida o conteúdo da foto E extrai o nome do estabelecimento em UMA chamada ao Gemini
 */
async function analisarFoto(base64Foto) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { log('⚠️ GEMINI_API_KEY não configurada'); return null; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

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
          text: `Você é um validador de fotos para um sistema de entrega de AUTOPEÇAS.
O motoboy entrega peças automotivas e deve enviar uma foto da FACHADA do local de entrega.

CONTEXTO: Os clientes são lojas de autopeças, oficinas mecânicas, retíficas, distribuidores automotivos, concessionárias, borracharias, centros automotivos, ou residências.

TAREFA DUPLA:
1. VALIDAR se a foto mostra um local de entrega válido
2. Se válida, EXTRAIR o nome do estabelecimento visível (se houver)

FOTOS VÁLIDAS (aprovar):
- Fachada de loja, oficina, mecânica, autopeças, retífica, centro automotivo
- Fachada de residência, casa, prédio, condomínio (cliente pode ser pessoa física)
- Portão, entrada de estabelecimento
- Placa com nome do local
- Fachada mesmo que parcialmente visível

FOTOS INVÁLIDAS (rejeitar):
- Foto borrada, desfocada, escura demais
- Foto de moto, veículo, capacete, mão, chão
- Foto de rua/avenida sem foco em nenhum estabelecimento
- Screenshot de tela de celular
- Foto de documento, papel, nota fiscal
- Selfie ou foto de pessoa
- Foto totalmente preta, branca ou sem conteúdo

Responda APENAS em JSON, sem markdown:
{
  "foto_valida": true,
  "motivo_rejeicao": null,
  "tipo_local": "comercial",
  "ramo_automotivo": true,
  "nome_estabelecimento": "NOME AQUI ou NAO_IDENTIFICADO",
  "confianca": 85,
  "textos_visiveis": ["texto1", "texto2"]
}

tipo_local: "comercial" | "residencial" | "outro"
ramo_automotivo: true se parece ser autopeças, oficina, mecânica, retífica, centro automotivo, distribuidor. false se outro ramo (farmácia, padaria, etc).
Se foto_valida=false, preencha motivo_rejeicao com feedback claro pro motoboy.`
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 400,
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
    log(`📸 Gemini: valida=${parsed.foto_valida} | tipo=${parsed.tipo_local} | nome="${parsed.nome_estabelecimento}" (${parsed.confianca}%)`);
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
    includedTypes: ['car_repair', 'car_dealer'],
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
      log(`❌ Places API Nearby erro ${resp.status}: ${err.substring(0, 200)}`);
      return await buscarTextSearch(lat, lng, raioMetros, apiKey);
    }

    const data = await resp.json();
    let places = (data.places || []).map(p => ({
      nome: p.displayName?.text || '',
      endereco: p.formattedAddress || '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      tipos: p.types || [],
    }));

    log(`📍 Nearby: ${places.length} resultado(s)`);

    // Sempre complementar com Text Search automotivo
    const textPlaces = await buscarTextSearch(lat, lng, raioMetros, apiKey);
    if (textPlaces.length > 0) {
      const nomesExistentes = new Set(places.map(p => normalizar(p.nome)));
      const novos = textPlaces.filter(p => !nomesExistentes.has(normalizar(p.nome)));
      places.push(...novos);
      log(`📍 +TextSearch: ${novos.length} novo(s), total ${places.length}`);
    }

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
  const queries = [
    'auto peças autopeças',
    'oficina mecânica centro automotivo',
    'retífica distribuidora autopeças',
    'borracharia concessionária',
  ];

  let todosResultados = [];

  for (const textQuery of queries) {
    try {
      const url = 'https://places.googleapis.com/v1/places:searchText';
      const body = {
        textQuery,
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

      if (!resp.ok) continue;
      const data = await resp.json();
      const places = (data.places || []).map(p => ({
        nome: p.displayName?.text || '',
        endereco: p.formattedAddress || '',
        lat: p.location?.latitude,
        lng: p.location?.longitude,
      }));
      todosResultados.push(...places);
    } catch (err) { /* ignora */ }
  }

  // Deduplicar por nome
  const vistos = new Set();
  return todosResultados.filter(p => {
    const chave = normalizar(p.nome);
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
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
  const LIMIAR_SIMILARIDADE = 0.35;
  const LIMIAR_PALAVRAS = 0.5;

  log(`🔍 Validando: lat=${lat} lng=${lng}`);

  // 1. Analisar foto via Gemini (validação de conteúdo + extração de nome)
  const gemini = await analisarFoto(base64Foto);

  // Se Gemini falhou, aprovar (fail-open)
  if (!gemini) {
    log('⚠️ Gemini indisponível — aprovando sem validação');
    return {
      valido: true,
      foto_valida: true,
      nome_foto: null,
      match_google: null,
      confianca: 0,
      motivo: 'Validação indisponível no momento',
      detalhes: { gemini: null }
    };
  }

  // 2. Foto inválida? Bloquear com feedback
  if (gemini.foto_valida === false) {
    log(`❌ Foto rejeitada: ${gemini.motivo_rejeicao}`);
    return {
      valido: false,
      foto_valida: false,
      foto_rejeitada: true,
      nome_foto: null,
      match_google: null,
      confianca: 0,
      motivo: gemini.motivo_rejeicao || 'A foto enviada não é válida. Envie uma foto da fachada do local de entrega.',
      detalhes: { gemini }
    };
  }

  const nomeFoto = gemini.nome_estabelecimento;

  // 3. Nome não identificado — se residencial ou sem placa, aviso (não bloqueio)
  if (!nomeFoto || nomeFoto === 'NAO_IDENTIFICADO') {
    log(`⚠️ Nome não identificável (tipo: ${gemini.tipo_local}) — aviso para suporte validar`);
    return {
      valido: false,
      foto_valida: true,
      nome_foto: null,
      match_google: null,
      confianca: 0,
      tipo_local: gemini.tipo_local,
      motivo: gemini.tipo_local === 'residencial'
        ? 'Local residencial identificado — sem nome de estabelecimento visível'
        : 'Não foi possível identificar o nome do estabelecimento na foto',
      detalhes: { gemini }
    };
  }

  // 4. Buscar estabelecimentos próximos
  const lugares = await buscarEstabelecimentosProximos(lat, lng, RAIO_BUSCA_METROS);
  if (lugares.length === 0) {
    log(`⚠️ Nenhum estabelecimento em ${RAIO_BUSCA_METROS}m — aprovando`);
    return {
      valido: true,
      foto_valida: true,
      nome_foto: nomeFoto,
      match_google: null,
      confianca: 0,
      tipo_local: gemini.tipo_local,
      motivo: 'Nenhum estabelecimento do ramo automotivo encontrado no Google Maps nesta região',
      lugares_proximos: 0,
      detalhes: { gemini }
    };
  }

  // 5. Comparar nomes
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
    log(`   ${lugares.length} lugar(es): ${lugares.slice(0, 5).map(l => l.nome).join(', ')}`);
  }

  return {
    valido,
    foto_valida: true,
    nome_foto: nomeFoto,
    match_google: melhorMatch ? { nome: melhorMatch.nome, endereco: melhorMatch.endereco } : null,
    confianca: confiancaPercent,
    tipo_local: gemini.tipo_local,
    lugares_proximos: lugares.length,
    motivo: valido
      ? `Estabelecimento "${melhorMatch.nome}" encontrado próximo (${confiancaPercent}% similaridade)`
      : `Nenhum estabelecimento automotivo com nome similar a "${nomeFoto}" encontrado em ${RAIO_BUSCA_METROS}m`,
    detalhes: {
      gemini,
      lugares_top5: lugares.slice(0, 5).map(l => ({ nome: l.nome, endereco: l.endereco })),
    }
  };
}

module.exports = { validarLocalizacao, analisarFoto, buscarEstabelecimentosProximos, similaridade };
