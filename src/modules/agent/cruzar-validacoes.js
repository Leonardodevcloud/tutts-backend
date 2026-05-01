/**
 * cruzar-validacoes.js (2026-05 v2 — pós-remoção de foto da NF)
 *
 * Fluxo NOVO:
 *   - Motoboy NÃO envia mais foto da NF.
 *   - Motoboy DIGITA o CNPJ; backend consulta Receita Federal (BrasilAPI/OpenCNPJ).
 *   - Foto da FACHADA continua sendo enviada e validada via Gemini + Google Places.
 *   - Cruzamento usa dados da Receita como fonte primária (em vez da NF/Gemini OCR).
 *
 * 6 PATHS DE APROVAÇÃO (qualquer ≥90% → pode_salvar_no_banco):
 *
 *   A) Fachada (Gemini) ↔ Google Places (nome)
 *       Foto da fachada confirma o estabelecimento que o Google Places vê no GPS.
 *
 *   B) Endereço Receita ≈ GPS do motoboy (≤15m → 100; degrade até 50m → 0)
 *       Geocoda o endereço fiscal e mede distância em metros até o GPS.
 *
 *   C) Nome Receita (razão OU fantasia) ↔ Google Places (nome)
 *       Empresa cadastrada no Receita == empresa que o Google vê ali.
 *
 *   D) Nome Receita (razão OU fantasia) ↔ Foto fachada (Gemini)
 *       Empresa cadastrada no Receita == nome lido na fachada.
 *
 *   E) Endereço Receita ↔ Endereço digitado pelo motoboy
 *       Texto do endereço fiscal vs texto que o motoboy escreveu.
 *
 *   F) CEP Receita == CEP do reverse-geocoding do GPS
 *       Bônus: bate exato → 100; senão → 0.
 *
 * O caller (correcao.routes.js) é responsável por:
 *   - Calcular distância e CEP-do-GPS antes de chamar (helpers exportados aqui).
 *   - Passar os contextos: receita, fachada, motoboy_lat/lng, localizacao_raw, cep_gps.
 *
 * Critério de salvar: score_max ≥ 90 em pelo menos uma das 6 paths.
 *   (Receita ATIVA é informativa, NÃO bloqueia salvamento — conforme Tutts.)
 */

'use strict';

// ───────── Helpers de string ─────────

function normalizar(s) {
  if (!s) return '';
  let r = String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,\-/\\()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  r = r.replace(/\s+(ltda|s\/?a|eireli|me|epp|mei|cia)\.?$/g, '').trim();
  return r;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const v0 = new Array(n + 1);
  const v1 = new Array(n + 1);
  for (let i = 0; i <= n; i++) v0[i] = i;
  for (let i = 0; i < m; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < n; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= n; j++) v0[j] = v1[j];
  }
  return v1[n];
}

function scoreSimilaridade(s1, s2) {
  const a = normalizar(s1);
  const b = normalizar(s2);
  if (!a || !b) return 0;
  if (a === b) return 100;

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const lev = Math.max(0, 100 - (dist / maxLen) * 100);

  let sub = 0;
  if (a.includes(b) || b.includes(a)) {
    const minLen = Math.min(a.length, b.length);
    sub = (minLen / maxLen) * 100;
  }

  const tokensA = new Set(a.split(' ').filter(t => t.length > 2));
  const tokensB = new Set(b.split(' ').filter(t => t.length > 2));
  let overlap = 0;
  if (tokensA.size > 0 && tokensB.size > 0) {
    const inter = [...tokensA].filter(t => tokensB.has(t)).length;
    const union = new Set([...tokensA, ...tokensB]).size;
    overlap = (inter / union) * 100;
  }

  return Math.round(Math.max(lev, sub, overlap));
}

function scoreEndereco(end1, end2) {
  const limpar = (e) => normalizar(e).replace(/\b\d{5}\s?\d{3}\b/g, '');
  return scoreSimilaridade(limpar(end1), limpar(end2));
}

// ───────── Helpers de geo ─────────

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const a = parseFloat(lat1), b = parseFloat(lng1);
  const c = parseFloat(lat2), d = parseFloat(lng2);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return null;
  const R = 6371000;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(c - a);
  const dLng = toRad(d - b);
  const lat1r = toRad(a), lat2r = toRad(c);
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(sa)));
}

/**
 * Distância em metros → score 0-100.
 *  ≤15m → 100 | 15-50m → degrade linear | >50m → 0
 *
 * Threshold de 15m confirmado pelo Tutts. Aceita até 50m com degrade pq Receita
 * pode ter endereço fiscal ligeiramente diferente do operacional (matriz/filial).
 */
function scoreDistancia(metros) {
  if (metros === null || metros === undefined) return 0;
  if (metros <= 15) return 100;
  if (metros >= 50) return 0;
  return Math.round(100 * (50 - metros) / 35);
}

// ───────── Função principal ─────────

function cruzarValidacoes({
  receita,
  fachada,
  localizacao_raw,
  motoboy_lat,
  motoboy_lng,
  distancia_receita_gps,
  cep_gps,
}) {
  const scores = {};

  const nomeFachada = fachada && fachada.nome_foto;
  const nomeGoogle = fachada && fachada.match_google && fachada.match_google.nome;

  // Nomes da Receita: pega fantasia E razão (cliente pode ter cadastro com qualquer um)
  const nomesReceita = [];
  if (receita && receita.nome_fantasia) nomesReceita.push(receita.nome_fantasia);
  if (receita && receita.razao_social) nomesReceita.push(receita.razao_social);

  // ── Path A: Fachada (Gemini) ↔ Google Places ──
  if (nomeFachada && nomeGoogle) {
    scores.fachada_vs_google = scoreSimilaridade(nomeFachada, nomeGoogle);
  }

  // ── Path B: Endereço Receita ≈ GPS do motoboy (distância) ──
  let distanciaCalculada = distancia_receita_gps;
  if (
    distanciaCalculada === undefined &&
    receita && Number.isFinite(parseFloat(receita.lat)) && Number.isFinite(parseFloat(receita.lng))
  ) {
    distanciaCalculada = distanciaMetros(receita.lat, receita.lng, motoboy_lat, motoboy_lng);
  }
  if (distanciaCalculada !== undefined && distanciaCalculada !== null) {
    scores.endereco_receita_vs_gps = scoreDistancia(distanciaCalculada);
  }

  // ── Path C: Nome Receita ↔ Google Places ──
  if (nomeGoogle && nomesReceita.length > 0) {
    scores.nome_receita_vs_google = Math.max(
      ...nomesReceita.map(n => scoreSimilaridade(n, nomeGoogle))
    );
  }

  // ── Path D: Nome Receita ↔ Foto fachada (Gemini) ──
  if (nomeFachada && nomesReceita.length > 0) {
    scores.nome_receita_vs_fachada = Math.max(
      ...nomesReceita.map(n => scoreSimilaridade(n, nomeFachada))
    );
  }

  // ── Path E: Endereço Receita ↔ Endereço digitado pelo motoboy ──
  if (receita && receita.endereco && localizacao_raw) {
    scores.endereco_receita_vs_motoboy = scoreEndereco(receita.endereco, localizacao_raw);
  }

  // ── Path F: CEP Receita == CEP do reverse-geocoding do GPS ──
  if (receita && receita.cep && cep_gps) {
    const cepR = String(receita.cep).replace(/\D/g, '');
    const cepG = String(cep_gps).replace(/\D/g, '');
    if (cepR.length === 8 && cepG.length === 8) {
      scores.cep_receita_vs_gps = (cepR === cepG) ? 100 : 0;
    }
  }

  // ── Score final + caminho de aprovação ──
  const valores = Object.values(scores).filter(v => typeof v === 'number');
  const score_max = valores.length > 0 ? Math.max(...valores) : 0;
  const pelo_menos_um_90 = score_max >= 90;
  const receita_ativa = !!(receita && receita.ok && receita.ativa);
  const pode_salvar_no_banco = pelo_menos_um_90;

  const labels = {
    fachada_vs_google:           'Fachada↔Google',
    endereco_receita_vs_gps:     'Endereço Receita↔GPS',
    nome_receita_vs_google:      'Nome Receita↔Google',
    nome_receita_vs_fachada:     'Nome Receita↔Fachada',
    endereco_receita_vs_motoboy: 'Endereço Receita↔Motoboy',
    cep_receita_vs_gps:          'CEP Receita↔GPS',
  };

  let caminho_aprovacao = null;
  if (pelo_menos_um_90) {
    const vencedor = Object.entries(scores).find(([, v]) => v === score_max);
    caminho_aprovacao = vencedor ? labels[vencedor[0]] || vencedor[0] : null;
  }

  let mensagem_motoboy = null;
  if (receita && receita.ok) {
    const nome = receita.nome_fantasia || receita.razao_social || 'Estabelecimento';
    if (!receita_ativa) {
      mensagem_motoboy = `⚠️ ${nome} consta como ${receita.situacao} na Receita`;
    } else if (pelo_menos_um_90) {
      mensagem_motoboy = `✅ ${nome} confirmado (${caminho_aprovacao}: ${score_max}%)`;
    } else {
      mensagem_motoboy = `ℹ️ ${nome} encontrado na Receita (validação cruzada não atingiu 90%)`;
    }
  } else if (receita) {
    mensagem_motoboy = `⚠️ Não consultamos a Receita: ${receita.motivo || 'erro desconhecido'}`;
  }

  const resumoPartes = Object.entries(scores).map(([k, v]) => `${labels[k] || k}: ${v}%`);

  return {
    scores,
    score_max,
    pelo_menos_um_90,
    receita_ativa,
    pode_salvar_no_banco,
    caminho_aprovacao,
    mensagem_motoboy,
    resumo: resumoPartes.join(' • '),
    distancia_metros: distanciaCalculada ?? null,
  };
}

module.exports = {
  cruzarValidacoes,
  scoreSimilaridade,
  scoreEndereco,
  scoreDistancia,
  distanciaMetros,
  normalizar,
};
