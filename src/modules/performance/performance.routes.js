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

  // ── AUTO-CREATE: performance_config ──────────────────────────────────────────
  pool.query(`
    CREATE TABLE IF NOT EXISTS performance_config (
      id            SERIAL PRIMARY KEY,
      cod_cliente   INTEGER NOT NULL,
      nome_display  VARCHAR(255),
      centro_custo  VARCHAR(255),
      ativo         BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `).then(() => {
    pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_config_unico ON performance_config(cod_cliente, COALESCE(centro_custo, '__todos__'))`).catch(() => {});
  }).catch(err => console.log('⚠️ performance_config:', err.message));

  // ── GET /performance/config ───────────────────────────────────────────────
  router.get('/performance/config', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.*, m.mascara
        FROM performance_config c
        LEFT JOIN bi_mascaras m ON m.cod_cliente = c.cod_cliente::text
        WHERE c.ativo = true
        ORDER BY c.nome_display, c.centro_custo
      `);
      res.json({ configs: rows });
    } catch (err) {
      console.error('❌ /performance/config GET:', err);
      res.status(500).json({ error: 'Erro ao listar configurações' });
    }
  });

  // ── POST /performance/config ──────────────────────────────────────────────
  router.post('/performance/config', async (req, res) => {
    try {
      const { cod_cliente, nome_display, centro_custo } = req.body;
      if (!cod_cliente) return res.status(400).json({ error: 'cod_cliente é obrigatório' });

      const { rows } = await pool.query(`
        INSERT INTO performance_config (cod_cliente, nome_display, centro_custo)
        VALUES ($1, $2, $3)
        ON CONFLICT (cod_cliente, COALESCE(centro_custo, '__todos__')) DO UPDATE SET
          nome_display = COALESCE(EXCLUDED.nome_display, performance_config.nome_display),
          ativo = true
        RETURNING *
      `, [parseInt(cod_cliente), nome_display || null, centro_custo || null]);

      console.log(`✅ Performance config adicionado: ${cod_cliente} / ${centro_custo || 'Todos'}`);
      res.json({ success: true, config: rows[0] });
    } catch (err) {
      console.error('❌ /performance/config POST:', err);
      res.status(500).json({ error: 'Erro ao salvar configuração' });
    }
  });

  // ── DELETE /performance/config/:id ────────────────────────────────────────
  router.delete('/performance/config/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM performance_config WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao excluir configuração' });
    }
  });

  // ── GET /performance/dashboard ────────────────────────────────────────────
  // Retorna todos os configs com o snapshot mais recente de cada um
  router.get('/performance/dashboard', async (req, res) => {
    try {
      const { data_inicio, data_fim } = req.query;
      const di = data_inicio || new Date().toISOString().slice(0, 10);
      const df = data_fim || di;

      const { rows: configs } = await pool.query(`
        SELECT c.*, m.mascara
        FROM performance_config c
        LEFT JOIN bi_mascaras m ON m.cod_cliente = c.cod_cliente::text
        WHERE c.ativo = true
        ORDER BY c.nome_display, c.centro_custo
      `);

      // Para cada config, buscar snapshot mais recente
      const cards = await Promise.all(configs.map(async (cfg) => {
        const conditions = ['data_inicio >= $1', 'data_fim <= $2', 'cod_cliente = $3'];
        const params = [di, df, cfg.cod_cliente];
        if (cfg.centro_custo) {
          conditions.push('centro_custo = $4');
          params.push(cfg.centro_custo);
        }

        const { rows } = await pool.query(`
          SELECT id, total_os, no_prazo, fora_prazo, sem_dados, pct_no_prazo, criado_em, registros
          FROM performance_snapshots
          WHERE ${conditions.join(' AND ')}
          ORDER BY criado_em DESC
          LIMIT 1
        `, params);

        const snap = rows[0] || null;
        return {
          config: cfg,
          nome_display: cfg.mascara || cfg.nome_display || `Cliente ${cfg.cod_cliente}`,
          cod_cliente: cfg.cod_cliente,
          centro_custo: cfg.centro_custo,
          snapshot: snap ? {
            id: snap.id,
            total_os: snap.total_os,
            no_prazo: snap.no_prazo,
            fora_prazo: snap.fora_prazo,
            sem_dados: snap.sem_dados,
            pct_no_prazo: snap.pct_no_prazo,
            criado_em: snap.criado_em,
          } : null,
          registros: snap?.registros || [],
        };
      }));

      res.json({ cards, data_inicio: di, data_fim: df });
    } catch (err) {
      console.error('❌ /performance/dashboard:', err);
      res.status(500).json({ error: 'Erro ao carregar dashboard' });
    }
  });

  console.log('✅ Módulo Performance Diária — rotas montadas (10 endpoints)');
  return router;
}

module.exports = { createPerformanceRouter };
