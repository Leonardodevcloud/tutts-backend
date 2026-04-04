/**
 * Sub-Router: Filas Admin
 * V2: reordenar drag-drop, penalidades, regiões, cronômetro 1ª nota, limpar bairros
 */
const express = require('express');

function createFilasAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  router.get('/centrais', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT c.*, 
               COUNT(DISTINCT v.cod_profissional) as total_vinculados,
               COUNT(DISTINCT CASE WHEN p.status = 'aguardando' THEN p.cod_profissional END) as na_fila,
               COUNT(DISTINCT CASE WHEN p.status = 'em_rota' THEN p.cod_profissional END) as em_rota
        FROM filas_centrais c
        LEFT JOIN filas_vinculos v ON v.central_id = c.id AND v.ativo = true
        LEFT JOIN filas_posicoes p ON p.central_id = c.id
        GROUP BY c.id
        ORDER BY c.nome
      `);
      res.json({ success: true, centrais: result.rows });
    } catch (error) {
      console.error('❌ Erro ao listar centrais:', error);
      res.status(500).json({ error: 'Erro ao listar centrais' });
    }
  });

  // Criar nova central
  router.post('/centrais', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { nome, endereco, latitude, longitude, raio_metros } = req.body;
      
      if (!nome || !endereco || !latitude || !longitude) {
        return res.status(400).json({ error: 'Dados obrigatórios: nome, endereco, latitude, longitude' });
      }
      
      const result = await pool.query(`
        INSERT INTO filas_centrais (nome, endereco, latitude, longitude, raio_metros)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [nome, endereco, latitude, longitude, raio_metros || 900]);
      
      await registrarAuditoria(req, 'CRIAR_CENTRAL_FILA', 'admin', 'filas_centrais', result.rows[0].id, { nome, endereco });
      
      res.json({ success: true, central: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao criar central:', error);
      res.status(500).json({ error: 'Erro ao criar central' });
    }
  });

  // Atualizar central
  router.put('/centrais/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { nome, endereco, latitude, longitude, raio_metros, ativa } = req.body;
      
      const result = await pool.query(`
        UPDATE filas_centrais 
        SET nome = COALESCE($1, nome),
            endereco = COALESCE($2, endereco),
            latitude = COALESCE($3, latitude),
            longitude = COALESCE($4, longitude),
            raio_metros = COALESCE($5, raio_metros),
            ativa = COALESCE($6, ativa),
            updated_at = NOW()
        WHERE id = $7
        RETURNING *
      `, [nome, endereco, latitude, longitude, raio_metros, ativa, id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Central não encontrada' });
      }
      
      await registrarAuditoria(req, 'ATUALIZAR_CENTRAL_FILA', 'admin', 'filas_centrais', id, req.body);
      
      res.json({ success: true, central: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao atualizar central:', error);
      res.status(500).json({ error: 'Erro ao atualizar central' });
    }
  });

  // Deletar central
  router.delete('/centrais/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      const posicoes = await pool.query('SELECT COUNT(*) FROM filas_posicoes WHERE central_id = $1', [id]);
      if (parseInt(posicoes.rows[0].count) > 0) {
        return res.status(400).json({ error: 'Não é possível excluir central com profissionais na fila' });
      }
      
      await pool.query('DELETE FROM filas_centrais WHERE id = $1', [id]);
      await registrarAuditoria(req, 'EXCLUIR_CENTRAL_FILA', 'admin', 'filas_centrais', id);
      
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao deletar central:', error);
      res.status(500).json({ error: 'Erro ao deletar central' });
    }
  });

  // ==================== GESTÃO DE VÍNCULOS (ADMIN) ====================

  // Listar profissionais vinculados a uma central
  router.get('/centrais/:id/vinculos', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`
        SELECT v.*, 
               p.status as status_fila,
               p.posicao,
               p.entrada_fila_at,
               p.saida_rota_at
        FROM filas_vinculos v
        LEFT JOIN filas_posicoes p ON p.cod_profissional = v.cod_profissional AND p.central_id = v.central_id
        WHERE v.central_id = $1 AND v.ativo = true
        ORDER BY v.nome_profissional
      `, [id]);
      res.json({ success: true, vinculos: result.rows });
    } catch (error) {
      console.error('❌ Erro ao listar vínculos:', error);
      res.status(500).json({ error: 'Erro ao listar vínculos' });
    }
  });

  // Vincular profissional a uma central
  router.post('/vinculos', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id, cod_profissional, nome_profissional } = req.body;
      
      if (!central_id || !cod_profissional) {
        return res.status(400).json({ error: 'central_id e cod_profissional são obrigatórios' });
      }
      
      const existente = await pool.query(
        'SELECT * FROM filas_vinculos WHERE cod_profissional = $1 AND ativo = true',
        [cod_profissional]
      );
      
      if (existente.rows.length > 0) {
        return res.status(400).json({ 
          error: 'Profissional já está vinculado a outra central',
          central_atual: existente.rows[0].central_id
        });
      }
      
      const result = await pool.query(`
        INSERT INTO filas_vinculos (central_id, cod_profissional, nome_profissional)
        VALUES ($1, $2, $3)
        ON CONFLICT (cod_profissional) DO UPDATE SET
            central_id = $1,
            nome_profissional = $3,
            ativo = true
        RETURNING *
      `, [central_id, cod_profissional, nome_profissional]);
      
      await registrarAuditoria(req, 'VINCULAR_PROFISSIONAL_CENTRAL', 'admin', 'filas_vinculos', result.rows[0].id, 
        { central_id, cod_profissional, nome_profissional });
      
      res.json({ success: true, vinculo: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao vincular profissional:', error);
      res.status(500).json({ error: 'Erro ao vincular profissional' });
    }
  });

  // Desvincular profissional
  router.delete('/vinculos/:cod_profissional', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional } = req.params;
      
      await pool.query('DELETE FROM filas_posicoes WHERE cod_profissional = $1', [cod_profissional]);
      await pool.query('UPDATE filas_vinculos SET ativo = false WHERE cod_profissional = $1', [cod_profissional]);
      
      await registrarAuditoria(req, 'DESVINCULAR_PROFISSIONAL_CENTRAL', 'admin', 'filas_vinculos', null, { cod_profissional });
      
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao desvincular profissional:', error);
      res.status(500).json({ error: 'Erro ao desvincular profissional' });
    }
  });

  // ==================== OPERAÇÕES DA FILA (ADMIN) ====================

  // Obter fila em tempo real de uma central
  router.get('/centrais/:id/fila', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      
      const aguardando = await pool.query(`
        SELECT *, 
               EXTRACT(EPOCH FROM (NOW() - entrada_fila_at))/60 as minutos_esperando,
               EXTRACT(EPOCH FROM (NOW() - primeira_nota_at))/60 as minutos_desde_primeira_nota
        FROM filas_posicoes 
        WHERE central_id = $1 AND status = 'aguardando'
        ORDER BY posicao ASC
      `, [id]);
      
      const emRota = await pool.query(`
        SELECT *,
               EXTRACT(EPOCH FROM (NOW() - saida_rota_at))/60 as minutos_em_rota
        FROM filas_posicoes 
        WHERE central_id = $1 AND status = 'em_rota'
        ORDER BY saida_rota_at ASC
      `, [id]);
      
      const alertas = emRota.rows.filter(p => p.minutos_em_rota > 90);
      
      res.json({ 
        success: true, 
        aguardando: aguardando.rows,
        em_rota: emRota.rows,
        alertas: alertas,
        total_aguardando: aguardando.rows.length,
        total_em_rota: emRota.rows.length
      });
    } catch (error) {
      console.error('❌ Erro ao obter fila:', error);
      res.status(500).json({ error: 'Erro ao obter fila' });
    }
  });

  // Enviar profissional para roteiro
  router.post('/enviar-rota', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      
      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2 AND status = $3',
        [cod_profissional, central_id, 'aguardando']
      );
      
      if (posicao.rows.length === 0) {
        return res.status(404).json({ error: 'Profissional não encontrado na fila' });
      }
      
      const prof = posicao.rows[0];
      const tempoEspera = Math.round((Date.now() - new Date(prof.entrada_fila_at).getTime()) / 60000);
      
      await pool.query(`
        UPDATE filas_posicoes 
        SET status = 'em_rota', 
            saida_rota_at = NOW(),
            posicao = NULL,
            updated_at = NOW()
        WHERE cod_profissional = $1 AND central_id = $2
      `, [cod_profissional, central_id]);
      
      await pool.query(`
        UPDATE filas_posicoes 
        SET posicao = posicao - 1 
        WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
      `, [central_id, prof.posicao]);
      
      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
      
      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, 'enviado_rota', $5, $6, $7)
      `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional, tempoEspera, req.user.codProfissional, req.user.nome]);
      
      res.json({ success: true, tempo_espera: tempoEspera, notas_liberadas: parseInt(prof.notas_liberadas) || 0 });
      
      const totalNotas = parseInt(prof.notas_liberadas) || 0;
      const msgDespacho = totalNotas > 0
        ? `✅ Todas as ${totalNotas} nota(s) foram liberadas. Siga para o roteiro! Nenhuma outra nota adicional será atribuída.`
        : '🚀 Seu roteiro já foi definido, não há possibilidade de novas coletas. Retire a mercadoria na expedição e boas entregas!';
      
      pool.query(`
        INSERT INTO filas_notificacoes (cod_profissional, tipo, mensagem, dados)
        VALUES ($1, 'roteiro_despachado', $2, $3)
        ON CONFLICT (cod_profissional) DO UPDATE SET tipo = 'roteiro_despachado', mensagem = $2, dados = $3, lida = false, created_at = NOW()
      `, [cod_profissional, msgDespacho, JSON.stringify({ tempo_espera: tempoEspera, central: central.rows[0]?.nome, notas_liberadas: totalNotas })]).catch(() => {});
      
      registrarAuditoria(req, 'ENVIAR_PARA_ROTA', 'admin', 'filas_posicoes', null, 
        { cod_profissional, central_id, tempo_espera: tempoEspera }).catch(() => {});
      
    } catch (error) {
      console.error('❌ Erro ao enviar para rota:', error);
      res.status(500).json({ error: 'Erro ao enviar para rota' });
    }
  });

  // Enviar para Rota Única (com bônus e prioridade de retorno)
  router.post('/enviar-rota-unica', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      
      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2 AND status = $3',
        [cod_profissional, central_id, 'aguardando']
      );
      
      if (posicao.rows.length === 0) {
        return res.status(404).json({ error: 'Profissional não encontrado na fila' });
      }
      
      const prof = posicao.rows[0];
      const tempoEspera = Math.round((Date.now() - new Date(prof.entrada_fila_at).getTime()) / 60000);
      const posicaoOriginal = prof.posicao;
      
      await pool.query(`
        UPDATE filas_posicoes 
        SET status = 'em_rota', 
            saida_rota_at = NOW(),
            posicao = NULL,
            corrida_unica = TRUE,
            posicao_original = $3,
            updated_at = NOW()
        WHERE cod_profissional = $1 AND central_id = $2
      `, [cod_profissional, central_id, posicaoOriginal]);
      
      await pool.query(`
        UPDATE filas_posicoes 
        SET posicao = posicao - 1 
        WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
      `, [central_id, posicaoOriginal]);
      
      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
      
      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, 'enviado_rota_unica', $5, $6, $7, $8)
      `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional, tempoEspera, 
        `Corrida única - Posição original: ${posicaoOriginal}`, req.user.codProfissional, req.user.nome]);
      
      res.json({ success: true, tempo_espera: tempoEspera, corrida_unica: true, posicao_retorno: posicaoOriginal });
      
      pool.query(`
        INSERT INTO filas_notificacoes (cod_profissional, tipo, mensagem, dados)
        VALUES ($1, 'corrida_unica', $2, $3)
        ON CONFLICT (cod_profissional) DO UPDATE SET tipo = 'corrida_unica', mensagem = $2, dados = $3, lida = false, created_at = NOW()
      `, [cod_profissional, '👑 Seu roteiro já foi definido, e você saiu com apenas uma corrida! Não há possibilidade de novas coletas. Retire a mercadoria na expedição e boas entregas! O seu bônus já está adicionado!', JSON.stringify({ tempo_espera: tempoEspera, central: central.rows[0]?.nome, posicao_retorno: posicaoOriginal, bonus: true })]).catch(() => {});
      
      registrarAuditoria(req, 'ENVIAR_PARA_ROTA_UNICA', 'admin', 'filas_posicoes', null, 
        { cod_profissional, central_id, tempo_espera: tempoEspera, posicao_original: posicaoOriginal }).catch(() => {});
      
    } catch (error) {
      console.error('❌ Erro ao enviar para rota única:', error);
      res.status(500).json({ error: 'Erro ao enviar para rota única' });
    }
  });

  // Mover para Último (recusou roteiro)
  router.post('/mover-ultimo', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      
      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2 AND status = $3',
        [cod_profissional, central_id, 'aguardando']
      );
      
      if (posicao.rows.length === 0) {
        return res.status(404).json({ error: 'Profissional não encontrado na fila' });
      }
      
      const prof = posicao.rows[0];
      const posicaoAnterior = prof.posicao;
      
      const ultimaPosicao = await pool.query(
        'SELECT COALESCE(MAX(posicao), 0) as max_pos FROM filas_posicoes WHERE central_id = $1 AND status = $2',
        [central_id, 'aguardando']
      );
      const novaPosicao = ultimaPosicao.rows[0].max_pos;
      
      if (posicaoAnterior === novaPosicao) {
        return res.json({ success: true, message: 'Profissional já está na última posição', posicao: novaPosicao });
      }
      
      await pool.query(`
        UPDATE filas_posicoes 
        SET posicao = posicao - 1
        WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
      `, [central_id, posicaoAnterior]);
      
      await pool.query(`
        UPDATE filas_posicoes 
        SET posicao = $3,
            corrida_unica = FALSE,
            posicao_original = NULL,
            motivo_posicao = 'movido_ultimo'
        WHERE cod_profissional = $1 AND central_id = $2
      `, [cod_profissional, central_id, novaPosicao]);
      
      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
      
      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, 'movido_ultimo', $5, $6, $7)
      `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional,
        `Movido da posição ${posicaoAnterior} para ${novaPosicao}`, req.user.codProfissional, req.user.nome]);

      // ── Penalidade progressiva ──
      // Contar quantas vezes foi movido hoje nesta central
      const movimentosHoje = await pool.query(
        `SELECT COUNT(*) as total FROM filas_historico
         WHERE cod_profissional = $1 AND central_id = $2 AND acao = 'movido_ultimo'
         AND created_at::date = CURRENT_DATE`,
        [cod_profissional, central_id]
      );
      const vezesMovido = parseInt(movimentosHoje.rows[0].total) || 0; // Já inclui o INSERT acima

      let penalidade = null;
      let mensagemUsuario = '';
      let proximaPunicao = '';

      if (vezesMovido >= 3) {
        // 3ª vez: bloqueia 24h
        const bloqueadoAte = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await pool.query(`
          INSERT INTO filas_penalidades (central_id, cod_profissional, nome_profissional, saidas_hoje, bloqueado_ate, data_ref)
          VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
          ON CONFLICT (cod_profissional, central_id, data_ref)
          DO UPDATE SET saidas_hoje = $4, bloqueado_ate = $5, updated_at = NOW()
        `, [central_id, cod_profissional, prof.nome_profissional, vezesMovido, bloqueadoAte]);

        // Remover da fila
        await pool.query(
          `DELETE FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2`,
          [cod_profissional, central_id]
        );

        penalidade = { minutos: 1440, bloqueado_ate: bloqueadoAte };
        mensagemUsuario = 'Você foi movido para o final da fila pois não teve disponibilidade para executar o roteiro ofertado.';
        proximaPunicao = 'Você está impedido de entrar na fila por 24 horas.';
      } else if (vezesMovido === 2) {
        // 2ª vez: bloqueia 2h
        const bloqueadoAte = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await pool.query(`
          INSERT INTO filas_penalidades (central_id, cod_profissional, nome_profissional, saidas_hoje, bloqueado_ate, data_ref)
          VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
          ON CONFLICT (cod_profissional, central_id, data_ref)
          DO UPDATE SET saidas_hoje = $4, bloqueado_ate = $5, updated_at = NOW()
        `, [central_id, cod_profissional, prof.nome_profissional, vezesMovido, bloqueadoAte]);

        // Remover da fila
        await pool.query(
          `DELETE FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2`,
          [cod_profissional, central_id]
        );

        penalidade = { minutos: 120, bloqueado_ate: bloqueadoAte };
        mensagemUsuario = 'Você foi movido para o final da fila pois não teve disponibilidade para executar o roteiro ofertado.';
        proximaPunicao = 'Você está impedido de entrar na fila por 2 horas. Caso ocorra novamente, será impedido por 24 horas.';
      } else {
        // 1ª vez: só aviso
        mensagemUsuario = 'Você foi movido para o final da fila pois não teve disponibilidade para executar o roteiro ofertado.';
        proximaPunicao = 'Caso isso ocorra novamente, você será impedido de entrar na fila por 2 horas.';
      }

      // 🔔 Notificar motoboy via WebSocket
      if (typeof global.sendToUser === 'function') {
        global.sendToUser(cod_profissional, 'FILA_MOVIDO_ULTIMO', {
          central_id,
          central_nome: central.rows[0]?.nome || '',
          posicao_anterior: posicaoAnterior,
          posicao_nova: novaPosicao,
          vezes_movido: vezesMovido,
          mensagem: mensagemUsuario,
          proxima_punicao: proximaPunicao,
          penalidade,
        });
      }
      
      res.json({
        success: true,
        posicao_anterior: posicaoAnterior,
        posicao_nova: novaPosicao,
        vezes_movido: vezesMovido,
        penalidade,
      });
      
      registrarAuditoria(req, 'MOVER_PARA_ULTIMO', 'admin', 'filas_posicoes', null, 
        { cod_profissional, central_id, posicao_anterior: posicaoAnterior, posicao_nova: novaPosicao, vezes_movido: vezesMovido }).catch(() => {});
      
    } catch (error) {
      console.error('❌ Erro ao mover para último:', error);
      res.status(500).json({ error: 'Erro ao mover para último' });
    }
  });

  // ==================== REORDENAR FILA (DRAG-DROP) ====================

  router.post('/reordenar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id, cod_profissional, nova_posicao } = req.body;
      
      if (!central_id || !cod_profissional || !nova_posicao) {
        return res.status(400).json({ error: 'central_id, cod_profissional e nova_posicao são obrigatórios' });
      }

      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2 AND status = $3',
        [cod_profissional, central_id, 'aguardando']
      );

      if (posicao.rows.length === 0) {
        return res.status(404).json({ error: 'Profissional não encontrado na fila' });
      }

      const posicaoAtual = posicao.rows[0].posicao;
      const novaPosInt = parseInt(nova_posicao);

      if (posicaoAtual === novaPosInt) {
        return res.json({ success: true, message: 'Posição inalterada' });
      }

      // Mover para frente (ex: pos 5 -> pos 2): quem está entre 2 e 4 desce +1
      if (novaPosInt < posicaoAtual) {
        await pool.query(`
          UPDATE filas_posicoes 
          SET posicao = posicao + 1
          WHERE central_id = $1 AND status = 'aguardando' 
            AND posicao >= $2 AND posicao < $3
            AND cod_profissional != $4
        `, [central_id, novaPosInt, posicaoAtual, cod_profissional]);
      } else {
        // Mover para trás (ex: pos 1 -> pos 3): quem está entre 2 e 3 sobe -1
        await pool.query(`
          UPDATE filas_posicoes 
          SET posicao = posicao - 1
          WHERE central_id = $1 AND status = 'aguardando' 
            AND posicao > $2 AND posicao <= $3
            AND cod_profissional != $4
        `, [central_id, posicaoAtual, novaPosInt, cod_profissional]);
      }

      await pool.query(`
        UPDATE filas_posicoes 
        SET posicao = $1, motivo_posicao = 'reordenado_admin', updated_at = NOW()
        WHERE cod_profissional = $2 AND central_id = $3
      `, [novaPosInt, cod_profissional, central_id]);

      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);

      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, 'reordenado', $5, $6, $7)
      `, [central_id, central.rows[0]?.nome, cod_profissional, posicao.rows[0].nome_profissional,
        `Movido da posição ${posicaoAtual} para ${novaPosInt}`, req.user.codProfissional, req.user.nome]);

      res.json({ success: true, posicao_anterior: posicaoAtual, posicao_nova: novaPosInt });

      registrarAuditoria(req, 'REORDENAR_FILA', 'admin', 'filas_posicoes', null,
        { cod_profissional, central_id, posicao_anterior: posicaoAtual, nova_posicao: novaPosInt }).catch(() => {});

    } catch (error) {
      console.error('❌ Erro ao reordenar:', error);
      res.status(500).json({ error: 'Erro ao reordenar fila' });
    }
  });

  // Remover profissional da fila (admin)
  router.post('/remover', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id, observacao } = req.body;
      
      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2',
        [cod_profissional, central_id]
      );
      
      if (posicao.rows.length === 0) {
        return res.status(404).json({ error: 'Profissional não encontrado na fila' });
      }
      
      const prof = posicao.rows[0];
      const tempoNaFila = Math.round((Date.now() - new Date(prof.entrada_fila_at || prof.saida_rota_at).getTime()) / 60000);
      
      await pool.query('DELETE FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2', [cod_profissional, central_id]);
      
      if (prof.status === 'aguardando' && prof.posicao) {
        await pool.query(`
          UPDATE filas_posicoes 
          SET posicao = posicao - 1 
          WHERE central_id = $1 AND status = 'aguardando' AND posicao > $2
        `, [central_id, prof.posicao]);
      }
      
      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
      
      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, tempo_espera_minutos, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, 'removido', $5, $6, $7, $8)
      `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional, tempoNaFila, observacao, req.user.codProfissional, req.user.nome]);
      
      res.json({ success: true });
      
      registrarAuditoria(req, 'REMOVER_DA_FILA', 'admin', 'filas_posicoes', null, 
        { cod_profissional, central_id, observacao }).catch(() => {});
      
    } catch (error) {
      console.error('❌ Erro ao remover da fila:', error);
      res.status(500).json({ error: 'Erro ao remover da fila' });
    }
  });

  // ==================== LIMPAR BAIRROS DE UM PROFISSIONAL ====================

  router.post('/limpar-bairros', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      if (!cod_profissional || !central_id) return res.status(400).json({ error: 'cod_profissional e central_id obrigatórios' });
      
      await pool.query(
        `UPDATE filas_posicoes SET bairros = '[]'::jsonb, updated_at = NOW() WHERE cod_profissional = $1 AND central_id = $2`,
        [cod_profissional, central_id]
      );
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao limpar bairros' });
    }
  });

  // ==================== BAIRROS CONFIG ====================

  // Listar bairros de uma central (com região)
  router.get('/bairros-config/:central_id', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT b.*, r.nome as regiao_nome 
         FROM filas_bairros_config b 
         LEFT JOIN filas_regioes r ON r.id = b.regiao_id
         WHERE b.central_id = $1 ORDER BY r.nome NULLS LAST, b.nome`,
        [req.params.central_id]
      );
      res.json({ success: true, bairros: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao listar bairros' });
    }
  });

  // Adicionar bairro
  router.post('/bairros-config', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id, nome, regiao_id } = req.body;
      if (!central_id || !nome?.trim()) return res.status(400).json({ error: 'central_id e nome obrigatórios' });
      const nomeUpper = nome.trim().toUpperCase();
      const result = await pool.query(
        'INSERT INTO filas_bairros_config (central_id, nome, regiao_id) VALUES ($1, $2, $3) ON CONFLICT (central_id, nome) DO NOTHING RETURNING *',
        [central_id, nomeUpper, regiao_id || null]
      );
      if (result.rows.length === 0) return res.json({ success: true, msg: 'Já existe' });
      res.json({ success: true, bairro: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao adicionar bairro' });
    }
  });

  // Atualizar região de um bairro
  router.put('/bairros-config/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { regiao_id } = req.body;
      await pool.query('UPDATE filas_bairros_config SET regiao_id = $1 WHERE id = $2', [regiao_id || null, req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao atualizar bairro' });
    }
  });

  // Remover bairro
  router.delete('/bairros-config/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      await pool.query('DELETE FROM filas_bairros_config WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao remover bairro' });
    }
  });

  // Atribuir bairros a um profissional na fila
  router.post('/atribuir-bairros', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id, bairros } = req.body;
      if (!cod_profissional || !central_id) return res.status(400).json({ error: 'cod_profissional e central_id obrigatórios' });
      
      const bairrosArr = Array.isArray(bairros) ? bairros : [];
      await pool.query(
        'UPDATE filas_posicoes SET bairros = $1::jsonb, updated_at = NOW() WHERE cod_profissional = $2 AND central_id = $3',
        [JSON.stringify(bairrosArr), cod_profissional, central_id]
      );
      
      res.json({ success: true, bairros: bairrosArr });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao atribuir bairros' });
    }
  });

  // ==================== REGIÕES DE ROTAS ====================

  router.get('/regioes/:central_id', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT r.*, COUNT(b.id) as total_bairros FROM filas_regioes r LEFT JOIN filas_bairros_config b ON b.regiao_id = r.id WHERE r.central_id = $1 GROUP BY r.id ORDER BY r.nome',
        [req.params.central_id]
      );
      res.json({ success: true, regioes: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao listar regiões' });
    }
  });

  router.post('/regioes', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id, nome } = req.body;
      if (!central_id || !nome?.trim()) return res.status(400).json({ error: 'central_id e nome obrigatórios' });
      const result = await pool.query(
        'INSERT INTO filas_regioes (central_id, nome) VALUES ($1, $2) ON CONFLICT (central_id, nome) DO NOTHING RETURNING *',
        [central_id, nome.trim().toUpperCase()]
      );
      if (result.rows.length === 0) return res.json({ success: true, msg: 'Já existe' });
      res.json({ success: true, regiao: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao criar região' });
    }
  });

  router.delete('/regioes/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      await pool.query('UPDATE filas_bairros_config SET regiao_id = NULL WHERE regiao_id = $1', [req.params.id]);
      await pool.query('DELETE FROM filas_regioes WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao remover região' });
    }
  });

  // ==================== LIBERAÇÃO GRADATIVA DE NOTAS ====================

  // Liberar próxima nota de um profissional na fila
  router.post('/liberar-nota', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      
      const posicao = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2 AND status = $3',
        [cod_profissional, central_id, 'aguardando']
      );
      
      if (posicao.rows.length === 0) {
        return res.status(404).json({ error: 'Profissional não encontrado na fila' });
      }
      
      const prof = posicao.rows[0];
      const novasNotas = (parseInt(prof.notas_liberadas) || 0) + 1;
      
      // Se é a primeira nota, marcar timestamp para cronômetro
      const setPrimeiraNota = novasNotas === 1 ? ', primeira_nota_at = NOW()' : '';
      
      await pool.query(
        `UPDATE filas_posicoes SET notas_liberadas = $1${setPrimeiraNota}, updated_at = NOW() WHERE cod_profissional = $2 AND central_id = $3`,
        [novasNotas, cod_profissional, central_id]
      );
      
      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);
      
      // Registrar no histórico
      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, 'nota_liberada', $5, $6, $7)
      `, [central_id, central.rows[0]?.nome, cod_profissional, prof.nome_profissional,
        `Nota ${novasNotas} liberada`, req.user.codProfissional, req.user.nome]);
      
      // Notificar o profissional
      const msgNota = `📦 A ${novasNotas}ª nota já foi liberada! Verifique o APP Tutts e realize a coleta.`;
      await pool.query(`
        INSERT INTO filas_notificacoes (cod_profissional, tipo, mensagem, dados)
        VALUES ($1, 'nota_liberada', $2, $3)
        ON CONFLICT (cod_profissional) DO UPDATE SET tipo = 'nota_liberada', mensagem = $2, dados = $3, lida = false, created_at = NOW()
      `, [cod_profissional, msgNota, JSON.stringify({ 
        notas_liberadas: novasNotas, 
        central: central.rows[0]?.nome,
        admin: req.user.nome
      })]);
      
      console.log(`📦 Nota ${novasNotas} liberada para ${prof.nome_profissional} (${cod_profissional}) por ${req.user.codProfissional}`);
      
      res.json({ success: true, notas_liberadas: novasNotas, profissional: prof.nome_profissional });
      
      registrarAuditoria(req, 'LIBERAR_NOTA', 'admin', 'filas_posicoes', null, 
        { cod_profissional, central_id, nota_numero: novasNotas }).catch(() => {});
      
    } catch (error) {
      console.error('❌ Erro ao liberar nota:', error);
      res.status(500).json({ error: 'Erro ao liberar nota' });
    }
  });

  // ==================== PENALIDADES (ADMIN) ====================

  // Listar penalidades ativas de uma central
  router.get('/penalidades/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT * FROM filas_penalidades 
        WHERE central_id = $1 AND bloqueado_ate > NOW() AND anulado_em IS NULL
        ORDER BY bloqueado_ate DESC
      `, [req.params.central_id]);
      res.json({ success: true, penalidades: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao listar penalidades' });
    }
  });

  // Anular penalidade (devolver motoboy)
  router.post('/anular-penalidade', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      if (!cod_profissional || !central_id) return res.status(400).json({ error: 'Dados obrigatórios' });

      await pool.query(`
        UPDATE filas_penalidades 
        SET anulado_por = $1, anulado_em = NOW(), bloqueado_ate = NOW(), updated_at = NOW()
        WHERE cod_profissional = $2 AND central_id = $3 AND bloqueado_ate > NOW() AND anulado_em IS NULL
      `, [req.user.codProfissional, cod_profissional, central_id]);

      const central = await pool.query('SELECT nome FROM filas_centrais WHERE id = $1', [central_id]);

      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, '', 'penalidade_anulada', 'Penalidade anulada pelo admin', $4, $5)
      `, [central_id, central.rows[0]?.nome, cod_profissional, req.user.codProfissional, req.user.nome]);

      res.json({ success: true });

      registrarAuditoria(req, 'ANULAR_PENALIDADE', 'admin', 'filas_penalidades', null,
        { cod_profissional, central_id }).catch(() => {});

    } catch (error) {
      console.error('❌ Erro ao anular penalidade:', error);
      res.status(500).json({ error: 'Erro ao anular penalidade' });
    }
  });

  return router;
}

module.exports = { createFilasAdminRoutes };
