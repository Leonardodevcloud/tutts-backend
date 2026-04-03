/**
 * src/modules/bootstrap/bootstrap.routes.js
 * 🔒 SECURITY FIX (AUDIT-10): Lógica de negócio extraída do server.js
 * 
 * Rotas de inicialização e overrides que antes viviam inline no server.js.
 * Agora em módulo próprio para testabilidade e separação de responsabilidades.
 */

const express = require('express');

function createBootstrapRoutes(pool, verificarToken, verificarAdmin, verificarAdminOuFinanceiro) {
  const router = express.Router();

  // ⚡ PERFORMANCE: Endpoint consolidado para login — 1 chamada ao invés de 20
  router.get('/init', verificarToken, async (req, res) => {
    try {
      const { codProfissional, role } = req.user;
      
      const queries = [];
      
      queries.push(
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE status = 'pending' OR status = 'aguardando_aprovacao') as saques_pendentes,
                  COUNT(*) FILTER (WHERE status = 'pending') as gratuidades_pendentes
           FROM (
             SELECT status FROM withdrawal_requests WHERE status IN ('pending','aguardando_aprovacao') LIMIT 100
           ) w
           FULL OUTER JOIN (
             SELECT status FROM gratuities WHERE status = 'pending' LIMIT 100
           ) g ON false`
        ).catch(() => ({ rows: [{ saques_pendentes: 0, gratuidades_pendentes: 0 }] }))
      );
      
      queries.push(
        pool.query(
          `SELECT COUNT(*) as unread FROM social_messages 
           WHERE receiver_cod = $1 AND read = false`,
          [codProfissional]
        ).catch(() => ({ rows: [{ unread: 0 }] }))
      );
      
      queries.push(
        pool.query(
          `SELECT COUNT(*) as pendentes FROM todo_tarefas 
           WHERE status != 'concluido' 
           AND (criado_por = $1 OR responsaveis::text LIKE $2)
           LIMIT 1`,
          [codProfissional, `%${codProfissional}%`]
        ).catch(() => ({ rows: [{ pendentes: 0 }] }))
      );
      
      queries.push(
        pool.query(
          `SELECT display_name, bio, avatar_url, status_text FROM social_profiles WHERE user_cod = $1`,
          [codProfissional]
        ).catch(() => ({ rows: [] }))
      );
      
      const [countersRes, socialRes, todoRes, profileRes] = await Promise.all(queries);
      
      res.json({
        counters: {
          saquesPendentes: parseInt(countersRes.rows[0]?.saques_pendentes) || 0,
          gratuidadesPendentes: parseInt(countersRes.rows[0]?.gratuidades_pendentes) || 0,
          socialUnread: parseInt(socialRes.rows[0]?.unread) || 0,
          todoPendentes: parseInt(todoRes.rows[0]?.pendentes) || 0,
        },
        socialProfile: profileRes.rows[0] || null,
        role,
        codProfissional,
      });
    } catch (error) {
      console.error('❌ Erro no /api/init:', error.message);
      res.status(500).json({ error: 'Erro ao inicializar' });
    }
  });

  // ⚡ PERFORMANCE: Endpoint consolidado para módulo financeiro
  router.get('/financeiro/init', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const [pendentesRes, countRes, restrictedRes, pedidosRes, gratuidadesRes] = await Promise.all([
        pool.query(`SELECT * FROM withdrawal_requests WHERE status IN ('pending', 'aguardando_aprovacao') ORDER BY created_at DESC`),
        pool.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status IN ('pending','aguardando_aprovacao')) as aguardando,
            COUNT(*) FILTER (WHERE status = 'approved') as aprovadas,
            COUNT(*) FILTER (WHERE status = 'approved' AND tipo_pagamento = 'gratuidade') as gratuidade,
            COUNT(*) FILTER (WHERE status = 'rejected') as rejeitadas,
            COUNT(*) FILTER (WHERE status = 'inactive') as inativo,
            COUNT(*) FILTER (WHERE status IN ('pending','aguardando_aprovacao') AND created_at < NOW() - INTERVAL '1 hour') as atrasadas,
            COUNT(*) as total
          FROM withdrawal_requests WHERE created_at >= NOW() - INTERVAL '90 days'
        `),
        pool.query(`SELECT user_cod, reason FROM restricted_professionals WHERE status = 'ativo'`),
        pool.query(`SELECT * FROM loja_pedidos WHERE status = 'pendente' ORDER BY created_at DESC LIMIT 50`),
        pool.query(`SELECT * FROM gratuities WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`)
      ]);
      
      const restrictedMap = {};
      for (const r of restrictedRes.rows) restrictedMap[r.user_cod] = r.reason;
      const withdrawals = pendentesRes.rows.map(w => ({
        ...w, is_restricted: !!restrictedMap[w.user_cod], restriction_reason: restrictedMap[w.user_cod] || null,
      }));
      
      res.json({ withdrawals, counts: countRes.rows[0] || {}, pedidos: pedidosRes.rows, gratuidades: gratuidadesRes.rows });
    } catch (error) {
      console.error('❌ Erro /financeiro/init:', error.message);
      res.status(500).json({ error: 'Erro ao inicializar financeiro' });
    }
  });

  // ⚡ /api/withdrawals — CACHE 30s | Com filtro de data: SEM LIMIT | Sem filtro: SEM CAP
  let _wCache = { data: null, ts: 0, key: '' };
  router.get('/withdrawals', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const status = req.query.status || '';
      const dataInicio = req.query.dataInicio || '';
      const dataFim = req.query.dataFim || '';
      const tipoFiltro = req.query.tipoFiltro || 'solicitacao';
      const userCod = req.query.userCod || '';
      const comFiltroData = !!(dataInicio && dataFim);
      const limit = comFiltroData ? null : (parseInt(req.query.limit) || 999999);
      const offset = parseInt(req.query.offset) || 0;
      const ck = `${status}-${limit}-${offset}-${dataInicio}-${dataFim}-${tipoFiltro}-${userCod}`;
      if (_wCache.key === ck && _wCache.data && Date.now() - _wCache.ts < 30000) return res.json(_wCache.data);
      
      let query, params;
      
      if (userCod) {
        query = `SELECT * FROM withdrawal_requests WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC LIMIT $2`;
        params = [userCod, Math.min(parseInt(req.query.limit) || 500, 500)];
      }
      else if (comFiltroData) {
        const col = tipoFiltro === 'lancamento' ? 'lancamento_at' : tipoFiltro === 'debito' ? 'debito_plific_at' : 'created_at';
        if (status) {
          query = `SELECT * FROM withdrawal_requests WHERE status = $1 AND ${col} >= $2::date AND ${col} < $3::date + interval '1 day' ORDER BY created_at DESC`;
          params = [status, dataInicio, dataFim];
        } else {
          query = `SELECT * FROM withdrawal_requests WHERE ${col} >= $1::date AND ${col} < $2::date + interval '1 day' ORDER BY created_at DESC`;
          params = [dataInicio, dataFim];
        }
      } else if (status) {
        query = `SELECT * FROM withdrawal_requests WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
        params = [status, limit, offset];
      } else {
        query = `SELECT * FROM withdrawal_requests ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
        params = [limit, offset];
      }
      
      const [result, rRes] = await Promise.all([
        pool.query(query, params),
        pool.query(`SELECT user_cod, reason FROM restricted_professionals WHERE status = 'ativo'`)
      ]);
      const rm = {}; for (const r of rRes.rows) rm[r.user_cod] = r.reason;
      const enriched = result.rows.map(w => ({ ...w, is_restricted: !!rm[w.user_cod], restriction_reason: rm[w.user_cod] || null }));
      _wCache = { data: enriched, ts: Date.now(), key: ck };
      console.log(`⚡ /withdrawals: ${enriched.length} regs (limit=${limit}, semLimit=${comFiltroData}, dataInicio=${dataInicio}, dataFim=${dataFim})`);
      res.json(enriched);
    } catch (error) {
      console.error('❌ Erro /withdrawals:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // /api/gratuities — HARD LIMIT 50
  // 🔒 SECURITY FIX (HIGH-03): Exige role admin
  router.get('/gratuities', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const result = await pool.query(`SELECT * FROM gratuities ORDER BY created_at DESC LIMIT $1`, [limit]);
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // /api/restricted — HARD LIMIT 100
  // 🔒 SECURITY FIX (HIGH-03): Exige role admin
  router.get('/restricted', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM restricted_professionals WHERE status = 'ativo' ORDER BY created_at DESC LIMIT 100`);
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createBootstrapRoutes };
