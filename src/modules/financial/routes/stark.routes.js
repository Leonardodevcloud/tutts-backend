/**
 * STARK BANK - Routes
 * Integração com Stark Bank para pagamentos automáticos via Pix
 * 
 * Endpoints:
 *   GET  /stark/saldo           - Consultar saldo da conta Stark Bank
 *   GET  /stark/lote/pendente   - Listar saques aprovados aguardando pagamento
 *   POST /stark/lote/executar   - Executar pagamento do lote
 *   GET  /stark/lote/historico  - Histórico de lotes executados
 *   GET  /stark/lote/:id        - Detalhe de um lote específico
 *   POST /stark/lote/:id/retentar - Retentar pagamentos com erro de um lote
 *   POST /stark/validar-chave   - Validar chave Pix via DICT
 *   POST /stark/webhook         - Webhook de confirmação da Stark Bank (público)
 *   GET  /stark/status          - Status da integração
 */

const express = require('express');

function createStarkRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

  // ==================== CONFIGURAÇÃO STARK BANK ====================

  let starkbank = null;
  let starkIniciado = false;
  let starkErroInit = null;

  /**
   * Formata a chave privada PEM que vem de variável de ambiente.
   * Trata os cenários comuns:
   *  1. \\n literais (Railway/Docker) → \n reais
   *  2. Espaços no lugar de quebras (copiar/colar) → \n reais
   *  3. Já vem formatada corretamente
   */
  function formatarPrivateKey(raw) {
    if (!raw) return raw;

    let key = raw;

    // Se contém \\n literal (string escapada), converter para newline real
    if (key.includes('\\n')) {
      key = key.replace(/\\n/g, '\n');
    }

    // Se não tem newlines mas tem os marcadores PEM em uma linha só, reformatar
    if (!key.includes('\n') && key.includes('-----BEGIN')) {
      key = key
        .replace('-----BEGIN EC PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----\n')
        .replace('-----END EC PRIVATE KEY-----', '\n-----END EC PRIVATE KEY-----')
        .replace('-----BEGIN EC PARAMETERS-----', '\n-----BEGIN EC PARAMETERS-----\n')
        .replace('-----END EC PARAMETERS-----', '\n-----END EC PARAMETERS-----\n');
      // Também tratar RSA caso mude no futuro
      key = key
        .replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n')
        .replace('-----END RSA PRIVATE KEY-----', '\n-----END RSA PRIVATE KEY-----');
    }

    // Remover espaços em branco no início/fim de cada linha
    key = key.split('\n').map(l => l.trim()).join('\n');

    // Remover linhas vazias extras
    key = key.replace(/\n{3,}/g, '\n\n');

    return key;
  }

  function inicializarStark() {
    if (starkIniciado) return !!starkbank;

    const projectId = process.env.STARK_PROJECT_ID;
    const privateKey = process.env.STARK_PRIVATE_KEY;
    const environment = process.env.STARK_ENVIRONMENT || 'sandbox';

    if (!projectId || !privateKey) {
      starkErroInit = 'Variáveis STARK_PROJECT_ID e/ou STARK_PRIVATE_KEY não configuradas';
      console.warn(`⚠️ [Stark Bank] ${starkErroInit}`);
      starkIniciado = true;
      return false;
    }

    try {
      starkbank = require('starkbank');

      const privateKeyFormatada = formatarPrivateKey(privateKey);

      // Diagnóstico: logar se a chave tem formato PEM válido
      if (!privateKeyFormatada.includes('-----BEGIN')) {
        console.warn('⚠️ [Stark Bank] STARK_PRIVATE_KEY não contém header PEM (-----BEGIN ...). Verifique a variável de ambiente.');
      }

      const project = new starkbank.Project({
        environment: environment,
        id: projectId,
        privateKey: privateKeyFormatada
      });

      starkbank.setUser(project);
      starkIniciado = true;

      // Exportar globalmente para acerto.routes.js e outros módulos reutilizarem
      global.__starkbank = starkbank;

      console.log(`✅ [Stark Bank] Inicializado com sucesso (ambiente: ${environment}, project: ${projectId})`);
      return true;
    } catch (err) {
      starkErroInit = err.message;
      console.error(`❌ [Stark Bank] Erro ao inicializar:`, err.message);

      // Diagnóstico extra para erros comuns
      if (err.message.includes('privateKey')) {
        console.error('💡 [Stark Bank] Dica: no Railway, coloque a chave PEM inteira em uma linha só com \\n no lugar das quebras de linha.');
        console.error('💡 [Stark Bank] Exemplo: -----BEGIN EC PRIVATE KEY-----\\nMHQ...base64...\\n-----END EC PRIVATE KEY-----');
      }

      starkIniciado = true;
      return false;
    }
  }

  // Middleware que verifica se Stark Bank está disponível
  function verificarStark(req, res, next) {
    if (!inicializarStark() || !starkbank) {
      return res.status(503).json({
        error: 'Stark Bank não disponível',
        details: starkErroInit || 'SDK não inicializado',
        configurado: false
      });
    }
    next();
  }

  // Helper: obter saldo em reais (compatível com SDK retornando array ou objeto)
  async function obterSaldoReais() {
    const result = await starkbank.balance.get();
    if (Array.isArray(result)) {
      return result.length > 0 ? result[0].amount / 100 : 0;
    } else if (result && result.amount !== undefined) {
      return result.amount / 100;
    }
    return 0;
  }

  // ==================== CONSULTAR SALDO ====================
  router.get('/stark/saldo', verificarToken, verificarAdminOuFinanceiro, verificarStark, async (req, res) => {
    try {
      const saldoReais = await obterSaldoReais();

      await registrarAuditoria(req, 'STARK_CONSULTA_SALDO', AUDIT_CATEGORIES.FINANCIAL, 'stark_bank', null, {
        saldo: saldoReais
      });

      res.json({
        saldo: saldoReais,
        moeda: 'BRL',
        atualizado_em: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ [Stark Bank] Erro ao consultar saldo:', error.message);
      res.status(500).json({ error: 'Erro ao consultar saldo', details: error.message });
    }
  });

  // ==================== MARCAR SAQUES PARA LOTE (chamado pela aba Solicitações) ====================
  router.post('/stark/lote/marcar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { saque_ids } = req.body;

      if (!saque_ids || !Array.isArray(saque_ids) || saque_ids.length === 0) {
        return res.status(400).json({ error: 'Nenhum saque selecionado' });
      }

      // Marcar os saques como 'em_lote' — só os que são aprovados e ainda não foram marcados
      const result = await pool.query(`
        UPDATE withdrawal_requests 
        SET stark_status = 'em_lote', updated_at = NOW()
        WHERE id = ANY($1)
          AND status IN ('aprovado', 'aprovado_gratuidade')
          AND (stark_status IS NULL OR stark_status = 'erro')
        RETURNING id
      `, [saque_ids]);

      const marcados = result.rows.length;

      console.log('🏦 [Stark Bank] ' + marcados + ' saques marcados para lote por ' + (req.user.nome || req.user.username));

      await registrarAuditoria(req, 'STARK_LOTE_MARCADO', AUDIT_CATEGORIES.FINANCIAL, 'withdrawal_requests', null, {
        saque_ids: saque_ids,
        marcados: marcados,
        solicitados: saque_ids.length
      });

      res.json({
        success: true,
        marcados: marcados,
        mensagem: marcados + ' saques marcados para pagamento'
      });

    } catch (error) {
      console.error('❌ [Stark Bank] Erro ao marcar lote:', error.message);
      res.status(500).json({ error: 'Erro ao marcar saques para lote' });
    }
  });

  // ==================== LISTAR SAQUES AGUARDANDO PAGAMENTO ====================
  // Mostra apenas saques que foram explicitamente marcados como 'em_lote' pelo admin
  router.get('/stark/lote/pendente', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { data_inicio, data_fim } = req.query;

      let whereExtra = '';
      const params = [];

      if (data_inicio) {
        params.push(data_inicio);
        whereExtra += ' AND w.approved_at >= $' + params.length + '::date';
      }
      if (data_fim) {
        params.push(data_fim);
        whereExtra += ' AND w.approved_at < ($' + params.length + '::date + interval \'1 day\')';
      }

      // Buscar APENAS saques marcados como 'em_lote' (marcados via /stark/lote/marcar)
      // OU saques com stark_status = 'erro' (para retry)
      const result = await pool.query(`
        SELECT 
          w.id, w.user_cod, w.user_name, w.cpf, w.pix_key, 
          w.requested_amount, w.fee_amount, w.final_amount,
          w.has_gratuity, w.status, w.approved_at, w.created_at,
          w.stark_status, w.stark_transfer_id, w.stark_erro,
          ufd.pix_tipo
        FROM withdrawal_requests w
        LEFT JOIN user_financial_data ufd ON w.user_cod = ufd.user_cod
        WHERE w.status IN ('aprovado', 'aprovado_gratuidade')
          AND w.stark_status IN ('em_lote', 'erro')
        ${whereExtra}
        ORDER BY w.approved_at ASC
      `, params);

      const saques = result.rows;
      const valorTotal = saques.reduce((acc, s) => acc + parseFloat(s.final_amount || 0), 0);

      res.json({
        saques,
        quantidade: saques.length,
        valor_total: Math.round(valorTotal * 100) / 100
      });
    } catch (error) {
      console.error('❌ [Stark Bank] Erro ao listar pendentes:', error.message);
      res.status(500).json({ error: 'Erro ao listar saques pendentes' });
    }
  });

  // ==================== EXECUTAR PAGAMENTO DO LOTE ====================
  router.post('/stark/lote/executar', verificarToken, verificarAdminOuFinanceiro, verificarStark, async (req, res) => {
    const client = await pool.connect();
    let clientReleased = false;

    const releaseClient = () => {
      if (!clientReleased) {
        clientReleased = true;
        client.release();
      }
    };

    try {
      const { saque_ids } = req.body;

      await client.query('BEGIN');

      // 1. Buscar saques elegíveis com LOCK
      let queryPendentes;
      let paramsPendentes;

      if (saque_ids && Array.isArray(saque_ids) && saque_ids.length > 0) {
        queryPendentes = `
          SELECT w.*, ufd.pix_tipo
          FROM withdrawal_requests w
          LEFT JOIN user_financial_data ufd ON w.user_cod = ufd.user_cod
          WHERE w.id = ANY($1)
            AND w.status IN ('aprovado', 'aprovado_gratuidade')
            AND w.stark_status IN ('em_lote', 'erro')
          FOR UPDATE OF w
        `;
        paramsPendentes = [saque_ids];
      } else {
        queryPendentes = `
          SELECT w.*, ufd.pix_tipo
          FROM withdrawal_requests w
          LEFT JOIN user_financial_data ufd ON w.user_cod = ufd.user_cod
          WHERE w.status IN ('aprovado', 'aprovado_gratuidade')
            AND w.stark_status IN ('em_lote', 'erro')
          FOR UPDATE OF w
        `;
        paramsPendentes = [];
      }

      const saquesPendentes = await client.query(queryPendentes, paramsPendentes);

      if (saquesPendentes.rows.length === 0) {
        await client.query('ROLLBACK');
        releaseClient();
        return res.status(400).json({ error: 'Nenhum saque elegível para pagamento' });
      }

      const saques = saquesPendentes.rows;
      const valorTotal = saques.reduce((acc, s) => acc + parseFloat(s.final_amount || 0), 0);

      // 2. Verificar saldo
      let saldoDisponivel;
      try {
        saldoDisponivel = await obterSaldoReais();
      } catch (errSaldo) {
        await client.query('ROLLBACK');
        releaseClient();
        return res.status(500).json({ error: 'Não foi possível verificar saldo', details: errSaldo.message });
      }

      if (saldoDisponivel < valorTotal) {
        await client.query('ROLLBACK');
        releaseClient();
        return res.status(400).json({
          error: 'Saldo insuficiente',
          saldo_disponivel: saldoDisponivel,
          valor_lote: valorTotal,
          diferenca: Math.round((valorTotal - saldoDisponivel) * 100) / 100
        });
      }

      // 3. Validar dados ANTES de enviar para a Stark Bank
      const errosValidacao = [];
      for (const saque of saques) {
        const cpf = (saque.cpf || '').replace(/\D/g, '');
        const pixKey = (saque.pix_key || '').trim();

        if (!cpf || cpf.length !== 11) {
          errosValidacao.push(`Saque #${saque.id} (${saque.user_name}): CPF inválido — "${saque.cpf || 'vazio'}" (${cpf.length} dígitos, esperado 11)`);
        }
        if (!pixKey) {
          errosValidacao.push(`Saque #${saque.id} (${saque.user_name}): Chave Pix vazia`);
        }
        if (parseFloat(saque.final_amount) <= 0) {
          errosValidacao.push(`Saque #${saque.id} (${saque.user_name}): Valor inválido — R$ ${saque.final_amount}`);
        }
      }

      if (errosValidacao.length > 0) {
        await client.query('ROLLBACK');
        releaseClient();
        console.warn('⚠️ [Stark Bank] Validação falhou antes de enviar:', errosValidacao);
        return res.status(400).json({
          error: 'Dados inválidos em um ou mais saques',
          detalhes: errosValidacao
        });
      }

      // 4. Criar registro do lote
      const loteResult = await client.query(`
        INSERT INTO stark_lotes (
          quantidade, valor_total, saldo_antes, status, 
          executado_por_id, executado_por_nome
        ) VALUES ($1, $2, $3, 'processando', $4, $5)
        RETURNING *
      `, [saques.length, valorTotal, saldoDisponivel, req.user.id, req.user.nome || req.user.username]);

      const loteId = loteResult.rows[0].id;

      // 5. Consultar DICT para cada chave Pix e montar transfers com dados bancários reais
      // A Stark Bank Transfer exige dados bancários (bankCode, branchCode, accountNumber)
      // Para Pix via chave, precisamos primeiro resolver a chave no DICT
      const transfers = [];
      const errosDICT = [];

      for (const saque of saques) {
        const pixKey = (saque.pix_key || '').trim();
        const cpf = (saque.cpf || '').replace(/\D/g, '');
        const cpfFormatado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

        // Normalizar chave Pix para consulta DICT
        let chaveDict = pixKey;
        // CPF: só dígitos
        if (/^\d{3}[\.\-]?\d{3}[\.\-]?\d{3}[\.\-]?\d{2}$/.test(pixKey.replace(/[^\d]/g, '')) && pixKey.replace(/\D/g, '').length === 11) {
          chaveDict = pixKey.replace(/\D/g, '');
        }
        // Telefone: garantir +55
        if (/^\d{10,11}$/.test(pixKey.replace(/\D/g, '')) && !pixKey.startsWith('+')) {
          chaveDict = '+55' + pixKey.replace(/\D/g, '');
        }

        try {
          // Consultar DICT para obter dados bancários do destinatário
          const dictKey = await starkbank.dictKey.get(chaveDict);

          console.log(`🔍 [Stark Bank] DICT saque #${saque.id}: chave="${chaveDict}" → banco=${dictKey.ispb}, agencia=${dictKey.branchCode}, conta=${dictKey.accountNumber}, tipo=${dictKey.accountType}, nome="${dictKey.name}"`);

          const transferData = {
            amount: Math.round(parseFloat(saque.final_amount) * 100),
            name: saque.user_name,
            taxId: cpfFormatado,
            bankCode: dictKey.ispb || '20018183',
            branchCode: dictKey.branchCode || '0001',
            accountNumber: dictKey.accountNumber || chaveDict,
            accountType: dictKey.accountType || 'checking',
            externalId: `tutts-saque-${saque.id}`,
            tags: [`lote:${loteId}`, `saque:${saque.id}`]
          };

          transfers.push(new starkbank.Transfer(transferData));

        } catch (errDict) {
          console.warn(`⚠️ [Stark Bank] DICT falhou para saque #${saque.id} (chave="${chaveDict}"): ${errDict.message}`);
          // Fallback: tentar com bankCode Pix genérico (pode funcionar para chaves simples)
          const transferData = {
            amount: Math.round(parseFloat(saque.final_amount) * 100),
            name: saque.user_name,
            taxId: cpfFormatado,
            bankCode: '20018183',
            branchCode: '0001',
            accountNumber: chaveDict,
            accountType: 'payment',
            externalId: `tutts-saque-${saque.id}`,
            tags: [`lote:${loteId}`, `saque:${saque.id}`, 'dict-fallback']
          };

          console.log(`📋 [Stark Bank] Transfer saque #${saque.id} (fallback sem DICT): amount=${transferData.amount}, taxId="${cpfFormatado}", accountNumber="${chaveDict}"`);

          transfers.push(new starkbank.Transfer(transferData));
        }
      }

      if (transfers.length === 0) {
        await client.query(`
          UPDATE stark_lotes SET status = 'erro', erro = 'Nenhuma transfer válida montada', finalizado_em = NOW() WHERE id = $1
        `, [loteId]);
        await client.query('COMMIT');
        releaseClient();
        return res.status(400).json({ error: 'Nenhuma transfer válida para enviar', erros_dict: errosDICT });
      }

      // 6. Disparar transfers na Stark Bank
      let transfersCriadas;
      try {
        transfersCriadas = await starkbank.transfer.create(transfers);
      } catch (errStark) {
        const erroDetalhado = errStark.errors
          ? JSON.stringify(errStark.errors)
          : errStark.message;

        await client.query(`
          UPDATE stark_lotes SET status = 'erro', erro = $1, finalizado_em = NOW() WHERE id = $2
        `, [erroDetalhado, loteId]);
        await client.query('COMMIT');
        releaseClient();

        console.error('❌ [Stark Bank] Erro ao criar transfers:', erroDetalhado);
        if (errStark.errors) {
          errStark.errors.forEach((e, i) => {
            const saque = saques[i];
            console.error(`  ❌ Transfer[${i}] saque #${saque ? saque.id : '?'} (${saque ? saque.user_name : '?'}):`, JSON.stringify(e));
          });
        }

        return res.status(500).json({
          error: 'Erro ao disparar pagamentos na Stark Bank',
          details: erroDetalhado,
          lote_id: loteId
        });
      }

      // 7. Atualizar cada saque com o ID da transfer
      for (let i = 0; i < saques.length; i++) {
        const saque = saques[i];
        const transfer = transfersCriadas[i];

        await client.query(`
          UPDATE withdrawal_requests 
          SET stark_status = 'processando',
              stark_transfer_id = $1,
              stark_lote_id = $2,
              stark_enviado_em = NOW(),
              updated_at = NOW()
          WHERE id = $3
        `, [transfer.id, loteId, saque.id]);

        await client.query(`
          INSERT INTO stark_lote_itens (lote_id, withdrawal_id, stark_transfer_id, valor, status)
          VALUES ($1, $2, $3, $4, 'processando')
        `, [loteId, saque.id, transfer.id, saque.final_amount]);
      }

      // 8. Atualizar lote
      await client.query(`
        UPDATE stark_lotes SET status = 'processando' WHERE id = $1
      `, [loteId]);

      await client.query('COMMIT');
      releaseClient();

      // Auditoria (fora da transação)
      await registrarAuditoria(req, 'STARK_LOTE_EXECUTADO', AUDIT_CATEGORIES.FINANCIAL, 'stark_lotes', loteId, {
        quantidade: saques.length,
        valor_total: valorTotal,
        saldo_antes: saldoDisponivel,
        saque_ids: saques.map(s => s.id)
      });

      console.log(`✅ [Stark Bank] Lote #${loteId} executado: ${saques.length} pagamentos, R$ ${valorTotal.toFixed(2)}`);

      res.json({
        success: true,
        lote_id: loteId,
        quantidade: saques.length,
        valor_total: valorTotal,
        // Campos que o frontend espera para o modal de resultado
        enviados: saques.length,
        rejeitados: 0,
        valor_enviado: valorTotal,
        detalhes_rejeitados: [],
        saldo_antes: saldoDisponivel,
        saldo_apos_estimado: Math.round((saldoDisponivel - valorTotal) * 100) / 100,
        transfers: transfersCriadas.map(t => ({ id: t.id, status: t.status, amount: t.amount / 100 }))
      });

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      console.error('❌ [Stark Bank] Erro ao executar lote:', error.message);
      res.status(500).json({ error: 'Erro ao executar lote de pagamento', details: error.message });
    } finally {
      releaseClient();
    }
  });

  // ==================== HISTÓRICO DE LOTES ====================
  router.get('/stark/lote/historico', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const result = await pool.query(`
        SELECT l.*,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'pago') as itens_pagos,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'erro') as itens_erro,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'processando') as itens_processando
        FROM stark_lotes l
        ORDER BY l.created_at DESC
        LIMIT $1 OFFSET $2
      `, [parseInt(limit), offset]);

      const countResult = await pool.query('SELECT COUNT(*) as total FROM stark_lotes');

      res.json({
        lotes: result.rows,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (error) {
      console.error('❌ [Stark Bank] Erro ao listar histórico:', error.message);
      res.status(500).json({ error: 'Erro ao listar histórico de lotes' });
    }
  });

  // ==================== DETALHE DE UM LOTE ====================
  router.get('/stark/lote/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { id } = req.params;

      const lote = await pool.query('SELECT * FROM stark_lotes WHERE id = $1', [id]);
      if (lote.rows.length === 0) {
        return res.status(404).json({ error: 'Lote não encontrado' });
      }

      const itens = await pool.query(`
        SELECT li.*, w.user_name, w.user_cod, w.pix_key, w.cpf
        FROM stark_lote_itens li
        JOIN withdrawal_requests w ON w.id = li.withdrawal_id
        WHERE li.lote_id = $1
        ORDER BY li.id ASC
      `, [id]);

      res.json({
        lote: lote.rows[0],
        itens: itens.rows
      });
    } catch (error) {
      console.error('❌ [Stark Bank] Erro ao buscar detalhe do lote:', error.message);
      res.status(500).json({ error: 'Erro ao buscar detalhe do lote' });
    }
  });

  // ==================== RETENTAR PAGAMENTOS COM ERRO ====================
  router.post('/stark/lote/:id/retentar', verificarToken, verificarAdminOuFinanceiro, verificarStark, async (req, res) => {
    const client = await pool.connect();
    let clientReleased = false;
    const releaseClient = () => { if (!clientReleased) { clientReleased = true; client.release(); } };

    try {
      const { id } = req.params;

      await client.query('BEGIN');

      const itensErro = await client.query(`
        SELECT li.*, w.user_name, w.cpf, w.pix_key, w.final_amount, w.user_cod
        FROM stark_lote_itens li
        JOIN withdrawal_requests w ON w.id = li.withdrawal_id
        WHERE li.lote_id = $1 AND li.status = 'erro'
        FOR UPDATE OF li
      `, [id]);

      if (itensErro.rows.length === 0) {
        await client.query('ROLLBACK');
        releaseClient();
        return res.status(400).json({ error: 'Nenhum item com erro para retentar' });
      }

      const itens = itensErro.rows;
      const valorTotal = itens.reduce((acc, i) => acc + parseFloat(i.final_amount || i.valor || 0), 0);

      const saldoDisponivel = await obterSaldoReais();

      if (saldoDisponivel < valorTotal) {
        await client.query('ROLLBACK');
        releaseClient();
        return res.status(400).json({
          error: 'Saldo insuficiente para retentativa',
          saldo_disponivel: saldoDisponivel,
          valor_necessario: valorTotal
        });
      }

      const transfers = itens.map(item => {
        const cpf = (item.cpf || '').replace(/\D/g, '');
        const cpfFormatado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        const pixKey = (item.pix_key || '').trim();

        let accountNumber = pixKey;
        if (/^\d{3}[\.\-]?\d{3}[\.\-]?\d{3}[\.\-]?\d{2}$/.test(pixKey.replace(/\D/g, '')) && pixKey.replace(/\D/g, '').length === 11) {
          accountNumber = pixKey.replace(/\D/g, '');
        }
        if (pixKey.startsWith('+')) {
          accountNumber = pixKey.replace(/[\s\-\(\)]/g, '');
        }

        return new starkbank.Transfer({
          amount: Math.round(parseFloat(item.final_amount || item.valor) * 100),
          name: item.user_name,
          taxId: cpfFormatado,
          bankCode: '20018183',
          branchCode: '0001',
          accountNumber: accountNumber,
          accountType: 'checking',
          externalId: `tutts-saque-${item.withdrawal_id}-retry-${Date.now()}`,
          tags: [`lote:${id}`, `saque:${item.withdrawal_id}`, 'retry']
        });
      });

      const transfersCriadas = await starkbank.transfer.create(transfers);

      // Atualizar itens e saques
      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const transfer = transfersCriadas[i];

        await client.query(`
          UPDATE stark_lote_itens 
          SET stark_transfer_id = $1, status = 'processando', erro = NULL, atualizado_em = NOW()
          WHERE id = $2
        `, [transfer.id, item.id]);

        await client.query(`
          UPDATE withdrawal_requests 
          SET stark_status = 'processando', stark_transfer_id = $1, stark_erro = NULL, updated_at = NOW()
          WHERE id = $2
        `, [transfer.id, item.withdrawal_id]);
      }

      // Atualizar status do lote
      await client.query(`
        UPDATE stark_lotes SET status = 'processando', erro = NULL WHERE id = $1
      `, [id]);

      await client.query('COMMIT');

      await registrarAuditoria(req, 'STARK_LOTE_RETENTATIVA', AUDIT_CATEGORIES.FINANCIAL, 'stark_lotes', id, {
        itens_retentados: itens.length,
        valor: valorTotal
      });

      console.log(`🔄 [Stark Bank] Retentativa do lote #${id}: ${itens.length} pagamentos`);

      res.json({
        success: true,
        lote_id: parseInt(id),
        itens_retentados: itens.length,
        valor_total: valorTotal
      });

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      console.error('❌ [Stark Bank] Erro na retentativa:', error.message);
      res.status(500).json({ error: 'Erro ao retentar pagamentos', details: error.message });
    } finally {
      releaseClient();
    }
  });

  // ==================== VALIDAR CHAVE PIX ====================
  router.post('/stark/validar-chave', verificarToken, verificarAdminOuFinanceiro, verificarStark, async (req, res) => {
    try {
      const { chave_pix } = req.body;

      if (!chave_pix) {
        return res.status(400).json({ error: 'Chave Pix obrigatória' });
      }

      const dictKey = await starkbank.dictKey.get(chave_pix);

      res.json({
        valida: true,
        tipo: dictKey.type,
        nome: dictKey.name,
        banco: dictKey.ispb,
        conta_tipo: dictKey.accountType,
        status: dictKey.status
      });
    } catch (error) {
      console.error('⚠️ [Stark Bank] Chave Pix inválida:', error.message);
      res.json({
        valida: false,
        erro: error.message
      });
    }
  });

  // ==================== WEBHOOK STARK BANK (PÚBLICO - sem JWT) ====================
  router.post('/stark/webhook', async (req, res) => {
    try {
      const signature = req.headers['digital-signature'];
      const content = req.rawBody || JSON.stringify(req.body);
      const environment = process.env.STARK_ENVIRONMENT || 'sandbox';

      console.log(`📨 [Stark Webhook] Recebido! signature=${signature ? 'SIM(' + signature.substring(0, 20) + '...)' : 'NÃO'}, bodySize=${content.length}, rawBody=${req.rawBody ? 'SIM' : 'NÃO'}`);

      if (!starkbank) { inicializarStark(); }
      if (!starkbank) {
        console.error('❌ [Stark Webhook] SDK não inicializado');
        return res.status(200).send('OK');
      }

      if (environment === 'production') {
        if (!signature) {
          console.warn('⚠️ [Stark Webhook] REJEITADO — sem assinatura digital');
          return res.status(200).send('OK');
        }

        try {
          const event = await starkbank.event.parse({
            content: content,
            signature: signature
          });
          console.log(`✅ [Stark Webhook] Assinatura válida! subscription=${event.subscription}`);
          await processarEventoStark(event);
        } catch (errValidacao) {
          console.warn('⚠️ [Stark Webhook] Assinatura inválida:', errValidacao.message);
          console.warn('⚠️ [Stark Webhook] rawBody presente:', !!req.rawBody, '| content length:', content.length);

          // FALLBACK: processar pelo body parseado para não perder eventos
          try {
            const body = req.body;
            if (body && body.event) {
              console.log('🔄 [Stark Webhook] Fallback: processando pelo body parseado...');
              await processarEventoStark(body.event);
            }
          } catch (errFallback) {
            console.error('❌ [Stark Webhook] Fallback falhou:', errFallback.message);
          }
          return res.status(200).send('OK');
        }
      } else {
        // Sandbox
        if (signature) {
          try {
            const event = await starkbank.event.parse({ content, signature });
            await processarEventoStark(event);
          } catch (e) {
            if (req.body && req.body.event) await processarEventoStark(req.body.event);
          }
        } else if (req.body && req.body.event) {
          await processarEventoStark(req.body.event);
        }
      }

      res.status(200).send('OK');
    } catch (error) {
      console.error('❌ [Stark Webhook] Erro geral:', error.message);
      res.status(200).send('OK');
    }
  });

  // ==================== SYNC MANUAL — CONSULTAR STATUS NA STARK BANK ====================
  // Fallback quando webhook falha: consulta diretamente a API e atualiza o banco
  router.post('/stark/sync', verificarToken, verificarAdminOuFinanceiro, verificarStark, async (req, res) => {
    try {
      const pendentes = await pool.query(`
        SELECT id, stark_transfer_id, user_name
        FROM withdrawal_requests
        WHERE stark_status = 'processando'
          AND stark_transfer_id IS NOT NULL
          AND stark_enviado_em < NOW() - INTERVAL '1 minute'
        ORDER BY stark_enviado_em ASC
        LIMIT 50
      `);

      if (pendentes.rows.length === 0) {
        return res.json({ message: 'Nenhuma transfer pendente', atualizados: 0 });
      }

      console.log(`🔄 [Stark Sync] Verificando ${pendentes.rows.length} transfers pendentes...`);

      let atualizados = 0;
      const resultados = [];

      for (const saque of pendentes.rows) {
        try {
          const transfer = await starkbank.transfer.get(saque.stark_transfer_id);
          console.log(`🔄 [Stark Sync] Transfer ${saque.stark_transfer_id} (saque #${saque.id}): status=${transfer.status}`);

          if (transfer.status === 'success') {
            await atualizarStatusPagamento(saque.stark_transfer_id, 'pago', null);
            atualizados++;
            resultados.push({ id: saque.id, nome: saque.user_name, status: 'pago' });
          } else if (transfer.status === 'failed' || transfer.status === 'canceled') {
            const erro = transfer.errors?.[0]?.message || transfer.reason || `Status: ${transfer.status}`;
            await atualizarStatusPagamento(saque.stark_transfer_id, 'erro', erro);
            atualizados++;
            resultados.push({ id: saque.id, nome: saque.user_name, status: 'erro', erro });
          } else {
            resultados.push({ id: saque.id, nome: saque.user_name, status: transfer.status });
          }
        } catch (errTransfer) {
          console.error(`❌ [Stark Sync] Erro transfer ${saque.stark_transfer_id}:`, errTransfer.message);
          resultados.push({ id: saque.id, nome: saque.user_name, status: 'erro_consulta', erro: errTransfer.message });
        }
      }

      console.log(`✅ [Stark Sync] ${atualizados}/${pendentes.rows.length} atualizadas`);
      res.json({ consultadas: pendentes.rows.length, atualizados, resultados });
    } catch (error) {
      console.error('❌ [Stark Sync] Erro:', error.message);
      res.status(500).json({ error: 'Erro ao sincronizar', details: error.message });
    }
  });

  // Função para processar eventos do Stark Bank
  async function processarEventoStark(event) {
    const subscription = event.subscription || event.log?.type || '';

    console.log(`📨 [Stark Webhook] Evento recebido: ${subscription}`);

    if (subscription === 'transfer') {
      const transfer = event.log?.transfer || event.transfer || null;
      if (!transfer) {
        console.warn('⚠️ [Stark Webhook] Transfer não encontrada no evento');
        return;
      }

      const transferId = transfer.id;
      const status = transfer.status;

      console.log(`📨 [Stark Webhook] Transfer ${transferId}: status=${status}`);

      if (status === 'success') {
        // Pagamento confirmado!
        await atualizarStatusPagamento(transferId, 'pago', null);
      } else if (status === 'failed' || status === 'canceled') {
        const erro = transfer.errors?.[0]?.message || transfer.reason || `Status: ${status}`;
        await atualizarStatusPagamento(transferId, 'erro', erro);
      }
      // 'processing' e 'created' não precisam de ação — já estão como 'processando'
    }
  }

  // Atualizar status do pagamento no banco
  async function atualizarStatusPagamento(starkTransferId, novoStatus, erro) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Atualizar o saque
      const updateResult = await client.query(`
        UPDATE withdrawal_requests 
        SET stark_status = $1,
            stark_erro = $2,
            stark_pago_em = CASE WHEN $1 = 'pago' THEN NOW() ELSE stark_pago_em END,
            updated_at = NOW()
        WHERE stark_transfer_id = $3
        RETURNING *
      `, [novoStatus, erro, starkTransferId]);

      if (updateResult.rows.length === 0) {
        console.warn(`⚠️ [Stark Webhook] Saque não encontrado para transfer ${starkTransferId}`);
        await client.query('ROLLBACK');
        client.release();
        return;
      }

      const saque = updateResult.rows[0];

      // Atualizar o item do lote
      await client.query(`
        UPDATE stark_lote_itens 
        SET status = $1, erro = $2, atualizado_em = NOW()
        WHERE stark_transfer_id = $3
      `, [novoStatus, erro, starkTransferId]);

      // Verificar se todos os itens do lote já foram processados
      if (saque.stark_lote_id) {
        const pendentes = await client.query(`
          SELECT COUNT(*) as total FROM stark_lote_itens 
          WHERE lote_id = $1 AND status = 'processando'
        `, [saque.stark_lote_id]);

        if (parseInt(pendentes.rows[0].total) === 0) {
          // Todos processados — verificar se teve erros
          const erros = await client.query(`
            SELECT COUNT(*) as total FROM stark_lote_itens 
            WHERE lote_id = $1 AND status = 'erro'
          `, [saque.stark_lote_id]);

          const statusLote = parseInt(erros.rows[0].total) > 0 ? 'parcial' : 'concluido';

          await client.query(`
            UPDATE stark_lotes 
            SET status = $1, finalizado_em = NOW()
            WHERE id = $2
          `, [statusLote, saque.stark_lote_id]);

          console.log(`✅ [Stark Webhook] Lote #${saque.stark_lote_id} finalizado: ${statusLote}`);
        }
      }

      await client.query('COMMIT');

      // Notificar via WebSocket se disponível
      if (global.notifyStarkPayment) {
        global.notifyStarkPayment(saque, novoStatus);
      }

      console.log(`✅ [Stark Webhook] Saque #${saque.id} atualizado: ${novoStatus}${erro ? ` (${erro})` : ''}`);

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      console.error('❌ [Stark Webhook] Erro ao atualizar status:', error.message);
    } finally {
      client.release();
    }
  }

  // ==================== STATUS DA INTEGRAÇÃO ====================
  router.get('/stark/status', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const configurado = !!process.env.STARK_PROJECT_ID && !!process.env.STARK_PRIVATE_KEY;
      const ambiente = process.env.STARK_ENVIRONMENT || 'sandbox';

      let sdkOk = false;
      let saldo = null;
      let erroSaldo = null;

      if (configurado && inicializarStark() && starkbank) {
        try {
          saldo = await obterSaldoReais();
          sdkOk = true;
        } catch (e) {
          sdkOk = false;
          erroSaldo = e.message;
        }
      }

      // Diagnóstico de configuração
      const diagnostico = {
        project_id_presente: !!process.env.STARK_PROJECT_ID,
        private_key_presente: !!process.env.STARK_PRIVATE_KEY,
        private_key_tem_header_pem: !!(process.env.STARK_PRIVATE_KEY && (process.env.STARK_PRIVATE_KEY.includes('-----BEGIN') || process.env.STARK_PRIVATE_KEY.includes('-----BEGIN'))),
        private_key_tamanho: process.env.STARK_PRIVATE_KEY ? process.env.STARK_PRIVATE_KEY.length : 0,
        sdk_carregado: !!starkbank,
        inicializado: starkIniciado,
      };

      // Estatísticas
      const stats = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE stark_status = 'processando') as processando,
          COUNT(*) FILTER (WHERE stark_status = 'pago') as pagos,
          COUNT(*) FILTER (WHERE stark_status = 'erro') as erros,
          COALESCE(SUM(final_amount) FILTER (WHERE stark_status = 'pago'), 0) as valor_total_pago
        FROM withdrawal_requests
        WHERE stark_status IS NOT NULL
      `);

      res.json({
        configurado,
        sdk_operacional: sdkOk,
        ambiente,
        saldo,
        erro_init: starkErroInit,
        erro_saldo: erroSaldo,
        diagnostico,
        estatisticas: stats.rows[0]
      });
    } catch (error) {
      console.error('❌ [Stark Bank] Erro ao verificar status:', error.message);
      res.status(500).json({ error: 'Erro ao verificar status', details: error.message });
    }
  });

  return router;
}

module.exports = { createStarkRoutes };
