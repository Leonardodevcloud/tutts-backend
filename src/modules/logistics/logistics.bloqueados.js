'use strict';

/**
 * logistics.bloqueados.js — nucleo da blacklist de entregadores do Hub.
 *
 * A 99/Uber nao dao um ID estavel do entregador. Nossa "identidade" e
 * telefone (so digitos) + placa (upper, sem espaco/traco). Uma corrida
 * casa com um bloqueio se o TELEFONE bate OU a PLACA bate.
 *
 * IMPORTANTE (limite conhecido, aceito pelo produto):
 *  - O provider pode mandar telefone mascarado/proxy (muda por corrida) ou
 *    vir sem placa em certas fases. Entao o casamento e "muito bom, nao
 *    infalivel". Casamos pelo que der (telefone OU placa).
 */

/** So digitos. Ex: '(42) 99826-5999' -> '42998265999'. '' se vazio. */
function normalizarTelefone(tel) {
  if (!tel) return '';
  return String(tel).replace(/\D+/g, '');
}

/** Upper, sem espaco/traco/ponto. Ex: 'abc-1d23' -> 'ABC1D23'. '' se vazio. */
function normalizarPlaca(placa) {
  if (!placa) return '';
  return String(placa).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Procura um bloqueio ATIVO que case com o courier informado.
 * Casa por telefone OU placa (o que existir e bater).
 *
 * @param {import('pg').Pool} pool
 * @param {{name?:string, phone?:string, plate?:string}} courier
 * @returns {Promise<object|null>} a linha de logistics_couriers_bloqueados ou null
 */
async function buscarBloqueioAtivo(pool, courier) {
  if (!courier) return null;
  const tel = normalizarTelefone(courier.phone);
  const placa = normalizarPlaca(courier.plate);
  if (!tel && !placa) return null;

  // Monta os predicados dinamicamente — so casa em campo que EXISTE no courier
  // (evita casar dois bloqueios distintos que por acaso tenham telefone vazio).
  const cond = [];
  const params = [];
  if (tel) { params.push(tel); cond.push(`telefone_norm = $${params.length}`); }
  if (placa) { params.push(placa); cond.push(`placa_norm = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT * FROM logistics_couriers_bloqueados
      WHERE ativo = true AND (${cond.join(' OR ')})
      ORDER BY criado_em DESC LIMIT 1`,
    params
  );
  return rows[0] || null;
}

// REDESPACHO_EXCLUSAO_V1 — exclusao POR OS (nao e o bloqueio global).
// Registra que este entregador nao deve pegar ESTA OS. Usado pelo botao
// Redespachar: sem isso o provedor pode devolver o mesmo cara e o botao vira
// enfeite.
async function excluirCourierDaOS(pool, codigoOS, courier, opts = {}) {
  const tel = normalizarTelefone(courier && courier.phone);
  const placa = normalizarPlaca(courier && courier.plate);
  // Sem telefone nem placa nao ha como casar depois — nao adianta gravar.
  if (!tel && !placa) return null;
  const { rows } = await pool.query(
    `INSERT INTO logistics_os_exclusoes
       (codigo_os, telefone_norm, placa_norm, nome, motivo, criado_por)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [codigoOS, tel || null, placa || null, (courier && courier.name) || null,
     opts.motivo || 'redespacho manual', opts.criadoPor || 'sistema']
  );
  return rows[0] || null;
}

// Mesma mecanica do buscarBloqueioAtivo, mas amarrada a uma OS.
async function buscarExclusaoOS(pool, codigoOS, courier) {
  if (!courier || !codigoOS) return null;
  const tel = normalizarTelefone(courier.phone);
  const placa = normalizarPlaca(courier.plate);
  if (!tel && !placa) return null;

  const cond = [];
  const params = [codigoOS];
  if (tel) { params.push(tel); cond.push(`telefone_norm = $${params.length}`); }
  if (placa) { params.push(placa); cond.push(`placa_norm = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT * FROM logistics_os_exclusoes
      WHERE ativo = true AND codigo_os = $1 AND (${cond.join(' OR ')})
      ORDER BY criado_em DESC LIMIT 1`,
    params
  );
  return rows[0] || null;
}

async function contarExclusoesOS(pool, codigoOS) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM logistics_os_exclusoes WHERE codigo_os = $1 AND ativo = true',
    [codigoOS]
  );
  return (rows[0] && rows[0].n) || 0;
}

module.exports = {
  normalizarTelefone,
  normalizarPlaca,
  buscarBloqueioAtivo,
  excluirCourierDaOS,
  buscarExclusaoOS,
  contarExclusoesOS,
};
