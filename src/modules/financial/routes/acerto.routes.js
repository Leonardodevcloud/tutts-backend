/**
 * ACERTO PROFISSIONAL - Routes
 * Upload de planilha de faturamento + pagamento automático via Stark Bank
 * 
 * Endpoints:
 *   POST /stark/acerto/upload       - Upload e processamento da planilha
 *   GET  /stark/acerto/historico     - Histórico de acertos
 *   GET  /stark/acerto/:id           - Detalhe de um acerto
 *   POST /stark/acerto/:id/executar  - Executar pagamento do acerto (com 2FA)
 */

const express = require('express');
const XLSX = require('xlsx');

function createAcertoRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

  // ==================== UPLOAD E PROCESSAMENTO DA PLANILHA ====================
  router.post('/stark/acerto/upload', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { planilha_base64, nome_arquivo } = req.body;

      if (!planilha_base64) {
        return res.status(400).json({ error: 'Nenhuma planilha enviada' });
      }

      // Decodificar base64 e ler com SheetJS
      const buffer = Buffer.from(planilha_base64, 'base64');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const dados = XLSX.utils.sheet_to_json(ws, { header: 1 });

      if (dados.length < 2) {
        return res.status(400).json({ error: 'Planilha vazia ou sem dados' });
      }

      // Processar linhas (pular header na linha 0)
      const profissionais = [];
      const erros = [];

      for (let i = 1; i < dados.length; i++) {
        const linha = dados[i];
        if (!linha || !linha[5]) continue; // Coluna F vazia

        const profStr = String(linha[5] || '').trim();
        const saldoRaw = linha[16]; // Coluna Q (índice 16)
        const cpfRaw = String(linha[6] || '').trim(); // Coluna G
        const pixPlanilha = String(linha[12] || '').trim(); // Coluna M

        // Ignorar linha de fechamento de caixa
        if (profStr.toLowerCase().includes('fechamento') || profStr.toLowerCase().includes('caixa')) continue;

        // Extrair código e nome da coluna F: " 14416 - Cleyson Alves de Almeida "
        const match = profStr.match(/^\s*(\d+)\s*-\s*(.+)\s*$/);
        if (!match) {
          erros.push({ linha: i + 1, prof: profStr, erro: 'Formato inválido na coluna Prof.' });
          continue;
        }

        const codProf = match[1].trim();
        const nomeProf = match[2].trim();

        // Parsear saldo
        let saldo = 0;
        if (typeof saldoRaw === 'number') {
          saldo = saldoRaw;
        } else if (typeof saldoRaw === 'string') {
          saldo = parseFloat(saldoRaw.replace(/\./g, '').replace(',', '.')) || 0;
        }

        // Ignorar saldo zero
        if (saldo <= 0) continue;

        profissionais.push({
          linha: i + 1,
          cod_prof: codProf,
          nome_planilha: nomeProf,
          cpf_planilha: cpfRaw,
          pix_planilha: pixPlanilha,
          saldo: Math.round(saldo * 100) / 100
        });
      }

      if (profissionais.length === 0) {
        return res.json({
          success: true,
          profissionais: [],
          total: 0,
          valor_total: 0,
          erros,
          mensagem: 'Nenhum profissional com saldo positivo encontrado'
        });
      }

      // Cruzar com banco de dados — buscar chave Pix cadastrada
      // Buscar em múltiplas fontes: user_financial_data, withdrawal_requests (saques anteriores), users
      const codProfs = profissionais.map(p => p.cod_prof);
      
      // Fonte 1: Dados financeiros cadastrados (principal)
      const cadastros = await pool.query(`
        SELECT user_cod, full_name, cpf, pix_key, pix_tipo
        FROM user_financial_data
        WHERE user_cod = ANY($1)
      `, [codProfs]);

      // Fonte 2: Saques anteriores (fallback para chave Pix e CPF)
      const saques = await pool.query(`
        SELECT DISTINCT ON (user_cod) user_cod, user_name, cpf, pix_key
        FROM withdrawal_requests
        WHERE user_cod = ANY($1)
        ORDER BY user_cod, created_at DESC
      `, [codProfs]);

      // Fonte 3: Tabela de usuários (para nome)
      const usuarios = await pool.query(`
        SELECT cod_profissional as user_cod, full_name
        FROM users
        WHERE cod_profissional = ANY($1)
      `, [codProfs]);

      // Criar mapa consolidado (prioridade: financial_data > withdrawal > users)
      const mapaCadastro = {};
      
      // Primeiro popular com dados de usuários
      for (const u of usuarios.rows) {
        mapaCadastro[u.user_cod] = { 
          user_cod: u.user_cod, 
          full_name: u.full_name, 
          cpf: null, pix_key: null, pix_tipo: null 
        };
      }
      
      // Sobrescrever com dados de saques
      for (const s of saques.rows) {
        const existing = mapaCadastro[s.user_cod] || {};
        mapaCadastro[s.user_cod] = {
          user_cod: s.user_cod,
          full_name: s.user_name || existing.full_name,
          cpf: s.cpf || existing.cpf,
          pix_key: s.pix_key || existing.pix_key,
          pix_tipo: existing.pix_tipo
        };
      }
      
      // Sobrescrever com dados financeiros (mais confiáveis)
      for (const c of cadastros.rows) {
        const existing = mapaCadastro[c.user_cod] || {};
        mapaCadastro[c.user_cod] = {
          user_cod: c.user_cod,
          full_name: c.full_name || existing.full_name,
          cpf: c.cpf || existing.cpf,
          pix_key: c.pix_key || existing.pix_key,
          pix_tipo: c.pix_tipo || existing.pix_tipo
        };
      }

      // Enriquecer profissionais com dados do cadastro
      let encontrados = 0;
      let naoEncontrados = 0;
      const resultado = profissionais.map(p => {
        const cadastro = mapaCadastro[p.cod_prof];
        if (cadastro && cadastro.pix_key) {
          encontrados++;
          return {
            ...p,
            nome_sistema: cadastro.full_name,
            cpf_sistema: cadastro.cpf,
            pix_key: cadastro.pix_key,
            pix_tipo: cadastro.pix_tipo,
            pix_origem: 'cadastro',
            status: 'pronto'
          };
        } else {
          naoEncontrados++;
          return {
            ...p,
            nome_sistema: cadastro ? cadastro.full_name : null,
            cpf_sistema: cadastro ? cadastro.cpf : null,
            pix_key: null,
            pix_tipo: null,
            pix_origem: null,
            status: 'sem_pix'
          };
        }
      });

      const valorTotal = resultado.filter(r => r.status === 'pronto').reduce((a, r) => a + r.saldo, 0);

      console.log(`📋 [Acerto] Planilha processada: ${resultado.length} profissionais, ${encontrados} com Pix, ${naoEncontrados} sem Pix, R$ ${valorTotal.toFixed(2)}`);

      await registrarAuditoria(req, 'ACERTO_UPLOAD', AUDIT_CATEGORIES.FINANCIAL, 'stark_acerto', null, {
        arquivo: nome_arquivo,
        total: resultado.length,
        encontrados,
        nao_encontrados: naoEncontrados,
        valor_total: valorTotal
      });

      res.json({
        success: true,
        profissionais: resultado,
        total: resultado.length,
        prontos: encontrados,
        sem_pix: naoEncontrados,
        valor_total: Math.round(valorTotal * 100) / 100,
        erros
      });

    } catch (error) {
      console.error('❌ [Acerto] Erro ao processar planilha:', error.message);
      res.status(500).json({ error: 'Erro ao processar planilha', details: error.message });
    }
  });

  // ==================== CRIAR LOTE DE ACERTO ====================
  router.post('/stark/acerto/criar-lote', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    const client = await pool.connect();
    try {
      const { profissionais } = req.body; // Array de { cod_prof, nome, saldo, pix_key, cpf }

      if (!profissionais || profissionais.length === 0) {
        return res.status(400).json({ error: 'Nenhum profissional para o lote' });
      }

      // Filtrar apenas os que têm Pix
      const validos = profissionais.filter(p => p.pix_key && p.saldo > 0);
      if (validos.length === 0) {
        return res.status(400).json({ error: 'Nenhum profissional com chave Pix válida' });
      }

      const valorTotal = validos.reduce((a, p) => a + parseFloat(p.saldo || 0), 0);

      await client.query('BEGIN');

      // Criar lote com tipo 'acerto'
      const loteResult = await client.query(`
        INSERT INTO stark_lotes (quantidade, valor_total, status, executado_por_id, executado_por_nome, tipo)
        VALUES ($1, $2, 'aguardando', $3, $4, 'acerto')
        RETURNING *
      `, [validos.length, valorTotal, req.user.id, req.user.nome || req.user.username]);

      const loteId = loteResult.rows[0].id;

      // Criar itens do lote
      for (const prof of validos) {
        await client.query(`
          INSERT INTO stark_lote_itens (lote_id, cod_prof, nome_prof, valor, pix_key, cpf, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'em_lote')
        `, [loteId, prof.cod_prof, prof.nome || prof.nome_planilha, prof.saldo, prof.pix_key, prof.cpf || prof.cpf_sistema]);
      }

      await client.query('COMMIT');

      console.log(`🏦 [Acerto] Lote #${loteId} criado: ${validos.length} profissionais, R$ ${valorTotal.toFixed(2)}`);

      await registrarAuditoria(req, 'ACERTO_LOTE_CRIADO', AUDIT_CATEGORIES.FINANCIAL, 'stark_lotes', loteId, {
        quantidade: validos.length,
        valor_total: valorTotal,
        tipo: 'acerto'
      });

      res.json({
        success: true,
        lote_id: loteId,
        quantidade: validos.length,
        valor_total: Math.round(valorTotal * 100) / 100
      });

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      console.error('❌ [Acerto] Erro ao criar lote:', error.message);
      res.status(500).json({ error: 'Erro ao criar lote de acerto' });
    } finally {
      client.release();
    }
  });

  // ==================== EXECUTAR PAGAMENTO DO ACERTO (com 2FA) ====================
  router.post('/stark/acerto/:id/executar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { chave_token } = req.body;

      // Validar 2FA (reusar o tokensCache do stark.routes.js via global)
      if (!chave_token) {
        return res.status(403).json({ error: 'Token de segurança obrigatório.' });
      }

      // Buscar itens do lote
      await client.query('BEGIN');

      const lote = await client.query('SELECT * FROM stark_lotes WHERE id = $1 AND tipo = $2', [id, 'acerto']);
      if (lote.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Lote de acerto não encontrado' });
      }

      if (lote.rows[0].status !== 'aguardando') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Lote já foi executado. Status: ' + lote.rows[0].status });
      }

      const itens = await client.query(`
        SELECT * FROM stark_lote_itens WHERE lote_id = $1 AND status = 'em_lote'
        FOR UPDATE
      `, [id]);

      if (itens.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Nenhum item pendente neste lote' });
      }

      // Verificar saldo Stark Bank
      let starkbank;
      try {
        starkbank = require('starkbank');
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(503).json({ error: 'SDK Stark Bank não disponível' });
      }

      // Enviar pagamentos um por um
      const resultados = { sucesso: [], erro: [] };

      for (const item of itens.rows) {
        const cpf = (item.cpf || '').replace(/\D/g, '');
        const pixKey = (item.pix_key || '').trim();
        let accountNumber = pixKey.replace(/\D/g, '');
        if (!accountNumber || accountNumber.length === 0) accountNumber = cpf;
        if (accountNumber.length > 20) accountNumber = accountNumber.substring(0, 20);

        if (!cpf || cpf.length < 11) {
          // CPF inválido — marcar como erro
          await client.query(`
            UPDATE stark_lote_itens SET status = 'rejeitado', erro = 'CPF inválido', atualizado_em = NOW() WHERE id = $1
          `, [item.id]);
          resultados.erro.push({ id: item.id, nome: item.nome_prof, erro: 'CPF inválido' });
          continue;
        }

        try {
          const transferData = {
            amount: Math.round(parseFloat(item.valor) * 100),
            name: item.nome_prof,
            taxId: cpf,
            bankCode: '20018183',
            branchCode: '0001',
            accountNumber: accountNumber,
            accountType: 'checking',
            externalId: `tutts-acerto-${id}-${item.id}`,
            tags: [`acerto:${id}`, `prof:${item.cod_prof}`]
          };

          const resultado = await starkbank.transfer.create([transferData]);
          const transfer = resultado[0];

          await client.query(`
            UPDATE stark_lote_itens 
            SET status = 'processando', stark_transfer_id = $1, atualizado_em = NOW()
            WHERE id = $2
          `, [transfer.id, item.id]);

          resultados.sucesso.push({ id: item.id, nome: item.nome_prof, valor: item.valor, transfer_id: transfer.id });
          console.log(`  ✅ Acerto prof ${item.cod_prof} (${item.nome_prof}) — Transfer ${transfer.id}`);

        } catch (errItem) {
          const erroMsg = errItem.errors ? JSON.stringify(errItem.errors) : errItem.message;

          await client.query(`
            UPDATE stark_lote_itens SET status = 'rejeitado', erro = $1, atualizado_em = NOW() WHERE id = $2
          `, [erroMsg, item.id]);

          resultados.erro.push({ id: item.id, nome: item.nome_prof, erro: erroMsg });
          console.log(`  ❌ Acerto prof ${item.cod_prof} (${item.nome_prof}) — ${erroMsg}`);
        }
      }

      // Atualizar status do lote
      const qtdSucesso = resultados.sucesso.length;
      const qtdErro = resultados.erro.length;
      const valorSucesso = resultados.sucesso.reduce((a, s) => a + parseFloat(s.valor || 0), 0);
      let statusLote = qtdSucesso === 0 ? 'erro' : qtdErro === 0 ? 'processando' : 'parcial';

      await client.query(`
        UPDATE stark_lotes SET status = $1, finalizado_em = NOW() WHERE id = $2
      `, [statusLote, id]);

      await client.query('COMMIT');

      console.log(`🏦 [Acerto] Lote #${id}: ${qtdSucesso} enviados, ${qtdErro} rejeitados`);

      await registrarAuditoria(req, 'ACERTO_EXECUTADO', AUDIT_CATEGORIES.FINANCIAL, 'stark_lotes', id, {
        sucesso: qtdSucesso,
        rejeitados: qtdErro,
        valor_enviado: valorSucesso
      });

      res.json({
        success: true,
        lote_id: parseInt(id),
        enviados: qtdSucesso,
        rejeitados: qtdErro,
        valor_enviado: valorSucesso,
        detalhes_rejeitados: resultados.erro
      });

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      console.error('❌ [Acerto] Erro ao executar:', error.message);
      res.status(500).json({ error: 'Erro ao executar acerto', details: error.message });
    } finally {
      client.release();
    }
  });

  // ==================== HISTÓRICO DE ACERTOS ====================
  router.get('/stark/acerto/historico', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT l.*,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'processando') as itens_processando,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'pago') as itens_pagos,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'rejeitado') as itens_rejeitados
        FROM stark_lotes l
        WHERE l.tipo = 'acerto'
        ORDER BY l.created_at DESC
        LIMIT 50
      `);

      res.json({ lotes: result.rows });
    } catch (error) {
      console.error('❌ [Acerto] Erro histórico:', error.message);
      res.status(500).json({ error: 'Erro ao listar histórico' });
    }
  });

  // ==================== DETALHE DE UM ACERTO ====================
  router.get('/stark/acerto/:id', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { id } = req.params;
      const lote = await pool.query('SELECT * FROM stark_lotes WHERE id = $1', [id]);
      if (lote.rows.length === 0) return res.status(404).json({ error: 'Lote não encontrado' });

      const itens = await pool.query('SELECT * FROM stark_lote_itens WHERE lote_id = $1 ORDER BY valor DESC', [id]);

      res.json({ lote: lote.rows[0], itens: itens.rows });
    } catch (error) {
      res.status(500).json({ error: 'Erro ao buscar detalhe' });
    }
  });

  return router;
}

module.exports = { createAcertoRoutes };
