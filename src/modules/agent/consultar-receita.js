/**
 * consultar-receita.js
 * Consulta CNPJ na Receita Federal via APIs públicas gratuitas.
 *
 * Estratégia: BrasilAPI primeiro (mais confiável), OpenCNPJ como fallback.
 * Ambas são gratuitas, sem chave, mas usam dumps públicos da Receita
 * (atualizados ~mensalmente). CNPJs muito recentes podem não estar lá.
 *
 * Retorna formato normalizado independente de qual API respondeu:
 *   {
 *     ok: true,
 *     fonte: 'brasilapi' | 'opencnpj',
 *     cnpj: '12345678000190',
 *     razao_social: 'EMPRESA EXEMPLO LTDA',
 *     nome_fantasia: 'EXEMPLO',
 *     situacao: 'ATIVA' | 'BAIXADA' | 'SUSPENSA' | 'INAPTA' | 'NULA',
 *     ativa: true | false,
 *     endereco: 'RUA EXEMPLO, 123, COMPLEMENTO, BAIRRO',
 *     logradouro: 'RUA EXEMPLO',
 *     numero: '123',
 *     complemento: 'SALA 1',
 *     bairro: 'BAIRRO EXEMPLO',
 *     cep: '00000000',
 *     municipio: 'SAO PAULO',
 *     uf: 'SP',
 *     telefone: '11900000000' | null,
 *     consultado_em: '2026-04-25T18:30:00Z'
 *   }
 *
 * Em caso de falha:
 *   { ok: false, motivo: 'CNPJ não encontrado' | 'Timeout' | 'Erro HTTP 500' }
 */

'use strict';

const { logger } = require('../../config/logger');

function log(msg) { logger.info(`[consultar-receita] ${msg}`); }

const TIMEOUT_MS = 8000;

function normalizarCnpj(s) {
  if (!s) return '';
  const so = String(s).replace(/\D/g, '');
  return so.length === 14 ? so : '';
}

function fetchComTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    fetch(url, opts).then(
      r => { clearTimeout(timer); resolve(r); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * Mapeia situação cadastral pra normalizado.
 * BrasilAPI retorna em descricao_situacao_cadastral, OpenCNPJ em situacao_cadastral.
 */
function normalizarSituacao(s) {
  const u = String(s || '').toUpperCase().trim();
  if (u.includes('ATIVA')) return 'ATIVA';
  if (u.includes('BAIXADA')) return 'BAIXADA';
  if (u.includes('SUSPENSA')) return 'SUSPENSA';
  if (u.includes('INAPTA')) return 'INAPTA';
  if (u.includes('NULA')) return 'NULA';
  return u || 'DESCONHECIDA';
}

/**
 * Monta endereço completo formatado.
 */
function formatarEndereco(dados) {
  const partes = [
    dados.logradouro,
    dados.numero,
    dados.complemento,
    dados.bairro,
    dados.municipio,
    dados.uf,
  ].map(p => (p || '').toString().trim()).filter(Boolean);
  return partes.join(', ');
}

/**
 * Tenta BrasilAPI.
 */
async function consultarBrasilAPI(cnpj) {
  try {
    const r = await fetchComTimeout(
      `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      { headers: { 'User-Agent': 'tutts-agent/1.0', 'Accept': 'application/json' } }
    );
    if (r.status === 404) return { ok: false, motivo: 'CNPJ não encontrado na Receita' };
    if (!r.ok) return { ok: false, motivo: `BrasilAPI HTTP ${r.status}` };
    const d = await r.json();

    const situacao = normalizarSituacao(d.descricao_situacao_cadastral);
    return {
      ok: true,
      fonte: 'brasilapi',
      cnpj: cnpj,
      razao_social: (d.razao_social || '').trim() || null,
      nome_fantasia: (d.nome_fantasia || '').trim() || null,
      situacao,
      ativa: situacao === 'ATIVA',
      logradouro: (d.logradouro || '').trim() || null,
      numero: (d.numero || '').toString().trim() || null,
      complemento: (d.complemento || '').trim() || null,
      bairro: (d.bairro || '').trim() || null,
      cep: (d.cep || '').toString().replace(/\D/g, '') || null,
      municipio: (d.municipio || '').trim() || null,
      uf: (d.uf || '').trim() || null,
      endereco: formatarEndereco(d),
      telefone: (d.ddd_telefone_1 || '').toString().replace(/\D/g, '') || null,
      consultado_em: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, motivo: `BrasilAPI erro: ${err.message}` };
  }
}

/**
 * Tenta OpenCNPJ (fallback).
 */
async function consultarOpenCNPJ(cnpj) {
  try {
    const r = await fetchComTimeout(
      `https://api.opencnpj.org/${cnpj}`,
      { headers: { 'User-Agent': 'tutts-agent/1.0', 'Accept': 'application/json' } }
    );
    if (r.status === 404) return { ok: false, motivo: 'CNPJ não encontrado na Receita' };
    if (!r.ok) return { ok: false, motivo: `OpenCNPJ HTTP ${r.status}` };
    const d = await r.json();

    const situacao = normalizarSituacao(d.situacao_cadastral);
    const tel = (d.telefones && d.telefones[0])
      ? `${d.telefones[0].ddd || ''}${d.telefones[0].numero || ''}`.replace(/\D/g, '')
      : null;

    return {
      ok: true,
      fonte: 'opencnpj',
      cnpj: cnpj,
      razao_social: (d.razao_social || '').trim() || null,
      nome_fantasia: (d.nome_fantasia || '').trim() || null,
      situacao,
      ativa: situacao === 'ATIVA',
      logradouro: (d.logradouro || '').trim() || null,
      numero: (d.numero || '').toString().trim() || null,
      complemento: (d.complemento || '').trim() || null,
      bairro: (d.bairro || '').trim() || null,
      cep: (d.cep || '').toString().replace(/\D/g, '') || null,
      municipio: (d.municipio || '').trim() || null,
      uf: (d.uf || '').trim() || null,
      endereco: formatarEndereco(d),
      telefone: tel || null,
      consultado_em: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, motivo: `OpenCNPJ erro: ${err.message}` };
  }
}

/**
 * Consulta um CNPJ — tenta BrasilAPI, cai pra OpenCNPJ se falhar.
 */
async function consultarReceita(cnpj) {
  const c = normalizarCnpj(cnpj);
  if (!c) return { ok: false, motivo: 'CNPJ inválido' };

  // BrasilAPI primeiro
  const r1 = await consultarBrasilAPI(c);
  if (r1.ok) {
    log(`✅ ${c} → BrasilAPI: ${r1.razao_social} (${r1.situacao})`);
    return r1;
  }

  log(`⚠️ ${c} → BrasilAPI falhou (${r1.motivo}), tentando OpenCNPJ...`);

  // Fallback OpenCNPJ
  const r2 = await consultarOpenCNPJ(c);
  if (r2.ok) {
    log(`✅ ${c} → OpenCNPJ: ${r2.razao_social} (${r2.situacao})`);
    return r2;
  }

  log(`❌ ${c} → ambas falharam. Última tentativa: ${r2.motivo}`);
  return { ok: false, motivo: `${r1.motivo} | fallback: ${r2.motivo}` };
}

module.exports = { consultarReceita, normalizarSituacao };
