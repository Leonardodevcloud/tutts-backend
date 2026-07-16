/**
 * MODULO LOGISTICS — ClienteRegraResolver
 *
 * CLIENTE_CARD_ENDERECO_V1
 *
 * O PROBLEMA QUE ESTE ARQUIVO RESOLVE:
 *
 * O card do painel tira o nome do cliente de UM lugar so: o JOIN
 *   logistics_dispatch_rules ON id = COALESCE(regra_id_manual, regra_id)
 * ou seja, da regra que foi gravada NA HORA DO DESPACHO. Se a corrida foi
 * despachada ANTES da regra existir (ou com a regra desativada), regra_id
 * ficou NULL e o card mostra "Manual / sem regra" pra sempre — mesmo que hoje
 * exista uma regra cujo trecho casa exatamente com o endereco de coleta dela.
 *
 * O relatorio de corridas ja nao tinha esse problema porque resolve o nome em
 * degraus, e o degrau 2 casa por ENDERECO na hora da leitura
 * (RELATORIO_CLIENTE_V1, solicitacao/routes/admin.routes.js). Resultado: nome
 * no relatorio, "Manual / sem regra" no card, mesma corrida. Este arquivo da
 * ao card o mesmo degrau 2.
 *
 * POR QUE NAO GRAVAR regra_id NA LEITURA (o "conserta o banco de uma vez"):
 * regra_id e verdade historica — qual regra despachou aquela corrida. Ele
 * decide preco, margem e o que a loja enxerga no portal. Reescrever ele numa
 * rota de LISTAGEM misturaria "quem despachou" com "de quem e o endereco", e a
 * proxima pessoa a ler o dado nao teria como distinguir. Por isso o nome sai
 * resolvido no read e o campo `cliente_origem` diz de onde ele veio.
 *
 * POR QUE EM JS E NAO EM SQL: pra reusar normalizarEnderecoParaMatch, a MESMA
 * funcao do despacho e do relatorio. Em SQL seria uma segunda implementacao da
 * normalizacao (unaccent, "av." -> "avenida", ...) pra manter em sincronia — e
 * ela ia divergir na primeira vez que alguem mexesse em uma das duas.
 *
 * SEM CACHE de proposito: a tabela de regras tem dezenas de linhas e o
 * DispatchRuleMatcher tambem le ela a cada despacho. Um TTL aqui faria a regra
 * recem-cadastrada demorar pra aparecer no card — que e exatamente a queixa que
 * este pacote resolve.
 */

const { normalizarEnderecoParaMatch } = require('./DispatchRuleMatcher');

/**
 * Carrega as regras num formato ja normalizado pro match.
 *
 * SEM filtro de `ativo`: aqui o objetivo e NOMEAR, nao decidir despacho. Uma
 * regra desativada hoje ainda identifica de quem era aquela corrida. Mesma
 * decisao do relatorio (RELATORIO_CLIENTE_V1).
 *
 * ORDER BY id ASC = mesmo desempate do DispatchRuleMatcher: a primeira que
 * casar vence.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array<{id:number, nome:string, trecho:string, ident:string}>>}
 */
async function carregarRegrasParaNome(pool) {
  const { rows } = await pool.query(
    `SELECT id, cliente_nome, trecho_endereco, cliente_identificador
       FROM logistics_dispatch_rules
      ORDER BY id ASC`
  );
  return rows.map((rg) => ({
    id: rg.id,
    nome: rg.cliente_nome,
    trecho: normalizarEnderecoParaMatch(rg.trecho_endereco || rg.cliente_nome || ''),
    ident: normalizarEnderecoParaMatch(rg.cliente_identificador || ''),
  }));
}

/**
 * Acha a regra cujo trecho/identificador aparece no endereco de coleta.
 * Mesmos limiares do DispatchRuleMatcher: identificador >= 4, trecho >= 5.
 *
 * @param {Array} regras - saida de carregarRegrasParaNome
 * @param {string} endereco - endereco de coleta cru
 * @returns {Object|null}
 */
function regraPorEndereco(regras, endereco) {
  if (!Array.isArray(regras) || regras.length === 0) return null;
  const alvo = normalizarEnderecoParaMatch(endereco || '');
  if (!alvo) return null;
  for (const rg of regras) {
    if (rg.ident && rg.ident.length >= 4 && alvo.includes(rg.ident)) return rg;
    if (rg.trecho && rg.trecho.length >= 5 && alvo.includes(rg.trecho)) return rg;
  }
  return null;
}

/**
 * Preenche cliente_nome_regra / cliente_origem nas linhas CRUAS de
 * logistics_deliveries (antes do mapper).
 *
 * Ordem (a mesma do relatorio):
 *   1. regra_id_manual -> origem 'manual'   (atribuicao humana vence tudo)
 *   2. regra_id        -> origem 'regra'    (veio do JOIN de quem chamou)
 *   3. endereco_coleta -> origem 'endereco' (resolvido aqui, no read)
 *
 * Os degraus 1 e 2 chegam aqui ja resolvidos no campo cliente_nome_regra pelo
 * JOIN de quem chamou — esta funcao so distingue a origem deles e cobre o 3.
 *
 * Best-effort: se as regras nao carregarem, devolve as linhas intactas (o card
 * volta a mostrar "Manual / sem regra", que e o comportamento de antes — nunca
 * pior).
 *
 * @param {import('pg').Pool} pool
 * @param {Object[]} rows - linhas de logistics_deliveries com cliente_nome_regra do JOIN
 * @returns {Promise<Object[]>} as MESMAS linhas, mutadas
 */
async function resolverClienteEmLote(pool, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  for (const r of rows) {
    if (r.cliente_nome_regra) r.cliente_origem = r.regra_id_manual ? 'manual' : 'regra';
  }

  const faltando = rows.filter((r) => !r.cliente_nome_regra);
  if (faltando.length === 0) return rows;

  let regras;
  try {
    regras = await carregarRegrasParaNome(pool);
  } catch (err) {
    console.warn('[ClienteRegraResolver] regras indisponiveis:', err.message);
    return rows;
  }
  if (regras.length === 0) return rows;

  for (const r of faltando) {
    const rg = regraPorEndereco(regras, r.endereco_coleta);
    if (!rg) continue;
    r.cliente_nome_regra = rg.nome;
    r.cliente_origem = 'endereco';
    r.cliente_regra_id = rg.id; // pre-seleciona a regra no modal de atribuicao
  }
  return rows;
}

module.exports = { carregarRegrasParaNome, regraPorEndereco, resolverClienteEmLote };
