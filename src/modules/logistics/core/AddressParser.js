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

  // 🔧 2026-07 (Uber): descola numero grudado no nome da rua que quebra o
  // geocoding (ex: "RONDON395" -> "RONDON 395", "CRESPI619Q" -> "CRESPI 619Q").
  // So quando 2+ letras estao coladas ao digito, pra preservar abreviacoes
  // curtas como "L10", "H2", "A1". Sem isso a Uber joga o ponto pra longe e
  // recusa ("outside delivery radius").
  limpo = limpo.replace(/([A-Za-zÀ-Úà-ú]{2,})(\d)/g, '$1 $2').replace(/\s{2,}/g, ' ').trim();

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

  // 🔧 2026-07 (Uber cert item dropoff): SEPARAR complemento do logradouro.
  // A Uber exige street_address = [RUA+NUMERO, BAIRRO] e NADA MAIS. Quadra, lote,
  // bloco, apto, sala etc. tem que ir pra nota (dropoff_notes/pickup_notes), senao
  // o geocoder da Uber se perde e sobrescreve as coordenadas (erro de >1km ->
  // reprova). Critico em Goiania e Brasilia, onde o endereco vem cheio desses
  // tokens (ex: "AV GOIAS 4057Q25 LT 3 4057", "SQN 415 Bloco C").
  // extrairComplementoBR devolve { logradouro, complemento } — o complemento vai
  // pro campo complemento_extraido no retorno, pra o adapter juntar na nota.
  var _extr = extrairComplementoBR(street);
  var streetSemComp = _extr.logradouro;
  var complementoExtraido = _extr.complemento;

  // 🔧 2026-06 (Uber cert): street_address em ATÉ 2 posições [RUA+NÚMERO, BAIRRO]
  // e remove "N"/"Nº"/"No" antes do número — o "N" atrapalha a normalização de
  // geolocalização da Uber. Bairro vai na 2ª posição (pode ser omitida).
  var streetLimpo = String(streetSemComp || '').replace(/\b[Nn][º°o]?\.?\s+(?=\d)/g, '').replace(/\s{2,}/g, ' ').trim();
  var segs = streetLimpo.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var streetArr;
  if (segs.length <= 1) {
    streetArr = [streetLimpo || 'Endereço não informado'];
  } else {
    // Padrão BR comum: "Rua X, 123, Bairro" — o número vem após a 1ª vírgula.
    // Se o 2º segmento começa com dígito, é o número: junta com a rua e o
    // resto vira bairro. Senão, a rua+número já está no 1º segmento.
    var ruaNumero, bairro;
    if (/^\d/.test(segs[1])) {
      ruaNumero = (segs[0] + ' ' + segs[1]).replace(/\s{2,}/g, ' ').trim();
      bairro = segs.slice(2).join(' ').trim();
    } else {
      ruaNumero = segs[0];
      bairro = segs.slice(1).join(' ').trim();
    }
    streetArr = bairro ? [ruaNumero, bairro] : [ruaNumero];
  }

  return {
    street_address: streetArr,
    city: cidade,
    state: uf,
    zip_code: cep,
    country: DEFAULT_COUNTRY,
    // 🔧 2026-07 (Uber): complemento removido do street_address (quadra/lote/bloco/
    // apto/sala). O adapter que quiser junta isso na nota. Campo ADITIVO — quem
    // nao usa (ex: 99) simplesmente ignora.
    complemento_extraido: complementoExtraido || '',
  };
}

/**
 * 🔧 2026-07 (Uber cert): separa complemento (quadra, lote, bloco, apto, sala,
 * conjunto, casa, loja, andar) de um logradouro brasileiro. A Uber exige que o
 * street_address tenha SO rua+numero — o resto vai pra nota, senao o geocoder
 * erra e reprova. Foco em GO/DF, onde esses tokens sao a norma.
 *
 * @param {string} street  logradouro bruto (pode ter numero + complementos)
 * @returns {{ logradouro: string, complemento: string }}
 */
function extrairComplementoBR(street) {
  var s = String(street == null ? '' : street).trim();
  if (!s) return { logradouro: '', complemento: '' };

  // 1. Descola numero grudado na quadra: "4057Q25" -> "4057 Q25".
  s = s.replace(/\b(\d+)\s*([Qq]\s*\.?\s*\d+[A-Za-z]?)\b/g, '$1 $2');

  // 2. Tokens de complemento (rotulo + valor). Ordem importa: mais especificos
  //    primeiro. Cada match sai do logradouro e entra na lista de complementos.
  var re = /\b((?:qd|quadra|q)\s*\.?\s*\d+[a-z]?|(?:lt|lote)\s*\.?\s*\d+[a-z]?|(?:bloco|blc|bl)\s*\.?\s*[a-z0-9]+|(?:apto|apartamento|ap)\s*\.?\s*\d+|(?:sala|sl)\s*\.?\s*\d+|(?:conjunto|conj|cj)\s*\.?\s*[a-z0-9]+|casa\s*\d*|loja\s*\d*|andar\s*\d*)\b/gi;

  var comps = [];
  var m;
  while ((m = re.exec(s)) !== null) {
    comps.push(m[1].replace(/\s{2,}/g, ' ').trim());
  }
  var logradouro = s.replace(re, ' ');

  // 3. Limpa o logradouro: remove numero duplicado consecutivo ("4057 4057" ->
  //    "4057"), espacos e virgulas orfas.
  logradouro = logradouro
    .replace(/\b(\d+)\b(?:\s+\1\b)+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/^[\s,\-]+|[\s,\-]+$/g, '')
    .trim();

  return { logradouro: logradouro, complemento: comps.join(', ') };
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
  extrairComplementoBR,
  formatarTelefoneE164,
  formatarTelefoneBR,
  truncarTexto,
  DEFAULT_CITY,
  DEFAULT_STATE,
  DEFAULT_COUNTRY,
};
