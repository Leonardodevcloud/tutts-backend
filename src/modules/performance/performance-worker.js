/**
 * performance-worker.js
 * Processa a fila performance_jobs.
 * Cron automático (hoje) + jobs manuais do frontend.
 * Um job por vez — nunca abre Playwright em paralelo.
 */

'use strict';

const { logger } = require('../../config/logger');
const { buscarPerformance } = require('./playwright-performance');

const INTERVALO_MS = 5 * 60 * 1000;  // 5 minutos
let workerAtivo = false;
let _pool       = null;

function log(msg) { logger.info(`[perf-worker] ${msg}`); }

// Converte Date ou string ISO "2026-03-12" → "12/03/2026"
function dataToBR(valor) {
  const s = valor instanceof Date
    ? valor.toISOString().slice(0, 10)
    : String(valor).slice(0, 10);
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}

// Cria job automático do dia (só se ainda não existe)
async function criarJobAutomatico() {
  const hoje = new Date().toISOString().slice(0, 10);  // "2026-03-12"
  const { rows } = await _pool.query(`
    SELECT id FROM performance_jobs
    WHERE data_inicio = $1
      AND data_fim    = $1
      AND cod_cliente  IS NULL
      AND centro_custo IS NULL
      AND status NOT IN ('erro')
    LIMIT 1
  `, [hoje]);
  if (rows.length) return;

  await _pool.query(`
    INSERT INTO performance_jobs (data_inicio, data_fim, status, origem)
    VALUES ($1, $1, 'pendente', 'cron')
  `, [hoje]);
  log(`📅 Job automático criado para ${hoje}`);
}

// Processa próximo job pendente
async function processarProximo() {
  const { rows } = await _pool.query(`
    SELECT * FROM performance_jobs
    WHERE status = 'pendente'
    ORDER BY iniciado_em ASC
    LIMIT 1
  `);
  if (!rows.length) return;

  const job = rows[0];
  log(`📋 Job #${job.id} | ${job.data_inicio} → ${job.data_fim} | cli=${job.cod_cliente} | origem=${job.origem}`);

  await _pool.query(`UPDATE performance_jobs SET status = 'executando' WHERE id = $1`, [job.id]);

  try {
    const resultado = await buscarPerformance({
      dataInicio:  dataToBR(job.data_inicio),
      dataFim:     dataToBR(job.data_fim),
      codCliente:  job.cod_cliente  || null,
      centroCusto: job.centro_custo || null,
    });

    await _pool.query(`
      INSERT INTO performance_snapshots
        (job_id, data_inicio, data_fim, cod_cliente, centro_custo,
         total_os, no_prazo, fora_prazo, sem_dados, pct_no_prazo, registros)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      job.id,
      job.data_inicio, job.data_fim,
      job.cod_cliente  || null,
      job.centro_custo || null,
      resultado.total,
      resultado.no_prazo,
      resultado.fora_prazo,
      resultado.sem_dados,
      resultado.pct_no_prazo,
      JSON.stringify(resultado.registros),
    ]);

    await _pool.query(`
      UPDATE performance_jobs
      SET status = 'concluido', concluido_em = NOW(), total_os = $1
      WHERE id = $2
    `, [resultado.total, job.id]);

    log(`✅ Job #${job.id} concluído — ${resultado.total} OS, ${resultado.pct_no_prazo}% no prazo`);

  } catch (err) {
    log(`❌ Job #${job.id} falhou: ${err.message}`);
    await _pool.query(`
      UPDATE performance_jobs
      SET status = 'erro', erro = $1, concluido_em = NOW()
      WHERE id = $2
    `, [err.message, job.id]);
  }
}

// Inicia o worker
function startPerformanceWorker(pool) {
  _pool = pool;
  if (workerAtivo) return;
  workerAtivo = true;

  async function tick() {
    try {
      await criarJobAutomatico();
      await processarProximo();
    } catch (err) {
      log(`❌ Tick erro: ${err.message}`);
    } finally {
      setTimeout(tick, INTERVALO_MS);
    }
  }

  setTimeout(tick, 10_000);  // primeiro tick 10s após boot
  log('🟢 Worker iniciado (intervalo: 5min)');
}

module.exports = { startPerformanceWorker };
