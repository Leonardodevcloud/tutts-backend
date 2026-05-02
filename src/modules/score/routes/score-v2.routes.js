/**
 * Score v2 — Rotas (2026-05)
 *
 * Endpoints:
 *
 *   MOTOBOY:
 *     GET  /api/score-v2/meu-nivel
 *       → recalcula em tempo real, retorna nível + stats + progresso + bônus
 *
 *   ADMIN:
 *     GET  /api/score-v2/admin/regioes-disponiveis
 *       → lista regiões disponíveis (do CRM) que ainda podem ser configuradas
 *     GET  /api/score-v2/admin/configuracoes
 *       → lista todas as configs ativas
 *     POST /api/score-v2/admin/configuracoes
 *       → cria/atualiza config de uma região
 *     DELETE /api/score-v2/admin/configuracoes/:id
 *       → desativa config (não deleta — mantém histórico)
 *     GET  /api/score-v2/admin/sorteios
 *       → histórico de sorteios mensais
 *     POST /api/score-v2/admin/sortear-agora
 *       → dispara sorteio manualmente (debug ou força bruta)
 *     GET  /api/score-v2/admin/motoboys-por-nivel?regiao=X
 *       → lista motoboys da região por nível
 */

'use strict';

const express = require('express');
const {
  avaliarMotoboy,
  rodarSorteiosMensais,
} = require('../score-v2.service');

function createScoreV2Routes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // ============================================================
  // MOTOBOY: meu nível em tempo real
  // ============================================================
  router.get('/score-v2/meu-nivel', verificarToken, async (req, res) => {
    try {
      const codProf = req.user.codProfissional || req.user.cod_profissional;
      if (!codProf) {
        return res.status(400).json({ error: 'Usuário sem cod_profissional' });
      }
      const resultado = await avaliarMotoboy(pool, codProf);
      res.json(resultado);
    } catch (err) {
      console.error('❌ [Score v2] /meu-nivel cod=' + (req.user?.codProfissional || '?') + ':', err.message);
      console.error(err.stack);
      res.status(500).json({ error: 'Erro ao calcular nível', details: err.message });
    }
  });

  // Permitir admin consultar nível de qualquer motoboy (debug)
  router.get('/score-v2/admin/avaliar/:codProf', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const resultado = await avaliarMotoboy(pool, req.params.codProf);
      res.json(resultado);
    } catch (err) {
      console.error('❌ [Score v2] /admin/avaliar:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  // ============================================================
  // ADMIN: regiões disponíveis (do CRM, ainda não configuradas)
  // ============================================================
  router.get('/score-v2/admin/regioes-disponiveis', verificarToken, verificarAdmin, async (req, res) => {
    try {
      // Pega regiões distintas do CRM com pelo menos 1 motoboy ativo
      const result = await pool.query(`
        SELECT DISTINCT regiao,
          COUNT(*)::int AS total_motoboys
        FROM crm_leads_capturados
        WHERE regiao IS NOT NULL AND regiao <> ''
        GROUP BY regiao
        ORDER BY regiao
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ [Score v2] /regioes-disponiveis:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  // ============================================================
  // ADMIN: listar configurações
  // ============================================================
  router.get('/score-v2/admin/configuracoes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, regiao, ativo, niveis_ativos,
          sorteio_valor_n2, sorteio_valor_n3,
          saque_teto_n2, saque_teto_n3,
          criado_em, atualizado_em, criado_por
        FROM score_config_regiao
        ORDER BY regiao
      `);

      // Pra cada config, pega contagem de motoboys por nível
      const enriquecido = await Promise.all(result.rows.map(async (cfg) => {
        const counts = await pool.query(`
          SELECT nivel_atual, COUNT(*)::int AS total
          FROM score_nivel_motoboy
          WHERE UPPER(regiao) = UPPER($1)
          GROUP BY nivel_atual
        `, [cfg.regiao]);
        const porNivel = { 1: 0, 2: 0, 3: 0 };
        counts.rows.forEach(r => { porNivel[r.nivel_atual] = r.total; });
        return { ...cfg, motoboys_por_nivel: porNivel };
      }));

      res.json(enriquecido);
    } catch (err) {
      console.error('❌ [Score v2] /configuracoes:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  // ============================================================
  // ADMIN: criar/atualizar configuração (UPSERT por região)
  // ============================================================
  router.post('/score-v2/admin/configuracoes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const {
        regiao,
        ativo = true,
        niveis_ativos = [2, 3],
        sorteio_valor_n2 = 50,
        sorteio_valor_n3 = 150,
        saque_teto_n2 = 500,
        saque_teto_n3 = 500,
      } = req.body || {};

      if (!regiao || !regiao.trim()) {
        return res.status(400).json({ error: 'Região é obrigatória' });
      }
      if (!Array.isArray(niveis_ativos) || niveis_ativos.length === 0) {
        return res.status(400).json({ error: 'niveis_ativos deve ser array não-vazio' });
      }
      // Valida que niveis_ativos só tem 2 e/ou 3
      const niveisValidos = niveis_ativos.filter(n => n === 2 || n === 3);
      if (niveisValidos.length === 0) {
        return res.status(400).json({ error: 'niveis_ativos deve conter 2 e/ou 3' });
      }

      const result = await pool.query(`
        INSERT INTO score_config_regiao (
          regiao, ativo, niveis_ativos,
          sorteio_valor_n2, sorteio_valor_n3,
          saque_teto_n2, saque_teto_n3,
          criado_por
        ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
        ON CONFLICT (regiao) DO UPDATE SET
          ativo = EXCLUDED.ativo,
          niveis_ativos = EXCLUDED.niveis_ativos,
          sorteio_valor_n2 = EXCLUDED.sorteio_valor_n2,
          sorteio_valor_n3 = EXCLUDED.sorteio_valor_n3,
          saque_teto_n2 = EXCLUDED.saque_teto_n2,
          saque_teto_n3 = EXCLUDED.saque_teto_n3,
          atualizado_em = NOW()
        RETURNING *
      `, [
        regiao.trim(), ativo, JSON.stringify(niveisValidos),
        parseFloat(sorteio_valor_n2), parseFloat(sorteio_valor_n3),
        parseFloat(saque_teto_n2), parseFloat(saque_teto_n3),
        req.user.userId || req.user.email || 'admin',
      ]);

      console.log(`✅ [Score v2] Config salva: ${regiao} (níveis ${niveisValidos.join(',')})`);
      res.json({ sucesso: true, configuracao: result.rows[0] });
    } catch (err) {
      console.error('❌ [Score v2] POST /configuracoes:', err);
      res.status(500).json({ error: 'Erro ao salvar', details: err.message });
    }
  });

  // Desativa config (não deleta — preserva histórico de sorteios/bonus)
  router.delete('/score-v2/admin/configuracoes/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        UPDATE score_config_regiao SET ativo = false, atualizado_em = NOW()
        WHERE id = $1 RETURNING regiao
      `, [parseInt(req.params.id)]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
      console.log(`✅ [Score v2] Config desativada: ${result.rows[0].regiao}`);
      res.json({ sucesso: true });
    } catch (err) {
      console.error('❌ [Score v2] DELETE /configuracoes:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  // ============================================================
  // ADMIN: histórico de sorteios
  // ============================================================
  router.get('/score-v2/admin/sorteios', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const limite = Math.min(parseInt(req.query.limit) || 100, 500);
      const result = await pool.query(`
        SELECT * FROM score_sorteios
        ORDER BY mes_referencia DESC, regiao, nivel
        LIMIT $1
      `, [limite]);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ [Score v2] /sorteios:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  // Disparo manual de sorteio (debug ou refazer mês perdido)
  router.post('/score-v2/admin/sortear-agora', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { mes_referencia } = req.body || {};
      if (!mes_referencia || !/^\d{4}-\d{2}$/.test(mes_referencia)) {
        return res.status(400).json({ error: 'mes_referencia obrigatório no formato YYYY-MM' });
      }
      const resultados = await rodarSorteiosMensais(pool, mes_referencia);
      res.json({ sucesso: true, mes: mes_referencia, sorteios: resultados });
    } catch (err) {
      console.error('❌ [Score v2] /sortear-agora:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  // ============================================================
  // ADMIN: motoboys por nível (pra ver quem está em cada nível)
  // ============================================================
  router.get('/score-v2/admin/motoboys-por-nivel', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { regiao, nivel } = req.query;
      const params = [];
      let where = '1=1';
      if (regiao) {
        params.push(regiao);
        where += ` AND UPPER(regiao) = UPPER($${params.length})`;
      }
      if (nivel) {
        params.push(parseInt(nivel));
        where += ` AND nivel_atual = $${params.length}`;
      }
      const result = await pool.query(`
        SELECT cod_prof, nome_prof, regiao, nivel_atual,
          entregas_periodo, dias_16h_periodo, pct_prazo,
          avaliado_em, ultima_subida_em, ultima_descida_em
        FROM score_nivel_motoboy
        WHERE ${where}
        ORDER BY nivel_atual DESC, entregas_periodo DESC
        LIMIT 500
      `, params);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ [Score v2] /motoboys-por-nivel:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  return router;
}

module.exports = { createScoreV2Routes };
