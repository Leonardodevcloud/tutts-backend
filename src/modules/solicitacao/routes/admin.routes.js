/**
 * Sub-Router: Solicitacao Admin + Webhooks + Rastreio
 */
const express = require('express');
const bcrypt = require('bcrypt');

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

  return router;
}

module.exports = { createSolicitacaoAdminRoutes };
