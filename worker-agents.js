/**
 * Tutts Backend - worker-agents.js (v2 - com HTTP server)
 * ─────────────────────────────────────────────────────────────────────────
 * Processo separado para os agentes Playwright (RPA + SLA capture + detector).
 * Roda HTTP server mínimo pra expor status e health check.
 *
 * ENDPOINTS HTTP:
 *   GET /healthz       — health check Railway (200 se pool ativo)
 *   GET /pool/status   — snapshot completo dos agentes e browser-pool
 *
 * DEPLOY:
 *   Railway → New Service → mesma config do tutts-backend
 *   Start Command: node worker-agents.js
 *   Settings → Networking → Generate Domain (pra acessar HTTP de fora)
 *   Settings → Healthcheck Path: /healthz
 *
 *   Env vars: copiar do serviço principal + adicionar:
 *     AGENTS_WORKER_SEPARADO=true   (no serviço principal — desativa agentes lá)
 *     AGENTS_RUN_HERE=true          (neste worker — ativa agentes aqui)
 *     SLA_CAPTURE_ATIVO=true
 *     SLA_DETECTOR_ATIVO=true
 *     BROWSER_POOL_SIZE=3
 *     POOL_SLA_CAPTURE_SLOTS=3
 *     POOL_AGENT_CORRECAO_SLOTS=2
 *     PORT=8080  (Railway define automaticamente)
 *     SISTEMA_EXTERNO_EMAIL_1, SISTEMA_EXTERNO_SENHA_1  (conta 1)
 *     ...
 */

'use strict';

// Sinaliza que ESTE processo é onde os agentes devem rodar
process.env.AGENTS_RUN_HERE = 'true';

const http = require('http');
const { pool, testConnection } = require('./src/config/database');
const { logger } = require('./src/config/logger');
const { initAgentTables, startAgentWorker, getPoolSnapshot } = require('./src/modules/agent');

const HTTP_PORT = Number(process.env.PORT || 8080);

// Estado pra health check
let _poolIniciado = false;

// ─── HTTP server (status + health) ───────────────────────────────
function iniciarHttpServer() {
  const server = http.createServer((req, res) => {
    // CORS básico — permite chamar do centraltutts.online
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'method not allowed' }));
      return;
    }

    // ── /healthz — health check do Railway ──────────────────
    // 200 se o pool está rodando; 503 se ainda não inicializou ou crashou
    if (req.url === '/healthz' || req.url === '/health') {
      if (_poolIniciado) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'healthy' }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 'starting' }));
      }
      return;
    }

    // ── /pool/status — snapshot completo ────────────────────
    if (req.url === '/pool/status' || req.url === '/status') {
      try {
        const snap = getPoolSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, snapshot: snap }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return;
    }

    // ── / — landing page simples ────────────────────────────
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <h1>tutts-agents</h1>
        <p>Worker de agentes Playwright em execução.</p>
        <ul>
          <li><a href="/pool/status">/pool/status</a> — snapshot do pool</li>
          <li><a href="/healthz">/healthz</a> — health check</li>
        </ul>
      `);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'not found' }));
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    logger.info(`🌐 HTTP server escutando em :${HTTP_PORT}`);
    logger.info(`   GET /healthz       → health check`);
    logger.info(`   GET /pool/status   → snapshot do pool`);
  });

  server.on('error', (err) => {
    logger.error(`❌ HTTP server error: ${err.message}`);
  });

  return server;
}

async function main() {
  logger.info('🚀 worker-agents iniciando...');

  // 1. Sobe HTTP server JÁ (pra Railway poder fazer health check enquanto inicializa)
  iniciarHttpServer();

  // 2. Testa conexão com o banco
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('❌ Falha ao conectar no banco — saindo');
    process.exit(1);
  }
  logger.info('✅ Banco conectado');

  // 3. Garante tabelas (idempotente)
  try {
    await initAgentTables(pool);
    logger.info('✅ Tabelas verificadas');
  } catch (e) {
    logger.error(`❌ Falha em initAgentTables: ${e.message}`);
    // Continua mesmo assim — tabelas podem já existir
  }

  // 4. Inicia o pool de agentes
  startAgentWorker(pool);
  _poolIniciado = true;

  // 5. Health snapshot a cada 60s no log
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
  _poolIniciado = false;
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
