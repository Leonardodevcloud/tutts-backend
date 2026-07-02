'use strict';

/**
 * routes/sla-monitor.routes.js
 *
 * Endpoints:
 *   GET  /agent/sla-monitor/status        (extensão v9 — Origin tutts.com.br + x-sla-token opcional)
 *   GET  /agent/sla-monitor/prazos        (admin — visualizar config de prazos)
 *   PUT  /agent/sla-monitor/prazos-fixos  (admin — upsert prazo fixo por cliente)
 *
 * O /status segue o MESMO modelo de segurança do antigo /sla-capture/trigger:
 * validação de Origin/Referer (content script roda em tutts.com.br) + token
 * compartilhado opcional via header x-sla-token (env SLA_MONITOR_TOKEN, com
 * fallback pra SLA_CAPTURE_TOKEN já existente). Também aceita JWT de admin
 * (pro futuro painel na Central Tutts consumir o mesmo endpoint).
 */

const express = require('express');
const slaMonitorService = require('../sla-monitor.service');

// Origens permitidas — content script da extensão roda dentro do MAP
const ORIGENS_VALIDAS = [
  'https://tutts.com.br',
  'https://www.tutts.com.br',
];

function validarOrigem(req) {
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  if (ORIGENS_VALIDAS.includes(origin)) return true;
  return ORIGENS_VALIDAS.some((o) => referer.startsWith(o));
}

function validarTokenSla(req) {
  const tokenEsperado = process.env.SLA_MONITOR_TOKEN || process.env.SLA_CAPTURE_TOKEN;
  if (!tokenEsperado) return true; // não configurado → validação desativada
  const recebido = req.headers['x-sla-token'] || '';
  return recebido === tokenEsperado;
}

function createSlaMonitorRoutes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // ──────────────────────────────────────────────────────────────────────
  // GET /agent/sla-monitor/status
  // Consumido pela extensão v9 (thin client) e futuramente pela aba SLA
  // da Central Tutts. Retorna todas as OS em execução com status calculado.
  // ──────────────────────────────────────────────────────────────────────
  router.get('/sla-monitor/status', async (req, res) => {
    try {
      // Caminho 1: extensão (Origin do MAP + token compartilhado)
      const extensaoOk = validarOrigem(req) && validarTokenSla(req);
      // Caminho 2: token compartilhado puro (curl/testes/painel worker)
      const tokenPuroOk = !!(process.env.SLA_MONITOR_TOKEN || process.env.SLA_CAPTURE_TOKEN)
        && validarTokenSla(req)
        && !!req.headers['x-sla-token'];

      if (!extensaoOk && !tokenPuroOk) {
        return res.status(403).json({ ok: false, erro: 'Origem ou token inválido.' });
      }

      const painel = await slaMonitorService.consultarStatus(pool, {
        // ?finalizadas=1&horas=24 → inclui concluídas com veredito
        // CONCLUIDA_NO_PRAZO / CONCLUIDA_ATRASADA (badge aba Concluídos)
        incluirFinalizadas: req.query.finalizadas === '1' || req.query.finalizadas === 'true',
        horasFinalizadas: req.query.horas,
      });
      return res.json({ ok: true, ...painel });
    } catch (err) {
      console.error('[sla-monitor/status] erro:', err);
      return res.status(500).json({ ok: false, erro: 'Erro interno ao consultar status SLA.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /agent/sla-monitor/performance   (admin)
  // Performance diária de SLA agregada do histórico do snapshot.
  // Query: ?dias=7&agrupar=cliente|profissional
  // ──────────────────────────────────────────────────────────────────────
  router.get('/sla-monitor/performance', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const resultado = await slaMonitorService.performanceDiaria(pool, {
        dias: req.query.dias,
        agruparPor: req.query.agrupar === 'profissional' ? 'profissional' : 'cliente',
      });
      return res.json({ ok: true, ...resultado });
    } catch (err) {
      console.error('[sla-monitor/performance] erro:', err);
      return res.status(500).json({ ok: false, erro: 'Erro ao calcular performance diária.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /agent/sla-monitor/prazos   (admin)
  // ──────────────────────────────────────────────────────────────────────
  router.get('/sla-monitor/prazos', verificarToken, verificarAdmin, async (_req, res) => {
    try {
      const prazos = await slaMonitorService.carregarPrazos(pool);
      return res.json({ ok: true, ...prazos });
    } catch (err) {
      console.error('[sla-monitor/prazos] erro:', err);
      return res.status(500).json({ ok: false, erro: 'Erro ao carregar prazos.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // PUT /agent/sla-monitor/prazos-fixos   (admin)
  // Body: { cliente_cod: '767', prazo_min: 120, ativo: true }
  // Muda regra de SLA sem deploy — a mudança vale no próximo tick (cache 60s).
  // ──────────────────────────────────────────────────────────────────────
  router.put('/sla-monitor/prazos-fixos', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cliente_cod, prazo_min, ativo } = req.body || {};
      if (!cliente_cod || !/^\d{2,5}$/.test(String(cliente_cod))) {
        return res.status(400).json({ ok: false, erro: 'cliente_cod inválido.' });
      }
      const prazo = parseInt(prazo_min, 10);
      if (!prazo || prazo < 1 || prazo > 1440) {
        return res.status(400).json({ ok: false, erro: 'prazo_min deve estar entre 1 e 1440.' });
      }

      await pool.query(
        `INSERT INTO sla_monitor_prazos_fixos (cliente_cod, prazo_min, ativo)
         VALUES ($1, $2, $3)
         ON CONFLICT (cliente_cod) DO UPDATE SET
           prazo_min = EXCLUDED.prazo_min,
           ativo     = EXCLUDED.ativo`,
        [String(cliente_cod), prazo, ativo !== false]
      );

      slaMonitorService.limparCachePrazos();
      return res.json({ ok: true, cliente_cod: String(cliente_cod), prazo_min: prazo, ativo: ativo !== false });
    } catch (err) {
      console.error('[sla-monitor/prazos-fixos] erro:', err);
      return res.status(500).json({ ok: false, erro: 'Erro ao salvar prazo fixo.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 🆕 v2.5: CENTROS POR TERMOS DE ENDEREÇO (admin)
  // Mesmo padrão dos filtros do rastreio-clientes: se o texto da linha da
  // OS contém o TERMO, ela recebe o CENTRO. Editável sem deploy.
  // ──────────────────────────────────────────────────────────────────────

  // GET /agent/sla-monitor/centros-termos — listar
  router.get('/sla-monitor/centros-termos', verificarToken, verificarAdmin, async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, cliente_cod, termo, centro_nome, ativo, criado_em
           FROM sla_monitor_centros_termos
          ORDER BY cliente_cod, centro_nome, termo`
      );
      return res.json({ ok: true, termos: rows });
    } catch (err) {
      console.error('[sla-monitor/centros-termos GET] erro:', err);
      return res.status(500).json({ ok: false, erro: 'Erro ao listar termos.' });
    }
  });

  // PUT /agent/sla-monitor/centros-termos — upsert
  // Body: { cliente_cod: '767', termo: 'GALBA', centro_nome: 'Comollati Alagoas', ativo: true }
  router.put('/sla-monitor/centros-termos', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cliente_cod, termo, centro_nome, ativo } = req.body || {};
      if (!cliente_cod || !/^\d{2,5}$/.test(String(cliente_cod))) {
        return res.status(400).json({ ok: false, erro: 'cliente_cod inválido.' });
      }
      const termoLimpo = String(termo || '').trim();
      const centroLimpo = String(centro_nome || '').trim();
      if (termoLimpo.length < 3 || termoLimpo.length > 255) {
        return res.status(400).json({ ok: false, erro: 'termo deve ter entre 3 e 255 caracteres.' });
      }
      if (!centroLimpo || centroLimpo.length > 255) {
        return res.status(400).json({ ok: false, erro: 'centro_nome obrigatório (até 255 caracteres).' });
      }

      const { rows: [row] } = await pool.query(
        `INSERT INTO sla_monitor_centros_termos (cliente_cod, termo, centro_nome, ativo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cliente_cod, termo) DO UPDATE SET
           centro_nome = EXCLUDED.centro_nome,
           ativo       = EXCLUDED.ativo
         RETURNING id, cliente_cod, termo, centro_nome, ativo`,
        [String(cliente_cod), termoLimpo, centroLimpo, ativo !== false]
      );

      slaMonitorService.limparCacheTermos();
      return res.json({ ok: true, termo: row });
    } catch (err) {
      console.error('[sla-monitor/centros-termos PUT] erro:', err);
      return res.status(500).json({ ok: false, erro: 'Erro ao salvar termo.' });
    }
  });

  // DELETE /agent/sla-monitor/centros-termos/:id
  router.delete('/sla-monitor/centros-termos/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id || id < 1) return res.status(400).json({ ok: false, erro: 'id inválido.' });
      const r = await pool.query('DELETE FROM sla_monitor_centros_termos WHERE id = $1', [id]);
      slaMonitorService.limparCacheTermos();
      return res.json({ ok: true, removidos: r.rowCount || 0 });
    } catch (err) {
      console.error('[sla-monitor/centros-termos DELETE] erro:', err);
      return res.status(500).json({ ok: false, erro: 'Erro ao remover termo.' });
    }
  });

  return router;
}

module.exports = { createSlaMonitorRoutes };
