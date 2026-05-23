/**
 * filas-auto.service.js — Helpers da fila auto-gerenciável
 *
 * Diferencial vs fila clássica (filas.service.js):
 *  - Não tem despacho manual de admin (motoboys se organizam)
 *  - Agente Playwright valida em background
 *  - Posições reorganizadas atomicamente em SQL (sem race condition)
 */
'use strict';

const { calcularDistanciaHaversine } = require('./filas.service');

/**
 * Compacta posições da central (remove "buracos" deixados por saídas).
 * Após remover alguém da posição 3 em uma fila de 1..7, a 4 vira 3, a 5 vira 4 etc.
 * Atômico — usa CTE para gerar a nova numeração via ROW_NUMBER().
 *
 * @param {Pool} pool
 * @param {number} centralId
 * @param {object} [client] pg client de transação (opcional)
 */
async function compactarPosicoes(pool, centralId, client) {
  const conn = client || pool;
  await conn.query(
    `WITH ordenadas AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY posicao ASC, entrada_fila_at ASC) AS nova_pos
         FROM filas_posicoes
        WHERE central_id = $1 AND status = 'aguardando'
     )
     UPDATE filas_posicoes p
        SET posicao = o.nova_pos, updated_at = NOW()
       FROM ordenadas o
      WHERE p.id = o.id AND p.posicao <> o.nova_pos`,
    [centralId]
  );
}

/**
 * Reordena uma posição específica (admin emergência).
 * Move o motoboy `cod_profissional` da posição atual para `novaPosicao`
 * e desloca os demais conforme necessário.
 *
 * Implementação em 3 etapas (uma transação no chamador):
 *  1. Move o alvo para posição "limbo" (-1) pra não colidir
 *  2. Faz shift dos outros (+1 ou -1 dependendo da direção)
 *  3. Coloca o alvo em novaPosicao
 *
 * @param {Pool|Client} conn
 * @param {number} centralId
 * @param {string} codProfissional
 * @param {number} novaPosicao 1-based
 * @returns {Promise<{ok: boolean, mensagem?: string}>}
 */
async function reordenarMotoboy(conn, centralId, codProfissional, novaPosicao) {
  const atualR = await conn.query(
    `SELECT posicao FROM filas_posicoes
      WHERE central_id = $1 AND cod_profissional = $2 AND status = 'aguardando'`,
    [centralId, codProfissional]
  );
  if (atualR.rows.length === 0) return { ok: false, mensagem: 'Motoboy não está aguardando nesta fila' };
  const posicaoAtual = parseInt(atualR.rows[0].posicao, 10);
  const novaPos = parseInt(novaPosicao, 10);
  if (!Number.isFinite(novaPos) || novaPos < 1) return { ok: false, mensagem: 'Nova posição inválida' };
  if (novaPos === posicaoAtual) return { ok: true };

  const totalR = await conn.query(
    `SELECT COUNT(*)::int AS total FROM filas_posicoes WHERE central_id = $1 AND status = 'aguardando'`,
    [centralId]
  );
  const total = totalR.rows[0].total;
  const destinoEfetivo = Math.min(novaPos, total);

  // Etapa 1: tira o alvo do mapa (posição -1)
  await conn.query(
    `UPDATE filas_posicoes SET posicao = -1, updated_at = NOW()
      WHERE central_id = $1 AND cod_profissional = $2 AND status = 'aguardando'`,
    [centralId, codProfissional]
  );

  if (destinoEfetivo < posicaoAtual) {
    // Subindo: posições [destinoEfetivo .. posicaoAtual-1] sobem +1
    await conn.query(
      `UPDATE filas_posicoes SET posicao = posicao + 1, updated_at = NOW()
        WHERE central_id = $1 AND status = 'aguardando'
          AND posicao >= $2 AND posicao < $3`,
      [centralId, destinoEfetivo, posicaoAtual]
    );
  } else {
    // Descendo: posições (posicaoAtual+1 .. destinoEfetivo] descem -1
    await conn.query(
      `UPDATE filas_posicoes SET posicao = posicao - 1, updated_at = NOW()
        WHERE central_id = $1 AND status = 'aguardando'
          AND posicao > $2 AND posicao <= $3`,
      [centralId, posicaoAtual, destinoEfetivo]
    );
  }

  // Etapa 3: coloca o alvo no destino
  await conn.query(
    `UPDATE filas_posicoes SET posicao = $3, motivo_posicao = 'admin_reordenou', updated_at = NOW()
      WHERE central_id = $1 AND cod_profissional = $2 AND status = 'aguardando'`,
    [centralId, codProfissional, destinoEfetivo]
  );

  return { ok: true };
}

/**
 * Registra evento no log do agente.
 * @param {Pool} pool
 * @param {number} centralId
 * @param {string} acao  'validou' | 'removeu' | 'bloqueou_entrada' | 'varredura_completa' | 'admin_removeu' | 'admin_reordenou'
 */
async function registrarLog(pool, centralId, acao, opts = {}) {
  try {
    await pool.query(
      `INSERT INTO filas_agente_logs (central_id, cod_profissional, nome_profissional, acao, motivo, detalhes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        centralId,
        opts.cod_profissional || null,
        opts.nome_profissional || null,
        acao,
        opts.motivo || null,
        opts.detalhes ? JSON.stringify(opts.detalhes) : null,
      ]
    );
  } catch (e) {
    // log é best-effort, não bloqueia o fluxo principal
    console.warn('[filas-auto] Falha ao gravar log:', e.message);
  }
}

module.exports = {
  calcularDistanciaHaversine,
  compactarPosicoes,
  reordenarMotoboy,
  registrarLog,
};
