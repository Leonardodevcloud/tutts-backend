/**
 * MÓDULO LOGISTICS — AddressParser (STUB)
 *
 * Parser de endereço brasileiro: extrai { street, city, state, zip } de uma
 * string única vinda da Mapp.
 *
 * ⚠️  FASE 0: implementação completa NÃO está aqui ainda.
 *
 * Na Fase 1, a função `parsearEnderecoBrasileiro` será extraída integralmente
 * de src/modules/uber/uber.shared.js — ela é genérica o suficiente pra servir
 * todos os adapters, não pertence ao módulo Uber.
 *
 * A função atual lida com formatos variados encontrados em produção:
 *   "Rua do Níquel, Parque Oeste Industrial, Goiânia- GO - 74670-490"
 *   "Av. Pedro Miranda, 2018 - Terrabela Cerrado II, Sen. Canedo - GO, 75262-553, Brasil"
 *   "AV.PEDRO LUDOVICO TEIXEIRA NR.100 QUADRA 142, PARQUE OESTE INDUSTR, GO - 74375400 N° nota: ..."
 *
 * Cada adapter consome o resultado e formata para o dialeto do provider:
 *   - Uber: JSON-string com street_address[]/city/state/zip_code/country
 *   - 99:   campos separados (street, number, latitude, longitude, reference)
 *
 * Por isso o parser fica no core (compartilhado) e a formatação fica no adapter.
 */

/**
 * Estrutura canônica do endereço pós-parse.
 *
 * @typedef {Object} ParsedAddress
 * @property {string[]} street_address - Linhas do endereço (rua, número, complemento agrupados)
 * @property {string} city
 * @property {string} state - UF de 2 letras
 * @property {string} zip_code - CEP no formato '00000-000' (vazio se não detectado)
 * @property {string} country - 'BR' default
 */

const DEFAULT_CITY = 'Salvador';
const DEFAULT_STATE = 'BA';
const DEFAULT_COUNTRY = 'BR';

/**
 * Tenta extrair endereço brasileiro estruturado.
 *
 * @param {string} _str
 * @returns {ParsedAddress}
 */
function parsearEnderecoBrasileiro(_str) {
  // FASE 1: corpo será movido de uber.shared.js
  throw new Error('AddressParser.parsearEnderecoBrasileiro: Fase 1 — implementação será extraída de uber.shared.js');
}

module.exports = {
  parsearEnderecoBrasileiro,
  DEFAULT_CITY,
  DEFAULT_STATE,
  DEFAULT_COUNTRY,
};
