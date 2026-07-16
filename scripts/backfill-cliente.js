#!/usr/bin/env node
/**
 * BACKFILL - atribui cliente (regra) a corridas antigas por match de endereco
 *
 * BACKFILL_CLIENTE_V1
 *
 * O PROBLEMA
 * ----------
 * O relatorio e uma VISAO: refaz o match por endereco a cada consulta, entao
 * criar uma regra hoje ja conserta o nome e o valor das corridas antigas LA.
 *
 * O Hub e o /loja sao REGISTRO: leem regra_id da entrega, gravado no momento
 * do despacho e nunca revisitado. Corrida antiga tem regra_id NULL e vai
 * dizer "Manual / sem regra" pra sempre.
 *
 * Este script fecha essa diferenca: roda o MESMO match do relatorio e grava o
 * resultado em regra_id_manual.
 *
 * POR QUE regra_id_manual E NAO regra_id
 * --------------------------------------
 * regra_id e a verdade historica: qual regra DESPACHOU a corrida. A resposta
 * e "nenhuma" e continua sendo — a regra nem existia naquele dia. O backfill
 * e uma decisao tomada DEPOIS, igual a atribuicao pelo modal. Fica auditavel
 * (regra_manual_por = 'backfill'), reversivel, e nao mente sobre o despacho.
 *
 * O MATCH E O MESMO DO RELATORIO
 * ------------------------------
 * Mesma normalizarEnderecoParaMatch (importada do DispatchRuleMatcher, nao
 * copiada), mesma ordem (identificador >= 4 chars, depois trecho >= 5), mesma
 * fonte de regras (TODAS, sem filtro de ativo — regra inativa ainda
 * identifica de quem era a corrida).
 *
 * Se divergisse, o script gravaria uma coisa e a tela mostraria outra.
 *
 * USO
 * ---
 *   node scripts/backfill-cliente.js                 # DRY-RUN (nao grava)
 *   node scripts/backfill-cliente.js --meses=2       # dry-run, 2 meses
 *   node scripts/backfill-cliente.js --meses=2 --aplicar
 *
 * Sem --aplicar ele NAO grava. Preencher retroativo muda o valor das corridas
 * no relatorio — isso se olha antes.
 */

const { Pool } = require('pg');
const { normalizarEnderecoParaMatch } = require('../src/modules/logistics/core/DispatchRuleMatcher');

const args = process.argv.slice(2);
const APLICAR = args.includes('--aplicar');
const MESES = (() => {
  const a = args.find(x => x.startsWith('--meses='));
  const n = a ? parseInt(a.split('=')[1], 10) : 2;
  return Number.isInteger(n) && n > 0 ? n : 2;
})();

// Sem isto o pg cai no default (localhost:5432) e devolve um ECONNREFUSED
// com stack de pg-pool, que nao diz o que esta faltando. O banco esta no
// Railway; a maquina local nao tem Postgres nenhum.
if (!process.env.DATABASE_URL) {
  console.error('');
  console.error('  ERRO: DATABASE_URL nao esta setada.');
  console.error('');
  console.error('  O banco esta no Railway. Pegue a string em:');
  console.error('    Railway -> projeto -> Postgres -> Variables -> DATABASE_PUBLIC_URL');
  console.error('    (a publica, nao a interna: a interna so funciona dentro do Railway)');
  console.error('');
  console.error('  PowerShell:');
  console.error('    $env:DATABASE_URL = "postgresql://..."');
  console.error('    $env:DB_SSL_REJECT_UNAUTHORIZED = "false"');
  console.error('    node scripts/backfill-cliente.js --meses=2');
  console.error('');
  console.error('  Ou, com o Railway CLI (nao expoe senha no historico):');
  console.error('    railway run node scripts/backfill-cliente.js --meses=2');
  console.error('');
  process.exit(1);
}

// Railway exige SSL mas usa certificado proprio -> rejectUnauthorized: false.
// Mesmo tratamento das tres services (DB_SSL_REJECT_UNAUTHORIZED=false).
const ehLocal = /@(localhost|127\.0\.0\.1|::1)[:\/]/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: ehLocal ? undefined : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

function brl(v) {
  return v == null ? '-' : 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

async function main() {
  console.log('');
  console.log('BACKFILL DE CLIENTE POR ENDERECO');
  console.log('  periodo: ultimos ' + MESES + ' meses');
  console.log('  modo   : ' + (APLICAR ? 'APLICAR (vai gravar)' : 'DRY-RUN (nao grava nada)'));
  console.log('');

  // 1. Regras — TODAS, igual ao relatorio. Regra inativa ainda identifica.
  const { rows: rr } = await pool.query(
    `SELECT id, cliente_nome, trecho_endereco, cliente_identificador, ativo,
            preco_valor_fixo, preco_km_base, preco_valor_km_adicional
       FROM logistics_dispatch_rules ORDER BY id ASC`
  );
  const regras = rr.map(rg => ({
    id: rg.id,
    nome: rg.cliente_nome,
    ativo: rg.ativo,
    trecho: normalizarEnderecoParaMatch(rg.trecho_endereco || rg.cliente_nome || ''),
    ident: normalizarEnderecoParaMatch(rg.cliente_identificador || ''),
    temTabela: rg.preco_valor_fixo != null,
    valorFixo: rg.preco_valor_fixo,
  }));
  console.log('  ' + regras.length + ' regras carregadas (' + regras.filter(r => !r.ativo).length + ' inativas, tambem valem)');

  // Mesma funcao do relatorio: identificador primeiro, depois trecho.
  function regraPorEndereco(endereco) {
    const alvo = normalizarEnderecoParaMatch(endereco || '');
    if (!alvo) return null;
    for (const rg of regras) {
      if (rg.ident && rg.ident.length >= 4 && alvo.includes(rg.ident)) return rg;
      if (rg.trecho && rg.trecho.length >= 5 && alvo.includes(rg.trecho)) return rg;
    }
    return null;
  }

  // 2. Corridas orfas. NUNCA toca no que ja tem regra ou ja foi atribuido.
  const { rows: entregas } = await pool.query(
    `SELECT id, codigo_os, endereco_coleta, created_at
       FROM logistics_deliveries
      WHERE regra_id IS NULL
        AND regra_id_manual IS NULL
        AND created_at >= NOW() - ($1 || ' months')::interval
      ORDER BY created_at DESC`,
    [String(MESES)]
  );
  console.log('  ' + entregas.length + ' corridas sem cliente no periodo');
  console.log('');

  // 3. Match
  const porCliente = new Map();
  const casadas = [];
  let semMatch = 0;
  for (const e of entregas) {
    const rg = regraPorEndereco(e.endereco_coleta);
    if (!rg) { semMatch++; continue; }
    casadas.push({ id: e.id, os: e.codigo_os, regraId: rg.id });
    if (!porCliente.has(rg.nome)) porCliente.set(rg.nome, { n: 0, regraId: rg.id, temTabela: rg.temTabela, valorFixo: rg.valorFixo, ativo: rg.ativo });
    porCliente.get(rg.nome).n++;
  }

  if (porCliente.size === 0) {
    console.log('  Nenhuma corrida casou. Nada a fazer.');
    console.log('  (Se voce esperava match, o endereco da OS nao contem o trecho da regra.)');
    await pool.end();
    return;
  }

  console.log('  CASARAM: ' + casadas.length + ' de ' + entregas.length + '  |  sem match: ' + semMatch);
  console.log('');
  console.log('  cliente                              corridas   tabela       vira');
  console.log('  ' + '-'.repeat(72));
  const ordenado = [...porCliente.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [nome, d] of ordenado) {
    const tab = d.temTabela ? brl(d.valorFixo) + ' + km' : 'SEM TABELA';
    const vira = d.temTabela ? 'valor muda' : 'so o nome';
    console.log('  ' + String(nome).slice(0, 34).padEnd(36) + String(d.n).padEnd(11) + tab.padEnd(13) + vira + (d.ativo ? '' : '  (regra inativa)'));
  }
  console.log('');

  const comTabela = ordenado.filter(([, d]) => d.temTabela).reduce((s, [, d]) => s + d.n, 0);
  if (comTabela > 0) {
    console.log('  ATENCAO: ' + comTabela + ' corridas passam a ser cobradas pela tabela do cliente.');
    console.log('  O valor delas MUDA no relatorio. Confira a lista acima antes de aplicar.');
    console.log('');
  }

  if (!APLICAR) {
    console.log('  DRY-RUN — nada foi gravado.');
    console.log('  Se a lista acima estiver certa, rode de novo com --aplicar:');
    console.log('    node scripts/backfill-cliente.js --meses=' + MESES + ' --aplicar');
    console.log('');
    await pool.end();
    return;
  }

  // 4. Aplica. Uma transacao — ou entra tudo, ou nada.
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    let n = 0;
    for (const c of casadas) {
      await cli.query(
        `UPDATE logistics_deliveries
            SET regra_id_manual = $1, regra_manual_por = 'backfill', regra_manual_em = NOW(), updated_at = NOW()
          WHERE id = $2 AND regra_id IS NULL AND regra_id_manual IS NULL`,
        [c.regraId, c.id]
      );
      n++;
      if (n % 200 === 0) console.log('  ... ' + n + '/' + casadas.length);
    }
    await cli.query('COMMIT');
    console.log('');
    console.log('  APLICADO: ' + n + ' corridas.');
    console.log('  Elas aparecem como "manual" no modal, com regra_manual_por = backfill.');
    console.log('');
    console.log('  Pra desfazer TUDO que este script fez:');
    console.log("    UPDATE logistics_deliveries SET regra_id_manual = NULL, regra_manual_por = NULL,");
    console.log("           regra_manual_em = NULL WHERE regra_manual_por = 'backfill';");
    console.log('');
  } catch (err) {
    await cli.query('ROLLBACK');
    console.error('  ERRO — rollback, nada foi gravado:', err.message);
    process.exitCode = 1;
  } finally {
    cli.release();
  }
  await pool.end();
}

main().catch(err => {
  if (err && (err.code === 'ECONNREFUSED' || (err.errors && err.errors.some(e => e.code === 'ECONNREFUSED')))) {
    console.error('');
    console.error('  ERRO: nao consegui conectar no banco.');
    console.error('  DATABASE_URL aponta pra: ' + String(process.env.DATABASE_URL || '').replace(/:[^:@]*@/, ':***@'));
    console.error('');
    console.error('  Se ai aparece localhost, e a string errada — use a DATABASE_PUBLIC_URL do Railway.');
    console.error('');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
