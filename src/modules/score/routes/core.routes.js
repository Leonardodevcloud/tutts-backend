/**
 * Sub-Router: Score Core
 */
const express = require('express');
const { DATA_MINIMA_SCORE, calcularPontosOS, verificarConquistas } = require('../score.service');
function createScoreCoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  router.post('/recalcular', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_prof, data_inicio, data_fim } = req.body;

      let whereClause = `WHERE COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof IS NOT NULL AND data_solicitado >= '${DATA_MINIMA_SCORE}'`;
      const params = [];
      let paramIndex = 1;

      if (cod_prof) {
        whereClause += ` AND cod_prof = $${paramIndex}`;
        params.push(cod_prof);
        paramIndex++;
      }
      if (data_inicio) {
        whereClause += ` AND data_solicitado >= $${paramIndex}`;
        params.push(data_inicio);
        paramIndex++;
      }
      if (data_fim) {
        whereClause += ` AND data_solicitado <= $${paramIndex}`;
        params.push(data_fim);
        paramIndex++;
      }

      // Limpar histórico antigo
      if (!cod_prof) {
        await pool.query(`DELETE FROM score_historico WHERE data_os < '${DATA_MINIMA_SCORE}'`);
        await pool.query('TRUNCATE score_totais');
        await pool.query('TRUNCATE score_conquistas');
      } else {
        await pool.query(`DELETE FROM score_historico WHERE cod_prof = $1 AND data_os < '${DATA_MINIMA_SCORE}'`, [cod_prof]);
      }

      await pool.query('ALTER TABLE score_historico ADD COLUMN IF NOT EXISTS distancia_km DECIMAL(10,2)').catch(() => {});

      const entregasQuery = await pool.query(`
        SELECT DISTINCT ON (os, cod_prof) os, cod_prof, nome_prof, data_solicitado, hora_solicitado,
          tempo_entrega_prof_minutos, prazo_prof_minutos, dentro_prazo_prof, distancia
        FROM bi_entregas ${whereClause}
        ORDER BY os, cod_prof, data_solicitado DESC
      `, params);

      let processadas = 0, erros = 0;

      for (const entrega of entregasQuery.rows) {
        try {
          const dentroPrazo = entrega.dentro_prazo_prof;
          const tempoEntrega = parseFloat(entrega.tempo_entrega_prof_minutos) || 0;
          const prazoMinutos = parseFloat(entrega.prazo_prof_minutos) || 0;
          const distanciaKm = parseFloat(entrega.distancia) || 0;

          const pontos = calcularPontosOS(dentroPrazo, entrega.hora_solicitado);

          await pool.query(`
            INSERT INTO score_historico (cod_prof, nome_prof, os, data_os, hora_solicitacao,
              tempo_entrega_minutos, prazo_minutos, ponto_prazo, ponto_bonus_janela, ponto_total,
              dentro_prazo, janela_bonus, detalhamento, distancia_km)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (cod_prof, os) DO UPDATE SET
              nome_prof = EXCLUDED.nome_prof, data_os = EXCLUDED.data_os,
              hora_solicitacao = EXCLUDED.hora_solicitacao, tempo_entrega_minutos = EXCLUDED.tempo_entrega_minutos,
              prazo_minutos = EXCLUDED.prazo_minutos, ponto_prazo = EXCLUDED.ponto_prazo,
              ponto_bonus_janela = EXCLUDED.ponto_bonus_janela, ponto_total = EXCLUDED.ponto_total,
              dentro_prazo = EXCLUDED.dentro_prazo, janela_bonus = EXCLUDED.janela_bonus,
              detalhamento = EXCLUDED.detalhamento, distancia_km = EXCLUDED.distancia_km
          `, [entrega.cod_prof, entrega.nome_prof, entrega.os, entrega.data_solicitado,
              entrega.hora_solicitado, tempoEntrega, prazoMinutos,
              pontos.ponto_prazo, pontos.ponto_bonus_janela, pontos.ponto_total,
              dentroPrazo, pontos.janela_bonus, pontos.detalhamento, distanciaKm]);
          processadas++;
        } catch (err) {
          erros++;
          console.error('Erro ao processar OS:', entrega.os, err.message);
        }
      }

      // Atualizar totais
      const profissionais = cod_prof
        ? [{ cod_prof }]
        : (await pool.query('SELECT DISTINCT cod_prof FROM score_historico')).rows;

      for (const prof of profissionais) {
        await pool.query(`
          INSERT INTO score_totais (cod_prof, nome_prof, score_total, total_os, os_no_prazo, os_fora_prazo, bonus_janela_total)
          SELECT cod_prof, MAX(nome_prof), COALESCE(SUM(ponto_total), 0), COUNT(*),
            SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END),
            SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END),
            COALESCE(SUM(ponto_bonus_janela), 0)
          FROM score_historico WHERE cod_prof = $1 GROUP BY cod_prof
          ON CONFLICT (cod_prof) DO UPDATE SET
            nome_prof = EXCLUDED.nome_prof, score_total = EXCLUDED.score_total,
            total_os = EXCLUDED.total_os, os_no_prazo = EXCLUDED.os_no_prazo,
            os_fora_prazo = EXCLUDED.os_fora_prazo, bonus_janela_total = EXCLUDED.bonus_janela_total,
            ultimo_calculo = NOW(), updated_at = NOW()
        `, [prof.cod_prof]);
        await verificarConquistas(pool, prof.cod_prof);
      }

      if (registrarAuditoria) {
        await registrarAuditoria(req, 'score.recalcular', 'score', 'score', null,
          { processadas, erros, cod_prof: cod_prof || 'todos' });
      }

      res.json({
        success: true,
        message: `Score recalculado: ${processadas} OS processadas a partir de ${DATA_MINIMA_SCORE}, ${erros} erros`,
        processadas, erros, dataMinima: DATA_MINIMA_SCORE
      });
    } catch (error) {
      console.error('Erro ao recalcular score:', error);
      res.status(500).json({ error: 'Erro ao recalcular score', details: error.message });
    }
  });

  // ==================== PROFISSIONAL ====================

  // GET /api/score/profissional/:cod_prof - Dados completos
  router.get('/profissional/:cod_prof', verificarToken, async (req, res) => {
    try {
      const { cod_prof } = req.params;
      const { data_inicio, data_fim, limite } = req.query;

      const totaisResult = await pool.query('SELECT * FROM score_totais WHERE cod_prof = $1', [cod_prof]);
      let totais = totaisResult.rows[0] || {
        cod_prof: parseInt(cod_prof), nome_prof: null, score_total: 0,
        total_os: 0, os_no_prazo: 0, os_fora_prazo: 0, bonus_janela_total: 0
      };

      if (!totais.nome_prof) {
        const nomeResult = await pool.query(
          'SELECT DISTINCT nome_prof FROM bi_entregas WHERE cod_prof = $1 AND nome_prof IS NOT NULL LIMIT 1',
          [cod_prof]
        );
        if (nomeResult.rows.length > 0) totais.nome_prof = nomeResult.rows[0].nome_prof;
      }

      let extratoWhere = 'WHERE cod_prof = $1';
      const extratoParams = [cod_prof];
      let paramIndex = 2;

      if (data_inicio) { extratoWhere += ` AND data_os >= $${paramIndex}`; extratoParams.push(data_inicio); paramIndex++; }
      if (data_fim) { extratoWhere += ` AND data_os <= $${paramIndex}`; extratoParams.push(data_fim); paramIndex++; }

      const extratoResult = await pool.query(`
        SELECT os, data_os, hora_solicitacao, tempo_entrega_minutos, prazo_minutos,
          ponto_prazo, ponto_bonus_janela, ponto_total, dentro_prazo, janela_bonus, detalhamento, distancia_km
        FROM score_historico ${extratoWhere}
        ORDER BY data_os DESC, os DESC LIMIT ${parseInt(limite) || 100}
      `, extratoParams);

      const milestonesResult = await pool.query(`
        SELECT m.*, c.conquistado_em,
               CASE WHEN c.id IS NOT NULL THEN true ELSE false END as conquistado,
               pf.status as premio_status,
               pf.confirmado_em as premio_confirmado_em,
               CASE WHEN pf.status = 'entregue' THEN true ELSE false END as premio_recebido
        FROM score_milestones m
        LEFT JOIN score_conquistas c ON m.id = c.milestone_id AND c.cod_prof = $1
        LEFT JOIN score_premios_fisicos pf ON m.id = pf.milestone_id AND pf.cod_prof = $1
        WHERE m.ativo = true ORDER BY m.ordem ASC
      `, [cod_prof]);

      const scoreAtual = parseFloat(totais.score_total) || 0;
      const proximoMilestone = milestonesResult.rows.find(m => !m.conquistado);
      let progressoProximo = null;

      if (proximoMilestone) {
        const milestoneAnterior = milestonesResult.rows
          .filter(m => m.conquistado)
          .sort((a, b) => b.pontos_necessarios - a.pontos_necessarios)[0];
        const pontoInicial = milestoneAnterior ? milestoneAnterior.pontos_necessarios : 0;
        const pontoFinal = proximoMilestone.pontos_necessarios;
        const progresso = ((scoreAtual - pontoInicial) / (pontoFinal - pontoInicial)) * 100;

        progressoProximo = {
          milestone: proximoMilestone,
          pontos_atuais: scoreAtual,
          pontos_faltam: Math.max(0, pontoFinal - scoreAtual),
          progresso_percentual: Math.min(100, Math.max(0, progresso))
        };
      }

      const taxaNoPrazo = totais.total_os > 0 ? ((totais.os_no_prazo / totais.total_os) * 100).toFixed(1) : 0;

      res.json({
        profissional: { cod_prof: parseInt(cod_prof), nome: totais.nome_prof || `Profissional ${cod_prof}` },
        score: {
          total: parseFloat(totais.score_total) || 0,
          total_os: parseInt(totais.total_os) || 0,
          os_no_prazo: parseInt(totais.os_no_prazo) || 0,
          os_fora_prazo: parseInt(totais.os_fora_prazo) || 0,
          bonus_janela_total: parseFloat(totais.bonus_janela_total) || 0,
          taxa_no_prazo: parseFloat(taxaNoPrazo)
        },
        extrato: extratoResult.rows,
        milestones: milestonesResult.rows,
        proximo_milestone: progressoProximo
      });
    } catch (error) {
      console.error('Erro ao buscar score do profissional:', error);
      res.status(500).json({ error: 'Erro ao buscar score', details: error.message });
    }
  });

  // GET /api/score/profissional/:cod_prof/premios - Prêmios do profissional
  router.get('/profissional/:cod_prof/premios', verificarToken, async (req, res) => {
    try {
      const { cod_prof } = req.params;

      const scoreResult = await pool.query('SELECT * FROM score_totais WHERE cod_prof = $1', [cod_prof]);
      const score = scoreResult.rows.length > 0 ? parseFloat(scoreResult.rows[0].score_total) : 0;

      const milestones = await pool.query(`
        SELECT m.*,
               c.conquistado_em,
               CASE WHEN c.id IS NOT NULL THEN true ELSE false END as conquistado,
               pf.status as premio_status,
               pf.confirmado_em as premio_confirmado_em
        FROM score_milestones m
        LEFT JOIN score_conquistas c ON m.id = c.milestone_id AND c.cod_prof = $1
        LEFT JOIN score_premios_fisicos pf ON m.id = pf.milestone_id AND pf.cod_prof = $1
        WHERE m.ativo = true
        ORDER BY m.ordem ASC
      `, [cod_prof]);

      res.json({
        score_atual: score,
        milestones: milestones.rows.map(m => ({
          ...m,
          premio_fisico: m.pontos_necessarios === 250 || m.pontos_necessarios === 300,
          premio_recebido: m.premio_status === 'entregue'
        }))
      });
    } catch (error) {
      console.error('Erro ao buscar prêmios do profissional:', error);
      res.status(500).json({ error: 'Erro ao buscar prêmios' });
    }
  });

  // ==================== RANKING ====================

  // GET /api/score/ranking - Ranking geral
  router.get('/ranking', verificarToken, async (req, res) => {
    try {
      const { limite, data_inicio, data_fim, ordem } = req.query;
      let query, params = [];

      if (data_inicio || data_fim) {
        let whereClause = 'WHERE 1=1';
        let paramIndex = 1;
        if (data_inicio) { whereClause += ` AND data_os >= $${paramIndex}`; params.push(data_inicio); paramIndex++; }
        if (data_fim) { whereClause += ` AND data_os <= $${paramIndex}`; params.push(data_fim); paramIndex++; }

        query = `SELECT cod_prof, MAX(nome_prof) as nome_prof, COALESCE(SUM(ponto_total), 0) as score_total,
          COUNT(*) as total_os, SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as os_no_prazo,
          SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as os_fora_prazo,
          ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo
          FROM score_historico ${whereClause} GROUP BY cod_prof
          ORDER BY score_total ${ordem === 'asc' ? 'ASC' : 'DESC'} LIMIT $${paramIndex}`;
        params.push(parseInt(limite) || 10000);
      } else {
        query = `SELECT cod_prof, nome_prof, score_total, total_os, os_no_prazo, os_fora_prazo,
          ROUND(os_no_prazo::numeric / NULLIF(total_os, 0) * 100, 1) as taxa_prazo, ultimo_calculo
          FROM score_totais ORDER BY score_total ${ordem === 'asc' ? 'ASC' : 'DESC'} LIMIT $1`;
        params.push(parseInt(limite) || 10000);
      }

      const result = await pool.query(query, params);
      const ranking = result.rows.map((prof, index) => ({
        posicao: index + 1, cod_prof: prof.cod_prof,
        nome: prof.nome_prof || `Profissional ${prof.cod_prof}`,
        score_total: parseFloat(prof.score_total) || 0,
        total_os: parseInt(prof.total_os) || 0,
        os_no_prazo: parseInt(prof.os_no_prazo) || 0,
        os_fora_prazo: parseInt(prof.os_fora_prazo) || 0,
        taxa_prazo: parseFloat(prof.taxa_prazo) || 0
      }));

      res.json({ ranking, total_profissionais: ranking.length, filtros: { data_inicio, data_fim, limite, ordem } });
    } catch (error) {
      console.error('Erro ao buscar ranking:', error);
      res.status(500).json({ error: 'Erro ao buscar ranking', details: error.message });
    }
  });

  // ==================== MILESTONES (CRUD) ====================

  // GET /api/score/milestones

  return router;
}

module.exports = { createScoreCoreRoutes };
