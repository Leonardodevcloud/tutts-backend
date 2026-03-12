/**
 * MÓDULO PERFORMANCE DIÁRIA - Routes
 *
 * GET  /performance/snapshot          último snapshot
 * GET  /performance/historico         histórico por período
 * POST /performance/executar          dispara job manual
 * GET  /performance/jobs              lista jobs recentes
 * GET  /performance/jobs/:id          detalhe de um job
 * GET  /performance/clientes          lista clientes disponíveis nos snapshots
 */

'use strict';

const express = require('express');

function createPerformanceRouter(pool, verificarToken) {
  const router = express.Router();

  // ⚠️  NÃO aplicar router.use(verificarToken) aqui!
  // O server.js já aplica verificarToken como middleware antes de montar este router:
  //   app.use('/api', verificarToken, initPerformanceRoutes(pool, verificarToken));
  // Duplicar causava double-auth e inconsistências.

  // ── GET /performance/snapshot ──────────────────────────────────────────────
  // Retorna o snapshot mais recente (opcionalmente filtrado)
  router.get('/performance/snapshot', async (req, res) => {
    try {
      const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;

      const conditions = [];
      const params     = [];

      if (data_inicio) {
        params.push(data_inicio);
        conditions.push(`data_inicio >= $${params.length}`);
      }
      if (data_fim) {
        params.push(data_fim);
        conditions.push(`data_fim <= $${params.length}`);
      }
      if (cod_cliente) {
        params.push(parseInt(cod_cliente));
        conditions.push(`cod_cliente = $${params.length}`);
      }
      if (centro_custo) {
        params.push(centro_custo);
        conditions.push(`centro_custo = $${params.length}`);
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

      const { rows } = await pool.query(`
        SELECT
          id, job_id, data_inicio, data_fim, cod_cliente, centro_custo,
          total_os, no_prazo, fora_prazo, sem_dados, pct_no_prazo,
          registros, criado_em
        FROM performance_snapshots
        ${where}
        ORDER BY criado_em DESC
        LIMIT 1
      `, params);

      if (!rows.length) {
        return res.json({ snapshot: null, mensagem: 'Nenhum snapshot disponível' });
      }

      const snap = rows[0];

      // Agrupa registros por cliente
      const porCliente = {};
      (snap.registros || []).forEach(r => {
        const key = r.cod_cliente ?? '__sem__';
        if (!porCliente[key]) {
          porCliente[key] = {
            cod_cliente:  r.cod_cliente,
            // FIX: campo correto é nome_cliente (ou cliente_txt), não "cliente"
            nome_cliente: r.nome_cliente || (r.cliente_txt || '').replace(/^\s*\d+\s*[-–]\s*/, '').trim(),
            total: 0, no_prazo: 0, fora_prazo: 0, sem_dados: 0,
          };
        }
        porCliente[key].total++;
        if (r.sem_dados)         porCliente[key].sem_dados++;
        else if (r.sla_no_prazo) porCliente[key].no_prazo++;
        else                     porCliente[key].fora_prazo++;
      });

      // Calcula pct_no_prazo por cliente
      const clientesArray = Object.values(porCliente).map(c => {
        const analisados = c.total - c.sem_dados;
        return {
          ...c,
          pct_no_prazo: analisados > 0
            ? parseFloat(((c.no_prazo / analisados) * 100).toFixed(2))
            : 0,
        };
      }).sort((a, b) => b.total - a.total);

      res.json({
        snapshot: {
          ...snap,
          registros: undefined,   // não envia o array completo no resumo
        },
        por_cliente: clientesArray,
        registros:   snap.registros,  // envia separado para quem precisar
      });
    } catch (err) {
      console.error('❌ /performance/snapshot:', err);
      res.status(500).json({ error: 'Erro ao buscar snapshot' });
    }
  });

  // ── GET /performance/historico ─────────────────────────────────────────────
  router.get('/performance/historico', async (req, res) => {
    try {
      const { data_inicio, data_fim, cod_cliente } = req.query;
      const params = [];
      const conds  = [];

      if (data_inicio) { params.push(data_inicio); conds.push(`data_inicio >= $${params.length}`); }
      if (data_fim)    { params.push(data_fim);     conds.push(`data_fim <= $${params.length}`);   }
      if (cod_cliente) { params.push(parseInt(cod_cliente)); conds.push(`cod_cliente = $${params.length}`); }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

      const { rows } = await pool.query(`
        SELECT
          id, data_inicio, data_fim, cod_cliente, centro_custo,
          total_os, no_prazo, fora_prazo, sem_dados, pct_no_prazo, criado_em
        FROM performance_snapshots
        ${where}
        ORDER BY criado_em DESC
        LIMIT 90
      `, params);

      res.json({ historico: rows });
    } catch (err) {
      console.error('❌ /performance/historico:', err);
      res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
  });

  // ── POST /performance/executar ─────────────────────────────────────────────
  // Cria um job manual — o worker pega em até 5min
  router.post('/performance/executar', async (req, res) => {
    try {
      const { data_inicio, data_fim, cod_cliente, centro_custo } = req.body;

      if (!data_inicio || !data_fim) {
        return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórios (YYYY-MM-DD)' });
      }

      // Verifica se já tem job pendente/executando igual
      const { rows: existente } = await pool.query(`
        SELECT id FROM performance_jobs
        WHERE data_inicio    = $1
          AND data_fim       = $2
          AND status IN ('pendente', 'executando')
          AND (cod_cliente   = $3 OR ($3 IS NULL AND cod_cliente IS NULL))
          AND (centro_custo  = $4 OR ($4 IS NULL AND centro_custo IS NULL))
        LIMIT 1
      `, [data_inicio, data_fim, cod_cliente || null, centro_custo || null]);

      if (existente.length) {
        return res.json({
          job_id: existente[0].id,
          mensagem: 'Já existe um job em andamento para esses filtros',
          ja_existia: true,
        });
      }

      const { rows } = await pool.query(`
        INSERT INTO performance_jobs
          (data_inicio, data_fim, cod_cliente, centro_custo, status, origem)
        VALUES ($1, $2, $3, $4, 'pendente', 'manual')
        RETURNING id
      `, [data_inicio, data_fim, cod_cliente || null, centro_custo || null]);

      res.json({ job_id: rows[0].id, mensagem: 'Job criado — será processado em até 5 minutos' });
    } catch (err) {
      console.error('❌ /performance/executar:', err);
      res.status(500).json({ error: 'Erro ao criar job' });
    }
  });

  // ── GET /performance/jobs ──────────────────────────────────────────────────
  router.get('/performance/jobs', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, status, data_inicio, data_fim, cod_cliente, centro_custo,
               iniciado_em, concluido_em, erro, total_os, origem
        FROM performance_jobs
        ORDER BY iniciado_em DESC
        LIMIT 50
      `);
      res.json({ jobs: rows });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao listar jobs' });
    }
  });

  // ── GET /performance/jobs/:id ──────────────────────────────────────────────
  router.get('/performance/jobs/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT j.*, s.pct_no_prazo, s.total_os AS snap_total, s.no_prazo, s.fora_prazo
        FROM performance_jobs j
        LEFT JOIN performance_snapshots s ON s.job_id = j.id
        WHERE j.id = $1
      `, [req.params.id]);

      if (!rows.length) return res.status(404).json({ error: 'Job não encontrado' });
      res.json({ job: rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar job' });
    }
  });

  // ── GET /performance/clientes ──────────────────────────────────────────────
  // Lista clientes que aparecem nos snapshots (para o filtro do front)
  router.get('/performance/clientes', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT cod_cliente, centro_custo
        FROM performance_snapshots
        WHERE cod_cliente IS NOT NULL
        ORDER BY cod_cliente
      `);
      res.json({ clientes: rows });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao listar clientes' });
    }
  });

  console.log('✅ Módulo Performance Diária — rotas montadas (6 endpoints)');
  return router;
}

module.exports = { createPerformanceRouter };
