/**
 * BI Monitoramento - Route Orchestrator
 *
 * Aplica verificarToken + verificarAdmin (apenas admin e admin_master).
 * Bloqueia user e admin_financeiro automaticamente via verificarAdmin.
 *
 * IMPORTANTE: pula request OPTIONS pra não bloquear o preflight do CORS.
 * Se interceptarmos OPTIONS no auth, retornamos 401 sem ack do preflight,
 * e o browser bloqueia todas as chamadas seguintes com erro CORS.
 */
const express = require('express');

const { createDashboardRoutes } = require('./routes/dashboard.routes');
const { createProfissionaisRoutes } = require('./routes/profissionais.routes');
const { createRegioesRoutes } = require('./routes/regioes.routes');
const { createHoraAHoraRoutes } = require('./routes/hora-a-hora.routes');
const { createFiltrosRoutes } = require('./routes/filtros.routes');

function createBiMonitoramentoRouter(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // Aplica auth apenas em rotas /bi-monitoramento (não bloquear outros módulos)
  // E NUNCA em OPTIONS — preflight CORS já é tratado por app.options('*') no server
  router.use((req, res, next) => {
    // Deixa OPTIONS passar livre — CORS já trata
    if (req.method === 'OPTIONS') return next();
    // Só protege rotas do nosso módulo
    if (!req.path.startsWith('/bi-monitoramento')) return next();

    return verificarToken(req, res, (err) => {
      if (err) return next(err);
      return verificarAdmin(req, res, next);
    });
  });

  router.use(createDashboardRoutes(pool));
  router.use(createProfissionaisRoutes(pool));
  router.use(createRegioesRoutes(pool));
  router.use(createHoraAHoraRoutes(pool));
  router.use(createFiltrosRoutes(pool));

  return router;
}

module.exports = { createBiMonitoramentoRouter };
