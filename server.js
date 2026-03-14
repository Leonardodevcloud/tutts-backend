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

const { createPerformanceIndices } = require('./src/shared/migrations/performance-indices');

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
const { initCsRoutes, initCsTables } = require('./src/modules/cs');
const { initAgentRoutes, initAgentTables, startAgentWorker } = require('./src/modules/agent');
const { initAntiFraudeRoutes, initAntiFraudeTables, startAntiFraudeWorker } = require('./src/modules/antifraude');
const { initPerformanceRoutes, initPerformanceTables, startPerformanceWorker } = require('./src/modules/performance');

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
// verify: preserva o rawBody para validação de assinatura de webhooks (Stark Bank)
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    // Preservar raw body apenas para rotas de webhook (performance)
    if (req.originalUrl && req.originalUrl.includes('/stark/webhook')) {
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

// ⚡ PERFORMANCE: Endpoint consolidado para login — 1 chamada ao invés de 20
app.get('/api/init', verificarToken, async (req, res) => {
  try {
    const { codProfissional, role } = req.user;
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(role);
    
    // Executar queries essenciais em paralelo (apenas contadores leves)
    const queries = [];
    
    // 1. Contadores de notificação (sempre necessário)
    queries.push(
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'pending' OR status = 'aguardando_aprovacao') as saques_pendentes,
                COUNT(*) FILTER (WHERE status = 'pending') as gratuidades_pendentes
         FROM (
           SELECT status FROM withdrawal_requests WHERE status IN ('pending','aguardando_aprovacao') LIMIT 100
         ) w
         FULL OUTER JOIN (
           SELECT status FROM gratuities WHERE status = 'pending' LIMIT 100
         ) g ON false`
      ).catch(() => ({ rows: [{ saques_pendentes: 0, gratuidades_pendentes: 0 }] }))
    );
    
    // 2. Social unread count
    queries.push(
      pool.query(
        `SELECT COUNT(*) as unread FROM social_messages 
         WHERE receiver_cod = $1 AND read = false`,
        [codProfissional]
      ).catch(() => ({ rows: [{ unread: 0 }] }))
    );
    
    // 3. Todo pendentes count (se tem acesso)
    queries.push(
      pool.query(
        `SELECT COUNT(*) as pendentes FROM todo_tarefas 
         WHERE status != 'concluido' 
         AND (criado_por = $1 OR responsaveis::text LIKE $2)
         LIMIT 1`,
        [codProfissional, `%${codProfissional}%`]
      ).catch(() => ({ rows: [{ pendentes: 0 }] }))
    );
    
    // 4. Social profile
    queries.push(
      pool.query(
        `SELECT display_name, bio, avatar_url, status_text FROM social_profiles WHERE user_cod = $1`,
        [codProfissional]
      ).catch(() => ({ rows: [] }))
    );
    
    const [countersRes, socialRes, todoRes, profileRes] = await Promise.all(queries);
    
    res.json({
      counters: {
        saquesPendentes: parseInt(countersRes.rows[0]?.saques_pendentes) || 0,
        gratuidadesPendentes: parseInt(countersRes.rows[0]?.gratuidades_pendentes) || 0,
        socialUnread: parseInt(socialRes.rows[0]?.unread) || 0,
        todoPendentes: parseInt(todoRes.rows[0]?.pendentes) || 0,
      },
      socialProfile: profileRes.rows[0] || null,
      role,
      codProfissional,
    });
  } catch (error) {
    console.error('❌ Erro no /api/init:', error.message);
    res.status(500).json({ error: 'Erro ao inicializar' });
  }
});

// ⚡ PERFORMANCE: Endpoint consolidado para módulo financeiro
app.get('/api/financeiro/init', verificarToken, async (req, res) => {
  try {
    const { role } = req.user;
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(role)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const [pendentesRes, countRes, restrictedRes, pedidosRes, gratuidadesRes] = await Promise.all([
      pool.query(`SELECT * FROM withdrawal_requests WHERE status IN ('pending', 'aguardando_aprovacao') ORDER BY created_at DESC`),
      pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status IN ('pending','aguardando_aprovacao')) as aguardando,
          COUNT(*) FILTER (WHERE status = 'approved') as aprovadas,
          COUNT(*) FILTER (WHERE status = 'approved' AND tipo_pagamento = 'gratuidade') as gratuidade,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejeitadas,
          COUNT(*) FILTER (WHERE status = 'inactive') as inativo,
          COUNT(*) FILTER (WHERE status IN ('pending','aguardando_aprovacao') AND created_at < NOW() - INTERVAL '1 hour') as atrasadas,
          COUNT(*) as total
        FROM withdrawal_requests WHERE created_at >= NOW() - INTERVAL '90 days'
      `),
      pool.query(`SELECT user_cod, reason FROM restricted_professionals WHERE status = 'ativo'`),
      pool.query(`SELECT * FROM loja_pedidos WHERE status = 'pendente' ORDER BY created_at DESC LIMIT 50`),
      pool.query(`SELECT * FROM gratuities WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`)
    ]);
    
    const restrictedMap = {};
    for (const r of restrictedRes.rows) restrictedMap[r.user_cod] = r.reason;
    const withdrawals = pendentesRes.rows.map(w => ({
      ...w, is_restricted: !!restrictedMap[w.user_cod], restriction_reason: restrictedMap[w.user_cod] || null,
    }));
    
    res.json({ withdrawals, counts: countRes.rows[0] || {}, pedidos: pedidosRes.rows, gratuidades: gratuidadesRes.rows });
  } catch (error) {
    console.error('❌ Erro /financeiro/init:', error.message);
    res.status(500).json({ error: 'Erro ao inicializar financeiro' });
  }
});

// ⚡⚡⚡ OVERRIDES DEFINITIVOS — registrados ANTES dos módulos para garantir prioridade
// /api/withdrawals — CACHE 30s | Com filtro de data: SEM LIMIT | Sem filtro: LIMIT 500
let _wCache = { data: null, ts: 0, key: '' };
app.get('/api/withdrawals', verificarToken, async (req, res) => {
  try {
    const { role } = req.user;
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(role)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const status = req.query.status || '';
    const dataInicio = req.query.dataInicio || '';
    const dataFim = req.query.dataFim || '';
    const tipoFiltro = req.query.tipoFiltro || 'solicitacao';
    const userCod = req.query.userCod || '';
    // Com filtro de data (validação/conciliação): sem cap — retorna tudo do período
    // Sem filtro de data: máximo 500 para performance
    const comFiltroData = !!(dataInicio && dataFim);
    const limit = comFiltroData ? null : Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const ck = `${status}-${limit}-${offset}-${dataInicio}-${dataFim}-${tipoFiltro}-${userCod}`;
    if (_wCache.key === ck && _wCache.data && Date.now() - _wCache.ts < 30000) return res.json(_wCache.data);
    
    let query, params;
    
    // Filtro por user_cod (aba resumo)
    if (userCod) {
      query = `SELECT * FROM withdrawal_requests WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC LIMIT $2`;
      params = [userCod, Math.min(parseInt(req.query.limit) || 500, 500)];
    }
    // Filtro por data (aba validação/conciliação) — SEM LIMIT, retorna tudo do período
    else if (comFiltroData) {
      const col = tipoFiltro === 'lancamento' ? 'lancamento_at' : tipoFiltro === 'debito' ? 'debito_plific_at' : 'created_at';
      if (status) {
        query = `SELECT * FROM withdrawal_requests WHERE status = $1 AND ${col} >= $2::date AND ${col} < $3::date + interval '1 day' ORDER BY created_at DESC`;
        params = [status, dataInicio, dataFim];
      } else {
        query = `SELECT * FROM withdrawal_requests WHERE ${col} >= $1::date AND ${col} < $2::date + interval '1 day' ORDER BY created_at DESC`;
        params = [dataInicio, dataFim];
      }
    } else if (status) {
      query = `SELECT * FROM withdrawal_requests WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
      params = [status, limit, offset];
    } else {
      query = `SELECT * FROM withdrawal_requests ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
      params = [limit, offset];
    }
    
    const [result, rRes] = await Promise.all([
      pool.query(query, params),
      pool.query(`SELECT user_cod, reason FROM restricted_professionals WHERE status = 'ativo'`)
    ]);
    const rm = {}; for (const r of rRes.rows) rm[r.user_cod] = r.reason;
    const enriched = result.rows.map(w => ({ ...w, is_restricted: !!rm[w.user_cod], restriction_reason: rm[w.user_cod] || null }));
    _wCache = { data: enriched, ts: Date.now(), key: ck };
    console.log(`⚡ /withdrawals: ${enriched.length} regs (limit=${limit}, semLimit=${comFiltroData}, dataInicio=${dataInicio}, dataFim=${dataFim})`);
    res.json(enriched);
  } catch (error) {
    console.error('❌ Erro /withdrawals:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// /api/gratuities — HARD LIMIT 50
app.get('/api/gratuities', verificarToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const result = await pool.query(`SELECT * FROM gratuities ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// /api/restricted — HARD LIMIT 100
app.get('/api/restricted', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM restricted_professionals WHERE status = 'ativo' ORDER BY created_at DESC LIMIT 100`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

// Sucesso do Cliente (CS) — acesso admin/gestores
// (mapa-calor é público via PUBLIC_PATHS em auth.js)
app.use('/api', verificarToken, initCsRoutes(pool, verificarToken, verificarAdmin));
// ── Screenshots RPA (público com chave, temporário) ──────────────────
const SCREENSHOT_DIR_TMP = '/tmp/screenshots';
const SCREENSHOT_KEY = process.env.SCREENSHOT_KEY || 'tutts-debug-2025';

app.get('/api/rpa-screenshots', (req, res) => {
  if (req.query.key !== SCREENSHOT_KEY) return res.status(403).json({ erro: 'Use ?key=CHAVE' });
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

app.get('/api/rpa-screenshots/:filename', (req, res) => {
  if (req.query.key !== SCREENSHOT_KEY) return res.status(403).json({ erro: 'Acesso negado' });
  const fss = require('fs');
  const pathh = require('path');
  const file = pathh.join(SCREENSHOT_DIR_TMP, req.params.filename);
  if (!fss.existsSync(file)) return res.status(404).json({ erro: 'Nao encontrada' });
  res.type('image/png').sendFile(file);
});

app.use('/api/agent', verificarToken, initAgentRoutes(pool, verificarToken, verificarAdmin));
app.use('/api/antifraude', verificarToken, verificarAdmin, initAntiFraudeRoutes(pool, verificarAdmin));
app.use('/api', verificarToken, initPerformanceRoutes(pool, verificarToken));

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
    try { await initAntiFraudeTables(pool); } catch (e) { console.error('⚠️ Anti-Fraude tables error:', e.message); }
    try { await initPerformanceTables(pool); } catch (e) { console.error('⚠️ Performance tables error:', e.message); }
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
initDatabase().then(() => {
  server.listen(env.PORT, () => {
    logger.info('Servidor iniciado', {
      port: env.PORT,
      version: env.SERVER_VERSION,
      nodeEnv: env.NODE_ENV,
    });

    // Cron jobs
    initTodoCron(pool);
    startAgentWorker(pool);
    startAntiFraudeWorker(pool);
    startPerformanceWorker(pool);
    // Crons: se WORKER_ENABLED=true, crons rodam no worker.js separado
    if (process.env.WORKER_ENABLED === 'true') {
      console.log('⏰ Crons desativados no server (rodando no worker separado)');
    } else {
      initScoreCron(cron, pool);

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

          // Criar registro do lote com status 'pendente' (admin executa depois)
          const loteResult = await pool.query(`
            INSERT INTO stark_lotes (quantidade, valor_total, saldo_antes, status, executado_por_id, executado_por_nome)
            VALUES ($1, $2, 0, 'pendente', 0, 'Sistema (Auto-batch)')
            RETURNING *
          `, [saques.length, valorTotal]);

          const loteId = loteResult.rows[0].id;

          // Aprovar e marcar como 'em_lote' com o lote_id real
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

          console.log(`✅ [CRON Stark] Lote #${loteId} criado — ${saques.length} saque(s) aprovados e marcados 'em_lote' — aguardando admin executar pagamento`);

        } catch (error) {
          console.error('❌ [CRON Stark] Erro geral:', error.message);
        }
      };

      // Seg-Sex: a cada hora das 8h às 18h
      cron.schedule('0 8-18 * * 1-5', prepararLoteStarkAutomatico, { timezone: 'America/Bahia' });
      // Sábado: a cada hora das 8h às 12h
      cron.schedule('0 8-12 * * 6', prepararLoteStarkAutomatico, { timezone: 'America/Bahia' });

      console.log('⏰ Cron Stark Bank: Seg-Sex 8h-18h | Sáb 8h-12h (America/Bahia)');

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
