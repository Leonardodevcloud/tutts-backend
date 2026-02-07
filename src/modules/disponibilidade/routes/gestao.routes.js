/**
 * Sub-Router: Gestão: Regiões, Lojas, Linhas, Faltosos, Em-Loja
 */
const express = require('express');

function createGestaoRoutes(pool) {
  const router = express.Router();

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

  return router;
}

module.exports = { createGestaoRoutes };
