/**
 * Tutts Backend - server.js
 * Orchestrator: configura, monta e inicia o servidor
 * Nenhuma lógica de negócio aqui — só wiring
 */

const express = require('express');
const http = require('http');
const dns = require('dns');
const cron = require('node-cron');
const cookieParser = require('cookie-parser');

// ─── Config ───────────────────────────────────────────────
const env = require('./src/config/env');
const { pool, testConnection } = require('./src/config/database');
const { logger } = require('./src/config/logger');
const { setupCors } = require('./src/config/cors');
const helmetConfig = require('./src/config/helmet');
const { additionalSecurityHeaders } = require('./src/config/helmet');
const { setupWebSocket, registerGlobals } = require('./src/config/websocket');

// ─── Middleware ────────────────────────────────────────────
const { verificarToken, verificarAdmin, verificarAdminOuFinanceiro } = require('./src/middleware/auth');
const { getClientIP, apiLimiter, loginLimiter, createAccountLimiter } = require('./src/middleware/rateLimiter');
const { notFoundHandler, globalErrorHandler } = require('./src/middleware/errorHandler');
const requestLogger = require('./src/middleware/requestLogger');
const { sanitizeInput } = require("./src/middleware/inputSanitizer");
const { verificarWebhookSignature, webhookBasicValidation } = require("./src/middleware/webhookAuth");
const { verificarCsrf } = require("./src/middleware/csrf");
const { cacheMiddleware, cacheInvalidationMiddleware } = require("./src/middleware/cache");

// ─── Shared ───────────────────────────────────────────────
const { AUDIT_CATEGORIES } = require('./src/shared/constants');
const { createAuditLogger } = require('./src/shared/utils/audit');
const httpRequest = require('./src/shared/utils/httpRequest');

// ─── Modules ──────────────────────────────────────────────
const { initScoreRoutes, initScoreTables, initScoreCron } = require('./src/modules/score');
const { initAuditRoutes, initAuditTables } = require('./src/modules/audit');
const { initCrmRoutes } = require('./src/modules/crm');
const { initSocialRoutes, initSocialTables } = require('./src/modules/social');
const { initOperacionalRoutes, initOperacionalTables } = require('./src/modules/operacional');
const { initLojaRoutes, initLojaTables } = require('./src/modules/loja');
const { initRoteirizadorRoutes, initRoteirizadorTables } = require('./src/modules/roteirizador');
const { initFilasRoutes, initFilasTables } = require('./src/modules/filas');
const { initConfigRoutes, initConfigTables } = require('./src/modules/config');
const { initAuthRoutes, initAuthTables } = require('./src/modules/auth');
const { initDisponibilidadeRoutes, initDisponibilidadeTables } = require('./src/modules/disponibilidade');
const { initFinancialRoutes, initFinancialTables } = require('./src/modules/financial');
const { initSolicitacaoRoutes, initSolicitacaoTables } = require('./src/modules/solicitacao');
const { initBiRoutes, initBiTables } = require('./src/modules/bi');
const { initTodoRoutes, initTodoTables, initTodoCron } = require('./src/modules/todo');
const { initMiscRoutes, initMiscTables } = require('./src/modules/misc');

// ─── Bootstrap ────────────────────────────────────────────
dns.setDefaultResultOrder('ipv4first');

const app = express();
const registrarAuditoria = createAuditLogger(pool);

// ─── Security & parsing ──────────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');

// CORS MUST come first
setupCors(app);

// Helmet (after CORS)
app.use(helmetConfig);

// Rate limiting
app.use('/api/', apiLimiter);

// Request logging
app.use(requestLogger);

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Input sanitization (after body parsing)
app.use(sanitizeInput);
app.use(additionalSecurityHeaders);

// 🔒 CSRF protection (after cookie parsing, before routes)
app.use(verificarCsrf);

// ⚡ Cache middleware (reduz compute hours no Neon)
app.use(cacheMiddleware);
app.use(cacheInvalidationMiddleware);

// ─── Health checks ────────────────────────────────────────
app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', message: 'API funcionando' });
});

app.get('/api/version', (req, res) => {
  res.json({ version: env.SERVER_VERSION, timestamp: new Date().toISOString() });
});

// 🔒 Webhook security (before routes)
app.use("/api/webhook/tutts", webhookBasicValidation, verificarWebhookSignature);
app.use("/api/solicitacao/webhook/tutts", webhookBasicValidation, verificarWebhookSignature);

// ─── Mount modules ────────────────────────────────────────

// Score
app.use('/api/score', initScoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

// Audit
app.use('/api/audit', initAuditRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

// CRM
app.use('/api/crm', verificarToken, initCrmRoutes(pool));

// Social (2 routers)
const { socialRouter, liderancaRouter } = initSocialRoutes(pool);
app.use('/api/social', verificarToken, socialRouter);
app.use('/api/lideranca', verificarToken, liderancaRouter);

// Operacional (3 routers)
const { avisosRouter, incentivosRouter, operacoesRouter } = initOperacionalRoutes(pool);
app.use('/api/avisos-op', verificarToken, avisosRouter);
app.use('/api/incentivos-op', verificarToken, incentivosRouter);
app.use('/api/operacoes', verificarToken, operacoesRouter);
app.get('/api/operacoes-regioes', verificarToken, (req, res, next) => { req.url = '/regioes'; operacoesRouter(req, res, next); });

// Loja
app.use('/api/loja', verificarToken, initLojaRoutes(pool));

// Roteirizador (4 routers)
const { routingRouter, roteirizadorRouter, adminRoteirizadorRouter, geocodeRouter } = initRoteirizadorRoutes(pool, verificarToken, httpRequest, registrarAuditoria, AUDIT_CATEGORIES);
app.use('/api/routing', routingRouter);
app.use('/api/roteirizador', roteirizadorRouter);
app.use('/api/admin/roteirizador/usuarios', adminRoteirizadorRouter);
app.use('/api/geocode', geocodeRouter);

// Filas
app.use('/api/filas', initFilasRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

// Config, Auth, Disponibilidade, Financial, Solicitacao, BI, Todo, Misc
app.use('/api', initConfigRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));
app.use('/api', initAuthRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter));
app.use('/api', initDisponibilidadeRoutes(pool, verificarToken));
app.use('/api', initFinancialRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP));
app.use('/api', initSolicitacaoRoutes(pool, verificarToken));
app.use('/api', initBiRoutes(pool, verificarToken));
app.use('/api', initTodoRoutes(pool, verificarToken));
app.use('/api', initMiscRoutes(pool, verificarToken));

// ─── Error handlers (MUST be last) ───────────────────────
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ─── Database init ────────────────────────────────────────
async function initDatabase() {
  const connected = await testConnection();
  if (!connected) return;

  try {
    await initFinancialTables(pool);
    await initSolicitacaoTables(pool);
    await initAuthTables(pool);
    await initConfigTables(pool);
    await initDisponibilidadeTables(pool);
    await initLojaTables(pool);
    await initBiTables(pool);
    await initTodoTables(pool);
    await initMiscTables(pool);
    await initSocialTables(pool);
    await initOperacionalTables(pool);
    await initScoreTables(pool);
    await initAuditTables(pool);
    console.log('✅ Todas as tabelas verificadas/criadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error.message);
  }
}

// ─── Start server ─────────────────────────────────────────
const server = http.createServer(app);

// WebSocket
setupWebSocket(server);
registerGlobals();

// Init DB then listen
initDatabase().then(() => {
  server.listen(env.PORT, () => {
    logger.info('Servidor iniciado', {
      port: env.PORT,
      version: env.SERVER_VERSION,
      nodeEnv: env.NODE_ENV,
    });

    // Cron jobs
    initTodoCron(pool);
    // Crons: se WORKER_ENABLED=true, crons rodam no worker.js separado
    if (process.env.WORKER_ENABLED === 'true') {
      console.log('⏰ Crons desativados no server (rodando no worker separado)');
    } else {
      initScoreCron(cron, pool);
      console.log('⏰ Crons rodando no server (defina WORKER_ENABLED=true para separar)');
    }
  });
});

// ─── Graceful Shutdown ────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n🛑 ${signal} recebido. Encerrando graciosamente...`);
  
  server.close(async () => {
    console.log('📡 Novas conexões recusadas');
    try {
      await pool.end();
      console.log('🗄️ Pool de conexões encerrado');
    } catch (err) {
      console.error('Erro ao encerrar pool:', err.message);
    }
    console.log('✅ Shutdown completo');
    process.exit(0);
  });

  // Forçar encerramento se demorar mais de 15s
  setTimeout(() => {
    console.error('⚠️ Forçando encerramento após timeout');
    process.exit(1);
  }, 15000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
