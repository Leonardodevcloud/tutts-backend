/**
 * performance-worker.js — v3
 * Processa jobs de performance (manuais + cron automático).
 * Timeout de 5min por job — nunca trava.
 * Auto-limpeza de jobs travados há > 10min.
 * Verifica fila a cada 30s (leve, só um SELECT).
 * Cron automático 1h em horário comercial (8h-19h, seg-sáb).
 */

'use strict';

const { logger } = require('../../config/logger');
const { buscarPerformance } = require('./playwright-performance');

const INTERVALO_MS = 30 * 1000;  // 30s — só checa fila, não abre browser
let workerAtivo = false;
let executando  = false;  // trava para não rodar 2 Playwright ao mesmo tempo
let executandoDesde = null; // timestamp de quando começou
let _pool       = null;

function log(msg) { logger.info(`[perf-worker] ${msg}`); }

// Converte "2026-03-12" → "12/03/2026"
function dataToBR(valor) {
  const s = valor instanceof Date
    ? valor.toISOString().slice(0, 10)
    : String(valor).slice(0, 10);
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}

const TIMEOUT_JOB_MS = 5 * 60 * 1000; // 5 min máx por job

// Limpar jobs travados (executando há > 10min)
async function limparJobsTravados() {
  try {
    const { rowCount } = await _pool.query(`
      UPDATE performance_jobs
      SET status = 'erro', erro = 'Timeout automático — travado há mais de 10 minutos', concluido_em = NOW()
      WHERE status = 'executando'
        AND iniciado_em < NOW() - INTERVAL '10 minutes'
    `);
    if (rowCount > 0) log(`🧹 ${rowCount} job(s) travado(s) limpo(s)`);
  } catch (e) { /* ignora */ }
}

// Promise com timeout
function comTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout após ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// Processa próximo job pendente
async function processarProximo() {
  if (executando) {
    if (Date.now() - (executandoDesde || 0) > 6 * 60 * 1000) {
      log('⚠️ Flag executando travada há >6min — resetando');
      executando = false;
    } else {
      return;
    }
  }

  await limparJobsTravados();

  // Buscar TODOS os jobs pendentes (batch)
  const { rows } = await _pool.query(`
    SELECT * FROM performance_jobs
    WHERE status = 'pendente'
    ORDER BY iniciado_em ASC
    LIMIT 20
  `);
  if (!rows.length) return;

  executando = true;
  executandoDesde = Date.now();

  // Agrupar por data (jobs do mesmo dia rodam em batch)
  const porData = {};
  for (const job of rows) {
    const key = `${job.data_inicio}_${job.data_fim}`;
    if (!porData[key]) porData[key] = [];
    porData[key].push(job);
  }

  for (const [dateKey, jobs] of Object.entries(porData)) {
    const ids = jobs.map(j => j.id);
    log(`📦 BATCH: ${jobs.length} jobs (${dateKey}) — IDs: ${ids.join(',')}`);

    // Marcar todos como executando
    await _pool.query(`UPDATE performance_jobs SET status = 'executando' WHERE id = ANY($1)`, [ids]);

    try {
      const configs = jobs.map(j => ({
        dataInicio:  dataToBR(j.data_inicio),
        dataFim:     dataToBR(j.data_fim),
        codCliente:  j.cod_cliente || null,
        centroCusto: j.centro_custo || null,
      }));

      const { buscarPerformanceBatch } = require('./playwright-performance');
      const resultados = await comTimeout(buscarPerformanceBatch(configs), TIMEOUT_JOB_MS * jobs.length);

      // Salvar cada resultado
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const resultado = resultados[i];

        if (resultado && resultado.success !== false) {
          await _pool.query(`
            INSERT INTO performance_snapshots
              (job_id, data_inicio, data_fim, cod_cliente, centro_custo,
               total_os, no_prazo, fora_prazo, sem_dados, pct_no_prazo, registros)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `, [job.id, job.data_inicio, job.data_fim, job.cod_cliente || null,
              job.centro_custo || null, resultado.total, resultado.no_prazo,
              resultado.fora_prazo, resultado.sem_dados, resultado.pct_no_prazo,
              JSON.stringify(resultado.registros)]);

          await _pool.query(`UPDATE performance_jobs SET status = 'concluido', concluido_em = NOW(), total_os = $1 WHERE id = $2`,
            [resultado.total, job.id]);
          log(`✅ Job #${job.id} concluído — ${resultado.total} OS`);
        } else {
          await _pool.query(`UPDATE performance_jobs SET status = 'erro', erro = $1, concluido_em = NOW() WHERE id = $2`,
            [resultado?.error || 'Falha desconhecida', job.id]);
          log(`❌ Job #${job.id} falhou: ${resultado?.error}`);
        }
      }
    } catch (err) {
      log(`❌ BATCH falhou: ${err.message}`);
      await _pool.query(`UPDATE performance_jobs SET status = 'erro', erro = $1, concluido_em = NOW() WHERE id = ANY($2)`,
        [err.message, ids]);
    }
  }

  executando = false;
  executandoDesde = null;
}

// Inicia o worker
function startPerformanceWorker(pool) {
  _pool = pool;
  if (workerAtivo) return;
  workerAtivo = true;

  async function tick() {
    try {
      await processarProximo();
    } catch (err) {
      log(`❌ Tick erro: ${err.message}`);
    } finally {
      setTimeout(tick, INTERVALO_MS);
    }
  }

  // ── CRON: execução automática a cada 1h em horário comercial (8h–19h) ──
  async function cronHorarioComercial() {
    try {
      const agora = new Date();
      // Usar horário de Brasília (UTC-3)
      const brasilHora = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const hora = brasilHora.getHours();
      const diaSemana = brasilHora.getDay(); // 0=dom, 6=sab

      // Só dias úteis (seg-sáb) entre 8h e 19h
      if (diaSemana === 0 || hora < 8 || hora >= 19) {
        return;
      }

      // Buscar configs ativas
      const { rows: configs } = await _pool.query(
        'SELECT * FROM performance_config WHERE ativo = true'
      ).catch(() => ({ rows: [] }));

      if (configs.length === 0) return;

      const hoje = brasilHora.toISOString().slice(0, 10);
      log(`🕐 Cron horário comercial (${hora}h) — ${configs.length} clientes configurados`);

      let criados = 0;
      for (const cfg of configs) {
        // Verificar se já tem job pendente/executando pra esse cliente hoje
        const { rows: existente } = await _pool.query(`
          SELECT id FROM performance_jobs
          WHERE data_inicio = $1 AND data_fim = $1
            AND status IN ('pendente', 'executando')
            AND (cod_cliente = $2 OR ($2 IS NULL AND cod_cliente IS NULL))
            AND (centro_custo = $3 OR ($3 IS NULL AND centro_custo IS NULL))
          LIMIT 1
        `, [hoje, cfg.cod_cliente || null, cfg.centro_custo || null]);

        if (existente.length > 0) continue; // já tem job ativo

        await _pool.query(`
          INSERT INTO performance_jobs (data_inicio, data_fim, cod_cliente, centro_custo, status, origem)
          VALUES ($1, $1, $2, $3, 'pendente', 'cron')
        `, [hoje, cfg.cod_cliente || null, cfg.centro_custo || null]);
        criados++;
      }

      if (criados > 0) log(`🕐 Cron: ${criados} jobs criados para ${hoje}`);
    } catch (err) {
      log(`❌ Cron erro: ${err.message}`);
    }
  }

  // Primeiro tick 15s após boot
  setTimeout(tick, 15_000);

  // Cron: verificar a cada 60 minutos
  setInterval(cronHorarioComercial, 60 * 60 * 1000);
  // Primeira verificação 30s após boot
  setTimeout(cronHorarioComercial, 30_000);

  log('🟢 Worker iniciado (jobs manuais 30s + cron horário comercial 1h)');
}

module.exports = { startPerformanceWorker };
