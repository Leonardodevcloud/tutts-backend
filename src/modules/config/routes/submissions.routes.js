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

// GET - Dashboard stats (LEVE - só contadores, 1 query)
router.get('/submissions/dashboard', verificarToken, async (req, res) => {
  try {
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
    if (!isAdmin) return res.status(403).json({ error: 'Acesso negado' });

    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE status = 'aprovado') as aprovados,
        COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitados,
        COUNT(*) FILTER (WHERE status = 'pendente' 
          AND created_at < NOW() - INTERVAL '24 hours'
          AND EXTRACT(DOW FROM created_at) BETWEEN 1 AND 5
          AND EXTRACT(HOUR FROM created_at) BETWEEN 9 AND 17
        ) as atrasadas,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as hoje_total,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND status != 'pendente') as hoje_processadas,
        COALESCE(AVG(
          CASE WHEN status != 'pendente' AND updated_at IS NOT NULL AND created_at IS NOT NULL
            AND EXTRACT(DOW FROM created_at) BETWEEN 1 AND 5
            AND EXTRACT(HOUR FROM created_at) BETWEEN 9 AND 17
          THEN EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600.0
          END
        ), 0) as tempo_medio_horas
      FROM submissions
    `);

    // Contagem por motivo (para gráfico)
    const motivos = await pool.query(`
      SELECT motivo, COUNT(*) as total
      FROM submissions
      GROUP BY motivo
      ORDER BY total DESC
    `);

    // OS atrasadas (para alerta) - só IDs
    const atrasadasOS = await pool.query(`
      SELECT ordem_servico
      FROM submissions
      WHERE status = 'pendente'
        AND created_at < NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
      LIMIT 10
    `);

    const stats = result.rows[0];
    res.json({
      total: parseInt(stats.total),
      pendentes: parseInt(stats.pendentes),
      aprovados: parseInt(stats.aprovados),
      rejeitados: parseInt(stats.rejeitados),
      atrasadas: parseInt(stats.atrasadas),
      hoje_total: parseInt(stats.hoje_total),
      hoje_processadas: parseInt(stats.hoje_processadas),
      tempo_medio_horas: parseFloat(stats.tempo_medio_horas),
      motivos: motivos.rows,
      atrasadas_os: atrasadasOS.rows.map(r => r.ordem_servico)
    });
  } catch (error) {
    console.error('❌ Erro dashboard submissions:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET - Busca com filtros (paginado)
router.get('/submissions/busca', verificarToken, async (req, res) => {
  try {
    const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
    const { q, status, periodo, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let conditions = [];
    let params = [];
    let paramIdx = 1;

    if (!isAdmin) {
      conditions.push(`user_cod = $${paramIdx++}`);
      params.push(req.user.codProfissional);
    }

    if (q && q.trim()) {
      conditions.push(`(ordem_servico ILIKE $${paramIdx} OR user_cod ILIKE $${paramIdx} OR user_name ILIKE $${paramIdx})`);
      params.push(`%${q.trim()}%`);
      paramIdx++;
    }

    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }

    if (periodo === 'today') {
      conditions.push(`created_at >= CURRENT_DATE`);
    } else if (periodo === 'week') {
      conditions.push(`created_at >= CURRENT_DATE - INTERVAL '7 days'`);
    } else if (periodo === 'month') {
      conditions.push(`created_at >= CURRENT_DATE - INTERVAL '30 days'`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM submissions ${where}`, params
    );

    const dataResult = await pool.query(`
      SELECT 
        id, ordem_servico, motivo, status, 
        user_id, user_cod, user_name,
        CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
        observacao, validated_by, validated_by_name,
        created_at, updated_at
      FROM submissions ${where}
      ORDER BY created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx}
    `, [...params, parseInt(limit), offset]);

    res.json({
      submissions: dataResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('❌ Erro busca submissions:', error);
    res.status(500).json({ error: 'Erro interno' });
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
          coordenadas, observacao,
          validated_by, validated_by_name,
          created_at, updated_at
        FROM submissions 
        ORDER BY created_at DESC
        LIMIT 500
      `;
      params = [];
    } else {
      query = `
        SELECT 
          id, ordem_servico, motivo, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
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

// GET - Ranking de Retorno (aprovações agrupadas por profissional)
router.get('/submissions/ranking-retorno', verificarToken, async (req, res) => {
  try {
    const { periodo } = req.query;
    let dateFilter = '';
    if (periodo === 'today') dateFilter = `AND created_at >= CURRENT_DATE`;
    else if (periodo === 'week') dateFilter = `AND created_at >= CURRENT_DATE - INTERVAL '7 days'`;
    else if (periodo === 'month') dateFilter = `AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`;

    const result = await pool.query(`
      SELECT 
        user_cod, user_name,
        COUNT(*) as total,
        json_agg(json_build_object(
          'id', id, 'ordemServico', ordem_servico, 'created_at', created_at,
          'temImagem', CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END
        ) ORDER BY created_at DESC) as solicitacoes
      FROM submissions
      WHERE status = 'aprovado' AND motivo = 'Ajuste de Retorno' ${dateFilter}
      GROUP BY user_cod, user_name
      ORDER BY total DESC
    `);

    res.json({ ranking: result.rows });
  } catch (error) {
    console.error('❌ Erro ranking retorno:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET - Relatórios de submissões por mês/ano
router.get('/submissions/relatorios', verificarToken, async (req, res) => {
  try {
    const mes = parseInt(req.query.mes ?? new Date().getMonth());
    const ano = parseInt(req.query.ano ?? new Date().getFullYear());
    const mesSQL = mes + 1;

    const [statsRes, motivosRes, profRes, semanasRes, evolucaoRes, totalProfsRes] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovados,
          COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitados,
          COUNT(*) FILTER (WHERE status = 'pendente') as pendentes
        FROM submissions 
        WHERE EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2
      `, [mesSQL, ano]),
      pool.query(`
        SELECT motivo,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas,
          COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitadas,
          COUNT(*) FILTER (WHERE status = 'pendente') as pendentes
        FROM submissions
        WHERE EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2
        GROUP BY motivo ORDER BY total DESC
      `, [mesSQL, ano]),
      pool.query(`
        SELECT user_name as nome, user_cod as cod,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas,
          COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitadas
        FROM submissions
        WHERE EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2
        GROUP BY user_name, user_cod ORDER BY total DESC LIMIT 10
      `, [mesSQL, ano]),
      pool.query(`
        SELECT 
          CASE 
            WHEN EXTRACT(DAY FROM created_at) BETWEEN 1 AND 7 THEN 'Semana 1'
            WHEN EXTRACT(DAY FROM created_at) BETWEEN 8 AND 14 THEN 'Semana 2'
            WHEN EXTRACT(DAY FROM created_at) BETWEEN 15 AND 21 THEN 'Semana 3'
            ELSE 'Semana 4'
          END as semana,
          MIN(EXTRACT(DAY FROM created_at))::int as dia_inicio,
          MAX(EXTRACT(DAY FROM created_at))::int as dia_fim,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas
        FROM submissions
        WHERE EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2
        GROUP BY 1 ORDER BY MIN(EXTRACT(DAY FROM created_at))
      `, [mesSQL, ano]),
      pool.query(`
        SELECT 
          TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as label,
          EXTRACT(MONTH FROM created_at)::int as mes,
          EXTRACT(YEAR FROM created_at)::int as ano,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas
        FROM submissions
        WHERE created_at >= DATE_TRUNC('month', make_date($2, $1, 1)) - INTERVAL '5 months'
          AND created_at < DATE_TRUNC('month', make_date($2, $1, 1)) + INTERVAL '1 month'
        GROUP BY 1, 2, 3
        ORDER BY ano, mes
      `, [mesSQL, ano]),
      pool.query(`SELECT COUNT(DISTINCT user_cod) as total FROM submissions`)
    ]);

    const stats = statsRes.rows[0];
    const mesAnterior = evolucaoRes.rows.find(r => {
      const mAnt = mesSQL === 1 ? 12 : mesSQL - 1;
      const aAnt = mesSQL === 1 ? ano - 1 : ano;
      return r.mes === mAnt && r.ano === aAnt;
    });

    res.json({
      total: parseInt(stats.total),
      aprovados: parseInt(stats.aprovados),
      rejeitados: parseInt(stats.rejeitados),
      pendentes: parseInt(stats.pendentes),
      taxaAprovacao: stats.total > 0 ? (stats.aprovados / stats.total * 100).toFixed(1) : '0.0',
      taxaRejeicao: stats.total > 0 ? (stats.rejeitados / stats.total * 100).toFixed(1) : '0.0',
      totalProfissionais: parseInt(totalProfsRes.rows[0].total),
      mediaPorProfissional: totalProfsRes.rows[0].total > 0 
        ? (stats.total / totalProfsRes.rows[0].total).toFixed(1) : '0.0',
      motivos: motivosRes.rows.reduce((acc, r) => { 
        acc[r.motivo || 'Outros'] = { total: parseInt(r.total), aprovadas: parseInt(r.aprovadas), rejeitadas: parseInt(r.rejeitadas), pendentes: parseInt(r.pendentes) }; 
        return acc; 
      }, {}),
      topProfissionais: profRes.rows.map(r => ({
        nome: r.nome, cod: r.cod,
        total: parseInt(r.total), aprovadas: parseInt(r.aprovadas), rejeitadas: parseInt(r.rejeitadas),
        taxa: r.total > 0 ? (r.aprovadas / r.total * 100).toFixed(0) : '0'
      })),
      semanas: semanasRes.rows.map(r => ({
        label: r.semana, dias: [r.dia_inicio, r.dia_fim],
        total: parseInt(r.total), aprovadas: parseInt(r.aprovadas)
      })),
      evolucao: evolucaoRes.rows.map(r => ({
        label: r.label, total: parseInt(r.total), aprovadas: parseInt(r.aprovadas)
      })),
      mesAnteriorTotal: mesAnterior ? parseInt(mesAnterior.total) : 0,
      variacao: mesAnterior && mesAnterior.total > 0 
        ? ((stats.total - mesAnterior.total) / mesAnterior.total * 100).toFixed(1) : '0.0'
    });
  } catch (error) {
    console.error('❌ Erro relatórios submissions:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

  // ==================== HORÁRIOS + AVISOS ====================


  return router;
}

module.exports = { createSubmissionsRoutes };
