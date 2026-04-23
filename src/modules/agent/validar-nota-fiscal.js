/**
 * validar-nota-fiscal.js
 * OCR + análise de uma foto de nota fiscal pra extrair:
 *   - CNPJ do emissor (obrigatório)
 *   - Razão social
 *   - Nome fantasia
 *   - Endereço da NF (rua, número, bairro, cidade, UF, CEP)
 *   - Número da NF
 *
 * Retorna também um score de confiança (0-100) e flag `nf_rejeitada` quando
 * a foto não é uma NF válida (borrada, ilegível, foto de outra coisa, etc.).
 *
 * Não tenta validar "se o endereço da NF bate com o GPS" — esse julgamento
 * fica pro caller, porque o endereço da NF frequentemente está errado/desatualizado.
 *
 * Uso: const r = await validarNotaFiscal(fotoBase64, { latitude, longitude, enderecoGoogle });
 */

'use strict';

const { logger } = require('../../config/logger');

function log(msg) { logger.info(`[validar-nf] ${msg}`); }

/**
 * Normaliza CNPJ: remove tudo que não é dígito, mantém só 14.
 * Retorna string vazia se inválido.
 */
function normalizarCnpj(s) {
  if (!s) return '';
  const so = String(s).replace(/\D/g, '');
  return so.length === 14 ? so : '';
}

/**
 * Formata CNPJ pra exibição: 12.345.678/0001-90
 */
function formatarCnpj(cnpj) {
  const c = normalizarCnpj(cnpj);
  if (!c) return '';
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
}

/**
 * Valida CNPJ pelo dígito verificador.
 * Retorna true se passa nas duas verificações.
 */
function cnpjValido(cnpj) {
  const c = normalizarCnpj(cnpj);
  if (!c || c.length !== 14) return false;
  if (/^(\d)\1+$/.test(c)) return false; // todos os dígitos iguais

  // Primeiro dígito
  const pesos1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += parseInt(c[i]) * pesos1[i];
  let d1 = soma % 11;
  d1 = d1 < 2 ? 0 : 11 - d1;
  if (d1 !== parseInt(c[12])) return false;

  // Segundo dígito
  const pesos2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  soma = 0;
  for (let i = 0; i < 13; i++) soma += parseInt(c[i]) * pesos2[i];
  let d2 = soma % 11;
  d2 = d2 < 2 ? 0 : 11 - d2;
  return d2 === parseInt(c[13]);
}

/**
 * Chama Gemini Vision pra extrair dados da NF.
 * Retorna o JSON extraído ou null se falhar.
 */
async function extrairDadosNF(base64Foto) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { log('⚠️ GEMINI_API_KEY não configurada'); return null; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
  const puro = base64Foto.replace(/^data:image\/[a-z]+;base64,/, '');

  const prompt = `Você é um OCR especializado em notas fiscais brasileiras (NF-e, NFC-e, DANFE, cupom fiscal).

Analise a foto e extraia os dados do EMISSOR (loja que emitiu a nota), retornando APENAS um JSON válido sem markdown:

{
  "is_nota_fiscal": true | false,
  "qualidade_foto": "boa" | "ruim" | "ilegivel",
  "razao_social": "string ou null",
  "nome_fantasia": "string ou null",
  "cnpj": "string só com dígitos, 14 chars, ou null",
  "numero_nf": "string ou null",
  "endereco_emissor": "string completa ou null",
  "rua": "string ou null",
  "numero_endereco": "string ou null",
  "bairro": "string ou null",
  "cidade": "string ou null",
  "uf": "2 letras ou null",
  "cep": "string só com dígitos, 8 chars, ou null",
  "motivo_rejeicao": "string explicando se is_nota_fiscal=false ou qualidade=ilegivel"
}

REGRAS:
- Se a foto não é uma nota fiscal (é uma foto qualquer, paisagem, fachada, etc.) → is_nota_fiscal=false e descreva o que vê em motivo_rejeicao.
- Se a foto está MUITO borrada/escura/cortada e não dá pra ler nada → qualidade_foto="ilegivel" e is_nota_fiscal pode ser true.
- O CNPJ deve ser do EMISSOR (a loja que emitiu a NF), não do destinatário.
- Razão social vs nome fantasia: razão social é o nome jurídico (ex: "BOM DIA AUTO PEÇAS LTDA"), nome fantasia é o nome comercial (ex: "BOM DIA PEÇAS"). Se só achar um, preencha esse e deixe o outro null.
- Se algum campo não existir ou estiver ilegível, use null (não invente).
- O número da NF tipicamente aparece como "Nº" ou "Nota:" ou no DANFE como sequência de 9 dígitos.
- Para endereço, pegue o do EMISSOR (cabeçalho da nota), nunca do destinatário.
- NÃO inclua markdown, comentários ou texto fora do JSON.`;

  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: puro } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json'
    }
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();

    if (!data.candidates || !data.candidates[0]) {
      log('⚠️ Gemini sem candidates: ' + JSON.stringify(data).slice(0, 200));
      return null;
    }
    const texto = data.candidates[0].content.parts[0].text;
    const limpo = texto.trim().replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(limpo);
    return parsed;
  } catch (err) {
    log('❌ Erro Gemini extrair NF: ' + err.message);
    return null;
  }
}

/**
 * Função principal exportada.
 *
 * @param {string} fotoBase64 - foto da nota fiscal em base64
 * @param {object} contexto - { latitude, longitude, enderecoGoogle (opcional, do reverse geocoding) }
 * @returns {object} {
 *   nf_rejeitada: bool,
 *   motivo: string (se rejeitada),
 *   confianca: 0-100,
 *   dados: { cnpj, cnpj_formatado, razao_social, nome_fantasia, numero_nf,
 *            endereco_nf, cidade_nf, uf_nf, cep_nf },
 *   match_cidade: bool (cidade da NF bate com cidade do endereço Google)
 * }
 */
async function validarNotaFiscal(fotoBase64, contexto = {}) {
  if (!fotoBase64) {
    return { nf_rejeitada: true, motivo: 'Foto da NF é obrigatória', confianca: 0, dados: null };
  }

  const extracao = await extrairDadosNF(fotoBase64);
  if (!extracao) {
    return {
      nf_rejeitada: false, // não conseguimos analisar — joga pra fila manual
      motivo: 'IA indisponível — análise manual necessária',
      confianca: 0,
      dados: null
    };
  }

  // Verificações de bloqueio
  if (extracao.is_nota_fiscal === false) {
    return {
      nf_rejeitada: true,
      motivo: extracao.motivo_rejeicao || 'A foto enviada não parece ser uma nota fiscal',
      confianca: 0,
      dados: null
    };
  }

  if (extracao.qualidade_foto === 'ilegivel') {
    return {
      nf_rejeitada: true,
      motivo: extracao.motivo_rejeicao || 'A foto está ilegível. Tire uma nova foto bem iluminada e enquadrada.',
      confianca: 0,
      dados: null
    };
  }

  // Extrai os dados normalizados
  const cnpj = normalizarCnpj(extracao.cnpj);
  const dados = {
    cnpj: cnpj || null,
    cnpj_formatado: cnpj ? formatarCnpj(cnpj) : null,
    razao_social: extracao.razao_social || null,
    nome_fantasia: extracao.nome_fantasia || null,
    numero_nf: extracao.numero_nf || null,
    endereco_nf: extracao.endereco_emissor || null,
    cidade_nf: extracao.cidade || null,
    uf_nf: extracao.uf || null,
    cep_nf: extracao.cep || null
  };

  // CNPJ é obrigatório — sem ele, não dá pra deduplicar
  if (!cnpj) {
    return {
      nf_rejeitada: true,
      motivo: 'Não foi possível ler o CNPJ na nota. Tire uma foto mais clara mostrando o cabeçalho.',
      confianca: 20,
      dados
    };
  }

  if (!cnpjValido(cnpj)) {
    return {
      nf_rejeitada: true,
      motivo: `CNPJ ${formatarCnpj(cnpj)} é inválido (dígito verificador errado). Pode ter sido lido errado pela IA — tente outra foto.`,
      confianca: 30,
      dados
    };
  }

  // Score de confiança — quanto mais campos extraídos, maior a confiança
  let score = 50; // base por ter CNPJ válido
  if (dados.razao_social) score += 15;
  if (dados.nome_fantasia) score += 10;
  if (dados.cidade_nf) score += 10;
  if (dados.cep_nf) score += 5;
  if (dados.numero_nf) score += 5;
  if (extracao.qualidade_foto === 'boa') score += 5;

  // Match cidade: bonificação se cidade da NF bate com a do GPS
  let matchCidade = false;
  if (contexto.enderecoGoogle && dados.cidade_nf) {
    const cidadeGoogle = contexto.enderecoGoogle.toLowerCase();
    const cidadeNF = dados.cidade_nf.toLowerCase();
    matchCidade = cidadeGoogle.includes(cidadeNF) || cidadeNF.split(' ').some(w => w.length > 3 && cidadeGoogle.includes(w));
    if (matchCidade) score += 0; // já validado pelo motoboy estar fisicamente lá; não premia/penaliza muito
  }

  log(`✅ NF analisada: CNPJ=${formatarCnpj(cnpj)} score=${Math.min(100, score)} cidade_match=${matchCidade}`);

  return {
    nf_rejeitada: false,
    motivo: null,
    confianca: Math.min(100, score),
    dados,
    match_cidade: matchCidade
  };
}

module.exports = {
  validarNotaFiscal,
  normalizarCnpj,
  formatarCnpj,
  cnpjValido
};
