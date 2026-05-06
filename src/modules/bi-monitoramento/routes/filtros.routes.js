/**
 * BI Monitoramento - Dados para Filtros Inteligentes
 *
 * Replica os endpoints que o modal de filtros do BI principal consome,
 * pra que o frontend não precise depender de rotas /bi/* (que tem
 * permissões diferentes e expõem campos financeiros).
 */
const express = require('express');

function createFiltrosRoutes(pool) {
  const router = express.Router();

  router.get('/bi-monitoramento/regioes-cadastradas', async (req, res) => {
    try {
      const result = await pool.query('SELECT id, nome FROM bi_regioes ORDER BY nome');
      res.json(result.rows);
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro regioes-cadastradas:', err);
      res.json([]);
    }
  });

  router.get('/bi-monitoramento/categorias', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DISTINCT categoria
        FROM bi_entregas
        WHERE categoria IS NOT NULL AND categoria <> ''
        ORDER BY categoria
      `);
      res.json(result.rows.map(r => r.categoria));
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro categorias:', err);
      res.json([]);
    }
  });

  router.get('/bi-monitoramento/dados-filtro', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DISTINCT cod_cliente, centro_custo, categoria, MAX(nome_fantasia) as nome_fantasia
        FROM bi_entregas
        WHERE cod_cliente IS NOT NULL
        GROUP BY cod_cliente, centro_custo, categoria
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro dados-filtro:', err);
      res.json([]);
    }
  });

  router.get('/bi-monitoramento/clientes', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          cod_cliente,
          MAX(nome_fantasia) as nome_fantasia
        FROM bi_entregas
        WHERE cod_cliente IS NOT NULL
        GROUP BY cod_cliente
        ORDER BY nome_fantasia
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro clientes:', err);
      res.json([]);
    }
  });

  router.get('/bi-monitoramento/centros-custo', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DISTINCT centro_custo
        FROM bi_entregas
        WHERE centro_custo IS NOT NULL AND centro_custo <> ''
        ORDER BY centro_custo
      `);
      res.json(result.rows.map(r => r.centro_custo));
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro centros-custo:', err);
      res.json([]);
    }
  });

  /**
   * GET /api/bi-monitoramento/info
   * Devolve metadados úteis pro header do módulo (data dos dados, última leitura).
   */
  router.get('/bi-monitoramento/info', async (req, res) => {
    try {
      const r = await pool.query(`
        SELECT
          MAX(data_solicitado) as ultima_data,
          MIN(data_solicitado) as primeira_data,
          COUNT(*) as total_registros
        FROM bi_entregas
      `);
      res.json(r.rows[0] || {});
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro info:', err);
      res.json({});
    }
  });

  return router;
}

module.exports = { createFiltrosRoutes };
