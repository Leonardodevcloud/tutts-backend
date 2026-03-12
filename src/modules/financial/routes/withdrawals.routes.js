/**
 * Sub-Router: Withdrawals + Conciliação
 * ⚡ PERFORMANCE V3: Cache em memória + queries sem JOIN pesado
 */
const express = require('express');

function createWithdrawalsRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES, helpers) {
  const router = express.Router();

// ═══════════════════════════════════════════════════════════
// ⚡ CACHE EM MEMÓRIA — evita bater no banco repetidamente
// ═══════════════════════════════════════════════════════════
const cache = {
  withdrawals: { data: null, timestamp: 0, key: '' },
  counts: { data: null, timestamp: 0 },
  restricted: { data: null, timestamp: 0 },
};
const CACHE_TTL = 30000; // 30 segundos

// Helper: buscar lista de profissionais restritos (raramente muda)
async function getRestrictedMap() {
  if (cache.restricted.data && Date.now() - cache.restricted.timestamp < 120000) {
    return cache.restricted.data; // cache 2 min
  }
  const res = await pool.query(
    `SELECT user_cod, reason FROM restricted_professionals WHERE status = 'ativo'`
  );
  const map = {};
  for (const r of res.rows) {
    map[r.user_cod] = r.reason;
  }
  cache.restricted = { data: map, timestamp: Date.now() };
  return map;
}

// Helper: enriquecer saques com info de restrição (em JS, não SQL)
function enrichWithRestrictions(rows, restrictedMap) {
  return rows.map(w => ({
    ...w,
    is_restricted: !!restrictedMap[w.user_cod],
    restriction_reason: restrictedMap[w.user_cod] || null,
  }));
}

// Invalidar cache quando houver mudança
function invalidateCache() {
  cache.withdrawals = { data: null, timestamp: 0, key: '' };
  cache.counts = { data: null, timestamp: 0 };
  console.log('🔄 Cache de withdrawals invalidado');
}

router.get('/withdrawals/pendentes', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const [restrictedMap, result] = await Promise.all([
      getRestrictedMap(),
      pool.query(`
        SELECT *, EXTRACT(EPOCH FROM (NOW() - created_at))/3600 as horas_aguardando
        FROM withdrawal_requests
        WHERE status IN ('pending', 'aguardando_aprovacao')
        ORDER BY created_at ASC
      `)
    ]);
    
    const withdrawals = enrichWithRestrictions(result.rows, restrictedMap).map(w => ({
      ...w,
      isDelayed: parseFloat(w.horas_aguardando) > 1
    }));
    
    console.log(`📋 [withdrawals/pendentes] Retornando ${withdrawals.length} saques pendentes`);
    res.json(withdrawals);
  } catch (error) {
    console.error('❌ Erro ao listar saques pendentes:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== NOVO: Contadores (ultra leve) ====================
router.get('/withdrawals/contadores', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('pending', 'aguardando_aprovacao')) as pendentes,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')) as aprovados,
        COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitados,
        COUNT(*) as total
      FROM withdrawal_requests
    `);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao obter contadores:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== NOVO: Histórico paginado ====================
router.get('/withdrawals/historico', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, user_cod, data_inicio, data_fim } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let whereConditions = [];
    
    if (status) {
      params.push(status);
      whereConditions.push(`w.status = $${params.length}`);
    } else {
      whereConditions.push(`w.status NOT IN ('pending', 'aguardando_aprovacao')`);
    }
    
    if (user_cod) {
      params.push(user_cod);
      whereConditions.push(`w.user_cod = $${params.length}`);
    }
    
    if (data_inicio) {
      params.push(data_inicio);
      whereConditions.push(`w.created_at >= $${params.length}::date`);
    }
    
    if (data_fim) {
      params.push(data_fim);
      whereConditions.push(`w.created_at <= $${params.length}::date + interval '1 day'`);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    const [result, restrictedMap] = await Promise.all([
      pool.query(`
        SELECT w.*
        FROM withdrawal_requests w
        ${whereClause}
        ORDER BY w.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, parseInt(limit), offset]),
      getRestrictedMap()
    ]);
    
    const countResult = await pool.query(`SELECT COUNT(*) as total FROM withdrawal_requests w ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / parseInt(limit));
    
    res.json({
      data: enrichWithRestrictions(result.rows, restrictedMap),
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages, hasNext: parseInt(page) < totalPages, hasPrev: parseInt(page) > 1 }
    });
  } catch (error) {
    console.error('❌ Erro ao listar histórico:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar solicitação de saque
router.post('/withdrawals', verificarToken, helpers.withdrawalCreateLimiter, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { userCod, userName, cpf, pixKey, requestedAmount, selectedGratuityId } = req.body;

    // =============== VALIDAÇÃO: VALOR MÍNIMO R$ 15,00 ===============
    if (!requestedAmount || parseFloat(requestedAmount) < 15) {
      client.release();
      return res.status(400).json({ error: 'Valor mínimo para saque é R$ 15,00' });
    }

    // Validar que o usuário só pode criar saque para si mesmo (exceto admin)
    if (req.user.role !== 'admin' && req.user.role !== 'admin_master' && req.user.role !== 'admin_financeiro') {
      if (req.user.codProfissional !== userCod) {
        console.log(`⚠️ [SEGURANÇA] Tentativa de criar saque para outro usuário: ${req.user.codProfissional} tentou criar para ${userCod}`);
        client.release();
        return res.status(403).json({ error: 'Você só pode criar saques para sua própria conta' });
      }
    }

    await client.query('BEGIN');

    // =============== PROTEÇÃO DEFINITIVA: LOCK + CHECK DUPLICATA ===============
    // Advisory lock por user_cod — impede dois requests simultâneos do mesmo motoboy
    const lockKey = Math.abs(userCod.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 0)) % 2147483647;
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Verificar se já existe saque pendente (aguardando_aprovacao) para este motoboy
    const pendente = await client.query(
      `SELECT id, requested_amount, created_at FROM withdrawal_requests 
       WHERE user_cod = $1 AND status = 'aguardando_aprovacao'
       ORDER BY created_at DESC LIMIT 1`,
      [userCod]
    );

    if (pendente.rows.length > 0) {
      const saquePendente = pendente.rows[0];
      const minutosDesdeCriacao = (Date.now() - new Date(saquePendente.created_at).getTime()) / 60000;
      
      await client.query('ROLLBACK');
      client.release();
      
      console.log(`⚠️ [DUPLICATA BLOQUEADA] Motoboy ${userCod} (${userName}) tentou criar saque duplicado. Pendente #${saquePendente.id} criado há ${minutosDesdeCriacao.toFixed(1)} min`);
      
      return res.status(409).json({ 
        error: 'Você já possui um saque aguardando aprovação! Aguarde a aprovação ou rejeição antes de solicitar novamente.',
        saque_pendente_id: saquePendente.id,
        saque_pendente_valor: saquePendente.requested_amount,
        criado_em: saquePendente.created_at
      });
    }

    // Verificar cooldown — nenhum saque (qualquer status) nos últimos 5 segundos
    // Protege contra double-click mesmo se o anterior já foi aprovado/rejeitado
    const recentissimo = await client.query(
      `SELECT id FROM withdrawal_requests 
       WHERE user_cod = $1 AND created_at > NOW() - INTERVAL '5 seconds'
       LIMIT 1`,
      [userCod]
    );

    if (recentissimo.rows.length > 0) {
      await client.query('ROLLBACK');
      client.release();
      console.log(`⚠️ [COOLDOWN] Motoboy ${userCod} tentou criar saque muito rápido (< 5s)`);
      return res.status(429).json({ error: 'Aguarde alguns segundos antes de solicitar novamente.' });
    }

    // Verificar se está restrito — BLOQUEAR SAQUE
    const restricted = await client.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );
    
    if (restricted.rows.length > 0) {
      await client.query('ROLLBACK');
      try { client.release(); } catch (e) {}
      console.log(`🚫 [Saque] Profissional restrito tentou solicitar saque: ${userCod} (${userName})`);
      return res.status(403).json({ 
        error: 'Infelizmente o saque emergencial está temporariamente fora do ar! Aguarde a normalização.',
        restrito: true
      });
    }

    // Verificar gratuidade ativa
    let gratuityQuery;
    if (selectedGratuityId) {
      gratuityQuery = await client.query(
        "SELECT * FROM gratuities WHERE id = $1 AND user_cod = $2 AND status = 'ativa' AND remaining > 0",
        [selectedGratuityId, userCod]
      );
      if (gratuityQuery.rows.length === 0) {
        gratuityQuery = await client.query(
          "SELECT * FROM gratuities WHERE user_cod = $1 AND status = 'ativa' AND remaining > 0 ORDER BY created_at ASC LIMIT 1",
          [userCod]
        );
      }
    } else {
      gratuityQuery = await client.query(
        "SELECT * FROM gratuities WHERE user_cod = $1 AND status = 'ativa' AND remaining > 0 ORDER BY created_at ASC LIMIT 1",
        [userCod]
      );
    }
    
    const hasGratuity = gratuityQuery.rows.length > 0;
    let gratuityId = null;
    let feeAmount = requestedAmount * 0.045;
    let finalAmount = requestedAmount - feeAmount;

    if (hasGratuity) {
      gratuityId = gratuityQuery.rows[0].id;
      feeAmount = 0;
      finalAmount = requestedAmount;

      const newRemaining = gratuityQuery.rows[0].remaining - 1;
      if (newRemaining <= 0) {
        await client.query(
          "UPDATE gratuities SET remaining = 0, status = 'expirada', expired_at = NOW() WHERE id = $1",
          [gratuityId]
        );
      } else {
        await client.query(
          'UPDATE gratuities SET remaining = $1 WHERE id = $2',
          [newRemaining, gratuityId]
        );
      }
    }

    const result = await client.query(
      `INSERT INTO withdrawal_requests 
       (user_cod, user_name, cpf, pix_key, requested_amount, fee_amount, final_amount, has_gratuity, gratuity_id, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aguardando_aprovacao') 
       RETURNING *`,
      [userCod, userName, cpf, pixKey, requestedAmount, feeAmount, finalAmount, hasGratuity, gratuityId]
    );

    await client.query('COMMIT');
    client.release();

    // Invalidar cache
    invalidateCache();

    // Registrar auditoria
    await registrarAuditoria(req, 'WITHDRAWAL_CREATE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', result.rows[0].id, {
      valor: requestedAmount,
      taxa: feeAmount,
      valor_final: finalAmount,
      gratuidade: hasGratuity,
      restrito: false
    });

    // Notificar via WebSocket
    if (global.notifyNewWithdrawal) {
      global.notifyNewWithdrawal(result.rows[0]);
    }

    res.status(201).json({ 
      ...result.rows[0], 
      isRestricted: false 
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    try { client.release(); } catch (e) { /* ignore */ }
    console.error('❌ Erro ao criar saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar saques do usuário
router.get('/withdrawals/user/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // Usuário só pode ver seus próprios saques (exceto admin)
    if (req.user.role !== 'admin' && req.user.role !== 'admin_master' && req.user.role !== 'admin_financeiro') {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM withdrawal_requests WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    // Adicionar verificação de atraso (mais de 1 hora)
    const now = new Date();
    const withdrawals = result.rows.map(w => {
      const createdAt = new Date(w.created_at);
      const diffMs = now - createdAt;
      const diffHours = diffMs / (1000 * 60 * 60);
      
      return {
        ...w,
        isDelayed: w.status === 'aguardando_aprovacao' && diffHours > 1
      };
    });

    res.json(withdrawals);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: error.message });
  }
});

// ⚡ CONTADORES — com cache de 30s
router.get('/withdrawals/counts', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    // Retornar cache se válido
    if (cache.counts.data && Date.now() - cache.counts.timestamp < CACHE_TTL) {
      return res.json(cache.counts.data);
    }
    
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('pending','aguardando_aprovacao')) as aguardando,
        COUNT(*) FILTER (WHERE status = 'approved') as aprovadas,
        COUNT(*) FILTER (WHERE status = 'approved' AND tipo_pagamento = 'gratuidade') as gratuidade,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejeitadas,
        COUNT(*) FILTER (WHERE status = 'inactive') as inativo,
        COUNT(*) FILTER (WHERE status IN ('pending','aguardando_aprovacao') AND created_at < NOW() - INTERVAL '1 hour') as atrasadas,
        COUNT(*) as total
      FROM withdrawal_requests
      WHERE created_at >= NOW() - INTERVAL '90 days'
    `);
    
    cache.counts = { data: result.rows[0], timestamp: Date.now() };
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro counts:', error);
    res.status(500).json({ error: error.message });
  }
});

// ⚡ Listar saques — COM CACHE 30s + SEM LEFT JOIN pesado
router.get('/withdrawals', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status, limit, dias, page, offset: offsetParam, dataInicio, dataFim, tipoFiltro } = req.query;
    
    // Com filtro de data (validação/conciliação) retorna todos os registros do período sem cap
    const maxLimit = (dataInicio && dataFim) ? 999999 : 200;
    const limiteFiltro = parseInt(limit) ? Math.min(parseInt(limit), maxLimit) : (dataInicio && dataFim ? maxLimit : 200);
    const diasFiltro = parseInt(dias) || 90;
    const offset = parseInt(offsetParam) || ((parseInt(page) || 1) - 1) * limiteFiltro;
    
    // Chave de cache baseada nos parâmetros
    const cacheKey = `${status || 'all'}-${limiteFiltro}-${diasFiltro}-${offset}-${dataInicio||''}-${dataFim||''}-${tipoFiltro||''}`;
    
    // ⚡ Retornar cache se mesma query em 30s
    if (cache.withdrawals.key === cacheKey && cache.withdrawals.data && Date.now() - cache.withdrawals.timestamp < CACHE_TTL) {
      console.log('⚡ Cache hit: withdrawals');
      return res.json(cache.withdrawals.data);
    }
    
    let conditions = [];
    let params = [];
    let paramIdx = 1;
    
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    
    // Filtro por data customizada (validação)
    if (dataInicio && dataFim) {
      const coluna = tipoFiltro === 'lancamento' ? 'lancamento_at' : tipoFiltro === 'debito' ? 'debito_plific_at' : 'created_at';
      conditions.push(`${coluna} >= $${paramIdx}::date AND ${coluna} < ($${paramIdx + 1}::date + INTERVAL '1 day')`);
      params.push(dataInicio, dataFim);
      paramIdx += 2;
    } else {
      conditions.push(`created_at >= NOW() - INTERVAL '1 day' * $${paramIdx++}`);
      params.push(diasFiltro);
    }
    
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    
    // Com filtro de datas: sem LIMIT (retorna tudo do período)
    // Sem filtro de datas: usa LIMIT para performance
    let query;
    if (dataInicio && dataFim) {
      query = `
        SELECT * FROM withdrawal_requests
        ${where}
        ORDER BY created_at DESC
      `;
      console.log(`📋 [withdrawals] Buscando todos os registros do período ${dataInicio} a ${dataFim}`);
    } else {
      query = `
        SELECT * FROM withdrawal_requests
        ${where}
        ORDER BY created_at DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx}
      `;
      params.push(limiteFiltro, offset);
    }

    // Executar em paralelo: saques + mapa de restritos
    const [result, restrictedMap] = await Promise.all([
      pool.query(query, params),
      getRestrictedMap()
    ]);
    
    const enriched = enrichWithRestrictions(result.rows, restrictedMap);
    
    // Salvar no cache
    cache.withdrawals = { data: enriched, timestamp: Date.now(), key: cacheKey };
    
    res.json(enriched);
  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar status do saque - COM PROTEÇÃO CONTRA DÉBITO DUPLICADO
router.patch('/withdrawals/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  const client = await pool.connect(); // Usar transação para atomicidade
  
  try {
    const { id } = req.params;
    const { status, adminId, adminName, rejectReason, dataDebito, idempotencyKey } = req.body;
    
    console.log('📅 dataDebito recebido do frontend:', dataDebito);
    console.log('🔑 idempotencyKey:', idempotencyKey);

    // =============== PROTEÇÃO 1: VERIFICAR IDEMPOTÊNCIA ===============
    // Se uma chave de idempotência foi enviada, verificar se já foi processada
    if (idempotencyKey) {
      const idempotenciaExistente = await client.query(
        `SELECT * FROM withdrawal_idempotency WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      
      if (idempotenciaExistente.rows.length > 0) {
        console.log(`⚠️ Requisição duplicada detectada! Key: ${idempotencyKey}`);
        client.release();
        // Retornar a resposta anterior (idempotência)
        return res.status(200).json({
          ...idempotenciaExistente.rows[0].response_data,
          _idempotent: true,
          _message: 'Requisição já processada anteriormente'
        });
      }
    }

    // Iniciar transação
    await client.query('BEGIN');

    // =============== PROTEÇÃO 2: LOCK PARA EVITAR RACE CONDITION ===============
    // Buscar dados do saque COM LOCK (FOR UPDATE)
    const saqueAtual = await client.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    
    if (saqueAtual.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Saque não encontrado' });
    }
    
    const dadosSaque = saqueAtual.rows[0];
    const isAprovado = status === 'aprovado' || status === 'aprovado_gratuidade';

    // =============== PROTEÇÃO 3: VERIFICAR STATUS ANTERIOR ===============
    // Só permitir aprovar se estiver aguardando
    if (isAprovado) {
      // Verificar se já está aprovado
      if (dadosSaque.status === 'aprovado' || dadosSaque.status === 'aprovado_gratuidade') {
        console.log(`⚠️ Tentativa de aprovar saque já aprovado! ID: ${id}, Status atual: ${dadosSaque.status}`);
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ 
          error: 'Este saque já foi aprovado anteriormente',
          status_atual: dadosSaque.status,
          aprovado_em: dadosSaque.approved_at
        });
      }
      
      // Verificar se já tem débito registrado
      if (dadosSaque.debito_plific_at) {
        console.log(`⚠️ Saque já teve débito realizado! ID: ${id}, Débito em: ${dadosSaque.debito_plific_at}`);
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ 
          error: 'Débito já foi realizado para este saque',
          debito_em: dadosSaque.debito_plific_at
        });
      }
      
      // Verificar se está em processamento (flag de lock)
      if (dadosSaque.processing_lock) {
        const lockAge = Date.now() - new Date(dadosSaque.processing_lock).getTime();
        // Se o lock tem menos de 60 segundos, rejeitar
        if (lockAge < 60000) {
          console.log(`⚠️ Saque em processamento! ID: ${id}, Lock há: ${lockAge}ms`);
          await client.query('ROLLBACK');
          client.release();
          return res.status(409).json({ 
            error: 'Este saque está sendo processado. Aguarde alguns segundos.',
            processing_since: dadosSaque.processing_lock
          });
        }
        // Se o lock é muito antigo, considerar como falha anterior e continuar
        console.log(`🔓 Lock antigo removido (${lockAge}ms). Continuando processamento.`);
      }
    }

    // =============== PROTEÇÃO 4: MARCAR COMO EM PROCESSAMENTO ===============
    if (isAprovado) {
      await client.query(
        `UPDATE withdrawal_requests SET processing_lock = NOW() WHERE id = $1`,
        [id]
      );
    }

    // =============== ATUALIZAR STATUS NO BANCO IMEDIATAMENTE ===============
    // A chamada Plific roda em background — não bloqueia a resposta ao admin
    const debitoPlificAt = isAprovado ? (dataDebito || new Date().toISOString()) : null;

    const result = await client.query(
      `UPDATE withdrawal_requests 
       SET status = $1, 
           admin_id = $2, 
           admin_name = $3, 
           reject_reason = $4, 
           approved_at = CASE WHEN $5 THEN NOW() ELSE approved_at END,
           lancamento_at = CASE WHEN $5 THEN NOW() ELSE lancamento_at END,
           debito_plific_at = CASE WHEN $5 THEN $7::timestamp ELSE debito_plific_at END,
           processing_lock = NULL,
           updated_at = NOW() 
       WHERE id = $6 
       RETURNING *`,
      [status, adminId, adminName, rejectReason || null, isAprovado, id, debitoPlificAt]
    );

    // =============== PROTEÇÃO 5: SALVAR IDEMPOTÊNCIA ===============
    if (idempotencyKey && result.rows.length > 0) {
      try {
        await client.query(
          `INSERT INTO withdrawal_idempotency (idempotency_key, withdrawal_id, response_data, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [idempotencyKey, id, JSON.stringify(result.rows[0])]
        );
      } catch (idempErr) {
        console.log('⚠️ Aviso: Não foi possível salvar idempotência:', idempErr.message);
      }
    }

    // Commit da transação — status já salvo
    await client.query('COMMIT');
    client.release();

    // ⚡ Invalidar cache
    invalidateCache();

    const saque = result.rows[0];

    // ==================== RESPONDER IMEDIATAMENTE ====================
    res.json(saque);

    // Notificar via WebSocket (imediato, não espera Plific)
    if (global.notifyWithdrawalUpdate) {
      global.notifyWithdrawalUpdate(saque, status);
    }

    // Auditoria em background
    registrarAuditoria(req, `WITHDRAWAL_${status.toUpperCase()}`, AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', id, {
      user_cod: saque.user_cod,
      valor: saque.requested_amount,
      admin: adminName,
      motivo_rejeicao: rejectReason,
      idempotency_key: idempotencyKey
    }).catch(err => console.error('❌ Erro auditoria:', err));

    // ==================== PLIFIC EM BACKGROUND ====================
    // Roda depois da resposta enviada — zero impacto no tempo de resposta
    if (isAprovado) {
      (async () => {
        try {
          const valorDebito = parseFloat(dadosSaque.requested_amount);
          const idProf = dadosSaque.user_cod;
          const descricaoDebito = status === 'aprovado_gratuidade'
            ? 'Saque Emergencial - Gratuito'
            : 'Saque emergencial - Prestação de Serviços';
          const dataDebitoFormatada = dataDebito ? dataDebito.split('T')[0] : new Date().toISOString().split('T')[0];

          console.log(`💳 [BG] Débito Plific - Prof: ${idProf}, Valor: ${valorDebito}, Data: ${dataDebitoFormatada}`);

          const responseDebito = await fetch(`${helpers.PLIFIC_BASE_URL}/lancarDebitoProfissional`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${helpers.PLIFIC_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              idProf: parseInt(idProf),
              valor: valorDebito,
              descricao: descricaoDebito,
              data: dataDebitoFormatada
            })
          });

          const respostaDebito = await responseDebito.json();

          if (respostaDebito.status !== '200' && respostaDebito.status !== 200) {
            console.error(`❌ [BG] Falha Plific saque ${id}:`, respostaDebito);
            // Registrar falha no banco para reprocessamento manual
            await pool.query(
              `UPDATE withdrawal_requests SET debito_plific_at = NULL WHERE id = $1`,
              [id]
            ).catch(e => console.error('❌ Erro ao registrar falha:', e));
          } else {
            console.log(`✅ [BG] Débito Plific OK - Prof: ${idProf}`);
            helpers.plificSaldoCache.delete(`saldo_${idProf}`);
          }
        } catch (erroDebito) {
          console.error(`❌ [BG] Exceção Plific saque ${id}:`, erroDebito.message);
        }
      })();
    }

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('❌ Erro no rollback:', rollbackErr);
    }
    console.error('❌ Erro ao atualizar saque:', error);
    // Só responde se ainda não respondeu
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  } finally {
    // client.release() só se não foi liberado ainda
    try { client.release(); } catch (_) {}
  }
});

// Excluir saque
router.delete('/withdrawals/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar dados antes de excluir para auditoria
    const saqueAntes = await pool.query('SELECT * FROM withdrawal_requests WHERE id = $1', [id]);

    const result = await pool.query(
      'DELETE FROM withdrawal_requests WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    // Registrar auditoria
    await registrarAuditoria(req, 'WITHDRAWAL_DELETE', AUDIT_CATEGORIES.FINANCIAL, 'withdrawals', id, {
      user_cod: result.rows[0].user_cod,
      valor: result.rows[0].requested_amount,
      status_anterior: result.rows[0].status
    });

    console.log('🗑️ Saque excluído:', id);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao excluir saque:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar conciliação/débito
router.patch('/withdrawals/:id/conciliacao', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { conciliacaoOmie, debito } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET conciliacao_omie = COALESCE($1, conciliacao_omie), 
           debito = COALESCE($2, debito),
           updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [conciliacaoOmie, debito, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar conciliação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar débito com data/hora
router.patch('/withdrawals/:id/debito', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { debito, debitoAt } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET debito = $1, debito_at = $2, updated_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [debito, debitoAt, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💳 Débito atualizado:', id, debito, debitoAt);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar débito:', error);
    res.status(500).json({ error: error.message });
  }
});

// Atualizar status do saldo
router.patch('/withdrawals/:id/saldo', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { saldoStatus } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests 
       SET saldo_status = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [saldoStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saque não encontrado' });
    }

    console.log('💰 Saldo status atualizado:', id, saldoStatus);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao atualizar saldo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dashboard de conciliação (PROTEGIDO - apenas admin financeiro)
router.get('/withdrawals/dashboard/conciliacao', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')) as total_aprovados,
        COUNT(*) FILTER (WHERE conciliacao_omie = true) as total_conciliado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND conciliacao_omie = false) as pendente_conciliacao,
        COUNT(*) FILTER (WHERE debito = true) as total_debitado,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade') AND debito = false) as pendente_debito,
        COALESCE(SUM(final_amount) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade')), 0) as valor_total_aprovado,
        COALESCE(SUM(final_amount) FILTER (WHERE conciliacao_omie = true), 0) as valor_conciliado,
        COALESCE(SUM(final_amount) FILTER (WHERE debito = true), 0) as valor_debitado
      FROM withdrawal_requests
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao obter dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GRATUIDADES
// ============================================

// Listar todas as gratuidades

  return router;
}

module.exports = { createWithdrawalsRoutes };
