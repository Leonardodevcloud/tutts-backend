/**
 * Sub-Router: Filas Profissional
 */
const express = require('express');
const { calcularDistanciaHaversine } = require('../filas.service');

function createFilasProfRoutes(pool, verificarToken, registrarAuditoria) {
  const router = express.Router();

  router.get('/minha-central', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      
      const vinculo = await pool.query(`
        SELECT v.*, c.nome as central_nome, c.endereco, c.latitude, c.longitude, c.raio_metros, c.ativa
        FROM filas_vinculos v
        JOIN filas_centrais c ON c.id = v.central_id
        WHERE v.cod_profissional = $1 AND v.ativo = true AND c.ativa = true
      `, [cod_profissional]);
      
      if (vinculo.rows.length === 0) {
        return res.json({ success: true, vinculado: false });
      }
      
      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
        [cod_profissional]
      );
      
      res.json({ 
        success: true, 
        vinculado: true,
        central: vinculo.rows[0],
        na_fila: posicao.rows.length > 0,
        posicao_atual: posicao.rows[0] || null
      });
    } catch (error) {
      console.error('❌ Erro ao verificar central:', error);
      res.status(500).json({ error: 'Erro ao verificar central' });
    }
  });

  // Entrar na fila (com validação de geolocalização)
  router.post('/entrar', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      const nome_profissional = req.user.nome;
      const { latitude, longitude } = req.body;
      
      if (!latitude || !longitude) {
        return res.status(400).json({ error: 'Localização GPS é obrigatória' });
      }
      
      const vinculo = await pool.query(`
        SELECT v.*, c.nome as central_nome, c.latitude as central_lat, c.longitude as central_lng, c.raio_metros
        FROM filas_vinculos v
        JOIN filas_centrais c ON c.id = v.central_id
        WHERE v.cod_profissional = $1 AND v.ativo = true AND c.ativa = true
      `, [cod_profissional]);
      
      if (vinculo.rows.length === 0) {
        return res.status(403).json({ error: 'Você não está vinculado a nenhuma central' });
      }
      
      const central = vinculo.rows[0];
      
      const distancia = calcularDistanciaHaversine(
        parseFloat(latitude), 
        parseFloat(longitude),
        parseFloat(central.central_lat),
        parseFloat(central.central_lng)
      );
      
      if (distancia > central.raio_metros) {
        return res.status(403).json({ 
          error: 'Você está muito longe da central',
          distancia_atual: Math.round(distancia),
          raio_permitido: central.raio_metros,
          mensagem: `Você está a ${Math.round(distancia)}m da central. Aproxime-se para entrar na fila (máx ${central.raio_metros}m).`
        });
      }
      
      const jaEstaNaFila = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
        [cod_profissional]
      );
      
      if (jaEstaNaFila.rows.length > 0) {
        const posicaoAtual = jaEstaNaFila.rows[0];
        
        if (posicaoAtual.status === 'em_rota') {
          const tempoRota = Math.round((Date.now() - new Date(posicaoAtual.saida_rota_at).getTime()) / 60000);
          
          let novaPosicao;
          let acaoHistorico = 'retorno';
          let observacaoHistorico = null;
          
          if (posicaoAtual.corrida_unica && posicaoAtual.posicao_original) {
            const posicaoOriginal = posicaoAtual.posicao_original;
            
            const totalAtual = await pool.query(
              'SELECT COUNT(*) as total, MIN(posicao) as primeira FROM filas_posicoes WHERE central_id = $1 AND status = $2',
              [central.central_id, 'aguardando']
            );
            
            const total = parseInt(totalAtual.rows[0].total) || 0;
            const primeiraPosicao = parseInt(totalAtual.rows[0].primeira) || 1;
            
            if (total === 0) {
              novaPosicao = 1;
            } else if (posicaoOriginal <= primeiraPosicao) {
              novaPosicao = primeiraPosicao;
              await pool.query(`
                UPDATE filas_posicoes 
                SET posicao = posicao + 1 
                WHERE central_id = $1 AND status = 'aguardando'
              `, [central.central_id]);
            } else {
              novaPosicao = posicaoOriginal;
              await pool.query(`
                UPDATE filas_posicoes 
                SET posicao = posicao + 1 
                WHERE central_id = $1 AND status = 'aguardando' AND posicao >= $2
              `, [central.central_id, posicaoOriginal]);
            }
            
            acaoHistorico = 'retorno_prioridade';
            observacaoHistorico = `Retorno prioritário - Posição original: ${posicaoOriginal}`;
          } else {
            const ultimaPosicao = await pool.query(
              'SELECT COALESCE(MAX(posicao), 0) as max_pos FROM filas_posicoes WHERE central_id = $1 AND status = $2',
              [central.central_id, 'aguardando']
            );
            novaPosicao = parseInt(ultimaPosicao.rows[0].max_pos) + 1;
          }
          
          await pool.query(`
            UPDATE filas_posicoes 
            SET status = 'aguardando',
                posicao = $1,
                entrada_fila_at = NOW(),
                retorno_at = NOW(),
                latitude_checkin = $2,
                longitude_checkin = $3,
                corrida_unica = FALSE,
                posicao_original = NULL,
                motivo_posicao = $5,
                updated_at = NOW()
            WHERE cod_profissional = $4
          `, [novaPosicao, latitude, longitude, cod_profissional, posicaoAtual.corrida_unica ? 'retorno_prioritario' : null]);
          
          await pool.query(`
            INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_rota_minutos, observacao)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [central.central_id, central.central_nome, cod_profissional, nome_profissional, acaoHistorico, tempoRota, observacaoHistorico]);
          
          return res.json({ 
            success: true, 
            mensagem: posicaoAtual.corrida_unica ? 'Você retornou com prioridade!' : 'Você retornou para a fila',
            posicao: novaPosicao,
            tempo_rota: tempoRota,
            prioridade: posicaoAtual.corrida_unica || false
          });
        } else {
          return res.status(400).json({ error: 'Você já está na fila de espera' });
        }
      }
      
      const ultimaPosicao = await pool.query(
        'SELECT COALESCE(MAX(posicao), 0) as max_pos FROM filas_posicoes WHERE central_id = $1 AND status = $2',
        [central.central_id, 'aguardando']
      );
      
      const posicao = parseInt(ultimaPosicao.rows[0].max_pos) + 1;
      
      await pool.query(`
        INSERT INTO filas_posicoes (central_id, cod_profissional, nome_profissional, status, posicao, latitude_checkin, longitude_checkin)
        VALUES ($1, $2, $3, 'aguardando', $4, $5, $6)
      `, [central.central_id, cod_profissional, nome_profissional, posicao, latitude, longitude]);
      
      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao)
        VALUES ($1, $2, $3, $4, 'entrada')
      `, [central.central_id, central.central_nome, cod_profissional, nome_profissional]);
      
      res.json({ 
        success: true, 
        posicao: posicao,
        central: central.central_nome,
        distancia: Math.round(distancia)
      });
      
      registrarAuditoria(req, 'ENTRAR_NA_FILA', 'user', 'filas_posicoes', null, 
        { central_id: central.central_id, posicao, distancia: Math.round(distancia) }).catch(() => {});
      
    } catch (error) {
      console.error('❌ Erro ao entrar na fila:', error);
      res.status(500).json({ error: 'Erro ao entrar na fila' });
    }
  });

  // Sair da fila voluntariamente
  router.post('/sair', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      
      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
        [cod_profissional]
      );
      
      if (posicao.rows.length === 0) {
        return res.status(404).json({ error: 'Você não está na fila' });
      }
      
      const prof = posicao.rows[0];
      const central_id = prof.central_id;
      const tempoNaFila = Math.round((Date.now() - new Date(prof.entrada_fila_at || prof.saida_rota_at).getTime()) / 60000);
      
      await pool.query('DELETE FROM filas_posicoes WHERE cod_profissional = $1', [cod_profissional]);
      
      if (prof.status === 'aguardando' && prof.posicao) {
        await pool.query(`
          UPDATE filas_posicoes 
          SET posicao = posicao - 1 
          WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
        `, [central_id, prof.posicao]);
      }
      
      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
      
      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos)
        VALUES ($1, $2, $3, $4, 'saida_voluntaria', $5)
      `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional, tempoNaFila]);
      
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao sair da fila:', error);
      res.status(500).json({ error: 'Erro ao sair da fila' });
    }
  });

  // Ver minha posição e quem está na fila
  router.get('/minha-posicao', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      
      const minhaPosicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1',
        [cod_profissional]
      );
      
      if (minhaPosicao.rows.length === 0) {
        return res.json({ success: true, na_fila: false });
      }
      
      const eu = minhaPosicao.rows[0];
      const central_id = eu.central_id;
      
      if (eu.status === 'em_rota') {
        const minutosEmRota = Math.round((Date.now() - new Date(eu.saida_rota_at).getTime()) / 60000);
        return res.json({
          success: true,
          na_fila: true,
          status: 'em_rota',
          minutos_em_rota: minutosEmRota,
          saida_rota_at: eu.saida_rota_at,
          corrida_unica: eu.corrida_unica || false,
          posicao_original: eu.posicao_original || null
        });
      }
      
      const naFrente = await pool.query(`
        SELECT cod_profissional, nome_profissional, posicao, motivo_posicao
        FROM filas_posicoes 
        WHERE central_id = $1 AND status = 'aguardando' AND posicao < $2
        ORDER BY posicao DESC
        LIMIT 3
      `, [central_id, eu.posicao]);
      
      const atras = await pool.query(`
        SELECT cod_profissional, nome_profissional, posicao, motivo_posicao
        FROM filas_posicoes 
        WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
        ORDER BY posicao ASC
        LIMIT 3
      `, [central_id, eu.posicao]);
      
      const total = await pool.query(
        'SELECT COUNT(*) FROM filas_posicoes WHERE central_id = $1 AND status = $2',
        [central_id, 'aguardando']
      );
      
      const minutosEsperando = Math.round((Date.now() - new Date(eu.entrada_fila_at).getTime()) / 60000);
      
      res.json({
        success: true,
        na_fila: true,
        status: 'aguardando',
        minha_posicao: eu.posicao,
        total_na_fila: parseInt(total.rows[0].count),
        minutos_esperando: minutosEsperando,
        entrada_fila_at: eu.entrada_fila_at,
        na_frente: naFrente.rows.reverse(),
        atras: atras.rows
      });
    } catch (error) {
      console.error('❌ Erro ao buscar posição:', error);
      res.status(500).json({ error: 'Erro ao buscar posição' });
    }
  });

  // ==================== RELATÓRIOS E MÉTRICAS ====================

  // Estatísticas do dia
  router.get('/estatisticas/:central_id', verificarToken, async (req, res) => {
    try {
      const { central_id } = req.params;
      const { data } = req.query;
      
      const dataFiltro = data || new Date().toISOString().split('T')[0];
      
      const saidas = await pool.query(`
        SELECT COUNT(*) as total
        FROM filas_historico 
        WHERE central_id = $1 
          AND acao = 'enviado_rota'
          AND DATE(created_at) = $2
      `, [central_id, dataFiltro]);
      
      const tempoMedio = await pool.query(`
        SELECT AVG(tempo_espera_minutos) as media
        FROM filas_historico 
        WHERE central_id = $1 
          AND acao = 'enviado_rota'
          AND DATE(created_at) = $2
          AND tempo_espera_minutos IS NOT NULL
      `, [central_id, dataFiltro]);
      
      const ranking = await pool.query(`
        SELECT cod_profissional, nome_profissional, COUNT(*) as total_saidas
        FROM filas_historico 
        WHERE central_id = $1 
          AND acao = 'enviado_rota'
          AND DATE(created_at) = $2
        GROUP BY cod_profissional, nome_profissional
        ORDER BY total_saidas DESC
        LIMIT 10
      `, [central_id, dataFiltro]);
      
      const porHora = await pool.query(`
        SELECT EXTRACT(HOUR FROM created_at) as hora, COUNT(*) as total
        FROM filas_historico 
        WHERE central_id = $1 
          AND acao = 'enviado_rota'
          AND DATE(created_at) = $2
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY hora
      `, [central_id, dataFiltro]);
      
      res.json({
        success: true,
        data: dataFiltro,
        total_saidas: parseInt(saidas.rows[0].total),
        tempo_medio_espera: Math.round(parseFloat(tempoMedio.rows[0].media) || 0),
        ranking: ranking.rows,
        por_hora: porHora.rows
      });
    } catch (error) {
      console.error('❌ Erro ao buscar estatísticas:', error);
      res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
  });

  // Histórico detalhado
  router.get('/historico/:central_id', verificarToken, async (req, res) => {
    try {
      const { central_id } = req.params;
      const { data_inicio, data_fim, limit = 100 } = req.query;
      
      let query = `SELECT * FROM filas_historico WHERE central_id = $1`;
      const params = [central_id];
      
      if (data_inicio) {
        params.push(data_inicio);
        query += ` AND DATE(created_at) >= $${params.length}`;
      }
      
      if (data_fim) {
        params.push(data_fim);
        query += ` AND DATE(created_at) <= $${params.length}`;
      }
      
      query += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
      
      const result = await pool.query(query, params);
      
      res.json({ success: true, historico: result.rows });
    } catch (error) {
      console.error('❌ Erro ao buscar histórico:', error);
      res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
  });

  // ==================== NOTIFICAÇÕES DO MOTOBOY ====================

  // Buscar notificação pendente
  router.get('/minha-notificacao', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      const result = await pool.query(
        'SELECT * FROM filas_notificacoes WHERE cod_profissional = $1 AND lida = false ORDER BY created_at DESC LIMIT 1',
        [cod_profissional]
      );
      if (result.rows.length > 0) {
        res.json({ success: true, tem_notificacao: true, notificacao: result.rows[0] });
      } else {
        res.json({ success: true, tem_notificacao: false });
      }
    } catch (error) {
      console.error('❌ Erro ao buscar notificação:', error);
      res.status(500).json({ error: 'Erro ao buscar notificação' });
    }
  });

  // Marcar notificação como lida
  router.post('/notificacao-lida', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      await pool.query(
        'UPDATE filas_notificacoes SET lida = true WHERE cod_profissional = $1',
        [cod_profissional]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao marcar notificação:', error);
      res.status(500).json({ error: 'Erro ao marcar notificação' });
    }
  });

  return router;

  return router;
}

module.exports = { createFilasProfRoutes };
