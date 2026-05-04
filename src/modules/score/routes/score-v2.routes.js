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
  avaliarRegiaoCompleta,
  rodarSorteiosMensais,
} = require('../score-v2.service');
// 🚀 helper compartilhado: regioes do CRM + Planilha Sheets
const { listarRegioes: listarRegioesCompletas } = require('../../../shared/utils/profissionaisLookup');

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
  // MOTOBOY: lista das próprias entregas dos últimos 28 dias
  // ============================================================
  // Retorna entregas com status de prazo + agrupamento por dia.
  // Usado na tela do motoboy pra ele ver detalhe das corridas.
  router.get('/score-v2/minhas-entregas', verificarToken, async (req, res) => {
    try {
      const codProf = req.user.codProfissional || req.user.cod_profissional;
      if (!codProf) {
        return res.status(400).json({ error: 'Usuário sem cod_profissional' });
      }
      const codProfInt = parseInt(codProf, 10);
      if (!Number.isFinite(codProfInt)) {
        return res.json({ entregas: [], resumo_dia: [] });
      }

      // Lista detalhada
      const entregas = await pool.query(`
        SELECT 
          os, num_pedido, data_solicitado, hora_solicitado,
          cidade, bairro, endereco, nome_cliente, nome_fantasia,
          dentro_prazo, tempo_execucao_minutos, distancia, valor_prof,
          data_chegada, hora_chegada, data_saida, hora_saida
        FROM bi_entregas
        WHERE cod_prof = $1
          AND data_solicitado >= (CURRENT_DATE - INTERVAL '27 days')::date
          AND data_solicitado <= CURRENT_DATE
        ORDER BY data_solicitado DESC, hora_solicitado DESC
        LIMIT 500
      `, [codProfInt]);

      // Resumo agrupado por dia (pra cards do tipo timeline)
      const resumoDia = await pool.query(`
        SELECT 
          data_solicitado AS dia,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE dentro_prazo = true)::int AS no_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false)::int AS fora_prazo,
          COUNT(*) FILTER (
            WHERE hora_solicitado IS NOT NULL 
              AND EXTRACT(HOUR FROM hora_solicitado) >= 16
          )::int AS apos_16h
        FROM bi_entregas
        WHERE cod_prof = $1
          AND data_solicitado >= (CURRENT_DATE - INTERVAL '27 days')::date
          AND data_solicitado <= CURRENT_DATE
        GROUP BY data_solicitado
        ORDER BY data_solicitado DESC
      `, [codProfInt]);

      res.json({
        entregas: entregas.rows,
        resumo_dia: resumoDia.rows,
      });
    } catch (err) {
      console.error('❌ [Score v2] /minhas-entregas:', err.message);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  // ============================================================
  // ADMIN: regiões disponíveis (do CRM, ainda não configuradas)
  // ============================================================
  router.get('/score-v2/admin/regioes-disponiveis', verificarToken, verificarAdmin, async (req, res) => {
    try {
      // 🚀 Usa helper que retorna regiões CRM + Planilha (deduplicadas)
      const regioes = await listarRegioesCompletas(pool);
      // Mapeia pro formato esperado pelo frontend ({ regiao, total_motoboys })
      // Como vem do helper sem contagem, fica null (admin não usa esse campo)
      const result = regioes.map(r => ({ regiao: r, total_motoboys: null }));
      res.json(result);
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
      // 🔧 FIX 2026-05: SELECT incluindo os 6 thresholds configuráveis.
      // Antes faltavam — o frontend recebia config sem eles e caía sempre nos defaults hardcoded
      // (80/15/80% e 150/20/88%), dando a falsa sensação de que "não salvava".
      const result = await pool.query(`
        SELECT id, regiao, ativo, niveis_ativos,
          sorteio_valor_n2, sorteio_valor_n3,
          saque_teto_n2, saque_teto_n3,
          n2_min_entregas, n2_min_dias_16h, n2_min_pct_prazo,
          n3_min_entregas, n3_min_dias_16h, n3_min_pct_prazo,
          criado_em, atualizado_em, criado_por
        FROM score_config_regiao
        ORDER BY regiao
      `);

      // Pra cada config, pega contagem de motoboys por nível
      // 🔧 FIX 2026-05: usa match case+acento+espaço insensitive (igual ao service).
      // Antes só fazia UPPER() — ficava "Goiânia" != "GOIANIA" e contagem dava errado.
      const enriquecido = await Promise.all(result.rows.map(async (cfg) => {
        const counts = await pool.query(`
          SELECT nivel_atual, COUNT(*)::int AS total
          FROM score_nivel_motoboy
          WHERE TRIM(UPPER(translate(regiao,
            'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
            'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyy')))
            = TRIM(UPPER(translate($1::text,
            'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
            'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyy')))
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
        // 🚀 2026-05: thresholds configuráveis (defaults se não vier)
        n2_min_entregas = 80,
        n2_min_dias_16h = 15,
        n2_min_pct_prazo = 80,
        n3_min_entregas = 150,
        n3_min_dias_16h = 20,
        n3_min_pct_prazo = 88,
      } = req.body || {};

      if (!regiao || !regiao.trim()) {
        return res.status(400).json({ error: 'Região é obrigatória' });
      }
      if (!Array.isArray(niveis_ativos) || niveis_ativos.length === 0) {
        return res.status(400).json({ error: 'niveis_ativos deve ser array não-vazio' });
      }
      const niveisValidos = niveis_ativos.filter(n => n === 2 || n === 3);
      if (niveisValidos.length === 0) {
        return res.status(400).json({ error: 'niveis_ativos deve conter 2 e/ou 3' });
      }

      // Valida thresholds (sanity)
      const intMin0 = (v, fb) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= 0 ? n : fb;
      };
      const pct = (v, fb) => {
        const n = parseFloat(v);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fb;
      };

      const result = await pool.query(`
        INSERT INTO score_config_regiao (
          regiao, ativo, niveis_ativos,
          sorteio_valor_n2, sorteio_valor_n3,
          saque_teto_n2, saque_teto_n3,
          n2_min_entregas, n2_min_dias_16h, n2_min_pct_prazo,
          n3_min_entregas, n3_min_dias_16h, n3_min_pct_prazo,
          criado_por
        ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (regiao) DO UPDATE SET
          ativo = EXCLUDED.ativo,
          niveis_ativos = EXCLUDED.niveis_ativos,
          sorteio_valor_n2 = EXCLUDED.sorteio_valor_n2,
          sorteio_valor_n3 = EXCLUDED.sorteio_valor_n3,
          saque_teto_n2 = EXCLUDED.saque_teto_n2,
          saque_teto_n3 = EXCLUDED.saque_teto_n3,
          n2_min_entregas = EXCLUDED.n2_min_entregas,
          n2_min_dias_16h = EXCLUDED.n2_min_dias_16h,
          n2_min_pct_prazo = EXCLUDED.n2_min_pct_prazo,
          n3_min_entregas = EXCLUDED.n3_min_entregas,
          n3_min_dias_16h = EXCLUDED.n3_min_dias_16h,
          n3_min_pct_prazo = EXCLUDED.n3_min_pct_prazo,
          atualizado_em = NOW()
        RETURNING *
      `, [
        regiao.trim(), ativo, JSON.stringify(niveisValidos),
        parseFloat(sorteio_valor_n2), parseFloat(sorteio_valor_n3),
        parseFloat(saque_teto_n2), parseFloat(saque_teto_n3),
        intMin0(n2_min_entregas, 80), intMin0(n2_min_dias_16h, 15), pct(n2_min_pct_prazo, 80),
        intMin0(n3_min_entregas, 150), intMin0(n3_min_dias_16h, 20), pct(n3_min_pct_prazo, 88),
        req.user.userId || req.user.email || 'admin',
      ]);

      console.log(`✅ [Score v2] Config salva: ${regiao} (níveis ${niveisValidos.join(',')}) thresholds N2:${n2_min_entregas}/${n2_min_dias_16h}/${n2_min_pct_prazo}% N3:${n3_min_entregas}/${n3_min_dias_16h}/${n3_min_pct_prazo}%`);

      // 🚀 Dispara pré-avaliação em BACKGROUND (não bloqueia resposta).
      // Avalia todos os motoboys da região pra popular score_nivel_motoboy.
      // Só dispara se a config está ativa (sem ponto se inativa).
      if (ativo) {
        setImmediate(async () => {
          try {
            console.log(`🚀 [Score v2] Disparando pré-avaliação em background para "${regiao}"...`);
            const r = await avaliarRegiaoCompleta(pool, regiao.trim());
            console.log(`✅ [Score v2] Pré-avaliação concluída:`, r);
          } catch (err) {
            console.error(`❌ [Score v2] Pré-avaliação falhou:`, err.message);
          }
        });
      }

      res.json({
        sucesso: true,
        configuracao: result.rows[0],
        info: ativo ? 'Pré-avaliação iniciada em background — recarregue em alguns segundos' : null,
      });
    } catch (err) {
      console.error('❌ [Score v2] POST /configuracoes:', err);
      res.status(500).json({ error: 'Erro ao salvar', details: err.message });
    }
  });

  // ============================================================
  // ADMIN: re-avaliar TODOS os motoboys de uma região (manual)
  // ============================================================
  router.post('/score-v2/admin/reavaliar-regiao', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { regiao } = req.body || {};
      if (!regiao || !regiao.trim()) {
        return res.status(400).json({ error: 'Região é obrigatória' });
      }
      const resultado = await avaliarRegiaoCompleta(pool, regiao.trim());
      res.json({ sucesso: true, ...resultado });
    } catch (err) {
      console.error('❌ [Score v2] /reavaliar-regiao:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
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
      const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const params = [];
      let where = '1=1';
      if (regiao) {
        params.push(regiao);
        // 🔧 FIX 2026-05: match case+acento+espaço insensitive (igual ao service)
        where += ` AND TRIM(UPPER(translate(regiao,
          'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
          'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyy')))
          = TRIM(UPPER(translate($${params.length}::text,
          'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
          'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyy')))`;
      }
      if (nivel) {
        params.push(parseInt(nivel));
        where += ` AND nivel_atual = $${params.length}`;
      }

      // Contagem total (pra UI mostrar paginação)
      const totalQ = await pool.query(
        `SELECT COUNT(*)::int AS total FROM score_nivel_motoboy WHERE ${where}`,
        params
      );
      const total = totalQ.rows[0].total;

      // Página atual
      const paramsComLimit = [...params, limit, offset];
      const result = await pool.query(`
        SELECT cod_prof, nome_prof, regiao, nivel_atual,
          entregas_periodo, dias_16h_periodo, pct_prazo,
          avaliado_em, ultima_subida_em, ultima_descida_em
        FROM score_nivel_motoboy
        WHERE ${where}
        ORDER BY nivel_atual DESC, entregas_periodo DESC, nome_prof
        LIMIT $${paramsComLimit.length - 1} OFFSET $${paramsComLimit.length}
      `, paramsComLimit);

      res.json({
        total,
        limit,
        offset,
        rows: result.rows,
      });
    } catch (err) {
      console.error('❌ [Score v2] /motoboys-por-nivel:', err);
      res.status(500).json({ error: 'Erro', details: err.message });
    }
  });

  return router;
}

module.exports = { createScoreV2Routes };
