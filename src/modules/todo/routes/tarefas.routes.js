/**
 * Sub-Router: Grupos + Tarefas CRUD + Recorrências
 */
const express = require('express');

function createTarefasRoutes(pool) {
  const router = express.Router();

router.get('/todo/grupos', async (req, res) => {
  try {
    const { user_cod, role } = req.query;
    
    let query = `
      SELECT * FROM todo_grupos 
      WHERE ativo = TRUE
    `;
    
    if (role !== 'admin_master') {
      query += ` AND (
        tipo = 'compartilhado' 
        OR criado_por = '${user_cod}'
        OR visivel_para @> '"${user_cod}"'
      )`;
    }
    
    query += ' ORDER BY ordem, nome';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar grupos:', err);
    res.status(500).json({ error: 'Erro ao listar grupos' });
  }
});

// Criar grupo
router.post('/todo/grupos', async (req, res) => {
  try {
    const { nome, descricao, icone, cor, tipo, criado_por, criado_por_nome, visivel_para } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_grupos (nome, descricao, icone, cor, tipo, criado_por, criado_por_nome, visivel_para)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [nome, descricao, icone || '📋', cor || '#7c3aed', tipo || 'compartilhado', criado_por, criado_por_nome, JSON.stringify(visivel_para || [])]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar grupo:', err);
    res.status(500).json({ error: 'Erro ao criar grupo' });
  }
});

// Atualizar grupo
router.put('/todo/grupos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, icone, cor, visivel_para } = req.body;
    
    const result = await pool.query(`
      UPDATE todo_grupos 
      SET nome = COALESCE($1, nome),
          descricao = COALESCE($2, descricao),
          icone = COALESCE($3, icone),
          cor = COALESCE($4, cor),
          visivel_para = COALESCE($5, visivel_para),
          updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [nome, descricao, icone, cor, JSON.stringify(visivel_para), id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar grupo:', err);
    res.status(500).json({ error: 'Erro ao atualizar grupo' });
  }
});

// Excluir grupo (soft delete)
router.delete('/todo/grupos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE todo_grupos SET ativo = FALSE WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir grupo:', err);
    res.status(500).json({ error: 'Erro ao excluir grupo' });
  }
});

// ============================================
// ROTAS TO-DO - TAREFAS
// ============================================

// Listar tarefas (com filtros)
router.get('/todo/tarefas', async (req, res) => {
  try {
    const { user_cod, role, grupo_id, status, responsavel, coluna_kanban } = req.query;
    
    let query = `
      SELECT t.*, g.nome as grupo_nome, g.icone as grupo_icone, g.cor as grupo_cor,
             COALESCE(ca.qtd, 0)::int as qtd_anexos,
             COALESCE(cc.qtd, 0)::int as qtd_comentarios,
             COALESCE(cs.qtd, 0)::int as qtd_subtarefas,
             COALESCE(cs.qtd_concluidas, 0)::int as qtd_subtarefas_concluidas,
             COALESCE(cd.qtd, 0)::int as qtd_dependencias
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      LEFT JOIN (SELECT tarefa_id, COUNT(*) as qtd FROM todo_anexos GROUP BY tarefa_id) ca ON ca.tarefa_id = t.id
      LEFT JOIN (SELECT tarefa_id, COUNT(*) as qtd FROM todo_comentarios GROUP BY tarefa_id) cc ON cc.tarefa_id = t.id
      LEFT JOIN (SELECT tarefa_id, COUNT(*) as qtd, COUNT(*) FILTER (WHERE concluida = true) as qtd_concluidas FROM todo_subtarefas GROUP BY tarefa_id) cs ON cs.tarefa_id = t.id
      LEFT JOIN (SELECT tarefa_id, COUNT(*) as qtd FROM todo_dependencias GROUP BY tarefa_id) cd ON cd.tarefa_id = t.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    // Se um grupo específico for selecionado, mostra TODAS as tarefas desse grupo
    if (grupo_id) {
      query += ` AND t.grupo_id = $${paramIndex}`;
      params.push(grupo_id);
      paramIndex++;
      // Não aplica filtro de usuário quando visualizando um grupo específico
    } else {
      // Se não for admin_master e não tiver grupo específico, filtra por permissões
      if (role !== 'admin_master') {
        query += ` AND (
          t.tipo = 'compartilhado' 
          OR t.criado_por = '${user_cod}'
          OR t.responsaveis @> '[{"user_cod":"${user_cod}"}]'
          OR t.responsaveis::text LIKE '%${user_cod}%'
        )`;
      }
    }
    
    if (status && status !== 'todas') {
      query += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    if (coluna_kanban) {
      query += ` AND t.coluna_kanban = $${paramIndex}`;
      params.push(coluna_kanban);
      paramIndex++;
    }
    
    if (responsavel) {
      query += ` AND t.responsaveis @> $${paramIndex}::jsonb`;
      params.push(JSON.stringify([{ user_cod: responsavel }]));
      paramIndex++;
    }
    
    query += ' ORDER BY t.ordem ASC, CASE t.prioridade WHEN \'urgente\' THEN 1 WHEN \'alta\' THEN 2 WHEN \'media\' THEN 3 ELSE 4 END, t.data_prazo ASC NULLS LAST, t.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar tarefas:', err);
    res.status(500).json({ error: 'Erro ao listar tarefas' });
  }
});

// Buscar tarefa específica com detalhes
router.get('/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const tarefa = await pool.query(`
      SELECT t.*, g.nome as grupo_nome, g.icone as grupo_icone, g.cor as grupo_cor
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE t.id = $1
    `, [id]);
    
    const anexos = await pool.query('SELECT * FROM todo_anexos WHERE tarefa_id = $1 ORDER BY created_at DESC', [id]);
    const comentarios = await pool.query('SELECT * FROM todo_comentarios WHERE tarefa_id = $1 ORDER BY created_at DESC', [id]);
    const historico = await pool.query('SELECT * FROM todo_historico WHERE tarefa_id = $1 ORDER BY created_at DESC LIMIT 20', [id]);
    
    res.json({
      ...tarefa.rows[0],
      anexos: anexos.rows,
      comentarios: comentarios.rows,
      historico: historico.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar tarefa:', err);
    res.status(500).json({ error: 'Erro ao buscar tarefa' });
  }
});

// Função para calcular próxima data de recorrência
function calcularProximaRecorrencia(dataBase, tipoRecorrencia, intervalo = 1) {
  const data = new Date(dataBase);
  data.setHours(0, 0, 0, 0);
  
  switch (tipoRecorrencia) {
    case 'diaria':
    case 'diario':
      data.setDate(data.getDate() + intervalo);
      break;
    case 'semanal':
      data.setDate(data.getDate() + (7 * intervalo));
      break;
    case 'mensal':
      data.setMonth(data.getMonth() + intervalo);
      break;
    case 'personalizado':
      data.setDate(data.getDate() + intervalo);
      break;
    default:
      data.setDate(data.getDate() + 1);
  }
  
  return data;
}

// Endpoint para processar tarefas recorrentes (chamado por cron ou manualmente)
router.post('/todo/processar-recorrencias', async (req, res) => {
  try {
    const agora = new Date();
    
    // Buscar tarefas recorrentes concluídas que precisam ser reabertas
    const tarefasRecorrentes = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrente = true 
      AND status = 'concluida'
      AND proxima_recorrencia IS NOT NULL 
      AND proxima_recorrencia <= $1
    `, [agora]);
    
    let reabertas = 0;
    
    for (const tarefa of tarefasRecorrentes.rows) {
      // Calcular próxima recorrência
      const proximaData = calcularProximaRecorrencia(
        new Date(), 
        tarefa.tipo_recorrencia, 
        tarefa.intervalo_recorrencia || 1
      );
      
      // Reabrir a tarefa
      await pool.query(`
        UPDATE todo_tarefas 
        SET status = 'pendente',
            data_conclusao = NULL,
            concluido_por = NULL,
            concluido_por_nome = NULL,
            proxima_recorrencia = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [proximaData, tarefa.id]);
      
      // Registrar no histórico
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')
      `, [tarefa.id]);
      
      reabertas++;
    }
    
    console.log(`✅ Processamento de recorrências: ${reabertas} tarefa(s) reaberta(s)`);
    res.json({ success: true, reabertas });
  } catch (err) {
    console.error('❌ Erro ao processar recorrências:', err);
    res.status(500).json({ error: 'Erro ao processar recorrências' });
  }
});

// Criar tarefa
router.post('/todo/tarefas', async (req, res) => {
  try {
    const { 
      grupo_id, titulo, descricao, prioridade, data_prazo, 
      recorrente, tipo_recorrencia, intervalo_recorrencia, tipo, 
      criado_por, criado_por_nome, criado_por_foto, responsaveis 
    } = req.body;
    
    // Calcular próxima recorrência se for recorrente
    let proxima_recorrencia = null;
    if (recorrente && tipo_recorrencia) {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      proxima_recorrencia = calcularProximaRecorrencia(hoje, tipo_recorrencia, intervalo_recorrencia || 1);
    }
    
    const result = await pool.query(`
      INSERT INTO todo_tarefas (
        grupo_id, titulo, descricao, prioridade, data_prazo,
        recorrente, tipo_recorrencia, intervalo_recorrencia, proxima_recorrencia, tipo,
        criado_por, criado_por_nome, criado_por_foto, responsaveis
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      grupo_id, titulo, descricao, prioridade || 'media', data_prazo,
      recorrente || false, tipo_recorrencia, intervalo_recorrencia || 1, proxima_recorrencia, tipo || 'compartilhado',
      criado_por, criado_por_nome, criado_por_foto || null, JSON.stringify(responsaveis || [])
    ]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'criada', 'Tarefa criada', $2, $3)
    `, [result.rows[0].id, criado_por, criado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar tarefa:', err);
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// Atualizar tarefa
router.put('/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      titulo, descricao, status, prioridade, data_prazo,
      recorrente, tipo_recorrencia, intervalo_recorrencia, responsaveis,
      user_cod, user_name
    } = req.body;
    
    const anterior = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    const tarefaAnterior = anterior.rows[0];
    
    let concluido_por = null;
    let concluido_por_nome = null;
    let data_conclusao = null;
    let proxima_recorrencia = tarefaAnterior?.proxima_recorrencia;
    
    // Se está sendo concluída
    if (status === 'concluida' && tarefaAnterior?.status !== 'concluida') {
      concluido_por = user_cod;
      concluido_por_nome = user_name;
      data_conclusao = new Date();
      
      // Se é recorrente, calcular próxima data
      if (tarefaAnterior?.recorrente) {
        proxima_recorrencia = calcularProximaRecorrencia(
          new Date(), 
          tarefaAnterior.tipo_recorrencia, 
          tarefaAnterior.intervalo_recorrencia || 1
        );
      }
    }
    
    const result = await pool.query(`
      UPDATE todo_tarefas 
      SET titulo = COALESCE($1, titulo),
          descricao = COALESCE($2, descricao),
          status = COALESCE($3, status),
          prioridade = COALESCE($4, prioridade),
          data_prazo = COALESCE($5, data_prazo),
          recorrente = COALESCE($6, recorrente),
          tipo_recorrencia = COALESCE($7, tipo_recorrencia),
          intervalo_recorrencia = COALESCE($8, intervalo_recorrencia),
          responsaveis = COALESCE($9, responsaveis),
          concluido_por = COALESCE($10, concluido_por),
          concluido_por_nome = COALESCE($11, concluido_por_nome),
          data_conclusao = COALESCE($12, data_conclusao),
          proxima_recorrencia = $13,
          updated_at = NOW()
      WHERE id = $14
      RETURNING *
    `, [
      titulo, descricao, status, prioridade, data_prazo,
      recorrente, tipo_recorrencia, intervalo_recorrencia,
      responsaveis ? JSON.stringify(responsaveis) : null,
      concluido_por, concluido_por_nome, data_conclusao, proxima_recorrencia, id
    ]);
    
    let acaoDesc = 'Tarefa atualizada';
    if (status && status !== anterior.rows[0]?.status) {
      acaoDesc = `Status alterado: ${anterior.rows[0]?.status || 'pendente'} → ${status}`;
    }
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name, dados_anteriores, dados_novos)
      VALUES ($1, 'atualizada', $2, $3, $4, $5, $6)
    `, [id, acaoDesc, user_cod, user_name, JSON.stringify(anterior.rows[0]), JSON.stringify(result.rows[0])]);
    
    // Se tarefa recorrente foi concluída, criar próxima
    if (status === 'concluida' && result.rows[0].recorrente && result.rows[0].tipo_recorrencia) {
      const tarefa = result.rows[0];
      let proximoPrazo = new Date();
      proximoPrazo.setHours(0, 0, 0, 0); // Começa à meia-noite
      
      const intervalo = tarefa.intervalo_recorrencia || 1;
      
      switch (tarefa.tipo_recorrencia) {
        case 'diario':
          proximoPrazo.setDate(proximoPrazo.getDate() + 1); // Próximo dia às 00:00
          break;
        case 'semanal':
          proximoPrazo.setDate(proximoPrazo.getDate() + (7 * intervalo));
          break;
        case 'mensal':
          proximoPrazo.setMonth(proximoPrazo.getMonth() + intervalo);
          break;
        case 'personalizado':
          proximoPrazo.setDate(proximoPrazo.getDate() + intervalo);
          break;
      }
      
      await pool.query(`
        INSERT INTO todo_tarefas (
          grupo_id, titulo, descricao, prioridade, data_prazo,
          recorrente, tipo_recorrencia, intervalo_recorrencia, tipo,
          criado_por, criado_por_nome, criado_por_foto, responsaveis
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        tarefa.grupo_id, tarefa.titulo, tarefa.descricao, tarefa.prioridade, proximoPrazo,
        true, tarefa.tipo_recorrencia, intervalo, tarefa.tipo,
        tarefa.criado_por, tarefa.criado_por_nome, tarefa.criado_por_foto, tarefa.responsaveis
      ]);
      console.log('✅ Tarefa recorrente criada para:', proximoPrazo);
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar tarefa:', err);
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

// Excluir tarefa
router.delete('/todo/tarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_tarefas WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir tarefa:', err);
    res.status(500).json({ error: 'Erro ao excluir tarefa' });
  }
});

// ============================================
// ROTAS TO-DO - COMENTÁRIOS
// ============================================

router.post('/todo/tarefas/:id/comentarios', async (req, res) => {
  try {
    const { id } = req.params;
    const { texto, user_cod, user_name } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_comentarios (tarefa_id, texto, user_cod, user_name)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, texto, user_cod, user_name]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'comentario', 'Comentário adicionado', $2, $3)
    `, [id, user_cod, user_name]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar comentário:', err);
    res.status(500).json({ error: 'Erro ao adicionar comentário' });
  }
});

// ============================================
// ROTAS TO-DO - ANEXOS
// ============================================

router.post('/todo/tarefas/:id/anexos', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_anexos (tarefa_id, nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [id, nome_arquivo, tipo_arquivo, tamanho, url, enviado_por, enviado_por_nome]);
    
    await pool.query(`
      INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
      VALUES ($1, 'anexo', $2, $3, $4)
    `, [id, `Anexo adicionado: ${nome_arquivo}`, enviado_por, enviado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar anexo:', err);
    res.status(500).json({ error: 'Erro ao adicionar anexo' });
  }
});

router.delete('/todo/anexos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_anexos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir anexo:', err);
    res.status(500).json({ error: 'Erro ao excluir anexo' });
  }
});

// ============================================
// ROTAS TO-DO - MÉTRICAS (Admin Master)
// ============================================


  return router;
}

module.exports = { createTarefasRoutes };
