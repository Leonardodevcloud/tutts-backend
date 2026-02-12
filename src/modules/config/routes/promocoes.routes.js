/**
 * Config Sub-Router: Promoções + Indicações + Links
 */
const express = require('express');
const { gerarTokenIndicacao } = require('../config.service');
function createPromocoesRoutes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

router.get('/promocoes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promocoes_indicacao ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar promoções ativas (para usuário)
router.get('/promocoes/ativas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promocoes_indicacao WHERE status = 'ativa' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções ativas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar promoção
router.post('/promocoes', async (req, res) => {
  try {
    const { regiao, valor_bonus, detalhes, created_by } = req.body;

    console.log('📣 Criando promoção:', { regiao, valor_bonus, detalhes });

    const result = await pool.query(
      `INSERT INTO promocoes_indicacao (regiao, valor_bonus, detalhes, status, created_by, created_at) 
       VALUES ($1, $2, $3, 'ativa', $4, NOW()) 
       RETURNING *`,
      [regiao, valor_bonus, detalhes || null, created_by]
    );

    console.log('✅ Promoção criada:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar promoção (status ou dados completos)
router.patch('/promocoes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, regiao, valor_bonus, detalhes } = req.body;

    let result;
    
    // Se só veio status, atualiza só o status
    if (status && !regiao && !valor_bonus) {
      result = await pool.query(
        'UPDATE promocoes_indicacao SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      // Atualização completa
      result = await pool.query(
        'UPDATE promocoes_indicacao SET regiao = COALESCE($1, regiao), valor_bonus = COALESCE($2, valor_bonus), detalhes = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
        [regiao, valor_bonus, detalhes, id]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promoção não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// Excluir promoção
router.delete('/promocoes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM promocoes_indicacao WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promoção não encontrada' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir promoção:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INDICAÇÕES
// ============================================

// Listar todas as indicações (admin)
router.get('/indicacoes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM indicacoes ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar indicações do usuário
router.get('/indicacoes/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações do usuário:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar indicação
router.post('/indicacoes', async (req, res) => {
  try {
    const { promocao_id, user_cod, user_name, indicado_nome, indicado_cpf, indicado_contato, valor_bonus, regiao } = req.body;

    console.log('👥 Criando indicação:', { user_cod, indicado_nome });

    // Calcular data de expiração (30 dias)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const result = await pool.query(
      `INSERT INTO indicacoes (promocao_id, user_cod, user_name, indicado_nome, indicado_cpf, indicado_contato, valor_bonus, regiao, status, created_at, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW(), $9) 
       RETURNING *`,
      [promocao_id, user_cod, user_name, indicado_nome, indicado_cpf || null, indicado_contato, valor_bonus, regiao, expiresAt]
    );

    console.log('✅ Indicação criada:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aprovar indicação
router.patch('/indicacoes/:id/aprovar', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'aprovada', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING *`,
      [resolved_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('✅ Indicação aprovada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao aprovar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rejeitar indicação
router.patch('/indicacoes/:id/rejeitar', async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo_rejeicao, resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'rejeitada', motivo_rejeicao = $1, resolved_at = NOW(), resolved_by = $2 
       WHERE id = $3 
       RETURNING *`,
      [motivo_rejeicao, resolved_by, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('❌ Indicação rejeitada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao rejeitar indicação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar crédito lançado
router.patch('/indicacoes/:id/credito', async (req, res) => {
  try {
    const { id } = req.params;
    const { credito_lancado, lancado_por } = req.body;

    console.log('💰 Atualizando crédito:', { id, credito_lancado, lancado_por });

    const result = await pool.query(
      `UPDATE indicacoes 
       SET credito_lancado = $1, lancado_por = $2, lancado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [credito_lancado, credito_lancado ? lancado_por : null, credito_lancado ? new Date() : null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('✅ Crédito atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar crédito:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar e expirar indicações antigas (pode ser chamado periodicamente)
router.post('/indicacoes/verificar-expiradas', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE indicacoes 
       SET status = 'expirada' 
       WHERE status = 'pendente' AND expires_at < NOW() 
       RETURNING *`
    );

    console.log(`⏰ ${result.rows.length} indicações expiradas`);
    res.json({ expiradas: result.rows.length, indicacoes: result.rows });
  } catch (error) {
    console.error('❌ Erro ao verificar expiradas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar cadastro de indicados via API Tutts (prof-status)
router.post('/indicacoes/verificar-cadastros', async (req, res) => {
  try {
    const { celulares } = req.body; // array de strings: ["62993084022", "61985701631", ...]
    if (!celulares || !Array.isArray(celulares) || celulares.length === 0) {
      return res.status(400).json({ error: 'celulares é obrigatório (array)' });
    }

    const token = process.env.TUTTS_TOKEN_PROF_STATUS;
    if (!token) {
      console.warn('⚠️ TUTTS_TOKEN_PROF_STATUS não configurado');
      return res.status(503).json({ error: 'Token prof-status não configurado' });
    }

    // Limitar a 50 consultas por vez
    const lista = celulares.slice(0, 50);
    const resultados = {};

    // Consultar em paralelo (max 5 simultâneas)
    const chunks = [];
    for (let i = 0; i < lista.length; i += 5) {
      chunks.push(lista.slice(i, i + 5));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (cel) => {
        try {
          // Limpar número - só dígitos
          const celLimpo = cel.replace(/\D/g, '');
          if (!celLimpo || celLimpo.length < 10) {
            resultados[cel] = { cadastrado: false, erro: 'número inválido' };
            return;
          }

          // Formatar como (XX) XXXXX-XXXX
          let celFormatado = celLimpo;
          if (celLimpo.length === 11) {
            celFormatado = `(${celLimpo.slice(0,2)}) ${celLimpo.slice(2,7)}-${celLimpo.slice(7)}`;
          } else if (celLimpo.length === 10) {
            celFormatado = `(${celLimpo.slice(0,2)}) ${celLimpo.slice(2,6)}-${celLimpo.slice(6)}`;
          }

          const resp = await fetch('https://tutts.com.br/integracao', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
              'identificador': 'prof-status'
            },
            body: JSON.stringify({ celular: celFormatado })
          });

          const data = await resp.json();

          if (data.Sucesso && data.Sucesso.length > 0) {
            const prof = data.Sucesso[0];
            resultados[cel] = {
              cadastrado: true,
              nome: prof.nome,
              codigo: prof.codigo,
              ativo: prof.ativo === 'S',
              status: prof.status,
              dataCadastro: prof.dataCadastro,
              dataAtivacao: prof.dataAtivacao
            };
          } else {
            resultados[cel] = { cadastrado: false };
          }
        } catch (err) {
          console.error(`❌ Erro ao verificar ${cel}:`, err.message);
          resultados[cel] = { cadastrado: false, erro: err.message };
        }
      });

      await Promise.allSettled(promises);
    }

    res.json({ resultados });
  } catch (error) {
    console.error('❌ Erro verificar-cadastros:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NOVO SISTEMA DE LINKS DE INDICAÇÃO
// ============================================

// Gerar ou obter link de indicação do usuário
router.post('/indicacao-link/gerar', async (req, res) => {
  try {
    const { user_cod, user_name, promocao_id, regiao, valor_bonus } = req.body;
    
    if (!user_cod || !user_name) {
      return res.status(400).json({ error: 'user_cod e user_name são obrigatórios' });
    }
    
    // Gerar novo token único (sempre gera um novo para cada promoção)
    let token = gerarTokenIndicacao();
    let tentativas = 0;
    while (tentativas < 10) {
      const existe = await pool.query('SELECT id FROM indicacao_links WHERE token = $1', [token]);
      if (existe.rows.length === 0) break;
      token = gerarTokenIndicacao();
      tentativas++;
    }
    
    // Criar novo link com dados da promoção
    const result = await pool.query(
      `INSERT INTO indicacao_links (user_cod, user_name, token, promocao_id, regiao, valor_bonus) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user_cod, user_name, token, promocao_id || null, regiao || null, valor_bonus || null]
    );
    
    console.log('✅ Link de indicação gerado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao gerar link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter link existente do usuário
router.get('/indicacao-link/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacao_links WHERE LOWER(user_cod) = LOWER($1) AND active = TRUE',
      [userCod]
    );
    res.json(result.rows[0] || null);
  } catch (error) {
    console.error('❌ Erro ao buscar link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Validar token (público - para página de cadastro)
router.get('/indicacao-link/validar/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      'SELECT user_cod, user_name FROM indicacao_links WHERE token = $1 AND active = TRUE',
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }
    
    res.json({ valido: true, indicador: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao validar token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cadastrar indicado via link (público)
router.post('/indicacao-link/cadastrar', async (req, res) => {
  try {
    const { token, nome, telefone } = req.body;
    
    if (!token || !nome || !telefone) {
      return res.status(400).json({ error: 'Token, nome e telefone são obrigatórios' });
    }
    
    // Validar token e pegar dados da promoção
    const linkResult = await pool.query(
      'SELECT * FROM indicacao_links WHERE token = $1 AND active = TRUE',
      [token]
    );
    
    if (linkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }
    
    const link = linkResult.rows[0];
    
    // Verificar se este telefone já foi indicado por este usuário
    const jaIndicado = await pool.query(
      `SELECT id FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) AND indicado_contato = $2`,
      [link.user_cod, telefone]
    );
    
    if (jaIndicado.rows.length > 0) {
      return res.status(400).json({ error: 'Este telefone já foi indicado anteriormente' });
    }
    
    // Criar indicação com dados da promoção
    const result = await pool.query(
      `INSERT INTO indicacoes (user_cod, user_name, indicado_nome, indicado_contato, link_token, promocao_id, regiao, valor_bonus, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW()) RETURNING *`,
      [link.user_cod, link.user_name, nome, telefone, token, link.promocao_id, link.regiao, link.valor_bonus]
    );
    
    console.log('✅ Indicação via link cadastrada:', result.rows[0]);
    res.json({ success: true, indicacao: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao cadastrar indicado:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar indicações recebidas via link (para admin)
router.get('/indicacao-link/indicacoes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM indicacoes WHERE link_token IS NOT NULL ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações via link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Estatísticas de indicações por usuário
router.get('/indicacao-link/estatisticas/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'pendente' THEN 1 END) as pendentes,
        COUNT(CASE WHEN status = 'aprovada' THEN 1 END) as aprovadas,
        COUNT(CASE WHEN status = 'rejeitada' THEN 1 END) as rejeitadas
       FROM indicacoes 
       WHERE LOWER(user_cod) = LOWER($1) AND link_token IS NOT NULL`,
      [userCod]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROMOÇÕES NOVATOS
// ============================================

// Listar regiões disponíveis da planilha (para criar promoções)

  return router;
}

module.exports = { createPromocoesRoutes };
