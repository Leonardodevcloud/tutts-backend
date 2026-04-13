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

// 🔒 SECURITY FIX (AUDIT-08): Mutex para cron jobs (transaction-level locks)
const { withCronLock, liberarLocksOrfaos } = require('./src/shared/utils/cronMutex');

// ─── Shared ───────────────────────────────────────────────
const { AUDIT_CATEGORIES } = require('./src/shared/constants');
const { createAuditLogger } = require('./src/shared/utils/audit');
const httpRequest = require('./src/shared/utils/httpRequest');

const { createPerformanceIndices } = require('./src/shared/migrations/performance-indices');

// ─── Modules ──────────────────────────────────────────────
const { initScoreRoutes, initScoreTables, initScoreCron } = require('./src/modules/score');
const { initAuditRoutes, initAuditTables } = require('./src/modules/audit');
const { initCrmRoutes, initCrmTables } = require('./src/modules/crm');
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
const { initCsRoutes, initCsTables } = require('./src/modules/cs');
const { initAgentRoutes, initAgentTables, startAgentWorker } = require('./src/modules/agent');
const { initRastreioClientesRoutes, initRastreioClientesTables } = require('./src/modules/rastreio-clientes');
const { initAntiFraudeRoutes, initAntiFraudeTables, startAntiFraudeWorker } = require('./src/modules/antifraude');
const { initPerformanceRoutes, initPerformanceTables, startPerformanceWorker } = require('./src/modules/performance');
const { initGerencialRoutes, initGerencialTables } = require('./src/modules/gerencial');
const { initUberRoutes, initUberTables, startUberWorker } = require('./src/modules/uber');

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
// verify: preserva o rawBody para validação de assinatura de webhooks (Stark Bank, Uber Direct)
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    // Preservar raw body apenas para rotas de webhook (performance)
    if (req.originalUrl && (
      req.originalUrl.includes('/stark/webhook') ||
      req.originalUrl.includes('/uber/webhook')
    )) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
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

// 🔒 SECURITY FIX (AUDIT-10): Rotas de init/overrides extraídas para módulo próprio
const { createBootstrapRoutes } = require('./src/modules/bootstrap/bootstrap.routes');
app.use('/api', createBootstrapRoutes(pool, verificarToken, verificarAdmin, verificarAdminOuFinanceiro));

// ─── Mount modules ────────────────────────────────────────

// Score
app.use('/api/score', initScoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

// Audit
app.use('/api/audit', initAuditRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

// CRM
// 🔒 SECURITY FIX (AUDIT-11): CRM é módulo administrativo
// Aceita JWT (admin) OU chave de serviço (server-to-server do CRM Vercel)
const verificarCrmAuth = (req, res, next) => {
  const serviceKey = req.headers['x-service-key'];
  const expectedKey = process.env.CRM_SERVICE_KEY;
  console.log(`[CRM Auth] key-recebida: ${serviceKey ? serviceKey.substring(0, 10) + '...' : 'NENHUMA'} | key-esperada: ${expectedKey ? expectedKey.substring(0, 10) + '...' : 'NÃO CONFIGURADA'} | match: ${!!(expectedKey && serviceKey === expectedKey)}`);
  if (expectedKey && serviceKey === expectedKey) {
    console.log('[CRM Auth] ✅ Autenticado por service-key');
    return next();
  }
  // Fallback: autenticação JWT normal
  verificarToken(req, res, () => {
    verificarAdmin(req, res, next);
  });
};
app.use('/api/crm', verificarCrmAuth, initCrmRoutes(pool));

// Social (2 routers) — usado por TODOS os usuários (motoboys + admin)
const { socialRouter, liderancaRouter } = initSocialRoutes(pool);
app.use('/api/social', verificarToken, socialRouter);
app.use('/api/lideranca', verificarToken, liderancaRouter);

// Operacional (3 routers)
// ⚠️ avisos-op: motoboys acessam /usuario/:cod — NÃO pode ter verificarAdmin no mount
// incentivos-op e operacoes: admin checks internos nas rotas que precisam
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
// ⚠️ IMPORTANTE: Módulos montados em /api NÃO PODEM ter verificarAdmin no mount!
// Express roda o middleware ANTES de verificar se o router tem rota correspondente.
// Isso bloquearia TODAS as /api/* requests pra não-admin, incluindo módulos posteriores.
// Auth admin deve ser feita DENTRO de cada módulo, no nível da rota individual.
app.use('/api', initConfigRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));
app.use('/api', initAuthRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES, getClientIP, loginLimiter, createAccountLimiter));
app.use('/api', initDisponibilidadeRoutes(pool, verificarToken));
app.use('/api', initFinancialRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, getClientIP));
app.use('/api', initSolicitacaoRoutes(pool, verificarToken));
app.use('/api', initBiRoutes(pool, verificarToken));
app.use('/api', initGerencialRoutes(pool, verificarToken));
app.use('/api', initTodoRoutes(pool, verificarToken));
app.use('/api', initMiscRoutes(pool, verificarToken));

// Sucesso do Cliente (CS) — acesso admin/gestores
// (mapa-calor é público via PUBLIC_PATHS em auth.js)
app.use('/api', verificarToken, initCsRoutes(pool, verificarToken, verificarAdmin));
// ── Screenshots RPA (protegido com auth admin + chave) ──────────────────
const SCREENSHOT_DIR_TMP = '/tmp/screenshots';
// 🔒 SECURITY FIX (CRIT-02): Sem fallback — se não configurar, endpoint fica desativado
const SCREENSHOT_KEY = process.env.SCREENSHOT_KEY || null;

// 🔒 SECURITY FIX: Agora exige admin autenticado + chave forte
app.get('/api/rpa-screenshots', verificarToken, verificarAdmin, (req, res) => {
  if (!SCREENSHOT_KEY) return res.status(503).json({ erro: 'Screenshots desativado. Configure SCREENSHOT_KEY.' });
  if (req.query.key !== SCREENSHOT_KEY) return res.status(403).json({ erro: 'Chave inválida' });
  try {
    const fss = require('fs');
    const pathh = require('path');
    if (!fss.existsSync(SCREENSHOT_DIR_TMP)) return res.type('html').send('<h1>Nenhum screenshot</h1>');
    const files = fss.readdirSync(SCREENSHOT_DIR_TMP).filter(f => f.endsWith('.png')).sort((a, b) => b.localeCompare(a));
    const k = SCREENSHOT_KEY;
    const cards = files.map(f => '<div style="background:#1a1a2e;padding:12px;border-radius:8px;margin:12px 0"><p style="color:#a78bfa;font-size:13px;margin:0 0 8px">' + f + '</p><img src="/api/rpa-screenshots/' + encodeURIComponent(f) + '?key=' + k + '" style="max-width:100%;border-radius:6px" loading="lazy"></div>').join('');
    res.type('html').send('<html><body style="font-family:sans-serif;padding:20px;background:#111;color:#eee"><h1>Screenshots RPA (' + files.length + ')</h1>' + cards + '</body></html>');
  } catch(e) { res.status(500).json({erro:e.message}); }
});

app.get('/api/rpa-screenshots/:filename', verificarToken, verificarAdmin, (req, res) => {
  if (!SCREENSHOT_KEY) return res.status(503).json({ erro: 'Screenshots desativado' });
  if (req.query.key !== SCREENSHOT_KEY) return res.status(403).json({ erro: 'Acesso negado' });
  const fss = require('fs');
  const pathh = require('path');
  // 🔒 SECURITY FIX (CRIT-02b): Sanitizar filename contra path traversal
  const filename = pathh.basename(req.params.filename); // Remove ../ e paths
  if (filename !== req.params.filename || !filename.endsWith('.png')) {
    return res.status(400).json({ erro: 'Nome de arquivo inválido' });
  }
  const file = pathh.join(SCREENSHOT_DIR_TMP, filename);
  // Verificar que o arquivo resolvido está dentro do diretório permitido
  if (!file.startsWith(SCREENSHOT_DIR_TMP)) {
    return res.status(403).json({ erro: 'Acesso negado — path traversal bloqueado' });
  }
  if (!fss.existsSync(file)) return res.status(404).json({ erro: 'Nao encontrada' });
  res.type('image/png').sendFile(file);
});

app.use('/api/agent', verificarToken, initAgentRoutes(pool, verificarToken, verificarAdmin));
app.use('/api/rastreio-clientes', initRastreioClientesRoutes(pool, { verificarToken, verificarAdmin, registrarAuditoria }));
app.use('/api/antifraude', verificarToken, verificarAdmin, initAntiFraudeRoutes(pool, verificarAdmin));
app.use('/api', verificarToken, initPerformanceRoutes(pool, verificarToken));
app.use('/api/uber', initUberRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

// ═══════════════════════════════════════════════════════════════════
// 🔬 DEBUG SLA — temporário pra diagnóstico do detector (2026-04-13)
// ═══════════════════════════════════════════════════════════════════
// GET /_debug/sla-coletar?key=tutts-sla-debug-2026 — chama coletarOsEmExecucao direto
// GET /_debug/sla-tick?key=tutts-sla-debug-2026    — chama detectarOsNovas (tick completo)
// REMOVER DEPOIS QUE CONFIRMAR QUE O PIPELINE ESTÁ FUNCIONANDO
const SLA_DEBUG_KEY = process.env.SLA_DEBUG_KEY || 'tutts-sla-debug-2026';

app.get('/_debug/sla-coletar', async (req, res) => {
  if (req.query.key !== SLA_DEBUG_KEY) {
    return res.status(401).json({ erro: 'key inválida' });
  }
  try {
    const { coletarOsEmExecucao } = require('./src/modules/agent/playwright-sla-capture');
    const t0 = Date.now();
    const resultado = await coletarOsEmExecucao();
    return res.json({
      ok: true,
      duracaoMs: Date.now() - t0,
      resumo: {
        ok: resultado.ok,
        motivo: resultado.motivo,
        totalOrdens: resultado.ordens?.length ?? 0,
        totalEsperado: resultado.totalEsperado,
        paginas: resultado.paginas,
        primeirasOrdens: (resultado.ordens || []).slice(0, 3),
      },
      diag: resultado.diag, // 🔬 diagnóstico completo: etapas + xhrs vistos
    });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message, stack: e.stack });
  }
});

app.get('/_debug/sla-tick', async (req, res) => {
  if (req.query.key !== SLA_DEBUG_KEY) {
    return res.status(401).json({ erro: 'key inválida' });
  }
  try {
    const { detectarOsNovas } = require('./src/modules/agent/sla-detector.service');
    const t0 = Date.now();
    const resultado = await detectarOsNovas(pool);
    return res.json({ ok: true, duracaoMs: Date.now() - t0, resultado });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message, stack: e.stack });
  }
});

// 🔬 Health do container — pra diagnosticar travamentos de Chromium
app.get('/_debug/health', async (req, res) => {
  if (req.query.key !== SLA_DEBUG_KEY) {
    return res.status(401).json({ erro: 'key inválida' });
  }

  const { exec } = require('child_process');
  const util = require('util');
  const execAsync = util.promisify(exec);

  const resultado = {
    timestamp: new Date().toISOString(),
    node: {
      uptime_s: Math.floor(process.uptime()),
      memory_mb: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        external: Math.round(process.memoryUsage().external / 1024 / 1024),
      },
      pid: process.pid,
    },
  };

  try {
    const { stdout } = await execAsync('ps -eo pid,ppid,rss,comm 2>/dev/null | grep -iE "chrom|head" | grep -v grep || true');
    const lines = stdout.trim().split('\n').filter(Boolean);
    resultado.chromium_count = lines.length;
    resultado.chromium_total_rss_mb = lines.reduce((sum, l) => {
      const parts = l.trim().split(/\s+/);
      return sum + (parseInt(parts[2], 10) || 0);
    }, 0) / 1024;
    resultado.chromium_processes = lines.slice(0, 20); // só os 20 primeiros
  } catch (e) {
    resultado.chromium_error = e.message;
  }

  try {
    const { stdout } = await execAsync('df -h /dev/shm 2>/dev/null | tail -1');
    resultado.dev_shm = stdout.trim();
  } catch (e) {}

  try {
    const { stdout } = await execAsync(`ls /proc/${process.pid}/fd 2>/dev/null | wc -l`);
    resultado.open_fds = parseInt(stdout.trim(), 10);
  } catch (e) {}

  try {
    const { stdout } = await execAsync('cat /proc/self/limits 2>/dev/null | grep -E "open files|processes" || echo ""');
    resultado.limits = stdout.trim();
  } catch (e) {}

  try {
    const { stdout } = await execAsync('cat /proc/meminfo 2>/dev/null | head -5');
    resultado.meminfo = stdout.trim();
  } catch (e) {}

  res.json(resultado);
});

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
    try { await initSocialTables(pool); } catch (e) { console.error('⚠️ Social tables error:', e.message); }
    try { await initOperacionalTables(pool); } catch (e) { console.error('⚠️ Operacional tables error:', e.message); }
    try { await initScoreTables(pool); } catch (e) { console.error('⚠️ Score tables error:', e.message); }
    try { await initAuditTables(pool); } catch (e) { console.error('⚠️ Audit tables error:', e.message); }
    try { await initCsTables(pool); } catch (e) { console.error('⚠️ CS tables error:', e.message); }
    try { await initAgentTables(pool); } catch (e) { console.error('⚠️ Agent tables error:', e.message); }
    try { await initRastreioClientesTables(pool); } catch (e) { console.error('⚠️ RastreioClientes tables error:', e.message); }
    try { await initAntiFraudeTables(pool); } catch (e) { console.error('⚠️ Anti-Fraude tables error:', e.message); }
    try { await initPerformanceTables(pool); } catch (e) { console.error('⚠️ Performance tables error:', e.message); }
    try { await initGerencialTables(pool); } catch (e) { console.error('⚠️ Gerencial tables error:', e.message); }
    try { await initCrmTables(pool); } catch (e) { console.error('⚠️ CRM tables error:', e.message); }
    try { await initUberTables(pool); } catch (e) { console.error('⚠️ Uber tables error:', e.message); }
    await createPerformanceIndices(pool);
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
initDatabase().then(async () => {
  server.listen(env.PORT, () => {
    logger.info('Servidor iniciado', {
      port: env.PORT,
      version: env.SERVER_VERSION,
      nodeEnv: env.NODE_ENV,
    });
  });

  // 🧹 Limpar advisory locks órfãos de deploys anteriores
  await liberarLocksOrfaos(pool);

  // Cron jobs
  initTodoCron(pool);
  startAgentWorker(pool);
  startAntiFraudeWorker(pool);
  startPerformanceWorker(pool);
  startUberWorker(pool);
  // Crons: se WORKER_ENABLED=true, crons rodam no worker.js separado
  if (process.env.WORKER_ENABLED === 'true') {
    console.log('⏰ Crons desativados no server (rodando no worker separado)');
  } else {
    // initScoreCron(cron, pool); // 🔒 Desativado — gratuidades do score não são mais aplicadas automaticamente

    // ════════════════════════════════════════════════════════════
    // WhatsApp module — import compartilhado para todos os crons
    // ════════════════════════════════════════════════════════════
    let notificarLoteGerado, notificarResumoDiario;
    try {
      const whatsapp = require('./src/modules/financial/routes/whatsapp.service');
      notificarLoteGerado = whatsapp.notificarLoteGerado;
      notificarResumoDiario = whatsapp.notificarResumoDiario;
      console.log('✅ [Server] WhatsApp module carregado');
    } catch (err) {
      console.warn('⚠️ [Server] WhatsApp module não carregou:', err.message);
      notificarLoteGerado = async () => ({ enviado: false, motivo: 'modulo_indisponivel' });
      notificarResumoDiario = async () => ({ enviado: false, motivo: 'modulo_indisponivel' });
    }

    // ════════════════════════════════════════════════════════════
    // CRON: Preparar lote Stark Bank (a cada 1 hora)
    // Aprova saques com débito OK e marca 'em_lote' para o admin revisar e executar
    // NÃO executa pagamento — apenas prepara o lote
    // ════════════════════════════════════════════════════════════
    const prepararLoteStarkAutomatico = async () => {
      console.log('🏦 [CRON Stark] Verificando saques aguardando pagamento Stark...');
      try {
        const saquesProntos = await pool.query(`
          SELECT w.*
          FROM withdrawal_requests w
          WHERE w.status = 'aguardando_pagamento_stark'
            AND w.debito = true
            AND (w.stark_status IS NULL OR w.stark_status = 'erro')
          ORDER BY w.created_at ASC
        `);

        if (saquesProntos.rows.length === 0) {
          console.log('🏦 [CRON Stark] Nenhum saque pendente');
          return;
        }

        const saques = saquesProntos.rows;
        const valorTotal = saques.reduce((acc, s) => acc + parseFloat(s.final_amount || 0), 0);

        console.log(`🏦 [CRON Stark] ${saques.length} saque(s) encontrado(s) — R$ ${valorTotal.toFixed(2)}`);

        // ═══ FIX: Verificar se já existe lote 'pendente' DE HOJE — reusar ao invés de criar novo ═══
        let loteId;
        const lotePendenteExistente = await pool.query(`
          SELECT id, quantidade, valor_total FROM stark_lotes 
          WHERE status = 'pendente' AND created_at >= CURRENT_DATE
          ORDER BY created_at DESC 
          LIMIT 1
        `);

        if (lotePendenteExistente.rows.length > 0) {
          // Reusar lote pendente existente — acumular saques nele
          loteId = lotePendenteExistente.rows[0].id;
          const qtdAnterior = parseInt(lotePendenteExistente.rows[0].quantidade) || 0;
          const valorAnterior = parseFloat(lotePendenteExistente.rows[0].valor_total) || 0;
          await pool.query(`
            UPDATE stark_lotes 
            SET quantidade = $1, valor_total = $2, updated_at = NOW()
            WHERE id = $3
          `, [qtdAnterior + saques.length, valorAnterior + valorTotal, loteId]);
          console.log(`🏦 [CRON Stark] Reusando lote pendente #${loteId} — adicionando ${saques.length} saque(s)`);
        } else {
          // Criar novo lote
          const loteResult = await pool.query(`
            INSERT INTO stark_lotes (quantidade, valor_total, saldo_antes, status, executado_por_id, executado_por_nome)
            VALUES ($1, $2, 0, 'pendente', 0, 'Sistema (Auto-batch)')
            RETURNING *
          `, [saques.length, valorTotal]);
          loteId = loteResult.rows[0].id;
          console.log(`🏦 [CRON Stark] Novo lote #${loteId} criado`);
        }

        // Aprovar e marcar como 'em_lote' com o lote_id
        for (const saque of saques) {
          const novoStatus = saque.has_gratuity ? 'aprovado_gratuidade' : 'aprovado';
          await pool.query(`
            UPDATE withdrawal_requests
            SET status = $1,
                approved_at = COALESCE(approved_at, NOW()),
                lancamento_at = COALESCE(lancamento_at, NOW()),
                stark_status = 'em_lote',
                stark_lote_id = $2,
                admin_name = COALESCE(admin_name, 'Sistema (Auto-batch)'),
                updated_at = NOW()
            WHERE id = $3
          `, [novoStatus, loteId, saque.id]);
        }

        console.log(`✅ [CRON Stark] Lote #${loteId} — ${saques.length} saque(s) aprovados e marcados 'em_lote'`);

        // 📱 Notificar grupo WhatsApp (com await para garantir envio)
        try {
          const whatsResult = await notificarLoteGerado({ loteId, quantidade: saques.length, valorTotal, saques });
          console.log(`📱 [CRON Stark] WhatsApp lote #${loteId}: ${whatsResult.enviado ? '✅ enviado' : '⚠️ ' + (whatsResult.motivo || 'não enviado')}`);
        } catch (errWhats) {
          console.error('❌ [WhatsApp] Falha notificação lote:', errWhats.message);
        }

      } catch (error) {
        console.error('❌ [CRON Stark] Erro geral:', error.message);
      }
    };

    // Seg-Sex: a cada hora das 8h às 18h
    // 🔒 AUDIT-08: withCronLock previne duplicação com worker.js
    cron.schedule('0 8-18 * * 1-5', withCronLock(pool, 'prepararLoteStark', prepararLoteStarkAutomatico), { timezone: 'America/Bahia' });
    // Sábado: a cada hora das 8h às 12h
    cron.schedule('0 8-12 * * 6', withCronLock(pool, 'prepararLoteStark', prepararLoteStarkAutomatico), { timezone: 'America/Bahia' });

    console.log('⏰ Cron Stark Bank: Seg-Sex 8h-18h | Sáb 8h-12h (America/Bahia)');

    // ════════════════════════════════════════════════════════════
    // CRON: Auto-Sync Stark Bank (a cada 3 minutos)
    // Consulta a Stark Bank para transfers pendentes (saques + acertos)
    // e atualiza o status automaticamente — sem depender apenas do webhook
    // ════════════════════════════════════════════════════════════
    const autoSyncStark = async () => {
      if (typeof global.__sincronizarTransfersStark === 'function') {
        try {
          const resultado = await global.__sincronizarTransfersStark();
          if (resultado.atualizados > 0) {
            console.log(`🔄 [CRON Auto-Sync] ${resultado.atualizados} transfer(s) atualizada(s)`);
          }
        } catch (e) {
          console.error('❌ [CRON Auto-Sync] Erro:', e.message);
        }
      }
    };
    // A cada 3 minutos, Seg-Sáb 7h-20h
    cron.schedule('*/3 7-20 * * 1-6', withCronLock(pool, 'autoSyncStark', autoSyncStark), { timezone: 'America/Bahia' });
    console.log('⏰ Cron Auto-Sync Stark: a cada 3min, Seg-Sáb 7h-20h');

    // ════════════════════════════════════════════════════════════
    // CRON: Resumo Diário WhatsApp (19h Seg-Sex, 13h Sáb)
    // ════════════════════════════════════════════════════════════

    // Stark Bank SDK para saldo no resumo — reusar instância do stark.routes.js
    // NÃO inicializar aqui para não sobrescrever a configuração do módulo financeiro

    const enviarResumoDiario = async () => {
      console.log('📊 [CRON Resumo] Gerando resumo diário...');
      try {
        // ═══ DEDUP: Verificar se já enviou resumo hoje (evita mensagem duplicada) ═══
        // Usa tabela de advisory para registrar envio — INSERT com ON CONFLICT
        await pool.query(`
          CREATE TABLE IF NOT EXISTS cron_execution_log (
            job_name VARCHAR(100) NOT NULL,
            execution_date DATE NOT NULL DEFAULT CURRENT_DATE,
            executed_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (job_name, execution_date)
          )
        `).catch(() => {}); // Ignora se já existe

        const dedup = await pool.query(`
          INSERT INTO cron_execution_log (job_name, execution_date)
          VALUES ('resumoDiario', CURRENT_DATE)
          ON CONFLICT (job_name, execution_date) DO NOTHING
          RETURNING *
        `);

        if (dedup.rows.length === 0) {
          console.log('📊 [CRON Resumo] Já enviou resumo hoje — pulando para evitar duplicata');
          return;
        }

        const resumo = await pool.query(`
          SELECT 
            COUNT(*) as total_recebidas,
            COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade', 'pago_stark')) as total_aprovadas,
            COUNT(*) FILTER (WHERE status = 'aprovado' OR (status = 'pago_stark' AND has_gratuity = false)) as sem_gratuidade,
            COUNT(*) FILTER (WHERE status = 'aprovado_gratuidade' OR (status = 'pago_stark' AND has_gratuity = true)) as com_gratuidade,
            COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitadas,
            COALESCE(SUM(requested_amount) FILTER (WHERE status = 'aprovado' OR (status = 'pago_stark' AND has_gratuity = false)), 0) as valor_sem_gratuidade,
            COALESCE(SUM(requested_amount) FILTER (WHERE status = 'aprovado_gratuidade' OR (status = 'pago_stark' AND has_gratuity = true)), 0) as valor_com_gratuidade
          FROM withdrawal_requests
          WHERE created_at >= CURRENT_DATE AND created_at < (CURRENT_DATE + INTERVAL '1 day')
        `);
        const r = resumo.rows[0];
        const totalRecebidas = parseInt(r.total_recebidas) || 0;
        const totalAprovadas = parseInt(r.total_aprovadas) || 0;
        const semGratuidade = parseInt(r.sem_gratuidade) || 0;
        const comGratuidade = parseInt(r.com_gratuidade) || 0;
        const rejeitadas = parseInt(r.rejeitadas) || 0;
        const valorSemGratuidade = parseFloat(r.valor_sem_gratuidade) || 0;
        const valorComGratuidade = parseFloat(r.valor_com_gratuidade) || 0;
        const valorTotalAprovado = valorSemGratuidade + valorComGratuidade;
        const lucro = valorSemGratuidade * 0.045;
        const deixouArrecadar = valorComGratuidade * 0.045;
        let saldoStark = 0;
        if (global.__starkbank) {
          try {
            const result = await global.__starkbank.balance.get();
            if (Array.isArray(result)) { saldoStark = result.length > 0 ? result[0].amount / 100 : 0; }
            else if (result && result.amount !== undefined) { saldoStark = result.amount / 100; }
          } catch (e) { console.error('⚠️ [Resumo] Erro saldo Stark:', e.message); }
        }
        console.log(`📊 [CRON Resumo] Recebidas: ${totalRecebidas} | Aprovadas: ${totalAprovadas} | Lucro: R$ ${lucro.toFixed(2)}`);
        await notificarResumoDiario({ totalRecebidas, totalAprovadas, semGratuidade, comGratuidade, rejeitadas, valorTotalAprovado, lucro, deixouArrecadar, saldoStark });
        console.log('📊 [CRON Resumo] ✅ Resumo enviado com sucesso');
      } catch (error) {
        console.error('❌ [CRON Resumo] Erro:', error.message);
        // Se falhou, remover o registro de dedup para permitir retry
        await pool.query(`DELETE FROM cron_execution_log WHERE job_name = 'resumoDiario' AND execution_date = CURRENT_DATE`).catch(() => {});
      }
    };
    cron.schedule('0 19 * * 1-5', withCronLock(pool, 'resumoDiario', enviarResumoDiario), { timezone: 'America/Bahia' });
    cron.schedule('0 13 * * 6', withCronLock(pool, 'resumoDiario', enviarResumoDiario), { timezone: 'America/Bahia' });
    console.log('⏰ Cron Resumo Diário: Seg-Sex 19h | Sáb 13h');

    // ════════════════════════════════════════════════════════════
    // CRON: Filas - Reset diário às 19h (Seg-Sáb)
    // ════════════════════════════════════════════════════════════
    const resetarFilasDiario = async () => {
      console.log('🔄 [CRON Filas] Iniciando reset diário das filas...');
      try {
        const posicoes = await pool.query(`
          SELECT p.*, c.nome as central_nome
          FROM filas_posicoes p
          LEFT JOIN filas_centrais c ON c.id = p.central_id
        `);
        if (posicoes.rows.length === 0) {
          console.log('🔄 [CRON Filas] Nenhum profissional na fila');
          return;
        }
        for (const pos of posicoes.rows) {
          const tempoEspera = pos.entrada_fila_at ? Math.round((Date.now() - new Date(pos.entrada_fila_at).getTime()) / 60000) : null;
          const tempoRota = pos.saida_rota_at ? Math.round((Date.now() - new Date(pos.saida_rota_at).getTime()) / 60000) : null;
          await pool.query(`
            INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos, tempo_rota_minutos, observacao, admin_cod, admin_nome)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [pos.central_id, pos.central_nome || 'Central', pos.cod_profissional, pos.nome_profissional, 'reset_diario', tempoEspera, pos.status === 'em_rota' ? tempoRota : null, 'Reset automático das 19h (status: ' + pos.status + ')', 'sistema', 'CRON Reset 19h']);
        }
        const deleted = await pool.query('DELETE FROM filas_posicoes RETURNING *');
        await pool.query('DELETE FROM filas_notificacoes').catch(() => {});
        const aguardando = posicoes.rows.filter(p => p.status === 'aguardando').length;
        const emRota = posicoes.rows.filter(p => p.status === 'em_rota').length;
        console.log(`✅ [CRON Filas] Reset: ${deleted.rowCount} removido(s) (${aguardando} aguardando, ${emRota} em rota)`);
      } catch (error) {
        console.error('❌ [CRON Filas] Erro:', error.message);
      }
    };
    cron.schedule('0 19 * * 1-6', withCronLock(pool, 'resetFilas', resetarFilasDiario), { timezone: 'America/Bahia' });
    console.log('⏰ Cron Filas Reset: Seg-Sáb 19h');

    // ════════════════════════════════════════════════════════════
    // CRON: Disponibilidade - Alerta WhatsApp preenchimento
    // Seg-Sex 9h-14h a cada 30min
    // ════════════════════════════════════════════════════════════
    const alertarDisponibilidadeWhatsApp = async () => {
      console.log('🏍️ [CRON Disp] Verificando preenchimento...');
      try {
        const result = await pool.query(`
          SELECT 
            l.id, l.codigo, l.nome, l.qtd_titulares,
            COUNT(li.id) FILTER (WHERE li.is_excedente = false AND li.is_reposicao = false) as total_linhas,
            COUNT(li.id) FILTER (
              WHERE li.cod_profissional IS NOT NULL AND li.cod_profissional != ''
              AND li.status = 'EM LOJA'
            ) as preenchidas,
            COUNT(li.id) FILTER (
              WHERE li.cod_profissional IS NOT NULL AND li.cod_profissional != ''
              AND li.status = 'A CAMINHO'
            ) as a_caminho,
            COUNT(li.id) FILTER (
              WHERE li.cod_profissional IS NOT NULL AND li.cod_profissional != ''
              AND li.status = 'FALTANDO'
            ) as faltando_count,
            r.nome as regiao_nome
          FROM disponibilidade_lojas l
          LEFT JOIN disponibilidade_linhas li ON li.loja_id = l.id
          LEFT JOIN disponibilidade_regioes r ON r.id = l.regiao_id
          GROUP BY l.id, l.codigo, l.nome, l.qtd_titulares, r.nome
          HAVING COUNT(li.id) FILTER (WHERE li.is_excedente = false AND li.is_reposicao = false) > 0
          ORDER BY r.nome, l.nome
        `);
        if (result.rows.length === 0) { console.log('🏍️ [CRON Disp] Nenhuma loja'); return; }

        const LIMIAR = 95;
        let totalGeralTitulares = 0, totalGeralPreenchidas = 0, totalGeralACaminho = 0;
        const todosClientes = [];
        for (const loja of result.rows) {
          const titulares = parseInt(loja.total_linhas) || 0;
          const preenchidas = parseInt(loja.preenchidas) || 0;
          const aCaminho = parseInt(loja.a_caminho) || 0;
          const faltandoCount = parseInt(loja.faltando_count) || 0;
          const pct = titulares > 0 ? Math.round((preenchidas / titulares) * 100) : 0;
          totalGeralTitulares += titulares;
          totalGeralPreenchidas += preenchidas;
          totalGeralACaminho += aCaminho;
          todosClientes.push({ codigo: loja.codigo, nome: loja.nome, regiao: loja.regiao_nome || 'Sem região', preenchidas, titulares, faltando: titulares - preenchidas, pct, a_caminho: aCaminho, faltando_count: faltandoCount });
        }
        const clientesAbaixo = todosClientes.filter(c => c.pct < LIMIAR);
        const pctGeral = totalGeralTitulares > 0 ? Math.round((totalGeralPreenchidas / totalGeralTitulares) * 100) : 0;
        if (clientesAbaixo.length === 0) { console.log(`✅ [CRON Disp] >= ${LIMIAR}% (geral: ${pctGeral}%)`); return; }

        const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
        if (!ativo) { console.log('📱 [CRON Disp] WhatsApp desativado'); return; }
        const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
        const apiKey = process.env.EVOLUTION_API_KEY;
        const instancia = process.env.EVOLUTION_INSTANCE;
        const grupoId = (process.env.EVOLUTION_GROUP_ID_DISP || '').trim();
        if (!grupoId) { console.warn('⚠️ [CRON Disp] EVOLUTION_GROUP_ID_DISP não configurado'); return; }
        if (!baseUrl || !apiKey || !instancia) { console.warn('⚠️ [CRON Disp] Config incompleta'); return; }

        // Agrupar por região
        const porRegiao = {};
        for (const c of clientesAbaixo) { if (!porRegiao[c.regiao]) porRegiao[c.regiao] = []; porRegiao[c.regiao].push(c); }

        const agora = new Date();
        const dataHora = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        // ── Gerar imagem via Playwright ──
        const corBarra = (pct) => pct === 0 ? '#ef4444' : pct < 50 ? '#f97316' : pct < 80 ? '#eab308' : '#22c55e';
        const corTexto = (pct) => pct === 0 ? '#dc2626' : pct < 50 ? '#ea580c' : pct < 80 ? '#ca8a04' : '#16a34a';

        let regioesHtml = '';
        for (const [regiao, clientes] of Object.entries(porRegiao)) {
          let linhasHtml = '';
          for (const c of clientes) {
            linhasHtml += `
              <tr>
                <td style="padding:6px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6">${c.codigo}</td>
                <td style="padding:6px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6">${c.nome}</td>
                <td style="padding:6px 10px;text-align:center;border-bottom:1px solid #f3f4f6">
                  <div style="display:flex;align-items:center;gap:6px;justify-content:center">
                    <div style="width:60px;height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden">
                      <div style="width:${c.pct}%;height:100%;background:${corBarra(c.pct)};border-radius:4px"></div>
                    </div>
                    <span style="font-size:12px;font-weight:600;color:${corTexto(c.pct)}">${c.pct}%</span>
                  </div>
                </td>
                <td style="padding:6px 10px;text-align:center;font-size:13px;font-weight:600;color:${corTexto(c.pct)};border-bottom:1px solid #f3f4f6">${c.preenchidas}/${c.titulares}</td>
                <td style="padding:6px 10px;text-align:center;font-size:13px;color:#dc2626;font-weight:600;border-bottom:1px solid #f3f4f6">${c.faltando}</td>
                <td style="padding:6px 10px;text-align:center;font-size:12px;color:#2563eb;border-bottom:1px solid #f3f4f6">${c.a_caminho > 0 ? c.a_caminho + ' 🚀' : '—'}</td>
              </tr>`;
          }
          regioesHtml += `
            <div style="margin-bottom:16px">
              <div style="background:#7C3AED;color:white;padding:6px 14px;border-radius:8px 8px 0 0;font-size:13px;font-weight:600">📍 ${regiao} (${clientes.length})</div>
              <table style="width:100%;border-collapse:collapse;background:white;border-radius:0 0 8px 8px;overflow:hidden">
                <thead><tr style="background:#f9fafb">
                  <th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280;font-weight:600">CÓD</th>
                  <th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280;font-weight:600">CLIENTE</th>
                  <th style="padding:6px 10px;text-align:center;font-size:11px;color:#6b7280;font-weight:600">SLA</th>
                  <th style="padding:6px 10px;text-align:center;font-size:11px;color:#6b7280;font-weight:600">EM LOJA</th>
                  <th style="padding:6px 10px;text-align:center;font-size:11px;color:#6b7280;font-weight:600">FALTA</th>
                  <th style="padding:6px 10px;text-align:center;font-size:11px;color:#6b7280;font-weight:600">A CAMINHO</th>
                </tr></thead>
                <tbody>${linhasHtml}</tbody>
              </table>
            </div>`;
        }

        const html = `
          <div style="width:620px;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8f7ff">
            <div style="text-align:center;margin-bottom:20px">
              <div style="font-size:11px;color:#7C3AED;letter-spacing:3px;font-weight:600;margin-bottom:4px">ARGOS INTELLIGENCE</div>
              <div style="font-size:20px;font-weight:700;color:#1f2937">Alerta de Disponibilidade</div>
              <div style="font-size:13px;color:#6b7280;margin-top:4px">📅 ${dataHora}</div>
            </div>
            <div style="display:flex;gap:12px;margin-bottom:20px">
              <div style="flex:1;background:white;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
                <div style="font-size:28px;font-weight:700;color:${pctGeral >= 80 ? '#16a34a' : pctGeral >= 50 ? '#ca8a04' : '#dc2626'}">${pctGeral}%</div>
                <div style="font-size:11px;color:#6b7280;margin-top:2px">Preenchimento Geral</div>
              </div>
              <div style="flex:1;background:white;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
                <div style="font-size:28px;font-weight:700;color:#2563eb">${totalGeralPreenchidas}/${totalGeralTitulares}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:2px">Em Loja / Total</div>
              </div>
              <div style="flex:1;background:white;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
                <div style="font-size:28px;font-weight:700;color:#f97316">${clientesAbaixo.length}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:2px">Abaixo de ${LIMIAR}%</div>
              </div>
              <div style="flex:1;background:white;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
                <div style="font-size:28px;font-weight:700;color:#7C3AED">${totalGeralACaminho}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:2px">A Caminho 🚀</div>
              </div>
            </div>
            ${regioesHtml}
            <div style="text-align:center;margin-top:16px;font-size:11px;color:#9ca3af">Argos, seu sentinela operacional</div>
          </div>`;

        let imageBase64;
        try {
          const { chromium } = require('playwright');
          const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
          const page = await browser.newPage({ viewport: { width: 670, height: 800 } });
          await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:#f8f7ff">${html}</body></html>`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(300);
          const el = await page.$('body > div');
          const buf = await (el || page).screenshot({ type: 'png' });
          imageBase64 = buf.toString('base64');
          await browser.close();
          console.log(`📸 [CRON Disp] Imagem gerada: ${Math.round(imageBase64.length / 1024)}KB`);
        } catch (imgErr) {
          console.error(`❌ [CRON Disp] Erro Playwright:`, imgErr.message);
          // Fallback: enviar como texto
          let msg = `🏍️ *Alerta de Disponibilidade*\n📅 ${dataHora}\n📊 Geral: *${pctGeral}%* (${totalGeralPreenchidas}/${totalGeralTitulares})\n\n`;
          for (const [regiao, clientes] of Object.entries(porRegiao)) {
            msg += `📍 *${regiao}*\n`;
            for (const c of clientes) { msg += `${c.pct === 0 ? '🔴' : c.pct < 50 ? '🟠' : '🟡'} ${c.codigo} ${c.nome} — *${c.preenchidas}/${c.titulares}* (${c.pct}%) falta *${c.faltando}*\n`; }
            msg += '\n';
          }
          await fetch(`${baseUrl}/message/sendText/${instancia}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': apiKey }, body: JSON.stringify({ number: grupoId, text: msg }) });
          return;
        }

        // Enviar imagem
        const caption = `*Alerta de Disponibilidade — ${dataHora}*\n\nPreenchimento geral: *${pctGeral}%* (${totalGeralPreenchidas}/${totalGeralTitulares})\n${clientesAbaixo.length} cliente(s) abaixo de ${LIMIAR}%\n\n_Argos, seu sentinela operacional_`;
        const sendResp = await fetch(`${baseUrl}/message/sendMedia/${instancia}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
          body: JSON.stringify({ number: grupoId, mediatype: 'image', mimetype: 'image/png', caption, media: imageBase64, fileName: 'disponibilidade-alerta.png' }),
        });
        if (sendResp.ok) { console.log(`✅ [CRON Disp] Imagem enviada — ${clientesAbaixo.length} cliente(s)`); }
        else { const data = await sendResp.json().catch(() => ({})); console.error(`❌ [CRON Disp] Erro ${sendResp.status}:`, data); }
      } catch (error) {
        console.error('❌ [CRON Disp] Erro:', error.message);
      }
    };
    cron.schedule('0 9-13 * * 1-5', withCronLock(pool, 'alertaDisp', alertarDisponibilidadeWhatsApp), { timezone: 'America/Bahia' });
    console.log('⏰ Cron Disp Alerta: Seg-Sex 9h-13h (1h)');

    // ════════════════════════════════════════════════════════════
    // CRON: Reset semanal de limites (toda terça-feira 00:01)
    // Expira solicitações pendentes do ciclo anterior
    // ════════════════════════════════════════════════════════════
    const resetarLimitesSemanais = async () => {
      console.log('🔄 [CRON Limites] Executando reset semanal de limites...');
      try {
        const expiradas = await pool.query(`
          UPDATE withdrawal_limit_liberacoes 
          SET status = 'expirado', updated_at = NOW()
          WHERE status = 'pendente' 
            AND ciclo_fim < CURRENT_DATE
          RETURNING id, user_cod, user_name
        `);
        
        if (expiradas.rowCount > 0) {
          console.log(`✅ [CRON Limites] ${expiradas.rowCount} solicitação(ões) pendente(s) expirada(s)`);
          for (const row of expiradas.rows) {
            console.log(`   ↳ #${row.id} — ${row.user_name} (${row.user_cod})`);
          }
        } else {
          console.log('✅ [CRON Limites] Nenhuma solicitação pendente para expirar');
        }

        const cicloResult = await pool.query(`
          SELECT 
            (date_trunc('week', CURRENT_DATE - interval '1 day') + interval '1 day')::date as ciclo_inicio,
            (date_trunc('week', CURRENT_DATE - interval '1 day') + interval '7 days')::date as ciclo_fim
        `);
        const ciclo = cicloResult.rows[0];
        console.log(`📅 [CRON Limites] Novo ciclo: ${ciclo.ciclo_inicio} a ${ciclo.ciclo_fim}`);
      } catch (error) {
        console.error('❌ [CRON Limites] Erro no reset semanal:', error.message);
      }
    };
    
    cron.schedule('1 0 * * 2', withCronLock(pool, 'resetLimites', resetarLimitesSemanais), { timezone: 'America/Bahia' });
    console.log('⏰ Cron Limites Reset: Terça-feira 00:01 (America/Bahia)');

    // ════════════════════════════════════════════════════════════
    // CRON: Auth cleanup (bloqueios + refresh tokens)
    // ════════════════════════════════════════════════════════════
    setInterval(async () => {
      try {
        const r1 = await pool.query(`DELETE FROM login_attempts WHERE blocked_until IS NOT NULL AND blocked_until < NOW()`);
        if (r1.rowCount > 0) console.log(`🧹 ${r1.rowCount} bloqueio(s) expirado(s) removido(s)`);
        const r2 = await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = true`);
        if (r2.rowCount > 0) console.log(`🧹 ${r2.rowCount} refresh token(s) expirado(s) removido(s)`);
      } catch (e) {}
    }, 5 * 60 * 1000);

    // ── CRM: Captura de leads cadastrados (7h e 20h) ──────────────
    const { capturarLeadsCadastrados } = require('./src/modules/crm/playwright-crm-leads');

    async function executarCapturaCrmLeads() {
      const hoje = new Date();
      const ontem = new Date(hoje);
      ontem.setDate(ontem.getDate() - 1);
      const formatD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const dataInicio = formatD(ontem);
      const dataFim = formatD(hoje);

      let jobId;
      try {
        const { rows } = await pool.query(
          `INSERT INTO crm_captura_jobs (tipo, status, data_inicio, data_fim, iniciado_por)
           VALUES ('cron', 'executando', $1, $2, 'cron') RETURNING id`,
          [dataInicio, dataFim]
        );
        jobId = rows[0].id;
      } catch (e) {
        console.error('[CRM-Cron] Erro ao criar job:', e.message);
        return;
      }

      try {
        console.log(`[CRM-Cron] Job #${jobId}: ${dataInicio} → ${dataFim}`);
        const resultado = await capturarLeadsCadastrados({ dataInicio, dataFim });

        let novos = 0, jaExistentes = 0, ativos = 0, inativos = 0;
        for (const lead of resultado.registros) {
          try {
            const { rows: existentes } = await pool.query('SELECT id FROM crm_leads_capturados WHERE cod = $1', [lead.cod]);
            if (existentes.length > 0) {
              await pool.query(
                `UPDATE crm_leads_capturados SET nome=COALESCE($2,nome), telefones_raw=COALESCE($3,telefones_raw),
                 celular=COALESCE($4,celular), telefone_fixo=COALESCE($5,telefone_fixo),
                 telefone_normalizado=COALESCE($6,telefone_normalizado), email=COALESCE($7,email),
                 categoria=COALESCE($8,categoria), data_cadastro=COALESCE($9,data_cadastro),
                 cidade=COALESCE($10,cidade), estado=COALESCE($11,estado), regiao=COALESCE($12,regiao),
                 status_sistema=COALESCE($13,status_sistema), status_api=COALESCE($14,status_api),
                 api_verificado_em=COALESCE($15,api_verificado_em), job_id=$16 WHERE cod=$1`,
                [lead.cod, lead.nome, lead.telefones_raw, lead.celular, lead.telefone_fixo,
                 lead.telefone_normalizado, lead.email, lead.categoria, lead.data_cadastro,
                 lead.cidade, lead.estado, lead.regiao, lead.status_sistema, lead.status_api,
                 lead.api_verificado_em, jobId]
              );
              jaExistentes++;
            } else {
              await pool.query(
                `INSERT INTO crm_leads_capturados (cod,nome,telefones_raw,celular,telefone_fixo,telefone_normalizado,
                 email,categoria,data_cadastro,cidade,estado,regiao,status_sistema,status_api,api_verificado_em,job_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [lead.cod, lead.nome, lead.telefones_raw, lead.celular, lead.telefone_fixo,
                 lead.telefone_normalizado, lead.email, lead.categoria, lead.data_cadastro,
                 lead.cidade, lead.estado, lead.regiao, lead.status_sistema, lead.status_api,
                 lead.api_verificado_em, jobId]
              );
              novos++;
            }
            if (lead.status_api === 'ativo') ativos++;
            else if (lead.status_api === 'inativo') inativos++;
          } catch (e) { console.error(`[CRM-Cron] Erro lead ${lead.cod}: ${e.message}`); }
        }

        await pool.query(
          `UPDATE crm_captura_jobs SET status='concluido', total_capturados=$2, total_novos=$3,
           total_ja_existentes=$4, total_api_verificados=$5, total_ativos=$6, total_inativos=$7,
           screenshots=$8, concluido_em=NOW() WHERE id=$1`,
          [jobId, resultado.total, novos, jaExistentes,
           resultado.registros.filter(r => r.status_api).length, ativos, inativos,
           JSON.stringify(resultado.screenshots || [])]
        );
        console.log(`[CRM-Cron] ✅ Job #${jobId}: ${novos} novos | ${jaExistentes} atualizados | ${ativos} ativos`);

        // 📱 Notificar grupo WhatsApp com novos leads
        try {
          const notifResp = await fetch(`http://localhost:${env.PORT}/api/crm/leads-captura/notificar-novos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-service-key': process.env.CRM_SERVICE_KEY || '' },
            body: '{}',
          });
          const notifData = await notifResp.json();
          console.log(`[CRM-Cron] 📱 Notificação: ${notifData.enviado ? '✅' : '❌'}`, notifData.motivo || '');
        } catch (notifErr) {
          console.error(`[CRM-Cron] ❌ Erro notificação: ${notifErr.message}`);
        }
      } catch (err) {
        console.error(`[CRM-Cron] ❌ Job #${jobId}: ${err.message}`);
        await pool.query('UPDATE crm_captura_jobs SET status=$2, erro=$3, concluido_em=NOW() WHERE id=$1',
          [jobId, 'erro', err.message]).catch(() => {});
      }
    }

    cron.schedule('0 7 * * *', withCronLock(pool, 'crmCaptura', executarCapturaCrmLeads), { timezone: 'America/Bahia' });
    cron.schedule('0 20 * * *', withCronLock(pool, 'crmCaptura', executarCapturaCrmLeads), { timezone: 'America/Bahia' });

    // CRM — Resumo diário (imagem WhatsApp): Seg-Sex 18h, Sáb 12:30
    async function enviarResumoDiarioCRM() {
      try {
        console.log('[CRM-Resumo] Disparando resumo diário via cron...');
        const url = `http://localhost:${env.PORT}/api/crm/leads-captura/resumo-diario`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-service-key': process.env.CRM_SERVICE_KEY || '' },
          body: '{}',
        });
        const data = await res.json();
        console.log(`[CRM-Resumo] ${data.enviado ? '✅' : '❌'} Resultado:`, JSON.stringify(data));
      } catch (err) {
        console.error('[CRM-Resumo] ❌ Erro cron:', err.message);
      }
    }
    cron.schedule('0 18 * * 1-5', withCronLock(pool, 'crmResumoDiario', enviarResumoDiarioCRM), { timezone: 'America/Bahia' });
    cron.schedule('30 12 * * 6', withCronLock(pool, 'crmResumoDiario', enviarResumoDiarioCRM), { timezone: 'America/Bahia' });

    console.log('⏰ Todos os crons rodando no server');
  }
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
