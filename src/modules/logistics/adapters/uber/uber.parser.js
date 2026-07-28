/**
 * UBER ADAPTER — Parser de payload
 *
 * Traduz objetos canônicos do hub para o dialeto que a Uber Direct espera:
 *   - Endereço: JSON-string em pickup_address/dropoff_address
 *   - Coordenadas: campos de primeiro nível (pickup_latitude, etc), NÃO aninhadas
 *   - Telefone: E.164 obrigatório (+5571999999999)
 *   - Manifest: array com pelo menos 1 item (obrigatório no createDelivery)
 *   - external_id: string livre (Tutts usa 'OS-{codigoOS}')
 *
 * Doc: https://developer.uber.com/docs/deliveries/api-reference
 *
 * Quem usa: UberAdapter.createQuote e UberAdapter.createDelivery.
 *
 * Comportamento extraído verbatim de uber.service.js:227-382 (uberCriarCotacao
 * e uberCriarEntrega). Diferenças:
 *  - Aceita CanonicalAddress como input (não objeto custom)
 *  - Aceita ou números explícitos OU strings que viram float
 *  - manifest_total_value_centavos vem da config (10000 default = R$ 100)
 *  - sandbox_mode controla inclusão de test_specifications.robo_courier
 */

const { parsearEnderecoBrasileiro, formatarTelefoneE164, truncarTexto } =
  require('../../core/AddressParser');
const { resolverAvisoEntregador, osUltimos4 } = require('../../logistics.shared');
const {
  montarJanelasUber,
  montarManifestItem,
  montarExternalStoreId,
} = require('./uber.manifest-windows');

/**
 * Monta o JSON-string que vai em pickup_address / dropoff_address.
 *
 * @param {string} stringEndereco - endereço completo em string única
 * @returns {string} JSON-stringified
 */
function montarEnderecoUber(stringEndereco, cepFallback) {
  const parsed = parsearEnderecoBrasileiro(stringEndereco);
  // 🔧 2026-07 (Uber): se o texto nao trouxe CEP, usa o resolvido por geocode
  // (req.pickup/dropoff.cep). Sem CEP a Uber geocodifica errado e recusa a corrida.
  if (cepFallback && (!parsed.zip_code || String(parsed.zip_code).replace(/\D/g, '').length < 8)) {
    parsed.zip_code = String(cepFallback);
  }
  return JSON.stringify(parsed);
}

// 🔧 2026-07 (Uber cert dropoff): igual ao montarEnderecoUber, mas devolve TAMBEM
// o complemento que o parser tirou do street_address (quadra/lote/bloco/apto...).
// O body junta esse complemento na nota (pickup_notes/dropoff_notes), pra o
// street_address ficar so com rua+numero+bairro como a Uber exige.
function montarEnderecoUberComNota(stringEndereco, cepFallback) {
  const parsed = parsearEnderecoBrasileiro(stringEndereco);
  if (cepFallback && (!parsed.zip_code || String(parsed.zip_code).replace(/\D/g, '').length < 8)) {
    parsed.zip_code = String(cepFallback);
  }
  const complemento = parsed.complemento_extraido || '';
  // nao serializa o campo interno pra Uber
  const semInterno = {
    street_address: parsed.street_address,
    city: parsed.city,
    state: parsed.state,
    zip_code: parsed.zip_code,
    country: parsed.country,
  };
  return { json: JSON.stringify(semInterno), complemento: complemento };
}

/**
 * 🔧 2026-07 (Uber cert item 4): evita placeholders no nome que o entregador ve no
 * pickup/dropoff. Filtra strings curtas ou repetitivas ("eeee", "xx", "aaaa") e
 * placeholders obvios de teste; cai no fallback. Nome real passa direto.
 */
function nomeRealOuFallback(nome, fallback) {
  var n = String(nome == null ? '' : nome).trim();
  if (n.length < 3) return fallback;
  if (/^(.)\1*$/.test(n.replace(/\s/g, ''))) return fallback; // 1 caractere repetido
  var placeholders = ['teste', 'test', 'asdf', 'qwer', 'sem nome', 'nao informado', 'nome'];
  if (placeholders.indexOf(n.toLowerCase()) !== -1) return fallback;
  return n;
}

/**
 * Monta body para POST /delivery_quotes
 *
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @returns {Object} body que vai pra Uber Direct
 */
function montarBodyQuote(req, config) {
  const body = {
    pickup_address: montarEnderecoUber(req.pickup.address, req.pickup.cep),
    dropoff_address: montarEnderecoUber(req.dropoff.address, req.dropoff.cep),
  };

  // Coordenadas — recomendado pra Brasil
  if (req.pickup.latitude != null && req.pickup.longitude != null) {
    body.pickup_latitude = parseFloat(req.pickup.latitude);
    body.pickup_longitude = parseFloat(req.pickup.longitude);
  }
  if (req.dropoff.latitude != null && req.dropoff.longitude != null) {
    body.dropoff_latitude = parseFloat(req.dropoff.latitude);
    body.dropoff_longitude = parseFloat(req.dropoff.longitude);
  }

  // 🔧 2026-06 (Uber cert): paridade Quote↔Delivery. Envia os mesmos campos
  // operacionais do Create Delivery pra consistência entre cotação e criação.
  if (config) {
    body.manifest_total_value = parseInt(config.manifest_total_value_centavos || 10000, 10);
    body.external_store_id = montarExternalStoreId(req, config);
  }

  // NOTA: o endpoint /delivery_quotes da Uber NAO aceita vehicle_type — apenas o
  // Create Delivery aceita. Enviar aqui causa "The parameters of your request
  // were invalid". A Uber cota o veiculo disponivel mais barato.

  return body;
}

/**
 * Monta body para POST /deliveries
 *
 * @param {string} quoteId
 * @param {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest} req
 * @param {Object} config - logistics_providers.config (manifest_total_value_centavos, telefone_suporte, sandbox_mode)
 * @returns {Object} body completo
 */
function montarBodyDelivery(quoteId, req, config, sandboxMode = false) {
  const telSuporte = formatarTelefoneE164(config.telefone_suporte);

  const pickupPhone = formatarTelefoneE164(req.pickup.phone) || telSuporte;
  const dropoffPhone = formatarTelefoneE164(req.dropoff.phone) || telSuporte;

  if (!pickupPhone || !dropoffPhone) {
    throw new Error('Telefone de coleta/entrega ausente e telefone_suporte não configurado');
  }

  const manifestValueCents = parseInt(config.manifest_total_value_centavos || 10000, 10);
  // manifest_items com weight (g) e dimensions (cm) — REQUIRED na certificacao.
  // Defaults configuraveis no provider (uber_item_weight_g / *_cm).
  const manifestItems = [
    montarManifestItem(truncarTexto(req.itemDescription || 'Encomenda', 100), config, manifestValueCents),
  ];

  // 🔧 2026-07 (Uber cert dropoff): monta endereco + extrai complemento (quadra/
  // lote/bloco...) de coleta e entrega. O complemento vai pra nota; o street_address
  // fica so rua+numero+bairro.
  const _pickupEnd  = montarEnderecoUberComNota(req.pickup.address, req.pickup.cep);
  const _dropoffEnd = montarEnderecoUberComNota(req.dropoff.address, req.dropoff.cep);

  const body = {
    quote_id: quoteId,
    external_id: `OS-${req.externalRef}-${Date.now()}`,
    // manifest_reference: codigo unico do pedido do parceiro (REQUIRED).
    manifest_reference: String(req.externalRef),
    // external_store_id: unico por endereco de retirada/loja (REQUIRED).
    external_store_id: montarExternalStoreId(req, config),

    pickup_address: _pickupEnd.json,
    pickup_name: truncarTexto(nomeRealOuFallback(req.pickup.name, 'Loja'), 100),
    pickup_phone_number: pickupPhone,
    pickup_business_name: truncarTexto(nomeRealOuFallback(req.pickup.name, 'Loja'), 100),
    // pickup_notes: complemento extraido do endereco (quadra/lote/bloco...) +
    // instrucoes do ponto -> aviso POR CLIENTE -> aviso global.
    pickup_notes: truncarTexto([_pickupEnd.complemento, req.pickup.instructions || req.avisoEntregador || resolverAvisoEntregador(config)].filter(Boolean).join(' - '), 280),

    dropoff_address: _dropoffEnd.json,
    dropoff_name: truncarTexto(nomeRealOuFallback(req.dropoff.name, 'Cliente'), 100),
    dropoff_phone_number: dropoffPhone,
    // 🔧 2026-07 (Uber cert dropoff): dropoff_notes = complemento EXTRAIDO do
    // endereco (quadra/lote/bloco/apto — tirado do street_address) + complemento
    // manual + instrucoes. Assim o street_address fica so rua+numero+bairro, e a
    // Uber para de sobrescrever as coordenadas.
    dropoff_notes: truncarTexto([_dropoffEnd.complemento, req.dropoff.complement, req.dropoff.instructions].filter(Boolean).join(' - '), 280) || undefined,

    manifest_items: manifestItems,
    manifest_total_value: manifestValueCents,

    deliverable_action: 'deliverable_action_meet_at_door',
    undeliverable_action: 'return',
  };

  // Delivery windows (REQUIRED) — ISO-8601 UTC, com clamp pras regras da Uber.
  // Defaults = entrega on-demand (pickup_ready=agora). Offsets configuraveis no
  // provider (uber_pickup_ready_offset_min, uber_dropoff_deadline_offset_min...).
  Object.assign(body, montarJanelasUber(config));

  // ── Códigos de verificação ─────────────────────────────────────
  // [uber-codigo-coleta-v1] Nenhum dos dois e mais gerado AQUI:
  //   pickupCode  -> derivado do tracking_url em UberAdapter.createDelivery
  //   dropoffCode -> gerado pela Uber (pincode) e lido da resposta
  let pickupCode  = null;
  let dropoffCode = null;

  // ⚠️ COLETA — NAO ENVIAR pickup_verification. NUNCA.
  //
  // Confirmado com o suporte da Uber (07/2026): o codigo de coleta e NATIVO da
  // plataforma (5 ultimos do workflow UUID) e o app do motoboy pede ele na loja.
  // O PRE-REQUISITO e nao mandar NENHUMA verificacao de coleta: se enviarmos
  // qualquer pickup_verification, a Uber entende que queremos verificacao
  // customizada e DESLIGA o fluxo nativo do codigo.
  //
  // O que existia aqui antes estava errado por dois motivos:
  //   1) mandava barcodes: [{ type: 'pin' }] — 'pin' nao e tipo de barcode valido
  //      na doc da Uber (o documentado e CODE39); pincode e um objeto SEPARADO,
  //      nao um tipo de barcode, e so existe no dropoff;
  //   2) barcode exige o motoboy ESCANEAR, nao digitar — o PIN de 6 digitos que
  //      mandavamos por WhatsApp pra loja era inescaneavel.
  if (config && (config.verificacao_coleta_habilitada || config.need_pickup_code)) {
    console.warn('[Uber] OS ' + req.externalRef + ': verificacao_coleta_habilitada esta LIGADO'
      + ' mas foi IGNORADO de proposito. A Uber usa codigo de coleta NATIVO (5 ultimos do'
      + ' workflow UUID) e ele so funciona se NAO enviarmos pickup_verification.'
      + ' Desligue esse toggle no painel da Uber.');
  }

  // Verificação de ENTREGA — dois modos via verificacao_entrega_tipo:
  //   'pincode' (alias legado: 'codigo') → PIN de 4 digitos GERADO PELA UBER.
  //        Volta em verification_requirements.pincode.value; o UberAdapter le e
  //        devolve como dropoffCode. Doc: pincode existe SO no dropoff.
  //   'assinatura' → assinatura digital no app do motoboy (default).
  if (config && (config.verificacao_entrega_habilitada || config.need_dropoff_code)) {
    const tipo = String(config.verificacao_entrega_tipo || 'assinatura').toLowerCase();
    if (tipo === 'pincode' || tipo === 'codigo') {
      // NAO geramos o valor: quem gera e a Uber. Antes inventavamos 6 digitos
      // que a Uber nao conhecia e mandavamos por WhatsApp pro destinatario.
      body.dropoff_verification = { pincode: { enabled: true } };
      console.log(`[Uber] Verificação de ENTREGA (pincode Uber) habilitada para OS ${req.externalRef}`);
    } else {
      // Modo padrão: assinatura digital (não gera código, só comprovante visual)
      body.dropoff_verification = {
        signature_requirement: {
          enabled: true,
          collect_signer_name: true,
          collect_signer_relationship: false,
        },
      };
      console.log(`[Uber] Verificação de ENTREGA (assinatura) habilitada para OS ${req.externalRef}`);
    }
  }

  // ── Verificação por FOTO (proof of delivery) — shape oficial { picture: true } ──
  // Mesma estrutura para pickup / dropoff / return. Flags configuráveis no
  // provider: uber_pickup_picture, uber_dropoff_picture, uber_return_picture.
  // ATENÇÃO (doc Uber): no dropoff a foto NÃO combina com assinatura/ID — quando
  // a foto está ligada ela tem PRECEDÊNCIA e o dropoff_verification vira só foto.
  // [uber-codigo-coleta-v1] ⚠️ Ligar foto na COLETA MATA o codigo de coleta nativo
  // (qualquer pickup_verification enviado desliga o fluxo nativo da Uber).
  // Mantido funcional porque e uma escolha legitima — mas e um OU exclusivo.
  if (config && config.uber_pickup_picture) {
    body.pickup_verification = Object.assign({}, body.pickup_verification, { picture: true });
    console.warn('[Uber] OS ' + req.externalRef + ': FOTO na coleta habilitada — isso DESLIGA o'
      + ' codigo de coleta nativo da Uber. Sao mutuamente exclusivos: ou foto, ou codigo.');
  }
  // [uber-codigo-coleta-v1] Foto no dropoff agora faz MERGE em vez de substituir.
  // A doc do pincode diz que ele combina com foto, barcode, assinatura e sobriety
  // check — o replace anterior apagava o pincode/assinatura silenciosamente.
  if (config && config.uber_dropoff_picture) {
    body.dropoff_verification = Object.assign({}, body.dropoff_verification, { picture: true });
    console.log(`[Uber] Verificação por FOTO na ENTREGA habilitada (OS ${req.externalRef})`);
  }
  if (config && config.uber_return_picture) {
    body.return_verification = { picture: true };
    console.log(`[Uber] Verificação por FOTO na DEVOLUÇÃO habilitada (OS ${req.externalRef})`);
  }

  // Coordenadas
  if (req.pickup.latitude != null && req.pickup.longitude != null) {
    body.pickup_latitude = parseFloat(req.pickup.latitude);
    body.pickup_longitude = parseFloat(req.pickup.longitude);
  }
  if (req.dropoff.latitude != null && req.dropoff.longitude != null) {
    body.dropoff_latitude = parseFloat(req.dropoff.latitude);
    body.dropoff_longitude = parseFloat(req.dropoff.longitude);
  }

  // Sandbox: Robo Courier auto pra simular ciclo
  if (sandboxMode === true || config.sandbox_mode === true) {
    body.test_specifications = {
      robo_courier_specification: { mode: 'auto' },
    };
  }

  // Retorna body + códigos gerados. UberAdapter.createDelivery salva os códigos
  // em logistics_deliveries e dispara WhatsApp quando necessário.
  return { body, pickupCode, dropoffCode };
}

/**
 * Extrai CanonicalQuoteRequest de um "serviço" da Mapp.
 *
 * O "serviço" tem o shape:
 *   { codigoOS, valorServico, valorProfissional, obs,
 *     endereco: [{ rua, nome, telefone, complemento, latitude, longitude, fone }, ...] }
 *
 * O primeiro endereço é coleta, o último é entrega (pode haver intermediários
 * em rotas multi-ponto, mas para Uber só usamos coleta+entrega final).
 *
 * @param {Object} servico - retorno da Mapp listarServicos
 * @returns {import('../../contracts/CanonicalTypes').CanonicalQuoteRequest}
 */
function servicoMappToCanonicalQuoteRequest(servico) {
  const enderecos = servico.endereco || [];
  if (enderecos.length < 2) {
    throw new Error(`OS ${servico.codigoOS}: menos de 2 endereços, não é possível cotar`);
  }

  const coleta = enderecos[0];
  const entrega = enderecos[enderecos.length - 1];

  return {
    pickup: {
      address: coleta.rua,
      instructions: coleta.obs || coleta.observacao || null,
      name: coleta.nome || 'Loja',
      phone: coleta.telefone || coleta.fone || null,
      complement: coleta.complemento || null,
      cep: coleta.cep || coleta.CEP || null,
      latitude: coleta.latitude != null ? parseFloat(coleta.latitude) : null,
      longitude: coleta.longitude != null ? parseFloat(coleta.longitude) : null,
    },
    dropoff: {
      address: entrega.rua,
      instructions: entrega.obs || entrega.observacao || null,
      name: entrega.nome || 'Cliente',
      phone: entrega.telefone || entrega.fone || null,
      complement: entrega.complemento || null,
      cep: entrega.cep || entrega.CEP || null,
      latitude: entrega.latitude != null ? parseFloat(entrega.latitude) : null,
      longitude: entrega.longitude != null ? parseFloat(entrega.longitude) : null,
    },
    vehicleType: null, // Decidido pelo caller (Orchestrator decide via regra)
    externalRef: servico.codigoOS,
    itemDescription: entrega.obs || entrega.observacao || coleta.obs || coleta.observacao || servico.obs || `OS ${osUltimos4(servico.codigoOS)}`,
  };
}

// ── 2026-07 [uber-codigo-coleta-v1] Codigo de coleta NATIVO da Uber ─────────
// Confirmado com o suporte da Uber (07/2026): o codigo que o app do motoboy
// pede na loja e os 5 ULTIMOS caracteres do workflow UUID, que e justamente o
// UUID que aparece no tracking_url:
//
//   https://delivery.uber.com/br/orders/04362cf0-...-dae18926dbeb?tenancy...
//                                                            ^^^^^  -> "6DBEB"
//
// Mesma regra que o front ja usava no banner do modal (modulo-logistica.js).
// Aqui ela sobe pro backend pra gravar em logistics_deliveries.pickup_code, que
// o kanban, os cards e o portal do cliente ja renderizam (5 pontos no front).
//
// ATENCAO - sem fallback proposital: se nao houver tracking_url, retorna null.
// Nao usar os 5 ultimos do delivery_id (del_...) — isso produzia codigos errados
// tipo "WDRUW"/"BDBVA" (ver comentario historico no modulo-logistica.js). Melhor
// a loja nao ver codigo nenhum do que ver um codigo que nao funciona.
function extrairCodigoColetaUber(trackingUrl) {
  if (!trackingUrl) return null;
  try {
    // Ancorado em /orders/ de proposito: a URL tambem carrega um segundo UUID
    // no tenancyOverride, que NAO e o workflow uuid.
    const m = String(trackingUrl).match(
      /\/orders\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/
    );
    if (m && m[1]) return m[1].slice(-5).toUpperCase();
  } catch (_e) { /* url malformada => sem codigo */ }
  return null;
}

// ── [uber-codigo-coleta-v1] PIN de entrega gerado PELA UBER ────────────────
// Quando dropoff_verification.pincode.enabled = true, quem gera os 4 digitos e
// a Uber. O valor volta em verification_requirements.pincode.value. A doc nao
// deixa 100% claro o aninhamento (ora sob dropoff, ora na raiz), entao tentamos
// os caminhos conhecidos em ordem.
function extrairPincodeUber(data) {
  if (!data || typeof data !== 'object') return null;
  const cands = [
    data.dropoff && data.dropoff.verification_requirements,
    data.verification_requirements,
    data.dropoff_verification,
  ];
  for (const c of cands) {
    const v = c && c.pincode && c.pincode.value;
    if (v) return String(v);
  }
  return null;
}

module.exports = {
  montarEnderecoUber,
  montarBodyQuote,
  montarBodyDelivery,
  servicoMappToCanonicalQuoteRequest,
  extrairCodigoColetaUber,
  extrairPincodeUber,
};
