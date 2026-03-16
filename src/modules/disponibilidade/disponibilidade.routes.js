/**
 * MÓDULO DISPONIBILIDADE - Routes
 * 39 endpoints: regiões, lojas, linhas, faltosos, em-loja, sem-contato,
 *               espelho, restrições, relatórios, público
 */

const express = require('express');

function createDisponibilidadeRouter(pool, verificarToken) {
  const router = express.Router();

  // Helper: extrair wsId do header para não enviar de volta ao remetente
  const getSenderWsId = (req) => req.headers['x-ws-id'] || null;

  // Aplicar verificarToken apenas a rotas de disponibilidade (não bloquear rotas de outros módulos)
  router.use((req, res, next) => {
    if (req.path.startsWith('/disponibilidade')) {
      if (verificarToken) return verificarToken(req, res, next);
    }
    next();
  });

// GET /api/disponibilidade - Lista todas as regiões, lojas e linhas
router.get('/disponibilidade', async (req, res) => {
  try {
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    res.json({
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows
    });
  } catch (err) {
    console.error('❌ Erro ao buscar disponibilidade:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// POST /api/disponibilidade/regioes - Criar região
router.post('/disponibilidade/regioes', async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
    
    const result = await pool.query(
      'INSERT INTO disponibilidade_regioes (nome) VALUES ($1) RETURNING *',
      [nome.toUpperCase().trim()]
    );
    console.log('✅ Região criada:', result.rows[0]);
    // Broadcast: reload estrutural
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'regiao-criada' }, getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Região já existe' });
    }
    console.error('❌ Erro ao criar região:', err);
    res.status(500).json({ error: 'Erro ao criar região' });
  }
});

// PUT /api/disponibilidade/regioes/:id - Atualizar região
router.put('/disponibilidade/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, gestores, ordem } = req.body;
    
    const result = await pool.query(
      `UPDATE disponibilidade_regioes 
       SET nome = COALESCE($1, nome), gestores = COALESCE($2, gestores), ordem = COALESCE($3, ordem), updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [nome ? nome.toUpperCase().trim() : null, gestores !== undefined ? gestores : null, ordem, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'regiao-atualizada' }, getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar região:', err);
    res.status(500).json({ error: 'Erro ao atualizar região' });
  }
});

// DELETE /api/disponibilidade/regioes/:id - Deletar região
router.delete('/disponibilidade/regioes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_regioes WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Região não encontrada' });
    }
    console.log('🗑️ Região deletada:', result.rows[0]);
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'regiao-deletada' }, getSenderWsId(req));
    }
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar região:', err);
    res.status(500).json({ error: 'Erro ao deletar região' });
  }
});

// POST /api/disponibilidade/lojas - Criar loja com linhas
router.post('/disponibilidade/lojas', async (req, res) => {
  try {
    const { regiao_id, codigo, nome, qtd_titulares, qtd_excedentes } = req.body;
    
    if (!regiao_id || !codigo || !nome) {
      return res.status(400).json({ error: 'Campos obrigatórios: regiao_id, codigo, nome' });
    }
    
    // Verificar se região existe
    const regiaoCheck = await pool.query('SELECT id FROM disponibilidade_regioes WHERE id = $1', [regiao_id]);
    if (regiaoCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Região não encontrada' });
    }
    
    const titulares = Math.min(parseInt(qtd_titulares) || 0, 50);
    const excedentes = Math.min(parseInt(qtd_excedentes) || 0, 50);
    
    // Criar loja
    const lojaResult = await pool.query(
      'INSERT INTO disponibilidade_lojas (regiao_id, codigo, nome, qtd_titulares, qtd_excedentes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [regiao_id, codigo.trim(), nome.toUpperCase().trim(), titulares, excedentes]
    );
    const loja = lojaResult.rows[0];
    
    // Criar linhas vazias
    const linhas = [];
    
    // Criar linhas de titulares
    for (let i = 0; i < titulares; i++) {
      const linhaResult = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja.id, 'A CONFIRMAR', false]
      );
      linhas.push(linhaResult.rows[0]);
    }
    
    // Criar linhas de excedentes
    for (let i = 0; i < excedentes; i++) {
      const linhaResult = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja.id, 'A CONFIRMAR', true]
      );
      linhas.push(linhaResult.rows[0]);
    }
    
    console.log('✅ Loja criada:', loja.nome, 'com', titulares, 'titulares e', excedentes, 'excedentes');
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'loja-criada' }, getSenderWsId(req));
    }
    res.json({ loja, linhas });
  } catch (err) {
    console.error('❌ Erro ao criar loja:', err);
    res.status(500).json({ error: 'Erro ao criar loja' });
  }
});

// PUT /api/disponibilidade/lojas/:id - Atualizar loja
router.put('/disponibilidade/lojas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { codigo, nome, qtd_titulares, qtd_excedentes, ordem } = req.body;
    
    const result = await pool.query(
      `UPDATE disponibilidade_lojas 
       SET codigo = COALESCE($1, codigo), 
           nome = COALESCE($2, nome), 
           qtd_titulares = COALESCE($3, qtd_titulares),
           qtd_excedentes = COALESCE($4, qtd_excedentes),
           ordem = COALESCE($5, ordem), 
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [codigo, nome ? nome.toUpperCase().trim() : null, qtd_titulares, qtd_excedentes, ordem, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Loja não encontrada' });
    }
    console.log('✅ Loja atualizada:', result.rows[0]);
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'loja-atualizada' }, getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar loja:', err);
    res.status(500).json({ error: 'Erro ao atualizar loja' });
  }
});

// DELETE /api/disponibilidade/lojas/:id - Deletar loja
router.delete('/disponibilidade/lojas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_lojas WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Loja não encontrada' });
    }
    console.log('🗑️ Loja deletada:', result.rows[0]);
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'loja-deletada' }, getSenderWsId(req));
    }
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar loja:', err);
    res.status(500).json({ error: 'Erro ao deletar loja' });
  }
});

// POST /api/disponibilidade/linhas - Adicionar linhas a uma loja
router.post('/disponibilidade/linhas', async (req, res) => {
  try {
    const { loja_id, quantidade, is_excedente } = req.body;
    
    if (!loja_id) {
      return res.status(400).json({ error: 'loja_id é obrigatório' });
    }
    
    // Verificar se loja existe
    const lojaCheck = await pool.query('SELECT id FROM disponibilidade_lojas WHERE id = $1', [loja_id]);
    if (lojaCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Loja não encontrada' });
    }
    
    const qtd = Math.min(parseInt(quantidade) || 1, 50);
    const excedente = is_excedente === true;
    const linhas = [];
    
    for (let i = 0; i < qtd; i++) {
      const result = await pool.query(
        'INSERT INTO disponibilidade_linhas (loja_id, status, is_excedente) VALUES ($1, $2, $3) RETURNING *',
        [loja_id, 'A CONFIRMAR', excedente]
      );
      linhas.push(result.rows[0]);
    }
    
    console.log('✅', qtd, excedente ? 'excedente(s)' : 'titular(es)', 'adicionado(s) à loja', loja_id);
    // Broadcast: novas linhas adicionadas
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_LINHAS_ADD', { loja_id, linhas }, getSenderWsId(req));
    }
    res.json(linhas);
  } catch (err) {
    console.error('❌ Erro ao criar linhas:', err);
    res.status(500).json({ error: 'Erro ao criar linhas' });
  }
});

// PUT /api/disponibilidade/linhas/:id - Atualizar linha
router.put('/disponibilidade/linhas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { cod_profissional, nome_profissional, status, observacao, observacao_usuario } = req.body;
    
    // Validar status - incluindo SEM CONTATO e A CAMINHO
    const statusValidos = ['A CONFIRMAR', 'CONFIRMADO', 'A CAMINHO', 'EM LOJA', 'FALTANDO', 'SEM CONTATO'];
    const statusFinal = statusValidos.includes(status) ? status : 'A CONFIRMAR';
    
    // Buscar linha atual para verificar se observação mudou
    const linhaAtual = await pool.query('SELECT observacao FROM disponibilidade_linhas WHERE id = $1', [id]);
    const obsAtual = linhaAtual.rows[0]?.observacao || '';
    const obsNova = observacao || '';
    
    // Se observação foi adicionada ou modificada, registrar quem e quando
    let observacaoCriadaPor = null;
    let observacaoCriadaEm = null;
    
    if (obsNova && obsNova !== obsAtual) {
      // Observação foi modificada ou criada - registrar metadados
      observacaoCriadaPor = observacao_usuario || 'Sistema';
      observacaoCriadaEm = new Date();
    } else if (obsNova) {
      // Observação não mudou - manter os metadados existentes
      const metadados = await pool.query(
        'SELECT observacao_criada_por, observacao_criada_em FROM disponibilidade_linhas WHERE id = $1',
        [id]
      );
      if (metadados.rows.length > 0) {
        observacaoCriadaPor = metadados.rows[0].observacao_criada_por;
        observacaoCriadaEm = metadados.rows[0].observacao_criada_em;
      }
    }
    // Se observação foi removida (obsNova vazio), os metadados ficam null
    
    const result = await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = $1, 
           nome_profissional = $2, 
           status = $3, 
           observacao = $4,
           observacao_criada_por = $5,
           observacao_criada_em = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [
        cod_profissional || null, 
        nome_profissional || null, 
        statusFinal, 
        observacao || null,
        observacaoCriadaPor,
        observacaoCriadaEm,
        id
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada' });
    }
    // Broadcast atualização granular da linha para outros clientes
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_LINHA_UPDATE', result.rows[0], getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar linha:', err);
    res.status(500).json({ error: 'Erro ao atualizar linha' });
  }
});

// DELETE /api/disponibilidade/linhas/:id - Deletar linha
router.delete('/disponibilidade/linhas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_linhas WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada' });
    }
    // Broadcast: linha removida
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_LINHA_DELETE', { id: parseInt(id), loja_id: result.rows[0].loja_id }, getSenderWsId(req));
    }
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao deletar linha:', err);
    res.status(500).json({ error: 'Erro ao deletar linha' });
  }
});

// DELETE /api/disponibilidade/limpar-linhas - Limpa todas as linhas (mantém estrutura)
router.delete('/disponibilidade/limpar-linhas', async (req, res) => {
  try {
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET cod_profissional = NULL, nome_profissional = NULL, status = 'A CONFIRMAR', observacao = NULL, updated_at = CURRENT_TIMESTAMP`
    );
    console.log('🧹 Todas as linhas de disponibilidade foram resetadas');
    // Broadcast: reload completo necessário
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'limpar-linhas' }, getSenderWsId(req));
    }
    res.json({ success: true, message: 'Todas as linhas foram resetadas' });
  } catch (err) {
    console.error('❌ Erro ao limpar linhas:', err);
    res.status(500).json({ error: 'Erro ao limpar linhas' });
  }
});

// ============================================
// FALTOSOS
// ============================================

// POST /api/disponibilidade/faltosos - Registrar faltoso
router.post('/disponibilidade/faltosos', async (req, res) => {
  try {
    const { loja_id, cod_profissional, nome_profissional, motivo, data_falta } = req.body;
    
    if (!loja_id || !motivo) {
      return res.status(400).json({ error: 'Campos obrigatórios: loja_id, motivo' });
    }
    
    // Usar data_falta enviada ou data atual
    const dataFalta = data_falta || new Date().toISOString().split('T')[0];
    
    const result = await pool.query(
      `INSERT INTO disponibilidade_faltosos (loja_id, cod_profissional, nome_profissional, motivo, data_falta)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [loja_id, cod_profissional || null, nome_profissional || null, motivo, dataFalta]
    );
    
    console.log('⚠️ Faltoso registrado:', result.rows[0]);
    // Broadcast: faltoso registrado (pode afetar o painel se status foi alterado)
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'faltoso-registrado' }, getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao registrar faltoso:', err);
    res.status(500).json({ error: 'Erro ao registrar faltoso' });
  }
});

// GET /api/disponibilidade/faltosos - Listar faltosos com filtros
router.get('/disponibilidade/faltosos', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id } = req.query;
    
    let query = `
      SELECT f.*, l.codigo as loja_codigo, l.nome as loja_nome, r.nome as regiao_nome
      FROM disponibilidade_faltosos f
      JOIN disponibilidade_lojas l ON f.loja_id = l.id
      JOIN disponibilidade_regioes r ON l.regiao_id = r.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND f.data_falta >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND f.data_falta <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND f.loja_id = $${params.length}`;
    }
    
    query += ' ORDER BY f.data_falta DESC, f.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar faltosos:', err);
    res.status(500).json({ error: 'Erro ao listar faltosos' });
  }
});

// DELETE /api/disponibilidade/faltosos/:id - Excluir registro de falta
router.delete('/disponibilidade/faltosos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM disponibilidade_faltosos WHERE id = $1', [id]);
    console.log('🗑️ Falta excluída:', id);
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'faltoso-removido' }, getSenderWsId(req));
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir falta:', err);
    res.status(500).json({ error: 'Erro ao excluir falta' });
  }
});

// POST /api/disponibilidade/linha-reposicao - Criar linha de reposição
router.post('/disponibilidade/linha-reposicao', async (req, res) => {
  try {
    const { loja_id, after_linha_id } = req.body;
    
    if (!loja_id) {
      return res.status(400).json({ error: 'loja_id é obrigatório' });
    }
    
    const result = await pool.query(
      `INSERT INTO disponibilidade_linhas (loja_id, status, is_reposicao)
       VALUES ($1, 'A CONFIRMAR', true) RETURNING *`,
      [loja_id]
    );
    
    console.log('🔄 Linha de reposição criada:', result.rows[0]);
    // Broadcast: nova linha de reposição
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_LINHAS_ADD', { loja_id, linhas: [result.rows[0]] }, getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar linha de reposição:', err);
    res.status(500).json({ error: 'Erro ao criar linha de reposição' });
  }
});

// GET /api/disponibilidade/em-loja - Listar registros de motoboys EM LOJA
router.get('/disponibilidade/em-loja', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id } = req.query;
    
    let query = `
      SELECT e.*, l.nome as loja_nome
      FROM disponibilidade_em_loja e
      LEFT JOIN disponibilidade_lojas l ON e.loja_id = l.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND e.data_registro >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND e.data_registro <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND e.loja_id = $${params.length}`;
    }
    
    query += ' ORDER BY e.data_registro DESC, e.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar em loja:', err);
    res.status(500).json({ error: 'Erro ao listar em loja' });
  }
});

// GET /api/disponibilidade/sem-contato - Listar registros de motoboys SEM CONTATO
router.get('/disponibilidade/sem-contato', async (req, res) => {
  try {
    const { data_inicio, data_fim, loja_id, apenas_risco } = req.query;
    
    let query = `
      SELECT s.*, l.nome as loja_nome
      FROM disponibilidade_sem_contato s
      LEFT JOIN disponibilidade_lojas l ON s.loja_id = l.id
      WHERE 1=1
    `;
    const params = [];
    
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND s.data_registro >= $${params.length}`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND s.data_registro <= $${params.length}`;
    }
    if (loja_id) {
      params.push(loja_id);
      query += ` AND s.loja_id = $${params.length}`;
    }
    if (apenas_risco === 'true') {
      // Apenas motoboys com 2+ dias (risco de remoção)
      query += ` AND s.dias_consecutivos >= 2`;
    }
    
    query += ' ORDER BY s.dias_consecutivos DESC, s.data_registro DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar sem contato:', err);
    res.status(500).json({ error: 'Erro ao listar sem contato' });
  }
});

// GET /api/disponibilidade/ranking-em-loja - Ranking de motoboys que mais trabalharam
router.get('/disponibilidade/ranking-em-loja', async (req, res) => {
  try {
    const { dias = 30 } = req.query;
    
    const result = await pool.query(`
      SELECT 
        cod_profissional,
        nome_profissional,
        COUNT(*) as total_dias,
        MAX(data_registro) as ultimo_dia
      FROM disponibilidade_em_loja
      WHERE data_registro >= CURRENT_DATE - $1::int
      AND cod_profissional IS NOT NULL
      GROUP BY cod_profissional, nome_profissional
      ORDER BY total_dias DESC
      LIMIT 20
    `, [dias]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking em loja:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking em loja' });
  }
});

// GET /api/disponibilidade/motoboys - Listar todos os motoboys com histórico completo
router.get('/disponibilidade/motoboys', async (req, res) => {
  try {
    const { loja_id, busca, dias = 30 } = req.query;
    
    // 1. Buscar todos os motoboys únicos das linhas (atuais e históricos)
    let motoboyQuery = `
      SELECT DISTINCT 
        cod_profissional,
        nome_profissional,
        loja_id
      FROM disponibilidade_linhas
      WHERE cod_profissional IS NOT NULL AND cod_profissional != ''
    `;
    
    const params = [];
    
    if (loja_id) {
      params.push(loja_id);
      motoboyQuery += ` AND loja_id = $${params.length}`;
    }
    
    if (busca) {
      params.push(`%${busca}%`);
      motoboyQuery += ` AND (cod_profissional ILIKE $${params.length} OR nome_profissional ILIKE $${params.length})`;
    }
    
    const motoboysResult = await pool.query(motoboyQuery, params);
    
    // 2. Para cada motoboy, buscar estatísticas
    const motoboys = [];
    
    for (const mb of motoboysResult.rows) {
      // Buscar contagem de EM LOJA
      const emLojaResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_registro) as ultima_vez
        FROM disponibilidade_em_loja
        WHERE cod_profissional = $1
        AND data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar contagem de SEM CONTATO
      const semContatoResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_registro) as ultima_vez, MAX(dias_consecutivos) as max_dias
        FROM disponibilidade_sem_contato
        WHERE cod_profissional = $1
        AND data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar contagem de FALTAS
      const faltasResult = await pool.query(`
        SELECT COUNT(*) as total, MAX(data_falta) as ultima_falta
        FROM disponibilidade_faltosos
        WHERE cod_profissional = $1
        AND data_falta >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar lojas onde rodou
      const lojasResult = await pool.query(`
        SELECT DISTINCT l.id, l.nome, l.codigo
        FROM disponibilidade_em_loja el
        JOIN disponibilidade_lojas l ON el.loja_id = l.id
        WHERE el.cod_profissional = $1
        AND el.data_registro >= CURRENT_DATE - $2::int
      `, [mb.cod_profissional, parseInt(dias)]);
      
      // Buscar info da loja atual
      const lojaAtualResult = await pool.query(`
        SELECT l.id, l.nome, l.codigo, r.nome as regiao_nome
        FROM disponibilidade_lojas l
        LEFT JOIN disponibilidade_regioes r ON l.regiao_id = r.id
        WHERE l.id = $1
      `, [mb.loja_id]);
      
      // Buscar status atual
      const statusAtualResult = await pool.query(`
        SELECT status, observacao
        FROM disponibilidade_linhas
        WHERE cod_profissional = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `, [mb.cod_profissional]);
      
      motoboys.push({
        cod: mb.cod_profissional,
        nome: mb.nome_profissional,
        loja_id: mb.loja_id,
        loja_atual: lojaAtualResult.rows[0] || null,
        status_atual: statusAtualResult.rows[0]?.status || 'A CONFIRMAR',
        observacao: statusAtualResult.rows[0]?.observacao || null,
        estatisticas: {
          em_loja: {
            total: parseInt(emLojaResult.rows[0]?.total) || 0,
            ultima_vez: emLojaResult.rows[0]?.ultima_vez || null
          },
          sem_contato: {
            total: parseInt(semContatoResult.rows[0]?.total) || 0,
            ultima_vez: semContatoResult.rows[0]?.ultima_vez || null,
            max_dias_consecutivos: parseInt(semContatoResult.rows[0]?.max_dias) || 0
          },
          faltas: {
            total: parseInt(faltasResult.rows[0]?.total) || 0,
            ultima_falta: faltasResult.rows[0]?.ultima_falta || null
          }
        },
        lojas_rodou: lojasResult.rows
      });
    }
    
    // Ordenar por nome
    motoboys.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    
    res.json({
      total: motoboys.length,
      periodo_dias: parseInt(dias),
      motoboys
    });
  } catch (err) {
    console.error('❌ Erro ao buscar motoboys:', err);
    res.status(500).json({ error: 'Erro ao buscar motoboys' });
  }
});

// ============================================
// RESTRIÇÕES DE MOTOBOYS
// ============================================

// GET /api/disponibilidade/restricoes - Listar todas as restrições
router.get('/disponibilidade/restricoes', async (req, res) => {
  try {
    const { ativo = 'true' } = req.query;
    
    let query = `
      SELECT r.*, l.nome as loja_nome, l.codigo as loja_codigo
      FROM disponibilidade_restricoes r
      LEFT JOIN disponibilidade_lojas l ON r.loja_id = l.id
    `;
    
    if (ativo === 'true') {
      query += ' WHERE r.ativo = true';
    }
    
    query += ' ORDER BY r.created_at DESC';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar restrições:', err);
    res.status(500).json({ error: 'Erro ao buscar restrições' });
  }
});

// GET /api/disponibilidade/restricoes/verificar - Verificar se um motoboy está restrito em uma loja
router.get('/disponibilidade/restricoes/verificar', async (req, res) => {
  try {
    const { cod_profissional, loja_id } = req.query;
    
    if (!cod_profissional) {
      return res.json({ restrito: false });
    }
    
    // Verifica se está restrito em TODAS as lojas ou na loja específica
    const result = await pool.query(`
      SELECT r.*, l.nome as loja_nome, l.codigo as loja_codigo
      FROM disponibilidade_restricoes r
      LEFT JOIN disponibilidade_lojas l ON r.loja_id = l.id
      WHERE r.cod_profissional = $1 
      AND r.ativo = true
      AND (r.todas_lojas = true OR r.loja_id = $2)
      LIMIT 1
    `, [cod_profissional, loja_id || null]);
    
    if (result.rows.length > 0) {
      const restricao = result.rows[0];
      res.json({
        restrito: true,
        motivo: restricao.motivo,
        todas_lojas: restricao.todas_lojas,
        loja_nome: restricao.loja_nome,
        loja_codigo: restricao.loja_codigo,
        criado_em: restricao.created_at
      });
    } else {
      res.json({ restrito: false });
    }
  } catch (err) {
    console.error('❌ Erro ao verificar restrição:', err);
    res.status(500).json({ error: 'Erro ao verificar restrição' });
  }
});

// POST /api/disponibilidade/restricoes - Criar nova restrição
router.post('/disponibilidade/restricoes', async (req, res) => {
  try {
    const { cod_profissional, nome_profissional, loja_id, todas_lojas, motivo, criado_por } = req.body;
    
    if (!cod_profissional || !motivo) {
      return res.status(400).json({ error: 'Código e motivo são obrigatórios' });
    }
    
    // Verificar se já existe restrição ativa para este motoboy nesta loja
    const existente = await pool.query(`
      SELECT id FROM disponibilidade_restricoes 
      WHERE cod_profissional = $1 
      AND ativo = true
      AND (todas_lojas = true OR loja_id = $2 OR $3 = true)
    `, [cod_profissional, loja_id || null, todas_lojas || false]);
    
    if (existente.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma restrição ativa para este motoboy nesta loja' });
    }
    
    const result = await pool.query(`
      INSERT INTO disponibilidade_restricoes 
      (cod_profissional, nome_profissional, loja_id, todas_lojas, motivo, criado_por)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      cod_profissional,
      nome_profissional || null,
      todas_lojas ? null : (loja_id || null),
      todas_lojas || false,
      motivo,
      criado_por || null
    ]);
    
    console.log(`🚫 Nova restrição criada: ${cod_profissional} - ${nome_profissional}`);
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'restricao-criada' }, getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar restrição:', err);
    res.status(500).json({ error: 'Erro ao criar restrição' });
  }
});

// PUT /api/disponibilidade/restricoes/:id - Atualizar restrição
router.put('/disponibilidade/restricoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { loja_id, todas_lojas, motivo, ativo } = req.body;
    
    const result = await pool.query(`
      UPDATE disponibilidade_restricoes 
      SET loja_id = $1, todas_lojas = $2, motivo = $3, ativo = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [
      todas_lojas ? null : (loja_id || null),
      todas_lojas || false,
      motivo,
      ativo !== undefined ? ativo : true,
      id
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }
    
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'restricao-atualizada' }, getSenderWsId(req));
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar restrição:', err);
    res.status(500).json({ error: 'Erro ao atualizar restrição' });
  }
});

// DELETE /api/disponibilidade/restricoes/:id - Remover restrição (desativar)
router.delete('/disponibilidade/restricoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Ao invés de deletar, desativa
    const result = await pool.query(`
      UPDATE disponibilidade_restricoes 
      SET ativo = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }
    
    console.log(`✅ Restrição ${id} desativada`);
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'restricao-removida' }, getSenderWsId(req));
    }
    res.json({ success: true, message: 'Restrição removida' });
  } catch (err) {
    console.error('❌ Erro ao remover restrição:', err);
    res.status(500).json({ error: 'Erro ao remover restrição' });
  }
});

// ============================================
// ESPELHO (Histórico)
// ============================================

// POST /api/disponibilidade/espelho - Salvar snapshot antes do reset
router.post('/disponibilidade/espelho', async (req, res) => {
  try {
    // Buscar todos os dados atuais
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      salvo_em: new Date().toISOString()
    };
    
    // Verificar se já existe espelho para hoje
    const hoje = new Date().toISOString().split('T')[0];
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [hoje]
    );
    
    if (existing.rows.length > 0) {
      // Atualizar o existente
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1 WHERE data_registro = $2',
        [JSON.stringify(dados), hoje]
      );
    } else {
      // Criar novo
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [hoje, JSON.stringify(dados)]
      );
    }
    
    console.log('📸 Espelho salvo para', hoje);
    res.json({ success: true, data: hoje });
  } catch (err) {
    console.error('❌ Erro ao salvar espelho:', err);
    res.status(500).json({ error: 'Erro ao salvar espelho' });
  }
});

// GET /api/disponibilidade/espelho - Listar datas disponíveis
router.get('/disponibilidade/espelho', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, data_registro, created_at FROM disponibilidade_espelho ORDER BY data_registro DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar espelhos:', err);
    res.status(500).json({ error: 'Erro ao listar espelhos' });
  }
});

// GET /api/disponibilidade/espelho/:data - Buscar espelho por data
router.get('/disponibilidade/espelho/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const result = await pool.query(
      'SELECT * FROM disponibilidade_espelho WHERE data_registro = $1',
      [data]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Espelho não encontrado para esta data' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar espelho:', err);
    res.status(500).json({ error: 'Erro ao buscar espelho' });
  }
});

// DELETE /api/disponibilidade/espelho/:id - Excluir espelho por ID
router.delete('/disponibilidade/espelho/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM disponibilidade_espelho WHERE id = $1 RETURNING data_registro', [id]);
    if (result.rows.length > 0) {
      console.log('🗑️ Espelho excluído:', result.rows[0].data_registro);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao excluir espelho:', err);
    res.status(500).json({ error: 'Erro ao excluir espelho' });
  }
});

// PATCH /api/disponibilidade/faltosos/corrigir-datas - Corrigir datas erradas
router.patch('/disponibilidade/faltosos/corrigir-datas', async (req, res) => {
  try {
    const { data_errada, data_correta } = req.body;
    const result = await pool.query(
      'UPDATE disponibilidade_faltosos SET data_falta = $1 WHERE data_falta = $2 RETURNING *',
      [data_correta, data_errada]
    );
    console.log(`📅 Datas corrigidas: ${data_errada} → ${data_correta} (${result.rowCount} registros)`);
    res.json({ success: true, corrigidos: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao corrigir datas:', err);
    res.status(500).json({ error: 'Erro ao corrigir datas' });
  }
});

// PATCH /api/disponibilidade/espelho/corrigir-data - Corrigir data do espelho
router.patch('/disponibilidade/espelho/corrigir-data', async (req, res) => {
  try {
    const { data_errada, data_correta } = req.body;
    const result = await pool.query(
      'UPDATE disponibilidade_espelho SET data_registro = $1 WHERE data_registro = $2 RETURNING *',
      [data_correta, data_errada]
    );
    console.log(`📅 Data do espelho corrigida: ${data_errada} → ${data_correta} (${result.rowCount} registros)`);
    res.json({ success: true, corrigidos: result.rowCount });
  } catch (err) {
    console.error('❌ Erro ao corrigir data do espelho:', err);
    res.status(500).json({ error: 'Erro ao corrigir data do espelho' });
  }
});

// POST /api/disponibilidade/resetar - Resetar status (com salvamento de espelho)
router.post('/disponibilidade/resetar', async (req, res) => {
  try {
    // Pegar a data da planilha (enviada pelo frontend) ou usar hoje
    const { data_planilha } = req.body || {};
    const dataEspelho = data_planilha || new Date().toISOString().split('T')[0];
    
    // 1. Salvar espelho antes de resetar
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY ordem, nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas ORDER BY id');
    
    const dados = {
      regioes: regioes.rows,
      lojas: lojas.rows,
      linhas: linhas.rows,
      data_planilha: dataEspelho,
      salvo_em: new Date().toISOString()
    };
    
    const existing = await pool.query(
      'SELECT id FROM disponibilidade_espelho WHERE data_registro = $1',
      [dataEspelho]
    );
    
    let espelhoSalvo = false;
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE disponibilidade_espelho SET dados = $1, created_at = CURRENT_TIMESTAMP WHERE data_registro = $2',
        [JSON.stringify(dados), dataEspelho]
      );
      espelhoSalvo = true;
    } else {
      await pool.query(
        'INSERT INTO disponibilidade_espelho (data_registro, dados) VALUES ($1, $2)',
        [dataEspelho, JSON.stringify(dados)]
      );
      espelhoSalvo = true;
    }
    console.log('📸 Espelho salvo antes do reset:', dataEspelho, '- Linhas:', linhas.rows.length);
    
    // 1.5. SALVAR OBSERVAÇÕES NO HISTÓRICO antes de resetar
    const linhasComObs = linhas.rows.filter(l => l.observacao && l.observacao.trim() !== '');
    let observacoesSalvas = 0;
    
    for (const linha of linhasComObs) {
      await pool.query(
        `INSERT INTO disponibilidade_observacoes_historico 
         (linha_id, loja_id, cod_profissional, nome_profissional, observacao, criada_por, criada_em, data_reset, data_planilha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)`,
        [
          linha.id,
          linha.loja_id,
          linha.cod_profissional,
          linha.nome_profissional,
          linha.observacao,
          linha.observacao_criada_por,
          linha.observacao_criada_em,
          dataEspelho
        ]
      );
      observacoesSalvas++;
    }
    console.log('📝 Observações salvas no histórico:', observacoesSalvas);
    
    // 2. REGISTRAR MOTOBOYS "EM LOJA" antes de resetar
    const emLojaLinhas = linhas.rows.filter(l => l.status === 'EM LOJA' && l.cod_profissional);
    for (const linha of emLojaLinhas) {
      await pool.query(
        `INSERT INTO disponibilidade_em_loja (loja_id, cod_profissional, nome_profissional, data_registro)
         VALUES ($1, $2, $3, $4)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho]
      );
    }
    console.log('🏪 Motoboys EM LOJA registrados:', emLojaLinhas.length);
    
    // 3. REGISTRAR MOTOBOYS "SEM CONTATO" e verificar dias consecutivos
    const semContatoLinhas = linhas.rows.filter(l => l.status === 'SEM CONTATO' && l.cod_profissional);
    const removidos = [];
    
    for (const linha of semContatoLinhas) {
      // Verificar se já tem registro recente (ontem ou antes)
      const ultimoRegistro = await pool.query(
        `SELECT * FROM disponibilidade_sem_contato 
         WHERE cod_profissional = $1 AND loja_id = $2
         ORDER BY data_registro DESC LIMIT 1`,
        [linha.cod_profissional, linha.loja_id]
      );
      
      let diasConsecutivos = 1;
      
      if (ultimoRegistro.rows.length > 0) {
        const ultimaData = new Date(ultimoRegistro.rows[0].data_registro);
        const dataAtual = new Date(dataEspelho);
        const diffDias = Math.floor((dataAtual - ultimaData) / (1000 * 60 * 60 * 24));
        
        // Se o último registro foi ontem (ou há 1 dia), incrementa contador
        if (diffDias === 1) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos + 1;
        }
        // Se foi no mesmo dia, mantém o mesmo contador
        else if (diffDias === 0) {
          diasConsecutivos = ultimoRegistro.rows[0].dias_consecutivos;
        }
        // Se foi há mais de 1 dia, reseta contador
      }
      
      // Inserir novo registro
      await pool.query(
        `INSERT INTO disponibilidade_sem_contato (loja_id, cod_profissional, nome_profissional, data_registro, dias_consecutivos)
         VALUES ($1, $2, $3, $4, $5)`,
        [linha.loja_id, linha.cod_profissional, linha.nome_profissional, dataEspelho, diasConsecutivos]
      );
      
      // AUTO-REMOÇÃO: Se chegou a 3 dias consecutivos, remove da planilha
      if (diasConsecutivos >= 3) {
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = NULL, nome_profissional = NULL, status = 'A CONFIRMAR', observacao = NULL
           WHERE id = $1`,
          [linha.id]
        );
        removidos.push({
          cod: linha.cod_profissional,
          nome: linha.nome_profissional,
          dias: diasConsecutivos
        });
        console.log('🚫 Auto-removido por 3 dias SEM CONTATO:', linha.cod_profissional, linha.nome_profissional);
      }
    }
    console.log('📵 Motoboys SEM CONTATO registrados:', semContatoLinhas.length, '- Removidos:', removidos.length);
    
    // 4. Processar linhas de reposição
    // Regra: Se há excedente vazio disponível, migra o usuário para lá. Senão, reposição vira nova linha excedente.
    
    // Buscar todas as linhas de reposição que têm usuário preenchido
    const reposicoesPreenchidas = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND cod_profissional IS NOT NULL AND cod_profissional != ''`
    );
    
    // Buscar todas as linhas de reposição vazias
    const reposicoesVazias = await pool.query(
      `SELECT * FROM disponibilidade_linhas 
       WHERE is_reposicao = true AND (cod_profissional IS NULL OR cod_profissional = '')`
    );
    
    console.log('📊 Reposições preenchidas:', reposicoesPreenchidas.rows.length);
    console.log('📊 Reposições vazias:', reposicoesVazias.rows.length);
    
    // Para cada reposição preenchida, tentar migrar para excedente vazio da mesma loja
    for (const reposicao of reposicoesPreenchidas.rows) {
      // Buscar excedente vazio na mesma loja
      const excedenteVazio = await pool.query(
        `SELECT id FROM disponibilidade_linhas 
         WHERE loja_id = $1 AND is_excedente = true 
         AND (cod_profissional IS NULL OR cod_profissional = '')
         LIMIT 1`,
        [reposicao.loja_id]
      );
      
      if (excedenteVazio.rows.length > 0) {
        // Migrar usuário para o excedente vazio
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET cod_profissional = $1, nome_profissional = $2
           WHERE id = $3`,
          [reposicao.cod_profissional, reposicao.nome_profissional, excedenteVazio.rows[0].id]
        );
        // Deletar a linha de reposição (já migrou o usuário)
        await pool.query('DELETE FROM disponibilidade_linhas WHERE id = $1', [reposicao.id]);
        console.log('✅ Usuário migrado de reposição para excedente vazio:', reposicao.cod_profissional);
      } else {
        // Não há excedente vazio, converter reposição em nova linha excedente (mantém o usuário)
        await pool.query(
          `UPDATE disponibilidade_linhas 
           SET is_excedente = true, is_reposicao = false 
           WHERE id = $1`,
          [reposicao.id]
        );
        console.log('✅ Reposição convertida em excedente adicional:', reposicao.cod_profissional);
      }
    }
    
    // Deletar reposições vazias (não precisam virar excedente)
    await pool.query(
      `DELETE FROM disponibilidade_linhas WHERE is_reposicao = true`
    );
    console.log('🗑️ Reposições vazias removidas');
    
    // 5. Resetar APENAS status (MANTER observações, cod e nome!)
    await pool.query(
      `UPDATE disponibilidade_linhas 
       SET status = 'A CONFIRMAR', 
           updated_at = CURRENT_TIMESTAMP`
    );
    
    console.log('🔄 Status resetado com sucesso (códigos e nomes mantidos)');
    // Broadcast: reload completo após reset
    if (global.broadcastDisponibilidade) {
      global.broadcastDisponibilidade('DISP_RELOAD', { reason: 'resetar' }, getSenderWsId(req));
    }
    res.json({ 
      success: true, 
      espelho_data: dataEspelho, 
      espelho_salvo: espelhoSalvo,
      em_loja_registrados: emLojaLinhas.length,
      sem_contato_registrados: semContatoLinhas.length,
      removidos_por_sem_contato: removidos
    });
  } catch (err) {
    console.error('❌ Erro ao resetar:', err);
    res.status(500).json({ error: 'Erro ao resetar status' });
  }
});

// ============================================
// HISTÓRICO DE OBSERVAÇÕES
// ============================================

// GET /api/disponibilidade/observacoes-historico - Listar histórico de observações com filtros
router.get('/disponibilidade/observacoes-historico', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_profissional, loja_id, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM disponibilidade_observacoes_historico WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      query += ` AND data_reset >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    
    if (data_fim) {
      query += ` AND data_reset <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    if (cod_profissional) {
      query += ` AND cod_profissional = $${paramIndex}`;
      params.push(cod_profissional);
      paramIndex++;
    }
    
    if (loja_id) {
      query += ` AND loja_id = $${paramIndex}`;
      params.push(loja_id);
      paramIndex++;
    }
    
    query += ` ORDER BY data_reset DESC, created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico de observações:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico de observações' });
  }
});

// GET /api/disponibilidade/observacoes-historico/datas - Listar datas disponíveis no histórico
router.get('/disponibilidade/observacoes-historico/datas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT data_reset, data_planilha, COUNT(*) as total_observacoes
      FROM disponibilidade_observacoes_historico
      GROUP BY data_reset, data_planilha
      ORDER BY data_reset DESC
      LIMIT 30
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar datas do histórico:', err);
    res.status(500).json({ error: 'Erro ao buscar datas do histórico' });
  }
});

// ============================================
// RELATÓRIOS E HISTÓRICO
// ============================================

// GET /api/disponibilidade/relatorios/metricas - Métricas dos últimos 7 espelhos salvos
router.get('/disponibilidade/relatorios/metricas', async (req, res) => {
  try {
    // Buscar os últimos 7 espelhos salvos (independente da data)
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Processar métricas por dia
    const metricas = [];
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      const totalTitulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let percOperacao = 0;
      if (totalTitulares > 0) {
        percOperacao = Math.min((emLoja / totalTitulares) * 100, 100);
      }
      
      metricas.push({
        data: espelho.data_registro,
        totalTitulares,
        emLoja,
        faltando,
        semContato,
        percOperacao: parseFloat(percOperacao.toFixed(1))
      });
    }
    
    res.json(metricas);
  } catch (err) {
    console.error('❌ Erro ao buscar métricas:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-lojas - Ranking de lojas por % EM LOJA
router.get('/disponibilidade/relatorios/ranking-lojas', async (req, res) => {
  try {
    // Buscar últimos 7 espelhos
    const espelhos = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 7
    `);
    
    // Buscar lojas para ter os nomes
    const lojasResult = await pool.query(`
      SELECT l.*, r.nome as regiao_nome 
      FROM disponibilidade_lojas l
      LEFT JOIN disponibilidade_regioes r ON l.regiao_id = r.id
    `);
    const lojasInfo = {};
    lojasResult.rows.forEach(l => {
      lojasInfo[l.id] = { nome: l.nome, regiao: l.regiao_nome };
    });
    
    // Agrupar dados por loja
    const lojasMap = {};
    
    for (const espelho of espelhos.rows) {
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      const linhas = dados?.linhas || [];
      
      // Agrupar linhas por loja
      const linhasPorLoja = {};
      linhas.forEach(linha => {
        if (!linha.loja_id) return;
        if (!linhasPorLoja[linha.loja_id]) {
          linhasPorLoja[linha.loja_id] = [];
        }
        linhasPorLoja[linha.loja_id].push(linha);
      });
      
      // Calcular métricas por loja neste dia
      Object.entries(linhasPorLoja).forEach(([lojaId, linhasLoja]) => {
        if (!lojasMap[lojaId]) {
          lojasMap[lojaId] = {
            loja_id: lojaId,
            loja_nome: lojasInfo[lojaId]?.nome || 'Desconhecida',
            regiao_nome: lojasInfo[lojaId]?.regiao || '',
            dias: []
          };
        }
        
        const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
        const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
        // % baseado em EM LOJA vs TITULARES, limitado a 100%
        const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
        
        lojasMap[lojaId].dias.push(perc);
      });
    }
    
    // Calcular média por loja
    const ranking = Object.values(lojasMap).map(loja => {
      const mediaPerc = loja.dias.length > 0 
        ? (loja.dias.reduce((a, b) => a + b, 0) / loja.dias.length).toFixed(1)
        : 0;
      return {
        loja_id: loja.loja_id,
        loja_nome: loja.loja_nome,
        regiao_nome: loja.regiao_nome,
        mediaPerc: parseFloat(mediaPerc),
        diasAnalisados: loja.dias.length
      };
    });
    
    // Ordenar por média (melhores primeiro)
    ranking.sort((a, b) => b.mediaPerc - a.mediaPerc);
    
    res.json(ranking);
  } catch (err) {
    console.error('❌ Erro ao buscar ranking lojas:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/ranking-faltosos - Ranking de entregadores que mais faltam
router.get('/disponibilidade/relatorios/ranking-faltosos', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltosos do período
    const faltosos = await pool.query(`
      SELECT f.*, l.nome as loja_nome
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      ORDER BY f.data_falta DESC
    `);
    
    // Agrupar por profissional
    const profissionaisMap = {};
    faltosos.rows.forEach(falta => {
      const key = falta.cod_profissional || falta.nome_profissional;
      if (!key) return;
      
      if (!profissionaisMap[key]) {
        profissionaisMap[key] = {
          cod: falta.cod_profissional,
          nome: falta.nome_profissional,
          loja_nome: falta.loja_nome,
          totalFaltas: 0,
          motivos: [],
          ultimaFalta: falta.data_falta
        };
      }
      profissionaisMap[key].totalFaltas++;
      if (falta.motivo && !profissionaisMap[key].motivos.includes(falta.motivo)) {
        profissionaisMap[key].motivos.push(falta.motivo);
      }
    });
    
    // Converter para array e ordenar
    const ranking = Object.values(profissionaisMap);
    ranking.sort((a, b) => b.totalFaltas - a.totalFaltas);
    
    res.json(ranking.slice(0, 20)); // Top 20
  } catch (err) {
    console.error('❌ Erro ao buscar ranking faltosos:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking' });
  }
});

// GET /api/disponibilidade/relatorios/comparativo - Comparar últimos 3 espelhos salvos
router.get('/disponibilidade/relatorios/comparativo', async (req, res) => {
  try {
    // Buscar os 3 últimos espelhos salvos (ordenados por data_registro DESC)
    const espelhosResult = await pool.query(`
      SELECT * FROM disponibilidade_espelho 
      ORDER BY data_registro DESC
      LIMIT 3
    `);
    
    // Função para calcular métricas com lógica correta de %
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const calcularMetricas = (linhas, dataRegistro) => {
      if (!linhas || linhas.length === 0) {
        return null;
      }
      
      const titulares = linhas.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const emLoja = linhas.filter(l => l.status === 'EM LOJA').length;
      const faltando = linhas.filter(l => l.status === 'FALTANDO').length;
      const semContato = linhas.filter(l => l.status === 'SEM CONTATO').length;
      
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      let perc = 0;
      if (titulares > 0) {
        perc = Math.min((emLoja / titulares) * 100, 100);
      }
      
      return { 
        titulares, 
        emLoja,
        faltando, 
        semContato, 
        perc: parseFloat(perc.toFixed(1)),
        data: dataRegistro
      };
    };
    
    // Extrair linhas do espelho (campo dados é JSON)
    const extrairLinhasEspelho = (espelho) => {
      if (!espelho) return [];
      const dados = typeof espelho.dados === 'string' ? JSON.parse(espelho.dados) : espelho.dados;
      return dados?.linhas || [];
    };
    
    // Formatar data para exibição
    const formatarData = (data) => {
      if (!data) return '';
      const d = new Date(data);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    };
    
    const espelhos = espelhosResult.rows;
    
    // Mais recente = "HOJE" (ou último salvo)
    // Segundo = "ONTEM" (ou penúltimo salvo)  
    // Terceiro = "ANTERIOR" (ou antepenúltimo salvo)
    const resultado = {
      hoje: espelhos[0] ? calcularMetricas(extrairLinhasEspelho(espelhos[0]), espelhos[0].data_registro) : null,
      ontem: espelhos[1] ? calcularMetricas(extrairLinhasEspelho(espelhos[1]), espelhos[1].data_registro) : null,
      semanaPassada: espelhos[2] ? calcularMetricas(extrairLinhasEspelho(espelhos[2]), espelhos[2].data_registro) : null,
      // Labels dinâmicos baseados nas datas reais
      labels: {
        hoje: espelhos[0] ? formatarData(espelhos[0].data_registro) : 'MAIS RECENTE',
        ontem: espelhos[1] ? formatarData(espelhos[1].data_registro) : 'ANTERIOR',
        semanaPassada: espelhos[2] ? formatarData(espelhos[2].data_registro) : '3º ANTERIOR'
      }
    };
    
    res.json(resultado);
  } catch (err) {
    console.error('❌ Erro ao buscar comparativo:', err);
    res.status(500).json({ error: 'Erro ao buscar comparativo' });
  }
});

// GET /api/disponibilidade/relatorios/heatmap - Heatmap de faltas por dia da semana e loja
router.get('/disponibilidade/relatorios/heatmap', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    
    // Buscar faltas com dia da semana
    const faltas = await pool.query(`
      SELECT 
        f.loja_id,
        l.nome as loja_nome,
        EXTRACT(DOW FROM f.data_falta) as dia_semana,
        COUNT(*) as total_faltas
      FROM disponibilidade_faltosos f
      LEFT JOIN disponibilidade_lojas l ON f.loja_id = l.id
      WHERE f.data_falta >= CURRENT_DATE - INTERVAL '${parseInt(periodo)} days'
      GROUP BY f.loja_id, l.nome, EXTRACT(DOW FROM f.data_falta)
      ORDER BY l.nome, dia_semana
    `);
    
    // Organizar em formato de heatmap
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const lojasMap = {};
    
    faltas.rows.forEach(row => {
      if (!lojasMap[row.loja_id]) {
        lojasMap[row.loja_id] = {
          loja_nome: row.loja_nome,
          dias: [0, 0, 0, 0, 0, 0, 0]
        };
      }
      lojasMap[row.loja_id].dias[parseInt(row.dia_semana)] = parseInt(row.total_faltas);
    });
    
    res.json({
      diasSemana,
      lojas: Object.values(lojasMap)
    });
  } catch (err) {
    console.error('❌ Erro ao buscar heatmap:', err);
    res.status(500).json({ error: 'Erro ao buscar heatmap' });
  }
});

// ============================================
// LINK PÚBLICO (SOMENTE LEITURA)
// ============================================

// GET /api/disponibilidade/publico - Retorna página HTML com panorama somente leitura
router.get('/disponibilidade/publico', async (req, res) => {
  try {
    const regioes = await pool.query('SELECT * FROM disponibilidade_regioes ORDER BY ordem, nome');
    const lojas = await pool.query('SELECT * FROM disponibilidade_lojas ORDER BY nome');
    const linhas = await pool.query('SELECT * FROM disponibilidade_linhas');
    
    // Calcular dados de cada loja
    // % = (emLoja / titulares) * 100, limitado a 100% (excedentes não contam extra)
    const lojasComDados = lojas.rows.map(loja => {
      const linhasLoja = linhas.rows.filter(l => l.loja_id === loja.id);
      const titulares = linhasLoja.filter(l => !l.is_excedente && !l.is_reposicao).length;
      const aCaminho = linhasLoja.filter(l => l.status === 'A CAMINHO').length;
      const confirmado = linhasLoja.filter(l => l.status === 'CONFIRMADO').length;
      const emLoja = linhasLoja.filter(l => l.status === 'EM LOJA').length;
      const semContato = linhasLoja.filter(l => l.status === 'SEM CONTATO').length;
      const emOperacao = aCaminho + confirmado + emLoja;
      const falta = Math.max(0, titulares - emOperacao);
      // % baseado em EM LOJA vs TITULARES, limitado a 100%
      const perc = titulares > 0 ? Math.min((emLoja / titulares) * 100, 100) : 0;
      const regiao = regioes.rows.find(r => r.id === loja.regiao_id);
      return { ...loja, titulares, aCaminho, confirmado, emLoja, semContato, emOperacao, falta, perc, regiao };
    });
    
    // Totais
    let totalGeral = { aCaminho: 0, confirmado: 0, emLoja: 0, titulares: 0, falta: 0, semContato: 0, emOperacao: 0 };
    lojasComDados.forEach(l => {
      totalGeral.aCaminho += l.aCaminho;
      totalGeral.confirmado += l.confirmado;
      totalGeral.emLoja += l.emLoja;
      totalGeral.titulares += l.titulares;
      totalGeral.falta += l.falta;
      totalGeral.semContato += l.semContato;
      totalGeral.emOperacao += l.emOperacao;
    });
    // % geral baseado em EM LOJA vs TITULARES, limitado a 100%
    const percGeral = totalGeral.titulares > 0 ? Math.min((totalGeral.emLoja / totalGeral.titulares) * 100, 100) : 0;
    
    // Gerar HTML - Design Clean
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panorama - Disponibilidade</title>
  <meta http-equiv="refresh" content="120">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 12px; }
    .header { background: white; padding: 16px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header h1 { font-size: 15px; color: #1e293b; font-weight: 600; }
    .header .info { font-size: 11px; color: #64748b; margin-top: 4px; }
    .badge { padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 12px; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-yellow { background: #fef3c7; color: #a16207; }
    .badge-red { background: #fee2e2; color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #f8fafc; color: #475569; padding: 8px 6px; text-align: center; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
    th.lojas { text-align: left; }
    td { padding: 4px 6px; border: 1px solid #e2e8f0; text-align: center; }
    td.loja { text-align: left; background: #fafafa; font-weight: 500; }
    tr.regiao td { background: #e2e8f0; font-weight: 700; text-align: center; color: #1e293b; }
    tr.total td { background: #f8fafc; font-weight: 700; border-top: 2px solid #cbd5e1; }
    tr.critico { background: #fef2f2; }
    tr.critico td.loja { background: #fef2f2; }
    .num-zero { color: #cbd5e1; }
    .num-acaminho { color: #ea580c; }
    .num-confirmado { color: #16a34a; }
    .num-emloja { color: #2563eb; font-weight: 700; }
    .num-ideal { color: #64748b; }
    .num-falta { color: #dc2626; font-weight: 600; }
    .num-semcontato { color: #d97706; }
    .perc { font-weight: 700; }
    .perc-ok { background: #bbf7d0; color: #15803d; }
    .perc-warn { background: #fde68a; color: #a16207; }
    .perc-danger { background: #fecaca; color: #b91c1c; }
    .perc-neutral { background: #f1f5f9; color: #475569; }
    .footer { margin-top: 12px; text-align: center; font-size: 10px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>📊 PANORAMA DIÁRIO OPERACIONAL</h1>
      <div class="info">Atualizado: ${new Date().toLocaleString('pt-BR')} | Auto-refresh: 2min</div>
    </div>
    <div>
      <span class="badge ${percGeral >= 100 ? 'badge-green' : percGeral >= 80 ? 'badge-yellow' : 'badge-red'}">
        ${percGeral.toFixed(0)}% GERAL
      </span>
      ${totalGeral.falta > 0 ? `<span class="badge badge-red" style="margin-left:5px">⚠️ FALTAM ${totalGeral.falta}</span>` : ''}
    </div>
  </div>
  
  <table>
    <thead>
      <tr>
        <th class="lojas">LOJAS</th>
        <th>A CAMINHO</th>
        <th>CONFIR.</th>
        <th>EM LOJA</th>
        <th>IDEAL</th>
        <th>FALTA</th>
        <th>S/ CONTATO</th>
        <th>%</th>
      </tr>
    </thead>
    <tbody>`;
    
    // Renderizar por região
    regioes.rows.forEach(regiao => {
      const lojasReg = lojasComDados.filter(l => l.regiao_id === regiao.id);
      if (lojasReg.length === 0) return;
      
      // Header região
      html += `<tr class="regiao"><td colspan="8">${regiao.nome}${regiao.gestores ? ` (${regiao.gestores})` : ''}</td></tr>`;
      
      // Lojas
      lojasReg.forEach(loja => {
        const critico = loja.perc < 50 ? 'critico' : '';
        const percClass = loja.perc >= 100 ? 'perc-ok' : loja.perc >= 80 ? 'perc-neutral' : loja.perc >= 50 ? 'perc-warn' : 'perc-danger';
        html += `<tr class="${critico}">
          <td class="loja">${loja.perc < 50 ? '🔴 ' : ''}${loja.nome}</td>
          <td class="${loja.aCaminho > 0 ? 'num-acaminho' : 'num-zero'}">${loja.aCaminho}</td>
          <td class="${loja.confirmado > 0 ? 'num-confirmado' : 'num-zero'}">${loja.confirmado}</td>
          <td class="${loja.emLoja > 0 ? 'num-emloja' : 'num-zero'}">${loja.emLoja}</td>
          <td class="num-ideal">${loja.titulares}</td>
          <td class="${loja.falta > 0 ? 'num-falta' : 'num-zero'}">${loja.falta > 0 ? -loja.falta : 0}</td>
          <td class="${loja.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${loja.semContato}</td>
          <td class="perc ${percClass}">${loja.perc.toFixed(0)}%</td>
        </tr>`;
      });
    });
    
    // Total geral
    const totalPercClass = percGeral >= 100 ? 'perc-ok' : percGeral >= 80 ? 'perc-neutral' : percGeral >= 50 ? 'perc-warn' : 'perc-danger';
    html += `<tr class="total">
      <td style="text-align:left;color:#1e293b">TOTAL GERAL</td>
      <td class="num-acaminho">${totalGeral.aCaminho}</td>
      <td class="num-confirmado">${totalGeral.confirmado}</td>
      <td class="num-emloja">${totalGeral.emLoja}</td>
      <td class="num-ideal">${totalGeral.titulares}</td>
      <td class="${totalGeral.falta > 0 ? 'num-falta' : 'num-zero'}">${totalGeral.falta > 0 ? -totalGeral.falta : 0}</td>
      <td class="${totalGeral.semContato > 0 ? 'num-semcontato' : 'num-zero'}">${totalGeral.semContato}</td>
      <td class="perc ${totalPercClass}" style="font-weight:800">${percGeral.toFixed(0)}%</td>
    </tr>`;
    
    html += `</tbody></table>
  <div class="footer">
    Esta página atualiza automaticamente a cada 2 minutos | Sistema Tutts
  </div>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('❌ Erro ao gerar página pública:', err);
    res.status(500).send('Erro ao gerar página');
  }
});

  return router;
}

module.exports = { createDisponibilidadeRouter };
