/**
 * MÓDULO SOLICITAÇÃO - Routes
 * 28 endpoints: login, verificar, configuracoes, corrida CRUD, historico,
 *               sincronizar, favoritos, enderecos-salvos, profissionais,
 *               webhook, admin clientes CRUD
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

function createSolicitacaoRouter(pool, verificarToken) {
  const router = express.Router();
  const JWT_SECRET = process.env.JWT_SECRET;

  const validarSenhaSimples = (senha) => {
    if (!senha || typeof senha !== 'string') {
      return { valido: false, erro: 'Senha é obrigatória' };
    }
    if (senha.length < 6) {
      return { valido: false, erro: 'Senha deve ter pelo menos 6 caracteres' };
    }
    return { valido: true };
  };

const verificarTokenSolicitacao = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.tipo !== 'solicitacao') {
      return res.status(401).json({ error: 'Token inválido para solicitação' });
    }
    
    const cliente = await pool.query(
      'SELECT * FROM clientes_solicitacao WHERE id = $1',
      [decoded.id]
    );
    
    if (cliente.rows.length === 0 || !cliente.rows[0].ativo) {
      return res.status(401).json({ error: 'Cliente inativo ou não encontrado' });
    }
    
    req.clienteSolicitacao = cliente.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

// Login do cliente de solicitação
router.post('/solicitacao/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    
    if (!email || !senha) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    
    const cliente = await pool.query(
      'SELECT * FROM clientes_solicitacao WHERE email = $1',
      [email.toLowerCase()]
    );
    
    if (cliente.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    
    const clienteData = cliente.rows[0];
    
    if (!clienteData.ativo) {
      return res.status(401).json({ error: 'Conta desativada. Entre em contato com o administrador.' });
    }
    
    const senhaValida = await bcrypt.compare(senha, clienteData.senha_hash);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    
    // Atualizar último acesso
    await pool.query(
      'UPDATE clientes_solicitacao SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = $1',
      [clienteData.id]
    );
    
    const token = jwt.sign(
      { id: clienteData.id, email: clienteData.email, tipo: 'solicitacao' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      cliente: {
        id: clienteData.id,
        nome: clienteData.nome,
        email: clienteData.email,
        empresa: clienteData.empresa,
        forma_pagamento_padrao: clienteData.forma_pagamento_padrao,
        endereco_partida_padrao: clienteData.endereco_partida_padrao,
        centro_custo_padrao: clienteData.centro_custo_padrao
      }
    });
  } catch (err) {
    console.error('❌ Erro no login solicitação:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Verificar token
router.get('/solicitacao/verificar', verificarTokenSolicitacao, (req, res) => {
  res.json({
    valido: true,
    cliente: {
      id: req.clienteSolicitacao.id,
      nome: req.clienteSolicitacao.nome,
      email: req.clienteSolicitacao.email,
      empresa: req.clienteSolicitacao.empresa,
      forma_pagamento_padrao: req.clienteSolicitacao.forma_pagamento_padrao,
      endereco_partida_padrao: req.clienteSolicitacao.endereco_partida_padrao,
      centro_custo_padrao: req.clienteSolicitacao.centro_custo_padrao
    }
  });
});

// Atualizar configurações do cliente (partida padrão, etc)
router.patch('/solicitacao/configuracoes', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { forma_pagamento_padrao, endereco_partida_padrao, centro_custo_padrao } = req.body;
    
    console.log('💾 Salvando configurações para cliente:', req.clienteSolicitacao.id);
    console.log('📍 Endereço partida:', endereco_partida_padrao);
    
    await pool.query(`
      UPDATE clientes_solicitacao 
      SET forma_pagamento_padrao = COALESCE($1, forma_pagamento_padrao),
          endereco_partida_padrao = COALESCE($2, endereco_partida_padrao),
          centro_custo_padrao = COALESCE($3, centro_custo_padrao)
      WHERE id = $4
    `, [forma_pagamento_padrao, endereco_partida_padrao ? JSON.stringify(endereco_partida_padrao) : null, centro_custo_padrao, req.clienteSolicitacao.id]);
    
    console.log('✅ Configurações salvas com sucesso');
    res.json({ sucesso: true, endereco_partida_padrao });
  } catch (err) {
    console.error('❌ Erro ao atualizar configurações:', err);
    res.status(500).json({ error: 'Erro ao atualizar configurações' });
  }
});

// Solicitar corrida (enviar para API Tutts)
router.post('/solicitacao/corrida', verificarTokenSolicitacao, async (req, res) => {
  try {
    const {
      numero_pedido,
      centro_custo,
      usuario_solicitante,
      data_retirada,
      forma_pagamento,
      ponto_receber,
      retorno,
      obs_retorno,
      ordenar,
      codigo_profissional,
      profissional_nome,      // NOVO - Nome do profissional selecionado
      profissional_foto,      // NOVO - Foto do profissional selecionado
      profissional_telefone,  // NOVO - Telefone do profissional selecionado
      profissional_placa,     // NOVO - Placa do profissional selecionado
      valor_rota_profissional,
      valor_rota_servico,
      sem_profissional,  // NOVO - Modo teste (não dispara para motoboys)
      pontos // Array de pontos
    } = req.body;
    
    if (!pontos || pontos.length < 1) {
      return res.status(400).json({ error: 'Informe pelo menos 1 ponto de entrega' });
    }
    
    console.log('📍 Pontos recebidos do frontend:', JSON.stringify(pontos, null, 2));
    
    if (pontos.length > 80) {
      return res.status(400).json({ error: 'Máximo de 80 pontos permitido' });
    }
    
    // NOVO - Validação: ordenar só permite até 20 pontos
    if (ordenar && pontos.length > 20) {
      return res.status(400).json({ error: 'Ordenação automática permite máximo de 20 pontos' });
    }
    
    // Montar payload para API Tutts - MÍNIMO conforme documentação
    const pontosFormatados = pontos.map(p => {
      // Se rua estiver vazia, usar endereco_completo como fallback
      let rua = p.rua || '';
      if (!rua && p.endereco_completo) {
        rua = p.endereco_completo;
      }
      if (!rua && p.latitude && p.longitude) {
        rua = `Coordenadas: ${p.latitude}, ${p.longitude}`;
      }
      
      const ponto = {
        rua: rua,
        numero: p.numero || '',
        bairro: p.bairro || '',
        cidade: p.cidade || '',
        uf: p.uf || '',
        obs: p.observacao || ''
      };
      
      // Adicionar coordenadas se existirem
      if (p.latitude) ponto.la = String(p.latitude);
      if (p.longitude) ponto.lo = String(p.longitude);
      if (p.cep) ponto.cep = p.cep;
      if (p.complemento) ponto.complemento = p.complemento;
      if (p.telefone) ponto.telefone = p.telefone;
      if (p.procurar_por) ponto.procurarPor = p.procurar_por;
      if (p.numero_nota) ponto.numeroNota = p.numero_nota;
      if (p.codigo_finalizar) ponto.codigoFinalizarEnd = p.codigo_finalizar;
      
      return ponto;
    });
    
    const payloadTutts = {
      token: req.clienteSolicitacao.tutts_token_api,
      codCliente: req.clienteSolicitacao.tutts_codigo_cliente,
      Usuario: usuario_solicitante || req.clienteSolicitacao.nome,
      centroCusto: centro_custo || req.clienteSolicitacao.centro_custo_padrao || req.clienteSolicitacao.nome || 'Central',
      pontos: pontosFormatados,
      retorno: retorno ? 'S' : 'N',
      formaPagamento: forma_pagamento || req.clienteSolicitacao.forma_pagamento_padrao || 'F'
    };
    
    // Adicionar campos opcionais apenas se tiverem valor
    if (numero_pedido) payloadTutts.numeroPedido = numero_pedido;
    if (data_retirada) payloadTutts.DataRetirada = data_retirada;
    if (codigo_profissional) payloadTutts.codigoProf = codigo_profissional;
    if (obs_retorno) payloadTutts.obsRetorno = obs_retorno;
    if (ponto_receber) payloadTutts.pontoReceber = String(ponto_receber);
    if (valor_rota_profissional) payloadTutts.valorRotaProfissional = String(valor_rota_profissional);
    if (valor_rota_servico) payloadTutts.valorRotaServico = String(valor_rota_servico);
    if (ordenar) payloadTutts.ordenar = 'true';
    if (sem_profissional) payloadTutts.semProfissional = 'S';
    
    console.log('📤 Enviando solicitação para API Tutts:', JSON.stringify(payloadTutts, null, 2));
    console.log('🔧 Modo teste (semProfissional):', sem_profissional ? 'ATIVADO' : 'desativado');
    console.log('🔑 Token usado:', payloadTutts.token);
    console.log('🏢 Código cliente usado:', payloadTutts.codCliente);
    
    // Enviar para API Tutts
    const response = await httpRequest('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payloadTutts)
    });
    
    const resultado = await response.json();
    console.log('📥 Resposta da API Tutts:', resultado);
    
    // Salvar no banco independente do resultado
    const solicitacao = await pool.query(`
      INSERT INTO solicitacoes_corrida (
        cliente_id, numero_pedido, centro_custo, usuario_solicitante,
        data_retirada, forma_pagamento, ponto_receber, retorno, obs_retorno,
        ordenar, codigo_profissional, valor_rota_profissional, valor_rota_servico,
        tutts_os_numero, tutts_distancia, tutts_duracao, tutts_valor, tutts_url_rastreamento,
        status, erro_mensagem,
        profissional_nome, profissional_foto, profissional_telefone, profissional_placa
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING id
    `, [
      req.clienteSolicitacao.id,
      numero_pedido,
      centro_custo,
      usuario_solicitante || req.clienteSolicitacao.nome,
      data_retirada || null,
      forma_pagamento || req.clienteSolicitacao.forma_pagamento_padrao || 'F',
      ponto_receber,
      retorno || false,
      obs_retorno,
      ordenar || false,
      codigo_profissional,
      valor_rota_profissional,
      valor_rota_servico,
      resultado.Sucesso || null,
      resultado.detalhes?.distancia || null,
      resultado.detalhes?.duracao || null,
      resultado.detalhes?.valor ? parseFloat(resultado.detalhes.valor) : null,
      resultado.detalhes?.urlRastreamento || null,
      resultado.Sucesso ? 'enviado' : 'erro',
      resultado.Erro || null,
      profissional_nome || null,
      profissional_foto || null,
      profissional_telefone || null,
      profissional_placa || null
    ]);
    
    const solicitacaoId = solicitacao.rows[0].id;
    
    // Salvar pontos
    for (let i = 0; i < pontos.length; i++) {
      const p = pontos[i];
      // Montar endereco_completo se não vier do frontend
      const enderecoCompleto = p.endereco_completo || [p.rua, p.numero, p.bairro, p.cidade, p.uf].filter(x => x && x.trim()).join(', ');
      await pool.query(`
        INSERT INTO solicitacoes_pontos (
          solicitacao_id, ordem, rua, numero, complemento, bairro, cidade, uf, cep,
          latitude, longitude, observacao, telefone, procurar_por, numero_nota, codigo_finalizar,
          status, endereco_completo
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `, [
        solicitacaoId, i + 1, p.rua, p.numero, p.complemento, p.bairro, p.cidade, p.uf, p.cep,
        p.latitude, p.longitude, p.observacao, p.telefone, p.procurar_por, p.numero_nota, p.codigo_finalizar,
        'pendente', enderecoCompleto
      ]);
    }
    
    if (resultado.Erro) {
      return res.status(400).json({ 
        error: resultado.Erro,
        solicitacao_id: solicitacaoId 
      });
    }
    
    // NOVO: Se enviou para profissional específico, consultar status para pegar foto
    if (codigo_profissional && resultado.Sucesso) {
      try {
        // Montar token de status
        let tokenStatus = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
        if (tokenStatus && tokenStatus.includes('-gravar')) {
          tokenStatus = tokenStatus.replace('-gravar', '-status');
        } else if (tokenStatus && !tokenStatus.includes('-status')) {
          tokenStatus = tokenStatus + '-status';
        }
        
        const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
        
        if (tokenStatus && codCliente) {
          // Aguardar 1 segundo para dar tempo da Tutts processar
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Consultar status da OS recém criada
          const statusData = await consultarStatusTutts(tokenStatus, codCliente, [resultado.Sucesso]);
          
          if (statusData && !statusData.erro) {
            const dadosOS = statusData[resultado.Sucesso] || statusData[resultado.Sucesso.toString()];
            
            if (dadosOS) {
              const dadosProf = dadosOS.dadosProf || dadosOS.dadosProfissional || {};
              
              console.log('📸 [FOTO] Dados do profissional recebidos:', JSON.stringify(dadosProf, null, 2));
              
              // Atualizar com dados do profissional (incluindo foto)
              if (dadosProf.nome || dadosProf.foto || dadosProf.Foto) {
                await pool.query(`
                  UPDATE solicitacoes_corrida SET
                    profissional_nome = COALESCE($1, profissional_nome),
                    profissional_foto = COALESCE($2, profissional_foto),
                    profissional_cpf = COALESCE($3, profissional_cpf),
                    profissional_placa = COALESCE($4, profissional_placa),
                    profissional_telefone = COALESCE($5, profissional_telefone),
                    profissional_email = COALESCE($6, profissional_email),
                    tutts_url_rastreamento = COALESCE($7, tutts_url_rastreamento),
                    atualizado_em = NOW()
                  WHERE id = $8
                `, [
                  dadosProf.nome || dadosProf.Nome || null,
                  dadosProf.foto || dadosProf.Foto || null,
                  dadosProf.cpf || dadosProf.CPF || null,
                  dadosProf.placa || dadosProf.Placa || null,
                  dadosProf.telefone || dadosProf.Telefone || null,
                  dadosProf.email || dadosProf.Email || null,
                  dadosOS.urlRastreamento || dadosOS.UrlRastreamento || null,
                  solicitacaoId
                ]);
                
                console.log('✅ [FOTO] Dados do profissional atualizados para OS', resultado.Sucesso);
              }
            }
          }
        }
      } catch (errStatus) {
        // Não falhar a criação se a consulta de status der erro
        console.log('⚠️ [FOTO] Erro ao consultar status (não crítico):', errStatus.message);
      }
    }
    
    res.json({
      sucesso: true,
      solicitacao_id: solicitacaoId,
      os_numero: resultado.Sucesso,
      detalhes: resultado.detalhes,
      modo_teste: sem_profissional || false  // NOVO - Informa se foi modo teste
    });
    
  } catch (err) {
    console.error('❌ Erro ao solicitar corrida:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao solicitar corrida', detalhe: err.message });
  }
});

// Listar histórico de solicitações
router.get('/solicitacao/historico', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { limite = 20, pagina = 1, status } = req.query;
    const offset = (pagina - 1) * limite;
    
    let query = `
      SELECT s.*, 
        (SELECT COUNT(*) FROM solicitacoes_pontos WHERE solicitacao_id = s.id) as total_pontos,
        (SELECT numero_nota FROM solicitacoes_pontos WHERE solicitacao_id = s.id AND numero_nota IS NOT NULL AND numero_nota != '' ORDER BY ordem LIMIT 1) as primeiro_numero_nota
      FROM solicitacoes_corrida s
      WHERE s.cliente_id = $1
    `;
    const params = [req.clienteSolicitacao.id];
    
    if (status) {
      query += ` AND s.status = $${params.length + 1}`;
      params.push(status);
    }
    
    query += ` ORDER BY s.criado_em DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limite, offset);
    
    const result = await pool.query(query, params);
    
    // Contar total
    const total = await pool.query(
      'SELECT COUNT(*) FROM solicitacoes_corrida WHERE cliente_id = $1' + (status ? ' AND status = $2' : ''),
      status ? [req.clienteSolicitacao.id, status] : [req.clienteSolicitacao.id]
    );
    
    res.json({
      solicitacoes: result.rows,
      total: parseInt(total.rows[0].count),
      pagina: parseInt(pagina),
      limite: parseInt(limite)
    });
  } catch (err) {
    console.error('❌ Erro ao listar histórico:', err);
    res.status(500).json({ error: 'Erro ao listar histórico' });
  }
});

// Buscar detalhes de uma solicitação

// Buscar detalhes de uma solicitação (COM MERGE DE DADOS DO WEBHOOK)
router.get('/solicitacao/corrida/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Buscar solicitação incluindo dados_pontos do webhook
    const solicitacao = await pool.query(
      'SELECT * FROM solicitacoes_corrida WHERE id = $1 AND cliente_id = $2',
      [id, req.clienteSolicitacao.id]
    );
    
    if (solicitacao.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }
    
    const corridaData = solicitacao.rows[0];
    
    // Buscar pontos da tabela solicitacoes_pontos
    const pontosResult = await pool.query(
      'SELECT * FROM solicitacoes_pontos WHERE solicitacao_id = $1 ORDER BY ordem',
      [id]
    );
    
    let pontos = pontosResult.rows;
    
    // Fazer merge com dados_pontos do webhook (se existir)
    // O webhook /api/webhook/tutts salva dados detalhados em dados_pontos
    let dadosPontosWebhook = corridaData.dados_pontos;
    if (dadosPontosWebhook) {
      // Parse se for string
      if (typeof dadosPontosWebhook === 'string') {
        try {
          dadosPontosWebhook = JSON.parse(dadosPontosWebhook);
        } catch (e) {
          dadosPontosWebhook = [];
        }
      }
      
      // Fazer merge: dados do webhook complementam dados da tabela
      if (Array.isArray(dadosPontosWebhook) && dadosPontosWebhook.length > 0) {
        pontos = pontos.map((ponto, idx) => {
          const dadosWebhook = dadosPontosWebhook[idx] || {};
          
          // Priorizar dados do webhook se existirem (são mais atualizados)
          return {
            ...ponto,
            // Status do ponto (webhook pode ter atualização mais recente)
            status: dadosWebhook.status || ponto.status || 'pendente',
            status_codigo: dadosWebhook.status_codigo || ponto.status_codigo,
            status_completo: dadosWebhook.status_completo || ponto.status_completo,
            status_descricao: dadosWebhook.status_descricao || ponto.status_descricao,
            
            // Datas do webhook
            data_evento: dadosWebhook.data_evento || ponto.data_evento,
            data_chegada: dadosWebhook.data_evento && dadosWebhook.status === 'chegou' 
              ? dadosWebhook.data_evento 
              : ponto.data_chegada,
            data_coletado: dadosWebhook.data_coletado || ponto.data_coletado,
            data_finalizado: dadosWebhook.data_evento && dadosWebhook.status === 'finalizado'
              ? dadosWebhook.data_evento
              : ponto.data_finalizado,
            
            // Métricas do webhook
            tempo_espera: dadosWebhook.tempo_espera || ponto.tempo_espera,
            distancia_ultimo_ponto: dadosWebhook.distancia_ultimo_ponto,
            tempo_ultimo_ponto: dadosWebhook.tempo_ultimo_ponto,
            
            // Coordenadas de chegada
            lat_chegada: dadosWebhook.lat_chegada,
            lon_chegada: dadosWebhook.lon_chegada,
            
            // Endereço completo (webhook pode ter versão atualizada)
            endereco_completo: dadosWebhook.endereco_completo || ponto.endereco_completo || 
              [ponto.rua, ponto.numero, ponto.bairro, ponto.cidade].filter(Boolean).join(', '),
            
            // Motivo de finalização
            motivo_finalizacao: dadosWebhook.motivo_tipo || ponto.motivo_finalizacao,
            motivo_descricao: dadosWebhook.motivo_descricao || ponto.motivo_descricao,
            
            // Assinatura e fotos
            assinatura: dadosWebhook.assinatura || (ponto.assinatura ? 
              (typeof ponto.assinatura === 'string' ? JSON.parse(ponto.assinatura) : ponto.assinatura) : null),
            fotos: dadosWebhook.protocolo_fotos || (ponto.fotos ?
              (typeof ponto.fotos === 'string' ? JSON.parse(ponto.fotos) : ponto.fotos) : null),
            
            // Dados de retorno
            is_retorno: dadosWebhook.is_retorno || ponto.is_retorno || false,
            ponto_retorno_de: dadosWebhook.ponto_retorno_de || ponto.ponto_retorno_de || null,
            tipo_ponto: dadosWebhook.tipo_ponto || ponto.tipo_ponto || null,
            
            // Outros dados
            numero_nota: dadosWebhook.numero_nota || ponto.numero_nota,
            observacao: dadosWebhook.observacao || ponto.observacao
          };
        });
        
        // Verificar se existem pontos extras no webhook (pontos de retorno adicionados pela Tutts)
        if (dadosPontosWebhook.length > pontos.length) {
          console.log(`🔄 [GET] Detectados ${dadosPontosWebhook.length - pontos.length} ponto(s) extra(s) (possíveis retornos)`);
          
          // Adicionar pontos extras (retornos)
          for (let i = pontos.length; i < dadosPontosWebhook.length; i++) {
            const dadosWebhook = dadosPontosWebhook[i];
            pontos.push({
              id: null,
              ordem: i + 1,
              status: dadosWebhook.status || 'pendente',
              endereco_completo: dadosWebhook.endereco_completo || 'Ponto de Retorno',
              is_retorno: true,
              ponto_retorno_de: dadosWebhook.ponto_retorno_de,
              tipo_ponto: dadosWebhook.tipo_ponto || 'retorno',
              data_chegada: dadosWebhook.data_evento && dadosWebhook.status === 'chegou' ? dadosWebhook.data_evento : null,
              data_finalizado: dadosWebhook.data_evento && dadosWebhook.status === 'finalizado' ? dadosWebhook.data_evento : null,
              motivo_finalizacao: dadosWebhook.motivo_tipo,
              motivo_descricao: dadosWebhook.motivo_descricao,
              fotos: dadosWebhook.protocolo_fotos
            });
          }
        }
      }
    }
    
    // Retornar dados completos
    res.json({
      ...corridaData,
      pontos: pontos
    });
    
  } catch (err) {
    console.error('❌ Erro ao buscar solicitação:', err);
    res.status(500).json({ error: 'Erro ao buscar solicitação' });
  }
});


// Cancelar corrida - chama API Tutts para cancelar de verdade
router.patch('/solicitacao/corrida/:id/cancelar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se a corrida pertence ao cliente
    const solicitacao = await pool.query(
      'SELECT id, status, tutts_os_numero FROM solicitacoes_corrida WHERE id = $1 AND cliente_id = $2',
      [id, req.clienteSolicitacao.id]
    );
    
    if (solicitacao.rows.length === 0) {
      return res.status(404).json({ error: 'Solicitação não encontrada' });
    }
    
    const osNumero = solicitacao.rows[0].tutts_os_numero;
    
    // Não permitir cancelar se já finalizada ou cancelada
    if (['finalizado', 'cancelado'].includes(solicitacao.rows[0].status)) {
      return res.status(400).json({ error: 'Esta corrida já está ' + solicitacao.rows[0].status });
    }
    
    // Obter token de cancelamento do cliente
    // O token de cancelamento tem sufixo "-cancelar" em vez de "-gravar"
    let tokenCancelar = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
    if (tokenCancelar && tokenCancelar.includes('-gravar')) {
      tokenCancelar = tokenCancelar.replace('-gravar', '-cancelar');
    } else if (tokenCancelar && !tokenCancelar.includes('-cancelar')) {
      tokenCancelar = tokenCancelar + '-cancelar';
    }
    
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    // Se tem OS na Tutts, tentar cancelar lá também
    let cancelouNaTutts = false;
    let erroTutts = null;
    
    if (osNumero && tokenCancelar && codCliente) {
      try {
        const payloadTutts = {
          token: tokenCancelar,
          codCliente: codCliente,
          OS: osNumero.toString()
        };
        
        console.log('❌ [CANCELAR TUTTS] Enviando cancelamento:', JSON.stringify(payloadTutts, null, 2));
        
        const respTutts = await fetch('https://tutts.com.br/integracao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadTutts)
        });
        
        const dataTutts = await respTutts.json();
        console.log('📥 [CANCELAR TUTTS] Resposta:', dataTutts);
        
        if (dataTutts.Sucesso || dataTutts.sucesso) {
          cancelouNaTutts = true;
          console.log(`✅ [CANCELAR TUTTS] OS ${osNumero} cancelada com sucesso na Tutts`);
        } else if (dataTutts.Erro || dataTutts.erro) {
          erroTutts = dataTutts.Erro || dataTutts.erro;
          console.log(`⚠️ [CANCELAR TUTTS] Erro ao cancelar OS ${osNumero}: ${erroTutts}`);
          
          // Se erro é "Alocado", significa que já está em execução
          if (erroTutts === 'Alocado') {
            return res.status(400).json({ 
              error: 'Não é possível cancelar: serviço em execução ou já finalizado na Tutts',
              erro_tutts: erroTutts
            });
          }
        }
      } catch (errTutts) {
        console.error('❌ [CANCELAR TUTTS] Erro na requisição:', errTutts.message);
        erroTutts = errTutts.message;
      }
    }
    
    // Atualizar status para cancelado no nosso banco
    await pool.query(`
      UPDATE solicitacoes_corrida 
      SET status = 'cancelado', 
          atualizado_em = NOW(),
          ultima_atualizacao = NOW()
      WHERE id = $1
    `, [id]);
    
    console.log(`❌ [CANCELAR] OS ${osNumero || id} cancelada pelo cliente ${req.clienteSolicitacao.nome}`);
    
    res.json({ 
      sucesso: true, 
      mensagem: cancelouNaTutts ? 'Corrida cancelada na Tutts e no sistema' : 'Corrida marcada como cancelada',
      cancelou_tutts: cancelouNaTutts,
      erro_tutts: erroTutts
    });
  } catch (err) {
    console.error('❌ Erro ao cancelar corrida:', err);
    res.status(500).json({ error: 'Erro ao cancelar corrida' });
  }
});

// Sincronizar status das corridas ativas com a Tutts
router.post('/solicitacao/sincronizar', verificarTokenSolicitacao, async (req, res) => {
  try {
    // Buscar corridas ativas do cliente que tem OS na Tutts
    const corridasAtivas = await pool.query(`
      SELECT id, tutts_os_numero, status 
      FROM solicitacoes_corrida 
      WHERE cliente_id = $1 
        AND status IN ('enviado', 'aceito', 'em_andamento')
        AND tutts_os_numero IS NOT NULL
      ORDER BY criado_em DESC
      LIMIT 50
    `, [req.clienteSolicitacao.id]);
    
    if (corridasAtivas.rows.length === 0) {
      return res.json({ 
        sucesso: true, 
        mensagem: 'Nenhuma corrida ativa para sincronizar',
        atualizadas: 0 
      });
    }
    
    // Montar token de status
    let tokenStatus = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
    if (tokenStatus && tokenStatus.includes('-gravar')) {
      tokenStatus = tokenStatus.replace('-gravar', '-status');
    } else if (tokenStatus && !tokenStatus.includes('-status')) {
      tokenStatus = tokenStatus + '-status';
    }
    
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    if (!tokenStatus || !codCliente) {
      return res.status(400).json({ error: 'Cliente não tem credenciais da Tutts configuradas' });
    }
    
    // Pegar lista de OS para consultar
    const listaOS = corridasAtivas.rows.map(c => c.tutts_os_numero);
    
    console.log(`🔄 [SINCRONIZAR] Consultando ${listaOS.length} OS na Tutts:`, listaOS);
    
    // Chamar API da Tutts
    const payloadTutts = {
      token: tokenStatus,
      codCliente: codCliente,
      servicos: listaOS
    };
    
    const respTutts = await fetch('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadTutts)
    });
    
    const dataTutts = await respTutts.json();
    console.log('📥 [SINCRONIZAR] Resposta da Tutts recebida');
    
    if (dataTutts.Erro) {
      console.error('❌ [SINCRONIZAR] Erro da Tutts:', dataTutts.Erro);
      return res.status(400).json({ error: dataTutts.Erro });
    }
    
    if (!dataTutts.Sucesso) {
      return res.status(400).json({ error: 'Resposta inválida da Tutts' });
    }
    
    // Mapear status da Tutts para nosso sistema
    const mapearStatus = (statusTutts) => {
      switch (statusTutts) {
        case 'SP': return 'enviado';      // Sem profissional
        case 'A': return 'em_andamento';  // Em execução
        case 'F': return 'finalizado';    // Finalizado
        case 'C': return 'cancelado';     // Cancelado
        case 'V': return 'enviado';       // Aguardando análise
        case 'U': return 'enviado';       // Aguardando autorização
        default: return null;
      }
    };
    
    let atualizadas = 0;
    let finalizadas = 0;
    let canceladas = 0;
    
    // Processar cada OS retornada
    for (const os of listaOS) {
      const dadosOS = dataTutts.Sucesso[os];
      if (!dadosOS) continue;
      
      const novoStatus = mapearStatus(dadosOS.status);
      if (!novoStatus) continue;
      
      // Buscar corrida no nosso banco
      const corrida = corridasAtivas.rows.find(c => c.tutts_os_numero === os || c.tutts_os_numero === os.toString());
      if (!corrida) continue;
      
      // Só atualizar se status mudou
      if (corrida.status !== novoStatus) {
        // Extrair dados do profissional
        const dadosProf = dadosOS.dadosProf || dadosOS.dadosProfissional || {};
        
        await pool.query(`
          UPDATE solicitacoes_corrida SET
            status = $1,
            profissional_nome = COALESCE($2, profissional_nome),
            profissional_cpf = COALESCE($3, profissional_cpf),
            profissional_placa = COALESCE($4, profissional_placa),
            tutts_url_rastreamento = COALESCE($5, tutts_url_rastreamento),
            dados_pontos = COALESCE($6, dados_pontos),
            ultima_atualizacao = NOW(),
            atualizado_em = NOW()
          WHERE id = $7
        `, [
          novoStatus,
          dadosProf.nome || null,
          dadosProf.cpf || null,
          dadosProf.placa || null,
          dadosOS.urlRastreamento || null,
          dadosOS.pontos ? JSON.stringify(dadosOS.pontos) : null,
          corrida.id
        ]);
        
        atualizadas++;
        if (novoStatus === 'finalizado') finalizadas++;
        if (novoStatus === 'cancelado') canceladas++;
        
        console.log(`✅ [SINCRONIZAR] OS ${os}: ${corrida.status} → ${novoStatus}`);
      }
    }
    
    console.log(`🔄 [SINCRONIZAR] Concluído: ${atualizadas} atualizadas, ${finalizadas} finalizadas, ${canceladas} canceladas`);
    
    res.json({ 
      sucesso: true, 
      mensagem: `Sincronização concluída`,
      total_consultadas: listaOS.length,
      atualizadas,
      finalizadas,
      canceladas
    });
    
  } catch (err) {
    console.error('❌ Erro ao sincronizar:', err);
    res.status(500).json({ error: 'Erro ao sincronizar com a Tutts' });
  }
});

// ==================== SINCRONIZAÇÃO DE STATUS COM TUTTS ====================

// Consultar status de uma ou mais OS na Tutts
async function consultarStatusTutts(tokenStatus, codCliente, osNumeros) {
  try {
    const payload = {
      token: tokenStatus,
      codCliente: codCliente,
      servicos: osNumeros.map(os => parseInt(os))
    };
    
    console.log('🔄 [STATUS TUTTS] Consultando:', osNumeros.join(', '));
    
    const resp = await fetch('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await resp.json();
    
    if (data.Erro) {
      console.log('⚠️ [STATUS TUTTS] Erro:', data.Erro);
      return { erro: data.Erro };
    }
    
    return data.Sucesso || data;
  } catch (err) {
    console.error('❌ [STATUS TUTTS] Erro na requisição:', err.message);
    return { erro: err.message };
  }
}

// Mapear status da Tutts para nosso sistema
function mapearStatusTutts(statusTutts) {
  const mapa = {
    'SP': 'enviado',      // Sem profissional
    'A': 'em_andamento',  // Em execução
    'F': 'finalizado',    // Finalizado
    'C': 'cancelado',     // Cancelado
    'V': 'enviado',       // Aguardando análise
    'U': 'enviado'        // Aguardando autorização
  };
  return mapa[statusTutts] || 'enviado';
}

// Endpoint para sincronizar status das corridas ativas de um cliente
router.post('/solicitacao/sincronizar', verificarTokenSolicitacao, async (req, res) => {
  try {
    // Buscar corridas ativas do cliente
    const corridasAtivas = await pool.query(`
      SELECT id, tutts_os_numero, status 
      FROM solicitacoes_corrida 
      WHERE cliente_id = $1 
        AND status IN ('enviado', 'aceito', 'em_andamento')
        AND tutts_os_numero IS NOT NULL
      ORDER BY criado_em DESC
      LIMIT 50
    `, [req.clienteSolicitacao.id]);
    
    if (corridasAtivas.rows.length === 0) {
      return res.json({ sucesso: true, mensagem: 'Nenhuma corrida ativa para sincronizar', atualizadas: 0 });
    }
    
    // Obter token de status do cliente
    let tokenStatus = req.clienteSolicitacao.tutts_token_api || req.clienteSolicitacao.tutts_token;
    if (tokenStatus && tokenStatus.includes('-gravar')) {
      tokenStatus = tokenStatus.replace('-gravar', '-status');
    } else if (tokenStatus && !tokenStatus.includes('-status')) {
      tokenStatus = tokenStatus + '-status';
    }
    
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    if (!tokenStatus || !codCliente) {
      return res.status(400).json({ error: 'Cliente não tem credenciais Tutts configuradas' });
    }
    
    // Consultar status na Tutts
    const osNumeros = corridasAtivas.rows.map(c => c.tutts_os_numero);
    const statusTutts = await consultarStatusTutts(tokenStatus, codCliente, osNumeros);
    
    if (statusTutts.erro) {
      return res.status(400).json({ error: 'Erro ao consultar Tutts: ' + statusTutts.erro });
    }
    
    // Atualizar cada corrida
    let atualizadas = 0;
    let canceladas = 0;
    let finalizadas = 0;
    
    for (const corrida of corridasAtivas.rows) {
      const osNum = corrida.tutts_os_numero.toString();
      const dadosOS = statusTutts[osNum];
      
      if (dadosOS) {
        const novoStatus = mapearStatusTutts(dadosOS.status);
        
        // Só atualizar se status mudou
        if (novoStatus !== corrida.status) {
          // Extrair dados do profissional
          const dadosProf = dadosOS.dadosProfissional || dadosOS.dadosProf || {};
          
          await pool.query(`
            UPDATE solicitacoes_corrida SET
              status = $1,
              profissional_nome = COALESCE($2, profissional_nome),
              profissional_cpf = COALESCE($3, profissional_cpf),
              profissional_placa = COALESCE($4, profissional_placa),
              tutts_url_rastreamento = COALESCE($5, tutts_url_rastreamento),
              ultima_atualizacao = NOW(),
              atualizado_em = NOW()
            WHERE id = $6
          `, [
            novoStatus,
            dadosProf.nome || null,
            dadosProf.cpf || null,
            dadosProf.placa || null,
            dadosOS.urlRastreamento || null,
            corrida.id
          ]);
          
          atualizadas++;
          if (novoStatus === 'cancelado') canceladas++;
          if (novoStatus === 'finalizado') finalizadas++;
          
          console.log(`🔄 [SYNC] OS ${osNum}: ${corrida.status} → ${novoStatus}`);
        }
      }
    }
    
    console.log(`✅ [SYNC] Cliente ${req.clienteSolicitacao.nome}: ${atualizadas} atualizadas, ${canceladas} canceladas, ${finalizadas} finalizadas`);
    
    res.json({ 
      sucesso: true, 
      total: corridasAtivas.rows.length,
      atualizadas,
      canceladas,
      finalizadas,
      mensagem: atualizadas > 0 
        ? `${atualizadas} corrida(s) atualizada(s)${canceladas > 0 ? `, ${canceladas} cancelada(s)` : ''}${finalizadas > 0 ? `, ${finalizadas} finalizada(s)` : ''}`
        : 'Todas as corridas já estão sincronizadas'
    });
  } catch (err) {
    console.error('❌ Erro ao sincronizar:', err);
    res.status(500).json({ error: 'Erro ao sincronizar status' });
  }
});

// Salvar endereço favorito
router.post('/solicitacao/favoritos', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { apelido, rua, numero, complemento, bairro, cidade, uf, cep, latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao } = req.body;
    
    if (!rua || !cidade) {
      return res.status(400).json({ error: 'Rua e cidade são obrigatórios' });
    }
    
    // Verificar se já existe
    const existe = await pool.query(
      'SELECT id FROM solicitacao_favoritos WHERE cliente_id = $1 AND rua = $2 AND numero = $3 AND cidade = $4',
      [req.clienteSolicitacao.id, rua, numero, cidade]
    );
    
    if (existe.rows.length > 0) {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP,
            latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude)
        WHERE id = $1
      `, [existe.rows[0].id, latitude, longitude]);
      
      return res.json({ sucesso: true, id: existe.rows[0].id, atualizado: true });
    }
    
    const result = await pool.query(`
      INSERT INTO solicitacao_favoritos (
        cliente_id, apelido, rua, numero, complemento, bairro, cidade, uf, cep,
        latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `, [
      req.clienteSolicitacao.id, apelido, rua, numero, complemento, bairro, cidade, uf, cep,
      latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
    ]);
    
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Erro ao salvar favorito:', err);
    res.status(500).json({ error: 'Erro ao salvar favorito' });
  }
});

// Listar favoritos
router.get('/solicitacao/favoritos', verificarTokenSolicitacao, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM solicitacao_favoritos 
      WHERE cliente_id = $1 
      ORDER BY vezes_usado DESC, ultimo_uso DESC
      LIMIT 50
    `, [req.clienteSolicitacao.id]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar favoritos:', err);
    res.status(500).json({ error: 'Erro ao listar favoritos' });
  }
});

// Deletar favorito
router.delete('/solicitacao/favoritos/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM solicitacao_favoritos WHERE id = $1 AND cliente_id = $2',
      [req.params.id, req.clienteSolicitacao.id]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao deletar favorito:', err);
    res.status(500).json({ error: 'Erro ao deletar favorito' });
  }
});

// ==================== ENDEREÇOS SALVOS (novo padrão) ====================

// Salvar endereço
router.post('/solicitacao/enderecos-salvos', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep, latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao } = req.body;
    
    console.log('📍 Salvando endereço:', { apelido, endereco_completo, rua, cidade });
    
    if (!endereco_completo && !rua) {
      return res.status(400).json({ error: 'Endereço é obrigatório' });
    }
    
    // Verificar se já existe pelo endereço completo ou rua+numero+cidade
    const existe = await pool.query(
      `SELECT id FROM solicitacao_favoritos 
       WHERE cliente_id = $1 AND (
         (endereco_completo = $2 AND $2 IS NOT NULL) OR 
         (rua = $3 AND numero = $4 AND cidade = $5)
       )`,
      [req.clienteSolicitacao.id, endereco_completo, rua, numero, cidade]
    );
    
    if (existe.rows.length > 0) {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET apelido = COALESCE($2, apelido),
            vezes_usado = vezes_usado + 1, 
            ultimo_uso = CURRENT_TIMESTAMP,
            latitude = COALESCE($3, latitude), 
            longitude = COALESCE($4, longitude)
        WHERE id = $1
      `, [existe.rows[0].id, apelido, latitude, longitude]);
      
      return res.json({ sucesso: true, id: existe.rows[0].id, atualizado: true });
    }
    
    const result = await pool.query(`
      INSERT INTO solicitacao_favoritos (
        cliente_id, apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep,
        latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
    `, [
      req.clienteSolicitacao.id, apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep,
      latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
    ]);
    
    console.log('✅ Endereço salvo com ID:', result.rows[0].id);
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Erro ao salvar endereço:', err);
    res.status(500).json({ error: 'Erro ao salvar endereço' });
  }
});

// Buscar endereços salvos
router.get('/solicitacao/enderecos-salvos/buscar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { q } = req.query;
    
    let query = `
      SELECT * FROM solicitacao_favoritos 
      WHERE cliente_id = $1
    `;
    let params = [req.clienteSolicitacao.id];
    
    if (q && q.trim()) {
      query += ` AND (
        apelido ILIKE $2 OR 
        endereco_completo ILIKE $2 OR 
        rua ILIKE $2 OR 
        bairro ILIKE $2 OR 
        cidade ILIKE $2
      )`;
      params.push(`%${q.trim()}%`);
    }
    
    query += ` ORDER BY vezes_usado DESC, ultimo_uso DESC LIMIT 50`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar endereços:', err);
    res.status(500).json({ error: 'Erro ao buscar endereços' });
  }
});

// Registrar uso de endereço (POST)
router.post('/solicitacao/enderecos-salvos/:id/usar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.query(`
      UPDATE solicitacao_favoritos 
      SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
      WHERE id = $1 AND cliente_id = $2
    `, [id, req.clienteSolicitacao.id]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao registrar uso:', err);
    res.status(500).json({ error: 'Erro ao registrar uso' });
  }
});

// Registrar uso de endereço (PATCH)
router.patch('/solicitacao/enderecos-salvos/:id/usar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.query(`
      UPDATE solicitacao_favoritos 
      SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
      WHERE id = $1 AND cliente_id = $2
    `, [id, req.clienteSolicitacao.id]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao registrar uso:', err);
    res.status(500).json({ error: 'Erro ao registrar uso' });
  }
});

// Deletar endereço salvo
router.delete('/solicitacao/enderecos-salvos/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM solicitacao_favoritos WHERE id = $1 AND cliente_id = $2',
      [req.params.id, req.clienteSolicitacao.id]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao deletar endereço:', err);
    res.status(500).json({ error: 'Erro ao deletar endereço' });
  }
});

// BUSCAR PROFISSIONAIS - Lista motoboys disponíveis para o cliente
router.get('/solicitacao/profissionais', verificarTokenSolicitacao, async (req, res) => {
  try {
    // Usar token global de profissionais
    const codCliente = req.clienteSolicitacao.tutts_codigo_cliente || req.clienteSolicitacao.tutts_cod_cliente;
    
    if (!codCliente) {
      return res.json({ 
        profissionais: [], 
        aviso: 'Código do cliente não configurado.'
      });
    }
    
    // Buscar profissionais na API Tutts
    const payloadTutts = {
      token: process.env.TUTTS_TOKEN_PROFISSIONAIS,
      codCliente: codCliente
    };
    
    console.log('📤 Buscando profissionais na Tutts:', JSON.stringify(payloadTutts, null, 2));
    
    const response = await fetch('https://tutts.com.br/integracao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadTutts)
    });
    
    const resultado = await response.json();
    console.log('📥 Resposta profissionais Tutts:', resultado);
    
    if (resultado.Erro) {
      console.log('⚠️ Erro ao buscar profissionais:', resultado.Erro);
      return res.json({ 
        profissionais: [], 
        erro: resultado.Erro 
      });
    }
    
    if (resultado.Sucesso && Array.isArray(resultado.Sucesso)) {
      return res.json({ 
        profissionais: resultado.Sucesso.map(p => ({
          codigo: p.codigo,
          nome: p.nome,
          foto: p.foto || p.Foto || null,
          telefone: p.telefone || null,
          placa: p.placa || null,
          veiculo: p.veiculo || p.modeloVeiculo || null
        }))
      });
    }
    
    res.json({ profissionais: [] });
    
  } catch (err) {
    console.error('❌ Erro ao buscar profissionais:', err.message);
    res.status(500).json({ error: 'Erro ao buscar profissionais', detalhe: err.message });
  }
});

// RASTREIO PÚBLICO - Acompanhar corrida sem login (para compartilhar)
router.get('/api/rastreio/:codigo', async (req, res) => {
  try {
    const { codigo } = req.params;
    
    // Buscar por OS número ou por código de rastreio
    const solicitacao = await pool.query(`
      SELECT 
        s.id, s.tutts_os_numero, s.status, s.status_codigo, s.status_atualizado_em,
        s.tutts_distancia, s.tutts_duracao, s.tutts_valor, s.tutts_url_rastreamento,
        s.profissional_nome, s.profissional_foto, s.profissional_placa, 
        s.profissional_veiculo, s.profissional_cor_veiculo,
        s.criado_em, s.atualizado_em,
        c.empresa as cliente_empresa
      FROM solicitacoes_corrida s
      LEFT JOIN clientes_solicitacao c ON s.cliente_id = c.id
      WHERE s.tutts_os_numero = $1 OR s.codigo_rastreio = $1
    `, [codigo]);
    
    if (solicitacao.rows.length === 0) {
      return res.status(404).json({ error: 'Corrida não encontrada' });
    }
    
    const dados = solicitacao.rows[0];
    
    // Buscar pontos (sem dados sensíveis)
    const pontos = await pool.query(`
      SELECT 
        ordem, bairro, cidade, uf, status, 
        data_chegada, data_coletado, data_finalizado
      FROM solicitacoes_pontos 
      WHERE solicitacao_id = $1 
      ORDER BY ordem
    `, [dados.id]);
    
    // Retornar dados públicos (sem expor endereços completos, telefones, etc)
    res.json({
      os_numero: dados.tutts_os_numero,
      status: dados.status,
      status_atualizado_em: dados.status_atualizado_em,
      distancia: dados.tutts_distancia,
      duracao: dados.tutts_duracao,
      url_rastreamento_tutts: dados.tutts_url_rastreamento,
      profissional: dados.profissional_nome ? {
        nome: dados.profissional_nome,
        foto: dados.profissional_foto,
        placa: dados.profissional_placa,
        veiculo: dados.profissional_veiculo,
        cor: dados.profissional_cor_veiculo
      } : null,
      empresa: dados.cliente_empresa,
      criado_em: dados.criado_em,
      pontos: pontos.rows.map(p => ({
        ordem: p.ordem,
        local: `${p.bairro || ''}, ${p.cidade || ''}`.replace(/^, |, $/g, ''),
        status: p.status,
        chegou_em: p.data_chegada,
        coletado_em: p.data_coletado,
        finalizado_em: p.data_finalizado
      }))
    });
    
  } catch (err) {
    console.error('❌ Erro ao buscar rastreio:', err);
    res.status(500).json({ error: 'Erro ao buscar rastreio' });
  }
});

// WEBHOOK - Receber notificações da API Tutts
router.post('/solicitacao/webhook/tutts', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📨 Webhook Tutts recebido:', JSON.stringify(payload, null, 2));
    
    // Salvar log do webhook
    await pool.query(
      'INSERT INTO solicitacao_webhooks_log (tutts_os_numero, payload) VALUES ($1, $2)',
      [payload.ID, JSON.stringify(payload)]
    );
    
    if (!payload.ID) {
      return res.status(400).json({ error: 'ID da OS não informado' });
    }
    
    // Buscar solicitação pelo número da OS
    const solicitacao = await pool.query(
      'SELECT id FROM solicitacoes_corrida WHERE tutts_os_numero = $1',
      [payload.ID]
    );
    
    if (solicitacao.rows.length === 0) {
      console.log('⚠️ OS não encontrada no sistema:', payload.ID);
      return res.json({ recebido: true, processado: false, motivo: 'OS não encontrada' });
    }
    
    const solicitacaoId = solicitacao.rows[0].id;
    const statusInfo = payload.Status;
    const statusCodigo = statusInfo?.ID;
    
    // Mapear status
    let novoStatus = 'enviado';
    if (statusCodigo === 0) novoStatus = 'aceito';
    else if (statusCodigo === 0.5 || statusCodigo === 0.75) novoStatus = 'em_andamento';
    else if (statusCodigo === 1) novoStatus = 'em_andamento';
    else if (statusCodigo === 2) novoStatus = 'finalizado';
    
    // Atualizar solicitação
    await pool.query(`
      UPDATE solicitacoes_corrida SET
        status = $1,
        status_codigo = $2,
        status_atualizado_em = CURRENT_TIMESTAMP,
        tutts_url_rastreamento = COALESCE($3, tutts_url_rastreamento),
        profissional_nome = COALESCE($4, profissional_nome),
        profissional_email = COALESCE($5, profissional_email),
        profissional_foto = COALESCE($6, profissional_foto),
        profissional_placa = COALESCE($7, profissional_placa),
        profissional_veiculo = COALESCE($8, profissional_veiculo),
        profissional_cor_veiculo = COALESCE($9, profissional_cor_veiculo),
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $10
    `, [
      novoStatus,
      statusCodigo,
      payload.UrlRastreamento,
      statusInfo?.Nome,
      statusInfo?.Email,
      statusInfo?.Foto,
      statusInfo?.placa,
      statusInfo?.modeloVeiculo,
      statusInfo?.corVeiculo,
      solicitacaoId
    ]);
    
    // Atualizar ponto específico se informado
    if (payload.statusEndereco) {
      const endInfo = payload.statusEndereco;
      const pontoOrdem = endInfo.endereco?.ponto;
      
      if (pontoOrdem) {
        let statusPonto = 'pendente';
        if (endInfo.codigo === 'CHE') statusPonto = 'chegou';
        else if (endInfo.codigo === 'COL') statusPonto = 'coletado';
        else if (endInfo.codigo === 'FIN') statusPonto = 'finalizado';
        
        await pool.query(`
          UPDATE solicitacoes_pontos SET
            status = $1,
            status_atualizado_em = CURRENT_TIMESTAMP,
            data_chegada = CASE WHEN $1 = 'chegou' THEN CURRENT_TIMESTAMP ELSE data_chegada END,
            data_coletado = CASE WHEN $1 = 'coletado' THEN CURRENT_TIMESTAMP ELSE data_coletado END,
            data_finalizado = CASE WHEN $1 = 'finalizado' THEN CURRENT_TIMESTAMP ELSE data_finalizado END,
            motivo_finalizacao = COALESCE($2, motivo_finalizacao),
            motivo_descricao = COALESCE($3, motivo_descricao),
            tempo_espera = COALESCE($4, tempo_espera),
            fotos = COALESCE($5, fotos),
            assinatura = COALESCE($6, assinatura)
          WHERE solicitacao_id = $7 AND ordem = $8
        `, [
          statusPonto,
          endInfo.endereco?.motivo?.tipo,
          endInfo.endereco?.motivo?.descricao,
          endInfo.endereco?.tempoEspera,
          endInfo.endereco?.protocolo ? JSON.stringify(endInfo.endereco.protocolo) : null,
          endInfo.endereco?.assinatura ? JSON.stringify(endInfo.endereco.assinatura) : null,
          solicitacaoId,
          pontoOrdem
        ]);
      }
    }
    
    // Marcar webhook como processado
    await pool.query(
      'UPDATE solicitacao_webhooks_log SET processado = true WHERE tutts_os_numero = $1 ORDER BY id DESC LIMIT 1',
      [payload.ID]
    );
    
    res.json({ recebido: true, processado: true });
    
  } catch (err) {
    console.error('❌ Erro ao processar webhook:', err);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

// ==================== ADMIN - Gerenciar clientes de solicitação ====================

// Criar cliente de solicitação (só admin da central)
router.post('/admin/solicitacao/clientes', verificarToken, async (req, res) => {
  try {
    // Aceita ambos os nomes (novo e antigo) para compatibilidade
    const { nome, email, senha, telefone, empresa, observacoes } = req.body;
    const tutts_token_api = req.body.tutts_token_api || req.body.tutts_token;
    const tutts_codigo_cliente = req.body.tutts_codigo_cliente || req.body.tutts_cod_cliente;
    
    console.log('📝 Criando cliente solicitação:', { nome, email, telefone, empresa, tutts_token_api: tutts_token_api ? '***' : null, tutts_codigo_cliente });
    
    if (!nome || !email || !senha || !tutts_token_api || !tutts_codigo_cliente) {
      return res.status(400).json({ error: 'Nome, email, senha, token Tutts e código cliente são obrigatórios' });
    }
    
    // Verificar se email já existe
    const existe = await pool.query(
      'SELECT id FROM clientes_solicitacao WHERE email = $1',
      [email.toLowerCase()]
    );
    
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    
    const senhaHash = await bcrypt.hash(senha, 10);
    const criado_por = req.user?.id || null;
    
    const result = await pool.query(`
      INSERT INTO clientes_solicitacao (nome, email, senha_hash, telefone, empresa, tutts_token_api, tutts_codigo_cliente, criado_por, observacoes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, nome, email, empresa
    `, [nome, email.toLowerCase(), senhaHash, telefone || null, empresa || null, tutts_token_api, tutts_codigo_cliente, criado_por, observacoes || null]);
    
    console.log('✅ Cliente solicitação criado:', result.rows[0]);
    res.json({ sucesso: true, cliente: result.rows[0] });
  } catch (err) {
    console.error('❌ Erro ao criar cliente solicitação:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao criar cliente: ' + err.message });
  }
});

// Listar clientes de solicitação
router.get('/admin/solicitacao/clientes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.nome, c.email, c.telefone, c.empresa, c.ativo, c.criado_em, c.ultimo_acesso,
        c.tutts_codigo_cliente, c.tutts_codigo_cliente as tutts_cod_cliente, c.observacoes,
        (SELECT COUNT(*) FROM solicitacoes_corrida WHERE cliente_id = c.id) as total_solicitacoes
      FROM clientes_solicitacao c
      ORDER BY c.criado_em DESC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Ativar/Desativar cliente
router.patch('/admin/solicitacao/clientes/:id/ativo', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { ativo } = req.body;
    
    await pool.query(
      'UPDATE clientes_solicitacao SET ativo = $1 WHERE id = $2',
      [ativo, id]
    );
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao atualizar cliente:', err);
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
});

// Resetar senha do cliente
router.patch('/admin/solicitacao/clientes/:id/senha', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nova_senha } = req.body;
    
    // Cliente pode ter senha simples (mínimo 6 caracteres)
    const validacaoSenha = validarSenhaSimples(nova_senha);
    if (!validacaoSenha.valido) {
      return res.status(400).json({ error: validacaoSenha.erro });
    }
    
    const senhaHash = await bcrypt.hash(nova_senha, 10);
    
    await pool.query(
      'UPDATE clientes_solicitacao SET senha_hash = $1 WHERE id = $2',
      [senhaHash, id]
    );
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao resetar senha:', err);
    res.status(500).json({ error: 'Erro ao resetar senha' });
  }
});

// Atualizar credenciais Tutts do cliente
router.patch('/admin/solicitacao/clientes/:id/credenciais', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    // Aceita ambos os nomes (novo e antigo) para compatibilidade
    const tutts_token_api = req.body.tutts_token_api || req.body.tutts_token;
    const tutts_codigo_cliente = req.body.tutts_codigo_cliente || req.body.tutts_cod_cliente;
    
    await pool.query(`
      UPDATE clientes_solicitacao 
      SET tutts_token_api = COALESCE($1, tutts_token_api),
          tutts_codigo_cliente = COALESCE($2, tutts_codigo_cliente)
      WHERE id = $3
    `, [tutts_token_api, tutts_codigo_cliente, id]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao atualizar credenciais:', err);
    res.status(500).json({ error: 'Erro ao atualizar credenciais' });
  }
});

// Alterar status (ativo/inativo) do cliente de solicitação
router.patch('/admin/solicitacao/clientes/:id/status', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { ativo } = req.body;
    
    await pool.query(
      'UPDATE clientes_solicitacao SET ativo = $1 WHERE id = $2',
      [ativo, id]
    );
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao alterar status:', err);
    res.status(500).json({ error: 'Erro ao alterar status' });
  }
});

// Excluir cliente de solicitação
router.delete('/admin/solicitacao/clientes/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar se cliente existe
    const cliente = await pool.query('SELECT id, nome FROM clientes_solicitacao WHERE id = $1', [id]);
    if (cliente.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }
    
    // Excluir (as tabelas relacionadas têm ON DELETE CASCADE)
    await pool.query('DELETE FROM clientes_solicitacao WHERE id = $1', [id]);
    
    console.log(`🗑️ Cliente de solicitação excluído: ${cliente.rows[0].nome} (ID: ${id})`);
    res.json({ sucesso: true, mensagem: 'Cliente excluído com sucesso' });
  } catch (err) {
    console.error('❌ Erro ao excluir cliente:', err);
    res.status(500).json({ error: 'Erro ao excluir cliente' });
  }
});

// ==================== WEBHOOK TUTTS - NOTIFICAÇÕES EM TEMPO REAL ====================
// Endpoint para receber atualizações de status das corridas da Tutts
// URL para configurar na Tutts: https://tutts-backend-production.up.railway.app/api/webhook/tutts

router.post('/webhook/tutts', async (req, res) => {
  try {
    const payload = req.body;
    
    console.log('📥 [WEBHOOK TUTTS] Notificação recebida:', JSON.stringify(payload, null, 2));
    
    // Extrair dados do payload conforme documentação
    const osNumero = payload.ID;
    const status = payload.Status;
    const urlRastreamento = payload.UrlRastreamento;
    const rotaProfissional = payload.rotaprofissional;
    const statusEndereco = payload.statusEndereco;
    
    if (!osNumero) {
      console.log('⚠️ [WEBHOOK] Payload sem ID da OS');
      return res.status(200).json({ recebido: true, mensagem: 'Payload sem ID' });
    }
    
    // Buscar a solicitação pelo número da OS
    const solicitacao = await pool.query(
      'SELECT id, status, dados_pontos FROM solicitacoes_corrida WHERE tutts_os_numero = $1',
      [osNumero]
    );
    
    if (solicitacao.rows.length === 0) {
      console.log(`⚠️ [WEBHOOK] OS ${osNumero} não encontrada no sistema`);
      return res.status(200).json({ recebido: true, mensagem: 'OS não encontrada' });
    }
    
    const solicitacaoId = solicitacao.rows[0].id;
    let dadosPontos = solicitacao.rows[0].dados_pontos || [];
    if (typeof dadosPontos === 'string') dadosPontos = JSON.parse(dadosPontos);
    
    // Mapear status da Tutts para nosso sistema
    let novoStatus = solicitacao.rows[0].status;
    let statusDescricao = '';
    let statusId = status?.ID !== undefined ? parseFloat(status.ID) : null;
    
    if (statusId !== null) {
      switch (statusId) {
        case 0:
          novoStatus = 'aceito';
          statusDescricao = 'Profissional recebeu a OS';
          break;
        case 0.5:
          novoStatus = 'em_andamento';
          statusDescricao = 'Profissional chegou no ponto';
          break;
        case 0.75:
          novoStatus = 'em_andamento';
          statusDescricao = 'Coleta confirmada';
          break;
        case 1:
          novoStatus = 'em_andamento';
          statusDescricao = 'Ponto finalizado';
          break;
        case 2:
          novoStatus = 'finalizado';
          statusDescricao = 'OS finalizada';
          break;
      }
    }
    
    // Dados do profissional
    const profissionalNome = status?.Nome || null;
    const profissionalEmail = status?.Email || null;
    const profissionalFoto = status?.Foto || null;
    const profissionalCpf = status?.cpf || null;
    const profissionalPlaca = status?.placa || null;
    const profissionalTelefone = status?.telefone || null;
    const profissionalCodigo = status?.codProf || null;
    const corVeiculo = status?.corVeiculo || null;
    const modeloVeiculo = status?.modeloVeiculo || null;
    const dataHoraStatus = status?.dataHora || null;
    
    // Se tiver info do endereço, atualizar o ponto específico
    if (statusEndereco?.endereco) {
      const pontoNumero = parseInt(statusEndereco.endereco.ponto);
      const pontoIdx = pontoNumero - 1; // Converter para 0-indexed
      
      // Determinar status do ponto
      let pontoStatus = 'pendente';
      const codigoStatus = statusEndereco.codigo?.toUpperCase();
      if (codigoStatus === 'FIN' || statusEndereco.codigoCompleto?.toUpperCase() === 'FINALIZADO') {
        pontoStatus = 'finalizado';
      } else if (codigoStatus === 'CHE' || statusEndereco.codigoCompleto?.toUpperCase() === 'CHEGOU') {
        pontoStatus = 'chegou';
      } else if (codigoStatus === 'COL' || statusEndereco.codigoCompleto?.toUpperCase() === 'COLETADO') {
        pontoStatus = 'coletado';
      }
      
      // Garantir que o array tem o ponto
      while (dadosPontos.length <= pontoIdx) {
        dadosPontos.push({});
      }
      
      // Atualizar dados do ponto
      dadosPontos[pontoIdx] = {
        ...dadosPontos[pontoIdx],
        status: pontoStatus,
        status_codigo: statusEndereco.codigo,
        status_completo: statusEndereco.codigoCompleto,
        status_descricao: statusEndereco.descricao,
        data_evento: statusEndereco.criadoEm,
        data_coletado: statusEndereco.endereco.dataColetado,
        tempo_espera: statusEndereco.endereco.tempoEspera,
        distancia_ultimo_ponto: statusEndereco.distanciaPercorridaUltimoPonto,
        tempo_ultimo_ponto: statusEndereco.tempoPercorridaUltimoPonto,
        lat_chegada: statusEndereco.endereco.latChegada,
        lon_chegada: statusEndereco.endereco.lonChegada,
        endereco_completo: statusEndereco.endereco.enderecoCompleto,
        // Dados de entrega
        assinatura: statusEndereco.endereco.assinatura || null,
        protocolo_fotos: statusEndereco.endereco.protocolo || null,
        motivo_tipo: statusEndereco.endereco.motivo?.tipo || null,
        motivo_descricao: statusEndereco.endereco.motivo?.descricao || null,
        numero_nota: statusEndereco.endereco.numeroNota || null,
        observacao: statusEndereco.endereco.obs || null,
        // Campos de retorno (quando há insucesso)
        is_retorno: statusEndereco.endereco.retorno === true || statusEndereco.endereco.isRetorno === true || false,
        ponto_retorno_de: statusEndereco.endereco.pontoRetornoDe || statusEndereco.endereco.retornoDe || null,
        tipo_ponto: statusEndereco.endereco.tipoPonto || statusEndereco.endereco.tipo || null
      };
      
      // Log detalhado quando há insucesso ou retorno
      const motivoTipo = statusEndereco.endereco.motivo?.tipo?.toLowerCase();
      if (motivoTipo && motivoTipo !== 'sucesso') {
        console.log(`⚠️ [WEBHOOK] INSUCESSO no ponto ${pontoNumero}: ${statusEndereco.endereco.motivo?.tipo} - ${statusEndereco.endereco.motivo?.descricao}`);
        console.log(`📦 [WEBHOOK] Dados de retorno:`, JSON.stringify({
          retorno: statusEndereco.endereco.retorno,
          isRetorno: statusEndereco.endereco.isRetorno,
          pontoRetornoDe: statusEndereco.endereco.pontoRetornoDe,
          tipoPonto: statusEndereco.endereco.tipoPonto,
          endereco: statusEndereco.endereco
        }, null, 2));
      }
      
      // Verificar se é um ponto de retorno (adicionado automaticamente pela Tutts)
      if (statusEndereco.endereco.retorno || statusEndereco.endereco.isRetorno || statusEndereco.endereco.tipoPonto === 'retorno') {
        console.log(`🔄 [WEBHOOK] Ponto ${pontoNumero} é um PONTO DE RETORNO`);
        dadosPontos[pontoIdx].is_retorno = true;
      }
      
      // Log detalhado das fotos de protocolo
      if (statusEndereco.endereco.protocolo) {
        console.log(`📸 [WEBHOOK] Fotos de protocolo do ponto ${pontoNumero}:`, JSON.stringify(statusEndereco.endereco.protocolo));
      }
      
      console.log(`📍 [WEBHOOK] Ponto ${pontoNumero} atualizado: ${pontoStatus} - ${statusEndereco.descricao || ''}`);
    }
    
    // Atualizar a solicitação com todos os dados
    await pool.query(`
      UPDATE solicitacoes_corrida SET
        status = $1,
        profissional_nome = COALESCE($2, profissional_nome),
        profissional_email = COALESCE($3, profissional_email),
        profissional_foto = COALESCE($4, profissional_foto),
        profissional_cpf = COALESCE($5, profissional_cpf),
        profissional_placa = COALESCE($6, profissional_placa),
        profissional_telefone = COALESCE($7, profissional_telefone),
        profissional_codigo = COALESCE($8, profissional_codigo),
        tutts_url_rastreamento = COALESCE($9, tutts_url_rastreamento),
        dados_pontos = $10,
        rota_profissional = COALESCE($11, rota_profissional),
        cor_veiculo = COALESCE($12, cor_veiculo),
        modelo_veiculo = COALESCE($13, modelo_veiculo),
        ultima_atualizacao = NOW(),
        atualizado_em = NOW()
      WHERE id = $14
    `, [
      novoStatus,
      profissionalNome,
      profissionalEmail,
      profissionalFoto,
      profissionalCpf,
      profissionalPlaca,
      profissionalTelefone,
      profissionalCodigo,
      urlRastreamento,
      JSON.stringify(dadosPontos),
      rotaProfissional ? JSON.stringify(rotaProfissional) : null,
      corVeiculo,
      modeloVeiculo,
      solicitacaoId
    ]);
    
    // Registrar log da notificação
    await pool.query(`
      INSERT INTO webhook_tutts_logs (
        os_numero, solicitacao_id, status_id, status_descricao,
        profissional_nome, ponto_numero, ponto_status, payload_completo, criado_em
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      osNumero,
      solicitacaoId,
      statusId,
      statusDescricao,
      profissionalNome,
      statusEndereco?.endereco?.ponto || null,
      statusEndereco?.codigo || null,
      JSON.stringify(payload)
    ]);
    
    console.log(`✅ [WEBHOOK] OS ${osNumero} atualizada: ${statusDescricao} (${novoStatus})`);
    
    // Responder rapidamente (Tutts espera resposta em até 5 segundos)
    res.status(200).json({ 
      recebido: true, 
      os: osNumero, 
      status: novoStatus,
      mensagem: statusDescricao 
    });
    
  } catch (err) {
    console.error('❌ [WEBHOOK] Erro ao processar notificação:', err);
    // Mesmo com erro, responder 200 para a Tutts não reenviar
    res.status(200).json({ recebido: true, erro: err.message });
  }
});



// Endpoint para verificar se webhook está funcionando
router.get('/webhook/tutts/status', (req, res) => {
  res.json({ 
    ativo: true, 
    url: 'https://tutts-backend-production.up.railway.app/api/webhook/tutts',
    metodo: 'POST',
    mensagem: 'Configure esta URL no painel da Tutts para receber notificações'
  });
});


// ==================== ERROR HANDLER GLOBAL COM CORS ====================
// Este handler DEVE ser o último middleware antes de app.listen

  return router;
}

module.exports = { createSolicitacaoRouter };
