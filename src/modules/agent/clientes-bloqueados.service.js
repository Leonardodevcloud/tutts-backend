'use strict';

/**
 * clientes-bloqueados.service.js (2026-07)
 * ─────────────────────────────────────────────────────────────
 * Match PURO POR TEXTO (custo zero, sem API): compara o texto do
 * Ponto 1 lido pelo agente com os clientes bloqueados ativos.
 *
 * Reaproveita normalizar() + scoreSimilaridade() do cruzar-validacoes.
 * Fail-open: qualquer erro de banco NAO barra (retorna { bloqueado:false }).
 */

const { normalizar, scoreSimilaridade } = require('./cruzar-validacoes');

// Limiar de similaridade do endereco (0-100). Ajustavel por env.
const LIMIAR = Number(process.env.BLOQUEIO_AJUSTE_LIMIAR || 80);
// Tamanho minimo pra usar match por substring (evita falso-positivo curto).
const MIN_SUBSTR = 12;

/**
 * @param {Pool} pool
 * @param {string} textoPonto1  Endereco/texto do Ponto 1 lido pelo agente.
 * @returns {Promise<{bloqueado:boolean, nome_loja?:string, endereco?:string}>}
 */
async function checarClienteBloqueado(pool, textoPonto1) {
  const texto = String(textoPonto1 || '').trim();
  if (!texto) return { bloqueado: false };

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT nome_loja, endereco FROM clientes_bloqueados_ajuste WHERE ativo = true`
    ));
  } catch (e) {
    // fail-open: banco fora nao deve barrar entregador
    return { bloqueado: false, erro: e.message };
  }
  if (!rows || rows.length === 0) return { bloqueado: false };

  const nTexto = normalizar(texto);

  for (const r of rows) {
    const nEnd = normalizar(r.endereco);
    const nNome = normalizar(r.nome_loja);

    const bateEndereco =
      nEnd.length >= MIN_SUBSTR && (
        nTexto.includes(nEnd) ||
        (nTexto.length >= MIN_SUBSTR && nEnd.includes(nTexto)) ||
        scoreSimilaridade(texto, r.endereco) >= LIMIAR
      );

    // Nome da loja aparecendo no texto do ponto (bonus). Minimo 4 chars.
    const bateNome = nNome.length >= 4 && nTexto.includes(nNome);

    if (bateEndereco || bateNome) {
      return { bloqueado: true, nome_loja: r.nome_loja, endereco: r.endereco };
    }
  }

  return { bloqueado: false };
}

module.exports = { checarClienteBloqueado };
