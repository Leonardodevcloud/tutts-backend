/**
 * Config Sub-Router: Promoções Novatos + Inscrições + Quiz
 *
 * 🆕 2026-05 — Mudanças nesta versão:
 *   1. CRM como source primária de região (crm_leads_capturados.regiao) com fallback
 *      pra planilha Google Sheets legada. Resolve bug "promoções aparecem pra todo
 *      mundo" — motoboys ausentes da planilha caíam em `userRegiao = null` e
 *      `if (userRegiao)` falhava silenciosamente, deixando passar TODAS promoções.
 *   2. Migration idempotente das colunas `dica1..dica5` (TEXT) na
 *      `quiz_procedimentos_config` — texto educativo que aparece pro motoboy errante
 *      na tela de resultado.
 *   3. GET /quiz-procedimentos/config retorna `dicas[]` agregadas.
 *   4. POST /quiz-procedimentos/config aceita `dicas[]`.
 *   5. Novo endpoint GET /quiz-procedimentos/kpis (respostas, aproveitamento, valor
 *      distribuído, pergunta mais errada) pra dashboard admin.
 */
const express = require('express');

// 🆕 Lookup robusto de região por cod_profissional.
// Ordem de prioridade:
//   1. crm_leads_capturados.regiao (source de verdade — alimentada pela
//      captura Playwright do módulo CRM, contém TODOS os motoboys cadastrados)
//   2. Planilha Google Sheets (legada — usada quando CRM falha por algum motivo)
// Retorna { regiao: string|null, fonte: 'crm'|'planilha'|null }
async function buscarRegiaoUsuario(pool, userCod) {
  // 1. CRM primeiro
  try {
    const result = await pool.query(
      `SELECT regiao FROM crm_leads_capturados
       WHERE TRIM(cod)::text = TRIM($1)::text
         AND regiao IS NOT NULL AND regiao <> ''
       LIMIT 1`,
      [userCod.toString()]
    );
    if (result.rows.length > 0 && result.rows[0].regiao) {
      return { regiao: result.rows[0].regiao.trim(), fonte: 'crm' };
    }
  } catch (e) {
    console.log('⚠️ [novatos] CRM lookup falhou:', e.message);
  }

  // 2. Fallback planilha legada (mantém compat — alguns motoboys antigos podem
  // não estar no CRM ainda dependendo de quando o RPA rodou)
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    const sheetText = await sheetResponse.text();
    const sheetLines = sheetText.split('\n').slice(1);
    for (const line of sheetLines) {
      const cols = line.split(',');
      if (cols[0]?.trim() === userCod.toString()) {
        const cidade = cols[3]?.trim();
        if (cidade) return { regiao: cidade, fonte: 'planilha' };
      }
    }
  } catch (e) {
    console.log('⚠️ [novatos] Planilha fallback falhou:', e.message);
  }

  return { regiao: null, fonte: null };
}

// 🆕 Migration idempotente das colunas de dica (dica1..dica5) na quiz_procedimentos_config.
// E coluna `respostas` JSONB na quiz_procedimentos_respostas pra armazenar o array
// original (necessário pra calcular pergunta-mais-errada e pra tela de revisão do motoboy).
// Rodada uma vez no boot via initNovatosTables (exportado lá embaixo).
async function ensureDicasColumns(pool) {
  const alters = [
    'ALTER TABLE quiz_procedimentos_config ADD COLUMN IF NOT EXISTS dica1 TEXT',
    'ALTER TABLE quiz_procedimentos_config ADD COLUMN IF NOT EXISTS dica2 TEXT',
    'ALTER TABLE quiz_procedimentos_config ADD COLUMN IF NOT EXISTS dica3 TEXT',
    'ALTER TABLE quiz_procedimentos_config ADD COLUMN IF NOT EXISTS dica4 TEXT',
    'ALTER TABLE quiz_procedimentos_config ADD COLUMN IF NOT EXISTS dica5 TEXT',
    'ALTER TABLE quiz_procedimentos_respostas ADD COLUMN IF NOT EXISTS respostas JSONB',
  ];
  for (const sql of alters) {
    try { await pool.query(sql); } catch (e) { /* coluna ja existe */ }
  }
  console.log('✅ [novatos] Colunas dica1..dica5 + respostas JSONB verificadas');
}

function createNovatosRoutes(pool, verificarToken, verificarAdmin) {
  const router = express.Router();

  // Run migration once on first creation
  ensureDicasColumns(pool).catch(e => console.log('⚠️ ensureDicasColumns:', e.message));

router.get('/promocoes-novatos/regioes', async (req, res) => {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1); // pular header
    
    const regioes = new Set();
    lines.forEach(line => {
      const cols = line.split(',');
      const cidade = cols[3]?.trim(); // coluna Cidade (índice 3 = coluna D)
      if (cidade && cidade.length > 0 && cidade !== '') {
        regioes.add(cidade);
      }
    });
    
    res.json([...regioes].sort());
  } catch (err) {
    console.error('❌ Erro ao buscar regiões para novatos:', err);
    res.json([]);
  }
});

// Verificar elegibilidade do usuário para promoções novatos
// Regras: 
// 1. Deve haver promoção ativa para a região do usuário (região vem do CRM
//    como source primária; fallback pra planilha Google Sheets legada)
// 2. Usuário nunca realizou nenhuma corrida OU não realizou corrida nos últimos 10 dias
//
// 🆕 2026-05 FIX (bug "vaza pra todo mundo"):
//   Antes: se userRegiao === null (motoboy ausente da planilha defasada),
//   o filtro de região era pulado e TODAS promoções ativas eram devolvidas.
//   Agora: sem região → elegivel:false. CRM é a primária (alimentada pela
//   captura Playwright e contém TODOS os motoboys cadastrados).
router.get('/promocoes-novatos/elegibilidade/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;

    // 1. Buscar região (CRM > planilha)
    const { regiao: userRegiao, fonte: fonteRegiao } = await buscarRegiaoUsuario(pool, userCod);
    
    // 2. Verificar se há promoções ativas
    const promoResult = await pool.query(
      "SELECT * FROM promocoes_novatos WHERE status = 'ativa'"
    );
    
    if (promoResult.rows.length === 0) {
      return res.json({ 
        elegivel: false, 
        motivo: 'Nenhuma promoção ativa no momento',
        promocoes: [],
        userRegiao,
        fonteRegiao
      });
    }
    
    // 3. Verificar histórico de entregas
    // cod_prof na bi_entregas é INTEGER, userCod pode ser string
    const userCodNumerico = parseInt(userCod.toString().replace(/\D/g, ''), 10);
    
    const entregasResult = await pool.query(`
      SELECT 
        COUNT(*) as total_entregas,
        MAX(data_solicitado) as ultima_entrega
      FROM bi_entregas 
      WHERE cod_prof = $1
    `, [userCodNumerico]);
    
    const totalEntregas = parseInt(entregasResult.rows[0]?.total_entregas) || 0;
    const ultimaEntrega = entregasResult.rows[0]?.ultima_entrega;
    
    // Calcular dias desde a última entrega
    let diasSemEntrega = null;
    if (ultimaEntrega) {
      const hoje = new Date();
      const dataUltima = new Date(ultimaEntrega);
      diasSemEntrega = Math.floor((hoje - dataUltima) / (1000 * 60 * 60 * 24));
    }
    
    // Verificar elegibilidade:
    // - Nunca fez entrega (totalEntregas === 0) OU
    // - Não fez entrega nos últimos 10 dias (diasSemEntrega >= 10)
    const elegivelPorEntregas = totalEntregas === 0 || (diasSemEntrega !== null && diasSemEntrega >= 10);
    
    if (!elegivelPorEntregas) {
      return res.json({
        elegivel: false,
        motivo: `Você realizou entregas recentemente (última há ${diasSemEntrega} dias). Promoção disponível apenas para quem não fez entregas nos últimos 10 dias.`,
        promocoes: [],
        totalEntregas,
        diasSemEntrega,
        userRegiao,
        fonteRegiao
      });
    }
    
    // 🆕 2026-05 FIX (estrito): sem região identificada → não elegível.
    // Motoboy precisa estar no CRM (Playwright) ou na planilha legada pra
    // sabermos qual promoção mostrar. Antes, sem região, vazava tudo.
    if (!userRegiao) {
      return res.json({
        elegivel: false,
        motivo: 'Não conseguimos identificar sua região para selecionar promoções. Procure o suporte para concluir seu cadastro.',
        promocoes: [],
        totalEntregas,
        diasSemEntrega,
        userRegiao: null,
        fonteRegiao: null
      });
    }

    // Filtrar promoções por região do usuário
    const promocoesDisponiveis = promoResult.rows.filter(promo => {
      const regiaoPromo = (promo.regiao || '').toLowerCase().trim();
      const regiaoUser = userRegiao.toLowerCase().trim();
      
      // Compatível se:
      // - Região da promoção é igual à região do usuário
      // - Região da promoção contém a região do usuário (ou vice-versa)
      // - Região da promoção é "Todas", "Geral" ou vazia (atinge todo mundo)
      return regiaoPromo === regiaoUser ||
             regiaoPromo.includes(regiaoUser) || 
             regiaoUser.includes(regiaoPromo) ||
             regiaoPromo.includes('todas') || 
             regiaoPromo.includes('geral') ||
             regiaoPromo === '' ||
             !promo.regiao;
    });
    
    if (promocoesDisponiveis.length === 0) {
      return res.json({
        elegivel: false,
        motivo: `Não há promoções ativas para sua região (${userRegiao}).`,
        promocoes: [],
        totalEntregas,
        diasSemEntrega,
        userRegiao,
        fonteRegiao
      });
    }
    
    res.json({
      elegivel: true,
      motivo: totalEntregas === 0 
        ? 'Você é um novo profissional! Aproveite as promoções.' 
        : `Você não realiza entregas há ${diasSemEntrega} dias. Volte a entregar com bônus!`,
      promocoes: promocoesDisponiveis,
      totalEntregas,
      diasSemEntrega,
      userRegiao,
      fonteRegiao
    });
    
  } catch (error) {
    console.error('❌ Erro ao verificar elegibilidade novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar todas as promoções de novatos
router.get('/promocoes-novatos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promocoes_novatos ORDER BY created_at DESC'
    );
    
    // Buscar clientes vinculados para cada promoção
    const promocoesComClientes = await Promise.all(result.rows.map(async (promo) => {
      const clientesResult = await pool.query(
        'SELECT * FROM promocoes_novatos_clientes WHERE promocao_id = $1',
        [promo.id]
      );
      return {
        ...promo,
        clientes_vinculados: clientesResult.rows
      };
    }));
    
    res.json(promocoesComClientes);
  } catch (error) {
    console.error('❌ Erro ao listar promoções novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar promoções ativas (para usuários)
router.get('/promocoes-novatos/ativas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promocoes_novatos WHERE status = 'ativa' ORDER BY created_at DESC"
    );
    
    // Buscar clientes vinculados para cada promoção
    const promocoesComClientes = await Promise.all(result.rows.map(async (promo) => {
      const clientesResult = await pool.query(
        'SELECT * FROM promocoes_novatos_clientes WHERE promocao_id = $1',
        [promo.id]
      );
      return {
        ...promo,
        clientes_vinculados: clientesResult.rows
      };
    }));
    
    res.json(promocoesComClientes);
  } catch (error) {
    console.error('❌ Erro ao listar promoções ativas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar nova promoção novatos
router.post('/promocoes-novatos', async (req, res) => {
  try {
    const { regiao, apelido, clientes, valor_bonus, detalhes, quantidade_entregas, created_by } = req.body;
    
    // Validar que tem pelo menos um cliente selecionado
    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos um cliente' });
    }

    // Criar a promoção (usando apelido como "cliente" para manter compatibilidade)
    const result = await pool.query(
      `INSERT INTO promocoes_novatos (regiao, cliente, apelido, valor_bonus, detalhes, quantidade_entregas, status, created_by, created_at) 
       VALUES ($1, $2, $2, $3, $4, $5, 'ativa', $6, NOW()) 
       RETURNING *`,
      [regiao, apelido, valor_bonus, detalhes || null, quantidade_entregas || 50, created_by || 'Admin']
    );
    
    const promocaoId = result.rows[0].id;
    
    // Inserir os clientes vinculados
    for (const cliente of clientes) {
      await pool.query(
        `INSERT INTO promocoes_novatos_clientes (promocao_id, cod_cliente, nome_cliente) 
         VALUES ($1, $2, $3)
         ON CONFLICT (promocao_id, cod_cliente) DO NOTHING`,
        [promocaoId, cliente.cod_cliente, cliente.nome_display || cliente.nome_cliente]
      );
    }
    
    // Buscar clientes inseridos
    const clientesResult = await pool.query(
      'SELECT * FROM promocoes_novatos_clientes WHERE promocao_id = $1',
      [promocaoId]
    );

    console.log('✅ Promoção novatos criada:', result.rows[0], 'Clientes:', clientesResult.rows.length);
    res.json({ ...result.rows[0], clientes_vinculados: clientesResult.rows });
  } catch (error) {
    console.error('❌ Erro ao criar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar promoção novatos (status ou dados)
router.patch('/promocoes-novatos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, regiao, apelido, clientes, valor_bonus, detalhes, quantidade_entregas } = req.body;

    let result;
    if (status && !regiao) {
      // Apenas atualizar status
      result = await pool.query(
        'UPDATE promocoes_novatos SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      // Atualizar todos os campos
      result = await pool.query(
        `UPDATE promocoes_novatos SET 
         regiao = COALESCE($1, regiao), 
         cliente = COALESCE($2, cliente),
         apelido = COALESCE($2, apelido), 
         valor_bonus = COALESCE($3, valor_bonus), 
         detalhes = $4, 
         quantidade_entregas = COALESCE($5, quantidade_entregas), 
         updated_at = NOW() 
         WHERE id = $6 RETURNING *`,
        [regiao, apelido, valor_bonus, detalhes, quantidade_entregas, id]
      );
      
      // Se tiver clientes, atualizar a tabela de clientes vinculados
      if (clientes && Array.isArray(clientes) && clientes.length > 0) {
        // Remover clientes antigos
        await pool.query('DELETE FROM promocoes_novatos_clientes WHERE promocao_id = $1', [id]);
        
        // Inserir novos clientes
        for (const cliente of clientes) {
          await pool.query(
            `INSERT INTO promocoes_novatos_clientes (promocao_id, cod_cliente, nome_cliente) 
             VALUES ($1, $2, $3)
             ON CONFLICT (promocao_id, cod_cliente) DO NOTHING`,
            [id, cliente.cod_cliente, cliente.nome_display || cliente.nome_cliente]
          );
        }
      }
    }

    // Buscar clientes vinculados
    const clientesResult = await pool.query(
      'SELECT * FROM promocoes_novatos_clientes WHERE promocao_id = $1',
      [id]
    );

    console.log('✅ Promoção novatos atualizada:', result.rows[0]);
    res.json({ ...result.rows[0], clientes_vinculados: clientesResult.rows });
  } catch (error) {
    console.error('❌ Erro ao atualizar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar promoção novatos
router.delete('/promocoes-novatos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se tem inscrições pendentes
    const inscricoes = await pool.query(
      "SELECT COUNT(*) FROM inscricoes_novatos WHERE promocao_id = $1 AND status = 'pendente'",
      [id]
    );
    
    if (parseInt(inscricoes.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Não é possível deletar promoção com inscrições pendentes' });
    }

    const result = await pool.query(
      'DELETE FROM promocoes_novatos WHERE id = $1 RETURNING *',
      [id]
    );

    console.log('🗑️ Promoção novatos deletada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao deletar promoção novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INSCRIÇÕES NOVATOS
// ============================================

// Listar todas as inscrições (admin)
router.get('/inscricoes-novatos', async (req, res) => {
  try {
    // Buscar inscrições com dados da promoção
    const result = await pool.query(`
      SELECT i.*, p.quantidade_entregas as meta_entregas
      FROM inscricoes_novatos i
      LEFT JOIN promocoes_novatos p ON i.promocao_id = p.id
      ORDER BY i.created_at DESC
    `);
    
    // Calcular progresso de cada inscrição
    const inscricoesComProgresso = await Promise.all(result.rows.map(async (inscricao) => {
      const userCodNumerico = parseInt(inscricao.user_cod.toString().replace(/\D/g, ''), 10);
      const dataInscricao = new Date(inscricao.created_at);
      const dataExpiracao = inscricao.expires_at ? new Date(inscricao.expires_at) : null;
      const metaEntregas = inscricao.meta_entregas || 50;
      
      // Buscar clientes vinculados à promoção
      const clientesResult = await pool.query(
        'SELECT cod_cliente FROM promocoes_novatos_clientes WHERE promocao_id = $1',
        [inscricao.promocao_id]
      );
      const clientesVinculados = clientesResult.rows.map(c => c.cod_cliente);
      
      let totalEntregas = 0;
      
      // Só conta entregas se tiver clientes vinculados à promoção
      if (clientesVinculados.length > 0) {
        // Buscar entregas no período, filtrando pelos clientes da promoção
        const query = `
          SELECT COUNT(*) as total
          FROM bi_entregas 
          WHERE cod_prof = $1 
            AND data_solicitado >= $2::date
            AND data_solicitado <= $3::date
            AND (status IS NULL OR status NOT IN ('cancelado', 'cancelada'))
            AND cod_cliente = ANY($4::int[])
        `;
        
        const dataFim = dataExpiracao ? dataExpiracao.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
        const params = [userCodNumerico, dataInscricao.toISOString().split('T')[0], dataFim, clientesVinculados];
        
        const entregasResult = await pool.query(query, params);
        totalEntregas = parseInt(entregasResult.rows[0]?.total) || 0;
      }
      
      const percentual = Math.min(100, Math.round((totalEntregas / metaEntregas) * 100));
      const metaAtingida = totalEntregas >= metaEntregas;
      
      return {
        ...inscricao,
        meta_entregas: metaEntregas,
        total_entregas: totalEntregas,
        percentual,
        meta_atingida: metaAtingida
      };
    }));
    
    res.json(inscricoesComProgresso);
  } catch (error) {
    console.error('❌ Erro ao listar inscrições novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar inscrições de um usuário
router.get('/inscricoes-novatos/usuario/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar inscrições do usuário:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar inscrição novatos (usuário se inscreve)
router.post('/inscricoes-novatos', async (req, res) => {
  try {
    const { promocao_id, user_cod, user_name, valor_bonus, regiao, cliente } = req.body;

    // Verificar se já está inscrito nesta promoção
    const existing = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE promocao_id = $1 AND LOWER(user_cod) = LOWER($2)',
      [promocao_id, user_cod]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Você já está inscrito nesta promoção' });
    }

    // Criar inscrição com expiração em 10 dias
    const result = await pool.query(
      `INSERT INTO inscricoes_novatos (promocao_id, user_cod, user_name, valor_bonus, regiao, cliente, status, created_at, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente', NOW(), NOW() + INTERVAL '15 days') 
       RETURNING *`,
      [promocao_id, user_cod, user_name, valor_bonus, regiao, cliente]
    );

    console.log('✅ Inscrição novatos criada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Aprovar inscrição novatos
router.patch('/inscricoes-novatos/:id/aprovar', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'aprovada', resolved_at = NOW(), resolved_by = $1 
       WHERE id = $2 
       RETURNING *`,
      [resolved_by || 'Admin', id]
    );

    console.log('✅ Inscrição novatos aprovada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao aprovar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rejeitar inscrição novatos
router.patch('/inscricoes-novatos/:id/rejeitar', async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo_rejeicao, resolved_by } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'rejeitada', motivo_rejeicao = $1, resolved_at = NOW(), resolved_by = $2 
       WHERE id = $3 
       RETURNING *`,
      [motivo_rejeicao, resolved_by || 'Admin', id]
    );

    console.log('❌ Inscrição novatos rejeitada:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao rejeitar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar crédito lançado para inscrição novatos
router.patch('/inscricoes-novatos/:id/credito', async (req, res) => {
  try {
    const { id } = req.params;
    const { credito_lancado, lancado_por } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET credito_lancado = $1, lancado_por = $2, lancado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [credito_lancado, lancado_por, credito_lancado ? new Date() : null, id]
    );

    console.log('💰 Crédito novatos atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar crédito novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar inscrição novatos
router.delete('/inscricoes-novatos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM inscricoes_novatos WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Inscrição não encontrada' });
    }

    console.log('🗑️ Inscrição novatos deletada:', result.rows[0]);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar inscrição novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar e expirar inscrições novatos antigas (chamado periodicamente)
router.post('/inscricoes-novatos/verificar-expiradas', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET status = 'expirada' 
       WHERE status = 'pendente' AND expires_at < NOW() 
       RETURNING *`
    );

    console.log(`⏰ ${result.rows.length} inscrições novatos expiradas`);
    res.json({ expiradas: result.rows.length, inscricoes: result.rows });
  } catch (error) {
    console.error('❌ Erro ao verificar expiradas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar débito para inscrição novatos
router.patch('/inscricoes-novatos/:id/debito', async (req, res) => {
  try {
    const { id } = req.params;
    const { debito, debitado_por } = req.body;

    const result = await pool.query(
      `UPDATE inscricoes_novatos 
       SET debito = $1, debitado_por = $2, debitado_at = $3 
       WHERE id = $4 
       RETURNING *`,
      [debito, debitado_por, debito ? new Date() : null, id]
    );

    console.log('💳 Débito novatos atualizado:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar débito novatos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Buscar entregas do profissional no período da inscrição (integração com BI)
router.get('/inscricoes-novatos/:id/entregas', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar dados da inscrição
    const inscricaoResult = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE id = $1',
      [id]
    );
    
    if (inscricaoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Inscrição não encontrada' });
    }
    
    const inscricao = inscricaoResult.rows[0];
    const userCod = parseInt(inscricao.user_cod.toString().replace(/\D/g, ''), 10);
    const dataInscricao = new Date(inscricao.created_at);
    const dataExpiracao = new Date(inscricao.expires_at);
    
    // Buscar a meta de entregas da promoção
    const promoResult = await pool.query(
      'SELECT quantidade_entregas FROM promocoes_novatos WHERE id = $1',
      [inscricao.promocao_id]
    );
    const metaEntregas = promoResult.rows[0]?.quantidade_entregas || 50;
    
    // Buscar clientes vinculados à promoção
    const clientesResult = await pool.query(
      'SELECT cod_cliente FROM promocoes_novatos_clientes WHERE promocao_id = $1',
      [inscricao.promocao_id]
    );
    const clientesVinculados = clientesResult.rows.map(c => c.cod_cliente);
    
    let entregas = [];
    
    // Só busca entregas se tiver clientes vinculados à promoção
    if (clientesVinculados.length > 0) {
      // Buscar entregas do profissional no período, filtrando pelos clientes da promoção
      const query = `
        SELECT 
          os,
          cod_cliente,
          data_solicitado,
          hora_solicitado,
          COALESCE(nome_fantasia, nome_cliente) as nome_cliente,
          cidade,
          bairro,
          valor_prof,
          status
        FROM bi_entregas 
        WHERE cod_prof = $1 
          AND data_solicitado >= $2::date
          AND data_solicitado <= $3::date
          AND (status IS NULL OR status NOT IN ('cancelado', 'cancelada'))
          AND cod_cliente = ANY($4::int[])
        ORDER BY data_solicitado DESC, hora_solicitado DESC
      `;
      
      const params = [userCod, dataInscricao.toISOString().split('T')[0], dataExpiracao.toISOString().split('T')[0], clientesVinculados];
      
      const entregasResult = await pool.query(query, params);
      entregas = entregasResult.rows;
    }
    
    const totalEntregas = entregas.length;
    const percentual = Math.min(100, Math.round((totalEntregas / metaEntregas) * 100));
    const metaAtingida = totalEntregas >= metaEntregas;
    
    console.log(`📊 Entregas da inscrição ${id}: ${totalEntregas}/${metaEntregas} (${percentual}%) - Clientes: ${clientesVinculados.join(',')}`);
    
    res.json({
      inscricao_id: parseInt(id),
      user_cod: inscricao.user_cod,
      data_inscricao: dataInscricao,
      data_expiracao: dataExpiracao,
      meta_entregas: metaEntregas,
      total_entregas: totalEntregas,
      percentual,
      meta_atingida: metaAtingida,
      clientes_vinculados: clientesVinculados,
      entregas
    });
  } catch (error) {
    console.error('❌ Erro ao buscar entregas da inscrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// Buscar progresso de todas as inscrições de um usuário
router.get('/inscricoes-novatos/progresso/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const userCodNumerico = parseInt(userCod.toString().replace(/\D/g, ''), 10);
    
    // Buscar todas as inscrições pendentes do usuário
    const inscricoesResult = await pool.query(`
      SELECT i.*, p.quantidade_entregas as meta_entregas
      FROM inscricoes_novatos i
      LEFT JOIN promocoes_novatos p ON i.promocao_id = p.id
      WHERE LOWER(i.user_cod) = LOWER($1)
      ORDER BY i.created_at DESC
    `, [userCod]);
    
    const progressos = await Promise.all(inscricoesResult.rows.map(async (inscricao) => {
      const dataInscricao = new Date(inscricao.created_at);
      const dataExpiracao = new Date(inscricao.expires_at);
      const metaEntregas = inscricao.meta_entregas || 50;
      
      // Buscar clientes vinculados à promoção
      const clientesResult = await pool.query(
        'SELECT cod_cliente FROM promocoes_novatos_clientes WHERE promocao_id = $1',
        [inscricao.promocao_id]
      );
      const clientesVinculados = clientesResult.rows.map(c => c.cod_cliente);
      
      let totalEntregas = 0;
      
      // Só conta entregas se tiver clientes vinculados à promoção
      if (clientesVinculados.length > 0) {
        const query = `
          SELECT COUNT(*) as total
          FROM bi_entregas 
          WHERE cod_prof = $1 
            AND data_solicitado >= $2::date
            AND data_solicitado <= $3::date
            AND (status IS NULL OR status NOT IN ('cancelado', 'cancelada'))
            AND cod_cliente = ANY($4::int[])
        `;
        
        const params = [userCodNumerico, dataInscricao.toISOString().split('T')[0], dataExpiracao.toISOString().split('T')[0], clientesVinculados];
        
        const entregasResult = await pool.query(query, params);
        totalEntregas = parseInt(entregasResult.rows[0]?.total) || 0;
      }
      
      const percentual = Math.min(100, Math.round((totalEntregas / metaEntregas) * 100));
      
      return {
        inscricao_id: inscricao.id,
        promocao_id: inscricao.promocao_id,
        status: inscricao.status,
        regiao: inscricao.regiao,
        cliente: inscricao.cliente,
        valor_bonus: inscricao.valor_bonus,
        data_inscricao: dataInscricao,
        data_expiracao: dataExpiracao,
        meta_entregas: metaEntregas,
        total_entregas: totalEntregas,
        percentual,
        meta_atingida: totalEntregas >= metaEntregas,
        clientes_vinculados: clientesVinculados
      };
    }));
    
    console.log(`📊 Progresso de ${userCod}: ${progressos.length} inscrições`);
    res.json(progressos);
  } catch (error) {
    console.error('❌ Erro ao buscar progresso:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// QUIZ DE PROCEDIMENTOS (Promoção Novato)
// ============================================

// Obter configuração do quiz
router.get('/quiz-procedimentos/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) {
      // Retorna config padrão vazia
      return res.json({
        titulo: 'Acerte os procedimentos e ganhe saque gratuito de R$ 500,00',
        imagens: [null, null, null, null],
        perguntas: [
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true },
          { texto: '', resposta: true }
        ],
        // 🆕 2026-05 — dicas educativas que aparecem na revisão pós-quiz
        // pra quem errar (e na entrada na tela "Aprender" também)
        dicas: ['', '', '', '', ''],
        valor_gratuidade: 500.00,
        ativo: false
      });
    }
    const config = result.rows[0];
    res.json({
      id: config.id,
      titulo: config.titulo,
      imagens: [config.imagem1, config.imagem2, config.imagem3, config.imagem4],
      perguntas: [
        { texto: config.pergunta1, resposta: config.resposta1 },
        { texto: config.pergunta2, resposta: config.resposta2 },
        { texto: config.pergunta3, resposta: config.resposta3 },
        { texto: config.pergunta4, resposta: config.resposta4 },
        { texto: config.pergunta5, resposta: config.resposta5 }
      ],
      // 🆕 2026-05 — array paralelo ao de perguntas
      dicas: [
        config.dica1 || '',
        config.dica2 || '',
        config.dica3 || '',
        config.dica4 || '',
        config.dica5 || ''
      ],
      valor_gratuidade: parseFloat(config.valor_gratuidade),
      ativo: config.ativo
    });
  } catch (error) {
    console.error('❌ Erro ao obter config quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Salvar configuração do quiz
router.post('/quiz-procedimentos/config', async (req, res) => {
  try {
    // 🆕 2026-05 — `dicas` é opcional pra backward-compat com frontends antigos
    const { titulo, imagens, perguntas, dicas, valor_gratuidade, ativo } = req.body;
    const safeDicas = Array.isArray(dicas) ? dicas : ['', '', '', '', ''];
    while (safeDicas.length < 5) safeDicas.push('');

    // Verificar se já existe config
    const existing = await pool.query('SELECT id FROM quiz_procedimentos_config LIMIT 1');
    
    if (existing.rows.length > 0) {
      // Atualizar
      await pool.query(
        `UPDATE quiz_procedimentos_config SET 
          titulo = $1,
          imagem1 = $2, imagem2 = $3, imagem3 = $4, imagem4 = $5,
          pergunta1 = $6, resposta1 = $7,
          pergunta2 = $8, resposta2 = $9,
          pergunta3 = $10, resposta3 = $11,
          pergunta4 = $12, resposta4 = $13,
          pergunta5 = $14, resposta5 = $15,
          valor_gratuidade = $16, ativo = $17,
          dica1 = $18, dica2 = $19, dica3 = $20, dica4 = $21, dica5 = $22,
          updated_at = NOW()
        WHERE id = $23`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo,
          safeDicas[0], safeDicas[1], safeDicas[2], safeDicas[3], safeDicas[4],
          existing.rows[0].id
        ]
      );
    } else {
      // Inserir
      await pool.query(
        `INSERT INTO quiz_procedimentos_config 
          (titulo, imagem1, imagem2, imagem3, imagem4, 
           pergunta1, resposta1, pergunta2, resposta2, pergunta3, resposta3,
           pergunta4, resposta4, pergunta5, resposta5, valor_gratuidade, ativo,
           dica1, dica2, dica3, dica4, dica5)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo,
          safeDicas[0], safeDicas[1], safeDicas[2], safeDicas[3], safeDicas[4]
        ]
      );
    }
    
    console.log('✅ Config quiz salva');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar config quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🆕 2026-05 — KPIs do quiz pra dashboard admin.
// Retorna: total de respostas, % aproveitamento (passou/total), valor distribuído,
// número da pergunta mais errada (1-5, ou null se não houver dados).
router.get('/quiz-procedimentos/kpis', async (req, res) => {
  try {
    const totalResult = await pool.query(`
      SELECT 
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE passou = true)::int as passou,
        COALESCE(SUM(CASE WHEN passou THEN (SELECT valor_gratuidade FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1) ELSE 0 END), 0)::numeric as valor_distribuido
      FROM quiz_procedimentos_respostas
    `);
    const { total, passou, valor_distribuido } = totalResult.rows[0];
    const aproveitamento = total > 0 ? Math.round((passou / total) * 100) : 0;

    // Pergunta mais errada — assume que `respostas` está armazenada como JSON
    // (array de booleans) e a config tem as respostas corretas resposta1..5.
    // Conta os errados por índice.
    let perguntaMaisErrada = null;
    try {
      const erros = await pool.query(`
        WITH cfg AS (SELECT resposta1, resposta2, resposta3, resposta4, resposta5 FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1),
        r AS (
          SELECT respostas FROM quiz_procedimentos_respostas WHERE respostas IS NOT NULL
        )
        SELECT
          SUM(CASE WHEN (respostas->>0)::boolean IS DISTINCT FROM cfg.resposta1 THEN 1 ELSE 0 END)::int AS e1,
          SUM(CASE WHEN (respostas->>1)::boolean IS DISTINCT FROM cfg.resposta2 THEN 1 ELSE 0 END)::int AS e2,
          SUM(CASE WHEN (respostas->>2)::boolean IS DISTINCT FROM cfg.resposta3 THEN 1 ELSE 0 END)::int AS e3,
          SUM(CASE WHEN (respostas->>3)::boolean IS DISTINCT FROM cfg.resposta4 THEN 1 ELSE 0 END)::int AS e4,
          SUM(CASE WHEN (respostas->>4)::boolean IS DISTINCT FROM cfg.resposta5 THEN 1 ELSE 0 END)::int AS e5
        FROM r, cfg
      `);
      const row = erros.rows[0] || {};
      const counts = [row.e1 || 0, row.e2 || 0, row.e3 || 0, row.e4 || 0, row.e5 || 0];
      const maxErros = Math.max(...counts);
      if (maxErros > 0) {
        perguntaMaisErrada = counts.indexOf(maxErros) + 1;
      }
    } catch (e) {
      // Se respostas não for JSON ou houver erro, deixa null
      console.log('⚠️ [novatos] pergunta+errada calc falhou (ok pra ignorar):', e.message);
    }

    res.json({
      total,
      passou,
      aproveitamento,
      valor_distribuido: parseFloat(valor_distribuido),
      pergunta_mais_errada: perguntaMaisErrada
    });
  } catch (error) {
    console.error('❌ Erro KPIs quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar se usuário já respondeu o quiz
router.get('/quiz-procedimentos/verificar/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [userCod]
    );
    res.json({ 
      ja_respondeu: result.rows.length > 0,
      dados: result.rows[0] || null
    });
  } catch (error) {
    console.error('❌ Erro ao verificar quiz:', error);
    res.json({ ja_respondeu: false });
  }
});

// Responder o quiz
router.post('/quiz-procedimentos/responder', async (req, res) => {
  try {
    const { user_cod, user_name, respostas } = req.body;
    
    // Verificar se já respondeu
    const existing = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas WHERE LOWER(user_cod) = LOWER($1)',
      [user_cod]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Você já respondeu este quiz' });
    }
    
    // Buscar config para verificar respostas corretas
    const configResult = await pool.query('SELECT * FROM quiz_procedimentos_config ORDER BY id DESC LIMIT 1');
    if (configResult.rows.length === 0) {
      return res.status(400).json({ error: 'Quiz não configurado' });
    }
    
    const config = configResult.rows[0];
    const respostasCorretas = [
      config.resposta1, config.resposta2, config.resposta3, config.resposta4, config.resposta5
    ];
    
    // Contar acertos + montar detalhe por pergunta (pra tela de revisão do motoboy)
    let acertos = 0;
    const detalheRespostas = [];
    for (let i = 0; i < 5; i++) {
      const correto = respostas[i] === respostasCorretas[i];
      if (correto) acertos++;
      detalheRespostas.push({
        indice: i,
        resposta_usuario: respostas[i],
        resposta_correta: respostasCorretas[i],
        correto
      });
    }
    
    const passou = acertos === 5;
    
    // Registrar resposta — 🆕 inclui array JSONB pra cálculo de KPI "+errada"
    // e exibição na tela de revisão.
    await pool.query(
      `INSERT INTO quiz_procedimentos_respostas (user_cod, user_name, acertos, passou, gratuidade_criada, respostas)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [user_cod, user_name, acertos, passou, passou, JSON.stringify(respostas)]
    );
    
    // Se passou, criar gratuidade automaticamente
    if (passou) {
      await pool.query(
        `INSERT INTO gratuities (user_cod, quantity, remaining, value, reason, status, created_at)
         VALUES ($1, 1, 1, $2, 'Promoção Novato', 'ativa', NOW())`,
        [user_cod, config.valor_gratuidade]
      );
      console.log(`🎉 Gratuidade criada para ${user_name} (${user_cod}): R$ ${config.valor_gratuidade}`);
    }
    
    res.json({ 
      success: true, 
      acertos, 
      passou,
      valor_gratuidade: passou ? parseFloat(config.valor_gratuidade) : 0,
      // 🆕 detalhe pergunta-a-pergunta + dicas pra tela de revisão educativa
      detalhe_respostas: detalheRespostas,
      dicas: [
        config.dica1 || '', config.dica2 || '', config.dica3 || '',
        config.dica4 || '', config.dica5 || ''
      ]
    });
  } catch (error) {
    console.error('❌ Erro ao responder quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar quem respondeu o quiz (admin)
router.get('/quiz-procedimentos/respostas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar respostas:', error);
    res.status(500).json({ error: error.message });
  }
});

  // ==================== RECRUTAMENTO ====================

// GET /api/recrutamento - Listar todas as necessidades

  return router;
}

module.exports = { createNovatosRoutes };
