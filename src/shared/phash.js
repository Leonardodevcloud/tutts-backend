/**
 * phash.js — Perceptual Hash (dHash) para detecção de fotos duplicadas
 * 
 * Usa sharp para redimensionar a imagem → compara pixels adjacentes → gera hash de 64 bits
 * Hamming distance < 10 = mesma foto (mesmo com compressão, leve crop, etc)
 */
'use strict';

const sharp = require('sharp');
const { logger } = require('../config/logger');

function log(msg) { logger.info(`[pHash] ${msg}`); }

/**
 * Gera dHash (difference hash) de uma imagem base64
 * @param {string} base64 — imagem em base64 (pode ter ou não o prefixo data:image/...)
 * @returns {string|null} — hash hexadecimal de 16 caracteres (64 bits) ou null se falhar
 */
async function gerarHash(base64) {
  try {
    if (!base64 || typeof base64 !== 'string') return null;

    // Remover prefixo data:image/... se existir
    const puro = base64.replace(/^data:image\/[a-z]+;base64,/, '');
    if (puro.length < 100) return null; // muito pequeno pra ser uma imagem real

    const buffer = Buffer.from(puro, 'base64');

    // Redimensionar para 9x8 em grayscale
    const pixels = await sharp(buffer)
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    // Gerar hash: comparar pixel[x] > pixel[x+1] para cada linha
    let hash = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = pixels[y * 9 + x];
        const right = pixels[y * 9 + x + 1];
        hash += left > right ? '1' : '0';
      }
    }

    // Converter binário para hexadecimal (64 bits → 16 chars hex)
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(hash.substring(i, i + 4), 2).toString(16);
    }

    return hex;
  } catch (err) {
    log(`⚠️ Erro ao gerar hash: ${err.message}`);
    return null;
  }
}

/**
 * Calcula a distância de Hamming entre dois hashes hex
 * @param {string} hash1
 * @param {string} hash2
 * @returns {number} — número de bits diferentes (0 = idêntico, 64 = totalmente diferente)
 */
function distanciaHamming(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 64;

  let dist = 0;
  for (let i = 0; i < hash1.length; i++) {
    const b1 = parseInt(hash1[i], 16);
    const b2 = parseInt(hash2[i], 16);
    let xor = b1 ^ b2;
    while (xor > 0) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

/**
 * Verifica se uma imagem base64 já foi enviada anteriormente
 * @param {Object} pool — pool do PostgreSQL
 * @param {string} base64 — imagem em base64
 * @param {Object} opts — opções
 * @param {string} opts.origem — 'submission' | 'contestacao'
 * @param {string} opts.user_cod — código do profissional (ou null pra checar global)
 * @param {number} opts.limiar — distância máxima para considerar duplicata (default: 10)
 * @param {number} opts.dias — quantos dias pra trás verificar (default: 90)
 * @returns {{ duplicada: boolean, hash: string|null, match?: Object }}
 */
async function verificarDuplicata(pool, base64, opts = {}) {
  const { origem, user_cod, limiar = 10, dias = 90 } = opts;

  const hash = await gerarHash(base64);
  if (!hash) return { duplicada: false, hash: null };

  try {
    // Buscar hashes recentes
    const where = ['created_at > NOW() - INTERVAL \'' + dias + ' days\''];
    const params = [];

    // Se quiser checar só do mesmo user ou de todos
    // Por segurança, checa de TODOS (outro motoboy usando a mesma foto = fraude também)

    const { rows } = await pool.query(
      `SELECT id, hash, user_cod, user_nome, origem, referencia_id, created_at
       FROM foto_hashes
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC`,
      params
    );

    for (const row of rows) {
      const dist = distanciaHamming(hash, row.hash);
      if (dist <= limiar) {
        const dataOriginal = new Date(row.created_at).toLocaleDateString('pt-BR');
        log(`🚨 Foto duplicada! dist=${dist} | hash=${hash} ≈ ${row.hash} | original: user=${row.user_cod} em ${dataOriginal} (${row.origem} #${row.referencia_id})`);
        return {
          duplicada: true,
          hash,
          distancia: dist,
          match: {
            id: row.id,
            user_cod: row.user_cod,
            user_nome: row.user_nome,
            origem: row.origem,
            referencia_id: row.referencia_id,
            data: dataOriginal,
          }
        };
      }
    }

    return { duplicada: false, hash };
  } catch (err) {
    log(`⚠️ Erro ao verificar duplicata: ${err.message}`);
    return { duplicada: false, hash };
  }
}

/**
 * Salva o hash de uma foto no banco
 */
async function salvarHash(pool, { hash, user_cod, user_nome, origem, referencia_id }) {
  if (!hash) return;
  try {
    await pool.query(
      `INSERT INTO foto_hashes (hash, user_cod, user_nome, origem, referencia_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [hash, user_cod || null, user_nome || null, origem || 'submission', referencia_id || null]
    );
  } catch (err) {
    log(`⚠️ Erro ao salvar hash: ${err.message}`);
  }
}

/**
 * Processa múltiplas imagens: verifica duplicatas e salva hashes
 * @returns {{ bloqueada: boolean, motivo?: string, detalhes?: Object }}
 */
async function processarFotos(pool, base64Array, { user_cod, user_nome, origem, referencia_id, limiar = 10 }) {
  if (!Array.isArray(base64Array) || base64Array.length === 0) {
    return { bloqueada: false };
  }

  for (let i = 0; i < base64Array.length; i++) {
    const foto = base64Array[i];
    if (!foto || typeof foto !== 'string' || foto.length < 100) continue;

    const resultado = await verificarDuplicata(pool, foto, { origem, user_cod, limiar });

    if (resultado.duplicada) {
      const match = resultado.match;
      const mesmoUser = match.user_cod === user_cod;
      return {
        bloqueada: true,
        motivo: mesmoUser
          ? `Esta foto já foi enviada por você em ${match.data} (${match.origem} #${match.referencia_id}).`
          : `Esta foto já foi utilizada por outro profissional (${match.user_cod}) em ${match.data}.`,
        detalhes: match,
        foto_index: i,
      };
    }

    // Salvar hash (foto passou)
    await salvarHash(pool, { hash: resultado.hash, user_cod, user_nome, origem, referencia_id });
  }

  return { bloqueada: false };
}

module.exports = { gerarHash, distanciaHamming, verificarDuplicata, salvarHash, processarFotos };
