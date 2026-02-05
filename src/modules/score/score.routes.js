// ============================================================
// MÓDULO SCORE/GAMIFICAÇÃO - ROUTES (17 endpoints)
// Extraído de server.js (linhas 21340-22132)
// ============================================================

const express = require('express');
const router = express.Router();
const {
  DATA_MINIMA_SCORE,
  calcularPontosOS,
  verificarConquistas,
  determinarNivelGratuidade,
  aplicarGratuidadeProfissional
} = require('./score.service');

/**
 * Inicializa as rotas do módulo Score
 * @param {object} pool - Pool de conexão PostgreSQL
 * @param {function} verificarToken - Middleware de autenticação JWT
 * @param {function} verificarAdmin - Middleware de verificação admin
 * @param {function} registrarAuditoria - Função de audit logging (opcional)
 */
function initScoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {

  // ==================== RECALCULAR ====================

  // POST /api/score/recalcular - Recalcula scores
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
  router.get('/milestones', verificarToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM score_milestones ORDER BY ordem ASC');
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao listar milestones' });
    }
  });

  // POST /api/score/milestones
  router.post('/milestones', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem } = req.body;
      const result = await pool.query(`
        INSERT INTO score_milestones (nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [nome, descricao, pontos_necessarios, icone || '🏆', cor || '#7c3aed', beneficio, ordem || 0]);
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao criar milestone' });
    }
  });

  // PUT /api/score/milestones/:id
  router.put('/milestones/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { nome, descricao, pontos_necessarios, icone, cor, beneficio, ativo, ordem } = req.body;
      const result = await pool.query(`
        UPDATE score_milestones SET nome = COALESCE($1, nome), descricao = COALESCE($2, descricao),
          pontos_necessarios = COALESCE($3, pontos_necessarios), icone = COALESCE($4, icone),
          cor = COALESCE($5, cor), beneficio = COALESCE($6, beneficio), ativo = COALESCE($7, ativo),
          ordem = COALESCE($8, ordem) WHERE id = $9 RETURNING *
      `, [nome, descricao, pontos_necessarios, icone, cor, beneficio, ativo, ordem, id]);
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao atualizar milestone' });
    }
  });

  // DELETE /api/score/milestones/:id
  router.delete('/milestones/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM score_conquistas WHERE milestone_id = $1', [id]);
      await pool.query('DELETE FROM score_milestones WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao deletar milestone' });
    }
  });

  // POST /api/score/milestones/reset
  router.post('/milestones/reset', verificarToken, verificarAdmin, async (req, res) => {
    try {
      await pool.query('TRUNCATE score_conquistas');
      await pool.query('TRUNCATE score_milestones RESTART IDENTITY CASCADE');

      await pool.query(`
        INSERT INTO score_milestones (nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem) VALUES
        ('Bronze', '2 saques gratuitos de R$500/mês', 80, '🥉', '#cd7f32', '2 saques gratuitos de R$500 por mês', 1),
        ('Prata', '+2 saques gratuitos/mês (total: 4)', 100, '🥈', '#c0c0c0', '+2 saques gratuitos de R$500 por mês (total: 4)', 2),
        ('Ouro', '1 Camisa Tutts', 250, '🥇', '#ffd700', '1 Camisa Tutts (Retirada única)', 3),
        ('Platina', '1 Óleo de motor', 300, '💎', '#e5e4e2', '1 Óleo de motor (Retirada única)', 4),
        ('Diamante', 'Sorteio Vale Combustível', 500, '👑', '#b9f2ff', 'Participação em sorteio de Vale Combustível R$100 por mês', 5)
      `);

      // Recalcular conquistas
      const profissionais = await pool.query('SELECT DISTINCT cod_prof FROM score_totais');
      for (const prof of profissionais.rows) {
        await verificarConquistas(pool, prof.cod_prof);
      }

      res.json({
        success: true,
        message: 'Milestones resetados com sucesso!',
        milestones: [
          { pontos: 80, premio: '2 saques gratuitos de R$500/mês' },
          { pontos: 100, premio: '+2 saques gratuitos/mês (total: 4)' },
          { pontos: 250, premio: '1 Camisa Tutts' },
          { pontos: 300, premio: '1 Óleo de motor' },
          { pontos: 500, premio: 'Sorteio Vale Combustível R$100/mês' }
        ]
      });
    } catch (error) {
      console.error('Erro ao resetar milestones:', error);
      res.status(500).json({ error: 'Erro ao resetar milestones', details: error.message });
    }
  });

  // ==================== GRATUIDADES ====================

  // POST /api/score/aplicar-gratuidades
  router.post('/aplicar-gratuidades', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const mesReferencia = req.body.mes || new Date().toISOString().slice(0, 7);
      console.log(`🎁 Aplicando gratuidades do Score para ${mesReferencia}...`);

      const profissionais = await pool.query(`
        SELECT cod_prof, nome_prof, score_total
        FROM score_totais WHERE score_total >= 80
        ORDER BY score_total DESC
      `);

      let aplicados = 0, atualizados = 0, erros = 0;
      const detalhes = [];

      for (const prof of profissionais.rows) {
        try {
          const resultado = await aplicarGratuidadeProfissional(pool, prof, mesReferencia);
          if (resultado === 'criado') {
            aplicados++;
            detalhes.push({ cod_prof: prof.cod_prof, nome: prof.nome_prof, acao: 'criado' });
          } else if (resultado === 'atualizado') {
            atualizados++;
            detalhes.push({ cod_prof: prof.cod_prof, nome: prof.nome_prof, acao: 'atualizado' });
          }
        } catch (err) {
          erros++;
          console.error(`Erro ao aplicar gratuidade para ${prof.cod_prof}:`, err.message);
        }
      }

      console.log(`✅ Gratuidades aplicadas: ${aplicados} novos, ${atualizados} atualizados, ${erros} erros`);

      res.json({
        success: true,
        mes_referencia: mesReferencia,
        resumo: { novos: aplicados, atualizados, erros, total_processados: profissionais.rows.length },
        detalhes: detalhes.slice(0, 20)
      });
    } catch (error) {
      console.error('Erro ao aplicar gratuidades:', error);
      res.status(500).json({ error: 'Erro ao aplicar gratuidades', details: error.message });
    }
  });

  // GET /api/score/gratuidades
  router.get('/gratuidades', verificarToken, async (req, res) => {
    try {
      const { mes, cod_prof } = req.query;
      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (mes) { whereClause += ` AND mes_referencia = $${paramIndex}`; params.push(mes); paramIndex++; }
      if (cod_prof) { whereClause += ` AND cod_prof = $${paramIndex}`; params.push(cod_prof); paramIndex++; }

      const result = await pool.query(`
        SELECT sg.*, g.remaining as saques_restantes, g.status as gratuidade_status
        FROM score_gratuidades sg
        LEFT JOIN gratuities g ON sg.gratuidade_id = g.id
        ${whereClause}
        ORDER BY sg.created_at DESC LIMIT 100
      `, params);

      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao listar gratuidades do score' });
    }
  });

  // POST /api/score/resetar-gratuidades-mes
  router.post('/resetar-gratuidades-mes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const mesReferencia = req.body.mes || new Date().toISOString().slice(0, 7);
      console.log(`🔄 Resetando gratuidades do Score para ${mesReferencia}...`);

      const gratuidadesDoMes = await pool.query(
        'SELECT * FROM score_gratuidades WHERE mes_referencia = $1',
        [mesReferencia]
      );

      for (const sg of gratuidadesDoMes.rows) {
        if (sg.gratuidade_id) {
          await pool.query('DELETE FROM gratuities WHERE id = $1', [sg.gratuidade_id]);
        }
      }
      await pool.query('DELETE FROM score_gratuidades WHERE mes_referencia = $1', [mesReferencia]);

      console.log(`🗑️ ${gratuidadesDoMes.rows.length} gratuidades removidas`);

      // Reaplicar
      const profissionais = await pool.query(`
        SELECT cod_prof, nome_prof, score_total
        FROM score_totais WHERE score_total >= 80
      `);

      let aplicados = 0;
      for (const prof of profissionais.rows) {
        try {
          const resultado = await aplicarGratuidadeProfissional(pool, prof, mesReferencia);
          if (resultado === 'criado') aplicados++;
        } catch (err) {
          console.error(`Erro ao reaplicar gratuidade para ${prof.cod_prof}:`, err.message);
        }
      }

      res.json({
        success: true,
        mes_referencia: mesReferencia,
        removidos: gratuidadesDoMes.rows.length,
        reaplicados: aplicados
      });
    } catch (error) {
      console.error('Erro ao resetar gratuidades:', error);
      res.status(500).json({ error: 'Erro ao resetar gratuidades', details: error.message });
    }
  });

  // ==================== PRÊMIOS FÍSICOS ====================

  // GET /api/score/premios-fisicos
  router.get('/premios-fisicos', verificarToken, async (req, res) => {
    try {
      const { status, cod_prof } = req.query;
      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (status) { whereClause += ` AND pf.status = $${paramIndex}`; params.push(status); paramIndex++; }
      if (cod_prof) { whereClause += ` AND pf.cod_prof = $${paramIndex}`; params.push(cod_prof); paramIndex++; }

      const result = await pool.query(`
        SELECT pf.*, m.nome as milestone_nome, m.icone as milestone_icone, m.pontos_necessarios,
               st.score_total
        FROM score_premios_fisicos pf
        JOIN score_milestones m ON pf.milestone_id = m.id
        LEFT JOIN score_totais st ON pf.cod_prof = st.cod_prof
        ${whereClause}
        ORDER BY pf.status ASC, pf.created_at DESC
      `, params);

      res.json(result.rows);
    } catch (error) {
      console.error('Erro ao listar prêmios físicos:', error);
      res.status(500).json({ error: 'Erro ao listar prêmios físicos' });
    }
  });

  // GET /api/score/premios-pendentes
  router.get('/premios-pendentes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          st.cod_prof, st.nome_prof, st.score_total,
          m.id as milestone_id, m.nome as milestone_nome, m.icone, m.pontos_necessarios, m.beneficio,
          pf.id as premio_id, pf.status as premio_status, pf.confirmado_em, pf.confirmado_por
        FROM score_totais st
        JOIN score_milestones m ON st.score_total >= m.pontos_necessarios
        LEFT JOIN score_premios_fisicos pf ON st.cod_prof = pf.cod_prof AND m.id = pf.milestone_id
        WHERE m.pontos_necessarios IN (250, 300)
        ORDER BY st.score_total DESC, m.pontos_necessarios ASC
      `);

      const porProfissional = {};
      for (const row of result.rows) {
        if (!porProfissional[row.cod_prof]) {
          porProfissional[row.cod_prof] = {
            cod_prof: row.cod_prof, nome_prof: row.nome_prof,
            score_total: parseFloat(row.score_total), premios: []
          };
        }
        porProfissional[row.cod_prof].premios.push({
          milestone_id: row.milestone_id, milestone_nome: row.milestone_nome,
          icone: row.icone, pontos_necessarios: row.pontos_necessarios,
          beneficio: row.beneficio, premio_id: row.premio_id,
          status: row.premio_status || 'disponivel',
          confirmado_em: row.confirmado_em, confirmado_por: row.confirmado_por
        });
      }

      res.json(Object.values(porProfissional));
    } catch (error) {
      console.error('Erro ao listar prêmios pendentes:', error);
      res.status(500).json({ error: 'Erro ao listar prêmios pendentes' });
    }
  });

  // POST /api/score/premios-fisicos/confirmar
  router.post('/premios-fisicos/confirmar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_prof, milestone_id, confirmado_por, observacao } = req.body;

      if (!cod_prof || !milestone_id) {
        return res.status(400).json({ error: 'cod_prof e milestone_id são obrigatórios' });
      }

      const scoreResult = await pool.query('SELECT * FROM score_totais WHERE cod_prof = $1', [cod_prof]);
      if (scoreResult.rows.length === 0) {
        return res.status(400).json({ error: 'Profissional não encontrado' });
      }

      const milestoneResult = await pool.query('SELECT * FROM score_milestones WHERE id = $1', [milestone_id]);
      if (milestoneResult.rows.length === 0) {
        return res.status(400).json({ error: 'Milestone não encontrado' });
      }

      const score = parseFloat(scoreResult.rows[0].score_total);
      if (score < milestoneResult.rows[0].pontos_necessarios) {
        return res.status(400).json({ error: 'Profissional não atingiu pontuação necessária' });
      }

      const result = await pool.query(`
        INSERT INTO score_premios_fisicos (cod_prof, nome_prof, milestone_id, tipo_premio, status, confirmado_por, confirmado_em, observacao)
        VALUES ($1, $2, $3, $4, 'entregue', $5, NOW(), $6)
        ON CONFLICT (cod_prof, milestone_id) DO UPDATE SET
          status = 'entregue', confirmado_por = $5, confirmado_em = NOW(), observacao = $6
        RETURNING *
      `, [cod_prof, scoreResult.rows[0].nome_prof, milestone_id,
          milestoneResult.rows[0].beneficio, confirmado_por || 'Admin', observacao]);

      res.json({ success: true, message: 'Prêmio confirmado com sucesso!', premio: result.rows[0] });
    } catch (error) {
      console.error('Erro ao confirmar prêmio:', error);
      res.status(500).json({ error: 'Erro ao confirmar prêmio', details: error.message });
    }
  });

  // ==================== ESTATÍSTICAS E BUSCA ====================

  // GET /api/score/estatisticas
  router.get('/estatisticas', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { data_inicio, data_fim } = req.query;
      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (data_inicio) { whereClause += ` AND data_os >= $${paramIndex}`; params.push(data_inicio); paramIndex++; }
      if (data_fim) { whereClause += ` AND data_os <= $${paramIndex}`; params.push(data_fim); paramIndex++; }

      const geraisResult = await pool.query(`
        SELECT COUNT(DISTINCT cod_prof) as total_profissionais, COUNT(*) as total_os,
          SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as os_no_prazo,
          SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as os_fora_prazo,
          COALESCE(SUM(ponto_total), 0) as pontos_distribuidos,
          COALESCE(SUM(ponto_bonus_janela), 0) as bonus_janelas_total,
          ROUND(AVG(ponto_total), 2) as media_pontos_por_os
        FROM score_historico ${whereClause}
      `, params);

      const top10Result = await pool.query(`
        SELECT cod_prof, MAX(nome_prof) as nome_prof, COALESCE(SUM(ponto_total), 0) as score_total, COUNT(*) as total_os
        FROM score_historico ${whereClause} GROUP BY cod_prof ORDER BY score_total DESC LIMIT 10
      `, params);

      const conquistasResult = await pool.query(`
        SELECT c.cod_prof, t.nome_prof, m.nome as milestone_nome, m.icone, c.conquistado_em
        FROM score_conquistas c JOIN score_milestones m ON c.milestone_id = m.id
        LEFT JOIN score_totais t ON c.cod_prof = t.cod_prof
        ORDER BY c.conquistado_em DESC LIMIT 10
      `);

      const gerais = geraisResult.rows[0];
      res.json({
        resumo: {
          total_profissionais: parseInt(gerais.total_profissionais) || 0,
          total_os: parseInt(gerais.total_os) || 0,
          os_no_prazo: parseInt(gerais.os_no_prazo) || 0,
          os_fora_prazo: parseInt(gerais.os_fora_prazo) || 0,
          taxa_prazo: gerais.total_os > 0 ? ((gerais.os_no_prazo / gerais.total_os) * 100).toFixed(1) : 0,
          pontos_distribuidos: parseFloat(gerais.pontos_distribuidos) || 0,
          bonus_janelas_total: parseFloat(gerais.bonus_janelas_total) || 0,
          media_pontos_por_os: parseFloat(gerais.media_pontos_por_os) || 0
        },
        top_10: top10Result.rows.map((p, i) => ({
          posicao: i + 1, cod_prof: p.cod_prof,
          nome: p.nome_prof || `Profissional ${p.cod_prof}`,
          score_total: parseFloat(p.score_total), total_os: parseInt(p.total_os)
        })),
        conquistas_recentes: conquistasResult.rows
      });
    } catch (error) {
      console.error('Erro ao buscar estatísticas:', error);
      res.status(500).json({ error: 'Erro ao buscar estatísticas', details: error.message });
    }
  });

  // GET /api/score/buscar
  router.get('/buscar', verificarToken, async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || q.length < 2) return res.json([]);

      const result = await pool.query(`
        SELECT cod_prof, nome_prof, score_total, total_os FROM score_totais
        WHERE cod_prof::text ILIKE $1 OR nome_prof ILIKE $1
        ORDER BY score_total DESC LIMIT 20
      `, [`%${q}%`]);
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao buscar profissional' });
    }
  });

  return router;
}

module.exports = initScoreRoutes;
