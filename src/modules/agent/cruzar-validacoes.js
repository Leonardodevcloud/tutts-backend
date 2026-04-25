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
/**
 * Função principal — versão 2026-04 com 6 regras NÃO baseadas em Receita.
 *
 * Receita Federal vira INFORMATIVA: aparece na tela mas NÃO entra no critério
 * de salvar. As 6 regras abaixo são as únicas que decidem.
 *
 * Entrada:
 *   nf       — { razao_social, nome_fantasia, endereco_nf, ... } da NF (Gemini)
 *   receita  — { razao_social, ... } — só pra exibir na tela do motoboy
 *   fachada  — { nome_foto, match_google: { nome } } da foto (validar-localizacao.js)
 *   localizacao_raw — string que o motoboy DIGITOU como endereço de entrega
 *
 * Critério: PELO MENOS UM dos 6 scores ≥90% → salva no banco.
 *
 * As 6 regras:
 *   1. Foto fachada (Gemini) ↔ Google Places (nome do estabelecimento)
 *   2. Razão social NF ↔ Google Places (nome)
 *   3. Razão social NF ↔ Foto fachada (Gemini)
 *   4. Nome fantasia NF ↔ Google Places (nome)
 *   5. Nome fantasia NF ↔ Foto fachada (Gemini)
 *   6. Endereço NF ↔ Endereço que motoboy digitou (localizacao_raw)
 */
function cruzarValidacoes({ nf, receita, fachada, localizacao_raw }) {
  const scores = {};

  // Fachada (Gemini extraiu o nome de algum estabelecimento da foto)
  const nomeFachada = fachada && fachada.nome_foto;

  // Google Places (resultado do match com o estabelecimento mais próximo)
  const nomeGoogle = fachada && fachada.match_google && fachada.match_google.nome;

  // Regra 1: Foto fachada ↔ Google Places
  if (nomeFachada && nomeGoogle) {
    scores.fachada_vs_google = scoreSimilaridade(nomeFachada, nomeGoogle);
  }

  // Regra 2: Razão NF ↔ Google Places
  if (nf && nf.razao_social && nomeGoogle) {
    scores.razao_nf_vs_google = scoreSimilaridade(nf.razao_social, nomeGoogle);
  }

  // Regra 3: Razão NF ↔ Foto fachada
  if (nf && nf.razao_social && nomeFachada) {
    scores.razao_nf_vs_fachada = scoreSimilaridade(nf.razao_social, nomeFachada);
  }

  // Regra 4: Nome fantasia NF ↔ Google Places
  if (nf && nf.nome_fantasia && nomeGoogle) {
    scores.fantasia_nf_vs_google = scoreSimilaridade(nf.nome_fantasia, nomeGoogle);
  }

  // Regra 5: Nome fantasia NF ↔ Foto fachada
  if (nf && nf.nome_fantasia && nomeFachada) {
    scores.fantasia_nf_vs_fachada = scoreSimilaridade(nf.nome_fantasia, nomeFachada);
  }

  // Regra 6: Endereço NF ↔ Endereço que motoboy DIGITOU
  if (nf && nf.endereco_nf && localizacao_raw) {
    scores.endereco_nf_vs_motoboy = scoreEndereco(nf.endereco_nf, localizacao_raw);
  }

  const valores = Object.values(scores).filter(v => typeof v === 'number');
  const score_max = valores.length > 0 ? Math.max(...valores) : 0;
  const pelo_menos_um_90 = score_max >= 90;
  const receita_ativa = !!(receita && receita.ok && receita.ativa);

  // CRITÉRIO DE SALVAR (2026-04): apenas score≥90% em pelo menos 1 das 6 regras.
  // Receita NÃO entra no critério (é só informativa pro motoboy).
  const pode_salvar_no_banco = pelo_menos_um_90;

  // Mensagem pro motoboy (Receita continua sendo MOSTRADA, só não bloqueia salvamento)
  let mensagem_motoboy = null;
  if (receita && receita.ok) {
    const nome = receita.nome_fantasia || receita.razao_social || 'Estabelecimento';
    if (!receita_ativa) {
      mensagem_motoboy = `⚠️ ${nome} consta como ${receita.situacao} na Receita`;
    } else if (pelo_menos_um_90) {
      mensagem_motoboy = `✅ ${nome} confirmado pela Receita Federal`;
    } else {
      // Receita ATIVA + ainda assim score baixo: dado é confiável mas dados não conferem
      mensagem_motoboy = `ℹ️ ${nome} encontrado na Receita (validação cruzada não atingiu 90%)`;
    }
  } else if (receita) {
    mensagem_motoboy = `⚠️ Não consultamos a Receita: ${receita.motivo || 'erro desconhecido'}`;
  }

  // Resumo curto pra logs/admin (só as 6 regras novas)
  const labels = {
    fachada_vs_google:        'Fachada↔Google',
    razao_nf_vs_google:       'Razão NF↔Google',
    razao_nf_vs_fachada:      'Razão NF↔Fachada',
    fantasia_nf_vs_google:    'Fantasia NF↔Google',
    fantasia_nf_vs_fachada:   'Fantasia NF↔Fachada',
    endereco_nf_vs_motoboy:   'Endereço NF↔Motoboy',
  };
  const resumoPartes = Object.entries(scores).map(([k, v]) => `${labels[k] || k}: ${v}%`);

  return {
    scores,
    score_max,
    pelo_menos_um_90,
    receita_ativa,           // mantido pra exibição
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
