/**
 * MÓDULO LOGISTICS — Routes (Fase 1B.1)
 *
 * Master router para /api/logistics/*.
 *
 * Endpoints funcionais nesta fase:
 *   GET    /health
 *   GET    /providers
 *   GET    /providers/:code
 *   POST   /providers/:code/test-connection   ← healthCheck do adapter
 *   POST   /quotes                            ← cota uma OS
 *   POST   /quotes/multi                      ← cota múltiplos veículos
 *   POST   /deliveries                        ← despacha (com regra + margem)
 *   GET    /deliveries                        ← lista (lê uber_entregas)
 *   GET    /deliveries/:id                    ← detalhe
 *   POST   /deliveries/:id/cancel             ← cancela
 *   POST   /_test/dispatch-os/:codigoOS       ← teste end-to-end
 *
 * Pendentes (501 até Fase seguinte):
 *   PUT    /providers/:code           — config (Fase 2)
 *   GET    /dispatch-rules            — CRUD regras (Fase 2)
 *   POST   /deliveries/:id/redispatch — redespacho (Fase 2)
 *   GET    /metrics, /events          — dashboard (Fase 4)
 *
 * Webhook (/api/logistics/webhook/:provider) é montado em server.js
 * separadamente (público) — Fase 1B.2.
 */

const express = require('express');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getDispatchOrchestrator } = require('./core/DispatchOrchestrator');
const { getMappClient } = require('./core/MappClient');
const { EventSource } = require('./core/EventLogger');

function notImplemented(fase) {
  return (req, res) => res.status(501).json({
    error: 'not_implemented',
    message: `Endpoint em desenvolvimento — disponivel a partir da ${fase}`,
    rota: `${req.method} ${req.originalUrl}`,
    fase_atual: 'Fase 1B.1',
  });
}

function createLogisticsRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  const registry = getProviderRegistry(pool);

  // ───────────────────────────────────────────────────────────
  // GET /health
  // ───────────────────────────────────────────────────────────
  router.get('/health', verificarToken, async (req, res) => {
    res.json({
      ok: true,
      modulo: 'logistics',
      fase: 'Fase 1B.1 - UberAdapter + Orchestrator',
      providers_cadastrados: registry.listAll().length,
      providers_ativos: registry.listActiveCodes(),
      observacao: 'Webhook canonico ainda nao montado (Fase 1B.2). Worker em standby (Fase 1C).',
    });
  });

  // ───────────────────────────────────────────────────────────
  // GET /providers
  // ───────────────────────────────────────────────────────────
  router.get('/providers', verificarToken, async (req, res) => {
    try {
      res.json({ success: true, providers: registry.listAll() });
    } catch (err) {
      console.error('[logistics/routes] erro listar providers:', err.message);
      res.status(500).json({ error: 'Erro ao listar providers' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /providers/:code  — config (segredos mascarados)
  // ───────────────────────────────────────────────────────────
  router.get('/providers/:code', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM logistics_providers WHERE provider_code = $1',
        [req.params.code]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Provider nao encontrado' });

      const row = rows[0];
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
      console.error('[logistics/routes] erro obter provider:', err.message);
      res.status(500).json({ error: 'Erro ao obter provider' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /providers/:code/test-connection
  // ───────────────────────────────────────────────────────────
  router.post('/providers/:code/test-connection', verificarToken, verificarAdmin, async (req, res) => {
    const adapter = registry.get(req.params.code);
    if (!adapter) {
      return res.status(503).json({
        ok: false,
        msg: `Provider '${req.params.code}' não está ativo ou registrado`,
      });
    }
    try {
      const result = await adapter.healthCheck();
      res.json({ ok: result.ok, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, msg: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /quotes  — cota uma OS (1 veículo)
  // body: { codigoOS, providerCode?, vehicleType? }
  // ───────────────────────────────────────────────────────────
  router.post('/quotes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { codigoOS, providerCode = 'uber', vehicleType = null } = req.body || {};
      if (!codigoOS) {
        return res.status(400).json({ error: 'codigoOS obrigatório' });
      }
      const orch = getDispatchOrchestrator(pool);
      const result = await orch.quote(codigoOS, {
        providerCode,
        vehicleType,
        eventSource: EventSource.API,
      });

      res.json({
        success: true,
        codigoOS,
        provider_code: providerCode,
        cotacao: {
          quote_id: result.cotacao.quoteId,
          valor_provider: result.valor_provider,
          valor_uber: result.valor_provider,    // backward compat
          eta_minutos: result.cotacao.etaMinutos,
          vehicle_type: result.cotacao.vehicleType,
          expires_at: result.cotacao.expiresAt,
        },
        valor_cliente: result.valor_cliente,
        valor_profissional: result.valor_profissional,
        margem: result.margem,
        margem_pct: result.margem_pct,
      });
    } catch (err) {
      console.error('[logistics/routes] POST /quotes erro:', err.message);
      res.status(err.httpStatus || 500).json({
        error: err.message,
        category: err.category,
        code: err.code,
        retriable: err.retriable,
      });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /quotes/multi  — cota em múltiplos veículos
  // body: { codigoOS, providerCode?, vehicleTypes? }
  // ───────────────────────────────────────────────────────────
  router.post('/quotes/multi', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { codigoOS, providerCode = 'uber', vehicleTypes } = req.body || {};
      if (!codigoOS) {
        return res.status(400).json({ error: 'codigoOS obrigatório' });
      }
      const orch = getDispatchOrchestrator(pool);
      const cotacoes = await orch.quoteMultiple(codigoOS, {
        providerCode,
        vehicleTypes: Array.isArray(vehicleTypes) ? vehicleTypes : undefined,
      });
      res.json({ success: true, codigoOS, cotacoes });
    } catch (err) {
      console.error('[logistics/routes] POST /quotes/multi erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /deliveries  — despacha
  // body: { codigoOS, providerCode?, vehicleType?, quoteId?, regraId? }
  //   Se quoteId for passado, tenta reusar do cache (não cota de novo).
  // ───────────────────────────────────────────────────────────
  router.post('/deliveries', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { codigoOS, providerCode = 'uber', vehicleType = null, quoteId = null, regraId = null } = req.body || {};
      if (!codigoOS) {
        return res.status(400).json({ error: 'codigoOS obrigatório' });
      }

      const orch = getDispatchOrchestrator(pool);

      // Busca servico Mapp
      const servicos = await getMappClient(pool).listarServicos(0, 0);
      const servico = servicos.find(s => Number(s.codigoOS) === Number(codigoOS));
      if (!servico) {
        return res.status(404).json({ error: `OS ${codigoOS} não encontrada na Mapp ou já despachada` });
      }

      // Se passou quoteId, tenta cache
      let quoteReuso = null;
      if (quoteId) {
        const cached = orch.cache.getByQuoteId(quoteId);
        if (cached) {
          quoteReuso = { quote: cached.quote, request: cached.request };
        }
      }

      const registro = await orch.dispatch(servico, {
        providerCode,
        vehicleType,
        regraId,
        quoteReuso,
        eventSource: EventSource.API,
      });

      if (!registro) {
        return res.status(409).json({ error: 'OS ja tem entrega ativa ou despacho falhou' });
      }

      res.json({ success: true, entrega: registro });
    } catch (err) {
      console.error('[logistics/routes] POST /deliveries erro:', err.message);
      res.status(500).json({ error: err.message, category: err.category, code: err.code });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /deliveries  — lista (lê uber_entregas)
  // query: ?provider=uber&status=enviado_uber&codigo_os=123&limit=50&offset=0
  // ───────────────────────────────────────────────────────────
  router.get('/deliveries', verificarToken, async (req, res) => {
    try {
      const where = [];
      const params = [];
      let i = 1;

      if (req.query.status) {
        where.push(`status_uber = $${i++}`); params.push(req.query.status);
      }
      if (req.query.codigo_os) {
        where.push(`codigo_os = $${i++}`); params.push(parseInt(req.query.codigo_os, 10));
      }
      // provider filter — na Fase 1B só temos uber, mas já preparado pro futuro:
      // se passar provider != 'uber', retorna vazio.
      if (req.query.provider && req.query.provider !== 'uber') {
        return res.json({ success: true, total: 0, entregas: [] });
      }

      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = parseInt(req.query.offset, 10) || 0;
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `SELECT id, codigo_os, status_uber, valor_servico, valor_profissional, valor_uber,
                eta_minutos, uber_quote_id, uber_delivery_id, tracking_url,
                endereco_coleta, endereco_entrega, regra_id, tentativas, erro_ultimo,
                cancelado_por, cancelado_motivo, created_at, updated_at
         FROM uber_entregas ${whereSql}
         ORDER BY id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      );

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS total FROM uber_entregas ${whereSql}`,
        params
      );

      res.json({
        success: true,
        total: parseInt(countRows[0].total, 10),
        entregas: rows.map(r => ({ ...r, provider_code: 'uber' })),
      });
    } catch (err) {
      console.error('[logistics/routes] GET /deliveries erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /deliveries/:id  — detalhe
  // ───────────────────────────────────────────────────────────
  router.get('/deliveries/:id', verificarToken, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM uber_entregas WHERE id = $1',
        [parseInt(req.params.id, 10)]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });
      res.json({ success: true, entrega: { ...rows[0], provider_code: 'uber' } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /deliveries/:id/cancel
  // body: { motivo?, reabrir_mapp? }
  // ───────────────────────────────────────────────────────────
  router.post('/deliveries/:id/cancel', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const orch = getDispatchOrchestrator(pool);
      const result = await orch.cancel(parseInt(req.params.id, 10), {
        motivo: req.body?.motivo || 'Cancelado via API',
        reabrirMapp: req.body?.reabrir_mapp !== false,
        eventSource: EventSource.API,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /_test/dispatch-os/:codigoOS   — END-TO-END (admin-only)
  // Útil pra testar pipeline sem esperar worker. Será removido na Fase 2.
  // ───────────────────────────────────────────────────────────
  router.post('/_test/dispatch-os/:codigoOS', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const codigoOS = parseInt(req.params.codigoOS, 10);
      if (!codigoOS) return res.status(400).json({ error: 'codigoOS inválido' });

      const orch = getDispatchOrchestrator(pool);
      const result = await orch.tryDispatchByOS(codigoOS, { eventSource: EventSource.API });

      res.json({ success: true, codigoOS, ...result });
    } catch (err) {
      console.error('[logistics/routes] _test/dispatch-os erro:', err.message);
      res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
    }
  });

  // ───────────────────────────────────────────────────────────
  // Endpoints pendentes (501)
  // ───────────────────────────────────────────────────────────
  router.put('/providers/:code', verificarToken, verificarAdmin, notImplemented('Fase 2'));
  router.get('/dispatch-rules', verificarToken, notImplemented('Fase 2'));
  router.post('/dispatch-rules', verificarToken, verificarAdmin, notImplemented('Fase 2'));
  router.put('/dispatch-rules/:id', verificarToken, verificarAdmin, notImplemented('Fase 2'));
  router.delete('/dispatch-rules/:id', verificarToken, verificarAdmin, notImplemented('Fase 2'));
  router.post('/deliveries/:id/redispatch', verificarToken, verificarAdmin, notImplemented('Fase 2'));
  router.get('/deliveries/:id/tracking', verificarToken, notImplemented('Fase 1B.2'));
  router.get('/metrics', verificarToken, notImplemented('Fase 4'));
  router.get('/events', verificarToken, notImplemented('Fase 4'));

  return router;
}

module.exports = { createLogisticsRouter };
