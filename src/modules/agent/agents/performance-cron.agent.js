/**
 * agents/performance-cron.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Cria jobs automáticos de performance 3x/dia em dias úteis.
 * Substitui parte do `performance-worker.js` antigo (a parte de cron).
 *
 * NÃO usa Playwright — só insere registros em performance_jobs.
 * O processamento real é feito por performance.agent.js.
 *
 * NOTA: tem 3 horários (10:10, 14:00, 17:10), e defineAgent suporta só 1
 * cronExpression. Solução: cron expression "10 10,17 * * 1-5" + "0 14 * * 1-5"
 * não dá pra ter 2 expressions. Então usamos uma expressão composta:
 *   "10 10 * * 1-5"  → 10:10
 *   "0 14 * * 1-5"   → 14:00
 *   "10 17 * * 1-5"  → 17:10
 *
 * Cron suporta múltiplos minutos no mesmo padrão de hora, mas como os
 * minutos diferem entre 10:10/14:00/17:10, usamos a expressão consolidada:
 *   "10 10 * * 1-5,0 14 * * 1-5,10 17 * * 1-5" — NÃO é cron padrão.
 *
 * Workaround: 3 agentes registrados (1 por horário). Aceitável porque é
 * só agendamento (não usa pool de browser).
 *
 * Alternativa mais limpa: cron "[*]/30 8-18 * * 1-5" + filtro interno por horário.
 * Decisão: usar 3 agentes pra ficar explícito.
 */

'use strict';

const { defineAgent } = require('../core/agent-base');

async function dispararCronHorario(pool, ctx) {
  try {
    const { rows: configs } = await pool.query(
      'SELECT * FROM performance_config WHERE ativo = true'
    ).catch(() => ({ rows: [] }));

    if (configs.length === 0) {
      ctx.log('🕐 Cron disparou, mas não há clientes configurados');
      return;
    }

    // "Hoje" em Brasília — pra garantir que data_inicio/data_fim batem
    const brasilStr = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
    const hoje = new Date(brasilStr).toISOString().slice(0, 10);

    ctx.log(`🕐 Cron disparado — ${configs.length} cliente(s) configurado(s)`);

    let criados = 0;
    for (const cfg of configs) {
      const { rows: existente } = await pool.query(`
        SELECT id FROM performance_jobs
        WHERE data_inicio = $1 AND data_fim = $1
          AND status IN ('pendente', 'executando')
          AND (cod_cliente = $2 OR ($2 IS NULL AND cod_cliente IS NULL))
          AND (centro_custo = $3 OR ($3 IS NULL AND centro_custo IS NULL))
        LIMIT 1
      `, [hoje, cfg.cod_cliente || null, cfg.centro_custo || null]);

      if (existente.length > 0) continue;

      await pool.query(`
        INSERT INTO performance_jobs (data_inicio, data_fim, cod_cliente, centro_custo, status, origem)
        VALUES ($1, $1, $2, $3, 'pendente', 'cron')
      `, [hoje, cfg.cod_cliente || null, cfg.centro_custo || null]);
      criados++;
    }

    if (criados > 0) ctx.log(`🕐 ${criados} job(s) criado(s) para ${hoje}`);
    else ctx.log('🕐 Nenhum job novo (todos já tinham pendente/executando)');
  } catch (err) {
    ctx.log(`❌ Cron erro: ${err.message}`);
  }
}

// Exporta um array de agentes — um por horário (10:10, 14:00, 17:10)
const horarios = [
  { hora: 10, min: 10, suffix: '1010' },
  { hora: 14, min: 0,  suffix: '1400' },
  { hora: 17, min: 10, suffix: '1710' },
];

module.exports = horarios.map(({ hora, min, suffix }) => defineAgent({
  nome: `performance-cron-${suffix}`,
  slots: 1,
  sessionStrategy: null,                      // não usa Playwright
  cronExpression: `${min} ${hora} * * 1-5`,   // dias úteis (seg-sex)
  timezone: 'America/Bahia',                  // mesmo TZ do worker antigo

  tickGlobal: dispararCronHorario,
}));
