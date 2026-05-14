/**
 * MÓDULO LOGISTICS — Routes (placeholder Fase 0)
 *
 * Master router para /api/logistics/*.
 *
 * ⚠️  FASE 0: todas as rotas operacionais retornam 501 Not Implemented.
 *
 * As únicas rotas que funcionam de verdade nesta fase são:
 *   - GET /api/logistics/providers — lista providers cadastrados (sem segredos)
 *   - GET /api/logistics/health    — health check do módulo
 *
 * Tudo o mais retorna 501 com payload explicativo, pra que clients que tentem
 * usar saibam claramente que está em desenvolvimento. Frontend Uber atual
 * continua usando /api/uber/* — nada quebra.
 *
 * Na Fase 1, este arquivo será expandido para chamar o Orchestrator.
 */

const express = require('express');
const { getProviderRegistry } = require('./core/ProviderRegistry');

function notImplemented(fase) {
  return (req, res) => res.status(501).json({
    error: 'not_implemented',
    message: `Endpoint em desenvolvimento — disponível a partir da ${fase}`,
    rota: `${req.method} ${req.originalUrl}`,
    fase_atual: 'Fase 0 (Setup e contratos)',
  });
}

function createLogisticsRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  const registry = getProviderRegistry(pool);

  // ──────────────────────────────────────────────────────────
  // Health do módulo
  // ──────────────────────────────────────────────────────────
  router.get('/health', verificarToken, async (req, res) => {
    res.json({
      ok: true,
      modulo: 'logistics',
      fase: 'Fase 0 — Setup e contratos',
      providers_cadastrados: registry.listAll().length,
      providers_ativos: registry.listActiveCodes(),
      observacao: 'Operações de cotação/despacho ainda não estão ligadas (501). Use /api/uber/* para Uber Direct nesta fase.',
    });
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/logistics/providers — lista (sem segredos)
  // ──────────────────────────────────────────────────────────
  router.get('/providers', verificarToken, async (req, res) => {
    try {
      const lista = registry.listAll();
      res.json({ success: true, providers: lista });
    } catch (err) {
      console.error('❌ [logistics/routes] erro ao listar providers:', err.message);
      res.status(500).json({ error: 'Erro ao listar providers' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/logistics/providers/:code — config (segredos mascarados)
  // ──────────────────────────────────────────────────────────
  router.get('/providers/:code', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM logistics_providers WHERE provider_code = $1',
        [req.params.code]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Provider não encontrado' });

      const row = rows[0];
      // Mascarar segredos (mesma estratégia do uber/admin.routes.js)
      const config = { ...(row.config || {}) };
      const segredosKeys = ['client_secret', 'mapp_api_token', 'api_key', 'webhook_secret'];
      for (const key of segredosKeys) {
        if (config[key]) {
          config[`${key}_setado`] = true;
          config[key] = '';
        }
      }

      res.json({
        success: true,
        provider: {
          provider_code: row.provider_code,
          display_name: row.display_name,
          ativo: row.ativo,
          sandbox_mode: row.sandbox_mode,
          prioridade: row.prioridade,
          config,
          capabilities: row.capabilities,
          webhook_secret_setado: !!row.webhook_secret,
          has_adapter_class: registry.listAll().find(p => p.provider_code === row.provider_code)?.has_adapter_class || false,
          instanciado: registry.has(row.provider_code),
        },
      });
    } catch (err) {
      console.error('❌ [logistics/routes] erro ao obter provider:', err.message);
      res.status(500).json({ error: 'Erro ao obter provider' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // Endpoints operacionais — todos 501 na Fase 0
  // ──────────────────────────────────────────────────────────

  // CRUD config — Fase 1
  router.put('/providers/:code', verificarToken, verificarAdmin, notImplemented('Fase 1'));
  router.post('/providers/:code/test-connection', verificarToken, verificarAdmin, notImplemented('Fase 1'));

  // Dispatch rules — Fase 1
  router.get('/dispatch-rules', verificarToken, notImplemented('Fase 1'));
  router.post('/dispatch-rules', verificarToken, verificarAdmin, notImplemented('Fase 1'));
  router.put('/dispatch-rules/:id', verificarToken, verificarAdmin, notImplemented('Fase 1'));
  router.delete('/dispatch-rules/:id', verificarToken, verificarAdmin, notImplemented('Fase 1'));

  // Cotação / despacho / cancelamento — Fase 1
  router.post('/quotes', verificarToken, verificarAdmin, notImplemented('Fase 1'));
  router.post('/deliveries', verificarToken, verificarAdmin, notImplemented('Fase 1'));
  router.get('/deliveries', verificarToken, notImplemented('Fase 1'));
  router.get('/deliveries/:id', verificarToken, notImplemented('Fase 1'));
  router.post('/deliveries/:id/cancel', verificarToken, verificarAdmin, notImplemented('Fase 1'));
  router.post('/deliveries/:id/redispatch', verificarToken, verificarAdmin, notImplemented('Fase 1'));
  router.get('/deliveries/:id/tracking', verificarToken, notImplemented('Fase 1'));

  // Métricas / eventos — Fase 1
  router.get('/metrics', verificarToken, notImplemented('Fase 1'));
  router.get('/events', verificarToken, notImplemented('Fase 1'));

  // ──────────────────────────────────────────────────────────
  // OBS: /api/logistics/webhook/:provider NÃO é montado aqui.
  // Webhooks são públicos (sem JWT), montados direto em server.js
  // antes da auth global, igual ao Uber atual. Ver patch no
  // server.js.patch.md (mas só ativado na Fase 1).
  // ──────────────────────────────────────────────────────────

  return router;
}

module.exports = { createLogisticsRouter };
