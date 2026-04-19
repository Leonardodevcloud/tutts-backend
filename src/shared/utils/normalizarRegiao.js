/**
 * normalizarRegiao.js
 *
 * Utilitário pra comparar nomes de regiões/cidades de forma tolerante a:
 *   - Acentos (Goiânia ↔ Goiania)
 *   - Caixa (salvador ↔ SALVADOR)
 *   - Espaços extras (São Paulo ↔ SÃO  PAULO)
 *   - Pontuação (Florianópolis-SC ↔ Florianopolis SC)
 *   - Sufixos de UF (Salvador/BA ↔ Salvador)
 *   - Letras faltando/trocadas (fuzzy — ex: "Feira Santana" vs "Feira de Santana")
 *
 * Uso típico:
 *   const { normalizarRegiao, regioesBate } = require('../shared/utils/normalizarRegiao');
 *   if (regioesBate(crm.cidade, regiao.nome)) { ... }
 *
 * A função `regioesBate(a, b)` primeiro testa igualdade após normalização.
 * Se falhar, calcula similaridade de Levenshtein e aceita >= 0.85.
 */

'use strict';

/**
 * Normalização canônica — usa isso pra comparar igualdade (UPPER + TRIM + sem acento + sem pontuação).
 *
 * Ex:
 *   "Goiânia - GO"   → "GOIANIA GO"
 *   "são paulo/sp"   → "SAO PAULO SP"
 *   "Feira de Santana, BA" → "FEIRA DE SANTANA BA"
 */
function normalizarRegiao(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .normalize('NFD')                          // separa acentos dos caracteres
    .replace(/[\u0300-\u036f]/g, '')           // remove os acentos
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')              // troca pontuação/símbolos por espaço
    .replace(/\s+/g, ' ')                      // múltiplos espaços → um
    .trim();
}

/**
 * Versão mais agressiva — remove TAMBÉM sufixo de UF (2 letras no final)
 * e palavras curtas comuns ("DE", "DA", "DO"). Usada como fallback pro fuzzy.
 *
 * Ex:
 *   "SÃO PAULO SP"      → "SAO PAULO"
 *   "FEIRA DE SANTANA"  → "FEIRA SANTANA"
 *   "SALVADOR BA"       → "SALVADOR"
 */
function normalizarRegiaoCore(s) {
  let norm = normalizarRegiao(s);
  // Remove UF no final (exatamente 2 letras precedidas de espaço)
  norm = norm.replace(/\s+[A-Z]{2}$/, '').trim();
  // Remove stopwords comuns
  norm = norm.split(' ')
    .filter(w => w && !['DE', 'DA', 'DO', 'DOS', 'DAS', 'E'].includes(w))
    .join(' ');
  return norm;
}

/**
 * Distância de Levenshtein — quantas edições (inserir/deletar/trocar) pra
 * transformar a em b.
 */
function levenshtein(a, b) {
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  // Matriz (m+1) x (n+1) — mas só precisamos de 2 linhas pra economizar mem
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // inserção
        prev[j] + 1,           // deleção
        prev[j - 1] + custo    // substituição
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Similaridade 0-1 (1 = idêntico). Baseado em Levenshtein normalizado pelo tamanho.
 */
function similaridadeTexto(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - (dist / maxLen);
}

/**
 * Compara dois nomes de região/cidade. Retorna true se baterem com tolerância.
 *
 * Regras (ordem de prioridade):
 *   1. Normalização exata (acento/caixa/pontuação/UF) — cobre 80% dos casos
 *   2. Normalização core (sem UF, sem stopwords) exata — cobre Santos vs "Santos SP"
 *   3. Fuzzy Levenshtein ≥ 0.85 — cobre "Feira de Santana" vs "Feira Santana"
 *
 * @param {string} a
 * @param {string} b
 * @param {number} limiarFuzzy - 0-1, default 0.85
 * @returns {boolean}
 */
function regioesBate(a, b, limiarFuzzy = 0.85) {
  if (!a || !b) return false;

  const na = normalizarRegiao(a);
  const nb = normalizarRegiao(b);
  if (na === nb) return true;

  const ca = normalizarRegiaoCore(a);
  const cb = normalizarRegiaoCore(b);
  if (ca && cb && ca === cb) return true;

  // Fuzzy só se ambos têm pelo menos 4 caracteres (evita match em "BA" ↔ "SP")
  if (na.length < 4 || nb.length < 4) return false;
  const sim = similaridadeTexto(na, nb);
  return sim >= limiarFuzzy;
}

module.exports = {
  normalizarRegiao,
  normalizarRegiaoCore,
  regioesBate,
  similaridadeTexto,
  levenshtein,
};
