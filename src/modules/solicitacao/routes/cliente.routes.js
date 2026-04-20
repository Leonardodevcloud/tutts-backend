/**
 * Sub-Router: Solicitacao Cliente (app endpoints)
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const httpRequest = require('../../../shared/utils/httpRequest');

function createClienteRoutes(pool, helpers) {
  const router = express.Router();
  const { verificarTokenSolicitacao, validarSenhaSimples, JWT_SECRET } = helpers;

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
      centro_custo_padrao: req.clienteSolicitacao.centro_custo_padrao,
      grupo_enderecos_id: req.clienteSolicitacao.grupo_enderecos_id || null
    }
  });
});

// Retorna a chave do Google Maps JS pro frontend carregar o mapa dinamicamente.
// Protegido pelo token de solicitação — não expõe a chave publicamente.
// Observação: uma vez carregada no browser, a chave estará visível em DevTools,
// então é recomendado restringir a chave por HTTP Referrer no Google Cloud Console.
router.get('/solicitacao/maps-key', verificarTokenSolicitacao, (req, res) => {
  const chave = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!chave) {
    return res.status(500).json({ error: 'Chave do Google Maps não configurada no servidor' });
  }
  res.json({ key: chave });
});

// Atualizar configurações do cliente (partida padrão, etc)
router.patch('/solicitacao/configuracoes', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { forma_pagamento_padrao, endereco_partida_padrao, centro_custo_padrao, limpar_endereco_padrao } = req.body;
    
    console.log('💾 Salvando configurações para cliente:', req.clienteSolicitacao.id);
    console.log('📍 Endereço partida:', endereco_partida_padrao, '| limpar:', limpar_endereco_padrao);
    
    // Se limpar_endereco_padrao=true, setar null explicitamente (COALESCE não permite)
    if (limpar_endereco_padrao) {
      await pool.query(`
        UPDATE clientes_solicitacao 
        SET endereco_partida_padrao = NULL,
            forma_pagamento_padrao = COALESCE($1, forma_pagamento_padrao),
            centro_custo_padrao = COALESCE($2, centro_custo_padrao)
        WHERE id = $3
      `, [forma_pagamento_padrao, centro_custo_padrao, req.clienteSolicitacao.id]);
    } else {
      await pool.query(`
        UPDATE clientes_solicitacao 
        SET forma_pagamento_padrao = COALESCE($1, forma_pagamento_padrao),
            endereco_partida_padrao = COALESCE($2, endereco_partida_padrao),
            centro_custo_padrao = COALESCE($3, centro_custo_padrao)
        WHERE id = $4
      `, [forma_pagamento_padrao, endereco_partida_padrao ? JSON.stringify(endereco_partida_padrao) : null, centro_custo_padrao, req.clienteSolicitacao.id]);
    }
    
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
        (SELECT numero_nota FROM solicitacoes_pontos WHERE solicitacao_id = s.id AND numero_nota IS NOT NULL AND numero_nota != '' ORDER BY ordem LIMIT 1) as primeiro_numero_nota,
        (SELECT json_agg(json_build_object('status', sp.status, 'ordem', sp.ordem, 'data_chegada', sp.data_chegada, 'data_finalizado', sp.data_finalizado) ORDER BY sp.ordem) FROM solicitacoes_pontos sp WHERE sp.solicitacao_id = s.id) as pontos_status
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
      
      // NOVO: atualizar também a tabela solicitacoes_pontos (source of truth do status dos pontos)
      // A Tutts retorna os pontos no formato { codigo: "CHE"|"COL"|"FIN", statusPonto: {...} }
      if (Array.isArray(dadosOS.pontos)) {
        for (const ponto of dadosOS.pontos) {
          const pontoNumero = parseInt(ponto.ponto);
          if (!pontoNumero) continue;
          
          let pontoStatus = null;
          const codigo = (ponto.codigo || '').toUpperCase();
          if (codigo === 'CHE') pontoStatus = 'chegou';
          else if (codigo === 'COL') pontoStatus = 'coletado';
          else if (codigo === 'FIN') pontoStatus = 'finalizado';
          else continue; // pendente ou desconhecido — não atualiza
          
          const sp = ponto.statusPonto || {};
          console.log(`🕐 [SYNC] OS ${os} Ponto ${pontoNumero}: ${pontoStatus} | chegada=${sp.chegada || 'NULL'} | saida=${sp.saida || 'NULL'}`);
          try {
            await pool.query(`
              UPDATE solicitacoes_pontos SET
                status = $1,
                status_atualizado_em = CURRENT_TIMESTAMP,
                data_chegada = CASE 
                  WHEN $2::timestamp IS NOT NULL THEN $2::timestamp
                  WHEN $1 IN ('chegou','coletado','finalizado') AND data_chegada IS NULL THEN CURRENT_TIMESTAMP
                  ELSE data_chegada 
                END,
                data_coletado = CASE
                  WHEN $1 = 'coletado' AND data_coletado IS NULL THEN CURRENT_TIMESTAMP
                  ELSE data_coletado
                END,
                data_finalizado = CASE 
                  WHEN $3::timestamp IS NOT NULL THEN $3::timestamp
                  WHEN $1 = 'finalizado' AND data_finalizado IS NULL THEN CURRENT_TIMESTAMP
                  ELSE data_finalizado 
                END,
                motivo_descricao = COALESCE($4, motivo_descricao),
                fotos = COALESCE($5::jsonb, fotos),
                assinatura = COALESCE($6::jsonb, assinatura)
              WHERE solicitacao_id = $7 AND ordem = $8
            `, [
              pontoStatus,
              sp.chegada || null,
              pontoStatus === 'finalizado' ? (sp.saida || null) : null,
              sp.motivo || sp.ocorrencia || null,
              sp.protocolo?.length ? JSON.stringify(sp.protocolo) : null,
              sp.assinatura?.length ? JSON.stringify(sp.assinatura) : null,
              corrida.id,
              pontoNumero
            ]);
          } catch (errPonto) {
            console.error(`⚠️ [SINCRONIZAR] Erro ao atualizar ponto ${pontoNumero} da OS ${os}:`, errPonto.message);
          }
        }
      }
      
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
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;
    const result = grupoId
      ? await pool.query(`
          SELECT * FROM solicitacao_favoritos 
          WHERE grupo_enderecos_id = $1 OR (cliente_id = $2 AND grupo_enderecos_id IS NULL)
          ORDER BY vezes_usado DESC, ultimo_uso DESC LIMIT 50
        `, [grupoId, req.clienteSolicitacao.id])
      : await pool.query(`
          SELECT * FROM solicitacao_favoritos 
          WHERE cliente_id = $1 AND grupo_enderecos_id IS NULL
          ORDER BY vezes_usado DESC, ultimo_uso DESC LIMIT 50
        `, [req.clienteSolicitacao.id]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar favoritos:', err);
    res.status(500).json({ error: 'Erro ao listar favoritos' });
  }
});

// Deletar favorito (legado — qualquer membro do grupo pode deletar)
router.delete('/solicitacao/favoritos/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;
    if (grupoId) {
      await pool.query(
        `DELETE FROM solicitacao_favoritos 
         WHERE id = $1 AND (grupo_enderecos_id = $2 OR (cliente_id = $3 AND grupo_enderecos_id IS NULL))`,
        [req.params.id, grupoId, req.clienteSolicitacao.id]
      );
    } else {
      await pool.query(
        `DELETE FROM solicitacao_favoritos 
         WHERE id = $1 AND cliente_id = $2 AND grupo_enderecos_id IS NULL`,
        [req.params.id, req.clienteSolicitacao.id]
      );
    }
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
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;  // null se não está em grupo
    
    console.log('📍 Salvando endereço:', { apelido, endereco_completo, rua, cidade, grupoId });
    
    if (!endereco_completo && !rua) {
      return res.status(400).json({ error: 'Endereço é obrigatório' });
    }
    
    // Verificar duplicatas: se tem grupo, busca no grupo inteiro; senão só no cliente
    const scopeClausula = grupoId 
      ? '(grupo_enderecos_id = $1 OR cliente_id = $6)' 
      : '(cliente_id = $6 AND grupo_enderecos_id IS NULL)';
    const existe = await pool.query(
      `SELECT id FROM solicitacao_favoritos 
       WHERE ${scopeClausula} AND (
         (endereco_completo = $2 AND $2 IS NOT NULL) OR 
         (rua = $3 AND numero = $4 AND cidade = $5)
       )`,
      [grupoId, endereco_completo, rua, numero, cidade, req.clienteSolicitacao.id]
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
        cliente_id, grupo_enderecos_id, apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep,
        latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id
    `, [
      req.clienteSolicitacao.id, grupoId, apelido, endereco_completo, rua, numero, complemento, bairro, cidade, uf, cep,
      latitude, longitude, telefone_padrao, procurar_por_padrao, observacao_padrao
    ]);
    
    console.log('✅ Endereço salvo com ID:', result.rows[0].id, 'grupo:', grupoId || 'individual');
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Erro ao salvar endereço:', err);
    res.status(500).json({ error: 'Erro ao salvar endereço' });
  }
});

// Buscar endereços salvos (inclui endereços do grupo se o cliente pertencer a um)
router.get('/solicitacao/enderecos-salvos/buscar', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { q } = req.query;
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;
    const clienteId = req.clienteSolicitacao.id;
    
    console.log(`📚 [Endereços] Busca: cliente=${clienteId} (${req.clienteSolicitacao.nome}) | grupo=${grupoId || 'NENHUM'} | q="${q || ''}"`);
    
    // Scope: se está em grupo, vê todos do grupo + individuais próprios (legado sem grupo)
    //        se não está em grupo, vê só os individuais próprios
    let query, params;
    if (grupoId) {
      query = `
        SELECT * FROM solicitacao_favoritos 
        WHERE (grupo_enderecos_id = $1 OR (cliente_id = $2 AND grupo_enderecos_id IS NULL))
      `;
      params = [grupoId, req.clienteSolicitacao.id];
    } else {
      query = `
        SELECT * FROM solicitacao_favoritos 
        WHERE cliente_id = $1 AND grupo_enderecos_id IS NULL
      `;
      params = [req.clienteSolicitacao.id];
    }
    
    if (q && q.trim()) {
      const paramIdx = params.length + 1;
      query += ` AND (
        apelido ILIKE $${paramIdx} OR 
        endereco_completo ILIKE $${paramIdx} OR 
        rua ILIKE $${paramIdx} OR 
        bairro ILIKE $${paramIdx} OR 
        cidade ILIKE $${paramIdx}
      )`;
      params.push(`%${q.trim()}%`);
    }
    
    query += ` ORDER BY vezes_usado DESC, ultimo_uso DESC LIMIT 50`;
    
    const result = await pool.query(query, params);
    console.log(`📚 [Endereços] Resultado: ${result.rows.length} endereço(s) encontrado(s) | scope=${grupoId ? 'grupo_' + grupoId : 'individual_' + clienteId}`);
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
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;
    
    // Se está em grupo, pode marcar uso em qualquer endereço do grupo + próprios individuais
    // Se não está em grupo, só nos próprios individuais
    if (grupoId) {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
        WHERE id = $1 AND (grupo_enderecos_id = $2 OR (cliente_id = $3 AND grupo_enderecos_id IS NULL))
      `, [id, grupoId, req.clienteSolicitacao.id]);
    } else {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
        WHERE id = $1 AND cliente_id = $2 AND grupo_enderecos_id IS NULL
      `, [id, req.clienteSolicitacao.id]);
    }
    
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
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;
    
    if (grupoId) {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
        WHERE id = $1 AND (grupo_enderecos_id = $2 OR (cliente_id = $3 AND grupo_enderecos_id IS NULL))
      `, [id, grupoId, req.clienteSolicitacao.id]);
    } else {
      await pool.query(`
        UPDATE solicitacao_favoritos 
        SET vezes_usado = vezes_usado + 1, ultimo_uso = CURRENT_TIMESTAMP
        WHERE id = $1 AND cliente_id = $2 AND grupo_enderecos_id IS NULL
      `, [id, req.clienteSolicitacao.id]);
    }
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao registrar uso:', err);
    res.status(500).json({ error: 'Erro ao registrar uso' });
  }
});

// Editar endereço salvo (apelido, complemento, observação, telefone)
// Qualquer membro do grupo pode editar endereços do grupo.
router.patch('/solicitacao/enderecos-salvos/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    const { id } = req.params;
    const { apelido, complemento, observacao_padrao, telefone_padrao, procurar_por_padrao } = req.body;
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;
    
    // Verificar autorização: próprio ou mesmo grupo
    const autoCheck = grupoId
      ? 'SELECT id FROM solicitacao_favoritos WHERE id = $1 AND (grupo_enderecos_id = $2 OR (cliente_id = $3 AND grupo_enderecos_id IS NULL))'
      : 'SELECT id FROM solicitacao_favoritos WHERE id = $1 AND cliente_id = $2 AND grupo_enderecos_id IS NULL';
    const autoParams = grupoId ? [id, grupoId, req.clienteSolicitacao.id] : [id, req.clienteSolicitacao.id];
    
    const existe = await pool.query(autoCheck, autoParams);
    if (existe.rows.length === 0) {
      return res.status(404).json({ error: 'Endereço não encontrado' });
    }
    
    await pool.query(`
      UPDATE solicitacao_favoritos SET
        apelido = COALESCE($1, apelido),
        complemento = COALESCE($2, complemento),
        observacao_padrao = COALESCE($3, observacao_padrao),
        telefone_padrao = COALESCE($4, telefone_padrao),
        procurar_por_padrao = COALESCE($5, procurar_por_padrao)
      WHERE id = $6
    `, [
      apelido?.trim() || null,
      complemento?.trim() || null,
      observacao_padrao?.trim() || null,
      telefone_padrao?.trim() || null,
      procurar_por_padrao?.trim() || null,
      id
    ]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao editar endereço:', err);
    res.status(500).json({ error: 'Erro ao editar endereço' });
  }
});

// Deletar endereço salvo (qualquer membro do grupo pode deletar endereços do grupo)
router.delete('/solicitacao/enderecos-salvos/:id', verificarTokenSolicitacao, async (req, res) => {
  try {
    const grupoId = req.clienteSolicitacao.grupo_enderecos_id;
    
    if (grupoId) {
      await pool.query(
        `DELETE FROM solicitacao_favoritos 
         WHERE id = $1 AND (grupo_enderecos_id = $2 OR (cliente_id = $3 AND grupo_enderecos_id IS NULL))`,
        [req.params.id, grupoId, req.clienteSolicitacao.id]
      );
    } else {
      await pool.query(
        `DELETE FROM solicitacao_favoritos 
         WHERE id = $1 AND cliente_id = $2 AND grupo_enderecos_id IS NULL`,
        [req.params.id, req.clienteSolicitacao.id]
      );
    }
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

  return router;
}

module.exports = { createClienteRoutes };
