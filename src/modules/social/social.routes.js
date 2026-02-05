// ============================================================
// MÓDULO SOCIAL - ROUTES (20 Endpoints)
// Extraído de server.js (linhas 15320-15760)
//
// Sub-módulos:
//   /api/social/*     - Perfis, status, mensagens (8 endpoints)
//   /api/lideranca/*  - Mensagens da liderança (12 endpoints)
//
// Segurança: Endpoints abertos no original (sem verificarToken)
// NOTA: Considerar adicionar verificarToken futuramente
// ============================================================

const express = require('express');

/**
 * Inicializa rotas do módulo Social (inclui Liderança)
 * @param {object} pool - Pool de conexão PostgreSQL
 * @returns {object} { socialRouter, liderancaRouter }
 */
function initSocialRoutes(pool) {

  // ==========================================
  // SOCIAL ROUTER (/api/social)
  // ==========================================
  const socialRouter = express.Router();

  // GET /profile/:userCod - Obter perfil social do usuário
  socialRouter.get('/profile/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const result = await pool.query(
        'SELECT * FROM social_profiles WHERE user_cod = $1',
        [userCod]
      );
      if (result.rows.length > 0) {
        res.json(result.rows[0]);
      } else {
        res.json(null);
      }
    } catch (err) {
      console.error('Erro ao buscar perfil social:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /profile/:userCod - Criar ou atualizar perfil social
  socialRouter.put('/profile/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const { display_name, profile_photo } = req.body;

      const result = await pool.query(`
        INSERT INTO social_profiles (user_cod, display_name, profile_photo, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (user_cod) 
        DO UPDATE SET 
          display_name = COALESCE($2, social_profiles.display_name),
          profile_photo = COALESCE($3, social_profiles.profile_photo),
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `, [userCod, display_name, profile_photo]);

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Erro ao salvar perfil social:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /status - Atualizar status online
  socialRouter.post('/status', async (req, res) => {
    try {
      const { user_cod, is_online } = req.body;

      await pool.query(`
        INSERT INTO social_status (user_cod, is_online, last_seen)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_cod) 
        DO UPDATE SET 
          is_online = $2,
          last_seen = CURRENT_TIMESTAMP
      `, [user_cod, is_online]);

      res.json({ success: true });
    } catch (err) {
      console.error('Erro ao atualizar status:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /users - Listar todos os usuários com status e perfil social
  socialRouter.get('/users', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          u.cod_profissional,
          u.full_name,
          u.role,
          COALESCE(sp.display_name, u.full_name) as display_name,
          sp.profile_photo,
          COALESCE(ss.is_online, false) as is_online,
          ss.last_seen
        FROM users u
        LEFT JOIN social_profiles sp ON u.cod_profissional = sp.user_cod
        LEFT JOIN social_status ss ON u.cod_profissional = ss.user_cod
        WHERE u.role IN ('user', 'admin', 'admin_financeiro', 'admin_master')
        ORDER BY ss.is_online DESC NULLS LAST, COALESCE(sp.display_name, u.full_name) ASC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('Erro ao listar usuários:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /messages - Enviar mensagem ou reação
  socialRouter.post('/messages', async (req, res) => {
    try {
      const { from_user_cod, from_user_name, to_user_cod, message_type, content } = req.body;

      const result = await pool.query(`
        INSERT INTO social_messages (from_user_cod, from_user_name, to_user_cod, message_type, content)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [from_user_cod, from_user_name, to_user_cod, message_type, content]);

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Erro ao enviar mensagem:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /messages/:userCod - Buscar mensagens recebidas por um usuário
  socialRouter.get('/messages/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const result = await pool.query(`
        SELECT * FROM social_messages 
        WHERE to_user_cod = $1 
        ORDER BY created_at DESC 
        LIMIT 50
      `, [userCod]);
      res.json(result.rows);
    } catch (err) {
      console.error('Erro ao buscar mensagens:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /messages/read - Marcar mensagens como lidas
  socialRouter.patch('/messages/read', async (req, res) => {
    try {
      const { user_cod } = req.body;
      await pool.query(
        'UPDATE social_messages SET is_read = true WHERE to_user_cod = $1 AND is_read = false',
        [user_cod]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('Erro ao marcar como lido:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /messages/unread/:userCod - Contar mensagens não lidas
  socialRouter.get('/messages/unread/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM social_messages WHERE to_user_cod = $1 AND is_read = false',
        [userCod]
      );
      res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) {
      console.error('Erro ao contar não lidas:', err);
      res.json({ count: 0 });
    }
  });

  // ==========================================
  // LIDERANÇA ROUTER (/api/lideranca)
  // ==========================================
  const liderancaRouter = express.Router();

  // POST /mensagens - Criar nova mensagem da liderança
  liderancaRouter.post('/mensagens', async (req, res) => {
    try {
      const {
        titulo, conteudo, tipo_conteudo, midia_url, midia_tipo,
        criado_por_cod, criado_por_nome, criado_por_foto,
        recorrente, tipo_recorrencia, intervalo_recorrencia
      } = req.body;

      // Calcular próxima exibição se for recorrente
      let proxima_exibicao = null;
      if (recorrente && tipo_recorrencia) {
        const agora = new Date();
        switch (tipo_recorrencia) {
          case 'diaria':
            proxima_exibicao = new Date(agora.getTime() + (intervalo_recorrencia || 1) * 24 * 60 * 60 * 1000);
            break;
          case 'semanal':
            proxima_exibicao = new Date(agora.getTime() + (intervalo_recorrencia || 1) * 7 * 24 * 60 * 60 * 1000);
            break;
          case 'mensal':
            proxima_exibicao = new Date(agora);
            proxima_exibicao.setMonth(proxima_exibicao.getMonth() + (intervalo_recorrencia || 1));
            break;
        }
      }

      const result = await pool.query(`
        INSERT INTO lideranca_mensagens (
          titulo, conteudo, tipo_conteudo, midia_url, midia_tipo,
          criado_por_cod, criado_por_nome, criado_por_foto,
          recorrente, tipo_recorrencia, intervalo_recorrencia, proxima_exibicao
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        titulo, conteudo, tipo_conteudo || 'texto', midia_url, midia_tipo,
        criado_por_cod, criado_por_nome, criado_por_foto,
        recorrente || false, tipo_recorrencia, intervalo_recorrencia || 1, proxima_exibicao
      ]);

      console.log('📢 Nova mensagem da liderança criada:', result.rows[0].id);
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar mensagem da liderança:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /mensagens - Listar todas (para admin_master gerenciar)
  liderancaRouter.get('/mensagens', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT m.*, 
          (SELECT COUNT(*) FROM lideranca_visualizacoes WHERE mensagem_id = m.id) as total_visualizacoes
        FROM lideranca_mensagens m
        ORDER BY m.created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar mensagens:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /mensagens/pendentes/:userCod - Mensagens não visualizadas
  liderancaRouter.get('/mensagens/pendentes/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const result = await pool.query(`
        SELECT m.* FROM lideranca_mensagens m
        WHERE m.ativo = true
          AND m.id NOT IN (
            SELECT mensagem_id FROM lideranca_visualizacoes WHERE user_cod = $1
          )
        ORDER BY m.created_at DESC
      `, [userCod]);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao buscar mensagens pendentes:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /mensagens/:id/visualizar - Marcar como visualizada
  liderancaRouter.post('/mensagens/:id/visualizar', async (req, res) => {
    try {
      const { id } = req.params;
      const { user_cod, user_nome, user_foto } = req.body;

      await pool.query(`
        INSERT INTO lideranca_visualizacoes (mensagem_id, user_cod, user_nome, user_foto)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (mensagem_id, user_cod) DO UPDATE SET visualizado_em = CURRENT_TIMESTAMP
      `, [id, user_cod, user_nome, user_foto]);

      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao marcar como visualizado:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /mensagens/:id/visualizacoes - Quem visualizou
  liderancaRouter.get('/mensagens/:id/visualizacoes', async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`
        SELECT * FROM lideranca_visualizacoes
        WHERE mensagem_id = $1
        ORDER BY visualizado_em DESC
      `, [id]);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar visualizações:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /mensagens/historico/:userCod - Histórico do usuário
  liderancaRouter.get('/mensagens/historico/:userCod', async (req, res) => {
    try {
      const { userCod } = req.params;
      const result = await pool.query(`
        SELECT m.*, v.visualizado_em
        FROM lideranca_mensagens m
        INNER JOIN lideranca_visualizacoes v ON m.id = v.mensagem_id
        WHERE v.user_cod = $1
        ORDER BY v.visualizado_em DESC
      `, [userCod]);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao buscar histórico:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /mensagens/:id - Atualizar mensagem
  liderancaRouter.put('/mensagens/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { titulo, conteudo, tipo_conteudo, midia_url, midia_tipo, recorrente, tipo_recorrencia, intervalo_recorrencia, ativo } = req.body;

      const result = await pool.query(`
        UPDATE lideranca_mensagens SET
          titulo = COALESCE($1, titulo),
          conteudo = COALESCE($2, conteudo),
          tipo_conteudo = COALESCE($3, tipo_conteudo),
          midia_url = COALESCE($4, midia_url),
          midia_tipo = COALESCE($5, midia_tipo),
          recorrente = COALESCE($6, recorrente),
          tipo_recorrencia = COALESCE($7, tipo_recorrencia),
          intervalo_recorrencia = COALESCE($8, intervalo_recorrencia),
          ativo = COALESCE($9, ativo),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $10
        RETURNING *
      `, [titulo, conteudo, tipo_conteudo, midia_url, midia_tipo, recorrente, tipo_recorrencia, intervalo_recorrencia, ativo, id]);

      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar mensagem:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /mensagens/:id - Deletar mensagem
  liderancaRouter.delete('/mensagens/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM lideranca_mensagens WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao deletar mensagem:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /processar-recorrencias - Processar recorrências
  liderancaRouter.post('/processar-recorrencias', async (req, res) => {
    try {
      const agora = new Date();

      // Buscar mensagens recorrentes que precisam ser reexibidas
      const mensagens = await pool.query(`
        SELECT * FROM lideranca_mensagens
        WHERE recorrente = true AND ativo = true AND proxima_exibicao <= $1
      `, [agora]);

      for (const msg of mensagens.rows) {
        // Limpar visualizações antigas para reexibir
        await pool.query('DELETE FROM lideranca_visualizacoes WHERE mensagem_id = $1', [msg.id]);

        // Calcular próxima exibição
        let proxima = new Date(agora);
        switch (msg.tipo_recorrencia) {
          case 'diaria':
            proxima.setDate(proxima.getDate() + (msg.intervalo_recorrencia || 1));
            break;
          case 'semanal':
            proxima.setDate(proxima.getDate() + (msg.intervalo_recorrencia || 1) * 7);
            break;
          case 'mensal':
            proxima.setMonth(proxima.getMonth() + (msg.intervalo_recorrencia || 1));
            break;
        }

        await pool.query('UPDATE lideranca_mensagens SET proxima_exibicao = $1 WHERE id = $2', [proxima, msg.id]);
      }

      res.json({ processadas: mensagens.rows.length });
    } catch (err) {
      console.error('❌ Erro ao processar recorrências:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /mensagens/:id/reagir - Enviar reação
  liderancaRouter.post('/mensagens/:id/reagir', async (req, res) => {
    try {
      const { id } = req.params;
      const { user_cod, user_nome, user_foto, emoji } = req.body;

      await pool.query(`
        INSERT INTO lideranca_reacoes (mensagem_id, user_cod, user_nome, user_foto, emoji)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (mensagem_id, user_cod, emoji) DO NOTHING
      `, [id, user_cod, user_nome, user_foto, emoji]);

      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao enviar reação:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /mensagens/:id/reacoes - Listar reações
  liderancaRouter.get('/mensagens/:id/reacoes', async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`
        SELECT * FROM lideranca_reacoes
        WHERE mensagem_id = $1
        ORDER BY created_at DESC
      `, [id]);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar reações:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /mensagens/:id/reagir - Remover reação (toggle)
  liderancaRouter.delete('/mensagens/:id/reagir', async (req, res) => {
    try {
      const { id } = req.params;
      const { user_cod, emoji } = req.body;

      await pool.query(`
        DELETE FROM lideranca_reacoes 
        WHERE mensagem_id = $1 AND user_cod = $2 AND emoji = $3
      `, [id, user_cod, emoji]);

      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao remover reação:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return { socialRouter, liderancaRouter };
}

module.exports = initSocialRoutes;
