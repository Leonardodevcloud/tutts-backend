/**
 * MODULO LOGISTICS - ClienteFinalParser
 *
 * Fonte UNICA da verdade pra "nome do cliente final" e "numero da nota".
 * Consumido por: card do kanban (logistics.routes), pagina de rastreio e
 * mensagem de rastreio do grupo (sla-capture.service).
 *
 * ---------------------------------------------------------------------------
 * O PROBLEMA
 * ---------------------------------------------------------------------------
 * O texto do ponto vem da Mapp como campo LIVRE. O parser historico
 * (parseEntrega767) assume "tudo depois do ULTIMO CEP = nome do cliente":
 *
 *   ...ZONA INDUSTRIAL, BRASILIA- DF - 70634200 01-001148140-1 061-41011089 - 99619 No nota: 01-001148140-1
 *   |------------------ endereco -------------| |------- vira "nomeCliente" -------| |----- nota -----|
 *
 * Clientes que NAO preenchem nome deixam ali NF + telefone + codigo. Resultado:
 * sai "Cliente: 99619" / "Cliente: 5-1 061-3361-6535 - -" no grupo e no rastreio.
 *
 * ---------------------------------------------------------------------------
 * A CORRECAO
 * ---------------------------------------------------------------------------
 * 1. CLIENTES_SO_NF: lista de cliente_cod que sabidamente nao mandam nome.
 *    Pra eles o nome e SEMPRE descartado e so a NF e exibida.
 * 2. pareceNome(): rede de seguranca por conteudo. Mesmo fora da lista, um
 *    "nome" sem nenhuma letra (so digitos/pontuacao) e lixo e vira null.
 * 3. limparNotaFiscal(): "01-001148140-1" -> "1148140" (miolo, sem zeros
 *    a esquerda). Formato Mapp: <serie>-<numero>-<dv>.
 *
 * Marker: CLIENTE_FINAL_PARSER_V1
 */

'use strict';

// Clientes que nao preenchem o nome do cliente final na Mapp — so tem NF.
// O trecho depois do ultimo CEP neles e sempre lixo (NF/telefone/codigo).
const CLIENTES_SO_NF = ['1165', '1178', '1188'];

/**
 * "01-001148140-1" -> "1148140"
 * "05-000034696-5" -> "34696"
 * "07-002707611-7" -> "2707611"
 * "515959"         -> "515959"  (ja limpa, passa direto)
 *
 * Regra: no formato <serie>-<numero>-<dv> pega o MIOLO e tira zeros a esquerda.
 * Fora desse formato, devolve so os digitos (sem zeros a esquerda).
 * Nunca devolve string vazia — se sobrar nada, mantem o valor original.
 */
function limparNotaFiscal(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Formato canonico da Mapp: 2+ digitos - miolo - digito verificador
  const m = s.match(/^(\d{1,3})-(\d+)-(\d{1,2})$/);
  if (m) {
    const miolo = m[2].replace(/^0+/, '');
    return miolo || m[2];
  }

  // Fallback: se tem hifens mas nao casou o padrao, tenta o maior bloco numerico
  if (s.includes('-')) {
    const blocos = s.split('-').map(b => b.replace(/[^0-9]/g, '')).filter(Boolean);
    if (blocos.length >= 3) {
      const miolo = blocos.slice(1, -1).join('').replace(/^0+/, '');
      if (miolo) return miolo;
    }
  }

  const soDigitos = s.replace(/[^0-9]/g, '').replace(/^0+/, '');
  return soDigitos || s;
}

/**
 * Rede de seguranca: um nome de verdade tem letras. "99619", "5-1 061-3361-6535 - -"
 * e "01-001148140-1 061-41011089" nao sao nomes.
 * Exige pelo menos 2 letras e que letras sejam >= 30% dos caracteres uteis.
 */
function pareceNome(txt) {
  if (!txt) return false;
  const s = String(txt).trim();
  if (s.length < 2) return false;
  const letras = (s.match(/[A-Za-zÀ-Úà-ú]/g) || []).length;
  if (letras < 2) return false;
  const uteis = s.replace(/\s/g, '').length || 1;
  return (letras / uteis) >= 0.3;
}

/**
 * Extrai a nota do texto livre do ponto ("... No nota: 01-001148140-1").
 * Devolve JA LIMPA.
 */
function extrairNota(texto) {
  if (!texto) return null;
  const m = String(texto).match(/(?:PARA\s+)?N[ºo°]\s*nota:?\s*(\S+)/i);
  if (!m) return null;
  const bruta = m[1].replace(/[,.;]+$/, '').trim();
  return limparNotaFiscal(bruta);
}

/**
 * Extrai o nome do cliente do texto livre: trecho depois do ULTIMO CEP e
 * antes do "No nota:". Mesma logica do parseEntrega767, porem passando pela
 * rede de seguranca pareceNome().
 */
function extrairNomeDoTexto(texto) {
  if (!texto) return null;
  const t = String(texto).replace(/\s+/g, ' ').trim();

  const mNota = t.match(/(?:PARA\s+)?N[ºo°]\s*nota:?\s*(\S+)/i);
  const antes = (mNota ? t.substring(0, mNota.index) : t)
    .replace(/\s*PARA\s*$/i, '')
    .trim();

  const ceps = [];
  const rx = /\d{5}-?\d{3}/g;
  let m;
  while ((m = rx.exec(antes)) !== null) ceps.push(m.index + m[0].length);
  if (ceps.length === 0) return null;

  let nome = antes.substring(ceps[ceps.length - 1]).trim();
  nome = nome.replace(/^[\s,\-–]+/, '').replace(/[\s,\-–]+$/, '').trim();
  return pareceNome(nome) ? nome : null;
}

/**
 * API principal.
 *
 * @param {Object} opts
 * @param {string} [opts.texto]      texto livre do ponto (rua/endereco_completo/textoBruto)
 * @param {string} [opts.nome]       nome ja vindo estruturado (ponto.nome / procurar_por)
 * @param {string} [opts.nota]       nota ja vinda estruturada (numero_nota) — sera limpa
 * @param {string} [opts.clienteCod] codigo Mapp do cliente (1165, 1178, ...)
 * @returns {{cliente_final: string|null, nota_fiscal: string|null}}
 */
function extrairClienteFinalENota({ texto = null, nome = null, nota = null, clienteCod = null } = {}) {
  const cod = clienteCod == null ? null : String(clienteCod).trim();
  const soNF = cod != null && CLIENTES_SO_NF.includes(cod);

  const notaFinal = (nota != null && String(nota).trim() !== '')
    ? limparNotaFiscal(nota)
    : extrairNota(texto);

  if (soNF) {
    // Cliente sabidamente sem nome: nunca arrisca exibir o lixo.
    return { cliente_final: null, nota_fiscal: notaFinal };
  }

  let nomeFinal = pareceNome(nome) ? String(nome).trim() : null;
  if (!nomeFinal) nomeFinal = extrairNomeDoTexto(texto);

  return { cliente_final: nomeFinal || null, nota_fiscal: notaFinal };
}

module.exports = {
  CLIENTES_SO_NF,
  limparNotaFiscal,
  pareceNome,
  extrairNota,
  extrairNomeDoTexto,
  extrairClienteFinalENota,
};
