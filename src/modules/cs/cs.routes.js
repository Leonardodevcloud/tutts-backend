/**
 * MÓDULO SUCESSO DO CLIENTE (CS) - Route Orchestrator
 * Monta sub-routers por domínio lógico
 * 0 lógica de negócio aqui — só wiring
 *
 * 🔕 2026-05-23: Raio-X DESATIVADO (custo Google APIs incontrolável — ver doc
 *    análise-custos-google-apis). Endpoints retornam 410 Gone. Manter arquivos
 *    pra histórico mas não importar.
 */

const express = require('express');

// Sub-routers por domínio
const { createClientesRoutes } = require('./routes/clientes.routes');
const { createInteracoesRoutes } = require('./routes/interacoes.routes');
const { createOcorrenciasRoutes } = require('./routes/ocorrencias.routes');
const { createDashboardRoutes } = require('./routes/dashboard.routes');
// 🔕 DESATIVADO 2026-05-23
// const { createRaioXRoutes } = require('./routes/raioX.routes');
// const { createRaioXPdfRoutes } = require('./routes/raioXPdf.routes');
// const { createRaioXClienteRoutes } = require('./routes/raioXCliente.routes');
const { createEmailsRoutes } = require('./routes/emails.routes');
const { createEmailAutomacaoRoutes } = require('./routes/email-automacao.routes');

function createCsRouter(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // Montar sub-routers
  router.use(createClientesRoutes(pool));
  router.use(createInteracoesRoutes(pool));
  router.use(createOcorrenciasRoutes(pool));
  router.use(createDashboardRoutes(pool));

  // 🔕 Raio-X desativado — endpoints retornam 410 Gone
  const raioXGone = (req, res) => res.status(410).json({
    error: 'Funcionalidade descontinuada',
    detalhe: 'O Raio-X com IA foi desativado em 23/05/2026 para controle de custos da Google Maps API.'
  });
  router.all('/raio-x', raioXGone);
  router.all('/raio-x/*', raioXGone);

  router.use(createEmailsRoutes(pool));
  router.use(createEmailAutomacaoRoutes(pool));

  console.log('✅ Módulo Sucesso do Cliente — rotas montadas (Raio-X desativado)');

  return router;
}

module.exports = { createCsRouter };
