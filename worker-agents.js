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
// Pré-carrega playwright-sla-capture aqui, antes de qualquer outro módulo do agent.
// Garante que o módulo esteja 100% no cache quando os agentes fizerem require
// (via lazy getter ou sla-capture-api), eliminando o carregamento parcial
// que causava "coletarOsEmExecucao is not a function".
require('./src/modules/agent/playwright-sla-capture');
const { initAgentTables, startAgentWorker, getPoolSnapshot } = require('./src/modules/agent');

// 🧹 Cleanup periódico de /tmp (profiles órfãos do Chromium + screenshots antigos)
// Necessário pra prevenir o vazamento de /tmp que causa "Target page, context or
// browser has been closed" depois de ~5h de runtime.
const { iniciarCleanupPeriodico, rodarCicloLimpeza } = require('./src/shared/tmp-cleanup');

// 🛡️ Memory watchdog — failsafe último-recurso. Se RSS passar de 1.5GB
// sustentadamente, força restart graceful (Railway sobe nova instância).
const { iniciarMemoryWatchdog } = require('./src/shared/memory-watchdog');

const HTTP_PORT = Number(process.env.PORT || 8080);

// Estado pra health check
let _poolIniciado = false;

// ─── HTTP server (status + health) ───────────────────────────────
function iniciarHttpServer() {
  const server = http.createServer((req, res) => {
    // CORS básico — permite chamar do centraltutts.online
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      // 🆕 v5 (2026-05-27): exceção pro POST /agents/restart (endpoint cai no handler abaixo).
      // Sem isso, o early-return 405 mata o request antes dele chegar na rota.
      if (req.method === 'POST' && req.url === '/agents/restart') {
        // segue pro handler do /agents/restart (linha ~238)
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'method not allowed' }));
        return;
      }
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

    // ── /health/agents — health agregado pra dashboards e Railway healthcheck ──
    // 🔧 v3 (2026-05-26 FIX): retorna 200 durante startup window (60s) mesmo
    // com pool não iniciado. Antes (v2) retornava 503 nos primeiros 10-30s e
    // o Railway healthcheck falhava → deploy revertido.
    //
    // Critérios de "crítico" (HTTP 503):
    //   - uptime > 60s E pool ainda não iniciado (algo travou)
    //   - RSS > KILL_LIMIT
    //   - Algum agente com >5 falhas consecutivas
    if (req.url === '/health/agents') {
      try {
        const mem = process.memoryUsage();
        const fmtMB = b => Math.round(b / 1024 / 1024);
        const uptimeSeg = Math.round(process.uptime());

        // 🔧 v3: grace period de 60s no startup
        const startupGrace = uptimeSeg < 60;
        const poolPronto = _poolIniciado;

        // Se ainda tá no startup, devolve 200 "starting" SEM tentar fazer snapshot
        // (que pode falhar se pool não iniciou)
        if (startupGrace && !poolPronto) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            status: 'starting',
            timestamp: new Date().toISOString(),
            uptime_seg: uptimeSeg,
            mensagem: `Aguardando inicialização do pool (${uptimeSeg}s/60s grace)`,
            memoria: {
              rss_mb: fmtMB(mem.rss),
              heap_used_mb: fmtMB(mem.heapUsed),
              heap_total_mb: fmtMB(mem.heapTotal),
            },
            pool: { iniciado: false },
          }, null, 2));
          return;
        }

        // Pool deve estar pronto a essa altura — se não está após 60s, é crítico
        let snap;
        try {
          snap = getPoolSnapshot();
        } catch (e) {
          // Snapshot falhou — provavelmente pool nem iniciou
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            status: 'critical',
            timestamp: new Date().toISOString(),
            uptime_seg: uptimeSeg,
            erro: `getPoolSnapshot falhou: ${e.message}`,
            memoria: { rss_mb: fmtMB(mem.rss) },
          }, null, 2));
          return;
        }

        // Coleta resumo por agente
        // 🔧 v4 (2026-05-26 FIX): nomes dos campos de stats batem com o agent-pool
        // (era ticksOk/ticksErr, mas no agent-pool é ticksComSucesso/ticksComErro)
        const agentesResumo = (snap.agentes || []).map(a => {
          const stats = a.stats || {};
          const ticksOk = stats.ticksComSucesso || 0;
          const ticksErr = stats.ticksComErro || 0;
          const totalTicks = ticksOk + ticksErr;
          const taxaErro = totalTicks > 0
            ? Math.round(ticksErr / totalTicks * 100)
            : 0;
          return {
            nome: a.nome,
            ativo: a.ativo,
            slotsAtivos: a.slotsAtivos,
            slots: a.slots,
            ticksOk,
            ticksErr,
            ticksTotais: stats.ticksTotais || 0,
            ticksTimeout: stats.ticksComTimeout || 0,
            taxaErroPct: taxaErro,
            ultimaExecucao: stats.ultimoTickEm || null,
            ultimoErroEm: stats.ultimoErroEm || null,
            ultimoErroMsg: stats.ultimoErroMsg || null,
            iniciadoEm: stats.iniciadoEm || null,
          };
        });

        // Detecta agentes com problema (>50% erro E pelo menos 5 falhas)
        const agentesProblema = agentesResumo.filter(a =>
          a.taxaErroPct > 50 && a.ticksErr >= 5
        );

        // Status geral — só é crítico se uptime>60s E pool não iniciou, OU RSS estourou
        const critico = (uptimeSeg > 60 && !poolPronto) || fmtMB(mem.rss) > 1700;
        const degradado = agentesProblema.length > 0 || fmtMB(mem.rss) > 1400;

        const statusGeral = critico ? 'critical' : (degradado ? 'degraded' : 'healthy');
        const statusCode = critico ? 503 : 200;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: !critico,
          status: statusGeral,
          timestamp: new Date().toISOString(),
          uptime_seg: uptimeSeg,
          memoria: {
            rss_mb: fmtMB(mem.rss),
            heap_used_mb: fmtMB(mem.heapUsed),
            heap_total_mb: fmtMB(mem.heapTotal),
            limites: { warn_mb: 1400, kill_mb: 1700 },
          },
          pool: {
            iniciado: poolPronto,
            browser_pool: snap.browserPool,
          },
          agentes: {
            total: agentesResumo.length,
            ativos: agentesResumo.filter(a => a.ativo).length,
            com_problema: agentesProblema.length,
            problemas: agentesProblema.map(a => ({
              nome: a.nome,
              taxa_erro_pct: a.taxaErroPct,
              ultimo_erro: a.ultimoErro,
            })),
            detalhes: agentesResumo,
          },
        }, null, 2));
      } catch (e) {
        // 🔧 v3: em caso de exceção inesperada, retorna 200 com status "error"
        // pra NÃO fazer Railway restart o serviço — erros aqui são bugs do health,
        // não do worker em si.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          status: 'error',
          erro: e.message,
          uptime_seg: Math.round(process.uptime()),
        }));
      }
      return;
    }

    // ── POST /agents/restart — restart graceful via process.exit ──
    // 🆕 v4 (2026-05-26): permite UI disparar restart sem precisar Railway API.
    // O process.exit(0) faz Railway recriar o container em ~10-30s.
    //
    // Segurança: requer header X-Restart-Token que deve bater com env
    // AGENTS_RESTART_TOKEN. Se a env não estiver setada, endpoint retorna 503
    // (impede restart sem config explícita).
    if (req.url === '/agents/restart' && req.method === 'POST') {
      const tokenEsperado = process.env.AGENTS_RESTART_TOKEN;
      if (!tokenEsperado) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          erro: 'AGENTS_RESTART_TOKEN não configurado no worker',
        }));
        return;
      }
      const tokenRecebido = req.headers['x-restart-token'];
      if (tokenRecebido !== tokenEsperado) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Token inválido' }));
        return;
      }

      // Coleta corpo (se enviado — opcional, pra log)
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let solicitante = 'desconhecido';
        try {
          const data = body ? JSON.parse(body) : {};
          solicitante = data.solicitante || 'desconhecido';
        } catch (_) {}

        logger.warn(`🔄 [agents/restart] Restart solicitado por: ${solicitante}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          mensagem: 'Restart em andamento — container vai subir nova instância em segundos',
          solicitante,
        }));

        // Pequeno delay pra resposta sair antes do exit
        setTimeout(() => {
          logger.warn(`🔄 [agents/restart] process.exit(0) — Railway vai recriar container`);
          process.exit(0);
        }, 500);
      });
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

    // ── /diagnostico-tmp — visão de /tmp e memória do worker ────
    // Útil pra diagnosticar vazamentos sem precisar de shell no Railway.
    // Lista profiles do Chromium em /tmp + uso de memória do processo.
    if (req.url === '/diagnostico-tmp' || req.url === '/diag') {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const TMP = os.tmpdir();

        const padroes = [
          /^playwright_chromiumdev_/,
          /^\.org\.chromium\.Chromium\./,
        ];

        let nomes = [];
        try { nomes = fs.readdirSync(TMP); } catch {}

        const profiles = [];
        for (const n of nomes) {
          if (!padroes.some(re => re.test(n))) continue;
          const full = path.join(TMP, n);
          try {
            const st = fs.statSync(full);
            profiles.push({
              nome: n,
              isDir: st.isDirectory(),
              idadeMin: Math.round((Date.now() - st.mtimeMs) / 60000),
              tamanhoBytes: st.size,
            });
          } catch {}
        }
        profiles.sort((a, b) => a.idadeMin - b.idadeMin);

        const mem = process.memoryUsage();
        const fmtMB = b => Math.round(b / 1024 / 1024) + ' MB';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          memoria: {
            rss: fmtMB(mem.rss),
            heapTotal: fmtMB(mem.heapTotal),
            heapUsed: fmtMB(mem.heapUsed),
            external: fmtMB(mem.external),
          },
          profilesPlaywright: {
            quantidade: profiles.length,
            maisAntigosPrimeiro: profiles.slice().sort((a,b) => b.idadeMin - a.idadeMin).slice(0, 10),
            maisRecentesPrimeiro: profiles.slice(0, 10),
          },
          uptime: Math.round(process.uptime()) + 's',
        }, null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return;
    }

    // ── /diagnostico-tmp/limpar — força ciclo de cleanup agora ──
    // Útil pra liberar /tmp manualmente sem esperar o cron.
    if (req.url === '/diagnostico-tmp/limpar') {
      try {
        const resultado = rodarCicloLimpeza();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, resultado }, null, 2));
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
          <li><a href="/diagnostico-tmp">/diagnostico-tmp</a> — memória + profiles em /tmp</li>
          <li><a href="/diagnostico-tmp/limpar">/diagnostico-tmp/limpar</a> — força cleanup agora</li>
        </ul>
      `);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'not found' }));
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    logger.info(`🌐 HTTP server escutando em :${HTTP_PORT}`);
    logger.info(`   GET /healthz              → health check`);
    logger.info(`   GET /pool/status          → snapshot do pool`);
    logger.info(`   GET /diagnostico-tmp      → memória + profiles em /tmp`);
    logger.info(`   GET /diagnostico-tmp/limpar → força cleanup agora`);
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

  // 4.1. Cleanup periódico de /tmp — evita que profiles do Chromium
  // acumulem e estourem disco. Roda 1x agora + a cada 30 min.
  // 🔧 v2 (2026-05-25): intervalo reduzido de 30min → 5min pra prevenir
  // acúmulo de /tmp entre ciclos. Cada ciclo é leve (~50-200ms) e barato.
  // Combinado com IDADE_MIN_MS=3min, garante que /tmp nunca acumula >8min de profiles.
  iniciarCleanupPeriodico(5 * 60 * 1000);

  // 4.2. Memory watchdog — failsafe último-recurso. Se a memória passar
  // de 1.5GB sustentadamente (3 verificações), faz restart graceful.
  // Tenta parar o pool primeiro pra não deixar jobs órfãos.
  iniciarMemoryWatchdog(async () => {
    try {
      const agentPool = require('./src/modules/agent')._agentPool;
      if (agentPool && agentPool.stopAll) {
        await agentPool.stopAll();
        logger.info('✅ Pool parado (watchdog)');
      }
    } catch (e) {
      logger.warn(`⚠️ stopAll falhou no watchdog: ${e.message}`);
    }
  });

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
