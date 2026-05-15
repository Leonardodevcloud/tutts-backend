/**
 * Módulo Máquinas — Helpers compartilhados
 *
 * Este arquivo lida com a integração entre o cadastro de profissionais da
 * API Tutts (legado, externo) e o cadastro `users` da Central. Os códigos
 * NÃO batem entre os dois sistemas, então cruzamos pelo NOME normalizado.
 *
 * Exportações:
 *  - normalizarNome(nome)              → string normalizada pra comparação
 *  - resolverMotoboyCentral(pool, nm)  → { cod_profissional, full_name } | null
 *  - verificarMaquinaPendente(pool, cod, nome?) → MaquinaPendente | null
 */

// ─── Normalização de nomes ─────────────────────────────────────────────────
// "João Silva" / "JOÃO SILVA" / "joão  silva " → "joao silva"
function normalizarNome(nome) {
  if (!nome) return '';
  return String(nome)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove diacríticos
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// SQL de normalização equivalente, para usar em queries (sem extensão unaccent).
// Mantém o resultado idêntico ao normalizarNome em JS.
const SQL_NORM = `lower(translate(
    $NAME$,
    'áàâãäÁÀÂÃÄéèêëÉÈÊËíìîïÍÌÎÏóòôõöÓÒÔÕÖúùûüÚÙÛÜçÇñÑ',
    'aaaaaAAAAAeeeeEEEEiiiiIIIIoooooOOOOOuuuuUUUUcCnN'
  ))`;

/**
 * Resolve um nome de motoboy vindo da API Tutts para um registro em `users`
 * (cadastro da Central). Tenta match exato normalizado, depois fallback
 * pelos dois primeiros nomes. Retorna null se não achou ou se houver
 * ambiguidade (>1 match).
 */
async function resolverMotoboyCentral(pool, nomeTutts) {
  const nomeNorm = normalizarNome(nomeTutts);
  if (!nomeNorm) return null;

  // 1) Match exato normalizado
  const r1 = await pool.query(
    `SELECT cod_profissional, full_name
       FROM users
      WHERE role = 'motoboy'
        AND ${SQL_NORM.replace('$NAME$', 'full_name')} = $1
      LIMIT 2`,
    [nomeNorm]
  );
  if (r1.rows.length === 1) return r1.rows[0];
  if (r1.rows.length > 1) {
    console.warn(`[MAQUINAS/cross-ref] AMBIGUIDADE para "${nomeTutts}" — ${r1.rows.length} matches exatos. Vínculo recusado.`);
    return null;
  }

  // 2) Fallback: dois primeiros nomes (cobre sobrenomes adicionais)
  //    "JOÃO SILVA" Tutts → casa com "João Silva Santos" Central
  const partes = nomeNorm.split(' ').filter(p => p.length > 1);
  if (partes.length >= 2) {
    const prefixo = partes.slice(0, 2).join(' ');
    const r2 = await pool.query(
      `SELECT cod_profissional, full_name
         FROM users
        WHERE role = 'motoboy'
          AND ${SQL_NORM.replace('$NAME$', 'full_name')} LIKE $1
        LIMIT 2`,
      [`${prefixo}%`]
    );
    if (r2.rows.length === 1) return r2.rows[0];
    if (r2.rows.length > 1) {
      console.warn(`[MAQUINAS/cross-ref] AMBIGUIDADE pelo prefixo "${prefixo}" para "${nomeTutts}". Vínculo recusado.`);
      return null;
    }
  }

  console.warn(`[MAQUINAS/cross-ref] Motoboy "${nomeTutts}" NÃO encontrado em users (role=motoboy). Despacho prosseguirá sem vínculo Central.`);
  return null;
}

/**
 * Verifica se um motoboy tem máquina em mãos (movimentação ativa).
 *
 * Estratégia em 2 camadas (defesa em profundidade):
 *   1. Match direto por cod_profissional (caso comum — vínculo já resolvido)
 *   2. Fallback por NOME normalizado entre as movimentações com
 *      vinculado_central = false (caso o cross-ref tenha falhado no despacho
 *      mas o motoboy realmente é o mesmo)
 *
 * @param {Pool} pool
 * @param {string} motoboyCodigo - cod_profissional do JWT do motoboy (Central)
 * @param {string} [motoboyNome] - full_name do motoboy logado (opcional, do JWT)
 */
async function verificarMaquinaPendente(pool, motoboyCodigo, motoboyNome) {
  if (!motoboyCodigo) return null;

  const SELECT_BASE = `
    SELECT
      mm.id            AS movimentacao_id,
      mm.maquina_id,
      mm.motoboy_codigo,
      mm.motoboy_codigo_tutts,
      mm.motoboy_nome,
      mm.vinculado_central,
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
  `;

  // 1) Match direto por cod_profissional (caminho rápido — usa index parcial)
  const r1 = await pool.query(
    `${SELECT_BASE}
     WHERE mm.motoboy_codigo = $1::text
       AND mm.restituida_em IS NULL
     ORDER BY mm.despachada_em ASC
     LIMIT 1`,
    [String(motoboyCodigo)]
  );
  if (r1.rows.length > 0) return formatar(r1.rows[0]);

  // 2) Fallback por nome (só vasculha registros sem vínculo Central)
  if (motoboyNome) {
    const nomeNorm = normalizarNome(motoboyNome);
    if (nomeNorm) {
      const r2 = await pool.query(
        `${SELECT_BASE}
         WHERE mm.restituida_em IS NULL
           AND mm.vinculado_central = false
           AND ${SQL_NORM.replace('$NAME$', 'mm.motoboy_nome')} = $1
         ORDER BY mm.despachada_em ASC
         LIMIT 1`,
        [nomeNorm]
      );
      if (r2.rows.length > 0) {
        console.log(`[MAQUINAS/saque-bloqueio] Pendência resolvida via fallback por nome "${motoboyNome}" (movimentacao_id=${r2.rows[0].movimentacao_id})`);
        return formatar(r2.rows[0]);
      }
    }
  }

  return null;
}

function formatar(r) {
  return {
    movimentacao_id: r.movimentacao_id,
    maquina_id: r.maquina_id,
    identificador: r.identificador,
    marca: r.marca,
    motoboy_codigo: r.motoboy_codigo,
    motoboy_codigo_tutts: r.motoboy_codigo_tutts,
    motoboy_nome: r.motoboy_nome,
    vinculado_central: r.vinculado_central,
    despachada_em: r.despachada_em,
    despachada_por: r.despachada_por,
    cliente_id: r.cliente_id,
    cliente_nome: r.cliente_nome,
    cliente_telefone: r.cliente_telefone,
  };
}

module.exports = {
  normalizarNome,
  resolverMotoboyCentral,
  verificarMaquinaPendente,
};
