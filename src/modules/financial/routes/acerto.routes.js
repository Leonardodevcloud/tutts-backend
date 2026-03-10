/**
 * ACERTO PROFISSIONAL - Routes
 * Upload de planilha de faturamento + pagamento automático via Stark Bank
 * 
 * Endpoints:
 *   POST /stark/acerto/upload          - Upload e processamento da planilha
 *   POST /stark/acerto/criar-lote      - Criar lote a partir dos selecionados (só marca, não paga)
 *   GET  /stark/acerto/em-aprovacao    - Listar lotes aguardando aprovação
 *   GET  /stark/acerto/historico       - Histórico de acertos (executados/concluídos)
 *   GET  /stark/acerto/:id             - Detalhe de um acerto (lote + itens)
 *   POST /stark/acerto/:id/executar    - Executar pagamento do acerto (com 2FA)
 *   POST /stark/token/solicitar        - Solicitar token 2FA por email
 *   POST /stark/token/validar          - Validar token 2FA digitado
 */

const express = require('express');
const XLSX = require('xlsx');
const crypto = require('crypto');

// ==================== VALIDAÇÃO DE FORMATO PIX ====================
function validarFormatoPix(chave) {
  if (!chave || typeof chave !== 'string') return { valido: false, tipo: null };
  const ch = chave.trim();
  if (ch.length === 0) return { valido: false, tipo: null };

  // CPF: 11 dígitos (com ou sem formatação)
  const cpfLimpo = ch.replace(/[\.\-]/g, '');
  if (/^\d{11}$/.test(cpfLimpo)) return { valido: true, tipo: 'cpf' };

  // CNPJ: 14 dígitos (com ou sem formatação)
  const cnpjLimpo = ch.replace(/[\.\-\/]/g, '');
  if (/^\d{14}$/.test(cnpjLimpo)) return { valido: true, tipo: 'cnpj' };

  // Telefone: +55 seguido de DDD + número (11-13 dígitos com +55)
  const telLimpo = ch.replace(/[\s\-\(\)]/g, '');
  if (/^\+55\d{10,11}$/.test(telLimpo)) return { valido: true, tipo: 'telefone' };
  // Telefone sem +55 mas com formato (XX) XXXXX-XXXX
  if (/^\d{10,11}$/.test(telLimpo)) return { valido: true, tipo: 'telefone' };

  // Email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ch)) return { valido: true, tipo: 'email' };

  // Chave aleatória (UUID): xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ch)) return { valido: true, tipo: 'aleatoria' };

  // Formato não reconhecido — pode ser inválido
  return { valido: false, tipo: null };
}

function createAcertoRoutes(pool, verificarToken, verificarAdminOuFinanceiro, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();

  // ==================== CACHE DE TOKENS 2FA (em memória) ====================
  const tokensCache = new Map();

  // Limpar tokens expirados a cada 5 minutos
  setInterval(function() {
    const agora = Date.now();
    for (const [chave, dados] of tokensCache.entries()) {
      if (agora > dados.expira_em) {
        tokensCache.delete(chave);
      }
    }
  }, 5 * 60 * 1000);

  // ==================== SOLICITAR TOKEN 2FA POR EMAIL ====================
  router.post('/stark/token/solicitar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { saque_ids, valor_total, quantidade } = req.body;
      const emailUser = process.env.STARK_EMAIL_USER;
      const emailPass = process.env.STARK_EMAIL_PASS;
      const emailDestino = process.env.STARK_TOKEN_EMAIL_DESTINO;

      if (!emailUser || !emailPass || !emailDestino) {
        return res.status(503).json({ error: 'Configuração de email para 2FA não encontrada. Verifique STARK_EMAIL_USER, STARK_EMAIL_PASS e STARK_TOKEN_EMAIL_DESTINO.' });
      }

      // Gerar token de 6 dígitos e chave única
      const token = String(Math.floor(100000 + Math.random() * 900000));
      const chaveToken = crypto.randomBytes(32).toString('hex');

      // Armazenar no cache (expira em 10 minutos)
      tokensCache.set(chaveToken, {
        token: token,
        saque_ids: saque_ids || [],
        valor_total: valor_total || 0,
        quantidade: quantidade || 0,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || req.user.username,
        criado_em: Date.now(),
        expira_em: Date.now() + 10 * 60 * 1000,
        tentativas: 0
      });

      // Mascarar email para exibir no frontend
      const partes = emailDestino.split('@');
      const emailMascarado = partes[0].substring(0, 3) + '***@' + partes[1];

      // Enviar email com nodemailer
      let nodemailer;
      try {
        nodemailer = require('nodemailer');
      } catch (e) {
        return res.status(503).json({ error: 'Nodemailer não instalado no servidor.' });
      }

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: emailUser, pass: emailPass }
      });

      const valorFormatado = (valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      await transporter.sendMail({
        from: '"Central Tutts - 2FA" <' + emailUser + '>',
        to: emailDestino,
        subject: '🔐 Código de Segurança — Acerto Profissional',
        html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px;">' +
          '<div style="background:linear-gradient(135deg,#059669,#0d9488);border-radius:12px;padding:30px;text-align:center;color:white;">' +
          '<h2 style="margin:0 0 10px;">🔐 Código de Segurança</h2>' +
          '<p style="margin:0;opacity:0.9;font-size:14px;">Acerto Profissional — Central Tutts</p>' +
          '</div>' +
          '<div style="background:#f9fafb;border-radius:12px;padding:24px;margin-top:16px;text-align:center;">' +
          '<p style="color:#6b7280;margin:0 0 12px;">Seu código de verificação:</p>' +
          '<div style="background:white;border:2px solid #059669;border-radius:12px;padding:16px;display:inline-block;">' +
          '<span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#059669;">' + token + '</span>' +
          '</div>' +
          '<p style="color:#9ca3af;font-size:12px;margin-top:16px;">Válido por 10 minutos</p>' +
          '</div>' +
          '<div style="background:#f0fdf4;border-radius:12px;padding:16px;margin-top:16px;">' +
          '<p style="margin:0;font-size:14px;color:#374151;"><strong>Operação:</strong> Pagamento de acerto</p>' +
          '<p style="margin:4px 0 0;font-size:14px;color:#374151;"><strong>Quantidade:</strong> ' + (quantidade || 0) + ' profissionais</p>' +
          '<p style="margin:4px 0 0;font-size:14px;color:#374151;"><strong>Valor total:</strong> ' + valorFormatado + '</p>' +
          '<p style="margin:4px 0 0;font-size:14px;color:#374151;"><strong>Solicitado por:</strong> ' + (req.user.nome || req.user.username) + '</p>' +
          '</div>' +
          '<p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:16px;">Se você não solicitou este código, ignore este email.</p>' +
          '</div>'
      });

      console.log('📧 [Acerto 2FA] Token enviado para ' + emailMascarado + ' por ' + (req.user.nome || req.user.username));

      res.json({
        success: true,
        chave_token: chaveToken,
        email_mascarado: emailMascarado,
        expira_em: 10
      });

    } catch (error) {
      console.error('❌ [Acerto 2FA] Erro ao solicitar token:', error.message);
      res.status(500).json({ error: 'Erro ao enviar código de segurança', details: error.message });
    }
  });

  // ==================== VALIDAR TOKEN 2FA ====================
  router.post('/stark/token/validar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const { chave_token, token } = req.body;

      if (!chave_token || !token) {
        return res.status(400).json({ error: 'Chave e token são obrigatórios' });
      }

      const dados = tokensCache.get(chave_token);

      if (!dados) {
        return res.status(401).json({ error: 'Token expirado ou inválido. Solicite um novo código.' });
      }

      // Verificar expiração
      if (Date.now() > dados.expira_em) {
        tokensCache.delete(chave_token);
        return res.status(401).json({ error: 'Token expirado. Solicite um novo código.' });
      }

      // Verificar tentativas (máx 5)
      if (dados.tentativas >= 5) {
        tokensCache.delete(chave_token);
        return res.status(429).json({ error: 'Muitas tentativas incorretas. Solicite um novo código.' });
      }

      // Verificar token
      if (dados.token !== token.trim()) {
        dados.tentativas++;
        return res.status(401).json({ error: 'Código incorreto. Tentativa ' + dados.tentativas + '/5.' });
      }

      // Token válido! Marcar como usado (não deletar ainda — será usado no executar)
      dados.validado = true;

      console.log('✅ [Acerto 2FA] Token validado por ' + (req.user.nome || req.user.username));

      res.json({
        success: true,
        saque_ids: dados.saque_ids,
        mensagem: 'Token validado com sucesso'
      });

    } catch (error) {
      console.error('❌ [Acerto 2FA] Erro ao validar token:', error.message);
      res.status(500).json({ error: 'Erro ao validar token' });
    }
  });

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
      const codProfs = profissionais.map(function(p) { return p.cod_prof.trim(); });

      // Fonte 1: Dados financeiros cadastrados (principal)
      const cadastros = await pool.query(`
        SELECT TRIM(user_cod) as user_cod, full_name, cpf, pix_key, pix_tipo
        FROM user_financial_data
        WHERE TRIM(user_cod) = ANY($1)
      `, [codProfs]);

      // Fonte 2: Saques anteriores (fallback para chave Pix e CPF)
      const saques = await pool.query(`
        SELECT DISTINCT ON (TRIM(user_cod)) TRIM(user_cod) as user_cod, user_name, cpf, pix_key
        FROM withdrawal_requests
        WHERE TRIM(user_cod) = ANY($1)
        ORDER BY TRIM(user_cod), created_at DESC
      `, [codProfs]);

      // Fonte 3: Tabela de usuários (para nome)
      const usuarios = await pool.query(`
        SELECT TRIM(cod_profissional) as user_cod, full_name
        FROM users
        WHERE TRIM(cod_profissional) = ANY($1)
      `, [codProfs]);

      console.log('🔍 [Acerto] Cruzamento: ' + codProfs.length + ' códigos | users: ' + usuarios.rows.length + ' | saques: ' + saques.rows.length + ' | financial: ' + cadastros.rows.length);

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

      // Sobrescrever com dados de saques (tem chave Pix e CPF)
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

      console.log('🔍 [Acerto] Mapa final: ' + Object.keys(mapaCadastro).length + ' profissionais encontrados. Chaves Pix: ' + Object.values(mapaCadastro).filter(function(m) { return m.pix_key; }).length);

      // Debug: mostrar o que encontrou para cada código
      for (const p of profissionais) {
        const found = mapaCadastro[p.cod_prof];
        console.log('  📋 Cod ' + p.cod_prof + ': ' + (found ? 'ENCONTRADO (pix: ' + (found.pix_key || 'NENHUMA') + ')' : 'NÃO ENCONTRADO'));
      }

      // Enriquecer profissionais com dados do cadastro
      // PRIORIDADE: 1) Mapp (planilha) com formato validado → 2) Sistema → 3) Mapp sem validação → 4) sem_pix
      let encontradosMapp = 0;
      let encontradosSistema = 0;
      let naoEncontrados = 0;
      const resultado = profissionais.map(function(p) {
        const cadastro = mapaCadastro[p.cod_prof];
        const nomeSistema = cadastro ? cadastro.full_name : null;
        const cpfSistema = cadastro ? cadastro.cpf : null;
        const pixMapp = p.pix_planilha && p.pix_planilha !== '-' && p.pix_planilha.length > 3 ? p.pix_planilha.trim() : null;
        const pixSistema = cadastro && cadastro.pix_key ? cadastro.pix_key : null;

        // Validar formato da chave Pix do Mapp
        const validacaoMapp = pixMapp ? validarFormatoPix(pixMapp) : { valido: false, tipo: null };

        // Prioridade 1: Chave Pix do Mapp com formato válido
        if (pixMapp && validacaoMapp.valido) {
          encontradosMapp++;
          return {
            ...p,
            nome_sistema: nomeSistema,
            cpf_sistema: cpfSistema || p.cpf_planilha,
            pix_key: pixMapp,
            pix_tipo: validacaoMapp.tipo,
            pix_origem: 'mapp',
            pix_formato_valido: true,
            status: 'pronto'
          };
        }

        // Prioridade 2: Chave Pix do Sistema (fallback)
        if (pixSistema) {
          encontradosSistema++;
          return {
            ...p,
            nome_sistema: nomeSistema,
            cpf_sistema: cpfSistema,
            pix_key: pixSistema,
            pix_tipo: cadastro.pix_tipo,
            pix_origem: 'sistema',
            pix_formato_valido: true,
            pix_mapp_rejeitado: pixMapp ? 'formato_invalido' : null,
            status: 'pronto'
          };
        }

        // Prioridade 3: Mapp com formato inválido (melhor que nada — aviso ao admin)
        if (pixMapp) {
          encontradosMapp++;
          return {
            ...p,
            nome_sistema: nomeSistema,
            cpf_sistema: cpfSistema || p.cpf_planilha,
            pix_key: pixMapp,
            pix_tipo: null,
            pix_origem: 'mapp',
            pix_formato_valido: false,
            status: 'pronto'
          };
        }

        // Sem Pix em nenhuma fonte
        naoEncontrados++;
        return {
          ...p,
          nome_sistema: nomeSistema,
          cpf_sistema: cpfSistema || p.cpf_planilha,
          pix_key: null,
          pix_tipo: null,
          pix_origem: null,
          pix_formato_valido: false,
          status: 'sem_pix'
        };
      });

      const valorTotal = resultado.filter(function(r) { return r.status === 'pronto'; }).reduce(function(a, r) { return a + r.saldo; }, 0);

      console.log('📋 [Acerto] Planilha processada: ' + resultado.length + ' profissionais | Pix Mapp: ' + encontradosMapp + ' | Pix Sistema: ' + encontradosSistema + ' | Sem Pix: ' + naoEncontrados + ' | R$ ' + valorTotal.toFixed(2));

      await registrarAuditoria(req, 'ACERTO_UPLOAD', AUDIT_CATEGORIES.FINANCIAL, 'stark_acerto', null, {
        arquivo: nome_arquivo,
        total: resultado.length,
        pix_mapp: encontradosMapp,
        pix_sistema: encontradosSistema,
        nao_encontrados: naoEncontrados,
        valor_total: valorTotal
      });

      res.json({
        success: true,
        profissionais: resultado,
        total: resultado.length,
        prontos: encontradosMapp + encontradosSistema,
        pix_mapp: encontradosMapp,
        pix_sistema: encontradosSistema,
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
  // Recebe array de profissionais selecionados via checkbox — só cria o lote (não paga)
  router.post('/stark/acerto/criar-lote', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    const client = await pool.connect();
    try {
      const { profissionais } = req.body; // Array de { cod_prof, nome_planilha, nome_sistema, saldo, pix_key, cpf_sistema, cpf_planilha, pix_origem }

      if (!profissionais || profissionais.length === 0) {
        return res.status(400).json({ error: 'Nenhum profissional para o lote' });
      }

      // Filtrar apenas os que têm Pix e saldo > 0
      const validos = profissionais.filter(function(p) { return p.pix_key && p.saldo > 0; });
      if (validos.length === 0) {
        return res.status(400).json({ error: 'Nenhum profissional com chave Pix válida' });
      }

      const valorTotal = validos.reduce(function(a, p) { return a + parseFloat(p.saldo || 0); }, 0);

      await client.query('BEGIN');

      // Criar lote com tipo 'acerto' e status 'aguardando'
      const loteResult = await client.query(`
        INSERT INTO stark_lotes (quantidade, valor_total, status, executado_por_id, executado_por_nome, tipo)
        VALUES ($1, $2, 'aguardando', $3, $4, 'acerto')
        RETURNING *
      `, [validos.length, valorTotal, req.user.id, req.user.nome || req.user.username]);

      const loteId = loteResult.rows[0].id;

      // Criar itens do lote
      for (const prof of validos) {
        const nomeFinal = prof.nome_sistema || prof.nome_planilha || 'Profissional ' + prof.cod_prof;
        const cpfFinal = prof.cpf_sistema || prof.cpf_planilha || '';
        await client.query(`
          INSERT INTO stark_lote_itens (lote_id, cod_prof, nome_prof, valor, pix_key, cpf, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'em_lote')
        `, [loteId, prof.cod_prof, nomeFinal, prof.saldo, prof.pix_key, cpfFinal]);
      }

      await client.query('COMMIT');

      console.log('🏦 [Acerto] Lote #' + loteId + ' criado: ' + validos.length + ' profissionais, R$ ' + valorTotal.toFixed(2));

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

  // ==================== LOTES EM APROVAÇÃO ====================
  router.get('/stark/acerto/em-aprovacao', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT l.*,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id) as total_itens,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'em_lote') as itens_pendentes
        FROM stark_lotes l
        WHERE l.tipo = 'acerto' AND l.status = 'aguardando'
        ORDER BY l.created_at DESC
        LIMIT 50
      `);

      res.json({ lotes: result.rows });
    } catch (error) {
      console.error('❌ [Acerto] Erro em-aprovação:', error.message);
      res.status(500).json({ error: 'Erro ao listar lotes em aprovação' });
    }
  });

  // ==================== EXECUTAR PAGAMENTO DO ACERTO (com 2FA) ====================
  router.post('/stark/acerto/:id/executar', verificarToken, verificarAdminOuFinanceiro, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { chave_token } = req.body;

      // Validar 2FA
      if (!chave_token) {
        return res.status(403).json({ error: 'Token de segurança obrigatório.' });
      }

      const dadosToken = tokensCache.get(chave_token);
      if (!dadosToken || !dadosToken.validado) {
        return res.status(403).json({ error: 'Token não validado. Solicite e valide um novo código.' });
      }

      // Consumir o token (uso único)
      tokensCache.delete(chave_token);

      // Buscar lote
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

      const valorTotalLote = itens.rows.reduce(function(a, item) { return a + parseFloat(item.valor || 0); }, 0);

      let saldoDisponivel;
      try {
        const balances = await starkbank.balance.get();
        saldoDisponivel = balances && balances.length > 0 ? balances[0].amount / 100 : 0;
      } catch (errSaldo) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Não foi possível verificar saldo Stark Bank', details: errSaldo.message });
      }

      if (saldoDisponivel < valorTotalLote) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Saldo insuficiente na conta Stark Bank',
          saldo_disponivel: saldoDisponivel,
          valor_lote: valorTotalLote,
          diferenca: Math.round((valorTotalLote - saldoDisponivel) * 100) / 100
        });
      }

      // Registrar saldo antes no lote
      await client.query('UPDATE stark_lotes SET saldo_antes = $1 WHERE id = $2', [saldoDisponivel, id]);

      // Enviar pagamentos um por um
      const resultados = { sucesso: [], erro: [] };

      for (const item of itens.rows) {
        const cpf = (item.cpf || '').replace(/\D/g, '');
        const pixKey = (item.pix_key || '').trim();
        let accountNumber = pixKey.replace(/\D/g, '');
        if (!accountNumber || accountNumber.length === 0) accountNumber = cpf;
        if (accountNumber.length > 20) accountNumber = accountNumber.substring(0, 20);

        if (!cpf || cpf.length < 11) {
          await client.query(`
            UPDATE stark_lote_itens SET status = 'rejeitado', erro = 'CPF inválido', atualizado_em = NOW() WHERE id = $1
          `, [item.id]);
          resultados.erro.push({ id: item.id, nome: item.nome_prof, cod_prof: item.cod_prof, valor: item.valor, erro: 'CPF inválido' });
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
            externalId: 'tutts-acerto-' + id + '-' + item.id,
            tags: ['acerto:' + id, 'prof:' + item.cod_prof]
          };

          const resultado = await starkbank.transfer.create([transferData]);
          const transfer = resultado[0];

          await client.query(`
            UPDATE stark_lote_itens 
            SET status = 'processando', stark_transfer_id = $1, atualizado_em = NOW()
            WHERE id = $2
          `, [transfer.id, item.id]);

          resultados.sucesso.push({ id: item.id, nome: item.nome_prof, cod_prof: item.cod_prof, valor: item.valor, transfer_id: transfer.id });
          console.log('  ✅ Acerto prof ' + item.cod_prof + ' (' + item.nome_prof + ') — Transfer ' + transfer.id);

        } catch (errItem) {
          const erroMsg = errItem.errors ? JSON.stringify(errItem.errors) : errItem.message;

          await client.query(`
            UPDATE stark_lote_itens SET status = 'rejeitado', erro = $1, atualizado_em = NOW() WHERE id = $2
          `, [erroMsg, item.id]);

          resultados.erro.push({ id: item.id, nome: item.nome_prof, cod_prof: item.cod_prof, valor: item.valor, erro: erroMsg });
          console.log('  ❌ Acerto prof ' + item.cod_prof + ' (' + item.nome_prof + ') — ' + erroMsg);
        }
      }

      // Atualizar status do lote
      const qtdSucesso = resultados.sucesso.length;
      const qtdErro = resultados.erro.length;
      const valorSucesso = resultados.sucesso.reduce(function(a, s) { return a + parseFloat(s.valor || 0); }, 0);
      let statusLote = qtdSucesso === 0 ? 'erro' : qtdErro === 0 ? 'processando' : 'parcial';

      await client.query(`
        UPDATE stark_lotes SET status = $1, finalizado_em = NOW() WHERE id = $2
      `, [statusLote, id]);

      await client.query('COMMIT');

      console.log('🏦 [Acerto] Lote #' + id + ': ' + qtdSucesso + ' enviados, ' + qtdErro + ' rejeitados');

      await registrarAuditoria(req, 'ACERTO_EXECUTADO', AUDIT_CATEGORIES.FINANCIAL, 'stark_lotes', id, {
        sucesso: qtdSucesso,
        rejeitados: qtdErro,
        valor_enviado: valorSucesso,
        saldo_antes: saldoDisponivel
      });

      res.json({
        success: true,
        lote_id: parseInt(id),
        enviados: qtdSucesso,
        rejeitados: qtdErro,
        valor_enviado: Math.round(valorSucesso * 100) / 100,
        saldo_antes: saldoDisponivel,
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
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id AND status = 'rejeitado') as itens_rejeitados,
          (SELECT COUNT(*) FROM stark_lote_itens WHERE lote_id = l.id) as total_itens
        FROM stark_lotes l
        WHERE l.tipo = 'acerto' AND l.status != 'aguardando'
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
