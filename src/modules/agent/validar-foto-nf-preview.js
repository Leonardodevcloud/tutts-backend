/**
 * src/modules/agent/validar-foto-nf-preview.js
 *
 * Pré-validação RÁPIDA da foto da NF — usado ANTES do submit final
 * para guiar o motoboy a tirar uma foto melhor.
 *
 * Diferenças do validar-nota-fiscal.js (validador completo):
 *   - Usa gemini-2.5-flash-lite (mesmo modelo, mas prompt MUITO menor)
 *   - Não consulta Receita Federal (economia de tempo + chamada extra)
 *   - Retorna feedback acionável em PT-BR ("Aproxime mais", "Tem reflexo", etc)
 *   - Resposta em 1-3s (vs 4-8s do validador completo)
 *
 * NÃO substitui o validar-nota-fiscal.js — só evita que o motoboy submeta
 * fotos ruins. A validação final continua sendo feita pelo módulo principal.
 */

'use strict';

const { logger } = require('../../config/logger');

function log(msg) { logger.info(`[validar-foto-preview] ${msg}`); }

const PROMPT_PREVIEW = `Você é um INSPETOR DE QUALIDADE RIGOROSO de fotos de notas fiscais para motoboys de entrega.

Seu trabalho: REJEITAR fotos que não são claramente NF legível. Na dúvida, REJEITE — é melhor o motoboy refazer do que mandar foto ruim.

Esta foto deve ser de uma NOTA FISCAL BRASILEIRA (NF-e, NFC-e, DANFE ou cupom fiscal) que será usada como prova de entrega.

Retorne APENAS este JSON sem markdown:

{
  "eh_nota_fiscal": true | false,
  "qualidade": "boa" | "media" | "ruim",
  "cnpj_legivel": true | false,
  "cnpj_lido": "string só com 14 dígitos ou null",
  "problemas": ["lista de problemas específicos"],
  "dica_motoboy": "frase curta em PT-BR pro motoboy melhorar a foto, ou null se foto está boa"
}

REGRAS DE REJEIÇÃO (seja rigoroso):
- "eh_nota_fiscal" = false se NÃO for claramente uma NF brasileira. Rejeite:
  - Fotos de paisagem, fachada, pessoas, objetos, animais, comida
  - Documentos que NÃO sejam NF (RG, CPF, recibos genéricos, comprovantes, etiquetas de transporte, ordens de serviço)
  - Telas de celular ou computador (foto de NF digital ainda vale, mas tem que ser claramente uma NF)
  - Fotos onde NÃO consegue ler "NOTA FISCAL", "DANFE", "NF-e", "CUPOM FISCAL" ou estrutura típica de NF (CNPJ + valores + descrição de produtos)
- "qualidade" = "ruim" se:
  - Foto MUITO borrada, escura, queimada, com reflexo grande
  - CNPJ não pode ser lido com confiança
  - Foto cortou parte essencial (cabeçalho, CNPJ)
  - Inclinação extrema ou perspectiva ruim
- "qualidade" = "media" só se foto utilizável MAS com problemas pequenos
- "qualidade" = "boa" SOMENTE se a foto está claramente legível e CNPJ visível sem dificuldade
- "cnpj_legivel" = true SOMENTE se você consegue ler os 14 dígitos do CNPJ com confiança total
- Se "cnpj_legivel" = true, "cnpj_lido" DEVE conter os 14 dígitos
- Se NÃO conseguir ler o CNPJ COM CERTEZA, use "cnpj_legivel": false e "cnpj_lido": null

PROBLEMAS POSSÍVEIS (use só esses valores):
- "nao_eh_nf" — não é uma nota fiscal
- "borrada" — foto desfocada
- "muito_escura"
- "muito_clara"
- "reflexo" — luz refletindo no papel
- "cortada" — parte importante fora da foto
- "inclinada" — perspectiva muito torta
- "sem_cnpj_visivel" — CNPJ não legível
- "muito_distante" — câmera longe demais
- "muito_perto" — câmera perto demais, cortou
- "papel_amassado" — NF dobrada/amassada atrapalhando leitura
- "outro_documento" — é um documento mas não NF (ordem de serviço, recibo, etc)

DICA_MOTOBOY:
- SEMPRE em português, MAX 80 caracteres, imperativa
- Se "eh_nota_fiscal" = false: "Isso não é uma nota fiscal — tire foto da NF de papel"
- Se "outro_documento": "Esse documento não é uma NF — preciso da nota fiscal"
- Se borrada: "Foto borrada, segure firme e foque na NF"
- Se muito_escura: "Muito escura, vá para um lugar com mais luz"
- Se muito_clara: "Muito clara, saia do sol direto"
- Se reflexo: "Tem reflexo na nota, mude o ângulo"
- Se cortada/sem_cnpj_visivel: "Enquadre a NF inteira, mostre o CNPJ"
- Se inclinada: "Endireite a foto, fique de frente pra NF"
- Se "qualidade" = "boa" e "cnpj_legivel" = true → "dica_motoboy": null

Seja DIRETO. Motoboy tá com pressa.`;

/**
 * Pré-valida a foto da NF de forma rápida.
 *
 * @param {string} fotoBase64 - foto em data URL ou base64 puro
 * @returns {object} {
 *   ok: bool,                  // true se pode prosseguir, false se refazer
 *   qualidade: 'boa'|'media'|'ruim',
 *   eh_nota_fiscal: bool,
 *   cnpj_legivel: bool,
 *   cnpj_lido: string|null,    // CNPJ formatado se conseguiu ler
 *   problemas: string[],
 *   dica: string|null,         // dica curta em PT-BR
 *   tempo_ms: number,          // duração da análise
 *   erro: string|null,         // se Gemini falhou (timeout, key ausente, etc)
 * }
 */
async function validarFotoNfPreview(fotoBase64) {
  const t0 = Date.now();

  if (!fotoBase64 || typeof fotoBase64 !== 'string' || fotoBase64.length < 1000) {
    return {
      ok: false,
      qualidade: 'ruim',
      eh_nota_fiscal: false,
      cnpj_legivel: false,
      cnpj_lido: null,
      problemas: ['foto_invalida'],
      dica: 'Foto não recebida. Tente novamente.',
      tempo_ms: Date.now() - t0,
      erro: 'foto_vazia_ou_pequena',
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log('⚠️ GEMINI_API_KEY não configurada — pré-validação desabilitada (passa direto)');
    return {
      ok: true,                 // Falha em modo aberto: deixa motoboy mandar e validador completo decide
      qualidade: 'media',
      eh_nota_fiscal: true,
      cnpj_legivel: false,
      cnpj_lido: null,
      problemas: [],
      dica: null,
      tempo_ms: Date.now() - t0,
      erro: 'sem_api_key',
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
  const puro = fotoBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: puro } },
        { text: PROMPT_PREVIEW }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json',
      // Limite duro pra resposta rápida — não precisamos de muitos tokens
      maxOutputTokens: 300,
    }
  };

  // Timeout agressivo: 5s. Pré-validação tem que ser rápida ou nem vale a pena.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const data = await resp.json();
    if (!data.candidates || !data.candidates[0]) {
      log(`⚠️ Gemini sem candidates: ${JSON.stringify(data).slice(0, 200)}`);
      // Falha em modo aberto: deixa motoboy mandar
      return {
        ok: true,
        qualidade: 'media',
        eh_nota_fiscal: true,
        cnpj_legivel: false,
        cnpj_lido: null,
        problemas: [],
        dica: null,
        tempo_ms: Date.now() - t0,
        erro: 'gemini_sem_resposta',
      };
    }

    const texto = data.candidates[0].content.parts[0].text;
    const limpo = texto.trim().replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(limpo);

    // Normaliza CNPJ pro motoboy ver formatado
    let cnpjFormatado = null;
    if (parsed.cnpj_lido) {
      const c = String(parsed.cnpj_lido).replace(/\D/g, '');
      if (c.length === 14) {
        cnpjFormatado = `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
      }
    }

    // Decisão final RIGOROSA: ok = NF de verdade + qualidade boa + CNPJ legível.
    // 2026-04 v4.1: motoboy reclamou que IA estava deixando passar fotos ruins.
    // Agora "media" não passa mais — só "boa". Se a IA disse "media", motoboy
    // refaz ou usa CNPJ digitado.
    const ehNF = parsed.eh_nota_fiscal !== false;
    const qualidadeBoa = parsed.qualidade === 'boa';
    const cnpjLegivel = parsed.cnpj_legivel === true;

    const ok = ehNF && qualidadeBoa && cnpjLegivel;

    log(`📷 Preview: qualidade=${parsed.qualidade} cnpj_legivel=${parsed.cnpj_legivel} ok=${ok} (${Date.now()-t0}ms)`);

    return {
      ok,
      qualidade: parsed.qualidade || 'media',
      eh_nota_fiscal: parsed.eh_nota_fiscal !== false,
      cnpj_legivel: !!parsed.cnpj_legivel,
      cnpj_lido: cnpjFormatado,
      problemas: Array.isArray(parsed.problemas) ? parsed.problemas : [],
      dica: parsed.dica_motoboy || null,
      tempo_ms: Date.now() - t0,
      erro: null,
    };
  } catch (err) {
    clearTimeout(timer);
    log(`❌ Preview falhou: ${err.message}`);
    // Falha em modo aberto — não trava o motoboy se Gemini estiver fora
    return {
      ok: true,
      qualidade: 'media',
      eh_nota_fiscal: true,
      cnpj_legivel: false,
      cnpj_lido: null,
      problemas: [],
      dica: null,
      tempo_ms: Date.now() - t0,
      erro: err.name === 'AbortError' ? 'timeout' : err.message,
    };
  }
}

module.exports = { validarFotoNfPreview };
