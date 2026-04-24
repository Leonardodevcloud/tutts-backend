/**
 * agents/performance.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente de performance — processa jobs em batch (mesmo dia agrupados).
 * Substitui parte do `performance-worker.js` antigo.
 *
 * MODELO: tickGlobal a cada 30s
 *   - Não usa item-por-item (porque batching agrupa N jobs do mesmo dia em 1 captura)
 *   - 1 slot só (não paralelo) — playwright-performance já abre múltiplas abas internamente
 *
 * Cron de criação de jobs (10:10, 14:00, 17:10) está em performance-cron.agent.js
 * (separado porque defineAgent suporta só 1 cronExpression por agente).
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const { logger } = require('../../../config/logger');

const TIMEOUT_JOB_MS = 5 * 60 * 1000; // 5min máx por job (igual ao worker antigo)

function dataToBR(valor) {
  const s = valor instanceof Date
    ? valor.toISOString().slice(0, 10)
    : String(valor).slice(0, 10);
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}

function comTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function limparJobsTravados(pool) {
  try {
    const { rowCount } = await pool.query(`
      UPDATE performance_jobs
      SET status = 'erro', erro = 'Timeout automático — travado há mais de 10 minutos', concluido_em = NOW()
      WHERE status = 'executando'
        AND iniciado_em < NOW() - INTERVAL '10 minutes'
    `);
    if (rowCount > 0) logger.info(`[performance.agent] 🧹 ${rowCount} job(s) travado(s) limpo(s)`);
  } catch (_) { /* ignora */ }
}

module.exports = defineAgent({
  nome: 'performance',
  slots: 1,                          // 1 slot — playwright-performance usa múltiplas abas internamente
  sessionStrategy: null,             // não usa session manager (playwright-performance tem seu próprio login)
  intervalo: 30_000,                 // 30s entre ticks (igual ao worker antigo)

  // Batch processing — não dá pra usar buscarPendentes/processar (item-por-item)
  // porque o playwright-performance.buscarPerformanceBatch agrupa N jobs em 1 captura
  tickGlobal: async (pool, ctx) => {
    await limparJobsTravados(pool);

    // Buscar TODOS os jobs pendentes (até 20)
    const { rows } = await pool.query(`
      SELECT * FROM performance_jobs
      WHERE status = 'pendente'
      ORDER BY iniciado_em ASC
      LIMIT 20
    `);

    if (!rows.length) return;

    ctx.log(`📦 ${rows.length} job(s) pendente(s)`);

    // Agrupar por (data_inicio, data_fim)
    const porData = {};
    for (const job of rows) {
      const key = `${job.data_inicio}_${job.data_fim}`;
      if (!porData[key]) porData[key] = [];
      porData[key].push(job);
    }

    for (const [dateKey, jobs] of Object.entries(porData)) {
      const ids = jobs.map(j => j.id);
      ctx.log(`📦 BATCH: ${jobs.length} jobs (${dateKey}) — IDs: ${ids.join(',')}`);

      await pool.query(
        `UPDATE performance_jobs SET status = 'executando', iniciado_em = NOW() WHERE id = ANY($1)`,
        [ids]
      );

      try {
        const configs = jobs.map(j => ({
          dataInicio:  dataToBR(j.data_inicio),
          dataFim:     dataToBR(j.data_fim),
          codCliente:  j.cod_cliente || null,
          centroCusto: j.centro_custo || null,
        }));

        // Lazy require pra evitar carregar Playwright se nunca rodar
        const { buscarPerformanceBatch } = require('../../performance/playwright-performance');
        const resultados = await comTimeout(
          buscarPerformanceBatch(configs),
          TIMEOUT_JOB_MS * jobs.length
        );

        // Salvar resultados
        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i];
          const resultado = resultados[i];

          if (resultado && resultado.success !== false) {
            await pool.query(`
              INSERT INTO performance_snapshots
                (job_id, data_inicio, data_fim, cod_cliente, centro_custo,
                 total_os, no_prazo, fora_prazo, sem_dados, pct_no_prazo, registros)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [
              job.id, job.data_inicio, job.data_fim,
              job.cod_cliente || null, job.centro_custo || null,
              resultado.total, resultado.no_prazo, resultado.fora_prazo,
              resultado.sem_dados, resultado.pct_no_prazo,
              JSON.stringify(resultado.registros)
            ]);

            await pool.query(
              `UPDATE performance_jobs SET status = 'concluido', concluido_em = NOW(), total_os = $1 WHERE id = $2`,
              [resultado.total, job.id]
            );
            ctx.log(`✅ Job #${job.id} concluído — ${resultado.total} OS`);
          } else {
            await pool.query(
              `UPDATE performance_jobs SET status = 'erro', erro = $1, concluido_em = NOW() WHERE id = $2`,
              [resultado?.error || 'Falha desconhecida', job.id]
            );
            ctx.log(`❌ Job #${job.id} falhou: ${resultado?.error}`);
          }
        }
      } catch (err) {
        ctx.log(`❌ BATCH falhou: ${err.message}`);
        await pool.query(
          `UPDATE performance_jobs SET status = 'erro', erro = $1, concluido_em = NOW() WHERE id = ANY($2)`,
          [err.message.slice(0, 500), ids]
        );
      }
    }
  },
});
