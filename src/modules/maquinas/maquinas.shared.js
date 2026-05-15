/**
 * Módulo Máquinas — Helpers compartilhados
 *
 * verificarMaquinaPendente(pool, motoboyCodigo) → Promise<null | MaquinaPendente>
 *
 * Consultado pelo módulo Financial antes de aceitar saque emergencial.
 * Retorna null se o motoboy não tem máquina em mãos, ou um objeto com
 * dados da máquina + loja para o frontend renderizar o modal de bloqueio.
 *
 * Performance: index parcial `idx_maqmov_pendente` em
 * maquinas_movimentacoes(motoboy_codigo) WHERE restituida_em IS NULL
 * garante lookup O(log n) mesmo com milhões de movimentações históricas.
 */

async function verificarMaquinaPendente(pool, motoboyCodigo) {
  if (!motoboyCodigo) return null;

  const result = await pool.query(
    `SELECT
       mm.id            AS movimentacao_id,
       mm.maquina_id,
       mm.motoboy_codigo,
       mm.motoboy_nome,
       mm.despachada_em,
       mm.despachada_por,
       m.identificador,
       m.marca,
       cs.id            AS cliente_id,
       COALESCE(cs.empresa, cs.nome) AS cliente_nome,
       cs.telefone      AS cliente_telefone
     FROM maquinas_movimentacoes mm
     JOIN maquinas m              ON m.id = mm.maquina_id
     JOIN clientes_solicitacao cs ON cs.id = mm.cliente_id
     WHERE mm.motoboy_codigo = $1::text
       AND mm.restituida_em IS NULL
     ORDER BY mm.despachada_em ASC
     LIMIT 1`,
    [String(motoboyCodigo)]
  );

  if (result.rows.length === 0) return null;

  const r = result.rows[0];
  return {
    movimentacao_id: r.movimentacao_id,
    maquina_id: r.maquina_id,
    identificador: r.identificador,
    marca: r.marca,
    motoboy_codigo: r.motoboy_codigo,
    motoboy_nome: r.motoboy_nome,
    despachada_em: r.despachada_em,
    despachada_por: r.despachada_por,
    cliente_id: r.cliente_id,
    cliente_nome: r.cliente_nome,
    cliente_telefone: r.cliente_telefone,
  };
}

module.exports = { verificarMaquinaPendente };
