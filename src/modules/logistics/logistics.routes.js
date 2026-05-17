/**
 * MÓDULO LOGISTICS — Routes (Fase 4)
 *
 * Master router para /api/logistics/*.
 *
 * Endpoints funcionais:
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
 *   POST   /deliveries/:id/redispatch         ← redespacho (Fase 2)
 *   POST   /_test/dispatch-os/:codigoOS       ← teste end-to-end
 *   POST   /_admin/resync-deliveries          ← re-roda backfill (Fase 2)
 *   GET    /dispatch-rules                    ← lista regras (Fase 2)
 *   GET    /dispatch-rules/:id                ← detalhe regra (Fase 2)
 *   POST   /dispatch-rules                    ← cria regra (Fase 2)
 *   PUT    /dispatch-rules/:id                ← atualiza regra (Fase 2)
 *   DELETE /dispatch-rules/:id                ← remove regra (Fase 2)
 *
 *   GET    /metrics                          ← dashboard agregado (Fase 4)
 *   GET    /events                           ← feed de eventos (Fase 4)
 *   GET    /events/timeline/:codigoOS         ← timeline de uma OS (Fase 4)
 *
 *   PUT    /providers/:code                   ← config do provider via API (Fase 5)
 *
 * Pendentes (501):
 *   GET    /deliveries/:id/tracking   — tracking detalhado (Fase 5)
 *
 * Webhook (/api/logistics/webhook/:provider) é montado em server.js
 * separadamente (público) — Fase 1B.2.
 */

const express = require('express');
const { getProviderRegistry } = require('./core/ProviderRegistry');
const { getDispatchOrchestrator } = require('./core/DispatchOrchestrator');
const { getMappClient } = require('./core/MappClient');
const { EventSource } = require('./core/EventLogger');
const { createDispatchRulesRoutes } = require('./routes/dispatch-rules.routes');
const { createDashboardRoutes } = require('./routes/dashboard.routes');
const { initLogisticsBackfill } = require('./logistics.backfill');

function notImplemented(fase) {
  return (req, res) => res.status(501).json({
    error: 'not_implemented',
    message: `Endpoint em desenvolvimento — disponivel a partir da ${fase}`,
    rota: `${req.method} ${req.originalUrl}`,
    fase_atual: 'Fase 1B.1',
  });
}

// ════════════════════════════════════════════════════════════════════════
// 🆕 2026-05 FASE 6 — READ-FLIP: leitura a partir de logistics_deliveries
// ────────────────────────────────────────────────────────────────────────
// Controlado por env LOGISTICS_READ_SOURCE:
//   'canonico' (default) → lê logistics_deliveries (tabela do hub)
//   'legado'             → lê uber_entregas (comportamento pré-Fase 6)
// O flag torna o read-flip 100% reversível sem redeploy.
//
// mapearCanonicoParaLegado(): logistics_deliveries devolve nomes canônicos
// (status_canonico, valor_provider, courier_data JSONB...). O frontend
// espera o shape legado (status_uber, valor_uber, entregador_*). Esta
// função traduz, pra o front não precisar mudar nada.
const LOGISTICS_READ_SOURCE = process.env.LOGISTICS_READ_SOURCE || 'canonico';

function mapearCanonicoParaLegado(ld) {
  const courier = ld.courier_data || {};
  return {
    id:                 ld.id,
    codigo_os:          ld.codigo_os,
    provider_code:      ld.provider_code,
    // status: o front usa status_uber; status_native guarda o status
    // nativo do provider (o dual-write grava ld.status_native = status_uber).
    status_uber:        ld.status_native || ld.status_canonico,
    status_canonico:    ld.status_canonico,
    valor_servico:      ld.valor_servico,
    valor_uber:         ld.valor_provider,        // legado: valor_uber
    valor_provider:     ld.valor_provider,
    valor_profissional: ld.valor_profissional,
    eta_minutos:        ld.eta_minutos,
    vehicle_type:       ld.vehicle_type,
    uber_quote_id:      ld.external_quote_id,     // legado: uber_quote_id
    uber_delivery_id:   ld.external_delivery_id,  // legado: uber_delivery_id
    tracking_url:       ld.tracking_url,
    endereco_coleta:    ld.endereco_coleta,
    endereco_entrega:   ld.endereco_entrega,
    latitude_coleta:    ld.latitude_coleta,
    longitude_coleta:   ld.longitude_coleta,
    latitude_entrega:   ld.latitude_entrega,
    longitude_entrega:  ld.longitude_entrega,
    pontos:             ld.pontos,
    obs:                ld.obs,
    regra_id:           ld.regra_id,
    cliente_nome_regra: ld.cliente_nome_regra || null, // vem do JOIN
    tentativas:         ld.tentativas,
    erro_ultimo:        ld.erro_ultimo,
    finalizado_at:      ld.finalizado_at,
    cancelado_por:      ld.cancelado_por,
    cancelado_motivo:   ld.cancelado_motivo,
    // courier_data JSONB → campos entregador_* legados
    entregador_nome:      courier.name || null,
    entregador_telefone:  courier.phone || null,
    entregador_placa:     courier.plate || null,
    entregador_veiculo:   courier.vehicle || null,
    entregador_documento: courier.document || null,
    entregador_foto:      courier.photo || null,
    entregador_rating:    courier.rating || null,
    created_at:         ld.created_at,
    updated_at:         ld.updated_at,
  };
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
  // GET /deliveries  — lista
  // 🆕 Fase 6 read-flip: lê logistics_deliveries (canônico) por padrão;
  //    LOGISTICS_READ_SOURCE='legado' volta a ler uber_entregas.
  // query: ?provider=uber&status=...&codigo_os=123&limit=50&offset=0
  // ───────────────────────────────────────────────────────────
  router.get('/deliveries', verificarToken, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = parseInt(req.query.offset, 10) || 0;

      // ── Caminho LEGADO (rollback) — lê uber_entregas ──
      if (LOGISTICS_READ_SOURCE === 'legado') {
        const where = [];
        const params = [];
        let i = 1;
        if (req.query.status) { where.push(`status_uber = $${i++}`); params.push(req.query.status); }
        if (req.query.codigo_os) { where.push(`codigo_os = $${i++}`); params.push(parseInt(req.query.codigo_os, 10)); }
        if (req.query.provider && req.query.provider !== 'uber') {
          return res.json({ success: true, total: 0, entregas: [] });
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const { rows } = await pool.query(
          `SELECT id, codigo_os, status_uber, valor_servico, valor_profissional, valor_uber,
                  eta_minutos, uber_quote_id, uber_delivery_id, tracking_url,
                  endereco_coleta, endereco_entrega, regra_id, tentativas, erro_ultimo,
                  cancelado_por, cancelado_motivo, created_at, updated_at
           FROM uber_entregas ${whereSql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
          params
        );
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*) AS total FROM uber_entregas ${whereSql}`, params);
        return res.json({
          success: true,
          total: parseInt(countRows[0].total, 10),
          entregas: rows.map(r => ({ ...r, provider_code: 'uber' })),
        });
      }

      // ── Caminho CANÔNICO (padrão Fase 6) — lê logistics_deliveries ──
      const where = [];
      const params = [];
      let i = 1;
      // status: aceita tanto o nativo (status_native) quanto o canônico
      if (req.query.status) {
        where.push(`(ld.status_native = $${i} OR ld.status_canonico = $${i})`);
        params.push(req.query.status); i++;
      }
      if (req.query.codigo_os) {
        where.push(`ld.codigo_os = $${i++}`); params.push(parseInt(req.query.codigo_os, 10));
      }
      if (req.query.provider) {
        where.push(`ld.provider_code = $${i++}`); params.push(req.query.provider);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `SELECT ld.*, r.cliente_nome AS cliente_nome_regra
         FROM logistics_deliveries ld
         LEFT JOIN logistics_dispatch_rules r ON r.id = ld.regra_id
         ${whereSql}
         ORDER BY ld.id DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS total FROM logistics_deliveries ld ${whereSql}`, params);

      res.json({
        success: true,
        total: parseInt(countRows[0].total, 10),
        entregas: rows.map(mapearCanonicoParaLegado),
      });
    } catch (err) {
      console.error('[logistics/routes] GET /deliveries erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /deliveries/:id  — detalhe (read-flip Fase 6)
  // ───────────────────────────────────────────────────────────
  router.get('/deliveries/:id', verificarToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);

      if (LOGISTICS_READ_SOURCE === 'legado') {
        const { rows } = await pool.query('SELECT * FROM uber_entregas WHERE id = $1', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });
        return res.json({ success: true, entrega: { ...rows[0], provider_code: 'uber' } });
      }

      const { rows } = await pool.query(
        `SELECT ld.*, r.cliente_nome AS cliente_nome_regra
         FROM logistics_deliveries ld
         LEFT JOIN logistics_dispatch_rules r ON r.id = ld.regra_id
         WHERE ld.id = $1`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });
      const entrega = mapearCanonicoParaLegado(rows[0]);

      // 🆕 Fase 6 — o modal de detalhes do frontend espera tracking + webhooks.
      // tracking: pontos de logistics_tracking; webhooks: eventos de logistics_events.
      let tracking = [];
      let webhooks = [];
      try {
        const t = await pool.query(
          `SELECT latitude, longitude, status_native, created_at
           FROM logistics_tracking WHERE codigo_os = $1 ORDER BY created_at ASC`,
          [entrega.codigo_os]
        );
        tracking = t.rows;
        const w = await pool.query(
          `SELECT event_type, event_source, status_native, payload, created_at
           FROM logistics_events WHERE codigo_os = $1 ORDER BY created_at DESC LIMIT 50`,
          [entrega.codigo_os]
        );
        webhooks = w.rows;
      } catch (e) {
        console.error('[logistics/routes] /deliveries/:id tracking/events:', e.message);
      }

      res.json({ success: true, entrega, tracking, webhooks });
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
  // POST /deliveries/:id/redispatch  — cancela e recria entrega (Fase 2)
  // body: { providerCode?, vehicleType?, motivo? }
  // ───────────────────────────────────────────────────────────
  router.post('/deliveries/:id/redispatch', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const entregaId = parseInt(req.params.id, 10);
      const { providerCode = 'uber', vehicleType = null, motivo } = req.body || {};

      const orch = getDispatchOrchestrator(pool);

      // 1. Busca a entrega original
      const { rows } = await pool.query('SELECT * FROM uber_entregas WHERE id = $1', [entregaId]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Entrega não encontrada' });
      }
      const original = rows[0];
      const codigoOS = original.codigo_os;

      // 2. Cancela a entrega atual (sem reabrir Mapp ainda — vamos redespachar já)
      if (!['cancelado', 'canceled', 'delivered', 'fallback_fila'].includes(original.status_uber)) {
        await orch.cancel(entregaId, {
          motivo: motivo || 'Redespacho solicitado',
          canceladoPor: 'operador',
          reabrirMapp: false,        // não reabre — vamos despachar de novo agora
          eventSource: EventSource.API,
        });
      }

      // 3. Busca o serviço atualizado na Mapp e despacha de novo
      const servicos = await getMappClient(pool).listarServicos(0, 0);
      const servico = servicos.find(s => Number(s.codigoOS) === Number(codigoOS));
      if (!servico) {
        // A OS não está mais aberta na Mapp — reabre só pra registrar e avisa
        await getMappClient(pool).alterarStatus(codigoOS, 0).catch(() => {});
        return res.status(409).json({
          error: `OS ${codigoOS} não está mais disponível na Mapp para redespacho`,
          entrega_cancelada: entregaId,
        });
      }

      const novoRegistro = await orch.dispatch(servico, {
        providerCode,
        vehicleType,
        regraId: original.regra_id || null,
        eventSource: EventSource.API,
      });

      if (!novoRegistro) {
        return res.status(409).json({
          error: 'Redespacho falhou (OS já tem entrega ativa ou erro no despacho)',
          entrega_cancelada: entregaId,
        });
      }

      res.json({
        success: true,
        entrega_anterior: entregaId,
        entrega_nova: novoRegistro.id,
        registro: novoRegistro,
      });
    } catch (err) {
      console.error('[logistics/routes] POST /deliveries/:id/redispatch erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /_admin/resync-deliveries  — re-roda o backfill sob demanda (Fase 2)
  // ───────────────────────────────────────────────────────────
  router.post('/_admin/resync-deliveries', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const resultado = await initLogisticsBackfill(pool);
      res.json({ success: true, ...resultado });
    } catch (err) {
      console.error('[logistics/routes] resync-deliveries erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────
  // CRUD de dispatch-rules (Fase 2) — sub-router dedicado
  // ───────────────────────────────────────────────────────────
  router.use(createDispatchRulesRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria));

  // ───────────────────────────────────────────────────────────
  // Dashboard /metrics e /events (Fase 4) — sub-router dedicado
  // ───────────────────────────────────────────────────────────
  router.use(createDashboardRoutes(pool, verificarToken, verificarAdmin));

  // ═══════════════════════════════════════════════════════════
  // 🆕 2026-05 FASE 6 — Endpoints portados de /api/uber/* pro hub.
  // Leem logistics_deliveries (canônico). Mantêm o MESMO shape de
  // resposta dos endpoints /uber/* legados — assim o frontend só
  // troca o caminho da URL, sem mudar como consome os dados.
  // ═══════════════════════════════════════════════════════════

  // GET /dashboard/metricas — agregados do período (porta /uber/metricas)
  router.get('/dashboard/metricas', verificarToken, async (req, res) => {
    try {
      const { data_inicio, data_fim } = req.query;
      const inicio = data_inicio || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const fim = data_fim || new Date().toISOString().slice(0, 10);

      // status terminal no canônico: DELIVERED / CANCELED. Mantém as chaves
      // de resposta legadas (valor_*_uber) pro frontend não precisar mudar.
      const { rows: [metricas] } = await pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status_canonico = 'DELIVERED') AS entregues,
          COUNT(*) FILTER (WHERE status_canonico = 'CANCELED' OR cancelado_por IS NOT NULL) AS cancelados,
          COUNT(*) FILTER (WHERE status_native = 'fallback_fila') AS fallback,
          COUNT(*) FILTER (WHERE status_canonico NOT IN ('DELIVERED','CANCELED')
                             AND status_native IS DISTINCT FROM 'fallback_fila'
                             AND cancelado_por IS NULL) AS em_andamento,
          COALESCE(AVG(valor_provider), 0) AS valor_medio_uber,
          COALESCE(AVG(eta_minutos), 0) AS eta_medio,
          COALESCE(SUM(valor_provider), 0) AS custo_total_uber
        FROM logistics_deliveries
        WHERE created_at >= $1 AND created_at <= $2
      `, [inicio, fim + ' 23:59:59']);

      res.json({ success: true, metricas, periodo: { inicio, fim } });
    } catch (err) {
      console.error('[logistics/routes] GET /dashboard/metricas erro:', err.message);
      res.status(500).json({ error: 'Erro ao calcular métricas' });
    }
  });

  // GET /dashboard/margem-clientes — margem por cliente (porta /uber/dashboard/margem-clientes)
  router.get('/dashboard/margem-clientes', verificarToken, async (req, res) => {
    try {
      const { periodo = '7d', inicio, fim } = req.query;
      const dataFim = fim ? new Date(fim + ' 23:59:59') : new Date();
      let dataInicio;
      if (periodo === '1d')      { dataInicio = new Date(); dataInicio.setHours(0,0,0,0); }
      else if (periodo === '30d') { dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate() - 30); }
      else if (periodo === 'custom' && inicio) { dataInicio = new Date(inicio + ' 00:00:00'); }
      else { dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate() - 7); }

      const { rows: porCliente } = await pool.query(`
        SELECT
          COALESCE(r.cliente_nome, 'Manual / sem regra') AS cliente,
          ld.regra_id,
          COUNT(*) AS qtd,
          COUNT(*) FILTER (WHERE ld.status_canonico = 'CANCELED') AS cancelados,
          COALESCE(SUM(ld.valor_servico), 0)::numeric AS receita_total,
          COALESCE(SUM(ld.valor_provider), 0)::numeric AS custo_uber_total,
          COALESCE(SUM(ld.valor_servico - ld.valor_provider), 0)::numeric AS margem_total,
          COALESCE(AVG(ld.valor_servico - ld.valor_provider), 0)::numeric AS margem_media
        FROM logistics_deliveries ld
        LEFT JOIN logistics_dispatch_rules r ON r.id = ld.regra_id
        WHERE ld.created_at BETWEEN $1 AND $2 AND ld.valor_provider IS NOT NULL
        GROUP BY r.cliente_nome, ld.regra_id
        ORDER BY margem_total DESC
      `, [dataInicio, dataFim]);

      const { rows: porDia } = await pool.query(`
        SELECT DATE(ld.created_at) AS dia, COUNT(*) AS qtd,
               COALESCE(SUM(ld.valor_servico - ld.valor_provider), 0)::numeric AS margem
        FROM logistics_deliveries ld
        WHERE ld.created_at BETWEEN $1 AND $2 AND ld.valor_provider IS NOT NULL
        GROUP BY DATE(ld.created_at) ORDER BY dia ASC
      `, [dataInicio, dataFim]);

      const { rows: [totais] } = await pool.query(`
        SELECT COUNT(*)::int AS qtd_total,
               COALESCE(SUM(valor_servico), 0)::numeric AS receita,
               COALESCE(SUM(valor_provider), 0)::numeric AS custo,
               COALESCE(SUM(valor_servico - valor_provider), 0)::numeric AS margem
        FROM logistics_deliveries
        WHERE created_at BETWEEN $1 AND $2 AND valor_provider IS NOT NULL
      `, [dataInicio, dataFim]);

      res.json({
        success: true,
        periodo: { tipo: periodo, inicio: dataInicio, fim: dataFim },
        totais,
        por_cliente: porCliente.map(r => ({
          ...r,
          margem_pct: r.receita_total > 0
            ? (parseFloat(r.margem_total) / parseFloat(r.receita_total)) * 100 : 0,
          taxa_cancelamento: r.qtd > 0
            ? (parseFloat(r.cancelados) / parseFloat(r.qtd)) * 100 : 0,
        })),
        por_dia: porDia,
      });
    } catch (err) {
      console.error('[logistics/routes] GET /dashboard/margem-clientes erro:', err.message);
      res.status(500).json({ error: 'Erro ao buscar dashboard de margem' });
    }
  });

  // GET /tracking/ativas — entregas em andamento + última posição (porta /uber/tracking/ativas)
  router.get('/tracking/ativas', verificarToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT ld.*, r.cliente_nome AS cliente_nome_regra,
          (SELECT jsonb_build_object('lat', t.latitude, 'lng', t.longitude, 'at', t.created_at)
           FROM logistics_tracking t
           WHERE t.codigo_os = ld.codigo_os
           ORDER BY t.created_at DESC LIMIT 1) AS ultima_posicao
        FROM logistics_deliveries ld
        LEFT JOIN logistics_dispatch_rules r ON r.id = ld.regra_id
        WHERE ld.status_canonico NOT IN ('DELIVERED','CANCELED','FAILED','RETURNED')
          AND ld.cancelado_por IS NULL
        ORDER BY ld.created_at DESC
      `);
      res.json({
        success: true,
        total: rows.length,
        entregas: rows.map(r => ({ ...mapearCanonicoParaLegado(r), ultima_posicao: r.ultima_posicao })),
      });
    } catch (err) {
      console.error('[logistics/routes] GET /tracking/ativas erro:', err.message);
      res.status(500).json({ error: 'Erro ao buscar entregas ativas' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // PUT /providers/:code  — configura o provider (Fase 5)
  // É o equivalente do hub ao PUT /uber/config: o painel salva aqui.
  //  - merge da config (chave de segredo vazia = preserva a atual)
  //  - atualiza ativo / sandbox_mode / prioridade / webhook_secret
  //  - registry.reload(code) → adapter sobe/cai NA HORA, sem restart
  // body: { ativo?, sandbox_mode?, prioridade?, webhook_secret?, config? }
  // ───────────────────────────────────────────────────────────
  router.put('/providers/:code', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const code = req.params.code;
      const { ativo, sandbox_mode, prioridade, config, webhook_secret } = req.body || {};

      const atual = await pool.query(
        'SELECT * FROM logistics_providers WHERE provider_code = $1',
        [code]
      );
      if (atual.rows.length === 0) {
        return res.status(404).json({ error: 'Provider nao encontrado' });
      }
      const row = atual.rows[0];

      // Detector de máscara — string só de bolinhas/asteriscos/traços (placeholder
      // de campo de segredo). Mesma lógica do PUT /uber/config.
      const ehMascara = (v) =>
        typeof v === 'string' && /^[•·●○*–\-\u2022\u00b7]+$/.test(v.trim());
      // Segredo só é gravado se for valor REAL — não vazio, não máscara.
      const valorSecretoValido = (v) =>
        typeof v === 'string' && v.trim() !== '' && !ehMascara(v);

      // Chaves de config tratadas como SEGREDO: vazio = preserva a atual.
      // Cobre uber (client_secret/mapp_api_token) e 99 (api_key/webhook_password).
      const SECRET_KEYS = [
        'api_key', 'client_secret', 'mapp_api_token',
        'webhook_secret', 'webhook_password',
      ];

      // Merge da config: parte do que já existe, aplica só o que veio.
      const configFinal = { ...(row.config || {}) };
      let configMudou = false;
      if (config && typeof config === 'object' && !Array.isArray(config)) {
        for (const [k, v] of Object.entries(config)) {
          if (SECRET_KEYS.includes(k)) {
            // segredo: só sobrescreve com valor real; vazio/máscara → preserva
            if (valorSecretoValido(v)) { configFinal[k] = v.trim(); configMudou = true; }
          } else {
            // campo comum: sobrescreve como veio (permite inclusive limpar)
            configFinal[k] = v;
            configMudou = true;
          }
        }
      }

      // UPDATE dinâmico — só toca no que foi enviado.
      const campos = [];
      const valores = [];
      let idx = 1;

      if (typeof ativo === 'boolean') {
        campos.push(`ativo = $${idx++}`); valores.push(ativo);
      }
      if (typeof sandbox_mode === 'boolean') {
        campos.push(`sandbox_mode = $${idx++}`); valores.push(sandbox_mode);
      }
      if (prioridade !== undefined && prioridade !== null && Number.isFinite(Number(prioridade))) {
        campos.push(`prioridade = $${idx++}`); valores.push(parseInt(prioridade, 10));
      }
      if (configMudou) {
        campos.push(`config = $${idx++}::jsonb`); valores.push(JSON.stringify(configFinal));
      }
      // webhook_secret é coluna top-level (uber usa HMAC; 99 não) — só grava valor real
      if (valorSecretoValido(webhook_secret)) {
        campos.push(`webhook_secret = $${idx++}`); valores.push(webhook_secret.trim());
      }

      if (campos.length === 0) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar' });
      }

      campos.push('updated_at = NOW()');
      valores.push(code);

      await pool.query(
        `UPDATE logistics_providers SET ${campos.join(', ')} WHERE provider_code = $${idx}`,
        valores
      );

      // Recarrega o adapter no registry: instancia se ativo, descarta se inativo.
      // Sem isso a mudança só valeria no próximo restart do backend.
      await registry.reload(code).catch(err => {
        console.error(`[logistics/routes] reload de '${code}' falhou:`, err.message);
      });

      if (registrarAuditoria) {
        await registrarAuditoria(req, 'ATUALIZAR_PROVIDER_LOGISTICS', 'config',
          'logistics_providers', row.id,
          { provider: code, campos_atualizados: campos.length - 1 })
          .catch(() => {});
      }

      // Estado pós-reload — o painel usa pra mostrar se o adapter realmente subiu.
      const depois = await pool.query(
        `SELECT provider_code, display_name, ativo, sandbox_mode, prioridade
           FROM logistics_providers WHERE provider_code = $1`,
        [code]
      );
      const p = depois.rows[0];

      res.json({
        success: true,
        provider: { ...p, instanciado: registry.has(code) },
        // Marcado ativo mas o adapter não subiu = config provavelmente incompleta.
        aviso: (p.ativo && !registry.has(code))
          ? 'Provider marcado como ativo, mas o adapter nao foi instanciado — confira se a config esta completa (ex: api_key da 99) e veja os logs do Railway.'
          : null,
      });
    } catch (err) {
      console.error('[logistics/routes] erro PUT /providers/:code:', err.message);
      res.status(500).json({ error: 'Erro ao atualizar provider' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // Endpoints ainda pendentes
  // ───────────────────────────────────────────────────────────
  router.get('/deliveries/:id/tracking', verificarToken, notImplemented('Fase 5'));

  return router;
}

module.exports = { createLogisticsRouter };
