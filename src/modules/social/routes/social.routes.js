const express = require('express');

function createSocialCoreRouter(pool) {
  const socialRouter = express.Router();

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

  return socialRouter;
}

module.exports = { createSocialCoreRouter };
