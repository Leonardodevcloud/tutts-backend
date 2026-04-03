const express = require('express');

function createLiderancaRouter(pool) {
  const liderancaRouter = express.Router();

  // 🔧 Helper: Calcula próxima exibição baseado no tipo e intervalo de recorrência
  // Centralizado para evitar inconsistências entre POST, PUT e processamento
  const calcularProximaExibicao = (baseDate, tipo_recorrencia, intervalo_recorrencia) => {
    const proxima = new Date(baseDate);
    const intervalo = intervalo_recorrencia || 1;
    
    switch (tipo_recorrencia) {
      case 'diaria':
      case 'diario': // 🔧 FIX: alias para compatibilidade com dados antigos
        proxima.setDate(proxima.getDate() + intervalo);
        break;
      case 'semanal':
        proxima.setDate(proxima.getDate() + intervalo * 7);
        break;
      case 'mensal':
        proxima.setMonth(proxima.getMonth() + intervalo);
        break;
      default:
        // 🔧 FIX: Safety — tipo desconhecido trata como diária para não travar em loop
        console.warn(`⚠️ tipo_recorrencia desconhecido: "${tipo_recorrencia}", usando diária como fallback`);
        proxima.setDate(proxima.getDate() + intervalo);
        break;
    }
    
    return proxima;
  };

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
        proxima_exibicao = calcularProximaExibicao(new Date(), tipo_recorrencia, intervalo_recorrencia);
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

      console.log('📢 Nova mensagem da liderança criada:', result.rows[0].id, 
        recorrente ? `(recorrente: ${tipo_recorrencia}, intervalo: ${intervalo_recorrencia}, próxima: ${proxima_exibicao?.toISOString()})` : '(única)');
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
      
      // Processar recorrências pendentes antes de buscar
      // NÃO deleta visualizações — apenas atualiza ultima_recorrencia e proxima_exibicao
      const agora = new Date();
      const recorrentes = await pool.query(`
        SELECT * FROM lideranca_mensagens
        WHERE recorrente = true AND ativo = true AND proxima_exibicao IS NOT NULL AND proxima_exibicao <= $1
      `, [agora]);
      
      for (const msg of recorrentes.rows) {
        // 🔧 FIX: Usar helper centralizado (suporta diario/diaria + default)
        const proxima = calcularProximaExibicao(agora, msg.tipo_recorrencia, msg.intervalo_recorrencia);
        
        // Atualizar proxima_exibicao e marcar ultima_recorrencia
        await pool.query(
          'UPDATE lideranca_mensagens SET proxima_exibicao = $1, ultima_recorrencia = $2 WHERE id = $3', 
          [proxima, agora, msg.id]
        );
        console.log(`🔄 Recorrência processada: "${msg.titulo}" (tipo=${msg.tipo_recorrencia}, intervalo=${msg.intervalo_recorrencia}) - próxima: ${proxima.toISOString()}`);
      }
      
      // Buscar pendentes: mensagens que o usuário NÃO visualizou neste ciclo
      // - Não-recorrentes: nunca visualizadas pelo usuário
      // - Recorrentes: não visualizadas DESDE a última recorrência (ou desde a criação se nunca recorreu)
      const result = await pool.query(`
        SELECT m.* FROM lideranca_mensagens m
        LEFT JOIN lideranca_visualizacoes v ON m.id = v.mensagem_id AND v.user_cod = $1
        WHERE m.ativo = true
          AND (
            -- Não-recorrente: nunca visualizada
            (m.recorrente = false AND v.id IS NULL)
            OR
            -- Recorrente: nunca visualizada OU visualizada antes da última recorrência
            (m.recorrente = true AND (v.id IS NULL OR v.visualizado_em < COALESCE(m.ultima_recorrencia, m.created_at)))
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

      // 🔧 FIX: Recalcular proxima_exibicao quando configuração de recorrência muda
      let proxima_exibicao = undefined; // undefined = não alterar
      
      if (recorrente !== undefined) {
        if (recorrente && tipo_recorrencia) {
          // Recorrência habilitada/alterada — recalcular a partir de agora
          proxima_exibicao = calcularProximaExibicao(new Date(), tipo_recorrencia, intervalo_recorrencia);
          console.log(`🔄 Recorrência atualizada para msg ${id}: tipo=${tipo_recorrencia}, intervalo=${intervalo_recorrencia}, próxima=${proxima_exibicao.toISOString()}`);
        } else if (recorrente === false) {
          // Recorrência desabilitada — limpar
          proxima_exibicao = null;
        }
      }

      // Construir query dinâmica para incluir proxima_exibicao apenas se necessário
      if (proxima_exibicao !== undefined) {
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
            proxima_exibicao = $10,
            ultima_recorrencia = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $11
          RETURNING *
        `, [titulo, conteudo, tipo_conteudo, midia_url, midia_tipo, recorrente, tipo_recorrencia, intervalo_recorrencia, ativo, proxima_exibicao, id]);
        
        res.json(result.rows[0]);
      } else {
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
      }
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

  // POST /processar-recorrencias - Processar recorrências (cron ou manual)
  liderancaRouter.post('/processar-recorrencias', async (req, res) => {
    try {
      const agora = new Date();

      // Buscar mensagens recorrentes que precisam ser reexibidas
      const mensagens = await pool.query(`
        SELECT * FROM lideranca_mensagens
        WHERE recorrente = true AND ativo = true AND proxima_exibicao <= $1
      `, [agora]);

      for (const msg of mensagens.rows) {
        // 🔧 FIX: Usar helper centralizado
        const proxima = calcularProximaExibicao(agora, msg.tipo_recorrencia, msg.intervalo_recorrencia);

        // Atualizar proxima_exibicao e marcar ultima_recorrencia (NÃO deleta visualizações)
        await pool.query(
          'UPDATE lideranca_mensagens SET proxima_exibicao = $1, ultima_recorrencia = $2 WHERE id = $3', 
          [proxima, agora, msg.id]
        );
        console.log(`🔄 Recorrência processada: "${msg.titulo}" -> próxima: ${proxima.toISOString()}`);
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

  return liderancaRouter;
}

module.exports = { createLiderancaRouter };
