/**
 * MÓDULO AGENTE RPA - Route Orchestrator
 * Monta sub-routers por domínio.
 * 0 lógica de negócio aqui — só wiring.
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { createCorrecaoRoutes }   = require('./routes/correcao.routes');
const { createHistoricoRoutes }  = require('./routes/historico.routes');
const { createSlaCaptureRoutes } = require('./routes/sla-capture.routes');
const { createLiberacaoRoutes }  = require('./routes/liberar-ponto.routes');  // 2026-04 v3

const SCREENSHOT_DIR = '/tmp/screenshots';

function createAgentRouter(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  router.use(createCorrecaoRoutes(pool));
  router.use(createHistoricoRoutes(pool, verificarAdmin));
  router.use(createSlaCaptureRoutes(pool, verificarToken, verificarAdmin));
  router.use(createLiberacaoRoutes(pool));  // 2026-04 v3 — endpoints de liberar ponto

  // ── Pool status (debug) ─────────────────────────────────────────────────────
  // GET /agent/pool/status — snapshot do agent-pool e browser-pool
  // Útil pra ver: slots ocupados, ticks executados, último erro de cada agente.
  router.get('/pool/status', verificarAdmin, (_req, res) => {
    try {
      const { getPoolSnapshot } = require('./index');
      res.json({ ok: true, snapshot: getPoolSnapshot() });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── Screenshots de debug ────────────────────────────────────────────────────
  router.get('/screenshots', (req, res) => {
    try {
      const files = fs.existsSync(SCREENSHOT_DIR)
        ? fs.readdirSync(SCREENSHOT_DIR).sort().reverse()
        : [];
      res.json({ total: files.length, files });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  router.get('/screenshots/:filename', (req, res) => {
    const file = path.join(SCREENSHOT_DIR, path.basename(req.params.filename));
    if (fs.existsSync(file)) {
      res.sendFile(file);
    } else {
      res.status(404).json({ erro: `Screenshot "${req.params.filename}" não encontrado.` });
    }
  });

  console.log('✅ Módulo Agente RPA — rotas montadas (3 sub-routers + screenshots)');
  return router;
}

module.exports = { createAgentRouter };
