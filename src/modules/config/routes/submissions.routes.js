/**
 * Config Sub-Router: Submissions (cadastros)
 */
const express = require('express');

function createSubmissionsRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

router.post('/submissions', verificarToken, async (req, res) => {
  try {
    const { ordemServico, motivo, imagemComprovante, imagens, coordenadas } = req.body;
    
    // SEGURANÇA: Usar dados do token JWT, não do body
    const userId = req.user.id;
    const userCod = req.user.codProfissional;
    const userName = req.user.nome;
    
    // Validação de entrada
    if (!ordemServico || ordemServico.length < 1 || ordemServico.length > 50) {
      return res.status(400).json({ error: 'Ordem de serviço inválida' });
    }
    if (!motivo || motivo.length < 1 || motivo.length > 1000) {
      return res.status(400).json({ error: 'Motivo inválido' });
    }
    
    const sanitizedOrdemServico = ordemServico.toString().trim().substring(0, 50);
    const sanitizedMotivo = motivo.toString().trim().substring(0, 1000);

    const result = await pool.query(
      `INSERT INTO submissions 
       (ordem_servico, motivo, status, user_id, user_cod, user_name, 
        imagem_comprovante, imagens, coordenadas, created_at) 
       VALUES ($1, $2, 'pendente', $3, $4, $5, $6, $7, $8, NOW()) 
       RETURNING *`,
      [sanitizedOrdemServico, sanitizedMotivo, userId, userCod, userName, imagemComprovante, imagens, coordenadas]
    );

    await registrarAuditoria(req, 'SUBMISSION_CREATE', AUDIT_CATEGORIES.DATA, 'submissions', result.rows[0].id, {
      ordem_servico: sanitizedOrdemServico
    });

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar submissão:', error);
    res.status(500).json({ error: 'Erro interno ao criar submissão' });
  }
});

// GET - Listar submissões (REQUER AUTENTICAÇÃO)
router.get('/submissions', verificarToken, async (req, res) => {
  try {
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
    
    let query;
    let params;
    
    if (isAdmin) {
      query = `
        SELECT 
          id, ordem_servico, motivo, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
          LENGTH(imagem_comprovante) as tamanho_imagem,
          coordenadas, observacao,
          validated_by, validated_by_name,
          created_at, updated_at
        FROM submissions 
        ORDER BY created_at DESC
        LIMIT 10000
      `;
      params = [];
    } else {
      query = `
        SELECT 
          id, ordem_servico, motivo, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
          LENGTH(imagem_comprovante) as tamanho_imagem,
          coordenadas, observacao,
          validated_by, validated_by_name,
          created_at, updated_at
        FROM submissions 
        WHERE user_cod = $1 
        ORDER BY created_at DESC
        LIMIT 2000
      `;
      params = [req.user.codProfissional];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar submissões:', error);
    res.status(500).json({ error: 'Erro interno ao listar submissões' });
  }
});

// GET - Buscar imagem de submissão (REQUER AUTENTICAÇÃO)
router.get('/submissions/:id/imagem', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const submissionId = parseInt(id);
    if (isNaN(submissionId) || submissionId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
    
    let query;
    let params;
    
    if (isAdmin) {
      query = 'SELECT imagem_comprovante FROM submissions WHERE id = $1';
      params = [submissionId];
    } else {
      query = 'SELECT imagem_comprovante FROM submissions WHERE id = $1 AND user_cod = $2';
      params = [submissionId, req.user.codProfissional];
    }
    
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    res.json({ imagem: result.rows[0].imagem_comprovante });
  } catch (error) {
    console.error('❌ Erro ao buscar imagem:', error);
    res.status(500).json({ error: 'Erro interno ao buscar imagem' });
  }
});

// PATCH - Atualizar submissão (APENAS ADMINS)
router.patch('/submissions/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, observacao } = req.body;
    
    const submissionId = parseInt(id);
    if (isNaN(submissionId) || submissionId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const validStatuses = ['pendente', 'aprovado', 'rejeitado', 'em_analise'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }
    
    const validatedBy = req.user.id;
    const validatedByName = req.user.nome;

    const result = await pool.query(
      `UPDATE submissions 
       SET status = $1, 
           observacao = $2, 
           validated_by = $3, 
           validated_by_name = $4, 
           updated_at = NOW() 
       WHERE id = $5 
       RETURNING *`,
      [status, (observacao || '').substring(0, 1000), validatedBy, validatedByName, submissionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    await registrarAuditoria(req, 'SUBMISSION_UPDATE', AUDIT_CATEGORIES.DATA, 'submissions', submissionId, {
      novo_status: status
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar submissão:', error);
    res.status(500).json({ error: 'Erro interno ao atualizar submissão' });
  }
});

// DELETE - Excluir submissão (APENAS ADMIN MASTER)
router.delete('/submissions/:id', verificarToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin_master') {
      await registrarAuditoria(req, 'SUBMISSION_DELETE_DENIED', AUDIT_CATEGORIES.DATA, 'submissions', req.params.id, {
        motivo: 'Permissão negada'
      }, 'denied');
      return res.status(403).json({ error: 'Apenas admin master pode excluir submissões' });
    }
    
    const { id } = req.params;
    const submissionId = parseInt(id);
    if (isNaN(submissionId) || submissionId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const existing = await pool.query('SELECT ordem_servico, user_cod FROM submissions WHERE id = $1', [submissionId]);
    
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Submissão não encontrada' });
    }

    const result = await pool.query(
      'DELETE FROM submissions WHERE id = $1 RETURNING *',
      [submissionId]
    );

    await registrarAuditoria(req, 'SUBMISSION_DELETE', AUDIT_CATEGORIES.DATA, 'submissions', submissionId, {
      ordem_servico: existing.rows[0].ordem_servico,
      user_cod_original: existing.rows[0].user_cod
    });

    res.json({ message: 'Submissão excluída com sucesso', deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao deletar submissão:', error);
    res.status(500).json({ error: 'Erro interno ao deletar submissão' });
  }
});

  // ==================== HORÁRIOS + AVISOS ====================


  return router;
}

module.exports = { createSubmissionsRoutes };
