/**
 * MÓDULO ROTEIRIZADOR - Service
 * Lógica pura: normalização de endereços, validações
 */

/**
 * Normaliza endereço para comparação no cache de geocodificação
 */
function normalizarEndereco(endereco) {
  let texto = (endereco || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    
    // ABREVIAÇÕES DE LOGRADOUROS
    .replace(/\b(avenida|aven|avda)\b/g, 'av')
    .replace(/\b(rua)\b/g, 'r')
    .replace(/\b(travessa|trav)\b/g, 'tv')
    .replace(/\b(alameda)\b/g, 'al')
    .replace(/\b(praca|pca)\b/g, 'pc')
    .replace(/\b(rodovia|rod)\b/g, 'rod')
    .replace(/\b(estrada|estr)\b/g, 'est')
    .replace(/\b(largo)\b/g, 'lg')
    .replace(/\b(beco)\b/g, 'bc')
    .replace(/\b(viela)\b/g, 'vl')
    .replace(/\b(ladeira)\b/g, 'ld')
    .replace(/\b(passagem|pass)\b/g, 'pas')
    .replace(/\b(quadra|qd)\b/g, 'q')
    .replace(/\b(lote|lt)\b/g, 'lt')
    .replace(/\b(bloco|bl)\b/g, 'bl')
    .replace(/\b(conjunto|conj|cj)\b/g, 'cj')
    .replace(/\b(edificio|edif|ed)\b/g, 'ed')
    .replace(/\b(apartamento|apto|apt|ap)\b/g, 'ap')
    .replace(/\b(casa)\b/g, 'cs')
    .replace(/\b(sala|sl)\b/g, 'sl')
    .replace(/\b(loja|lj)\b/g, 'lj')
    .replace(/\b(sobreloja|slj)\b/g, 'slj')
    .replace(/\b(andar)\b/g, 'and')
    .replace(/\b(galeria|gal)\b/g, 'gal')
    .replace(/\b(chacara|chac)\b/g, 'ch')
    .replace(/\b(fazenda|faz)\b/g, 'faz')
    .replace(/\b(sitio)\b/g, 'sit')
    .replace(/\b(vila|vl)\b/g, 'vl')
    .replace(/\b(jardim|jd|jard)\b/g, 'jd')
    .replace(/\b(parque|pq|pque)\b/g, 'pq')
    .replace(/\b(residencial|resid|res)\b/g, 'res')
    .replace(/\b(setor|set)\b/g, 'st')
    .replace(/\b(centro)\b/g, 'ctr')
    
    // TÍTULOS E PATENTES
    .replace(/\b(doutor|dr)\b/g, 'dr')
    .replace(/\b(doutora|dra)\b/g, 'dra')
    .replace(/\b(professor|prof)\b/g, 'prof')
    .replace(/\b(professora|profa)\b/g, 'profa')
    .replace(/\b(engenheiro|eng)\b/g, 'eng')
    .replace(/\b(engenheira|enga)\b/g, 'enga')
    .replace(/\b(general|gen)\b/g, 'gen')
    .replace(/\b(coronel|cel)\b/g, 'cel')
    .replace(/\b(tenente|ten)\b/g, 'ten')
    .replace(/\b(capitao|cap)\b/g, 'cap')
    .replace(/\b(sargento|sgt)\b/g, 'sgt')
    .replace(/\b(soldado|sd)\b/g, 'sd')
    .replace(/\b(almirante|alm)\b/g, 'alm')
    .replace(/\b(brigadeiro|brig)\b/g, 'brig')
    .replace(/\b(marechal|mal)\b/g, 'mal')
    .replace(/\b(presidente|pres)\b/g, 'pres')
    .replace(/\b(governador|gov)\b/g, 'gov')
    .replace(/\b(prefeito|pref)\b/g, 'pref')
    .replace(/\b(deputado|dep)\b/g, 'dep')
    .replace(/\b(senador|sen)\b/g, 'sen')
    .replace(/\b(vereador|ver)\b/g, 'ver')
    .replace(/\b(padre|pe)\b/g, 'pe')
    .replace(/\b(frei)\b/g, 'fr')
    .replace(/\b(irma|irm)\b/g, 'irm')
    .replace(/\b(santo|sto)\b/g, 'sto')
    .replace(/\b(santa|sta)\b/g, 'sta')
    .replace(/\b(sao)\b/g, 'sao')
    .replace(/\b(nossa senhora|ns)\b/g, 'ns')
    .replace(/\b(dom)\b/g, 'dom')
    .replace(/\b(dona|dna)\b/g, 'dna')
    .replace(/\b(senhor|sr)\b/g, 'sr')
    .replace(/\b(senhora|sra)\b/g, 'sra')
    
    // DIREÇÕES E POSIÇÕES
    .replace(/\b(norte|n)\b/g, 'n')
    .replace(/\b(sul|s)\b/g, 's')
    .replace(/\b(leste|l)\b/g, 'l')
    .replace(/\b(oeste|o)\b/g, 'o')
    
    // ESTADOS
    .replace(/\bgoias\b/g, 'go')
    .replace(/\b(goiania)\b/g, 'gyn')
    .replace(/\b(brasilia)\b/g, 'bsb')
    .replace(/\b(sao paulo)\b/g, 'sp')
    .replace(/\b(rio de janeiro)\b/g, 'rj')
    .replace(/\b(belo horizonte)\b/g, 'bh')
    .replace(/\b(brasil|brazil|br)\b/g, '')
    
    // LIMPEZA FINAL
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
    
  const stopWords = ['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'nas', 'nos', 'a', 'o', 'as', 'os', 'um', 'uma', 'para', 'com'];
  texto = texto.split(' ').filter(p => !stopWords.includes(p) && p.length > 0).join(' ');
  
  return texto;
}

module.exports = { normalizarEndereco };
