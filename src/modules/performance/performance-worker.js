/**
 * performance-worker.js — v4
 * Processa jobs de performance (manuais + cron automático).
 * Timeout de 5min por job — nunca trava.
 * Auto-limpeza de jobs travados há > 10min.
 * Verifica fila a cada 30s (leve, só um SELECT).
 * Cron automático em 3 horários fixos em dias úteis (seg-sex):
 *   10:10, 14:00, 17:10 (horário de Brasília).
 * Antes rodava 1x/hora 8h-19h (até 11 disparos/dia). Redução ~73%.
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

  // ── CRON: execução automática em 3 horários exatos (10:10, 14:00, 17:10), seg-sex ──
  // Antes: setInterval a cada 1h entre 8h-19h seg-sáb (até 11 disparos/dia).
  // Agora: 3 disparos/dia em dias úteis — reduz carga de Playwright sem perder cobertura.
  // Usa setTimeout recalculado em vez de setInterval pra ser robusto a reboot/crash:
  // no boot ou após cada execução, agenda o próximo horário correto.
  const HORARIOS_CRON = [
    { h: 10, m: 10 },
    { h: 14, m:  0 },
    { h: 17, m: 10 },
  ];

  // Calcula o próximo disparo a partir de "agora", em horário de Brasília.
  // Se passou dos 3 horários hoje, pula pro 10:10 do próximo dia útil (seg-sex).
  // Retorna Date em UTC (internal) + label pra log.
  function calcularProximaExecucao() {
    const agoraUtc = new Date();
    // Representação em Brasília (string) → Date com os componentes de Brasília.
    const brasilStr = agoraUtc.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
    const brasilAgora = new Date(brasilStr);

    // Função auxiliar: monta uma Date representando "Y-M-D H:M em Brasília" como UTC real.
    // Como brasilAgora é uma Date "fake" (components = Brasília mas tz local), converter pra UTC
    // precisa somar o offset entre brasilAgora e agoraUtc.
    const offsetMs = brasilAgora.getTime() - agoraUtc.getTime();

    function brasilDateParaUtc(ano, mes, dia, hora, minuto) {
      // Monta como se fosse local, depois compensa o offset descoberto.
      const local = new Date(ano, mes, dia, hora, minuto, 0, 0);
      return new Date(local.getTime() - offsetMs);
    }

    // Tenta hoje primeiro, depois avança 1 dia de cada vez até achar dia útil + horário futuro.
    for (let deltaDias = 0; deltaDias < 7; deltaDias++) {
      const alvo = new Date(brasilAgora);
      alvo.setDate(alvo.getDate() + deltaDias);
      const diaSemana = alvo.getDay(); // 0=dom, 6=sab

      // Só dia útil (seg-sex).
      if (diaSemana === 0 || diaSemana === 6) continue;

      for (const { h, m } of HORARIOS_CRON) {
        const dispUtc = brasilDateParaUtc(alvo.getFullYear(), alvo.getMonth(), alvo.getDate(), h, m);
        if (dispUtc.getTime() > agoraUtc.getTime()) {
          const label = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} de ${alvo.getDate().toString().padStart(2, '0')}/${(alvo.getMonth() + 1).toString().padStart(2, '0')}`;
          return { quando: dispUtc, label };
        }
      }
    }
    // Fallback improvável: 1 dia à frente.
    return { quando: new Date(agoraUtc.getTime() + 24 * 60 * 60 * 1000), label: 'fallback +24h' };
  }

  // Dispara a criação de jobs pra hoje (os que ainda não existem).
  async function dispararCronHorario() {
    try {
      const { rows: configs } = await _pool.query(
        'SELECT * FROM performance_config WHERE ativo = true'
      ).catch(() => ({ rows: [] }));

      if (configs.length === 0) {
        log('🕐 Cron disparou, mas não há clientes configurados');
        return;
      }

      // "Hoje" em Brasília — pra garantir que data_inicio/data_fim batem com a visão do usuário.
      const brasilStr = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
      const hoje = new Date(brasilStr).toISOString().slice(0, 10);

      log(`🕐 Cron disparado — ${configs.length} cliente(s) configurado(s)`);

      let criados = 0;
      for (const cfg of configs) {
        // Evita duplicar se já tem job pendente/executando pro mesmo cliente hoje.
        const { rows: existente } = await _pool.query(`
          SELECT id FROM performance_jobs
          WHERE data_inicio = $1 AND data_fim = $1
            AND status IN ('pendente', 'executando')
            AND (cod_cliente = $2 OR ($2 IS NULL AND cod_cliente IS NULL))
            AND (centro_custo = $3 OR ($3 IS NULL AND centro_custo IS NULL))
          LIMIT 1
        `, [hoje, cfg.cod_cliente || null, cfg.centro_custo || null]);

        if (existente.length > 0) continue;

        await _pool.query(`
          INSERT INTO performance_jobs (data_inicio, data_fim, cod_cliente, centro_custo, status, origem)
          VALUES ($1, $1, $2, $3, 'pendente', 'cron')
        `, [hoje, cfg.cod_cliente || null, cfg.centro_custo || null]);
        criados++;
      }

      if (criados > 0) log(`🕐 Cron: ${criados} job(s) criado(s) para ${hoje}`);
      else log(`🕐 Cron: nenhum job novo (todos já tinham pendente/executando)`);
    } catch (err) {
      log(`❌ Cron erro: ${err.message}`);
    }
  }

  // Agenda o próximo disparo via setTimeout. Após disparar, se reagenda.
  // Robusto a reboot: se o processo reiniciar, recalcula do zero no boot.
  function agendarProximoDisparo() {
    const { quando, label } = calcularProximaExecucao();
    const emMs = Math.max(quando.getTime() - Date.now(), 1000);
    const emMin = Math.round(emMs / 60000);
    log(`🕐 Próximo cron agendado para ${label} (em ${emMin} min)`);

    setTimeout(async () => {
      await dispararCronHorario();
      agendarProximoDisparo();
    }, emMs);
  }

  // Primeiro tick de jobs (fila) 15s após boot.
  setTimeout(tick, 15_000);

  // Inicia o ciclo de disparos agendados.
  agendarProximoDisparo();

  log('🟢 Worker iniciado (fila 30s + cron 3x/dia em dias úteis: 10:10, 14:00, 17:10)');
}

module.exports = { startPerformanceWorker };
