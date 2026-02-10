/**
 * Sub-Router: Gratuities + Restricted + Plific
 */
const express = require('express');

function createExtrasRoutes(pool, verificarToken, verificarAdminOuFinanceiro, helpers) {
  const router = express.Router();

router.get('/gratuities', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status, limit } = req.query;
    // ⚡ PERFORMANCE: Limitar resultados (padrão 200, máx 500)
    const safeLimit = Math.min(parseInt(limit) || 200, 500);
    
    let query, params;
    if (status) {
      query = 'SELECT * FROM gratuities WHERE status = $1 ORDER BY created_at DESC LIMIT $2';
      params = [status, safeLimit];
    } else {
      query = 'SELECT * FROM gratuities ORDER BY created_at DESC LIMIT $1';
      params = [safeLimit];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar gratuidades do usuário (PROTEGIDO)
router.get('/gratuities/user/:userCod', verificarToken, async (req, res) => {
  try {
    const { userCod } = req.params;
    
    // SEGURANÇA: Apenas o próprio usuário ou admin podem ver gratuidades
    if (!['admin', 'admin_master', 'admin_financeiro'].includes(req.user.role)) {
      if (req.user.codProfissional !== userCod) {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    }
    
    const result = await pool.query(
      'SELECT * FROM gratuities WHERE user_cod = $1 ORDER BY created_at DESC',
      [userCod]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar gratuidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar gratuidade
router.post('/gratuities', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { userCod, userName, quantity, value, reason, createdBy } = req.body;

    const result = await pool.query(
      `INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, 'ativa', $7) 
       RETURNING *`,
      [userCod, userName || null, quantity, quantity, value, reason || null, createdBy || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao criar gratuidade:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deletar gratuidade
router.delete('/gratuities/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM gratuities WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gratuidade não encontrada' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao deletar gratuidade:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PROFISSIONAIS RESTRITOS
// ============================================

// Listar todos os restritos
router.get('/restricted', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM restricted_professionals ORDER BY created_at DESC';
    if (status) {
      query = 'SELECT * FROM restricted_professionals WHERE status = $1 ORDER BY created_at DESC';
    }

    const result = status 
      ? await pool.query(query, [status])
      : await pool.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao listar restritos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar se usuário está restrito
router.get('/restricted/check/:userCod', async (req, res) => {
  try {
    const { userCod } = req.params;
    
    const result = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    res.json({ 
      isRestricted: result.rows.length > 0,
      restriction: result.rows[0] || null
    });
  } catch (error) {
    console.error('❌ Erro ao verificar restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// Adicionar restrição
router.post('/restricted', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { userCod, userName, reason, createdBy } = req.body;

    // Verificar se já existe e está ativo
    const existing = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status = 'ativo'",
      [userCod]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Profissional já está restrito' });
    }

    // Verificar se existe registro inativo (para reativar)
    const inactive = await pool.query(
      "SELECT * FROM restricted_professionals WHERE user_cod = $1 AND status != 'ativo'",
      [userCod]
    );

    let result;
    if (inactive.rows.length > 0) {
      // Reativar registro existente
      result = await pool.query(
        `UPDATE restricted_professionals 
         SET user_name = $2, reason = $3, status = 'ativo', created_by = $4, created_at = NOW(), removed_at = NULL, removed_reason = NULL
         WHERE user_cod = $1
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    } else {
      // Criar novo registro
      result = await pool.query(
        `INSERT INTO restricted_professionals (user_cod, user_name, reason, status, created_by) 
         VALUES ($1, $2, $3, 'ativo', $4) 
         RETURNING *`,
        [userCod, userName || null, reason, createdBy || null]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao adicionar restrição:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remover restrição
router.patch('/restricted/:id/remove', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
  try {
    const { id } = req.params;
    const { removedReason } = req.body;

    const result = await pool.query(
      `UPDATE restricted_professionals 
       SET status = 'removido', removed_at = NOW(), removed_reason = $1 
       WHERE id = $2 
       RETURNING *`,
      [removedReason || 'Restrição suspensa', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restrição não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erro ao remover restrição:', error);
    res.status(500).json({ error: error.message });
  }
});



  // ==================== PLIFIC ENDPOINTS ====================

router.get('/plific/saldo/:idProf', verificarToken, async (req, res) => {
    try {
        const { idProf } = req.params;
        const forceRefresh = req.query.refresh === 'true';
        
        if (!idProf || isNaN(parseInt(idProf))) {
            return res.status(400).json({ error: 'ID do profissional inválido', details: 'O idProf deve ser um número válido' });
        }

        const cacheKey = `saldo_${idProf}`;
        if (!forceRefresh && helpers.plificSaldoCache.has(cacheKey)) {
            const cached = helpers.plificSaldoCache.get(cacheKey);
            if (Date.now() - cached.timestamp < helpers.PLIFIC_CONFIG.CACHE_TTL) {
                console.log(`📦 Plific: Saldo do profissional ${idProf} retornado do cache`);
                return res.json({ ...cached.data, fromCache: true, cacheAge: Math.round((Date.now() - cached.timestamp) / 1000) });
            }
        }

        const url = `${helpers.PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${idProf}`;
        console.log(`🔍 Plific: Consultando saldo do profissional ${idProf}...`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${helpers.PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.status === '401') {
            console.error('❌ Plific: Token inválido');
            return res.status(401).json({ error: 'Token Plific inválido', details: data.msgUsuario || 'Verifique a configuração do token' });
        }

        if (data.dados && data.dados.status === false) {
            return res.status(404).json({ error: 'Profissional não encontrado', details: data.dados.msg || 'ID não existe na base Plific' });
        }

        // Converter saldo de formato brasileiro (1.000,00) para número
        const profissionalData = data.dados?.profissional || null;
        if (profissionalData && profissionalData.saldo) {
            // Remove pontos de milhar e troca vírgula por ponto
            const saldoStr = String(profissionalData.saldo);
            profissionalData.saldoOriginal = saldoStr;
            profissionalData.saldo = parseFloat(saldoStr.replace(/\./g, '').replace(',', '.')) || 0;
        }
        
        const resultado = {
            success: true,
            profissional: profissionalData,
            ambiente: helpers.PLIFIC_AMBIENTE,
            consultadoEm: new Date().toISOString()
        };

        helpers.plificSaldoCache.set(cacheKey, { data: resultado, timestamp: Date.now() });
        console.log(`✅ Plific: Saldo do profissional ${idProf} = R$ ${resultado.profissional?.saldo || 0}`);
        
        await registrarAuditoria(req, 'CONSULTA_SALDO_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_saldo', idProf, { saldo: resultado.profissional?.saldo, ambiente: helpers.PLIFIC_AMBIENTE });

        res.json(resultado);
    } catch (error) {
        console.error('❌ Erro ao consultar saldo Plific:', error.message);
        res.status(500).json({ error: 'Erro ao consultar saldo', details: error.message });
    }
});

// Buscar Saldos em Lote
router.post('/plific/saldos-lote', verificarToken, async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Lista de IDs inválida', details: 'Envie um array de IDs no corpo da requisição' });
        }

        if (ids.length > 100) {
            return res.status(400).json({ error: 'Limite excedido', details: 'Máximo de 100 profissionais por requisição' });
        }

        console.log(`🔍 Plific: Consultando saldo de ${ids.length} profissionais em lote...`);

        const resultados = [];
        const BATCH_SIZE = helpers.PLIFIC_CONFIG.RATE_LIMIT;
        
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const batch = ids.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (idProf) => {
                const cacheKey = `saldo_${idProf}`;
                if (helpers.plificSaldoCache.has(cacheKey)) {
                    const cached = helpers.plificSaldoCache.get(cacheKey);
                    if (Date.now() - cached.timestamp < helpers.PLIFIC_CONFIG.CACHE_TTL) {
                        return { idProf, ...cached.data.profissional, fromCache: true };
                    }
                }

                try {
                    const url = `${helpers.PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${idProf}`;
                    const response = await fetch(url, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${helpers.PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
                    });

                    const data = await response.json();

                    if (data.status === '200' && data.dados?.status === true) {
                        helpers.plificSaldoCache.set(cacheKey, { data: { profissional: data.dados.profissional }, timestamp: Date.now() });
                        return { idProf, ...data.dados.profissional, fromCache: false };
                    } else {
                        return { idProf, erro: data.dados?.msg || 'Não encontrado', saldo: null };
                    }
                } catch (err) {
                    return { idProf, erro: err.message, saldo: null };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            resultados.push(...batchResults);

            if (i + BATCH_SIZE < ids.length) {
                await new Promise(resolve => setTimeout(resolve, helpers.PLIFIC_CONFIG.RATE_LIMIT_WINDOW));
            }
        }

        const sucessos = resultados.filter(r => r.saldo !== null && !r.erro);
        const falhas = resultados.filter(r => r.saldo === null || r.erro);

        console.log(`✅ Plific: Lote concluído - ${sucessos.length} sucesso(s), ${falhas.length} falha(s)`);
        await registrarAuditoria(req, 'CONSULTA_SALDOS_LOTE_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_saldo_lote', null, { total: ids.length, sucessos: sucessos.length, falhas: falhas.length, ambiente: helpers.PLIFIC_AMBIENTE });

        res.json({ success: true, total: ids.length, sucessos: sucessos.length, falhas: falhas.length, resultados, ambiente: helpers.PLIFIC_AMBIENTE, consultadoEm: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Erro ao consultar saldos em lote Plific:', error.message);
        res.status(500).json({ error: 'Erro ao consultar saldos em lote', details: error.message });
    }
});

// Lançar Débito
router.post('/plific/lancar-debito', verificarToken, async (req, res) => {
    try {
        const { idProf, valor, descricao } = req.body;
        
        if (!idProf || isNaN(parseInt(idProf))) {
            return res.status(400).json({ error: 'ID do profissional inválido', details: 'O idProf deve ser um número válido' });
        }
        if (!valor || isNaN(parseFloat(valor)) || parseFloat(valor) <= 0) {
            return res.status(400).json({ error: 'Valor inválido', details: 'O valor deve ser um número positivo' });
        }
        if (!descricao || descricao.trim().length === 0) {
            return res.status(400).json({ error: 'Descrição obrigatória', details: 'Informe uma descrição para o débito' });
        }

        const url = `${helpers.PLIFIC_BASE_URL}/lancarDebitoProfissional`;
        console.log(`💳 Plific: Lançando débito de R$ ${valor} para profissional ${idProf}...`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${helpers.PLIFIC_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ idProf: parseInt(idProf), valor: parseFloat(valor), descricao: descricao.trim() })
        });

        const data = await response.json();

        if (data.status === '401') {
            console.error('❌ Plific: Token inválido ao lançar débito');
            return res.status(401).json({ error: 'Token Plific inválido', details: data.msgUsuario || 'Verifique a configuração do token' });
        }

        if (data.dados?.status === 'erro') {
            console.error('❌ Plific: Erro ao lançar débito:', data.dados.mensagem);
            return res.status(400).json({ error: 'Erro ao lançar débito', details: data.dados.mensagem || 'Erro na validação dos parâmetros', erros: data.dados.erros });
        }

        const cacheKey = `saldo_${idProf}`;
        helpers.plificSaldoCache.delete(cacheKey);

        console.log(`✅ Plific: Débito de R$ ${valor} lançado com sucesso para profissional ${idProf}`);
        await registrarAuditoria(req, 'LANCAR_DEBITO_PLIFIC', AUDIT_CATEGORIES.FINANCIAL, 'plific_debito', idProf, { valor: parseFloat(valor), descricao: descricao.trim(), ambiente: helpers.PLIFIC_AMBIENTE });

        res.json({ success: true, mensagem: data.dados?.mensagem || 'Débito lançado com sucesso', ambiente: helpers.PLIFIC_AMBIENTE, lancadoEm: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Erro ao lançar débito Plific:', error.message);
        res.status(500).json({ error: 'Erro ao lançar débito', details: error.message });
    }
});

// Buscar Profissionais para Consulta
router.get('/plific/profissionais', verificarToken, async (req, res) => {
    try {
        const { regiao, limite } = req.query;
        
        let query = `SELECT DISTINCT s.user_cod as id, s.user_name as nome, s.regiao FROM withdrawal_requests s WHERE s.user_cod IS NOT NULL`;
        const params = [];
        let paramIndex = 1;

        if (regiao) {
            query += ` AND s.regiao = $${paramIndex++}`;
            params.push(regiao);
        }

        query += ` ORDER BY s.user_name ASC`;
        
        if (limite) {
            query += ` LIMIT $${paramIndex}`;
            params.push(parseInt(limite));
        }

        const result = await pool.query(query, params);
        res.json({ success: true, total: result.rows.length, profissionais: result.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar profissionais:', error.message);
        res.status(500).json({ error: 'Erro ao buscar profissionais', details: error.message });
    }
});

// Listar todos os profissionais com saldo (do banco local + API Plific)
router.get('/plific/saldos-todos', verificarToken, async (req, res) => {
    try {
        const { pagina = 1, porPagina = 20 } = req.query;
        const paginaNum = parseInt(pagina);
        const porPaginaNum = Math.min(parseInt(porPagina), 50); // máximo 50 por página
        
        // Buscar todos os profissionais únicos que já fizeram saque
        const queryProfs = `
            SELECT s.user_cod as codigo, MAX(s.user_name) as nome 
            FROM withdrawal_requests s 
            WHERE s.user_cod IS NOT NULL AND s.user_name IS NOT NULL
            GROUP BY s.user_cod
            ORDER BY MAX(s.user_name) ASC
        `;
        const resultProfs = await pool.query(queryProfs);
        const profissionais = resultProfs.rows;
        
        if (profissionais.length === 0) {
            return res.json({ 
                success: true, 
                profissionais: [], 
                total: 0, 
                pagina: paginaNum, 
                porPagina: porPaginaNum, 
                totalPaginas: 0 
            });
        }
        
        // Buscar saldos de todos os profissionais na API Plific
        const resultados = [];
        for (const prof of profissionais) {
            try {
                // Verificar cache primeiro
                const cacheKey = `saldo_${prof.codigo}`;
                if (helpers.plificSaldoCache.has(cacheKey)) {
                    const cached = helpers.plificSaldoCache.get(cacheKey);
                    if (Date.now() - cached.timestamp < helpers.PLIFIC_CONFIG.CACHE_TTL) {
                        const saldoCached = cached.data.profissional?.saldo;
                        const saldoNum = typeof saldoCached === 'string' 
                            ? parseFloat(saldoCached.replace(/\./g, '').replace(',', '.')) || 0
                            : parseFloat(saldoCached || 0);
                        resultados.push({
                            codigo: prof.codigo,
                            nome: prof.nome,
                            saldo: saldoNum,
                            cpf: cached.data.profissional?.cpf || null
                        });
                        continue;
                    }
                }
                
                // Buscar da API
                const url = `${helpers.PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${prof.codigo}`;
                const response = await fetch(url, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${helpers.PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
                });
                const data = await response.json();
                
                if (data.status === '200' || data.status === 200) {
                    const profData = data.dados?.profissional || null;
                    let saldoNum = 0;
                    if (profData && profData.saldo) {
                        const saldoStr = String(profData.saldo);
                        saldoNum = parseFloat(saldoStr.replace(/\./g, '').replace(',', '.')) || 0;
                    }
                    
                    resultados.push({
                        codigo: prof.codigo,
                        nome: profData?.nome || prof.nome,
                        saldo: saldoNum,
                        cpf: profData?.cpf || null
                    });
                    
                    // Cachear resultado
                    helpers.plificSaldoCache.set(cacheKey, { 
                        data: { profissional: { ...profData, saldo: saldoNum } }, 
                        timestamp: Date.now() 
                    });
                }
                
                // Rate limit - pequena pausa entre requisições
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (err) {
                console.error(`Erro ao buscar saldo do prof ${prof.codigo}:`, err.message);
            }
        }
        
        // Ordenar por saldo (maior para menor)
        resultados.sort((a, b) => b.saldo - a.saldo);
        
        // Paginação
        const total = resultados.length;
        const totalPaginas = Math.ceil(total / porPaginaNum);
        const inicio = (paginaNum - 1) * porPaginaNum;
        const fim = inicio + porPaginaNum;
        const profissionaisPaginados = resultados.slice(inicio, fim);
        
        res.json({ 
            success: true, 
            profissionais: profissionaisPaginados, 
            total, 
            pagina: paginaNum, 
            porPagina: porPaginaNum, 
            totalPaginas,
            somaTotal: resultados.reduce((acc, p) => acc + p.saldo, 0)
        });
        
    } catch (error) {
        console.error('❌ Erro ao buscar saldos:', error.message);
        res.status(500).json({ error: 'Erro ao buscar saldos', details: error.message });
    }
});

// Status da Integração
router.get('/plific/status', verificarToken, async (req, res) => {
    try {
        const testId = helpers.PLIFIC_AMBIENTE === 'teste' ? '8888' : '1';
        const url = `${helpers.PLIFIC_BASE_URL}/buscarSaldoProf?idProf=${testId}`;
        
        const startTime = Date.now();
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${helpers.PLIFIC_TOKEN}`, 'Content-Type': 'application/json' }
        });
        const latency = Date.now() - startTime;

        const data = await response.json();
        const tokenValido = data.status !== '401';
        const apiOnline = response.ok;

        res.json({
            success: true,
            status: { apiOnline, tokenValido, latencia: `${latency}ms`, ambiente: helpers.PLIFIC_AMBIENTE, baseUrl: helpers.PLIFIC_BASE_URL, cacheSize: helpers.plificSaldoCache.size, cacheTTL: `${helpers.PLIFIC_CONFIG.CACHE_TTL / 1000}s` }
        });
    } catch (error) {
        res.json({ success: false, status: { apiOnline: false, tokenValido: false, erro: error.message, ambiente: helpers.PLIFIC_AMBIENTE } });
    }
});

console.log('✅ Módulo Plific carregado!');

// ==================== FIM INTEGRAÇÃO PLIFIC ====================


console.log('✅ Módulo de Auditoria carregado!');

// =====================================================
// SISTEMA DE SOLICITAÇÃO DE CORRIDAS - INTEGRAÇÃO TUTTS
// =====================================================

  return router;

  return router;
}

module.exports = { createExtrasRoutes };
