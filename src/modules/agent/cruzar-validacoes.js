/**
 * cruzar-validacoes.js
 * Cruza os dados extraídos da NF com os dados oficiais da Receita
 * e (opcionalmente) com a foto da fachada validada por Google Places.
 *
 * Retorna scores de match entre 0-100 pra cada par e decide se o endereço
 * pode ser salvo no banco de "endereços validados" (solicitacao_favoritos).
 *
 * Critério atual: "PELO MENOS UM dos matches dar ≥90%" (mais flexível).
 * Implementação isolada — fácil de mudar critério depois.
 */

'use strict';

/**
 * Normaliza string pra comparação:
 * - lowercase
 * - remove acentos
 * - colapsa espaços
 * - remove sufixos jurídicos comuns (LTDA, ME, EIRELI, S/A, etc)
 * - remove pontuação
 */
function normalizar(s) {
  if (!s) return '';
  let r = String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // remove acentos
    .replace(/[.,\-/\\()]/g, ' ')      // pontuação vira espaço
    .replace(/\s+/g, ' ')
    .trim();
  // Remove sufixos jurídicos (no fim)
  r = r.replace(/\s+(ltda|s\/?a|eireli|me|epp|mei|cia)\.?$/g, '').trim();
  return r;
}

/**
 * Distância de Levenshtein.
 */
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

/**
 * Score 0-100 entre 2 strings normalizadas.
 * - 100 = idênticas após normalização
 * - 90-99 = quase idênticas (typos pequenos)
 * - 70-89 = parecidas
 * - <70 = diferentes
 *
 * Combina 3 técnicas:
 * 1) Levenshtein normalizado (sensível a typos)
 * 2) Substring containment (uma contém a outra)
 * 3) Token overlap (palavras em comum)
 */
function scoreSimilaridade(s1, s2) {
  const a = normalizar(s1);
  const b = normalizar(s2);
  if (!a || !b) return 0;
  if (a === b) return 100;

  // 1) Levenshtein
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const lev = Math.max(0, 100 - (dist / maxLen) * 100);

  // 2) Substring (se uma contém a outra completamente, score alto)
  let sub = 0;
  if (a.includes(b) || b.includes(a)) {
    const minLen = Math.min(a.length, b.length);
    sub = (minLen / maxLen) * 100;
  }

  // 3) Token overlap (palavras em comum)
  const tokensA = new Set(a.split(' ').filter(t => t.length > 2));
  const tokensB = new Set(b.split(' ').filter(t => t.length > 2));
  let overlap = 0;
  if (tokensA.size > 0 && tokensB.size > 0) {
    const inter = [...tokensA].filter(t => tokensB.has(t)).length;
    const union = new Set([...tokensA, ...tokensB]).size;
    overlap = (inter / union) * 100;
  }

  // Pega o MELHOR dos 3 (porque cada técnica captura um tipo de match)
  return Math.round(Math.max(lev, sub, overlap));
}

/**
 * Compara endereços (logradouro + número).
 * Foco: rua + número. Bairro/cidade são extras.
 */
function scoreEndereco(end1, end2) {
  // Tira CEP, padroniza
  const limpar = (e) => normalizar(e).replace(/\b\d{5}\s?\d{3}\b/g, '');
  return scoreSimilaridade(limpar(end1), limpar(end2));
}

/**
 * Função principal: cruza NF + Receita + (Fachada opcional).
 *
 * Entrada:
 *   nf       — { razao_social, nome_fantasia, endereco_nf, ... } da NF (Gemini)
 *   receita  — { razao_social, nome_fantasia, endereco, ativa, ... } da API Receita
 *   fachada  — { nome_foto } da foto da fachada (opcional, do validar-localizacao.js)
 *
 * Saída:
 *   {
 *     scores: {
 *       razao_nf_vs_receita: 95,
 *       fantasia_nf_vs_receita: 88,
 *       endereco_nf_vs_receita: 92,
 *       fachada_vs_receita_fantasia: 87,
 *       fachada_vs_receita_razao: 60
 *     },
 *     score_max: 95,                     // melhor dos scores
 *     pelo_menos_um_90: true,            // critério de aprovação
 *     receita_ativa: true,
 *     pode_salvar_no_banco: true,        // ativa + score≥90
 *     mensagem_motoboy: '✅ Estabelecimento ABC LTDA confirmado',
 *     resumo: 'Razão social NF↔Receita: 95% • Endereço NF↔Receita: 92%'
 *   }
 */
function cruzarValidacoes({ nf, receita, fachada }) {
  const scores = {};

  if (nf && receita && receita.ok) {
    if (nf.razao_social && receita.razao_social) {
      scores.razao_nf_vs_receita = scoreSimilaridade(nf.razao_social, receita.razao_social);
    }
    if (nf.nome_fantasia && receita.nome_fantasia) {
      scores.fantasia_nf_vs_receita = scoreSimilaridade(nf.nome_fantasia, receita.nome_fantasia);
    }
    if (nf.endereco_nf && receita.endereco) {
      scores.endereco_nf_vs_receita = scoreEndereco(nf.endereco_nf, receita.endereco);
    }
  }

  if (fachada && fachada.nome_foto && receita && receita.ok) {
    if (receita.nome_fantasia) {
      scores.fachada_vs_receita_fantasia = scoreSimilaridade(fachada.nome_foto, receita.nome_fantasia);
    }
    if (receita.razao_social) {
      scores.fachada_vs_receita_razao = scoreSimilaridade(fachada.nome_foto, receita.razao_social);
    }
  }

  const valores = Object.values(scores).filter(v => typeof v === 'number');
  const score_max = valores.length > 0 ? Math.max(...valores) : 0;
  const pelo_menos_um_90 = score_max >= 90;
  const receita_ativa = !!(receita && receita.ok && receita.ativa);

  // CRITÉRIO: salva no banco se (a) Receita confirmou + ATIVA + (b) algum score ≥90
  const pode_salvar_no_banco = receita_ativa && pelo_menos_um_90;

  // Mensagem amigável pro motoboy
  let mensagem_motoboy = null;
  if (receita && receita.ok) {
    const nome = receita.nome_fantasia || receita.razao_social || 'Estabelecimento';
    if (!receita_ativa) {
      mensagem_motoboy = `⚠️ ${nome} consta como ${receita.situacao} na Receita`;
    } else if (pelo_menos_um_90) {
      mensagem_motoboy = `✅ ${nome} confirmado pela Receita Federal`;
    } else {
      mensagem_motoboy = `⚠️ ${nome} encontrado na Receita, mas dados da NF/foto divergem`;
    }
  } else if (receita) {
    mensagem_motoboy = `⚠️ Não consultamos a Receita: ${receita.motivo || 'erro desconhecido'}`;
  }

  // Resumo curto pra logs/admin
  const resumoPartes = [];
  if (typeof scores.razao_nf_vs_receita === 'number') {
    resumoPartes.push(`Razão NF↔Receita: ${scores.razao_nf_vs_receita}%`);
  }
  if (typeof scores.fantasia_nf_vs_receita === 'number') {
    resumoPartes.push(`Fantasia NF↔Receita: ${scores.fantasia_nf_vs_receita}%`);
  }
  if (typeof scores.endereco_nf_vs_receita === 'number') {
    resumoPartes.push(`Endereço NF↔Receita: ${scores.endereco_nf_vs_receita}%`);
  }
  if (typeof scores.fachada_vs_receita_fantasia === 'number') {
    resumoPartes.push(`Fachada↔Fantasia Receita: ${scores.fachada_vs_receita_fantasia}%`);
  }

  return {
    scores,
    score_max,
    pelo_menos_um_90,
    receita_ativa,
    pode_salvar_no_banco,
    mensagem_motoboy,
    resumo: resumoPartes.join(' • '),
  };
}

module.exports = {
  cruzarValidacoes,
  scoreSimilaridade,
  scoreEndereco,
  normalizar,
};
