/**
 * MÓDULO TODO - Routes
 * 34 endpoints: grupos, tarefas, comentários, anexos, métricas,
 *               subtarefas, time-tracking, kanban, dependências, templates
 */

const express = require('express');

function createTodoRouter(pool) {
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
             (SELECT COUNT(*) FROM todo_anexos WHERE tarefa_id = t.id) as qtd_anexos,
             (SELECT COUNT(*) FROM todo_comentarios WHERE tarefa_id = t.id) as qtd_comentarios,
             (SELECT COUNT(*) FROM todo_subtarefas WHERE tarefa_id = t.id) as qtd_subtarefas,
             (SELECT COUNT(*) FROM todo_subtarefas WHERE tarefa_id = t.id AND concluida = true) as qtd_subtarefas_concluidas,
             (SELECT COUNT(*) FROM todo_dependencias WHERE tarefa_id = t.id) as qtd_dependencias
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
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

router.get('/todo/metricas', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    const dias = parseInt(periodo);
    
    const statusResult = await pool.query(`
      SELECT status, COUNT(*) as total
      FROM todo_tarefas
      WHERE created_at >= NOW() - INTERVAL '${dias} days'
      GROUP BY status
    `);
    
    const conclusaoResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'concluida' AND (data_conclusao <= data_prazo OR data_prazo IS NULL)) as no_prazo,
        COUNT(*) FILTER (WHERE status = 'concluida' AND data_conclusao > data_prazo) as fora_prazo,
        COUNT(*) FILTER (WHERE status = 'concluida') as total_concluidas,
        COUNT(*) FILTER (WHERE status != 'concluida' AND data_prazo < NOW()) as atrasadas,
        COUNT(*) as total
      FROM todo_tarefas
      WHERE created_at >= NOW() - INTERVAL '${dias} days'
    `);
    
    const porResponsavelResult = await pool.query(`
      SELECT 
        concluido_por as user_cod,
        concluido_por_nome as user_name,
        COUNT(*) as total_concluidas,
        COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL) as no_prazo,
        COUNT(*) FILTER (WHERE data_conclusao > data_prazo) as fora_prazo,
        AVG(EXTRACT(EPOCH FROM (data_conclusao - created_at)) / 3600) as tempo_medio_horas
      FROM todo_tarefas
      WHERE status = 'concluida' 
        AND concluido_por IS NOT NULL
        AND data_conclusao >= NOW() - INTERVAL '${dias} days'
      GROUP BY concluido_por, concluido_por_nome
      ORDER BY total_concluidas DESC
    `);
    
    const porGrupoResult = await pool.query(`
      SELECT 
        g.id,
        g.nome,
        g.icone,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE t.status = 'concluida') as concluidas,
        COUNT(*) FILTER (WHERE t.status = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE t.status = 'em_andamento') as em_andamento
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      WHERE t.created_at >= NOW() - INTERVAL '${dias} days'
      GROUP BY g.id, g.nome, g.icone
      ORDER BY total DESC
    `);
    
    const conclusao = conclusaoResult.rows[0];
    const taxaNoPrazo = conclusao.total_concluidas > 0 
      ? ((conclusao.no_prazo / conclusao.total_concluidas) * 100).toFixed(1) 
      : 0;
    
    res.json({
      totais: {
        total: parseInt(conclusao.total),
        concluidas: parseInt(conclusao.total_concluidas),
        atrasadas: parseInt(conclusao.atrasadas),
        no_prazo: parseInt(conclusao.no_prazo),
        vencidas: parseInt(conclusao.atrasadas),
        taxaNoPrazo: parseFloat(taxaNoPrazo)
      },
      porStatus: statusResult.rows,
      porResponsavel: porResponsavelResult.rows,
      porGrupo: porGrupoResult.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar métricas:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

router.get('/todo/metricas/ranking', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    const result = await pool.query(`
      SELECT 
        concluido_por as user_cod,
        concluido_por_nome as user_name,
        COUNT(*) as total_concluidas,
        COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL) as no_prazo,
        ROUND(
          (COUNT(*) FILTER (WHERE data_conclusao <= data_prazo OR data_prazo IS NULL)::DECIMAL / 
           NULLIF(COUNT(*), 0) * 100), 1
        ) as taxa_prazo,
        ROUND(AVG(EXTRACT(EPOCH FROM (data_conclusao - created_at)) / 3600)::DECIMAL, 1) as tempo_medio_horas
      FROM todo_tarefas
      WHERE status = 'concluida' 
        AND concluido_por IS NOT NULL
        AND data_conclusao >= NOW() - INTERVAL '${periodo} days'
      GROUP BY concluido_por, concluido_por_nome
      HAVING COUNT(*) >= 1
      ORDER BY taxa_prazo DESC, total_concluidas DESC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// Listar admins para o TO-DO
router.get('/todo/admins', async (req, res) => {
  try {
    // Retorna apenas ADMINS e ADMIN_MASTER com foto do perfil social
    const result = await pool.query(`
      SELECT 
        u.cod_profissional as cod, 
        u.full_name as nome,
        u.role,
        sp.profile_photo as foto
      FROM users u
      LEFT JOIN social_profiles sp ON u.cod_profissional = sp.user_cod
      WHERE u.role IN ('admin', 'admin_master')
      ORDER BY u.full_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar admins para TODO:', err);
    res.json([]);
  }
});

// ============================================
// ROTAS TO-DO - SUBTAREFAS/CHECKLIST
// ============================================

// Listar subtarefas de uma tarefa
router.get('/todo/tarefas/:id/subtarefas', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM todo_subtarefas WHERE tarefa_id = $1 ORDER BY ordem, id',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar subtarefas:', err);
    res.status(500).json({ error: 'Erro ao listar subtarefas' });
  }
});

// Criar subtarefa
router.post('/todo/tarefas/:id/subtarefas', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, ordem } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_subtarefas (tarefa_id, titulo, ordem)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [id, titulo, ordem || 0]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar subtarefa:', err);
    res.status(500).json({ error: 'Erro ao criar subtarefa' });
  }
});

// Atualizar subtarefa (toggle concluída)
router.put('/todo/subtarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, concluida, user_cod, user_name } = req.body;
    
    const result = await pool.query(`
      UPDATE todo_subtarefas 
      SET titulo = COALESCE($1, titulo),
          concluida = COALESCE($2, concluida),
          concluida_por = CASE WHEN $2 = true THEN $3 ELSE NULL END,
          concluida_por_nome = CASE WHEN $2 = true THEN $4 ELSE NULL END,
          concluida_em = CASE WHEN $2 = true THEN NOW() ELSE NULL END
      WHERE id = $5
      RETURNING *
    `, [titulo, concluida, user_cod, user_name, id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar subtarefa:', err);
    res.status(500).json({ error: 'Erro ao atualizar subtarefa' });
  }
});

// Excluir subtarefa
router.delete('/todo/subtarefas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_subtarefas WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir subtarefa:', err);
    res.status(500).json({ error: 'Erro ao excluir subtarefa' });
  }
});

// Reordenar subtarefas
router.put('/todo/tarefas/:id/subtarefas/reordenar', async (req, res) => {
  try {
    const { id } = req.params;
    const { subtarefas } = req.body; // Array de {id, ordem}
    
    for (const sub of subtarefas) {
      await pool.query('UPDATE todo_subtarefas SET ordem = $1 WHERE id = $2', [sub.ordem, sub.id]);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao reordenar subtarefas:', err);
    res.status(500).json({ error: 'Erro ao reordenar subtarefas' });
  }
});

// ============================================
// ROTAS TO-DO - TIME TRACKING
// ============================================

// Iniciar timer
router.post('/todo/tarefas/:id/timer/iniciar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name } = req.body;
    
    // Verificar se já tem timer ativo
    const tarefaAtual = await pool.query('SELECT timer_ativo FROM todo_tarefas WHERE id = $1', [id]);
    if (tarefaAtual.rows[0]?.timer_ativo) {
      return res.status(400).json({ error: 'Timer já está ativo para esta tarefa' });
    }
    
    // Parar qualquer outro timer do usuário
    const outrosTimers = await pool.query(
      'SELECT id, timer_inicio FROM todo_tarefas WHERE timer_ativo = true AND timer_user_cod = $1',
      [user_cod]
    );
    
    for (const tarefa of outrosTimers.rows) {
      const duracaoSegundos = Math.floor((Date.now() - new Date(tarefa.timer_inicio).getTime()) / 1000);
      await pool.query(`
        UPDATE todo_tarefas 
        SET timer_ativo = false, 
            timer_inicio = NULL, 
            timer_user_cod = NULL,
            tempo_gasto_segundos = COALESCE(tempo_gasto_segundos, 0) + $1
        WHERE id = $2
      `, [duracaoSegundos, tarefa.id]);
      
      // Registrar no histórico de time tracking
      await pool.query(`
        INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos)
        VALUES ($1, $2, $3, $4, NOW(), $5)
      `, [tarefa.id, user_cod, user_name, tarefa.timer_inicio, duracaoSegundos]);
    }
    
    // Iniciar novo timer
    await pool.query(`
      UPDATE todo_tarefas 
      SET timer_ativo = true, timer_inicio = NOW(), timer_user_cod = $1, status = 'em_andamento'
      WHERE id = $2
    `, [user_cod, id]);
    
    const result = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao iniciar timer:', err);
    res.status(500).json({ error: 'Erro ao iniciar timer' });
  }
});

// Parar timer
router.post('/todo/tarefas/:id/timer/parar', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name, descricao } = req.body;
    
    const tarefa = await pool.query('SELECT timer_inicio, tempo_gasto_segundos FROM todo_tarefas WHERE id = $1', [id]);
    if (!tarefa.rows[0]?.timer_inicio) {
      return res.status(400).json({ error: 'Nenhum timer ativo para esta tarefa' });
    }
    
    const duracaoSegundos = Math.floor((Date.now() - new Date(tarefa.rows[0].timer_inicio).getTime()) / 1000);
    const tempoTotal = (tarefa.rows[0].tempo_gasto_segundos || 0) + duracaoSegundos;
    
    // Registrar no histórico
    await pool.query(`
      INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos, descricao)
      VALUES ($1, $2, $3, $4, NOW(), $5, $6)
    `, [id, user_cod, user_name, tarefa.rows[0].timer_inicio, duracaoSegundos, descricao]);
    
    // Atualizar tarefa
    await pool.query(`
      UPDATE todo_tarefas 
      SET timer_ativo = false, 
          timer_inicio = NULL, 
          timer_user_cod = NULL,
          tempo_gasto_segundos = $1
      WHERE id = $2
    `, [tempoTotal, id]);
    
    const result = await pool.query('SELECT * FROM todo_tarefas WHERE id = $1', [id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao parar timer:', err);
    res.status(500).json({ error: 'Erro ao parar timer' });
  }
});

// Histórico de tempo de uma tarefa
router.get('/todo/tarefas/:id/time-tracking', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM todo_time_tracking WHERE tarefa_id = $1 ORDER BY inicio DESC',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico de tempo:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// Adicionar tempo manual
router.post('/todo/tarefas/:id/time-tracking', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_cod, user_name, duracao_minutos, descricao, data } = req.body;
    
    const duracaoSegundos = duracao_minutos * 60;
    const dataRegistro = data ? new Date(data) : new Date();
    
    // Inserir registro
    await pool.query(`
      INSERT INTO todo_time_tracking (tarefa_id, user_cod, user_name, inicio, fim, duracao_segundos, descricao)
      VALUES ($1, $2, $3, $4, $4, $5, $6)
    `, [id, user_cod, user_name, dataRegistro, duracaoSegundos, descricao]);
    
    // Atualizar tempo total da tarefa
    await pool.query(`
      UPDATE todo_tarefas 
      SET tempo_gasto_segundos = COALESCE(tempo_gasto_segundos, 0) + $1
      WHERE id = $2
    `, [duracaoSegundos, id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao adicionar tempo:', err);
    res.status(500).json({ error: 'Erro ao adicionar tempo' });
  }
});

// ============================================
// ROTAS TO-DO - KANBAN
// ============================================

// Atualizar coluna kanban de uma tarefa
router.put('/todo/tarefas/:id/kanban', async (req, res) => {
  try {
    const { id } = req.params;
    const { coluna_kanban, ordem, user_cod, user_name } = req.body;
    
    console.log('🔄 Movendo tarefa no kanban:', { id, coluna_kanban, user_cod });
    
    if (!coluna_kanban) {
      return res.status(400).json({ error: 'coluna_kanban é obrigatório' });
    }
    
    // Verificar se a tarefa existe
    const tarefaCheck = await pool.query('SELECT id FROM todo_tarefas WHERE id = $1', [id]);
    if (tarefaCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }
    
    // Mapear coluna para status
    let status = 'pendente';
    if (coluna_kanban === 'doing') status = 'em_andamento';
    else if (coluna_kanban === 'done') status = 'concluida';
    
    // Atualizar tarefa
    const updateQuery = status === 'concluida' 
      ? `UPDATE todo_tarefas 
         SET coluna_kanban = $1, 
             status = $2, 
             concluido_por = $3,
             concluido_por_nome = $4,
             data_conclusao = NOW(),
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`
      : `UPDATE todo_tarefas 
         SET coluna_kanban = $1, 
             status = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`;
    
    const params = status === 'concluida' 
      ? [coluna_kanban, status, user_cod, user_name, id]
      : [coluna_kanban, status, id];
    
    const result = await pool.query(updateQuery, params);
    
    // Registrar no histórico (ignorar erro se tabela não existir)
    try {
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'movida', $2, $3, $4)
      `, [id, `Movida para ${coluna_kanban}`, user_cod || 'sistema', user_name || 'Sistema']);
    } catch (histErr) {
      console.log('⚠️ Histórico não registrado:', histErr.message);
    }
    
    console.log('✅ Tarefa movida com sucesso:', result.rows[0]?.id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao mover tarefa no kanban:', err);
    res.status(500).json({ error: 'Erro ao mover tarefa', details: err.message });
  }
});

// Reordenar tarefas dentro de uma coluna
router.put('/todo/kanban/reordenar', async (req, res) => {
  try {
    const { tarefas } = req.body; // Array de {id, ordem, coluna_kanban}
    
    for (const tarefa of tarefas) {
      await pool.query(
        'UPDATE todo_tarefas SET ordem = $1, coluna_kanban = $2 WHERE id = $3',
        [tarefa.ordem, tarefa.coluna_kanban, tarefa.id]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao reordenar kanban:', err);
    res.status(500).json({ error: 'Erro ao reordenar' });
  }
});

// ============================================
// ROTAS TO-DO - DEPENDÊNCIAS
// ============================================

// Listar dependências de uma tarefa
router.get('/todo/tarefas/:id/dependencias', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Tarefas das quais esta depende
    const dependeDe = await pool.query(`
      SELECT d.*, t.titulo, t.status 
      FROM todo_dependencias d
      JOIN todo_tarefas t ON d.depende_de = t.id
      WHERE d.tarefa_id = $1
    `, [id]);
    
    // Tarefas que dependem desta
    const dependentes = await pool.query(`
      SELECT d.*, t.titulo, t.status 
      FROM todo_dependencias d
      JOIN todo_tarefas t ON d.tarefa_id = t.id
      WHERE d.depende_de = $1
    `, [id]);
    
    res.json({
      depende_de: dependeDe.rows,
      dependentes: dependentes.rows
    });
  } catch (err) {
    console.error('❌ Erro ao listar dependências:', err);
    res.status(500).json({ error: 'Erro ao listar dependências' });
  }
});

// Adicionar dependência
router.post('/todo/tarefas/:id/dependencias', async (req, res) => {
  try {
    const { id } = req.params;
    const { depende_de, tipo } = req.body;
    
    // Verificar se não cria dependência circular
    const circular = await pool.query(`
      WITH RECURSIVE dep_chain AS (
        SELECT tarefa_id, depende_de FROM todo_dependencias WHERE tarefa_id = $1
        UNION
        SELECT d.tarefa_id, d.depende_de 
        FROM todo_dependencias d
        JOIN dep_chain c ON d.tarefa_id = c.depende_de
      )
      SELECT * FROM dep_chain WHERE depende_de = $2
    `, [depende_de, id]);
    
    if (circular.rows.length > 0) {
      return res.status(400).json({ error: 'Dependência circular detectada!' });
    }
    
    const result = await pool.query(`
      INSERT INTO todo_dependencias (tarefa_id, depende_de, tipo)
      VALUES ($1, $2, $3)
      ON CONFLICT (tarefa_id, depende_de) DO NOTHING
      RETURNING *
    `, [id, depende_de, tipo || 'finish_to_start']);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao adicionar dependência:', err);
    res.status(500).json({ error: 'Erro ao adicionar dependência' });
  }
});

// Remover dependência
router.delete('/todo/dependencias/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM todo_dependencias WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover dependência:', err);
    res.status(500).json({ error: 'Erro ao remover dependência' });
  }
});

// ============================================
// ROTAS TO-DO - TEMPLATES
// ============================================

// Listar templates
router.get('/todo/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM todo_templates WHERE ativo = true ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar templates:', err);
    res.json([]);
  }
});

// Criar template
router.post('/todo/templates', async (req, res) => {
  try {
    const { grupo_id, nome, titulo_tarefa, descricao, prioridade, checklist, tempo_estimado_minutos, criado_por, criado_por_nome } = req.body;
    
    const result = await pool.query(`
      INSERT INTO todo_templates (grupo_id, nome, titulo_tarefa, descricao, prioridade, checklist, tempo_estimado_minutos, criado_por, criado_por_nome)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [grupo_id, nome, titulo_tarefa, descricao, prioridade, JSON.stringify(checklist || []), tempo_estimado_minutos, criado_por, criado_por_nome]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar template:', err);
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// Criar tarefa a partir de template
router.post('/todo/templates/:id/criar-tarefa', async (req, res) => {
  try {
    const { id } = req.params;
    const { grupo_id, data_prazo, responsaveis, criado_por, criado_por_nome } = req.body;
    
    const template = await pool.query('SELECT * FROM todo_templates WHERE id = $1', [id]);
    if (template.rows.length === 0) {
      return res.status(404).json({ error: 'Template não encontrado' });
    }
    
    const t = template.rows[0];
    
    // Criar tarefa
    const tarefa = await pool.query(`
      INSERT INTO todo_tarefas (
        grupo_id, titulo, descricao, prioridade, data_prazo,
        tempo_estimado_minutos, template_id, tipo,
        criado_por, criado_por_nome, responsaveis
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'compartilhado', $8, $9, $10)
      RETURNING *
    `, [
      grupo_id || t.grupo_id, t.titulo_tarefa, t.descricao, t.prioridade, data_prazo,
      t.tempo_estimado_minutos, id,
      criado_por, criado_por_nome, JSON.stringify(responsaveis || [])
    ]);
    
    // Criar subtarefas do checklist
    const checklist = t.checklist || [];
    for (let i = 0; i < checklist.length; i++) {
      await pool.query(`
        INSERT INTO todo_subtarefas (tarefa_id, titulo, ordem)
        VALUES ($1, $2, $3)
      `, [tarefa.rows[0].id, checklist[i], i]);
    }
    
    res.json(tarefa.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar tarefa do template:', err);
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// ============================================
// ROTAS TO-DO - RELATÓRIO DE TEMPO
// ============================================

router.get('/todo/relatorio-tempo', async (req, res) => {
  try {
    const { periodo = '30', user_cod } = req.query;
    const dias = parseInt(periodo);
    
    let query = `
      SELECT 
        t.id as tarefa_id,
        t.titulo,
        t.tempo_estimado_minutos,
        t.tempo_gasto_segundos,
        g.nome as grupo_nome,
        COALESCE(SUM(tt.duracao_segundos), 0) as tempo_registrado
      FROM todo_tarefas t
      LEFT JOIN todo_grupos g ON t.grupo_id = g.id
      LEFT JOIN todo_time_tracking tt ON t.id = tt.tarefa_id
      WHERE t.created_at >= NOW() - INTERVAL '${dias} days'
    `;
    
    const params = [];
    if (user_cod) {
      query += ` AND tt.user_cod = $1`;
      params.push(user_cod);
    }
    
    query += ` GROUP BY t.id, t.titulo, t.tempo_estimado_minutos, t.tempo_gasto_segundos, g.nome ORDER BY tempo_registrado DESC`;
    
    const result = await pool.query(query, params);
    
    // Calcular totais
    const totais = result.rows.reduce((acc, row) => ({
      tempo_estimado: acc.tempo_estimado + (row.tempo_estimado_minutos || 0) * 60,
      tempo_gasto: acc.tempo_gasto + (row.tempo_gasto_segundos || 0),
      tempo_registrado: acc.tempo_registrado + parseInt(row.tempo_registrado || 0)
    }), { tempo_estimado: 0, tempo_gasto: 0, tempo_registrado: 0 });
    
    res.json({
      tarefas: result.rows,
      totais
    });
  } catch (err) {
    console.error('❌ Erro ao gerar relatório de tempo:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});




// Função para processar recorrências
async function processarRecorrenciasInterno() {
  try {
    const agora = new Date();
    
    const tarefasRecorrentes = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrente = true 
      AND status = 'concluida'
      AND proxima_recorrencia IS NOT NULL 
      AND proxima_recorrencia <= $1
    `, [agora]);
    
    let reabertas = 0;
    
    for (const tarefa of tarefasRecorrentes.rows) {
      const proximaData = calcularProximaRecorrencia(
        new Date(), 
        tarefa.tipo_recorrencia, 
        tarefa.intervalo_recorrencia || 1
      );
      
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
      
      await pool.query(`
        INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name)
        VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')
      `, [tarefa.id]);
      
      reabertas++;
    }
    
    if (reabertas > 0) {
      console.log(`🔄 Recorrências: ${reabertas} tarefa(s) reaberta(s)`);
    }
  } catch (err) {
    console.error('❌ Erro ao processar recorrências:', err);
  }
}


  return router;
}

module.exports = { createTodoRouter, initTodoCron: function(pool) {
  // processarRecorrenciasInterno precisa do pool via closure do router
  // Então chamamos via HTTP interno ou re-implementamos aqui
  const processarRecorrencias = async () => {
    try {
      const agora = new Date();
      const tarefasRecorrentes = await pool.query(`
        SELECT * FROM todo_tarefas 
        WHERE recorrente = true 
        AND status = 'concluida'
        AND proxima_recorrencia IS NOT NULL 
        AND proxima_recorrencia <= $1
      `, [agora]);
      let reabertas = 0;
      for (const tarefa of tarefasRecorrentes.rows) {
        const calcularProximaRecorrencia = (dataBase, tipo, intervalo) => {
          const data = new Date(dataBase);
          switch(tipo) {
            case 'diaria': data.setDate(data.getDate() + intervalo); break;
            case 'semanal': data.setDate(data.getDate() + (7 * intervalo)); break;
            case 'mensal': data.setMonth(data.getMonth() + intervalo); break;
            default: data.setDate(data.getDate() + intervalo);
          }
          return data;
        };
        const proximaData = calcularProximaRecorrencia(new Date(), tarefa.tipo_recorrencia, tarefa.intervalo_recorrencia || 1);
        await pool.query(`UPDATE todo_tarefas SET status = 'pendente', data_conclusao = NULL, concluido_por = NULL, concluido_por_nome = NULL, proxima_recorrencia = $1, updated_at = NOW() WHERE id = $2`, [proximaData, tarefa.id]);
        await pool.query(`INSERT INTO todo_historico (tarefa_id, acao, descricao, user_cod, user_name) VALUES ($1, 'reaberta', 'Tarefa reaberta automaticamente (recorrência)', 'sistema', 'Sistema')`, [tarefa.id]);
        reabertas++;
      }
      if (reabertas > 0) console.log(`🔄 ${reabertas} tarefas recorrentes reabertas`);
    } catch (err) { console.error('❌ Erro ao processar recorrências:', err.message); }
  };
  if (process.env.WORKER_ENABLED !== 'true') {
    setInterval(processarRecorrencias, 60 * 60 * 1000);
    setTimeout(processarRecorrencias, 10000);
    console.log('🔄 Cron de recorrências Todo ativado (intervalo: 1h)');
  }
} };
