/**
 * cruzar-validacoes.js (2026-06 v6.2 — validação RÍGIDA, com bloqueio real)
 *
 * Fluxo:
 *   - Motoboy DIGITA o CNPJ; backend consulta Receita Federal (BrasilAPI/OpenCNPJ).
 *   - Foto da FACHADA é validada via Gemini + Google Places.
 *   - Este módulo cruza os sinais e DECIDE se libera ou BARRA o envio.
 *
 * DUAS ROTAS DE APROVAÇÃO (fallback mútuo):
 *
 *   ROTA FACHADA (path A):
 *     A — Fachada (Gemini) ↔ Google Places (nome)
 *       A >= 50  → aprova pela fachada
 *       A <  50  → reprova a fachada (mas ainda passa se a Receita aprovar)
 *       A = N/D  → fachada indefinida (não aprova nem reprova sozinha)
 *
 *   ROTA RECEITA (basta 1 path >= 80):
 *     B — Endereço Receita ≈ GPS do motoboy (≤15m → 90; degrade até 200m → 0)
 *     C — Nome Receita ↔ Google Places
 *     D — Nome Receita ↔ Foto fachada (Gemini)
 *     E — Endereço Receita ↔ Endereço digitado
 *     F — CEP Receita == CEP reverse-geocoding do GPS (exato → 90; 5 díg → 60)
 *     G — Nome Receita ↔ textos visíveis na fachada (todos)         [máx 90]
 *     CNPJ — CNPJ da Receita aparece nos textos da fachada           [90]
 *     K — Número do logradouro Receita ↔ endereço digitado          [90]
 *
 * DECISÃO:
 *   libera = (fachada aprova) OU (receita aprova)
 *   barra  = nenhuma rota aprovou (fail-CLOSED: apagão de infra também reprova)
 *
 * As melhorias novas (G, CNPJ, K) e o CEP (F) são heurísticas: teto 90, nunca 100.
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

// Extrai o "número" do logradouro de um texto de endereço (best-effort).
function extrairNumero(endereco) {
  if (!endereco) return null;
  // pega o primeiro grupo de dígitos que NÃO seja um CEP (8 dígitos) nem parte dele
  const semCep = String(endereco).replace(/\b\d{5}-?\d{3}\b/g, ' ');
  const m = semCep.match(/(?:^|[,\s])n?[ºo]?\s*(\d{1,6})(?![\d/])/i);
  if (m) return m[1];
  const any = semCep.match(/\b(\d{1,6})\b/);
  return any ? any[1] : null;
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
 * Distância em metros → score 0-90 (heurística, teto 90).
 *  ≤15m → 90 | 15-200m → degrade linear | >200m → 0
 *
 * 2026-06 v6.2: pico rebaixado 100 → 90 e cauda alargada 80m → 200m.
 * Em zona urbana densa o drift de GPS + geocoding de telhado é grande;
 * a distância vira sinal de apoio (nunca 100).
 */
function scoreDistancia(metros) {
  if (metros === null || metros === undefined) return 0;
  if (metros <= 15) return 90;
  if (metros >= 200) return 0;
  return Math.round(90 * (200 - metros) / 185);
}

/**
 * CEP Receita vs CEP do GPS. Teto 90 (heurística).
 *  8 dígitos iguais → 90 | mesmos 5 primeiros (sub-região) → 60 | senão 0.
 *  Retorna null quando não dá pra comparar (algum CEP ausente/inválido).
 */
function scoreCepParcial(cepR, cepG) {
  const a = String(cepR || '').replace(/\D/g, '');
  const b = String(cepG || '').replace(/\D/g, '');
  if (a.length !== 8 || b.length !== 8) return null;
  if (a === b) return 90;
  if (a.slice(0, 5) === b.slice(0, 5)) return 60;
  return 0;
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
  textos_fachada,
  cnpj,
}) {
  const scores = {};

  const nomeFachada = fachada && fachada.nome_foto;
  const nomeGoogle = fachada && fachada.match_google && fachada.match_google.nome;
  const textos = Array.isArray(textos_fachada) ? textos_fachada.filter(Boolean) : [];

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

  // ── Path F: CEP Receita == CEP do reverse-geocoding do GPS (teto 90) ──
  if (receita && receita.cep && cep_gps) {
    const f = scoreCepParcial(receita.cep, cep_gps);
    if (f !== null) scores.cep_receita_vs_gps = f;
  }

  // ── Path G: Nome Receita ↔ textos visíveis na fachada (todos) [máx 90] ──
  if (nomesReceita.length > 0 && textos.length > 0) {
    let best = 0;
    for (const t of textos) {
      for (const n of nomesReceita) {
        best = Math.max(best, scoreSimilaridade(n, t));
        if (best >= 90) break;
      }
      if (best >= 90) break;
    }
    scores.nome_receita_vs_textos = Math.min(90, best);
  }

  // ── CNPJ na fachada: CNPJ da Receita aparece nos textos visíveis [90] ──
  const cnpjDig = String(cnpj || (receita && receita.cnpj) || '').replace(/\D/g, '');
  if (cnpjDig.length === 14 && textos.length > 0) {
    const blob = textos.map(t => String(t).replace(/\D/g, '')).join(' ');
    if (blob.includes(cnpjDig)) scores.cnpj_na_fachada = 90;
  }

  // ── Path K: Número do logradouro Receita ↔ endereço digitado [90] ──
  const numReceita = (receita && (receita.numero || extrairNumero(receita.endereco))) || null;
  if (numReceita && localizacao_raw) {
    const nR = String(numReceita).replace(/\D/g, '');
    if (nR) {
      const nums = String(localizacao_raw).match(/\d+/g) || [];
      scores.numero_receita_vs_motoboy = nums.includes(nR) ? 90 : 0;
    }
  }

  // ── Decisão: duas rotas com fallback mútuo ──
  const A = scores.fachada_vs_google;
  const fachadaAvaliavel = typeof A === 'number';
  const fachadaAprova = fachadaAvaliavel && A >= 50;

  const receitaKeys = [
    'endereco_receita_vs_gps',
    'nome_receita_vs_google',
    'nome_receita_vs_fachada',
    'endereco_receita_vs_motoboy',
    'cep_receita_vs_gps',
    'nome_receita_vs_textos',
    'cnpj_na_fachada',
    'numero_receita_vs_motoboy',
  ];
  const receitaScores = receitaKeys.map(k => scores[k]).filter(v => typeof v === 'number');
  const receita_max = receitaScores.length > 0 ? Math.max(...receitaScores) : 0;
  const receitaAprova = receitaScores.some(v => v >= 80);

  const algumSinal = fachadaAvaliavel || receitaScores.length > 0;
  const liberado = fachadaAprova || receitaAprova;
  // 2026-06 v6.2: fail-CLOSED — sem nenhuma rota aprovando, BARRA
  // (inclusive quando não há sinal calculável: apagão de infra reprova).
  const barrar = !liberado;

  // ── Score final + caminho de aprovação (compat + info) ──
  const valores = Object.values(scores).filter(v => typeof v === 'number');
  const score_max = valores.length > 0 ? Math.max(...valores) : 0;
  const pelo_menos_um_90 = score_max >= 90;
  const receita_ativa = !!(receita && receita.ok && receita.ativa);
  const pode_salvar_no_banco = pelo_menos_um_90;

  const labels = {
    fachada_vs_google:            'Fachada↔Google',
    endereco_receita_vs_gps:      'Endereço Receita↔GPS',
    nome_receita_vs_google:       'Nome Receita↔Google',
    nome_receita_vs_fachada:      'Nome Receita↔Fachada',
    endereco_receita_vs_motoboy:  'Endereço Receita↔Motoboy',
    cep_receita_vs_gps:           'CEP Receita↔GPS',
    nome_receita_vs_textos:       'Nome Receita↔Textos fachada',
    cnpj_na_fachada:              'CNPJ na fachada',
    numero_receita_vs_motoboy:    'Número Receita↔Motoboy',
  };

  let caminho_aprovacao = null;
  if (liberado) {
    if (fachadaAprova) {
      caminho_aprovacao = labels.fachada_vs_google;
    } else {
      const vencedor = receitaKeys
        .filter(k => typeof scores[k] === 'number' && scores[k] >= 80)
        .sort((a, b) => scores[b] - scores[a])[0];
      caminho_aprovacao = vencedor ? (labels[vencedor] || vencedor) : null;
    }
  }

  // ── Motivo de bloqueio (feedback pro motoboy) ──
  let motivo_bloqueio = null;
  if (barrar) {
    if (fachadaAvaliavel && A < 50) {
      motivo_bloqueio =
        `A foto da fachada não corresponde ao local e não confirmamos o ` +
        `endereço pelo CNPJ informado. Confira o endereço digitado e tire a foto ` +
        `na frente do estabelecimento certo.`;
    } else {
      motivo_bloqueio =
        `Não foi possível validar este endereço com o CNPJ informado. Confira o ` +
        `CNPJ, o endereço digitado e a foto da fachada, e tente novamente.`;
    }
  }

  let mensagem_motoboy = null;
  if (receita && receita.ok) {
    const nome = receita.nome_fantasia || receita.razao_social || 'Estabelecimento';
    if (!receita_ativa) {
      mensagem_motoboy = `⚠️ ${nome} consta como ${receita.situacao} na Receita`;
    } else if (liberado) {
      mensagem_motoboy = `✅ ${nome} confirmado (${caminho_aprovacao || 'validação cruzada'})`;
    } else {
      mensagem_motoboy = `ℹ️ ${nome} encontrado na Receita`;
    }
  } else if (receita) {
    mensagem_motoboy = `⚠️ Não consultamos a Receita: ${receita.motivo || 'erro desconhecido'}`;
  }

  const resumoPartes = Object.entries(scores).map(([k, v]) => `${labels[k] || k}: ${v}%`);

  return {
    scores,
    score_max,
    receita_max,
    fachada_score: fachadaAvaliavel ? A : null,
    pelo_menos_um_90,
    receita_ativa,
    pode_salvar_no_banco,
    // 2026-06 v6: decisão de bloqueio
    liberado,
    barrar,
    motivo_bloqueio,
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
  scoreCepParcial,
  distanciaMetros,
  extrairNumero,
  normalizar,
};
