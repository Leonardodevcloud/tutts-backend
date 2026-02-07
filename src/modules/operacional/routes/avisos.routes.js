function createAvisosRouter(pool) {
  const router = express.Router();

  // Listar todas as regiões (cidades) da planilha
  router.get('/regioes', async (req, res) => {
    try {
      const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
      const response = await fetch(sheetUrl);
      const text = await response.text();
      const lines = text.split('\n').slice(1); // pular header
      
      const regioes = new Set();
      lines.forEach(line => {
        const cols = line.split(',');
        const cidade = cols[3]?.trim(); // coluna Cidade
        if (cidade && cidade.length > 0 && cidade !== '') {
          regioes.add(cidade);
        }
      });
      
      res.json([...regioes].sort());
    } catch (err) {
      console.error('❌ Erro ao buscar regiões:', err);
      res.json([]);
    }
  });

  // Listar todos os avisos (para admin)
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT a.*, 
          (SELECT COUNT(*) FROM avisos_visualizacoes WHERE aviso_id = a.id) as total_visualizacoes
        FROM avisos a 
        ORDER BY created_at DESC
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar avisos:', err);
      res.json([]);
    }
  });

  // Criar novo aviso
  router.post('/', async (req, res) => {
    try {
      const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by } = req.body;
      
      const result = await pool.query(`
        INSERT INTO avisos (titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [titulo, regioes || [], todas_regioes || false, data_inicio, data_fim, recorrencia_tipo || 'uma_vez', recorrencia_intervalo || 0, imagem_url, created_by]);
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar aviso:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Atualizar aviso
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo } = req.body;
      
      const result = await pool.query(`
        UPDATE avisos 
        SET titulo = $1, regioes = $2, todas_regioes = $3, data_inicio = $4, data_fim = $5, 
            recorrencia_tipo = $6, recorrencia_intervalo = $7, imagem_url = $8, ativo = $9, updated_at = NOW()
        WHERE id = $10
        RETURNING *
      `, [titulo, regioes, todas_regioes, data_inicio, data_fim, recorrencia_tipo, recorrencia_intervalo, imagem_url, ativo, id]);
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar aviso:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Deletar aviso
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM avisos WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao deletar aviso:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Buscar avisos para um usuário específico (baseado na região)
  router.get('/usuario/:cod', async (req, res) => {
    try {
      const { cod } = req.params;
      
      // Buscar região do usuário na planilha
      const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
      const response = await fetch(sheetUrl);
      const text = await response.text();
      const lines = text.split('\n').slice(1);
      
      let userRegiao = null;
      for (const line of lines) {
        const cols = line.split(',');
        if (cols[0]?.trim() === cod) {
          userRegiao = cols[3]?.trim(); // coluna Cidade
          break;
        }
      }
      
      const now = new Date();
      
      // Buscar avisos ativos para a região do usuário
      const result = await pool.query(`
        SELECT a.* FROM avisos a
        WHERE a.ativo = true
          AND a.data_inicio <= $1
          AND a.data_fim >= $1
          AND (a.todas_regioes = true OR $2 = ANY(a.regioes) OR $2 IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM avisos_visualizacoes av 
            WHERE av.aviso_id = a.id AND av.user_cod = $3
            AND (
              a.recorrencia_tipo = 'uma_vez'
              OR (a.recorrencia_tipo = 'diario' AND av.visualizado_em > NOW() - INTERVAL '1 day')
              OR (a.recorrencia_tipo = 'intervalo_horas' AND av.visualizado_em > NOW() - (a.recorrencia_intervalo || ' hours')::INTERVAL)
            )
          )
        ORDER BY a.created_at DESC
        LIMIT 1
      `, [now, userRegiao, cod]);
      
      res.json(result.rows[0] || null);
    } catch (err) {
      console.error('❌ Erro ao buscar avisos do usuário:', err);
      res.json(null);
    }
  });

  // Marcar aviso como visualizado
  router.post('/:id/visualizar', async (req, res) => {
    try {
      const { id } = req.params;
      const { user_cod } = req.body;
      
      await pool.query(`
        INSERT INTO avisos_visualizacoes (aviso_id, user_cod, visualizado_em)
        VALUES ($1, $2, NOW())
        ON CONFLICT (aviso_id, user_cod) DO UPDATE SET visualizado_em = NOW()
      `, [id, user_cod]);
      
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao marcar visualização:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAvisosRouter };
