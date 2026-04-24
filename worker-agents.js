/**
 * Tutts Backend - worker-agents.js
 * ─────────────────────────────────────────────────────────────────────────
 * Processo separado para os agentes Playwright (RPA + SLA capture + detector).
 * Não serve HTTP — só executa o agent-pool.
 *
 * DEPLOY:
 *   Railway → New Service → mesma config do tutts-backend
 *   Start Command: node worker-agents.js
 *   Env vars: copiar do serviço principal + adicionar:
 *     AGENTS_WORKER_SEPARADO=true   (no serviço principal — desativa agentes lá)
 *     AGENTS_RUN_HERE=true          (neste worker — ativa agentes aqui)
 *     SLA_CAPTURE_ATIVO=true
 *     SLA_DETECTOR_ATIVO=true
 *     BROWSER_POOL_SIZE=3
 *     POOL_SLA_CAPTURE_SLOTS=3
 *     POOL_AGENT_CORRECAO_SLOTS=2
 *     SISTEMA_EXTERNO_EMAIL_1, SISTEMA_EXTERNO_SENHA_1  (conta 1)
 *     SISTEMA_EXTERNO_EMAIL_2, SISTEMA_EXTERNO_SENHA_2  (conta 2)
 *     SISTEMA_EXTERNO_EMAIL_3, SISTEMA_EXTERNO_SENHA_3  (conta 3)
 *     SISTEMA_EXTERNO_SLA_EMAIL_1, SISTEMA_EXTERNO_SLA_SENHA_1  (conta SLA 1)
 *     ...etc
 */

'use strict';

// Sinaliza que ESTE processo é onde os agentes devem rodar
process.env.AGENTS_RUN_HERE = 'true';

const { pool, testConnection } = require('./src/config/database');
const { logger } = require('./src/config/logger');
const { initAgentTables, startAgentWorker, getPoolSnapshot } = require('./src/modules/agent');

async function main() {
  logger.info('🚀 worker-agents iniciando...');

  // 1. Testa conexão com o banco
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('❌ Falha ao conectar no banco — saindo');
    process.exit(1);
  }
  logger.info('✅ Banco conectado');

  // 2. Garante tabelas (idempotente)
  try {
    await initAgentTables(pool);
    logger.info('✅ Tabelas verificadas');
  } catch (e) {
    logger.error(`❌ Falha em initAgentTables: ${e.message}`);
    // Continua mesmo assim — tabelas podem já existir
  }

  // 3. Inicia o pool de agentes
  startAgentWorker(pool);

  // 4. Health snapshot a cada 60s no log
  setInterval(() => {
    const snap = getPoolSnapshot();
    const linhas = snap.agentes.map(a =>
      `${a.nome}: ${a.slotsAtivos}/${a.slots} ativo, ` +
      `ticks=${a.stats.ticksTotais} (ok=${a.stats.ticksComSucesso}, err=${a.stats.ticksComErro})`
    );
    logger.info(`📊 Pool snapshot:\n  ${linhas.join('\n  ')}\n  Browser pool: ${snap.browserPool.slots.filter(s => !s.livre).length}/${snap.browserPool.poolSize} ocupados`);
  }, 60_000);

  logger.info('✅ worker-agents pronto');
}

// Graceful shutdown
async function shutdown(sinal) {
  logger.info(`🛑 ${sinal} recebido — iniciando shutdown gracioso (até 30s)...`);
  try {
    const agentPool = require('./src/modules/agent')._agentPool;
    await agentPool.stopAll();
    logger.info('✅ Pool parou. Encerrando.');
  } catch (e) {
    logger.error(`⚠️ Erro no shutdown: ${e.message}`);
  }
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error(`💥 uncaughtException: ${err.message}\n${err.stack}`);
  // Não sai — o pool continua. Railway vai restart se ficar realmente quebrado.
});
process.on('unhandledRejection', (reason) => {
  logger.error(`💥 unhandledRejection: ${reason}`);
});

main().catch(err => {
  logger.error(`💥 main() falhou: ${err.message}\n${err.stack}`);
  process.exit(1);
});
