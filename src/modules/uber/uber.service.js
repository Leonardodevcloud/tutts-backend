/**
 * MÓDULO UBER - Service
 * Lógica pura: autenticação OAuth2, chamadas Mapp/Uber, orquestração do fluxo
 */

const httpRequest = require('../../shared/utils/httpRequest');
const {
  UBER_API_BASE,
  UBER_AUTH_URL,
  UBER_SCOPE,
  UBER_STATUS_MAP,
  UBER_FLOW_STATUS,
  montarEnderecoUber,
  formatarTelefoneE164,
  truncarTexto,
} = require('./uber.shared');

// ════════════════════════════════════════════════════════════
// CONFIGURAÇÃO - buscar config do banco
// ════════════════════════════════════════════════════════════

async function obterConfig(pool) {
  const { rows } = await pool.query('SELECT * FROM uber_config WHERE id = 1');
  return rows[0] || null;
}

// ════════════════════════════════════════════════════════════
// OAUTH2 - Token de acesso Uber Direct
// ════════════════════════════════════════════════════════════

async function obterTokenUber(pool) {
  // 1. Verificar token cacheado no banco
  const { rows } = await pool.query(`
    SELECT access_token, expires_at FROM uber_oauth_token
    WHERE expires_at > NOW() + INTERVAL '2 minutes'
    ORDER BY id DESC LIMIT 1
  `);

  if (rows.length > 0) {
    return rows[0].access_token;
  }

  // 2. Solicitar novo token
  const config = await obterConfig(pool);
  if (!config || !config.client_id || !config.client_secret) {
    throw new Error('Credenciais Uber Direct não configuradas');
  }

  const body = new URLSearchParams({
    client_id: config.client_id,
    client_secret: config.client_secret,
    grant_type: 'client_credentials',
    scope: UBER_SCOPE,
  }).toString();

  const resp = await httpRequest(UBER_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = resp.json();

  if (!resp.ok || !data.access_token) {
    console.error('❌ [Uber] Erro ao obter token OAuth:', data);
    throw new Error(`Erro OAuth Uber: ${data.error || 'desconhecido'}`);
  }

  // 3. Salvar no banco (expires_in vem em segundos)
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  await pool.query(`
    INSERT INTO uber_oauth_token (access_token, expires_at)
    VALUES ($1, $2)
  `, [data.access_token, expiresAt]);

  // Limpar tokens antigos
  await pool.query(`DELETE FROM uber_oauth_token WHERE expires_at < NOW()`).catch(() => {});

  console.log('✅ [Uber] Token OAuth renovado, expira em', data.expires_in, 'seg');
  return data.access_token;
}

// ════════════════════════════════════════════════════════════
// MAPP API - Chamadas ao sistema Tutts/Mapp
// ════════════════════════════════════════════════════════════

/**
 * Verifica se uma resposta da API Mapp foi sucesso.
 * A Mapp sempre retorna { status: '200', dados: { status: true|false, dados: {...} }, msgUsuario }
 * O verdadeiro indicador é o boolean dados.status (interno).
 */
function mappRespostaOK(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (String(resp.status) !== '200') return false;
  // O envelope interno tem o boolean status === true quando deu certo
  if (resp.dados?.status === true) return true;
  if (resp.dados?.status === 'true') return true;
  return false;
}

/**
 * Extrai o payload "real" de uma resposta Mapp (lida com double-nesting).
 * Ex: { dados: { dados: { codigoOS: 123 } } } → { codigoOS: 123 }
 */
function mappPayload(resp) {
  return resp?.dados?.dados || resp?.dados || {};
}

async function mappListarServicos(pool, status = 0, ultimoId = 0) {
  const config = await obterConfig(pool);
  if (!config || !config.mapp_api_url || !config.mapp_api_token) {
    throw new Error('Configuração Mapp não definida');
  }

  const url = `${config.mapp_api_url}/integracao-app-externos/listarServicos?status=${status}&ultimoId=${ultimoId}`;
  const resp = await httpRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
  });

  const data = resp.json();
  if (data.status === '401') {
    throw new Error('Token Mapp inválido ou integração desativada');
  }

  // FIX: A API Mapp retorna estrutura double-nested { dados: { dados: { servicos: [...] } } }
  // Aceitamos os dois formatos pra robustez (caso a Mapp normalize no futuro).
  const servicos = data?.dados?.dados?.servicos || data?.dados?.servicos || [];
  return Array.isArray(servicos) ? servicos : [];
}

async function mappAlterarStatus(pool, codigoOS, status) {
  const config = await obterConfig(pool);
  const url = `${config.mapp_api_url}/integracao-app-externos/alterarStatus`;

  const resp = await httpRequest(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
    body: JSON.stringify({ codigoOS, status }),
  });

  const data = resp.json();
  console.log(`📡 [Mapp] alterarStatus OS=${codigoOS} → ${status}:`, data.msgUsuario);
  return data;
}

async function mappVincularMotorista(pool, codigoOS, profissional) {
  const config = await obterConfig(pool);
  const url = `${config.mapp_api_url}/integracao-app-externos/vincularMotorista`;

  const resp = await httpRequest(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
    body: JSON.stringify({ codigoOS, profissional }),
  });

  const data = resp.json();
  console.log(`📡 [Mapp] vincularMotorista OS=${codigoOS}:`, data.msgUsuario);
  return data;
}

async function mappInformarChegada(pool, codigoOS, ponto, lat, long) {
  const config = await obterConfig(pool);
  const url = `${config.mapp_api_url}/integracao-app-externos/informarChegada`;

  const payload = { codigoOS, ponto };
  if (lat && long) { payload.lat = lat; payload.long = long; }

  const resp = await httpRequest(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
    body: JSON.stringify(payload),
  });

  const data = resp.json();
  console.log(`📡 [Mapp] informarChegada OS=${codigoOS} ponto=${ponto}:`, data.msgUsuario);
  return data;
}

async function mappFinalizarEndereco(pool, codigoOS, ponto, lat, long) {
  const config = await obterConfig(pool);
  const url = `${config.mapp_api_url}/integracao-app-externos/informarFinalizacaoEndereco`;

  const payload = { codigoOS, ponto };
  if (lat && long) { payload.lat = lat; payload.long = long; }

  const resp = await httpRequest(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
    body: JSON.stringify(payload),
  });

  const data = resp.json();
  console.log(`📡 [Mapp] finalizarEndereco OS=${codigoOS} ponto=${ponto}:`, data.msgUsuario);
  return data;
}

async function mappFinalizarServico(pool, codigoOS) {
  const config = await obterConfig(pool);
  const url = `${config.mapp_api_url}/integracao-app-externos/finalizarServico`;

  const resp = await httpRequest(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
    body: JSON.stringify({ codigoOS }),
  });

  const data = resp.json();
  console.log(`📡 [Mapp] finalizarServico OS=${codigoOS}:`, data.msgUsuario);
  return data;
}

// ════════════════════════════════════════════════════════════
// UBER DIRECT API - Cotação + Criar Entrega + Cancelar
// ════════════════════════════════════════════════════════════

/**
 * Cria uma cotação no Uber Direct.
 *
 * IMPORTANTE: pickup_address e dropoff_address são STRINGS contendo JSON
 * estruturado, não objetos. lat/lng vão como CAMPOS DE PRIMEIRO NÍVEL
 * (pickup_latitude, dropoff_longitude, etc) — não aninhados.
 *
 * Doc oficial:
 * https://developer.uber.com/docs/deliveries/get-started
 */
async function uberCriarCotacao(pool, pickup, dropoff) {
  const token = await obterTokenUber(pool);
  const config = await obterConfig(pool);

  const url = `${UBER_API_BASE}/${config.customer_id}/delivery_quotes`;
  const body = {
    pickup_address: montarEnderecoUber(pickup.endereco),
    dropoff_address: montarEnderecoUber(dropoff.endereco),
  };

  // Coordenadas (campos de primeiro nível!) — fortemente recomendado pra Brasil
  if (pickup.latitude && pickup.longitude) {
    body.pickup_latitude = parseFloat(pickup.latitude);
    body.pickup_longitude = parseFloat(pickup.longitude);
  }
  if (dropoff.latitude && dropoff.longitude) {
    body.dropoff_latitude = parseFloat(dropoff.latitude);
    body.dropoff_longitude = parseFloat(dropoff.longitude);
  }

  const resp = await httpRequest(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = resp.json();
  if (!resp.ok) {
    console.error('❌ [Uber] Erro ao criar cotação:', JSON.stringify(data));
    throw new Error(`Erro cotação Uber: ${data.message || data.code || JSON.stringify(data)}`);
  }

  console.log(`✅ [Uber] Cotação criada: ${data.id} | R$${(data.fee / 100).toFixed(2)} | ETA ${data.duration}min`);
  return {
    quote_id: data.id,
    valor: data.fee / 100,  // Uber retorna em centavos
    eta_minutos: data.duration,
    expira_em: data.expires,
  };
}

/**
 * Cria uma entrega no Uber Direct.
 *
 * Campos OBRIGATÓRIOS confirmados pela doc:
 * - quote_id
 * - pickup_address (JSON string)
 * - pickup_name
 * - pickup_phone_number (E.164)
 * - dropoff_address (JSON string)
 * - dropoff_name
 * - dropoff_phone_number (E.164)
 * - manifest_items (array, mínimo 1 item)
 *
 * Telefones são forçados pra E.164. Se nenhum telefone for fornecido
 * (caso comum: a Mapp não envia telefones), usa o telefone de suporte
 * configurado em uber_config.telefone_suporte.
 */
async function uberCriarEntrega(pool, quoteId, pickup, dropoff, externalId) {
  const token = await obterTokenUber(pool);
  const config = await obterConfig(pool);

  // Telefone padrão do suporte como fallback
  const telSuporte = formatarTelefoneE164(config.telefone_suporte);

  const pickupPhone = formatarTelefoneE164(pickup.telefone) || telSuporte;
  const dropoffPhone = formatarTelefoneE164(dropoff.telefone) || telSuporte;

  if (!pickupPhone || !dropoffPhone) {
    throw new Error('Telefone de coleta/entrega ausente e telefone_suporte não configurado em uber_config');
  }

  // Manifest obrigatório — pelo menos 1 item
  const manifestValueCents = parseInt(config.manifest_total_value_centavos || 10000, 10);
  const manifestItems = [{
    name: truncarTexto(pickup.descricao_item || 'Encomenda', 100),
    quantity: 1,
    size: 'small',
  }];

  const body = {
    quote_id: quoteId,
    external_id: `OS-${externalId}`,

    // PICKUP — campos de primeiro nível
    pickup_address: montarEnderecoUber(pickup.endereco),
    pickup_name: truncarTexto(pickup.nome || 'Loja', 100),
    pickup_phone_number: pickupPhone,
    pickup_business_name: truncarTexto(pickup.nome || 'Loja', 100),
    pickup_notes: truncarTexto(pickup.complemento, 280),

    // DROPOFF — campos de primeiro nível
    dropoff_address: montarEnderecoUber(dropoff.endereco),
    dropoff_name: truncarTexto(dropoff.nome || 'Cliente', 100),
    dropoff_phone_number: dropoffPhone,
    dropoff_notes: truncarTexto(dropoff.complemento, 280),

    // Manifest obrigatório
    manifest_items: manifestItems,
    manifest_total_value: manifestValueCents,

    // Comportamento padrão
    deliverable_action: 'deliverable_action_meet_at_door',
    undeliverable_action: 'return',
  };

  // Coordenadas (campos de primeiro nível, não aninhadas em pickup/dropoff)
  if (pickup.latitude && pickup.longitude) {
    body.pickup_latitude = parseFloat(pickup.latitude);
    body.pickup_longitude = parseFloat(pickup.longitude);
  }
  if (dropoff.latitude && dropoff.longitude) {
    body.dropoff_latitude = parseFloat(dropoff.latitude);
    body.dropoff_longitude = parseFloat(dropoff.longitude);
  }

  const url = `${UBER_API_BASE}/${config.customer_id}/deliveries`;
  const resp = await httpRequest(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = resp.json();
  if (!resp.ok) {
    console.error('❌ [Uber] Erro ao criar entrega:', JSON.stringify(data));
    throw new Error(`Erro criar entrega Uber: ${data.message || data.code || JSON.stringify(data)}`);
  }

  console.log(`✅ [Uber] Entrega criada: ${data.id} | status=${data.status}`);
  return {
    delivery_id: data.id,
    status: data.status,
    tracking_url: data.tracking_url,
    pickup_eta: data.pickup?.eta,
  };
}

async function uberCancelarEntrega(pool, deliveryId) {
  const token = await obterTokenUber(pool);
  const config = await obterConfig(pool);

  const url = `${UBER_API_BASE}/${config.customer_id}/deliveries/${deliveryId}/cancel`;

  const resp = await httpRequest(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({}),
  });

  const data = resp.json();
  console.log(`📡 [Uber] Cancelar entrega ${deliveryId}:`, resp.ok ? 'OK' : data);
  return { ok: resp.ok, data };
}

async function uberConsultarEntrega(pool, deliveryId) {
  const token = await obterTokenUber(pool);
  const config = await obterConfig(pool);

  const url = `${UBER_API_BASE}/${config.customer_id}/deliveries/${deliveryId}`;

  const resp = await httpRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  return resp.json();
}

// ════════════════════════════════════════════════════════════
// ORQUESTRAÇÃO - Fluxo completo: Mapp → Uber → Mapp
// ════════════════════════════════════════════════════════════

/**
 * Processar um serviço da Mapp e enviar pro Uber Direct
 * Retorna o registro criado em uber_entregas
 */
async function despacharParaUber(pool, servico) {
  const codigoOS = servico.codigoOS;
  const enderecos = servico.endereco || [];

  if (enderecos.length < 2) {
    throw new Error(`OS ${codigoOS}: menos de 2 endereços, não é possível despachar`);
  }

  // Verificar se já existe registro ativo (não terminal).
  // Excluímos: cancelado, canceled (compat), delivered, fallback_fila
  const { rows: existente } = await pool.query(
    `SELECT id, status_uber FROM uber_entregas
     WHERE codigo_os = $1
       AND status_uber NOT IN ('cancelado', 'canceled', 'delivered', 'fallback_fila')`,
    [codigoOS]
  );
  if (existente.length > 0) {
    console.log(`⚠️ [Uber] OS ${codigoOS} já tem entrega ativa (id=${existente[0].id}, status=${existente[0].status_uber}), ignorando`);
    return null;
  }

  const coleta = enderecos[0];
  const entrega = enderecos[enderecos.length - 1];

  // 1. Reservar na Mapp (status 1 = app externo)
  const respReserva = await mappAlterarStatus(pool, codigoOS, 1);
  if (!mappRespostaOK(respReserva)) {
    // Se já tiver profissional vinculado ou outro erro, abortar
    console.warn(`⚠️ [Uber] Não foi possível reservar OS ${codigoOS}: ${respReserva?.msgUsuario || 'resposta inválida'}`);
    return null;
  }
  console.log(`✅ [Uber] OS ${codigoOS} reservada na Mapp (status 0 → 1)`);

  // 2. Criar registro no banco
  const { rows: [registro] } = await pool.query(`
    INSERT INTO uber_entregas (
      codigo_os, status_uber, valor_servico, valor_profissional,
      endereco_coleta, endereco_entrega,
      latitude_coleta, longitude_coleta,
      latitude_entrega, longitude_entrega,
      obs, pontos
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
  `, [
    codigoOS, 'aguardando_cotacao',
    servico.valorServico, servico.valorProfissional,
    coleta.rua, entrega.rua,
    coleta.latitude || null, coleta.longitude || null,
    entrega.latitude || null, entrega.longitude || null,
    servico.obs, JSON.stringify(enderecos),
  ]);

  try {
    // 3. Cotação Uber
    const cotacao = await uberCriarCotacao(pool, {
      endereco: coleta.rua,
      latitude: coleta.latitude,
      longitude: coleta.longitude,
    }, {
      endereco: entrega.rua,
      latitude: entrega.latitude,
      longitude: entrega.longitude,
    });

    await pool.query(`
      UPDATE uber_entregas
      SET uber_quote_id = $1, valor_uber = $2, eta_minutos = $3, status_uber = $4, updated_at = NOW()
      WHERE id = $5
    `, [cotacao.quote_id, cotacao.valor, cotacao.eta_minutos, 'cotacao_recebida', registro.id]);

    // 4. Criar entrega no Uber
    const entregaUber = await uberCriarEntrega(pool, cotacao.quote_id, {
      endereco: coleta.rua,
      nome: coleta.nome,
      telefone: coleta.telefone || coleta.fone,
      complemento: coleta.complemento,
      descricao_item: servico.obs || `OS ${codigoOS}`,
      latitude: coleta.latitude,
      longitude: coleta.longitude,
    }, {
      endereco: entrega.rua,
      nome: entrega.nome,
      telefone: entrega.telefone || entrega.fone,
      complemento: entrega.complemento,
      latitude: entrega.latitude,
      longitude: entrega.longitude,
    }, codigoOS);

    await pool.query(`
      UPDATE uber_entregas
      SET uber_delivery_id = $1, status_uber = $2, updated_at = NOW()
      WHERE id = $3
    `, [entregaUber.delivery_id, 'enviado_uber', registro.id]);

    console.log(`✅ [Uber] OS ${codigoOS} despachada → delivery_id=${entregaUber.delivery_id}`);

    return { ...registro, uber_delivery_id: entregaUber.delivery_id, cotacao };

  } catch (erro) {
    // Se falhar em qualquer passo, reabrir na Mapp
    console.error(`❌ [Uber] Erro ao despachar OS ${codigoOS}:`, erro.message);

    await pool.query(`
      UPDATE uber_entregas
      SET status_uber = $1, erro_ultimo = $2, tentativas = tentativas + 1, updated_at = NOW()
      WHERE id = $3
    `, ['erro', erro.message, registro.id]);

    // Reabrir na Mapp (status 0)
    await mappAlterarStatus(pool, codigoOS, 0).catch(e =>
      console.error(`❌ [Uber] Falha ao reabrir OS ${codigoOS} na Mapp:`, e.message)
    );

    return null;
  }
}

/**
 * Processar webhook de status da Uber
 * Traduz status Uber → ações na Mapp
 */
async function processarWebhookStatus(pool, payload) {
  const deliveryId = payload.data?.id || payload.data?.delivery_id;
  const novoStatus = payload.data?.status;

  if (!deliveryId || !novoStatus) {
    console.warn('⚠️ [Uber] Webhook status sem delivery_id ou status');
    return;
  }

  // Buscar registro local
  const { rows } = await pool.query(
    'SELECT * FROM uber_entregas WHERE uber_delivery_id = $1',
    [deliveryId]
  );

  if (rows.length === 0) {
    console.warn(`⚠️ [Uber] Webhook para delivery_id desconhecido: ${deliveryId}`);
    return;
  }

  const entrega = rows[0];
  const codigoOS = entrega.codigo_os;
  const statusInfo = UBER_STATUS_MAP[novoStatus];

  // 🔒 Idempotência: Uber pode reentregar o mesmo webhook (timeout, retry, etc).
  // Se o status já foi processado, ignoramos pra não disparar 2x as ações na Mapp.
  if (entrega.status_uber === novoStatus) {
    console.log(`⊘ [Uber] Status duplicado ignorado OS=${codigoOS}: ${novoStatus} (já processado)`);
    return;
  }

  console.log(`📡 [Uber] Status OS=${codigoOS}: ${entrega.status_uber} → ${novoStatus} (${statusInfo?.descricao || '?'})`);

  // Atualizar status local
  await pool.query(`
    UPDATE uber_entregas SET status_uber = $1, updated_at = NOW() WHERE id = $2
  `, [novoStatus, entrega.id]);

  // Executar ação na Mapp conforme mapeamento
  if (!statusInfo || !statusInfo.acao_mapp) return;

  const lat = payload.data?.courier?.location?.lat;
  const lng = payload.data?.courier?.location?.lng;

  try {
    switch (statusInfo.acao_mapp) {
      case 'finalizar_ponto_coleta':
        // Entregador coletou → informar chegada + finalizar ponto 1 na Mapp
        await mappInformarChegada(pool, codigoOS, 1, lat, lng);
        await mappFinalizarEndereco(pool, codigoOS, 1, lat, lng);
        break;

      case 'informar_chegada_entrega':
        // Entregador chegou no destino → informar chegada ponto 2
        await mappInformarChegada(pool, codigoOS, 2, lat, lng);
        break;

      case 'finalizar_servico':
        // Entregue → finalizar último ponto (auto-finaliza serviço)
        await mappFinalizarEndereco(pool, codigoOS, 2, lat, lng);
        await pool.query(`
          UPDATE uber_entregas SET finalizado_at = NOW(), updated_at = NOW() WHERE id = $1
        `, [entrega.id]);
        break;

      case 'cancelar':
        // Cancelado/devolvido → reabrir na Mapp
        await mappAlterarStatus(pool, codigoOS, 0);
        await pool.query(`
          UPDATE uber_entregas
          SET cancelado_por = $1, cancelado_motivo = $2, updated_at = NOW()
          WHERE id = $3
        `, ['uber', `Status: ${novoStatus}`, entrega.id]);
        break;
    }
  } catch (erro) {
    console.error(`❌ [Uber] Erro ao processar ação Mapp para OS ${codigoOS}:`, erro.message);
    await pool.query(`
      UPDATE uber_entregas SET erro_ultimo = $1, updated_at = NOW() WHERE id = $2
    `, [`Erro ação ${statusInfo.acao_mapp}: ${erro.message}`, entrega.id]);
  }
}

/**
 * Processar webhook de atualização do entregador (lat/lng a cada 20s)
 */
async function processarWebhookCourier(pool, payload) {
  const deliveryId = payload.data?.id || payload.data?.delivery_id;
  const courier = payload.data?.courier;
  const status = payload.data?.status;

  if (!deliveryId) return;

  // Buscar registro local
  const { rows } = await pool.query(
    'SELECT * FROM uber_entregas WHERE uber_delivery_id = $1',
    [deliveryId]
  );

  if (rows.length === 0) return;

  const entrega = rows[0];
  const codigoOS = entrega.codigo_os;

  // Atualizar dados do entregador (primeira vez ou mudança)
  if (courier?.name && !entrega.entregador_nome) {
    await pool.query(`
      UPDATE uber_entregas SET
        entregador_nome = $1,
        entregador_telefone = $2,
        entregador_placa = $3,
        entregador_veiculo = $4,
        entregador_foto = $5,
        entregador_rating = $6,
        status_uber = 'entregador_atribuido',
        updated_at = NOW()
      WHERE id = $7
    `, [
      courier.name,
      courier.phone_number || courier.public_phone_info?.formatted_phone_number,
      courier.vehicle_license_plate,
      [courier.vehicle_make, courier.vehicle_model].filter(Boolean).join(' '),
      courier.img_href,
      courier.rating,
      entrega.id,
    ]);

    // Vincular motorista na Mapp
    // Telefone vem da Uber em E.164 (+5571999999999). A Mapp espera só DDD+número
    // (10 ou 11 dígitos), então removemos o DDI 55 antes de enviar.
    const telE164 = courier.phone_number || courier.public_phone_info?.formatted_phone_number || '';
    const telDigits = telE164.replace(/\D/g, '');
    const telBR = telDigits.startsWith('55') && telDigits.length >= 12
      ? telDigits.slice(2)
      : telDigits;

    const profissional = {
      nome: courier.name,
      telefone: telBR,
      placa: courier.vehicle_license_plate || '',
      veiculo: [courier.vehicle_make, courier.vehicle_model].filter(Boolean).join(' '),
    };

    try {
      const respMapp = await mappVincularMotorista(pool, codigoOS, profissional);
      if (mappRespostaOK(respMapp)) {
        const payload = mappPayload(respMapp);
        if (payload.idMotoboy) {
          await pool.query(
            'UPDATE uber_entregas SET id_motoboy_mapp = $1, updated_at = NOW() WHERE id = $2',
            [payload.idMotoboy, entrega.id]
          );
        }
        console.log(`✅ [Uber] Entregador vinculado na Mapp: OS=${codigoOS}, nome=${courier.name}`);
      } else {
        console.warn(`⚠️ [Uber] vincularMotorista falhou OS=${codigoOS}: ${respMapp?.msgUsuario || 'resposta inválida'}`);
      }
    } catch (err) {
      console.error(`❌ [Uber] Erro ao vincular na Mapp OS=${codigoOS}:`, err.message);
    }
  }

  // Salvar posição no tracking
  if (courier?.location?.lat && courier?.location?.lng) {
    await pool.query(`
      INSERT INTO uber_tracking (codigo_os, uber_delivery_id, latitude, longitude, status_uber)
      VALUES ($1, $2, $3, $4, $5)
    `, [codigoOS, deliveryId, courier.location.lat, courier.location.lng, status]);

    // Broadcast via WebSocket
    if (global.broadcastUberTracking) {
      global.broadcastUberTracking(codigoOS, {
        latitude: courier.location.lat,
        longitude: courier.location.lng,
        status,
        entregador: courier.name,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

/**
 * Fallback: reabrir na Mapp quando Uber não encontra entregador
 */
async function verificarTimeouts(pool) {
  const config = await obterConfig(pool);
  if (!config || !config.ativo) return;

  const timeout = config.timeout_sem_entregador_min || 10;

  const { rows } = await pool.query(`
    SELECT * FROM uber_entregas
    WHERE status_uber IN ('enviado_uber', 'aguardando_cotacao', 'cotacao_recebida')
      AND created_at < NOW() - INTERVAL '${timeout} minutes'
      AND cancelado_por IS NULL
  `);

  for (const entrega of rows) {
    console.log(`⏰ [Uber] Timeout OS=${entrega.codigo_os} — sem entregador há ${timeout}min, reabrindo na Mapp`);

    // Cancelar no Uber se tiver delivery_id
    if (entrega.uber_delivery_id) {
      await uberCancelarEntrega(pool, entrega.uber_delivery_id).catch(() => {});
    }

    // Reabrir na Mapp
    await mappAlterarStatus(pool, entrega.codigo_os, 0).catch(e =>
      console.error(`❌ [Uber] Falha ao reabrir OS ${entrega.codigo_os}:`, e.message)
    );

    await pool.query(`
      UPDATE uber_entregas
      SET status_uber = $1, cancelado_por = $2, cancelado_motivo = $3, updated_at = NOW()
      WHERE id = $4
    `, ['fallback_fila', 'sistema', `Timeout ${timeout}min sem entregador`, entrega.id]);
  }

  if (rows.length > 0) {
    console.log(`⏰ [Uber] ${rows.length} entrega(s) reabertas por timeout`);
  }
}

module.exports = {
  // Config
  obterConfig,
  // Mapp
  mappListarServicos,
  mappAlterarStatus,
  mappVincularMotorista,
  mappInformarChegada,
  mappFinalizarEndereco,
  mappFinalizarServico,
  mappRespostaOK,
  mappPayload,
  // Uber
  obterTokenUber,
  uberCriarCotacao,
  uberCriarEntrega,
  uberCancelarEntrega,
  uberConsultarEntrega,
  // Orquestração
  despacharParaUber,
  processarWebhookStatus,
  processarWebhookCourier,
  verificarTimeouts,
};
