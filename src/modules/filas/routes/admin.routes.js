/**
 * Sub-Router: Filas Admin
 * V2: reordenar drag-drop, penalidades, regiões, cronômetro 1ª nota, limpar bairros
 */
const express = require('express');
// 🆕 2026-05-24: integração filas → disponibilidade (marcar EM LOJA automático)
const { marcarMotoboyEmLoja } = require('../../disponibilidade/disponibilidade.shared');

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
      
      // 🆕 2026-05: endereço é opcional (central auto-gerenciável pode ser ponto de GPS sem rua nominal)
      if (!nome || !latitude || !longitude) {
        return res.status(400).json({ error: 'Dados obrigatórios: nome, latitude, longitude' });
      }
      
      const result = await pool.query(`
        INSERT INTO filas_centrais (nome, endereco, latitude, longitude, raio_metros)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [nome, endereco || null, latitude, longitude, raio_metros || 900]);
      
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
            motivo_posicao = 'movido_ultimo',
            bairros = '[]'::jsonb,
            notas_liberadas = 0,
            primeira_nota_at = NULL
        WHERE cod_profissional = $1 AND central_id = $2
      `, [cod_profissional, central_id, novaPosicao]);
      // 🔧 2026-05: limpa tags de bairro + reseta contador de notas ao mover pro final.
      // Quando ele voltar pro topo, vai trabalhar com bairros novos definidos pelo admin.
      
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
  // 🆕 2026-05: agora retorna 'tipo' (automatica/manual), motivo_admin, aplicado_por_nome
  // pro front mostrar badge e quem aplicou (motivo NÃO é exposto pro motoboy, só pro admin)
  router.get('/penalidades/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, central_id, cod_profissional, nome_profissional, saidas_hoje,
               bloqueado_ate, anulado_por, anulado_em, data_ref, created_at, updated_at,
               COALESCE(tipo, 'automatica') AS tipo,
               motivo_admin,
               aplicado_por_cod, aplicado_por_nome
        FROM filas_penalidades 
        WHERE central_id = $1 AND bloqueado_ate > NOW() AND anulado_em IS NULL
        ORDER BY bloqueado_ate DESC
      `, [req.params.central_id]);
      res.json({ success: true, penalidades: result.rows });
    } catch (error) {
      console.error('❌ Erro ao listar penalidades:', error);
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

  // ==================== 🆕 2026-05: APLICAR PUNIÇÃO MANUAL ====================
  // Admin aplica penalidade direto num motoboy vinculado à central.
  // Regras:
  //   - Tempo: minutos (qualquer valor entre 1 e 10080 = 7 dias). Front oferece chips
  //     fixos (30/60/120/240/480/1440/2880) + opção 'Personalizado'.
  //   - Motoboy precisa estar vinculado à central (validação anti-erro).
  //   - Motivo é OPCIONAL (texto livre, só pro registro interno; nunca é exposto pro motoboy).
  //   - Se motoboy está na fila → remove (igual gatilho automático de mover-ultimo).
  //   - UPSERT: se já tem penalidade hoje, mantém o MAIOR bloqueio (não diminui punição
  //     automática preexistente). saidas_hoje é PRESERVADO (punição manual não deve
  //     resetar contador automático). Tipo vira 'manual' se for o caso novo, senão preserva.
  //   - Notifica motoboy via WebSocket (sem expor motivo).
  router.post('/aplicar-penalidade', verificarToken, verificarAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const { cod_profissional, central_id, minutos, motivo } = req.body || {};

      // ── Validações ──
      if (!cod_profissional || !central_id) {
        return res.status(400).json({ error: 'cod_profissional e central_id são obrigatórios' });
      }
      const minutosNum = parseInt(minutos);
      if (!Number.isFinite(minutosNum) || minutosNum < 1 || minutosNum > 10080) {
        return res.status(400).json({ error: 'minutos deve ser inteiro entre 1 e 10080 (7 dias)' });
      }
      const motivoLimpo = (typeof motivo === 'string' ? motivo : '').trim().slice(0, 500) || null;

      await client.query('BEGIN');

      // Verificar vínculo (motoboy precisa estar vinculado à central)
      const vinculo = await client.query(
        `SELECT v.cod_profissional, v.nome_profissional, c.nome AS central_nome
         FROM filas_vinculos v
         JOIN filas_centrais c ON c.id = v.central_id
         WHERE v.cod_profissional = $1 AND v.central_id = $2 AND v.ativo = true`,
        [cod_profissional, central_id]
      );
      if (vinculo.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Motoboy não vinculado a esta central' });
      }
      const nome_profissional = vinculo.rows[0].nome_profissional;
      const central_nome = vinculo.rows[0].central_nome;

      const novoBloqueadoAte = new Date(Date.now() + minutosNum * 60 * 1000);

      // UPSERT: respeita o MAIOR bloqueio existente. Se já tem penalidade hoje
      // (automática ou manual) e admin aplica uma menor, MANTÉM a maior.
      // Se admin aplica uma maior, ATUALIZA.
      // Tipo: vira 'manual' se for novo OU se a manual foi maior; senão preserva.
      const upsert = await client.query(`
        INSERT INTO filas_penalidades (
          central_id, cod_profissional, nome_profissional, saidas_hoje,
          bloqueado_ate, data_ref, tipo, motivo_admin, aplicado_por_cod, aplicado_por_nome
        ) VALUES ($1, $2, $3, 0, $4, CURRENT_DATE, 'manual', $5, $6, $7)
        ON CONFLICT (cod_profissional, central_id, data_ref) DO UPDATE SET
          bloqueado_ate = GREATEST(EXCLUDED.bloqueado_ate, filas_penalidades.bloqueado_ate),
          tipo = CASE WHEN EXCLUDED.bloqueado_ate >= filas_penalidades.bloqueado_ate
                      THEN 'manual'
                      ELSE COALESCE(filas_penalidades.tipo, 'automatica') END,
          motivo_admin = CASE WHEN EXCLUDED.bloqueado_ate >= filas_penalidades.bloqueado_ate
                              THEN EXCLUDED.motivo_admin
                              ELSE filas_penalidades.motivo_admin END,
          aplicado_por_cod = CASE WHEN EXCLUDED.bloqueado_ate >= filas_penalidades.bloqueado_ate
                                  THEN EXCLUDED.aplicado_por_cod
                                  ELSE filas_penalidades.aplicado_por_cod END,
          aplicado_por_nome = CASE WHEN EXCLUDED.bloqueado_ate >= filas_penalidades.bloqueado_ate
                                   THEN EXCLUDED.aplicado_por_nome
                                   ELSE filas_penalidades.aplicado_por_nome END,
          anulado_em = NULL,
          anulado_por = NULL,
          updated_at = NOW()
        RETURNING id, bloqueado_ate, tipo
      `, [central_id, cod_profissional, nome_profissional, novoBloqueadoAte,
          motivoLimpo, req.user.codProfissional, req.user.nome]);

      const bloqueadoAteFinal = upsert.rows[0].bloqueado_ate;
      const aumentou = new Date(bloqueadoAteFinal).getTime() >= novoBloqueadoAte.getTime() - 1000;

      // Remover da fila se estiver (mesmo padrão do gatilho automático)
      const removido = await client.query(
        `DELETE FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2 RETURNING id`,
        [cod_profissional, central_id]
      );
      const estavaNaFila = removido.rows.length > 0;

      // Histórico (motivo NÃO é incluído na observação visível na timeline padrão;
      // fica em audit log via registrarAuditoria mais abaixo)
      await client.query(`
        INSERT INTO filas_historico (
          central_id, central_nome, cod_profissional, nome_profissional,
          acao, observacao, admin_cod, admin_nome
        ) VALUES ($1, $2, $3, $4, 'penalidade_manual', $5, $6, $7)
      `, [central_id, central_nome, cod_profissional, nome_profissional,
          `Punição manual de ${minutosNum} min aplicada${estavaNaFila ? ' (removido da fila)' : ''}`,
          req.user.codProfissional, req.user.nome]);

      await client.query('COMMIT');

      // 🔔 WebSocket — avisa motoboy em tempo real (sem expor motivo)
      if (typeof global.sendToUser === 'function') {
        global.sendToUser(cod_profissional, 'FILA_PUNIDO_ADMIN', {
          central_id,
          central_nome,
          bloqueado_ate: bloqueadoAteFinal,
          minutos_bloqueio: minutosNum,
          mensagem: 'Você foi bloqueado da fila pela administração.'
        });
      }

      res.json({
        success: true,
        penalidade: {
          id: upsert.rows[0].id,
          bloqueado_ate: bloqueadoAteFinal,
          tipo: upsert.rows[0].tipo,
          minutos: minutosNum,
          ja_havia_penalidade_maior: !aumentou,
          removido_da_fila: estavaNaFila
        }
      });

      // 🔒 Auditoria registra motivo (acesso restrito) — fora do response pra fire-and-forget
      registrarAuditoria(req, 'APLICAR_PENALIDADE_MANUAL', 'admin', 'filas_penalidades',
        upsert.rows[0].id,
        { cod_profissional, central_id, minutos: minutosNum, motivo: motivoLimpo,
          removido_da_fila: estavaNaFila }
      ).catch(() => {});

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch(_) {}
      console.error('❌ Erro ao aplicar penalidade manual:', error);
      res.status(500).json({ error: 'Erro ao aplicar penalidade' });
    } finally {
      client.release();
    }
  });

  // 🚀 2026-05: Admin coloca motoboy vinculado direto na fila
  // Sem checagem de GPS / penalidade (admin tem autoridade pra ignorar)
  router.post('/colocar-na-fila', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      if (!cod_profissional || !central_id) {
        return res.status(400).json({ error: 'cod_profissional e central_id são obrigatórios' });
      }

      // 1. Confirma vínculo
      const vinc = await pool.query(`
        SELECT v.cod_profissional, v.nome_profissional, c.nome AS central_nome
        FROM filas_vinculos v
        JOIN filas_centrais c ON c.id = v.central_id
        WHERE v.cod_profissional = $1 AND v.central_id = $2 AND v.ativo = true AND c.ativa = true
      `, [cod_profissional, central_id]);
      if (vinc.rows.length === 0) {
        return res.status(403).json({ error: 'Motoboy não está vinculado a esta central' });
      }
      const nome_profissional = vinc.rows[0].nome_profissional;
      const central_nome = vinc.rows[0].central_nome;

      // 2. Confere se já está na fila / em rota
      const ja = await pool.query(
        'SELECT * FROM filas_posicoes WHERE cod_profissional = $1 AND central_id = $2',
        [cod_profissional, central_id]
      );
      if (ja.rows.length > 0) {
        const reg = ja.rows[0];
        if (reg.status === 'aguardando') {
          return res.status(400).json({ error: 'Motoboy já está aguardando na fila', posicao: reg.posicao });
        }
        if (reg.status === 'em_rota') {
          return res.status(400).json({ error: 'Motoboy ainda está em rota — finalize antes de recolocar' });
        }
      }

      // 3. Calcula última posição + 1
      const ultPos = await pool.query(
        'SELECT COALESCE(MAX(posicao), 0) AS max_pos FROM filas_posicoes WHERE central_id = $1 AND status = $2',
        [central_id, 'aguardando']
      );
      const novaPosicao = parseInt(ultPos.rows[0].max_pos) + 1;

      // 4. Insert ou update (caso exista linha residual)
      if (ja.rows.length > 0) {
        await pool.query(`
          UPDATE filas_posicoes
          SET status = 'aguardando',
              posicao = $1,
              entrada_fila_at = NOW(),
              latitude_checkin = NULL,
              longitude_checkin = NULL,
              corrida_unica = FALSE,
              posicao_original = NULL,
              notas_liberadas = 0,
              primeira_nota_at = NULL,
              bairros = '[]'::jsonb,
              motivo_posicao = 'colocado_admin',
              updated_at = NOW()
          WHERE cod_profissional = $2 AND central_id = $3
        `, [novaPosicao, cod_profissional, central_id]);
      } else {
        await pool.query(`
          INSERT INTO filas_posicoes
            (central_id, cod_profissional, nome_profissional, status, posicao, motivo_posicao)
          VALUES ($1, $2, $3, 'aguardando', $4, 'colocado_admin')
        `, [central_id, cod_profissional, nome_profissional, novaPosicao]);
      }

      // 5. Histórico
      await pool.query(`
        INSERT INTO filas_historico
          (central_id, central_nome, cod_profissional, nome_profissional, acao, observacao, admin_cod, admin_nome)
        VALUES ($1, $2, $3, $4, 'colocado_admin', $5, $6, $7)
      `, [central_id, central_nome, cod_profissional, nome_profissional,
        `Colocado na fila pelo admin (posição ${novaPosicao})`,
        req.user.codProfissional, req.user.nome]);

      // 🆕 2026-05-24: marca o motoboy como EM LOJA na disponibilidade (fire-and-forget)
      marcarMotoboyEmLoja(pool, cod_profissional, {
        origem: 'fila_classica_admin',
        alterado_por: `Admin: ${req.user?.nome || 'desconhecido'}`,
      }).catch(() => {});

      res.json({ success: true, posicao: novaPosicao, central: central_nome, nome: nome_profissional });

      registrarAuditoria(req, 'COLOCAR_NA_FILA', 'admin', 'filas_posicoes', null,
        { cod_profissional, central_id, posicao: novaPosicao }).catch(() => {});

    } catch (error) {
      console.error('❌ Erro ao colocar na fila:', error);
      res.status(500).json({ error: 'Erro ao colocar na fila' });
    }
  });

  // 🚀 2026-05: Listar vinculados disponíveis pra colocar na fila (não estão aguardando nem em rota)
  router.get('/vinculados-disponiveis/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const central_id = parseInt(req.params.central_id);
      if (!central_id) return res.status(400).json({ error: 'central_id inválido' });

      const r = await pool.query(`
        SELECT v.cod_profissional, v.nome_profissional
        FROM filas_vinculos v
        WHERE v.central_id = $1
          AND v.ativo = true
          AND NOT EXISTS (
            SELECT 1 FROM filas_posicoes fp
            WHERE fp.cod_profissional = v.cod_profissional
              AND fp.central_id = v.central_id
              AND fp.status IN ('aguardando', 'em_rota')
          )
        ORDER BY v.nome_profissional
      `, [central_id]);

      res.json({ success: true, vinculados: r.rows });
    } catch (error) {
      console.error('❌ Erro ao listar vinculados disponíveis:', error);
      res.status(500).json({ error: 'Erro ao listar vinculados' });
    }
  });

  return router;
}

module.exports = { createFilasAdminRoutes };
