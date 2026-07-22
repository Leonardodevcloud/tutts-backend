/**
 * Sub-Router: Solicitacao Admin + Webhooks + Rastreio
 */
const express = require('express');
const bcrypt = require('bcrypt');
// RELATORIO_PRECO_REGRA_V1: + calcularPrecoDistancia (identica a do dispatch)
const { resolverValorCorrida, calcularPrecoDistancia, classificarCanal, normalizarStatus, montarCSV, formatarBRL } = require('../preco-hub.shared');

function createSolicitacaoAdminRoutes(pool, verificarToken, helpers) {
  const router = express.Router();
  const { validarSenhaSimples } = helpers;

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
        c.categorias_disponiveis,
        c.provedores_habilitados,
        c.preco_hub,
        c.nome_remetente, c.package_type, c.package_weight, c.aviso_entregador,
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

// Editar dados gerais do cliente (nome, email, empresa)
router.patch('/admin/solicitacao/clientes/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, empresa } = req.body;
    
    // Validações básicas
    if (nome !== undefined && (!nome || !nome.trim())) {
      return res.status(400).json({ error: 'Nome não pode ser vazio' });
    }
    if (email !== undefined) {
      if (!email || !email.trim()) {
        return res.status(400).json({ error: 'Email não pode ser vazio' });
      }
      // Verificar se o email já está em uso por outro cliente
      const existente = await pool.query(
        'SELECT id FROM clientes_solicitacao WHERE email = $1 AND id != $2',
        [email.trim().toLowerCase(), id]
      );
      if (existente.rows.length > 0) {
        return res.status(400).json({ error: 'Email já cadastrado em outro cliente' });
      }
    }
    
    await pool.query(`
      UPDATE clientes_solicitacao 
      SET nome = COALESCE($1, nome),
          email = COALESCE($2, email),
          empresa = COALESCE($3, empresa)
      WHERE id = $4
    `, [
      nome?.trim() || null,
      email?.trim().toLowerCase() || null,
      empresa !== undefined ? (empresa?.trim() || null) : null,  // permite limpar empresa
      id
    ]);
    
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao atualizar cliente:', err);
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
});

// Perfil de mensagem pro entregador (99) do cliente API.
// Vazio = usa a configuracao global. Aplicado nas corridas que saem pela
// solicitacao.html (via solicitacoes_corrida -> cliente_id) no despacho do Hub.
router.patch('/admin/solicitacao/clientes/:id/perfil-mensagem', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const PACKAGE_TYPES_99 = ['groceries', 'food', 'documents', 'apparel', 'medication', 'electronics', 'others'];
    const PACKAGE_WEIGHTS_99 = ['1kg', '5kg', '10kg', '20kg', '30kg'];
    const _txt = (v, max) => { const s = (v == null) ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };
    const _enum = (v, lista) => { const s = (v == null) ? '' : String(v).trim(); return lista.includes(s) ? s : null; };

    const nome_remetente   = _txt(req.body.nome_remetente, 100);
    const package_type     = _enum(req.body.package_type, PACKAGE_TYPES_99);
    const package_weight   = _enum(req.body.package_weight, PACKAGE_WEIGHTS_99);
    const aviso_entregador = _txt(req.body.aviso_entregador, 127);

    const { rowCount } = await pool.query(`
      UPDATE clientes_solicitacao
         SET nome_remetente = $1, package_type = $2, package_weight = $3, aviso_entregador = $4,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
    `, [nome_remetente, package_type, package_weight, aviso_entregador, id]);

    if (!rowCount) return res.status(404).json({ error: 'Cliente não encontrado' });
    res.json({ sucesso: true, perfil: { nome_remetente, package_type, package_weight, aviso_entregador } });
  } catch (err) {
    console.error('❌ Erro ao salvar perfil de mensagem:', err);
    res.status(500).json({ error: 'Erro ao salvar perfil de mensagem' });
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
      
      // NOVO: atualizar também a tabela solicitacoes_pontos (source of truth do status)
      // Antes, só o JSONB dados_pontos era atualizado, causando pontos ficarem como "pendente" na UI
      try {
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
            fotos = COALESCE($5::jsonb, fotos),
            assinatura = COALESCE($6::jsonb, assinatura)
          WHERE solicitacao_id = $7 AND ordem = $8
        `, [
          pontoStatus,
          statusEndereco.endereco.motivo?.tipo || null,
          statusEndereco.endereco.motivo?.descricao || null,
          statusEndereco.endereco.tempoEspera || null,
          statusEndereco.endereco.protocolo ? JSON.stringify(statusEndereco.endereco.protocolo) : null,
          statusEndereco.endereco.assinatura ? JSON.stringify(statusEndereco.endereco.assinatura) : null,
          solicitacaoId,
          pontoNumero
        ]);
        console.log(`✅ [WEBHOOK] Tabela solicitacoes_pontos atualizada: ponto ${pontoNumero} → ${pontoStatus}`);
      } catch (errPonto) {
        console.error(`⚠️ [WEBHOOK] Erro ao atualizar tabela solicitacoes_pontos (não crítico, JSONB foi salvo):`, errPonto.message);
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


// ==================== GRUPOS DE ENDEREÇOS COMPARTILHADOS ====================
// Permite agrupar clientes_solicitacao que compartilham o mesmo pool de endereços salvos.

// Listar grupos
router.get('/admin/grupos-enderecos', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.*,
        COUNT(DISTINCT c.id) AS total_clientes,
        COUNT(DISTINCT f.id) AS total_enderecos
      FROM grupos_enderecos g
      LEFT JOIN clientes_solicitacao c ON c.grupo_enderecos_id = g.id
      LEFT JOIN solicitacao_favoritos f ON f.grupo_enderecos_id = g.id
      GROUP BY g.id
      ORDER BY g.nome
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar grupos:', err);
    res.status(500).json({ error: 'Erro ao listar grupos' });
  }
});

// Buscar um grupo específico com lista de clientes
router.get('/admin/grupos-enderecos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const grupo = await pool.query('SELECT * FROM grupos_enderecos WHERE id = $1', [id]);
    if (grupo.rows.length === 0) return res.status(404).json({ error: 'Grupo não encontrado' });
    const clientes = await pool.query(
      'SELECT id, nome, email, empresa FROM clientes_solicitacao WHERE grupo_enderecos_id = $1 ORDER BY nome',
      [id]
    );
    const totalEnderecos = await pool.query(
      'SELECT COUNT(*) AS total FROM solicitacao_favoritos WHERE grupo_enderecos_id = $1',
      [id]
    );
    res.json({ ...grupo.rows[0], clientes: clientes.rows, total_enderecos: parseInt(totalEnderecos.rows[0].total) });
  } catch (err) {
    console.error('❌ Erro ao buscar grupo:', err);
    res.status(500).json({ error: 'Erro ao buscar grupo' });
  }
});

// Criar grupo
router.post('/admin/grupos-enderecos', verificarToken, async (req, res) => {
  try {
    const { nome, descricao } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    const result = await pool.query(
      'INSERT INTO grupos_enderecos (nome, descricao) VALUES ($1, $2) RETURNING *',
      [nome.trim(), descricao?.trim() || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar grupo:', err);
    res.status(500).json({ error: 'Erro ao criar grupo' });
  }
});

// Editar grupo
router.patch('/admin/grupos-enderecos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, ativo } = req.body;
    await pool.query(`
      UPDATE grupos_enderecos SET
        nome = COALESCE($1, nome),
        descricao = COALESCE($2, descricao),
        ativo = COALESCE($3, ativo),
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [nome?.trim() || null, descricao?.trim() || null, ativo, id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao editar grupo:', err);
    res.status(500).json({ error: 'Erro ao editar grupo' });
  }
});

// Excluir grupo (clientes ficam sem grupo; endereços ficam sem grupo mas continuam no cliente que criou)
router.delete('/admin/grupos-enderecos/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    // Os SET NULL das FKs cuidam de desvincular clientes e endereços automaticamente
    await pool.query('DELETE FROM grupos_enderecos WHERE id = $1', [id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('❌ Erro ao excluir grupo:', err);
    res.status(500).json({ error: 'Erro ao excluir grupo' });
  }
});

// Atribuir cliente a um grupo (ou remover do grupo passando null)
// Ao atribuir, MIGRA automaticamente todos os endereços individuais desse cliente pro grupo.
router.patch('/admin/solicitacao/clientes/:id/grupo', verificarToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { grupo_enderecos_id } = req.body; // pode ser null
    
    await client.query('BEGIN');
    
    // Atualizar o cliente
    await client.query(
      'UPDATE clientes_solicitacao SET grupo_enderecos_id = $1 WHERE id = $2',
      [grupo_enderecos_id || null, id]
    );
    
    if (grupo_enderecos_id) {
      // Migrar endereços individuais (sem grupo) desse cliente pro grupo
      const migracao = await client.query(
        `UPDATE solicitacao_favoritos 
         SET grupo_enderecos_id = $1 
         WHERE cliente_id = $2 AND grupo_enderecos_id IS NULL
         RETURNING id`,
        [grupo_enderecos_id, id]
      );
      await client.query('COMMIT');
      return res.json({ sucesso: true, enderecos_migrados: migracao.rows.length });
    } else {
      // Removendo do grupo: endereços ficam "órfãos" (sem grupo), mas como cliente_id
      // continua sendo desse cliente, ainda serão visíveis apenas pra ele.
      // Desvincula todos os endereços que ESSE cliente criou e que estão no grupo
      await client.query(
        'UPDATE solicitacao_favoritos SET grupo_enderecos_id = NULL WHERE cliente_id = $1',
        [id]
      );
      await client.query('COMMIT');
      return res.json({ sucesso: true });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Erro ao atribuir grupo:', err);
    res.status(500).json({ error: 'Erro ao atribuir grupo' });
  } finally {
    client.release();
  }
});


// ─── Categorias de frete por cliente (integração Mapp "Cliente informa") ──────
// GET  /admin/solicitacao/clientes/:id/categorias  → lista categorias atuais
// PUT  /admin/solicitacao/clientes/:id/categorias  → substitui a lista completa
//
// Body esperado no PUT: { categorias: [{ sigla: "M", nome: "Motofrete" }, ...] }
// Enviar array vazio desabilita o dropdown no frontend.
router.get('/admin/solicitacao/clientes/:id/categorias', verificarToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT categorias_disponiveis FROM clientes_solicitacao WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
    res.json({ categorias: rows[0].categorias_disponiveis || [] });
  } catch (err) {
    console.error('❌ Erro ao buscar categorias:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/admin/solicitacao/clientes/:id/categorias', verificarToken, async (req, res) => {
  try {
    const { categorias } = req.body; // [{ sigla, nome }]
    if (!Array.isArray(categorias)) {
      return res.status(400).json({ error: 'Campo "categorias" deve ser um array' });
    }
    // Valida cada item
    for (const c of categorias) {
      if (!c.sigla || !c.nome) {
        return res.status(400).json({ error: 'Cada categoria precisa de "sigla" e "nome"' });
      }
    }
    const { rows } = await pool.query(
      'UPDATE clientes_solicitacao SET categorias_disponiveis = $1 WHERE id = $2 RETURNING id',
      [JSON.stringify(categorias), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
    console.log(`✅ [admin] Categorias do cliente ${req.params.id} atualizadas:`, categorias);
    res.json({ sucesso: true, categorias });
  } catch (err) {
    console.error('❌ Erro ao salvar categorias:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});


// GET  /admin/solicitacao/clientes/:id/provedores  → lista provedores atuais
// PUT  /admin/solicitacao/clientes/:id/provedores  → substitui lista
//
// Body PUT: { provedores: ["tutts","uber","99"] }
// "tutts" é sempre incluído mesmo que não enviado.
router.get('/admin/solicitacao/clientes/:id/provedores', verificarToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT provedores_habilitados FROM clientes_solicitacao WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
    const provedores = rows[0].provedores_habilitados || ['tutts'];
    // Garante que tutts sempre está presente
    if (!provedores.includes('tutts')) provedores.unshift('tutts');
    res.json({ provedores });
  } catch (err) {
    console.error('❌ Erro ao buscar provedores:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/admin/solicitacao/clientes/:id/provedores', verificarToken, async (req, res) => {
  try {
    let { provedores } = req.body;
    if (!Array.isArray(provedores)) {
      return res.status(400).json({ error: 'Campo "provedores" deve ser um array' });
    }
    const VALIDOS = ['tutts', 'uber', '99'];
    for (const p of provedores) {
      if (!VALIDOS.includes(p)) {
        return res.status(400).json({ error: 'Provedor inválido: ' + p + '. Válidos: ' + VALIDOS.join(', ') });
      }
    }
    // tutts sempre presente
    if (!provedores.includes('tutts')) provedores = ['tutts', ...provedores];
    const { rows } = await pool.query(
      'UPDATE clientes_solicitacao SET provedores_habilitados = $1 WHERE id = $2 RETURNING id',
      [JSON.stringify(provedores), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
    console.log('[admin] Provedores do cliente ' + req.params.id + ' atualizados:', provedores);
    res.json({ sucesso: true, provedores });
  } catch (err) {
    console.error('❌ Erro ao salvar provedores:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================================
// PRECO DO HUB POR CLIENTE (2026-07)
// GET  /admin/solicitacao/clientes/:id/preco-hub  -> tabela atual do cliente
// PUT  /admin/solicitacao/clientes/:id/preco-hub  -> salva/atualiza a tabela
// Body PUT: { ativo, valor_fixo, km_base, valor_km_adicional }
// ============================================================================
router.get('/admin/solicitacao/clientes/:id/preco-hub', verificarToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT preco_hub FROM clientes_solicitacao WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
    res.json({ preco_hub: rows[0].preco_hub || null });
  } catch (err) {
    console.error('❌ Erro ao buscar preco_hub:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/admin/solicitacao/clientes/:id/preco-hub', verificarToken, async (req, res) => {
  try {
    const b = req.body || {};

    // Permite limpar a tabela (voltar a herdar global) enviando null/vazio.
    if (b.preco_hub === null || (b.limpar === true)) {
      const { rows } = await pool.query(
        'UPDATE clientes_solicitacao SET preco_hub = NULL WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
      return res.json({ sucesso: true, preco_hub: null });
    }

    const num = (v) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const valorFixo = num(b.valor_fixo);
    const kmBase = num(b.km_base);
    const valorKmAdic = num(b.valor_km_adicional);

    if (valorFixo === null || valorFixo < 0) {
      return res.status(400).json({ error: 'valor_fixo é obrigatório e deve ser >= 0' });
    }
    if (kmBase !== null && kmBase < 0) {
      return res.status(400).json({ error: 'km_base deve ser >= 0' });
    }
    if (valorKmAdic !== null && valorKmAdic < 0) {
      return res.status(400).json({ error: 'valor_km_adicional deve ser >= 0' });
    }

    const tabela = {
      ativo: b.ativo === false ? false : true,
      valor_fixo: valorFixo,
      km_base: kmBase != null ? kmBase : 0,
      valor_km_adicional: valorKmAdic != null ? valorKmAdic : 0,
    };

    const { rows } = await pool.query(
      'UPDATE clientes_solicitacao SET preco_hub = $1 WHERE id = $2 RETURNING id',
      [JSON.stringify(tabela), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente não encontrado' });
    console.log('[admin] preco_hub do cliente ' + req.params.id + ' atualizado:', tabela);
    res.json({ sucesso: true, preco_hub: tabela });
  } catch (err) {
    console.error('❌ Erro ao salvar preco_hub:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================================
// RELATORIO HUB — corridas despachadas via Hub (uber/99), valor RECALCULADO
// on-read pela tabela do cliente (cliente sempre manda), senao valor gravado.
// GET /admin/relatorio/hub-corridas?de=YYYY-MM-DD&ate=YYYY-MM-DD&cliente_id=&provider=&formato=csv
// ============================================================================
router.get('/admin/relatorio/hub-corridas', verificarToken, async (req, res) => {
  try {
    const { de, ate, cliente_id, provider, status, formato, lojas } = req.query; // RELATORIO_CLIENTE_V1: + lojas

    const cteWhere = [];
    const params = [];
    let i = 1;
    if (de)  { cteWhere.push(`d.created_at >= $${i++}`); params.push(de); }
    if (ate) { cteWhere.push(`d.created_at < ($${i++}::date + INTERVAL '1 day')`); params.push(ate); }
    if (provider) { cteWhere.push(`d.provider_code = $${i++}`); params.push(provider); }
    const cteWhereSql = cteWhere.length ? `WHERE ${cteWhere.join(' AND ')}` : '';

    const outWhere = [];
    if (cliente_id) { outWhere.push(`sc.cliente_id = $${i++}`); params.push(parseInt(cliente_id, 10)); }
    const outWhereSql = outWhere.length ? `WHERE ${outWhere.join(' AND ')}` : '';

    const sql = `
      WITH ld AS (
        SELECT DISTINCT ON (d.codigo_os)
          d.codigo_os, d.provider_code, d.distancia_km, d.valor_servico,
          d.endereco_coleta, d.endereco_entrega, d.courier_data,
          d.status_canonico, d.created_at,
          -- [relatorio-retorno-v1] marca de que o adicional de retorno FOI
          -- cobrado nesta corrida (gravada pelo WebhookDispatcher no RETURNING).
          d.retorno_cobrado_em,
          -- RELATORIO_CLIENTE_V1
          -- regra_id: e daqui que o card da loja tira o nome do cliente. O
          -- relatorio usava so solicitacoes_corrida, que existe apenas pra
          -- corrida criada via Solicitacao — por isso a coluna vinha "—" na
          -- maioria das linhas.
          d.regra_id,
          -- CLIENTE_MANUAL_V1: atribuicao manual (tem prioridade sobre regra_id)
          d.regra_id_manual, d.regra_manual_por, d.regra_manual_em,
          -- RELATORIO_CUSTO_V1 — custo do provedor, duas fontes:
          --   valor_provider       = a COTACAO do despacho. E o unico que a
          --                          Uber tem.
          --   valor_provider_final = o custo REAL, com taxas. So a 99 preenche,
          --                          e so quando a entrega chega em status
          --                          terminal (TrackingPoller).
          -- O COALESCE la embaixo prefere o final; sem ele, usa a cotacao.
          d.valor_provider, d.valor_provider_final,
          -- valor_servico_mapp_original: gravado no despacho a partir do que a
          -- Mapp mandou. O valor_servico pode ser reescrito depois pela tabela
          -- de preco do cliente; este aqui nao muda.
          d.valor_servico_mapp_original
        FROM logistics_deliveries d
        ${cteWhereSql}
        ORDER BY d.codigo_os, d.created_at DESC
      )
      -- RELATORIO_PERF_V1
      -- Aqui havia um join lateral que resolvia o cliente UMA VEZ POR ENTREGA.
      -- Como o predicado aplicava trim() na coluna, o indice existente (que e
      -- sobre a coluna crua) nao podia ser usado: cada execucao varria
      -- solicitacoes_corrida inteira. Em 30 dias isso vira milhares de scans e
      -- a request nunca volta. Era a causa do relatorio girar sem responder.
      --
      -- Agora a CTE abaixo resolve o cliente de CADA OS numa passada so, e o
      -- resultado entra por hash join. O DISTINCT ON com ORDER BY id DESC
      -- preserva exatamente a semantica anterior (a solicitacao mais recente
      -- da OS). O IN (SELECT ...) limita ao periodo ja filtrado.
      , sc_os AS (
        SELECT DISTINCT ON (trim(tutts_os_numero))
               trim(tutts_os_numero) AS os_txt,
               cliente_id
          FROM solicitacoes_corrida
         WHERE tutts_os_numero IS NOT NULL
           AND trim(tutts_os_numero) <> ''
           AND trim(tutts_os_numero) IN (SELECT codigo_os::text FROM ld)
         ORDER BY trim(tutts_os_numero), id DESC
      )
      SELECT ld.*, sc.cliente_id, cs.nome AS cliente_nome, cs.preco_hub,
             dr.cliente_nome AS regra_cliente_nome,
             -- RELATORIO_PRECO_REGRA_V1: tabela de preco da regra. E ela que
             -- define o valor do Hub; o valor_servico gravado nao serve porque
             -- o dispatch nunca chega a aplicar a tabela (opts.regra fica
             -- undefined la), entao ele guarda o valor da Mapp.
             dr.preco_valor_fixo, dr.preco_km_base, dr.preco_valor_km_adicional,
             -- [relatorio-retorno-v1] adicional fixo por devolucao (por cliente)
             dr.preco_retorno_valor
      FROM ld
      LEFT JOIN sc_os sc ON sc.os_txt = ld.codigo_os::text
      LEFT JOIN clientes_solicitacao cs ON cs.id = sc.cliente_id
      -- RELATORIO_CLIENTE_V1: mesma fonte do card da loja.
      -- CLIENTE_MANUAL_V1 — o COALESCE faz o trabalho todo.
      -- Atribuiu a corrida a uma loja? Entao o nome E A TABELA DE PRECO
      -- daquela regra passam a valer, porque as duas coisas saem deste join.
      LEFT JOIN logistics_dispatch_rules dr ON dr.id = COALESCE(ld.regra_id_manual, ld.regra_id)
      ${outWhereSql}
      ORDER BY ld.created_at DESC
    `;
    // RELATORIO_SEM_LIMITE_V1 — o LIMIT 2000 saiu.
    //
    // Ele nao era um teto de seguranca: era um TRUNCAMENTO SILENCIOSO. Num
    // periodo de 30 dias a consulta batia nas 2000 e o relatorio mostrava
    // "661 de 2000" — os totais, o custo e o liquido eram calculados em cima
    // de um pedaco dos dados, sem nenhum aviso de que faltava coisa.
    //
    // O que limita a consulta e a JANELA DE DATAS, que e obrigatoria na
    // pratica e agora vem com "hoje" por padrao. Com o indice funcional do
    // pkg-relatorio-perf-v2 a consulta e rapida.
    //
    // CUIDADO: um intervalo muito largo (um ano) passa a trazer tudo pro
    // navegador. Se isso virar problema, o caminho e paginacao de verdade —
    // nao um teto mudo que mente no total.

    const { rows } = await pool.query(sql, params);

    // RELATORIO_CLIENTE_V1 — resolucao do nome do cliente, em 3 degraus:
    //
    //   1. regra_id gravado na entrega  -> EXATAMENTE o que o card mostra
    //   2. match por endereco de coleta -> cobre as entregas antigas, que
    //      foram despachadas antes do match manual passar a gravar regra_id
    //   3. clientes_solicitacao         -> preserva o que ja funcionava pras
    //      corridas criadas via Solicitacao
    //
    // O passo 2 roda em JS de proposito: reusa normalizarEnderecoParaMatch,
    // a MESMA funcao do despacho. Em SQL seria outra implementacao pra manter
    // em sincronia — e ela ia divergir.
    // RELATORIO_PRECO_REGRA_V1 — tabela global, lida UMA vez.
    // Mesma ordem do dispatch (_resolverTabelaPreco): regra -> global -> nada.
    // Se a linha id=1 nao existir, simplesmente nao ha tabela global.
    let _tabGlobal = null;
    try {
      const { rows: _cg } = await pool.query(
        `SELECT tabela_preco_ativa, preco_valor_fixo, preco_km_base, preco_valor_km_adicional
           FROM logistics_config_global WHERE id = 1`
      );
      const _c = _cg[0];
      if (_c && _c.tabela_preco_ativa && _c.preco_valor_fixo != null) {
        _tabGlobal = {
          valorFixo: Number(_c.preco_valor_fixo),
          kmBase: _c.preco_km_base != null ? Number(_c.preco_km_base) : 0,
          valorKmAdicional: _c.preco_valor_km_adicional != null ? Number(_c.preco_valor_km_adicional) : 0,
        };
      }
    } catch (e) {
      console.warn('[relatorio] tabela global indisponivel:', e.message);
    }

    let _regrasMatch = [];
    try {
      const { normalizarEnderecoParaMatch } = require('../../logistics/core/DispatchRuleMatcher');
      // ORDER BY id ASC = mesmo desempate do matcher (a primeira que casar vence).
      // Sem filtro de ativo: aqui o objetivo e NOMEAR, nao decidir despacho —
      // uma regra desativada hoje ainda identifica de quem era aquela corrida.
      // RELATORIO_PRECO_ENDERECO_V1: carrega TAMBEM a tabela de preco.
      // Antes so vinha o nome, e ai a corrida casada por endereco ganhava
      // cliente mas nao ganhava preco -> caia no valor da Mapp.
      const { rows: _rr } = await pool.query(
        `SELECT cliente_nome, trecho_endereco, cliente_identificador,
                preco_valor_fixo, preco_km_base, preco_valor_km_adicional
           FROM logistics_dispatch_rules ORDER BY id ASC`
      );
      _regrasMatch = _rr.map(rg => ({
        nome: rg.cliente_nome,
        trecho: normalizarEnderecoParaMatch(rg.trecho_endereco || rg.cliente_nome || ''),
        ident: normalizarEnderecoParaMatch(rg.cliente_identificador || ''),
        precoValorFixo: rg.preco_valor_fixo,
        precoKmBase: rg.preco_km_base,
        precoValorKmAdicional: rg.preco_valor_km_adicional,
      }));
      var _normEnd = normalizarEnderecoParaMatch;
    } catch (e) {
      console.warn('[relatorio] match por endereco indisponivel:', e.message);
    }

    // RELATORIO_PRECO_ENDERECO_V1: devolve a REGRA inteira, nao so o nome —
    // quem chama precisa do preco tambem.
    // Mesmos limiares do DispatchRuleMatcher: identificador >= 4, trecho >= 5.
    const _regraPorEndereco = (endereco) => {
      if (!_normEnd || !_regrasMatch.length) return null;
      const alvo = _normEnd(endereco || '');
      if (!alvo) return null;
      for (const rg of _regrasMatch) {
        if (rg.ident && rg.ident.length >= 4 && alvo.includes(rg.ident)) return rg;
        if (rg.trecho && rg.trecho.length >= 5 && alvo.includes(rg.trecho)) return rg;
      }
      return null;
    };

    let corridas = rows.map(r => {
      const courier = r.courier_data || {};
      let motoboy = courier.name || null;
      let km = r.distancia_km != null ? Number(r.distancia_km) : null;
      // RELATORIO_PRECO_REGRA_V1 — valor do Hub pela tabela, na ordem do dispatch:
      //   1. tabela da REGRA do cliente
      //   2. tabela GLOBAL (se ativa)
      //   3. preco_hub do clientes_solicitacao (corridas via Solicitacao)
      //   4. valor gravado (= o que a Mapp mandou)
      //
      // Calculado aqui e nao lido de valor_servico porque o dispatch nunca
      // aplica a tabela: ele le opts.regra, que nenhum caller preenche. Assim
      // o relatorio fica certo inclusive pras corridas ja gravadas.
      let valor = null, origem = 'indefinido';
      // RELATORIO_PRECO_ENDERECO_V1 — a regra da corrida, resolvida ANTES do
      // valor. Antes o cliente era resolvido la embaixo, depois do calculo:
      // dava pra nomear pelo endereco, mas nao dava pra PRECIFICAR por ele,
      // porque a regra casada nem existia ainda nesse ponto.
      //
      // Duas fontes, mesma prioridade do nome:
      //   1. regra_id gravado na entrega (veio no JOIN)
      //   2. match por endereco de coleta (despacho sem regra)
      let _cliente = r.regra_cliente_nome || null;
      // CLIENTE_MANUAL_V1: origem 'manual' quando foi atribuida na mao — o
      // relatorio mostra isso no title da celula, pra nao confundir com match
      // automatico.
      let _clienteOrigem = _cliente ? (r.regra_id_manual ? 'manual' : 'regra') : null;
      let _regraEnd = null;
      if (!_cliente) {
        _regraEnd = _regraPorEndereco(r.endereco_coleta);
        if (_regraEnd) { _cliente = _regraEnd.nome; _clienteOrigem = 'endereco'; }
      }
      if (!_cliente && r.cliente_nome) {
        _cliente = r.cliente_nome;
        _clienteOrigem = 'solicitacao';
      }

      // Tabela: do regra_id, ou da regra casada por endereco. Sem isso, a
      // corrida sem regra_id ficava com o valor da Mapp mesmo tendo uma regra
      // com tabela batendo no endereco dela.
      let _tabRegra = null;
      if (r.preco_valor_fixo != null) {
        _tabRegra = {
          valorFixo: Number(r.preco_valor_fixo),
          kmBase: r.preco_km_base != null ? Number(r.preco_km_base) : 0,
          valorKmAdicional: r.preco_valor_km_adicional != null ? Number(r.preco_valor_km_adicional) : 0,
        };
      } else if (_regraEnd && _regraEnd.precoValorFixo != null) {
        _tabRegra = {
          valorFixo: Number(_regraEnd.precoValorFixo),
          kmBase: _regraEnd.precoKmBase != null ? Number(_regraEnd.precoKmBase) : 0,
          valorKmAdicional: _regraEnd.precoValorKmAdicional != null ? Number(_regraEnd.precoValorKmAdicional) : 0,
        };
      }

      const _vRegra = _tabRegra ? calcularPrecoDistancia(km, _tabRegra) : null;
      if (_vRegra != null) {
        valor = _vRegra; origem = 'regra';
      } else {
        const _vGlobal = _tabGlobal ? calcularPrecoDistancia(km, _tabGlobal) : null;
        if (_vGlobal != null) {
          valor = _vGlobal; origem = 'global';
        } else {
          const _rv = resolverValorCorrida({
            distanciaKm: km,
            precoHub: r.preco_hub,
            valorGravado: r.valor_servico,
          });
          valor = _rv.valor; origem = _rv.origem;
        }
      }
      // [relatorio-retorno-v3] Adicional por devolucao — base STATUS (retroativo).
      // Toda corrida com status de devolucao soma o adicional configurado na
      // regra do cliente, INCLUSIVE as anteriores a esta feature. Por isso
      // olhamos o status_canonico e nao a marca retorno_cobrado_em (que so
      // existe pras devolucoes novas).
      //
      // Cobrimos RETURNED (devolucao concluida) e RETURNING (em andamento):
      // o normalizarStatus so mapeia 'returned', entao checamos o valor bruto.
      let _adicRetorno = 0;
      const _stRaw = String(r.status_canonico || '').trim().toUpperCase();
      const _ehDevolucao = _stRaw === 'RETURNED' || _stRaw === 'RETURNING'
        || ['DEVOLVIDO', 'RETURN'].includes(_stRaw);
      if (_ehDevolucao && r.preco_retorno_valor != null && valor != null) {
        const _ad = Number(r.preco_retorno_valor);
        if (Number.isFinite(_ad) && _ad > 0) {
          _adicRetorno = _ad;
          valor = Math.round((Number(valor) + _ad) * 100) / 100;
          origem = origem + '+retorno';
        }
      }

      // Cancelamento consistente: qualquer sinal (status_canonico ou "motoboy"
      // vindo como "Cancelado") cancela -> zera motoboy, km e valor.
      const cancelada = [r.status_canonico, motoboy]
        .some(s => normalizarStatus(s) === 'Cancelado');
      let statusNorm;
      if (cancelada) {
        statusNorm = 'Cancelado';
        motoboy = null; km = null; valor = null; origem = 'cancelado';
      } else {
        statusNorm = normalizarStatus(r.status_canonico);
      }
      // RELATORIO_PRECO_ENDERECO_V1: o cliente ja foi resolvido la em cima,
      // junto com a regra — o bloco que ficava aqui saiu pra nao duplicar.
      // valor_servico_mapp_original: zerado quando cancelada, igual km/valor.
      // Se ficasse cru, o total da coluna Mapp nao bateria com o de Valor e
      // pareceria bug.
      const _valorMapp = cancelada || r.valor_servico_mapp_original == null
        ? null : Number(r.valor_servico_mapp_original);

      // RELATORIO_CUSTO_V1 — custo do provedor e faturamento liquido.
      //
      // NAO zeramos o custo quando cancelada, ao contrario de km/valor: a 99
      // grava valor_provider_final tambem em CANCELED/RETURNED, e taxa de
      // cancelamento e dinheiro que saiu de verdade. Esconder isso mostraria
      // um liquido melhor do que o real.
      const _custoFinal = r.valor_provider_final != null ? Number(r.valor_provider_final) : null;
      const _custoCot   = r.valor_provider != null ? Number(r.valor_provider) : null;
      const _custo = _custoFinal != null ? _custoFinal : _custoCot;
      const _custoOrigem = _custoFinal != null ? 'final' : (_custoCot != null ? 'cotacao' : null);

      // liquido = valor do Hub - custo. Cancelada com taxa da uma liquida
      // NEGATIVA, que e exatamente o que aconteceu.
      const _liquido = (valor != null || _custo != null)
        ? Math.round(((valor || 0) - (_custo || 0)) * 100) / 100
        : null;
      return {
        os: r.codigo_os,
        provider: r.provider_code,
        canal: classificarCanal(r.provider_code),
        cliente_id: r.cliente_id || null,
        cliente_nome: _cliente || null,
        cliente_origem: _clienteOrigem,
        valor_mapp: _valorMapp,
        // RELATORIO_CUSTO_V1
        custo_provedor: _custo,
        custo_origem: _custoOrigem,
        faturamento_liquido: _liquido,
        endereco_coleta: r.endereco_coleta || '',
        endereco_entrega: r.endereco_entrega || '',
        motoboy,
        km,
        valor,
        valor_origem: origem,
        // [relatorio-retorno-v1] quanto do valor veio do adicional de devolucao
        // (0/null = sem retorno). O 'valor' acima JA inclui isso.
        adicional_retorno: _adicRetorno > 0 ? _adicRetorno : null,
        status: statusNorm,
        data: r.created_at,
      };
    });

    // Filtro opcional por status (rotulo normalizado; ex: Entregue, Cancelado)
    if (status && status !== 'todos') {
      corridas = corridas.filter(c => c.status === status);
    }

    // RELATORIO_CLIENTE_V1 — lista de lojas do periodo, ANTES de filtrar por
    // loja: senao a propria selecao encolheria as opcoes disponiveis e nao
    // daria pra remarcar o que foi desmarcado.
    const lojasDisponiveis = Array.from(
      new Set(corridas.map(c => c.cliente_nome).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const temSemCliente = corridas.some(c => !c.cliente_nome);

    // Filtro por loja. O front filtra na tela (resposta instantanea), mas o
    // parametro existe pro CSV sair igual ao que esta na tela.
    // '__sem__' = as corridas sem cliente resolvido.
    if (lojas) {
      const sel = new Set(String(lojas).split(',').map(s => s.trim()).filter(Boolean));
      if (sel.size) {
        corridas = corridas.filter(c => sel.has(c.cliente_nome || '__sem__'));
      }
    }

    if (String(formato).toLowerCase() === 'csv') {
      // RELATORIO_CLIENTE_V1: + coluna do valor original da Mapp
      // RELATORIO_CUSTO_V1: + custo do provedor e faturamento liquido
      const headers = ['OS', 'Cliente', 'Canal', 'Provedor', 'Coleta', 'Entrega', 'Motoboy', 'KM', 'Valor Hub (R$)', 'Valor Mapp (R$)', 'Custo Provedor (R$)', 'Faturamento Liquido (R$)', 'Status', 'Data'];
      const linhas = corridas.map(c => [
        c.os, c.cliente_nome || '', c.canal, c.provider, c.endereco_coleta, c.endereco_entrega,
        c.motoboy || '', c.km != null ? String(c.km).replace('.', ',') : '',
        formatarBRL(c.valor), formatarBRL(c.valor_mapp),
        formatarBRL(c.custo_provedor), formatarBRL(c.faturamento_liquido),
        c.status,
        c.data ? new Date(c.data).toISOString() : '',
      ]);
      const csv = montarCSV(headers, linhas);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio-hub.csv"');
      return res.send(csv);
    }

    const totais = corridas.reduce((acc, c) => {
      acc.corridas += 1;
      if (c.km != null) acc.km += c.km;
      if (c.valor != null) acc.valor += c.valor;
      // RELATORIO_CUSTO_V1
      if (c.custo_provedor != null) acc.custo += c.custo_provedor;
      if (c.faturamento_liquido != null) acc.liquido += c.faturamento_liquido;
      return acc;
    }, { corridas: 0, km: 0, valor: 0, custo: 0, liquido: 0 });
    totais.km = Math.round(totais.km * 100) / 100;
    totais.valor = Math.round(totais.valor * 100) / 100;
    totais.custo = Math.round(totais.custo * 100) / 100;
    totais.liquido = Math.round(totais.liquido * 100) / 100;

    res.json({ success: true, totais, corridas, lojas_disponiveis: lojasDisponiveis, tem_sem_cliente: temSemCliente }); // RELATORIO_CLIENTE_V1
  } catch (err) {
    console.error('❌ Erro no relatório hub:', err.message);
    res.status(500).json({ error: 'Erro ao gerar relatório', detalhe: err.message });
  }
});

// ==================== ERROR HANDLER GLOBAL COM CORS ====================
// Este handler DEVE ser o último middleware antes de app.listen

  return router;

  return router;
}

module.exports = { createSolicitacaoAdminRoutes };
