/**
 * MÓDULO CONFIG - Routes
 * 69 endpoints: admin-permissions(3), submissions(5), horarios(6), avisos(4),
 *               notifications(2), promocoes(5), indicacoes(7), indicacao-link(6),
 *               promocoes-novatos(7), inscricoes-novatos(11), quiz(5), recrutamento(8)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { gerarTokenIndicacao } = require('./config.service');
const { createValidacaoIaRoutes } = require('./routes/validacao-ia.routes');
const { processarFotos } = require('../../shared/phash');

function createConfigRouter(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

  // 🔒 SECURITY FIX (CRIT-06): Rate limiter para endpoint público de indicação
  const indicacaoCadastroLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5,
    message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ==================== PERMISSÕES DE ADMIN ====================

// Listar todos os admins com permissões (APENAS ADMIN_MASTER)
router.get('/admin-permissions', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode ver/gerenciar permissões
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Acesso negado a admin-permissions por: ${req.user.codProfissional}`);
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode gerenciar permissões.' });
    }
    
    const result = await pool.query(`
      SELECT u.id, u.cod_profissional, u.full_name, u.role, 
             COALESCE(u.allowed_modules::text, '[]') as allowed_modules,
             COALESCE(u.allowed_tabs::text, '{}') as allowed_tabs,
             u.created_at
      FROM users u
      WHERE u.role IN ('admin', 'admin_financeiro')
      ORDER BY u.full_name
    `);
    
    // Parse JSON strings
    const rows = result.rows.map(row => {
      try {
        row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
        row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
      } catch (e) {
        row.allowed_modules = [];
        row.allowed_tabs = {};
      }
      return row;
    });
    
    res.json(rows);
  } catch (error) {
    console.error('❌ Erro ao listar permissões:', error);
    res.json([]);
  }
});

// Atualizar permissões de um admin (APENAS ADMIN_MASTER)
router.patch('/admin-permissions/:codProfissional', verificarToken, async (req, res) => {
  try {
    // CRÍTICO: Apenas admin_master pode alterar permissões
    if (req.user.role !== 'admin_master') {
      console.log(`⚠️ [SEGURANÇA] Tentativa não autorizada de alterar permissões por: ${req.user.codProfissional}`);
      await registrarAuditoria(req, 'PERMISSIONS_CHANGE_DENIED', AUDIT_CATEGORIES.ADMIN, 'users', req.params.codProfissional, {
        motivo: 'Usuário não é admin_master'
      }, 'failed');
      return res.status(403).json({ error: 'Acesso negado. Apenas Admin Master pode alterar permissões.' });
    }
    
    const { codProfissional } = req.params;
    const { allowed_modules, allowed_tabs } = req.body;
    
    // Garantir que são objetos válidos
    const modules = Array.isArray(allowed_modules) ? allowed_modules : [];
    const tabs = (allowed_tabs && typeof allowed_tabs === 'object') ? allowed_tabs : {};
    
    const result = await pool.query(`
      UPDATE users 
      SET allowed_modules = $1::jsonb, allowed_tabs = $2::jsonb
      WHERE LOWER(cod_profissional) = LOWER($3)
      RETURNING id, cod_profissional, full_name, role, allowed_modules, allowed_tabs
    `, [JSON.stringify(modules), JSON.stringify(tabs), codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'Usuário não encontrado', success: false });
    }
    
    // Registrar auditoria
    await registrarAuditoria(req, 'PERMISSIONS_CHANGE', AUDIT_CATEGORIES.ADMIN, 'users', result.rows[0].id, {
      cod_profissional: codProfissional,
      modulos: modules,
      alterado_por: req.user.codProfissional
    });
    
    console.log(`🔐 Permissões atualizadas: ${codProfissional} (por ${req.user.codProfissional})`);
    res.json({ message: 'Permissões atualizadas com sucesso', user: result.rows[0], success: true });
  } catch (error) {
    console.error('❌ Erro ao atualizar permissões:', error);
    res.json({ message: 'Erro ao atualizar', success: false, error: error.message });
  }
});

// Obter permissões de um admin específico (ADMIN_MASTER ou próprio usuário)
router.get('/admin-permissions/:codProfissional', verificarToken, async (req, res) => {
  try {
    const { codProfissional } = req.params;
    
    // Permitir acesso apenas para admin_master ou o próprio usuário consultando suas permissões
    if (req.user.role !== 'admin_master' && req.user.codProfissional.toLowerCase() !== codProfissional.toLowerCase()) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const result = await pool.query(`
      SELECT id, cod_profissional, full_name, role, 
             COALESCE(allowed_modules::text, '[]') as allowed_modules,
             COALESCE(allowed_tabs::text, '{}') as allowed_tabs
      FROM users
      WHERE LOWER(cod_profissional) = LOWER($1)
    `, [codProfissional]);
    
    if (result.rows.length === 0) {
      return res.json({ allowed_modules: [], allowed_tabs: {} });
    }
    
    // Parse JSON strings se necessário
    const row = result.rows[0];
    try {
      row.allowed_modules = typeof row.allowed_modules === 'string' ? JSON.parse(row.allowed_modules) : (row.allowed_modules || []);
      row.allowed_tabs = typeof row.allowed_tabs === 'string' ? JSON.parse(row.allowed_tabs) : (row.allowed_tabs || {});
    } catch (e) {
      row.allowed_modules = [];
      row.allowed_tabs = {};
    }
    
    res.json(row);
  } catch (error) {
    console.error('❌ Erro ao buscar permissões:', error);
    res.json({ allowed_modules: [], allowed_tabs: {} });
  }
});

  // ==================== SUBMISSÕES ====================

router.post('/submissions', verificarToken, async (req, res) => {
  try {
    const { ordemServico, motivo, subcategoria, imagemComprovante, imagens, coordenadas, validacao_ia, tentativas_foto } = req.body;
    
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

    // ── Anti-fraude: verificar fotos duplicadas via pHash ──
    const fotosParaVerificar = [];
    if (imagemComprovante && typeof imagemComprovante === 'string' && imagemComprovante.length > 100) {
      fotosParaVerificar.push(imagemComprovante);
    }
    let imagensArr2 = imagens;
    if (typeof imagens === 'string') { try { imagensArr2 = JSON.parse(imagens); } catch(e) { imagensArr2 = []; } }
    if (Array.isArray(imagensArr2)) {
      fotosParaVerificar.push(...imagensArr2.filter(img => img && typeof img === 'string' && img.length > 100));
    }
    console.log(`[pHash] POST /submissions | user=${userCod} | comprovante=${imagemComprovante ? imagemComprovante.length + 'ch' : 'null'} | imagens=${typeof imagens}/${Array.isArray(imagens)} | fotos=${fotosParaVerificar.length}`);
    if (fotosParaVerificar.length > 0) {
      try {
        const check = await processarFotos(pool, fotosParaVerificar, {
          user_cod: userCod, user_nome: userName, origem: 'submission', referencia_id: null,
        });
        console.log(`[pHash] Resultado: bloqueada=${check.bloqueada}`);
        if (check.bloqueada) {
          // Buscar OS da submissão original
          let osOriginal = '';
          let dataOriginal = check.detalhes?.data || '';
          if (check.detalhes?.referencia_id) {
            const orig = await pool.query('SELECT ordem_servico, created_at FROM submissions WHERE id = $1', [check.detalhes.referencia_id]).catch(() => ({ rows: [] }));
            if (orig.rows.length > 0) {
              osOriginal = orig.rows[0].ordem_servico || '';
              dataOriginal = new Date(orig.rows[0].created_at).toLocaleDateString('pt-BR');
            }
          }
          return res.status(400).json({
            error: 'foto_duplicada',
            os_original: osOriginal,
            data_original: dataOriginal,
            submission_id_original: check.detalhes?.referencia_id,
            foto_index: check.foto_index,
          });
        }
      } catch (hashErr) {
        console.error('[pHash] Erro (não-bloqueante):', hashErr.message);
      }
    }

    const result = await pool.query(
      `INSERT INTO submissions 
       (ordem_servico, motivo, subcategoria, status, user_id, user_cod, user_name, 
        imagem_comprovante, imagens, coordenadas, validacao_ia, tentativas_foto, validada_por_ia, created_at) 
       VALUES ($1, $2, $3, 'pendente', $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()) 
       RETURNING *`,
      [sanitizedOrdemServico, sanitizedMotivo, subcategoria || null, userId, userCod, userName, imagemComprovante, imagens, coordenadas,
       validacao_ia || null, parseInt(tentativas_foto) || 0, validacao_ia ? true : false]
    );

    await registrarAuditoria(req, 'SUBMISSION_CREATE', AUDIT_CATEGORIES.DATA, 'submissions', result.rows[0].id, {
      ordem_servico: sanitizedOrdemServico
    });

    // Atualizar referencia_id nos hashes salvos
    pool.query(
      `UPDATE foto_hashes SET referencia_id = $1 WHERE referencia_id IS NULL AND user_cod = $2 AND origem = 'submission' AND created_at > NOW() - INTERVAL '1 minute'`,
      [result.rows[0].id, userCod]
    ).catch(() => {});

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
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'aprovado') as aprovados,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'rejeitado') as rejeitados,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'pendente' 
          AND created_at < NOW() - INTERVAL '24 hours'
          AND EXTRACT(DOW FROM created_at) BETWEEN 1 AND 5
          AND EXTRACT(HOUR FROM created_at) BETWEEN 9 AND 17
        ) as atrasadas,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as hoje_total,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND LOWER(TRIM(status)) != 'pendente') as hoje_processadas,
        COALESCE(AVG(
          CASE WHEN LOWER(TRIM(status)) != 'pendente' AND updated_at IS NOT NULL AND created_at IS NOT NULL
            AND EXTRACT(DOW FROM created_at) BETWEEN 1 AND 5
            AND EXTRACT(HOUR FROM created_at) BETWEEN 9 AND 17
          THEN EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600.0
          END
        ), 0) as tempo_medio_horas
      FROM submissions
    `);

    const motivos = await pool.query(`
      SELECT motivo, COUNT(*) as total
      FROM submissions
      GROUP BY motivo
      ORDER BY total DESC
    `);

    // Diagnóstico: todos os status distintos
    const statusBreakdown = await pool.query(`
      SELECT COALESCE(status, 'NULL') as status, COUNT(*) as total
      FROM submissions
      GROUP BY status
      ORDER BY total DESC
    `);

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
      atrasadas_os: atrasadasOS.rows.map(r => r.ordem_servico),
      statusBreakdown: statusBreakdown.rows
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
    const { q, status, periodo, dataInicio, dataFim, page = 1, limit = 100 } = req.query;
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
      if (status === 'contestado') {
        conditions.push(`contestacao_status = 'aberta'`);
      } else {
        conditions.push(`status = $${paramIdx++}`);
        params.push(status);
      }
    }

    if (dataInicio && dataFim) {
      conditions.push(`created_at >= $${paramIdx}::date AND created_at < ($${paramIdx + 1}::date + INTERVAL '1 day')`);
      params.push(dataInicio, dataFim);
      paramIdx += 2;
    } else if (periodo === 'today') {
      conditions.push(`created_at >= CURRENT_DATE`);
    } else if (periodo === 'week') {
      conditions.push(`created_at >= DATE_TRUNC('week', CURRENT_DATE)`);
    } else if (periodo === 'month') {
      conditions.push(`created_at >= DATE_TRUNC('month', CURRENT_DATE)`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM submissions ${where}`, params
    );

    const dataResult = await pool.query(`
      SELECT 
        id, ordem_servico, motivo, subcategoria, status, 
        user_id, user_cod, user_name,
        CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
        observacao, validated_by, validated_by_name,
        validacao_ia, tentativas_foto,
        contestacao_status, motivo_rejeicao, contestacao_lida,
        created_at, updated_at
      FROM submissions ${where}
      ORDER BY 
        CASE WHEN contestacao_status = 'aberta' THEN 0 ELSE 1 END,
        created_at DESC
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

// GET - Ranking de Retorno (aprovações agrupadas por profissional)
router.get('/submissions/ranking-retorno', verificarToken, async (req, res) => {
  try {
    const { periodo } = req.query;
    let dateFilter = '';
    if (periodo === 'today') dateFilter = `AND created_at >= CURRENT_DATE`;
    else if (periodo === 'week') dateFilter = `AND created_at >= DATE_TRUNC('week', CURRENT_DATE)`;
    else if (periodo === 'month') dateFilter = `AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`;
    // 'all' = sem filtro de data

    const result = await pool.query(`
      SELECT 
        user_cod, 
        MAX(user_name) as user_name,
        COUNT(*) as total,
        json_agg(json_build_object(
          'id', id, 'ordemServico', ordem_servico, 'created_at', created_at,
          'temImagem', CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END
        ) ORDER BY created_at DESC) as solicitacoes
      FROM submissions
      WHERE status = 'aprovado' AND LOWER(TRIM(motivo)) = 'ajuste de retorno' ${dateFilter}
      GROUP BY user_cod
      ORDER BY total DESC
    `);

    res.json({ ranking: result.rows });
  } catch (error) {
    console.error('❌ Erro ranking retorno:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET - Relatórios de submissões por mês/ano ou período customizado
router.get('/submissions/relatorios', verificarToken, async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;
    const usaCustom = dataInicio && dataFim;
    
    let dateFilter, dateParams, labelPeriodo;
    
    if (usaCustom) {
      // Período customizado: data início e fim
      dateFilter = `created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')`;
      dateParams = [dataInicio, dataFim];
      labelPeriodo = `${dataInicio} a ${dataFim}`;
    } else {
      // Modo padrão: mês/ano
      const mes = parseInt(req.query.mes ?? new Date().getMonth());
      const ano = parseInt(req.query.ano ?? new Date().getFullYear());
      const mesSQL = mes + 1;
      dateFilter = `EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2`;
      dateParams = [mesSQL, ano];
      labelPeriodo = `${mesSQL}/${ano}`;
    }

    const [statsRes, motivosRes, profRes, semanasRes, evolucaoRes, totalProfsRes] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovados,
          COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitados,
          COUNT(*) FILTER (WHERE status = 'pendente') as pendentes
        FROM submissions 
        WHERE ${dateFilter}
      `, dateParams),
      
      pool.query(`
        SELECT motivo,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas,
          COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitadas,
          COUNT(*) FILTER (WHERE status = 'pendente') as pendentes
        FROM submissions
        WHERE ${dateFilter}
        GROUP BY motivo ORDER BY total DESC
      `, dateParams),
      
      pool.query(`
        SELECT user_name as nome, user_cod as cod,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas,
          COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitadas
        FROM submissions
        WHERE ${dateFilter}
        GROUP BY user_name, user_cod ORDER BY total DESC LIMIT 10
      `, dateParams),
      
      // Semanas - para custom agrupa por semana ISO
      usaCustom 
        ? pool.query(`
            SELECT 
              'Sem ' || EXTRACT(WEEK FROM created_at)::int as semana,
              MIN(EXTRACT(DAY FROM created_at))::int as dia_inicio,
              MAX(EXTRACT(DAY FROM created_at))::int as dia_fim,
              COUNT(*) as total,
              COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas
            FROM submissions
            WHERE ${dateFilter}
            GROUP BY 1, EXTRACT(WEEK FROM created_at) ORDER BY EXTRACT(WEEK FROM created_at)
          `, dateParams)
        : pool.query(`
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
            WHERE ${dateFilter}
            GROUP BY 1 ORDER BY MIN(EXTRACT(DAY FROM created_at))
          `, dateParams),
      
      // Evolução - para custom mostra por mês dentro do range
      usaCustom
        ? pool.query(`
            SELECT 
              TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as label,
              EXTRACT(MONTH FROM created_at)::int as mes,
              EXTRACT(YEAR FROM created_at)::int as ano,
              COUNT(*) as total,
              COUNT(*) FILTER (WHERE status = 'aprovado') as aprovadas
            FROM submissions
            WHERE ${dateFilter}
            GROUP BY 1, 2, 3
            ORDER BY ano, mes
          `, dateParams)
        : pool.query(`
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
          `, dateParams),
      
      pool.query(`SELECT COUNT(DISTINCT user_cod) as total FROM submissions`)
    ]);

    const stats = statsRes.rows[0];
    
    // Calcular variação vs período anterior
    let mesAnteriorTotal = 0;
    if (!usaCustom) {
      const mesSQL = dateParams[0];
      const ano = dateParams[1];
      const mesAnterior = evolucaoRes.rows.find(r => {
        const mAnt = mesSQL === 1 ? 12 : mesSQL - 1;
        const aAnt = mesSQL === 1 ? ano - 1 : ano;
        return r.mes === mAnt && r.ano === aAnt;
      });
      mesAnteriorTotal = mesAnterior ? parseInt(mesAnterior.total) : 0;
    }

    const variacao = mesAnteriorTotal > 0 
      ? ((stats.total - mesAnteriorTotal) / mesAnteriorTotal * 100).toFixed(1) : '0.0';

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
      mesAnteriorTotal,
      variacao,
      periodoCustom: usaCustom || false
    });
  } catch (error) {
    console.error('❌ Erro relatórios submissions:', error);
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
          id, ordem_servico, motivo, subcategoria, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
          LENGTH(imagem_comprovante) as tamanho_imagem,
          coordenadas, observacao,
          validated_by, validated_by_name,
          validacao_ia, tentativas_foto,
          contestacao_status, motivo_rejeicao,
          created_at, updated_at
        FROM submissions 
        ORDER BY 
          CASE WHEN contestacao_status = 'aberta' THEN 0 ELSE 1 END,
          created_at DESC
        LIMIT 500
      `;
      params = [];
    } else {
      query = `
        SELECT 
          id, ordem_servico, motivo, subcategoria, status, 
          user_id, user_cod, user_name,
          CASE WHEN imagem_comprovante IS NOT NULL AND imagem_comprovante != '' THEN true ELSE false END as tem_imagem,
          LENGTH(imagem_comprovante) as tamanho_imagem,
          coordenadas, observacao,
          validated_by, validated_by_name,
          validacao_ia, tentativas_foto,
          contestacao_status, motivo_rejeicao, contestacao_lida,
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

    // Atualizar colunas de contestação (silencia se não existirem ainda)
    if (status === 'rejeitado') {
      pool.query(
        `UPDATE submissions SET motivo_rejeicao = $1, contestacao_lida = false WHERE id = $2`,
        [(observacao || '').substring(0, 1000), submissionId]
      ).catch(() => {});
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

  // ==================== CONTESTAÇÃO DE SUBMISSIONS ====================

  // GET - Rejeições não lidas do motoboy (para modal)
  router.get('/submissions/minhas-rejeicoes', verificarToken, async (req, res) => {
    try {
      const userCod = req.user.codProfissional;
      const result = await pool.query(`
        SELECT id, ordem_servico, motivo, motivo_rejeicao, observacao, contestacao_status, created_at, updated_at
        FROM submissions
        WHERE user_cod = $1 AND status = 'rejeitado' AND (contestacao_lida = false OR contestacao_lida IS NULL)
          AND (contestacao_status IS NULL OR contestacao_status NOT IN ('encerrada_rejeitada', 'aberta'))
        ORDER BY updated_at DESC
      `, [userCod]);
      res.json({ success: true, rejeicoes: result.rows });
    } catch (error) {
      console.error('❌ Erro ao buscar rejeições:', error);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // PATCH - Marcar rejeição como lida
  router.patch('/submissions/:id/marcar-lida', verificarToken, async (req, res) => {
    try {
      const submissionId = parseInt(req.params.id);
      await pool.query(
        'UPDATE submissions SET contestacao_lida = true WHERE id = $1 AND user_cod = $2',
        [submissionId, req.user.codProfissional]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // POST - Motoboy contesta uma rejeição
  router.post('/submissions/:id/contestar', verificarToken, async (req, res) => {
    try {
      const submissionId = parseInt(req.params.id);
      const { mensagem, imagens } = req.body;
      const userCod = req.user.codProfissional;
      const userName = req.user.nome;

      const sub = await pool.query('SELECT * FROM submissions WHERE id = $1 AND user_cod = $2', [submissionId, userCod]);
      if (sub.rows.length === 0) return res.status(404).json({ error: 'Submissão não encontrada' });
      if (sub.rows[0].status !== 'rejeitado') return res.status(400).json({ error: 'Só é possível contestar solicitações rejeitadas' });
      if (sub.rows[0].contestacao_status === 'encerrada_rejeitada') return res.status(400).json({ error: 'Contestação já encerrada definitivamente' });

      await pool.query(
        `UPDATE submissions SET contestacao_status = 'aberta', contestacao_aberta_em = NOW(), contestacao_lida = true, updated_at = NOW() WHERE id = $1`,
        [submissionId]
      );

      const imagensArr = Array.isArray(imagens) ? imagens : [];

      await pool.query(`
        INSERT INTO submissions_contestacoes (submission_id, autor_tipo, autor_cod, autor_nome, mensagem, imagens)
        VALUES ($1, 'motoboy', $2, $3, $4, $5)
      `, [submissionId, userCod, userName, (mensagem || '').substring(0, 2000), JSON.stringify(imagensArr)]);

      // 🔔 Notificar admins via WebSocket
      try {
        if (typeof global.broadcastToAdmins === 'function') {
          global.broadcastToAdmins('NEW_CONTESTATION', {
            submission_id: submissionId,
            ordem_servico: sub.rows[0].ordem_servico,
            motivo: sub.rows[0].motivo,
            user_cod: userCod,
            user_name: userName,
            mensagem: (mensagem || '').substring(0, 200),
          });
        }
      } catch (wsErr) {
        console.error('⚠️ Erro ao notificar WS contestação:', wsErr.message);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao contestar:', error);
      res.status(500).json({ error: 'Erro ao contestar' });
    }
  });

  // GET - Mensagens da contestação
  router.get('/submissions/:id/contestacao', verificarToken, async (req, res) => {
    try {
      const submissionId = parseInt(req.params.id);
      const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
      if (!isAdmin) {
        const sub = await pool.query('SELECT id FROM submissions WHERE id = $1 AND user_cod = $2', [submissionId, req.user.codProfissional]);
        if (sub.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
      }
      const msgs = await pool.query('SELECT * FROM submissions_contestacoes WHERE submission_id = $1 ORDER BY created_at ASC', [submissionId]);
      const sub = await pool.query('SELECT id, ordem_servico, motivo, status, contestacao_status, motivo_rejeicao, observacao, user_cod, user_name FROM submissions WHERE id = $1', [submissionId]);
      res.json({ success: true, mensagens: msgs.rows, submission: sub.rows[0] || null });
    } catch (error) {
      console.error('❌ Erro ao buscar contestação:', error);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // POST - Responder contestação (motoboy ou admin)
  router.post('/submissions/:id/contestacao-responder', verificarToken, async (req, res) => {
    try {
      const submissionId = parseInt(req.params.id);
      const { mensagem, imagens } = req.body;
      const isAdmin = ['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role);
      const sub = await pool.query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
      if (sub.rows.length === 0) return res.status(404).json({ error: 'Não encontrada' });
      if (sub.rows[0].contestacao_status !== 'aberta') return res.status(400).json({ error: 'Contestação não está aberta' });
      if (!isAdmin && sub.rows[0].user_cod !== req.user.codProfissional) return res.status(403).json({ error: 'Acesso negado' });

      const autorTipo = isAdmin ? 'admin' : 'motoboy';
      const imagensArr = Array.isArray(imagens) ? imagens : [];

      await pool.query(`
        INSERT INTO submissions_contestacoes (submission_id, autor_tipo, autor_cod, autor_nome, mensagem, imagens)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [submissionId, autorTipo, req.user.codProfissional || req.user.id, req.user.nome, (mensagem || '').substring(0, 2000), JSON.stringify(imagensArr)]);
      await pool.query('UPDATE submissions SET updated_at = NOW() WHERE id = $1', [submissionId]);

      // 🔔 Notificar a outra parte via WebSocket
      try {
        if (isAdmin && typeof global.sendToUser === 'function') {
          // Admin respondeu → notificar motoboy
          global.sendToUser(sub.rows[0].user_cod, 'CONTESTATION_REPLY', {
            submission_id: submissionId,
            ordem_servico: sub.rows[0].ordem_servico,
            autor_nome: req.user.nome,
          });
        } else if (!isAdmin && typeof global.broadcastToAdmins === 'function') {
          // Motoboy respondeu → notificar admins
          global.broadcastToAdmins('CONTESTATION_REPLY', {
            submission_id: submissionId,
            ordem_servico: sub.rows[0].ordem_servico,
            user_cod: req.user.codProfissional,
            user_name: req.user.nome,
          });
        }
      } catch (wsErr) {
        console.error('⚠️ Erro ao notificar WS resposta contestação:', wsErr.message);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao responder contestação:', error);
      res.status(500).json({ error: 'Erro ao responder' });
    }
  });

  // PATCH - Encerrar contestação (ADMIN)
  router.patch('/submissions/:id/contestacao-encerrar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const submissionId = parseInt(req.params.id);
      const { decisao, observacao } = req.body;
      if (!['aprovar', 'rejeitar'].includes(decisao)) return res.status(400).json({ error: 'Decisão deve ser aprovar ou rejeitar' });

      // Buscar dados da submission antes de atualizar (para pegar user_cod)
      const subAntes = await pool.query('SELECT user_cod, user_name, ordem_servico FROM submissions WHERE id = $1', [submissionId]);
      
      const novoStatus = decisao === 'aprovar' ? 'aprovado' : 'rejeitado';
      const contestacaoStatus = decisao === 'aprovar' ? 'encerrada_aprovada' : 'encerrada_rejeitada';

      await pool.query(`
        UPDATE submissions SET status = $1, contestacao_status = $2, contestacao_encerrada_em = NOW(),
          observacao = COALESCE($3, observacao), validated_by = $4, validated_by_name = $5, updated_at = NOW()
        WHERE id = $6
      `, [novoStatus, contestacaoStatus, observacao, req.user.id, req.user.nome, submissionId]);

      await pool.query(`
        INSERT INTO submissions_contestacoes (submission_id, autor_tipo, autor_cod, autor_nome, mensagem)
        VALUES ($1, 'admin', $2, $3, $4)
      `, [submissionId, req.user.codProfissional || req.user.id, req.user.nome,
        `📋 Contestação encerrada: ${decisao === 'aprovar' ? '✅ APROVADA' : '❌ REJEITADA DEFINITIVAMENTE'}${observacao ? ' — ' + observacao : ''}`]);

      await registrarAuditoria(req, 'CONTESTACAO_ENCERRADA', AUDIT_CATEGORIES.DATA, 'submissions', submissionId, { decisao });

      // 🔔 Notificar motoboy via WebSocket
      try {
        if (subAntes.rows.length > 0 && typeof global.sendToUser === 'function') {
          global.sendToUser(subAntes.rows[0].user_cod, 'CONTESTATION_CLOSED', {
            submission_id: submissionId,
            ordem_servico: subAntes.rows[0].ordem_servico,
            decisao,
            status: novoStatus,
            contestacao_status: contestacaoStatus,
          });
        }
      } catch (wsErr) {
        console.error('⚠️ Erro ao notificar WS encerramento:', wsErr.message);
      }

      res.json({ success: true, status: novoStatus, contestacao_status: contestacaoStatus });
    } catch (error) {
      console.error('❌ Erro ao encerrar contestação:', error);
      res.status(500).json({ error: 'Erro ao encerrar' });
    }
  });

  // ==================== HORÁRIOS + AVISOS ====================

router.get('/horarios', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM horarios_atendimento ORDER BY dia_semana');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários:', err);
    res.status(500).json({ error: 'Erro ao listar horários' });
  }
});

// PUT /api/horarios/:id - Atualizar horário de um dia
router.put('/horarios/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { hora_inicio, hora_fim, ativo } = req.body;
    
    const result = await pool.query(
      `UPDATE horarios_atendimento 
       SET hora_inicio = $1, hora_fim = $2, ativo = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [hora_inicio || null, hora_fim || null, ativo, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar horário:', err);
    res.status(500).json({ error: 'Erro ao atualizar horário' });
  }
});

// GET /api/horarios/especiais - Listar horários especiais
router.get('/horarios/especiais', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data >= CURRENT_DATE ORDER BY data'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar horários especiais:', err);
    res.status(500).json({ error: 'Erro ao listar horários especiais' });
  }
});

// POST /api/horarios/especiais - Criar horário especial
router.post('/horarios/especiais', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { data, descricao, hora_inicio, hora_fim, fechado } = req.body;
    
    const result = await pool.query(
      `INSERT INTO horarios_especiais (data, descricao, hora_inicio, hora_fim, fechado)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (data) DO UPDATE SET 
         descricao = $2, hora_inicio = $3, hora_fim = $4, fechado = $5
       RETURNING *`,
      [data, descricao, fechado ? null : hora_inicio, fechado ? null : hora_fim, fechado]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar horário especial:', err);
    res.status(500).json({ error: 'Erro ao criar horário especial' });
  }
});

// DELETE /api/horarios/especiais/:id - Remover horário especial
router.delete('/horarios/especiais/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM horarios_especiais WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover horário especial:', err);
    res.status(500).json({ error: 'Erro ao remover horário especial' });
  }
});

// GET /api/horarios/verificar - Verificar se está dentro do horário de atendimento
router.get('/horarios/verificar', verificarToken, async (req, res) => {
  try {
    const agora = new Date();
    // Ajustar para horário de Brasília (GMT-3)
    const brasiliaOffset = -3 * 60; // minutos
    const localOffset = agora.getTimezoneOffset(); // minutos
    const brasilia = new Date(agora.getTime() + (localOffset + brasiliaOffset) * 60000);
    
    const diaSemana = brasilia.getDay(); // 0=Domingo, 1=Segunda...
    const horaAtual = brasilia.toTimeString().slice(0, 5); // "HH:MM"
    const dataHoje = brasilia.toISOString().split('T')[0]; // "YYYY-MM-DD"
    
    // Verificar se há horário especial para hoje
    const especial = await pool.query(
      'SELECT * FROM horarios_especiais WHERE data = $1',
      [dataHoje]
    );
    
    let dentroHorario = false;
    let horarioInfo = null;
    
    if (especial.rows.length > 0) {
      // Usar horário especial
      const esp = especial.rows[0];
      if (esp.fechado) {
        dentroHorario = false;
        horarioInfo = { tipo: 'especial', descricao: esp.descricao, fechado: true };
      } else {
        dentroHorario = horaAtual >= esp.hora_inicio && horaAtual <= esp.hora_fim;
        horarioInfo = { 
          tipo: 'especial', 
          descricao: esp.descricao, 
          inicio: esp.hora_inicio, 
          fim: esp.hora_fim 
        };
      }
    } else {
      // Usar horário normal do dia
      const normal = await pool.query(
        'SELECT * FROM horarios_atendimento WHERE dia_semana = $1',
        [diaSemana]
      );
      
      if (normal.rows.length > 0) {
        const hor = normal.rows[0];
        if (!hor.ativo || !hor.hora_inicio || !hor.hora_fim) {
          dentroHorario = false;
          horarioInfo = { tipo: 'normal', fechado: true, diaSemana };
        } else {
          dentroHorario = horaAtual >= hor.hora_inicio && horaAtual <= hor.hora_fim;
          horarioInfo = { 
            tipo: 'normal', 
            inicio: hor.hora_inicio, 
            fim: hor.hora_fim, 
            diaSemana 
          };
        }
      }
    }
    
    // Buscar próximo horário de atendimento
    let proximoHorario = null;
    if (!dentroHorario) {
      // Buscar próximo dia com atendimento
      for (let i = 0; i <= 7; i++) {
        const proximaData = new Date(brasilia);
        proximaData.setDate(proximaData.getDate() + i);
        const proximoDia = proximaData.getDay();
        const proximaDataStr = proximaData.toISOString().split('T')[0];
        
        // Verificar especial
        const espProx = await pool.query(
          'SELECT * FROM horarios_especiais WHERE data = $1 AND fechado = false',
          [proximaDataStr]
        );
        
        if (espProx.rows.length > 0) {
          const esp = espProx.rows[0];
          if (i === 0 && horaAtual < esp.hora_inicio) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          } else if (i > 0) {
            proximoHorario = { data: proximaDataStr, inicio: esp.hora_inicio, descricao: esp.descricao };
            break;
          }
        } else {
          // Verificar normal
          const norProx = await pool.query(
            'SELECT * FROM horarios_atendimento WHERE dia_semana = $1 AND ativo = true',
            [proximoDia]
          );
          
          if (norProx.rows.length > 0 && norProx.rows[0].hora_inicio) {
            const nor = norProx.rows[0];
            if (i === 0 && horaAtual < nor.hora_inicio) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            } else if (i > 0) {
              proximoHorario = { data: proximaDataStr, inicio: nor.hora_inicio };
              break;
            }
          }
        }
      }
    }
    
    res.json({
      dentroHorario,
      horarioInfo,
      proximoHorario,
      horaAtual,
      dataHoje
    });
  } catch (err) {
    console.error('❌ Erro ao verificar horário:', err);
    res.status(500).json({ error: 'Erro ao verificar horário' });
  }
});

// GET /api/avisos - Listar avisos do financeiro
router.get('/avisos', verificarToken, async (req, res) => {
  try {
    const { ativos } = req.query;
    let query = 'SELECT * FROM avisos_financeiro';
    if (ativos === 'true') {
      query += ' WHERE ativo = true';
    }
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar avisos:', err);
    res.status(500).json({ error: 'Erro ao listar avisos' });
  }
});

// POST /api/avisos - Criar aviso
router.post('/avisos', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { titulo, mensagem, tipo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `INSERT INTO avisos_financeiro (titulo, mensagem, tipo, exibir_fora_horario)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [titulo, mensagem, tipo || 'info', exibir_fora_horario || false]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar aviso:', err);
    res.status(500).json({ error: 'Erro ao criar aviso' });
  }
});

// PUT /api/avisos/:id - Atualizar aviso
router.put('/avisos/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, mensagem, tipo, ativo, exibir_fora_horario } = req.body;
    
    const result = await pool.query(
      `UPDATE avisos_financeiro 
       SET titulo = $1, mensagem = $2, tipo = $3, ativo = $4, exibir_fora_horario = $5, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [titulo, mensagem, tipo, ativo, exibir_fora_horario, id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar aviso:', err);
    res.status(500).json({ error: 'Erro ao atualizar aviso' });
  }
});

// DELETE /api/avisos/:id - Remover aviso
router.delete('/avisos/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM avisos_financeiro WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao remover aviso:', err);
    res.status(500).json({ error: 'Erro ao remover aviso' });
  }
});

  // ==================== NOTIFICAÇÕES ====================

router.post('/notifications', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { message, type, forUser } = req.body;

    const result = await pool.query(
      `INSERT INTO notifications (message, type, for_user, created_at) 
       VALUES ($1, $2, $3, NOW()) 
       RETURNING *`,
      [message, type, forUser]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar notificação:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.get('/notifications/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;

    const result = await pool.query(
      "SELECT * FROM notifications WHERE for_user = $1 OR for_user = 'admin' ORDER BY created_at DESC LIMIT 50",
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar notificações:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

  // ==================== PROMOÇÕES + INDICAÇÕES + NOVATOS + QUIZ ====================

router.get('/promocoes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promocoes_indicacao ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar promoções ativas (para usuário)
router.get('/promocoes/ativas', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM promocoes_indicacao WHERE status = 'ativa' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar promoções ativas:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Criar promoção
router.post('/promocoes', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar promoção (status ou dados completos)
router.patch('/promocoes/:id', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Excluir promoção
router.delete('/promocoes/:id', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================
// INDICAÇÕES
// ============================================

// Listar todas as indicações (admin)
router.get('/indicacoes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM indicacoes ORDER BY created_at DESC'
    );
    console.log(`📋 [Indicações] Listando ${result.rows.length} indicações`);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar indicações do usuário
router.get('/indicacoes/usuario/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações do usuário:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Criar indicação
router.post('/indicacoes', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Aprovar indicação
router.patch('/indicacoes/:id/aprovar', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rejeitar indicação
router.patch('/indicacoes/:id/rejeitar', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar crédito lançado
router.patch('/indicacoes/:id/credito', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Verificar e expirar indicações antigas (pode ser chamado periodicamente)
router.post('/indicacoes/verificar-expiradas', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Verificar cadastro de indicados via API Tutts (prof-status)
router.post('/indicacoes/verificar-cadastros', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { celulares } = req.body;
    if (!celulares || !Array.isArray(celulares) || celulares.length === 0) {
      return res.status(400).json({ error: 'celulares é obrigatório (array)' });
    }

    const token = process.env.TUTTS_TOKEN_PROF_STATUS;
    if (!token) {
      console.warn('⚠️ TUTTS_TOKEN_PROF_STATUS não configurado');
      return res.status(503).json({ error: 'Token prof-status não configurado' });
    }

    const lista = celulares.slice(0, 50);
    const resultados = {};

    const chunks = [];
    for (let i = 0; i < lista.length; i += 5) {
      chunks.push(lista.slice(i, i + 5));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (cel) => {
        try {
          const celLimpo = cel.replace(/\D/g, '');
          if (!celLimpo || celLimpo.length < 10) {
            resultados[cel] = { cadastrado: false, erro: 'número inválido' };
            return;
          }

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

// Excluir indicação (admin)
router.delete('/indicacoes/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Apenas admin pode excluir
    if (req.user.role !== 'admin' && req.user.role !== 'admin_master' && req.user.role !== 'admin_financeiro') {
      return res.status(403).json({ error: 'Sem permissão para excluir indicações' });
    }

    const result = await pool.query(
      'DELETE FROM indicacoes WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Indicação não encontrada' });
    }

    console.log('🗑️ [Indicação] Excluída por', req.user.fullName || req.user.username, '— ID:', id, '| Indicado:', result.rows[0].indicado_nome);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir indicação:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Gerar ou obter link de indicação do usuário
router.post('/indicacao-link/gerar', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter link existente do usuário
router.get('/indicacao-link/usuario/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM indicacao_links WHERE LOWER(user_cod) = LOWER($1) AND active = TRUE',
      [userCod]
    );
    res.json(result.rows[0] || null);
  } catch (error) {
    console.error('❌ Erro ao buscar link:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Cadastrar indicado via link (público)
// 🔒 SECURITY FIX (CRIT-06): Rate limiter no endpoint público
router.post('/indicacao-link/cadastrar', indicacaoCadastroLimiter, async (req, res) => {
  try {
    const { token, nome, telefone } = req.body;
    
    console.log('👥 [Indicação] Tentativa de cadastro via link:', { token: token ? token.substring(0, 8) + '...' : 'VAZIO', nome, telefone });
    
    if (!token || !nome || !telefone) {
      return res.status(400).json({ error: 'Token, nome e telefone são obrigatórios' });
    }
    
    // Validar token e pegar dados da promoção
    const linkResult = await pool.query(
      'SELECT * FROM indicacao_links WHERE token = $1 AND active = TRUE',
      [token]
    );
    
    if (linkResult.rows.length === 0) {
      console.warn('⚠️ [Indicação] Link inválido ou inativo:', token);
      return res.status(404).json({ error: 'Link inválido ou expirado' });
    }
    
    const link = linkResult.rows[0];
    console.log('👥 [Indicação] Link válido. Indicador:', link.user_cod, link.user_name, '| Promoção ID:', link.promocao_id);
    
    // Limpar telefone para comparação
    const telefoneLimpo = telefone.replace(/\D/g, '');
    
    // Verificar se este telefone já foi indicado por este usuário
    const jaIndicado = await pool.query(
      `SELECT id FROM indicacoes WHERE LOWER(user_cod) = LOWER($1) AND REPLACE(indicado_contato, ' ', '') LIKE '%' || $2 || '%'`,
      [link.user_cod, telefoneLimpo.slice(-8)]
    );
    
    if (jaIndicado.rows.length > 0) {
      console.warn('⚠️ [Indicação] Telefone já indicado:', telefoneLimpo, 'por', link.user_cod);
      return res.status(400).json({ error: 'Este telefone já foi indicado anteriormente' });
    }
    
    // Verificar se a promoção ainda existe (evitar FK violation)
    let promocaoIdFinal = link.promocao_id;
    if (promocaoIdFinal) {
      const promoExiste = await pool.query('SELECT id FROM promocoes_indicacao WHERE id = $1', [promocaoIdFinal]);
      if (promoExiste.rows.length === 0) {
        console.warn('⚠️ [Indicação] Promoção ID', promocaoIdFinal, 'não existe mais. Salvando sem promoção.');
        promocaoIdFinal = null;
      }
    }
    
    // Criar indicação
    const result = await pool.query(
      `INSERT INTO indicacoes (user_cod, user_name, indicado_nome, indicado_contato, link_token, promocao_id, regiao, valor_bonus, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW()) RETURNING *`,
      [link.user_cod, link.user_name, nome.trim(), telefone, token, promocaoIdFinal, link.regiao, link.valor_bonus]
    );
    
    console.log('✅ [Indicação] Cadastrada com sucesso! ID:', result.rows[0].id, '| Indicador:', link.user_cod, '| Indicado:', nome, telefone);
    res.json({ success: true, indicacao: result.rows[0] });
  } catch (error) {
    console.error('❌ [Indicação] Erro ao cadastrar indicado:', error.message);
    console.error('❌ [Indicação] Detalhes:', error.detail || error.constraint || 'sem detalhe');
    
    // Tratar FK violation especificamente
    if (error.code === '23503') {
      console.error('❌ [Indicação] Foreign key violation — promoção provavelmente deletada');
      // Tentar inserir sem promocao_id
      try {
        const { token, nome, telefone } = req.body;
        const linkResult = await pool.query('SELECT * FROM indicacao_links WHERE token = $1 AND active = TRUE', [token]);
        if (linkResult.rows.length > 0) {
          const link = linkResult.rows[0];
          const result = await pool.query(
            `INSERT INTO indicacoes (user_cod, user_name, indicado_nome, indicado_contato, link_token, promocao_id, regiao, valor_bonus, status, created_at) 
             VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 'pendente', NOW()) RETURNING *`,
            [link.user_cod, link.user_name, nome.trim(), telefone, token, link.regiao, link.valor_bonus]
          );
          console.log('✅ [Indicação] Cadastrada com fallback (sem promoção)! ID:', result.rows[0].id);
          return res.json({ success: true, indicacao: result.rows[0] });
        }
      } catch (retryError) {
        console.error('❌ [Indicação] Retry também falhou:', retryError.message);
      }
    }
    
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar indicações recebidas via link (para admin)
router.get('/indicacao-link/indicacoes', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM indicacoes WHERE link_token IS NOT NULL ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar indicações via link:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Estatísticas de indicações por usuário
router.get('/indicacao-link/estatisticas/:userCod', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================
// PROMOÇÕES NOVATOS
// ============================================

// Listar regiões disponíveis da planilha (para criar promoções)
router.get('/promocoes-novatos/regioes', verificarToken, async (req, res) => {
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
// 1. Deve haver promoção ativa para a região do usuário (região vem da planilha)
// 2. Usuário nunca realizou nenhuma corrida OU não realizou corrida nos últimos 10 dias
router.get('/promocoes-novatos/elegibilidade/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // Buscar região do usuário na planilha do Google Sheets
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const sheetResponse = await fetch(sheetUrl);
    const sheetText = await sheetResponse.text();
    const sheetLines = sheetText.split('\n').slice(1); // pular header
    
    let userRegiao = null;
    for (const line of sheetLines) {
      const cols = line.split(',');
      if (cols[0]?.trim() === userCod.toString()) {
        userRegiao = cols[3]?.trim(); // coluna Cidade (índice 3 = coluna D)
        break;
      }
    }
    
    // Verificar se há promoções ativas
    const promoResult = await pool.query(
      "SELECT * FROM promocoes_novatos WHERE status = 'ativa'"
    );
    
    if (promoResult.rows.length === 0) {
      return res.json({ 
        elegivel: false, 
        motivo: 'Nenhuma promoção ativa no momento',
        promocoes: [],
        userRegiao
      });
    }
    
    // Verificar histórico de entregas do usuário
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
        userRegiao
      });
    }
    
    // Filtrar promoções por região do usuário
    let promocoesDisponiveis = promoResult.rows;
    
    // Se o usuário tem região na planilha, filtrar promoções compatíveis
    if (userRegiao) {
      promocoesDisponiveis = promoResult.rows.filter(promo => {
        const regiaoPromo = (promo.regiao || '').toLowerCase().trim();
        const regiaoUser = userRegiao.toLowerCase().trim();
        
        // Compatível se:
        // - Região da promoção é igual à região do usuário
        // - Região da promoção contém a região do usuário (ou vice-versa)
        // - Região da promoção é "Todas", "Geral" ou vazia
        return regiaoPromo === regiaoUser ||
               regiaoPromo.includes(regiaoUser) || 
               regiaoUser.includes(regiaoPromo) ||
               regiaoPromo.includes('todas') || 
               regiaoPromo.includes('geral') ||
               regiaoPromo === '' ||
               !promo.regiao;
      });
    }
    
    if (promocoesDisponiveis.length === 0) {
      return res.json({
        elegivel: false,
        motivo: userRegiao 
          ? `Não há promoções ativas para sua região (${userRegiao}).` 
          : 'Você não está cadastrado na planilha de profissionais ou não tem região definida.',
        promocoes: [],
        totalEntregas,
        diasSemEntrega,
        userRegiao
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
      userRegiao
    });
    
  } catch (error) {
    console.error('❌ Erro ao verificar elegibilidade novatos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar todas as promoções de novatos
router.get('/promocoes-novatos', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar promoções ativas (para usuários)
router.get('/promocoes-novatos/ativas', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Criar nova promoção novatos
router.post('/promocoes-novatos', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar promoção novatos (status ou dados)
router.patch('/promocoes-novatos/:id', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Deletar promoção novatos
router.delete('/promocoes-novatos/:id', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================
// INSCRIÇÕES NOVATOS
// ============================================

// Listar todas as inscrições (admin)
router.get('/inscricoes-novatos', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar inscrições de um usuário
router.get('/inscricoes-novatos/usuario/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    const result = await pool.query(
      'SELECT * FROM inscricoes_novatos WHERE LOWER(user_cod) = LOWER($1) ORDER BY created_at DESC',
      [userCod]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar inscrições do usuário:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Criar inscrição novatos (usuário se inscreve)
router.post('/inscricoes-novatos', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Aprovar inscrição novatos
router.patch('/inscricoes-novatos/:id/aprovar', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rejeitar inscrição novatos
router.patch('/inscricoes-novatos/:id/rejeitar', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar crédito lançado para inscrição novatos
router.patch('/inscricoes-novatos/:id/credito', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Deletar inscrição novatos
router.delete('/inscricoes-novatos/:id', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Verificar e expirar inscrições novatos antigas (chamado periodicamente)
router.post('/inscricoes-novatos/verificar-expiradas', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar débito para inscrição novatos
router.patch('/inscricoes-novatos/:id/debito', verificarToken, verificarAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Buscar entregas do profissional no período da inscrição (integração com BI)
router.get('/inscricoes-novatos/:id/entregas', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Buscar progresso de todas as inscrições de um usuário
router.get('/inscricoes-novatos/progresso/:userCod', verificarToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ============================================
// QUIZ DE PROCEDIMENTOS (Promoção Novato)
// ============================================

// Obter configuração do quiz
router.get('/quiz-procedimentos/config', verificarToken, async (req, res) => {
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
      valor_gratuidade: parseFloat(config.valor_gratuidade),
      ativo: config.ativo
    });
  } catch (error) {
    console.error('❌ Erro ao obter config quiz:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Salvar configuração do quiz
router.post('/quiz-procedimentos/config', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { titulo, imagens, perguntas, valor_gratuidade, ativo } = req.body;
    
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
          valor_gratuidade = $16, ativo = $17, updated_at = NOW()
        WHERE id = $18`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo,
          existing.rows[0].id
        ]
      );
    } else {
      // Inserir
      await pool.query(
        `INSERT INTO quiz_procedimentos_config 
          (titulo, imagem1, imagem2, imagem3, imagem4, 
           pergunta1, resposta1, pergunta2, resposta2, pergunta3, resposta3,
           pergunta4, resposta4, pergunta5, resposta5, valor_gratuidade, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          titulo,
          imagens[0], imagens[1], imagens[2], imagens[3],
          perguntas[0].texto, perguntas[0].resposta,
          perguntas[1].texto, perguntas[1].resposta,
          perguntas[2].texto, perguntas[2].resposta,
          perguntas[3].texto, perguntas[3].resposta,
          perguntas[4].texto, perguntas[4].resposta,
          valor_gratuidade, ativo
        ]
      );
    }
    
    console.log('✅ Config quiz salva');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao salvar config quiz:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Verificar se usuário já respondeu o quiz
router.get('/quiz-procedimentos/verificar/:userCod', verificarToken, async (req, res) => {
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
router.post('/quiz-procedimentos/responder', verificarToken, verificarAdmin, async (req, res) => {
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
    
    // Contar acertos
    let acertos = 0;
    for (let i = 0; i < 5; i++) {
      if (respostas[i] === respostasCorretas[i]) acertos++;
    }
    
    const passou = acertos === 5;
    
    // Registrar resposta
    await pool.query(
      `INSERT INTO quiz_procedimentos_respostas (user_cod, user_name, acertos, passou, gratuidade_criada)
       VALUES ($1, $2, $3, $4, $5)`,
      [user_cod, user_name, acertos, passou, passou]
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
      valor_gratuidade: passou ? parseFloat(config.valor_gratuidade) : 0
    });
  } catch (error) {
    console.error('❌ Erro ao responder quiz:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar quem respondeu o quiz (admin)
router.get('/quiz-procedimentos/respostas', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM quiz_procedimentos_respostas ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar respostas:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

  // ==================== RECRUTAMENTO ====================

// GET /api/recrutamento - Listar todas as necessidades
router.get('/recrutamento', verificarToken, async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT n.*, 
        COALESCE(
          (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE necessidade_id = n.id AND tipo = 'titular'),
          0
        ) as motos_atribuidas,
        COALESCE(
          (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE necessidade_id = n.id AND tipo = 'backup'),
          0
        ) as backups_atribuidos
      FROM recrutamento_necessidades n
    `;
    
    const params = [];
    if (status) {
      params.push(status);
      query += ` WHERE n.status = $1`;
    }
    
    query += ` ORDER BY n.data_conclusao ASC, n.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    // Para cada necessidade, buscar as atribuições
    const necessidades = [];
    for (const nec of result.rows) {
      const atribuicoes = await pool.query(
        `SELECT * FROM recrutamento_atribuicoes WHERE necessidade_id = $1 ORDER BY tipo, created_at`,
        [nec.id]
      );
      necessidades.push({
        ...nec,
        atribuicoes: atribuicoes.rows
      });
    }
    
    res.json(necessidades);
  } catch (error) {
    console.error('Erro ao listar recrutamento:', error);
    res.status(500).json({ error: 'Erro ao listar necessidades de recrutamento' });
  }
});

// POST /api/recrutamento - Criar nova necessidade
router.post('/recrutamento', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, criado_por } = req.body;
    
    if (!nome_cliente || !data_conclusao || !quantidade_motos) {
      return res.status(400).json({ error: 'Nome do cliente, data de conclusão e quantidade de motos são obrigatórios' });
    }
    
    const result = await pool.query(
      `INSERT INTO recrutamento_necessidades 
        (nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [nome_cliente, data_conclusao, quantidade_motos, quantidade_backup || 0, observacao || null, criado_por]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar necessidade:', error);
    res.status(500).json({ error: 'Erro ao criar necessidade de recrutamento' });
  }
});

// PUT /api/recrutamento/:id - Atualizar necessidade
router.put('/recrutamento/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, status } = req.body;
    
    const result = await pool.query(
      `UPDATE recrutamento_necessidades 
       SET nome_cliente = COALESCE($1, nome_cliente),
           data_conclusao = COALESCE($2, data_conclusao),
           quantidade_motos = COALESCE($3, quantidade_motos),
           quantidade_backup = COALESCE($4, quantidade_backup),
           observacao = $5,
           status = COALESCE($6, status),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [nome_cliente, data_conclusao, quantidade_motos, quantidade_backup, observacao, status, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar necessidade:', error);
    res.status(500).json({ error: 'Erro ao atualizar necessidade' });
  }
});

// DELETE /api/recrutamento/:id - Deletar necessidade
router.delete('/recrutamento/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM recrutamento_necessidades WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('Erro ao deletar necessidade:', error);
    res.status(500).json({ error: 'Erro ao deletar necessidade' });
  }
});

// POST /api/recrutamento/:id/atribuir - Atribuir moto a uma necessidade
router.post('/recrutamento/:id/atribuir', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { cod_profissional, tipo, atribuido_por } = req.body;
    
    if (!cod_profissional) {
      return res.status(400).json({ error: 'Código do profissional é obrigatório' });
    }
    
    // Verificar se a necessidade existe
    const necessidade = await pool.query(
      'SELECT * FROM recrutamento_necessidades WHERE id = $1',
      [id]
    );
    
    if (necessidade.rows.length === 0) {
      return res.status(404).json({ error: 'Necessidade não encontrada' });
    }
    
    // Verificar se já está atribuído nesta necessidade
    const jaAtribuido = await pool.query(
      'SELECT * FROM recrutamento_atribuicoes WHERE necessidade_id = $1 AND cod_profissional = $2',
      [id, cod_profissional]
    );
    
    if (jaAtribuido.rows.length > 0) {
      return res.status(400).json({ error: 'Este profissional já está atribuído a esta necessidade' });
    }
    
    // Buscar nome do profissional na planilha do Google Sheets
    let nome_profissional = null;
    try {
      const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
      const response = await fetch(sheetUrl);
      const text = await response.text();
      const lines = text.split('\n').slice(1);
      
      for (const line of lines) {
        const cols = line.split(',');
        if (cols[0]?.trim() === cod_profissional) {
          nome_profissional = cols[1]?.trim() || null;
          break;
        }
      }
    } catch (sheetErr) {
      console.log('Erro ao buscar na planilha, tentando fallback:', sheetErr.message);
    }
    
    // Fallback: buscar na tabela de disponibilidade se não achou na planilha
    if (!nome_profissional) {
      const profResult = await pool.query(
        `SELECT DISTINCT nome_profissional 
         FROM disponibilidade_linhas 
         WHERE cod_profissional = $1 AND nome_profissional IS NOT NULL
         LIMIT 1`,
        [cod_profissional]
      );
      nome_profissional = profResult.rows[0]?.nome_profissional || null;
    }
    
    // Inserir atribuição
    const result = await pool.query(
      `INSERT INTO recrutamento_atribuicoes 
        (necessidade_id, tipo, cod_profissional, nome_profissional, atribuido_por)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, tipo || 'titular', cod_profissional, nome_profissional, atribuido_por]
    );
    
    // Verificar se a necessidade foi completada
    const atribuicoes = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE tipo = 'titular') as titulares,
        COUNT(*) FILTER (WHERE tipo = 'backup') as backups
       FROM recrutamento_atribuicoes 
       WHERE necessidade_id = $1`,
      [id]
    );
    
    const nec = necessidade.rows[0];
    const stats = atribuicoes.rows[0];
    
    // Se atingiu o total necessário, atualizar status para concluído
    if (parseInt(stats.titulares) >= nec.quantidade_motos && 
        parseInt(stats.backups) >= nec.quantidade_backup) {
      await pool.query(
        `UPDATE recrutamento_necessidades SET status = 'concluido', updated_at = NOW() WHERE id = $1`,
        [id]
      );
    }
    
    res.json({ 
      atribuicao: result.rows[0],
      nome_profissional: nome_profissional
    });
  } catch (error) {
    console.error('Erro ao atribuir profissional:', error);
    res.status(500).json({ error: 'Erro ao atribuir profissional' });
  }
});

// DELETE /api/recrutamento/atribuicao/:id - Remover atribuição
router.delete('/recrutamento/atribuicao/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar a atribuição para saber qual necessidade
    const atribuicao = await pool.query(
      'SELECT * FROM recrutamento_atribuicoes WHERE id = $1',
      [id]
    );
    
    if (atribuicao.rows.length === 0) {
      return res.status(404).json({ error: 'Atribuição não encontrada' });
    }
    
    const necessidadeId = atribuicao.rows[0].necessidade_id;
    
    // Deletar atribuição
    await pool.query('DELETE FROM recrutamento_atribuicoes WHERE id = $1', [id]);
    
    // Atualizar status da necessidade para em_andamento se estava concluída
    await pool.query(
      `UPDATE recrutamento_necessidades 
       SET status = 'em_andamento', updated_at = NOW() 
       WHERE id = $1 AND status = 'concluido'`,
      [necessidadeId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover atribuição:', error);
    res.status(500).json({ error: 'Erro ao remover atribuição' });
  }
});

// GET /api/recrutamento/buscar-profissional/:cod - Buscar profissional por código
router.get('/recrutamento/buscar-profissional/:cod', verificarToken, async (req, res) => {
  try {
    const { cod } = req.params;
    
    // Buscar na planilha do Google Sheets (mesma usada no módulo de disponibilidade)
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1d7jI-q7OjhH5vU69D3Vc_6Boc9xjLZPVR8efjMo1yAE/export?format=csv';
    const response = await fetch(sheetUrl);
    const text = await response.text();
    const lines = text.split('\n').slice(1); // pular header
    
    let profissional = null;
    for (const line of lines) {
      const cols = line.split(',');
      const codigo = cols[0]?.trim();
      if (codigo === cod) {
        profissional = {
          cod_profissional: codigo,
          nome_profissional: cols[1]?.trim() || null,
          cidade: cols[3]?.trim() || null
        };
        break;
      }
    }
    
    if (!profissional) {
      // Fallback: tentar buscar na tabela de disponibilidade
      const dispResult = await pool.query(
        `SELECT DISTINCT cod_profissional, nome_profissional
         FROM disponibilidade_linhas 
         WHERE cod_profissional = $1 AND nome_profissional IS NOT NULL
         LIMIT 1`,
        [cod]
      );
      
      if (dispResult.rows.length > 0) {
        return res.json(dispResult.rows[0]);
      }
      
      // Fallback 2: tentar buscar na tabela de usuários
      const userResult = await pool.query(
        'SELECT cod_profissional, full_name as nome_profissional FROM users WHERE cod_profissional = $1',
        [cod]
      );
      
      if (userResult.rows.length > 0) {
        return res.json(userResult.rows[0]);
      }
      
      return res.status(404).json({ error: 'Profissional não encontrado' });
    }
    
    res.json(profissional);
  } catch (error) {
    console.error('Erro ao buscar profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar profissional' });
  }
});

// GET /api/recrutamento/estatisticas - Estatísticas gerais de recrutamento
router.get('/recrutamento/estatisticas', verificarToken, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_necessidades,
        COUNT(*) FILTER (WHERE status = 'em_andamento') as em_andamento,
        COUNT(*) FILTER (WHERE status = 'concluido') as concluidas,
        COUNT(*) FILTER (WHERE status = 'cancelado') as canceladas,
        SUM(quantidade_motos) as total_motos_necessarias,
        SUM(quantidade_backup) as total_backups_necessarios,
        (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE tipo = 'titular') as total_motos_atribuidas,
        (SELECT COUNT(*) FROM recrutamento_atribuicoes WHERE tipo = 'backup') as total_backups_atribuidos
      FROM recrutamento_necessidades
    `);
    
    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});


  // ==================== VALIDAÇÃO IA + RESPOSTAS PRONTAS ====================
  try {
    router.use(createValidacaoIaRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria, AUDIT_CATEGORIES));
    console.log('✅ Sub-router validação IA montado');
  } catch (err) {
    console.error('⚠️ Erro ao montar validação IA:', err.message);
  }

  return router;
}

module.exports = { createConfigRouter };
