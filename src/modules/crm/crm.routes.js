// ============================================================
// MÓDULO CRM - ROUTES (wrapper)
// Monta sub-routers: core (bi_entregas) + leads-captura (Playwright)
// ============================================================

const express = require('express');
const { createCrmCoreRoutes } = require('./routes/crm.routes');

let createLeadsCapturaRoutes;
try {
  createLeadsCapturaRoutes = require('./routes/leads-captura.routes').createLeadsCapturaRoutes;
} catch (e) {
  console.error('⚠️ [CRM] leads-captura.routes.js não encontrado:', e.message);
}

let createAlocacaoRoutes;
try {
  createAlocacaoRoutes = require('./routes/alocacao.routes').createAlocacaoRoutes;
} catch (e) {
  console.error('⚠️ [CRM] alocacao.routes.js não encontrado:', e.message);
}

function initCrmRoutes(pool) {
  const router = express.Router();

  // Core routes (bi_entregas)
  router.use('/', createCrmCoreRoutes(pool));

  // Leads captura (Playwright)
  if (createLeadsCapturaRoutes) {
    router.use('/leads-captura', createLeadsCapturaRoutes(pool));
  }

  // Alocação de profissionais
  if (createAlocacaoRoutes) {
    router.use('/alocacao', createAlocacaoRoutes(pool));
    console.log('✅ APIs CRM carregadas (core + leads-captura + alocação)');
  } else if (createLeadsCapturaRoutes) {
    console.log('✅ APIs CRM carregadas (core + leads-captura)');
  } else {
    console.log('✅ APIs CRM carregadas (core only)');
  }

  return router;
}

module.exports = initCrmRoutes;
