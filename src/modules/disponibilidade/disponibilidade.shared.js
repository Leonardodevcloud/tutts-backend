/**
 * MÓDULO DISPONIBILIDADE — Shared
 * Funções compartilhadas usadas por outros módulos (ex: filas) para
 * interagir com a tabela disponibilidade_linhas sem precisar conhecer
 * detalhes internos do módulo.
 *
 * 🆕 2026-05-24: integração filas → disponibilidade.
 *  Quando um motoboy entra na fila (clássica ou auto), automaticamente
 *  marcamos a linha dele em disponibilidade_linhas como 'EM LOJA'.
 */

/**
 * Marca o motoboy como 'EM LOJA' em todas as linhas onde ele esteja vinculado
 * em disponibilidade_linhas (filtrado por cod_profissional).
 *
 * Comportamento:
 *  - Fire-safe: NUNCA lança erro pra cima. Falha aqui não pode bloquear
 *    a entrada na fila — apenas loga e segue.
 *  - Idempotente: se já está 'EM LOJA', não atualiza (evita ruído em updated_at).
 *  - Sobrescreve qualquer status anterior (incluindo FALTANDO/SEM CONTATO):
 *    se o motoboy fisicamente entrou na fila, ele está fisicamente na loja —
 *    a presença é confirmada por essa ação.
 *  - Atualiza status_alterado_por / status_alterado_em pra auditoria visual
 *    na tela de disponibilidade (admin sabe quem mudou).
 *
 * @param {Pool} pool - Pool do PostgreSQL (pg)
 * @param {string} cod_profissional - Código do motoboy
 * @param {object} [contexto] - { origem?: string, alterado_por?: string }
 *   origem: 'fila_classica' | 'fila_classica_retorno' | 'fila_auto' |
 *           'fila_classica_admin' | 'fila_auto_admin'
 *   alterado_por: nome a registrar em status_alterado_por (default: "Auto ({origem})")
 * @returns {Promise<{ atualizadas: number, lojas: Array<{id:number, loja_id:number}> }>}
 */
async function marcarMotoboyEmLoja(pool, cod_profissional, contexto = {}) {
  if (!pool || !cod_profissional) {
    return { atualizadas: 0, lojas: [] };
  }

  try {
    const origem = contexto.origem || 'fila';
    const alteradoPor = contexto.alterado_por || `Auto (${origem})`;
    const codNorm = String(cod_profissional).trim().toLowerCase();

    // 🔧 v3 (2026-05-24): LOWER(TRIM(...)) em ambos os lados — alinhado com o
    // resto do sistema (auth usa case-insensitive); evita falsos negativos por
    // diferença de case/whitespace entre fontes.
    // Atualiza somente linhas que NÃO estão já em EM LOJA (evita writes redundantes)
    const result = await pool.query(
      `UPDATE disponibilidade_linhas
          SET status = 'EM LOJA',
              status_alterado_por = $1,
              status_alterado_em = NOW(),
              updated_at = NOW()
        WHERE LOWER(TRIM(cod_profissional)) = $2
          AND COALESCE(status, '') <> 'EM LOJA'
        RETURNING id, loja_id`,
      [alteradoPor, codNorm]
    );

    const atualizadas = result.rows.length;
    if (atualizadas > 0) {
      console.log(
        `🏪 [disponibilidade.em-loja] cod=${cod_profissional} ` +
        `marcado EM LOJA em ${atualizadas} linha(s) | origem=${origem} | por=${alteradoPor}`
      );
    } else {
      // 🔧 v3: log diagnóstico quando NÃO marca nada — pode ser que:
      // 1) já estava EM LOJA (idempotência funcionando)
      // 2) não tem linha em disponibilidade_linhas (vai aparecer o badge "Sem Disponibilidade")
      // O contador abaixo distingue os dois casos.
      const checkR = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'EM LOJA')::int AS ja_em_loja
           FROM disponibilidade_linhas
          WHERE LOWER(TRIM(cod_profissional)) = $1`,
        [codNorm]
      );
      const total = checkR.rows[0]?.total || 0;
      const jaEmLoja = checkR.rows[0]?.ja_em_loja || 0;
      if (total === 0) {
        console.log(
          `🏪 [disponibilidade.em-loja] cod=${cod_profissional} NÃO tem linha em ` +
          `disponibilidade_linhas | origem=${origem} (admin precisa alocar)`
        );
      } else {
        console.log(
          `🏪 [disponibilidade.em-loja] cod=${cod_profissional} já estava EM LOJA ` +
          `em ${jaEmLoja}/${total} linha(s) | origem=${origem} (idempotente)`
        );
      }
    }

    return { atualizadas, lojas: result.rows };
  } catch (err) {
    // Erro NÃO propaga — falha aqui não pode bloquear a entrada na fila
    console.error(
      `⚠️ [disponibilidade.marcarMotoboyEmLoja] erro silencioso (cod=${cod_profissional}):`,
      err.message
    );
    return { atualizadas: 0, lojas: [], erro: err.message };
  }
}

module.exports = { marcarMotoboyEmLoja };
