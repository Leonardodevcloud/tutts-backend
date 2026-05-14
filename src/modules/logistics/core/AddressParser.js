/**
 * MÓDULO LOGISTICS — AddressParser
 *
 * Parser de endereço brasileiro: extrai { street, city, state, zip } de uma
 * string única vinda da Mapp.
 *
 * Fase 1A: implementação real, extraída verbatim de src/modules/uber/uber.shared.js
 * (função parsearEnderecoBrasileiro, mais formatarTelefoneE164 e truncarTexto).
 *
 * Comportamento preservado 100%. Esses helpers são genéricos — servem
 * qualquer adapter logístico que precise parsear endereço BR ou normalizar
 * telefone, não pertencem ao módulo Uber.
 *
 * Quem o usa nesta fase:
 *  - uber.shared.js (via re-export das funções extraídas — facade)
 *  - UberAdapter (Fase 1B, via uber.parser.js que delega aqui)
 *  - NinetyNineAdapter (Fase 3)
 */

const DEFAULT_COUNTRY = 'BR';
const DEFAULT_STATE = 'BA';
const DEFAULT_CITY = 'Salvador';

/**
 * @typedef {Object} ParsedAddress
 * @property {string[]} street_address - Linhas do endereço (rua, número, complemento agrupados)
 * @property {string} city
 * @property {string} state - UF de 2 letras
 * @property {string} zip_code - CEP no formato '00000-000' (vazio se não detectado)
 * @property {string} country - 'BR' default
 */

/**
 * Tenta extrair {street, cidade, uf, cep} de uma string única vinda da Mapp.
 * Best-effort — formato varia muito entre lojistas.
 *
 * Exemplos reais que precisa lidar:
 *   "Rua do Níquel, Parque Oeste Industrial, Goiânia- GO - 74670-490"
 *   "Av. Pedro Miranda, 2018 - Terrabela Cerrado II, Sen. Canedo - GO, 75262-553, Brasil Nº nota: 515959"
 *   "AV.PEDRO LUDOVICO TEIXEIRA NR.100 QUADRA 142,, PARQUE OESTE INDUSTR, 5208707- GO - 74375400 N° nota: 07-002707611-7"
 *   "AV CASTELO BRANCO 6217 QD 36 LT 09, IPIRANGA, GOIANIA - GO - 74453386 SL1-44067025 062-39916090 - Nº nota: 07-002707611-7"
 *
 * @param {string} str
 * @returns {ParsedAddress}
 */
function parsearEnderecoBrasileiro(str) {
  if (!str || typeof str !== 'string') {
    return {
      street_address: ['Endereço não informado'],
      city: DEFAULT_CITY,
      state: DEFAULT_STATE,
      zip_code: '',
      country: DEFAULT_COUNTRY,
    };
  }

  let limpo = str.trim();

  // 1. Cortar sufixos "Nº nota:..." e "Brasil"
  limpo = limpo.replace(/\s*N[°ºo°]?\s*nota\s*:.*$/i, '').trim();
  limpo = limpo.replace(/[,\s\-]+Brasil\s*$/i, '').trim();

  const UFS = '(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)';

  // 2. Tentar achar o padrão UF imediatamente seguida de CEP — é o caso típico:
  //    "Goiânia - GO - 74670-490", "GO, 75262-553", "- GO - 74445360"
  let uf = DEFAULT_STATE;
  let cep = '';
  let posCorte = limpo.length;

  const padraoUfCep = new RegExp(`[\\s,\\-]${UFS}[\\s,\\-]+(\\d{5})-?(\\d{3})(?!\\d)`);
  const matchUfCep = limpo.match(padraoUfCep);

  if (matchUfCep) {
    uf = matchUfCep[1];
    cep = `${matchUfCep[2]}-${matchUfCep[3]}`;
    posCorte = matchUfCep.index;
  } else {
    // Fallback: extrair CEP e UF separadamente
    const cepRegex = /(\d{5})-?(\d{3})(?!\d)/g;
    const todosCeps = [...limpo.matchAll(cepRegex)];
    if (todosCeps.length > 0) {
      const escolhido = todosCeps[0];
      cep = `${escolhido[1]}-${escolhido[2]}`;
      posCorte = Math.min(posCorte, escolhido.index);
    }
    const ufRegex = new RegExp(`[\\s,\\-]${UFS}(?=[\\s,\\-]|$)`, 'g');
    const todasUfs = [...limpo.matchAll(ufRegex)];
    if (todasUfs.length > 0) {
      const escolhida = todasUfs[todasUfs.length - 1];
      uf = escolhida[1];
      posCorte = Math.min(posCorte, escolhida.index);
    }
  }

  // 3. Tudo antes do corte é o "endereço bruto" (rua + bairro + cidade)
  let antes = limpo.slice(0, posCorte).trim();
  antes = antes.replace(/[,\-\s]+$/g, '').replace(/\s{2,}/g, ' ').trim();

  // 4. Separar cidade do resto — última parte por vírgula que pareça um nome
  //    (ignora segmentos só de números/lixo). Só tenta extrair cidade se houver
  //    pelo menos 2 segmentos — caso contrário tudo vira street e city = default.
  let cidade = DEFAULT_CITY;
  const partes = antes.split(',').map(p => p.trim()).filter(Boolean);

  if (partes.length >= 2) {
    while (partes.length > 0) {
      const candidata = partes[partes.length - 1].replace(/^[\d\-\s]+/, '').trim();
      if (candidata.length >= 3 && /[a-zA-Zà-úÀ-Ú]/.test(candidata)) {
        cidade = candidata;
        partes.pop();
        break;
      }
      partes.pop();
    }
  }

  const street = partes.length > 0 ? partes.join(', ') : antes;

  return {
    street_address: [street || 'Endereço não informado'],
    city: cidade,
    state: uf,
    zip_code: cep,
    country: DEFAULT_COUNTRY,
  };
}

/**
 * Formata telefone para o padrão E.164 (Uber Direct exige).
 * Aceita: "71999999999", "(71) 99999-9999", "+5571999999999", etc.
 * Retorna: "+5571999999999" (sempre com +55 se não tiver código do país)
 *
 * @param {string} tel
 * @param {string} [ddiPadrao='55']
 * @returns {string|null}
 */
function formatarTelefoneE164(tel, ddiPadrao = '55') {
  if (!tel) return null;
  let digitos = String(tel).replace(/\D/g, '');
  if (!digitos) return null;
  // Se já começa com 55 e tem 12 ou 13 dígitos (DDI+DDD+número), assume que tá certo
  if (digitos.startsWith(ddiPadrao) && digitos.length >= 12) {
    return `+${digitos}`;
  }
  // Se tem 10 ou 11 dígitos (DDD + número), adiciona DDI
  if (digitos.length >= 10) {
    return `+${ddiPadrao}${digitos}`;
  }
  return null;
}

/**
 * Formata telefone para padrão BR sem DDI (99 Corp API exige).
 * Aceita os mesmos formatos. Retorna: "71999999999" (sem +55).
 *
 * @param {string} tel
 * @returns {string|null}
 */
function formatarTelefoneBR(tel) {
  if (!tel) return null;
  let digitos = String(tel).replace(/\D/g, '');
  if (!digitos) return null;
  // Remove DDI se vier
  if (digitos.startsWith('55') && digitos.length >= 12) {
    digitos = digitos.slice(2);
  }
  if (digitos.length >= 10) return digitos;
  return null;
}

/**
 * Limita uma string (para campos como notes/instructions que têm cap em 280 chars).
 *
 * @param {string} str
 * @param {number} [max=280]
 * @returns {string|null}
 */
function truncarTexto(str, max = 280) {
  if (!str) return null;
  const s = String(str).trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

module.exports = {
  parsearEnderecoBrasileiro,
  formatarTelefoneE164,
  formatarTelefoneBR,
  truncarTexto,
  DEFAULT_CITY,
  DEFAULT_STATE,
  DEFAULT_COUNTRY,
};
