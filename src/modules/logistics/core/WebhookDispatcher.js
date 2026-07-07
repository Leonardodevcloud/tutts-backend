/**
 * MÓDULO LOGISTICS — WebhookDispatcher
 *
 * Recebe webhooks de qualquer provider, valida, parseia e dispara as ações
 * Mapp correspondentes. É o lado "provider → Tutts" do hub.
 *
 * Fluxo:
 *  1. Recebe POST /api/logistics/webhook/:provider
 *  2. ProviderRegistry.get(provider) → adapter
 *  3. adapter.validateWebhookSignature(req) → valida HMAC/auth
 *  4. adapter.parseWebhookEvent(body) → CanonicalEvent
 *  5. Localiza entrega em logistics_deliveries pelo external_delivery_id
 *  6. IDEMPOTÊNCIA: se status já processado, ignora
 *  7. Atualiza logistics_deliveries
 *  8. Dispara ação Mapp conforme statusCanonico (via STATUS_TO_MAPP_ACTION)
 *  9. Loga tudo em logistics_events
 * 10. adapter.acknowledgeWebhook(res) → resposta no formato que o provider espera
 *
 * Comportamento extraído verbatim de:
 *  - uber.service.js:processarWebhookStatus (linhas 944-1033)
 *  - uber.service.js:processarWebhookCourier (linhas 1038-1132)
 *
 * Fase 6: escreve direto em logistics_deliveries (tabela primária do hub).
 * (linha original Opção A — escolha do
 * usuário pra Fase 1). Quando a Fase 2 migrar pra logistics_deliveries,
 * só os nomes de tabela/coluna mudam aqui.
 */

const { getProviderRegistry } = require('./ProviderRegistry');
const { getEventLogger, EventType, EventSource } = require('./EventLogger');
const { getMappClient } = require('./MappClient');
const { CanonicalStatus, STATUS_TO_MAPP_ACTION } = require('../contracts/CanonicalStatus');

class WebhookDispatcher {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
    this.registry = getProviderRegistry(pool);
    this.events = getEventLogger(pool);
    this.mapp = getMappClient(pool);
  }

  /**
   * Handler principal — chamado pela rota POST /webhook/:provider.
   *
   * @param {string} providerCode
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async handle(providerCode, req, res) {
    const adapter = this.registry.get(providerCode);

    // Provider não registrado/ativo
    if (!adapter) {
      console.warn(`⚠️ [WebhookDispatcher] provider '${providerCode}' não está ativo`);
      this.events.log({
        providerCode,
        eventType: EventType.WEBHOOK_REJECTED,
        eventSource: EventSource.WEBHOOK,
        erro: `Provider '${providerCode}' não registrado ou inativo`,
        payload: { headers: this._safeHeaders(req) },
        processado: false,
      }).catch(() => {});
      // Responde 200 mesmo assim — não queremos que o provider fique re-tentando
      // num provider que não existe. Mas loga pra investigação.
      return res.status(200).json({ received: true, warning: 'provider_inativo' });
    }

    // 1. Valida assinatura
    let assinaturaValida = false;
    try {
      assinaturaValida = await adapter.validateWebhookSignature(req);
    } catch (err) {
      console.error(`❌ [WebhookDispatcher] erro ao validar assinatura ${providerCode}:`, err.message);
      this.events.logError(providerCode, err, {
        eventSource: EventSource.WEBHOOK,
        payload: { fase: 'validacao_assinatura' },
      });
      return res.status(500).json({ error: 'Erro na validação' });
    }

    if (!assinaturaValida) {
      const motivo = req._webhookValidation?.motivo || 'assinatura_invalida';
      this.events.log({
        providerCode,
        eventType: EventType.WEBHOOK_INVALID_SIGNATURE,
        eventSource: EventSource.WEBHOOK,
        erro: motivo,
        payload: { headers: this._safeHeaders(req) },
        processado: false,
      }).catch(() => {});

      // Códigos diferentes conforme o motivo (mantém comportamento do legado)
      if (motivo === 'webhook_secret_nao_configurado') {
        return res.status(503).json({ error: 'Webhook não configurado' });
      }
      if (motivo === 'header_assinatura_ausente') {
        return res.status(401).json({ error: 'Assinatura ausente' });
      }
      return res.status(403).json({ error: 'Assinatura inválida' });
    }

    // 2. Parse do payload → CanonicalEvent
    let evento;
    try {
      evento = adapter.parseWebhookEvent(req.body);
    } catch (err) {
      console.error(`❌ [WebhookDispatcher] erro ao parsear evento ${providerCode}:`, err.message);
      this.events.logError(providerCode, err, {
        eventSource: EventSource.WEBHOOK,
        payload: { fase: 'parse_evento' },
      });
      // Responde 200 — evento malformado não deve gerar retry infinito
      return adapter.acknowledgeWebhook(res);
    }

    // Log de recebimento (sempre, mesmo se evento for null)
    this.events.log({
      providerCode,
      eventType: EventType.WEBHOOK_RECEIVED,
      eventSource: EventSource.WEBHOOK,
      externalDeliveryId: evento?.externalDeliveryId || null,
      statusCanonico: evento?.statusCanonico || null,
      statusNative: evento?.statusNative || null,
      payload: { event_type: evento?.eventType || 'unknown' },
    }).catch(() => {});

    // Evento sem ação genérico → ack e fim
    if (!evento || !evento.externalDeliveryId) {
      console.log(`📨 [WebhookDispatcher] ${providerCode}: evento sem delivery_id (${evento?.eventType || 'null'})`);
      return adapter.acknowledgeWebhook(res);
    }

    // refund_request (Uber) — recebemos mas precisamos registrar o valor de reembolso.
    // Não tem ação operacional, mas é dinheiro: auditamos como evento financeiro.
    if (evento.eventType === 'other') {
      const kindStr = adapter.webhookEventKind ? adapter.webhookEventKind(req.body) : 'other';
      if (kindStr === 'refund_request' || String(kindStr).includes('refund')) {
        const valorReembolso = req.body?.data?.fee ?? req.body?.data?.refund_amount ?? null;
        this.events.log({
          providerCode,
          eventType: 'refund_request',
          eventSource: EventSource.WEBHOOK,
          externalDeliveryId: evento.externalDeliveryId,
          payload: {
            motivo: 'refund_request recebido do provider',
            valor_centavos: valorReembolso,
            raw: req.body,
          },
        }).catch(() => {});
        if (valorReembolso != null) {
          const reaisStr = (Number(valorReembolso) / 100).toFixed(2);
          console.log(`💰 [WebhookDispatcher] ${providerCode}: refund_request recebido — R$${reaisStr} (external=${evento.externalDeliveryId}). Registrado em logistics_events.`);
        } else {
          console.log(`💰 [WebhookDispatcher] ${providerCode}: refund_request recebido (sem valor). Registrado em logistics_events.`);
        }
      } else {
        console.log(`📨 [WebhookDispatcher] ${providerCode}: evento informativo (${kindStr || 'other'})`);
      }
      return adapter.acknowledgeWebhook(res);
    }

    // 3. RESPONDE AO PROVIDER ANTES de processar (provider espera resposta rápida)
    // O processamento pesado roda depois, de forma assíncrona.
    adapter.acknowledgeWebhook(res);

    // 4. Processa o evento (assíncrono, já respondemos)
    try {
      await this._processarEvento(providerCode, adapter, evento);
    } catch (err) {
      console.error(`❌ [WebhookDispatcher] erro ao processar evento ${providerCode}:`, err.message);
      this.events.logError(providerCode, err, {
        eventSource: EventSource.WEBHOOK,
        externalDeliveryId: evento.externalDeliveryId,
        payload: { fase: 'processamento' },
      });
    }
  }

  /**
   * Aplica um CanonicalEvent que NÃO veio de webhook (ex: polling de tracking,
   * sync manual). Resolve o adapter pelo registry e roda o mesmo pipeline de
   * processamento dos webhooks — atualiza logistics_deliveries, grava tracking,
   * dispara ação Mapp, faz broadcast WebSocket.
   *
   * É o entrypoint público pro TrackingPoller (providers cujo webhook não traz
   * posição do entregador, como a 99Entrega) e pra qualquer resync futuro.
   *
   * @param {string} providerCode
   * @param {import('../contracts/CanonicalTypes').CanonicalEvent} evento
   * @returns {Promise<void>}
   */
  async processarEventoCanonico(providerCode, evento) {
    if (!evento || !evento.externalDeliveryId) return;

    const adapter = this.registry.get(providerCode);
    if (!adapter) {
      console.warn(`⚠️ [WebhookDispatcher] processarEventoCanonico: provider '${providerCode}' não está ativo`);
      return;
    }

    return this._processarEvento(providerCode, adapter, evento);
  }

  /**
   * Processa um CanonicalEvent: localiza entrega, atualiza, dispara ação Mapp.
   * @private
   */
  async _processarEvento(providerCode, adapter, evento) {
    // Localiza a entrega local pelo external_delivery_id
    const { rows } = await this.pool.query(
      'SELECT * FROM logistics_deliveries WHERE external_delivery_id = $1',
      [evento.externalDeliveryId]
    );

    if (rows.length === 0) {
      console.warn(`⚠️ [WebhookDispatcher] entrega desconhecida: ${evento.externalDeliveryId}`);
      return;
    }

    const entrega = rows[0];
    const codigoOS = entrega.codigo_os;

    // ─── Reatribuição de external_delivery_id ───
    // Alguns providers reatribuem o pedido a outro entregador e geram um id
    // novo (ex: 99Entrega DriverCanceled com new_order_id). O parser do adapter
    // expõe isso em evento.reassignedExternalDeliveryId — atualizamos a coluna
    // pra que os próximos webhooks (que virão com o id novo) localizem a entrega.
    if (evento.reassignedExternalDeliveryId
        && evento.reassignedExternalDeliveryId !== entrega.external_delivery_id) {
      await this.pool.query(
        `UPDATE logistics_deliveries
            SET external_delivery_id = $1,
                courier_data    = NULL,
                id_motoboy_mapp = NULL,
                atribuido_at    = NULL,
                ultima_lat      = NULL,
                ultima_lng      = NULL,
                updated_at      = NOW()
          WHERE id = $2`,
        [evento.reassignedExternalDeliveryId, entrega.id]
      );
      console.log(`🔄 [WebhookDispatcher] OS ${codigoOS}: external_delivery_id reatribuído ${entrega.external_delivery_id} → ${evento.reassignedExternalDeliveryId}`);
      this.events.log({
        providerCode,
        eventType: EventType.STATUS_CHANGED,
        eventSource: EventSource.WEBHOOK,
        codigoOS,
        deliveryId: entrega.id,
        externalDeliveryId: evento.reassignedExternalDeliveryId,
        payload: { reatribuicao: true, id_anterior: entrega.external_delivery_id },
      }).catch(() => {});
      entrega.external_delivery_id = evento.reassignedExternalDeliveryId;
      // Motoboy trocou: zera o courier em memoria pra o proximo courier_update
      // ser tratado como PRIMEIRA VEZ (ehPrimeiraVez) e avancar o status certo.
      entrega.courier_data = null;
    }

    // ─── courier_update: atualiza dados do entregador + vincula na Mapp ───
    if (evento.eventType === 'courier_update') {
      await this._processarCourierUpdate(providerCode, entrega, evento);
      return;
    }

    // ─── status_change: idempotência + atualiza + ação Mapp ───
    const novoStatusNative = evento.statusNative;
    const novoStatusCanonico = evento.statusCanonico;

    // IDEMPOTÊNCIA: se já processamos esse status, ignora
    if (entrega.status_native === novoStatusNative) {
      console.log(`⊘ [WebhookDispatcher] OS ${codigoOS}: status ${novoStatusNative} duplicado, ignorado`);
      return;
    }

    console.log(`📡 [WebhookDispatcher] OS ${codigoOS}: ${entrega.status_native} → ${novoStatusNative} (${novoStatusCanonico})`);

    // Atualiza status local (+ backfill tracking_url se faltava)
    if (evento.trackingUrl && !entrega.tracking_url) {
      await this.pool.query(
        'UPDATE logistics_deliveries SET status_native = $1, status_canonico = $2, tracking_url = $3, updated_at = NOW() WHERE id = $4',
        [novoStatusNative, novoStatusCanonico, evento.trackingUrl, entrega.id]
      );
    } else {
      await this.pool.query(
        'UPDATE logistics_deliveries SET status_native = $1, status_canonico = $2, updated_at = NOW() WHERE id = $3',
        [novoStatusNative, novoStatusCanonico, entrega.id]
      );
    }

    // 🆕 Timestamps de estágio (idempotente: a primeira ocorrência vence via COALESCE)
    if (novoStatusCanonico === CanonicalStatus.COURIER_ASSIGNED) {
      await this.pool.query(
        'UPDATE logistics_deliveries SET atribuido_at = COALESCE(atribuido_at, NOW()) WHERE id = $1',
        [entrega.id]
      ).catch(() => {});
    } else if (novoStatusCanonico === CanonicalStatus.PICKED_UP) {
      await this.pool.query(
        'UPDATE logistics_deliveries SET coletado_at = COALESCE(coletado_at, NOW()) WHERE id = $1',
        [entrega.id]
      ).catch(() => {});
    } else if (novoStatusCanonico === CanonicalStatus.DELIVERED) {
      await this.pool.query(
        'UPDATE logistics_deliveries SET entregue_at = COALESCE(entregue_at, NOW()) WHERE id = $1',
        [entrega.id]
      ).catch(() => {});
    }

    // Audita mudança de status
    this.events.log({
      providerCode,
      eventType: EventType.STATUS_CHANGED,
      eventSource: EventSource.WEBHOOK,
      codigoOS,
      deliveryId: entrega.id,
      externalDeliveryId: evento.externalDeliveryId,
      statusCanonico: novoStatusCanonico,
      statusNative: novoStatusNative,
    }).catch(() => {});

    // Dispara ação Mapp conforme o status canônico
    await this._dispararAcaoMapp(codigoOS, entrega, evento, novoStatusCanonico);
  }

  /**
   * Dispara a ação Mapp correspondente ao status canônico.
   * Usa STATUS_TO_MAPP_ACTION do CanonicalStatus.
   *
   * Fixes aplicados aqui:
   *  FIX #2 — providers sem supportsArrivedDropoff (ex: 99Entrega):
   *    O evento ARRIVED_DROPOFF nunca ocorre nesse ciclo. Quando DELIVERED
   *    chega, chamamos informarChegada(ponto 2) ANTES de finalizarEndereco(ponto 2)
   *    para manter a sequência que a Mapp exige.
   *  FIX #3 — finalizarServico explícito como fallback:
   *    Após finalizarEndereco(último ponto), chamamos finalizarServico() em
   *    best-effort. Se a Mapp já auto-finalizou, a chamada é inócua; se não
   *    finalizou (ex: OS com mais de 2 pontos não gerenciados pelo hub),
   *    o serviço é encerrado corretamente.
   * @private
   */
  async _dispararAcaoMapp(codigoOS, entrega, evento, statusCanonico) {
    // skipMappAction: grava o status_canonico (ex: RETURNED no SendBack, pra
    // mostrar no kanban) mas NAO dispara nenhuma acao na Mapp. Usado quando a
    // devolucao INICIA — a acao Mapp so acontece no SendBackCompleted.
    if (evento && evento.skipMappAction) return;
    // mappActionStatus (quando presente no evento) permite gravar um
    // status_canonico mas disparar a ACAO Mapp de outro status. Ex.: devolucao
    // concluida grava RETURNED mas FINALIZA a OS (acao de DELIVERED) em vez de
    // reabrir. Sem o flag, usa o proprio statusCanonico (comportamento normal).
    const acao = STATUS_TO_MAPP_ACTION[(evento && evento.mappActionStatus) || statusCanonico];
    if (!acao) return; // status sem ação Mapp (ex: PICKUP_EN_ROUTE)

    // Coordenadas do evento. Se o provider não envia GPS no webhook (ex: 99Entrega),
    // usa a última posição conhecida gravada pelo TrackingPoller como fallback.
    let lat = evento.location?.lat ?? null;
    let lng = evento.location?.lng ?? null;
    if ((lat == null || lng == null) && entrega.ultima_lat != null && entrega.ultima_lng != null) {
      lat = parseFloat(entrega.ultima_lat);
      lng = parseFloat(entrega.ultima_lng);
      console.log(`📍 [WebhookDispatcher] OS ${codigoOS}: usando última posição conhecida (${lat}, ${lng}) pra ação Mapp`);
    }

    // FIX #2: verifica se o provider suporta ARRIVED_DROPOFF. Se não suporta
    // (ex: 99Entrega), o evento de chegada no destino nunca ocorre — precisamos
    // compensar chamando informarChegada(ponto 2) antes de finalizar o serviço.
    const providerCode = entrega.provider_code || 'uber';
    const adapter = this.registry.get(providerCode);
    const supportsArrivedDropoff = !adapter || adapter.capabilities().supportsArrivedDropoff !== false;

    try {
      switch (acao.type) {
        case 'finalizar_ponto_coleta':
          // PICKED_UP → informa chegada + finaliza ponto 1
          await this.mapp.informarChegada(codigoOS, 1, lat, lng);
          await this.mapp.finalizarEndereco(codigoOS, 1, lat, lng);
          break;

        case 'informar_chegada':
          // ARRIVED_DROPOFF → informa chegada ponto 2
          await this.mapp.informarChegada(codigoOS, acao.ponto || 2, lat, lng);
          break;

        case 'finalizar_servico': {
          // DELIVERED → finaliza ponto 2 + encerra serviço na Mapp + busca comprovante
          const pontoDrop = acao.ponto || 2;

          // Busca comprovante de entrega em best-effort (foto/assinatura do recebedor).
          // Controlado por proof_of_delivery_habilitado na config do provider (padrão: true).
          const _proofHabilitado = !adapter?.config || adapter.config.proof_of_delivery_habilitado !== false;
          if (_proofHabilitado && adapter && typeof adapter.getProofOfDelivery === 'function' && entrega.external_delivery_id) {
            adapter.getProofOfDelivery(entrega.external_delivery_id).then(proof => {
              if (proof) {
                this.pool.query(
                  'UPDATE logistics_deliveries SET proof_of_delivery = $1, updated_at = NOW() WHERE id = $2',
                  [JSON.stringify(proof), entrega.id]
                ).catch(() => {});
                console.log(`📸 [WebhookDispatcher] OS ${codigoOS}: comprovante de entrega salvo`);
              }
            }).catch(() => {});
          }

          // FIX #2: provider sem ARRIVED_DROPOFF (ex: 99Entrega) — a informarChegada
          // do ponto de entrega nunca foi chamada. Fazemos agora antes de finalizar.
          if (!supportsArrivedDropoff) {
            console.log(`📡 [WebhookDispatcher] OS ${codigoOS}: provider '${providerCode}' sem ARRIVED_DROPOFF — chamando informarChegada(${pontoDrop}) antes de finalizar`);
            await this.mapp.informarChegada(codigoOS, pontoDrop, lat, lng);
          }

          await this.mapp.finalizarEndereco(codigoOS, pontoDrop, lat, lng);

          // FIX #3: finalizarServico explícito como fallback.
          // A Mapp auto-finaliza ao fechar o último ponto, mas chamamos aqui
          // em best-effort para garantir encerramento em casos de multi-ponto
          // ou de auto-finalize não ter disparado.
          this.mapp.finalizarServico(codigoOS).catch(errFS => {
            // Ignoramos erro (a Mapp retorna erro se já estava finalizado — esperado)
            console.log(`📡 [WebhookDispatcher] finalizarServico OS ${codigoOS} best-effort: ${errFS.message}`);
          });

          await this.pool.query(
            'UPDATE logistics_deliveries SET finalizado_at = NOW(), updated_at = NOW() WHERE id = $1',
            [entrega.id]
          );
          break;
        }

        case 'alterar_status':
          // CANCELED / RETURNED / FAILED / FALLBACK_QUEUE → reabre na Mapp
          await this.mapp.alterarStatus(codigoOS, acao.status != null ? acao.status : 0);
          await this.pool.query(
            'UPDATE logistics_deliveries SET cancelado_por = $1, cancelado_motivo = $2, updated_at = NOW() WHERE id = $3',
            ['provider', `Status: ${evento.statusNative}`, entrega.id]
          );
          break;

        case 'vincular_motorista':
          // COURIER_ASSIGNED via status_change (raro — geralmente vem via courier_update)
          // Se tiver courier no evento, vincula
          if (evento.courier?.name) {
            await this._vincularMotorista(codigoOS, entrega, evento.courier);
          }
          break;
      }
    } catch (erro) {
      console.error(`❌ [WebhookDispatcher] erro ação Mapp '${acao.type}' OS ${codigoOS}:`, erro.message);
      await this.pool.query(
        'UPDATE logistics_deliveries SET erro_ultimo = $1, updated_at = NOW() WHERE id = $2',
        [`Erro ação ${acao.type}: ${erro.message}`, entrega.id]
      ).catch(() => {});
    }
  }

  /**
   * 🚫 Blacklist: se o courier atribuido bate com um bloqueio ATIVO (por
   * telefone ou placa), cancela a entrega no provider e dispara nova
   * atribuicao (reatribuicao automatica). Protegido contra loop por um teto
   * de reatribuicoes por OS (em memoria).
   *
   * @returns {Promise<boolean>} true se barrou (cancelou/reatribuiu) — o
   *   chamador deve interromper o fluxo normal de courier_update.
   * @private
   */
  async _checarBloqueioEReatribuir(providerCode, entrega, courier) {
    const { buscarBloqueioAtivo } = require('../logistics.bloqueados');
    const bloqueio = await buscarBloqueioAtivo(this.pool, courier);
    if (!bloqueio) return false;

    const codigoOS = entrega.codigo_os;

    // Teto de reatribuicoes por OS (evita loop se o provider insistir no mesmo
    // entregador barrado). Em memoria — reinicio zera, cenario raro.
    const TETO = 3;
    if (!this._reatribBloqueio) this._reatribBloqueio = new Map();
    const jaFeitas = this._reatribBloqueio.get(codigoOS) || 0;

    console.warn(`🚫 [WebhookDispatcher] OS ${codigoOS}: entregador BLOQUEADO detectado (${courier.name}) — bloqueio id=${bloqueio.id}`);

    // Contabiliza a reatribuicao no bloqueio (metricas do painel)
    await this.pool.query(
      'UPDATE logistics_couriers_bloqueados SET reatribuicoes = reatribuicoes + 1 WHERE id = $1',
      [bloqueio.id]
    ).catch(() => {});

    // Audita o evento
    this.events.log({
      providerCode,
      eventType: EventType.REDISPATCHED,
      eventSource: EventSource.SYSTEM,
      codigoOS,
      deliveryId: entrega.id,
      payload: { motivo: 'entregador_bloqueado', bloqueio_id: bloqueio.id, courier: courier.name },
    }).catch(() => {});

    const { getDispatchOrchestrator } = require('./DispatchOrchestrator');
    const orchestrator = getDispatchOrchestrator(this.pool);

    // Cancela no provider + reabre a OS na Mapp (reabrirMapp:true default)
    try {
      await orchestrator.cancel(entrega.id, {
        motivo: `Entregador bloqueado (${courier.name || 's/ nome'}) — reatribuicao automatica`,
        canceladoPor: 'sistema-bloqueio',
        eventSource: EventSource.SYSTEM,
        reabrirMapp: true,
      });
    } catch (eCancel) {
      // Se ja estava terminal ou o cancel falhou, ainda assim NAO seguimos o
      // fluxo normal (nao queremos vincular o bloqueado). Loga e retorna true.
      console.warn(`[WebhookDispatcher] cancel do bloqueado OS ${codigoOS} nao confirmado: ${eCancel.message}`);
      return true;
    }

    // Reatribui (novo chamado) se ainda nao estourou o teto
    if (jaFeitas < TETO) {
      this._reatribBloqueio.set(codigoOS, jaFeitas + 1);
      try {
        await orchestrator.tryDispatchByOS(codigoOS, { motivo: 'reatribuicao_bloqueio' });
        console.log(`🔄 [WebhookDispatcher] OS ${codigoOS}: reatribuida (tentativa ${jaFeitas + 1}/${TETO})`);
      } catch (eRe) {
        console.error(`[WebhookDispatcher] falha ao reatribuir OS ${codigoOS}: ${eRe.message}`);
      }
    } else {
      console.warn(`⚠️ [WebhookDispatcher] OS ${codigoOS}: teto de reatribuicoes (${TETO}) atingido — corrida cancelada, INTERVIR MANUALMENTE`);
    }

    return true;
  }

  /**
   * Processa courier_update: salva dados do entregador, vincula na Mapp,
   * grava posição no tracking, faz broadcast WebSocket.
   * @private
   */
  async _processarCourierUpdate(providerCode, entrega, evento) {
    const codigoOS = entrega.codigo_os;
    const courier = evento.courier;

    // 🚫 BLACKLIST — se o entregador atribuido esta bloqueado, cancela e
    // reatribui automaticamente ANTES de vincular na Mapp. Cobre 99 e Uber
    // porque ambos convergem aqui (webhook Uber + TrackingPoller 99).
    if (courier?.name) {
      try {
        const barrado = await this._checarBloqueioEReatribuir(providerCode, entrega, courier);
        if (barrado) return; // ja foi cancelado/reatribuido — nao segue o fluxo normal
      } catch (eBloq) {
        console.error(`[WebhookDispatcher] erro na checagem de bloqueio OS ${codigoOS}:`, eBloq.message);
        // fail-open: se a checagem falhar, segue o fluxo normal (nao trava a corrida)
      }
    }

    // Vincula motorista na Mapp se é a primeira vez (entrega ainda sem courier)
    if (courier?.name) {
      // Merge (antes era write-once): a placa/cor da 99 so existem em
      // waiting/delivering e o PRIMEIRO courier_update pode chegar sem elas
      // (a 99 zera vehicle_info em finding e apos completed/canceled). O
      // write-once antigo perdia a placa que so aparecia depois. Aqui a gente
      // preenche o que faltava SEM sobrescrever valor existente com null.
      const ehPrimeiraVez = !(entrega.courier_data && entrega.courier_data.name);
      const avancaStatus = ehPrimeiraVez && ['PENDING', 'QUOTED', 'DISPATCHED'].includes(entrega.status_canonico);

      const _atual = entrega.courier_data || {};
      const _merged = {
        name:    courier.name    || _atual.name    || null,
        phone:   courier.phone   || _atual.phone   || null,
        plate:   courier.plate   || _atual.plate   || null,
        vehicle: courier.vehicle || _atual.vehicle || null,
        photo:   courier.photo   || _atual.photo   || null,
        rating:  courier.rating != null ? courier.rating : (_atual.rating != null ? _atual.rating : null),
      };
      // Troca de entregador FORA da reatribuicao-null (99 troca o driver sem
      // DriverCanceled+new_order_id). Detecta pelo nome: se mudou, precisa
      // re-vincular na Mapp (senao a Mapp fica no nome antigo) e registrar na
      // trilha. Comparacao normalizada (trim/lower) pra nao disparar por
      // diferenca de caixa/espaco do mesmo motoboy.
      const _norm = (s) => String(s || '').trim().toLowerCase();
      const nomeAntigo = _atual.name || null;
      const nomeNovo   = courier.name || null;
      const trocouMotoboy = !ehPrimeiraVez && nomeNovo && nomeAntigo
        && _norm(nomeNovo) !== _norm(nomeAntigo);

      const _mudou = ehPrimeiraVez
        || trocouMotoboy
        || (_merged.plate   || null) !== (_atual.plate   || null)
        || (_merged.vehicle || null) !== (_atual.vehicle || null)
        || (_merged.photo   || null) !== (_atual.photo   || null)
        || (_merged.phone   || null) !== (_atual.phone   || null);

      if (_mudou) {
        await this.pool.query(`
          UPDATE logistics_deliveries SET
            courier_data = $1,
            status_native   = CASE WHEN $3 THEN 'entregador_atribuido' ELSE status_native   END,
            status_canonico = CASE WHEN $3 THEN 'COURIER_ASSIGNED'     ELSE status_canonico END,
            updated_at = NOW()
          WHERE id = $2
        `, [JSON.stringify(_merged), entrega.id, avancaStatus]);
      }

      if (ehPrimeiraVez) {
        await this._vincularMotorista(codigoOS, entrega, courier);
        // Rastreio IMEDIATO ao grupo no aceite (nao espera o poller de 30s).
        try {
          const _sla = require('../../agent/sla-capture.service');
          if (typeof _sla.enviarRastreioGrupoImediato === 'function') {
            await _sla.enviarRastreioGrupoImediato(this.pool, entrega.id);
          }
        } catch (eRast) {
          console.warn(`[WebhookDispatcher] rastreio imediato OS ${codigoOS}:`, eRast.message);
        }
      } else if (trocouMotoboy) {
        // Re-vincula o NOVO motoboy na Mapp (troca o nome la) e registra a troca
        // na trilha (payload.reatribuicao=true -> aparece no TrilhaEntrega).
        await this._vincularMotorista(codigoOS, entrega, courier);
        this.events.log({
          providerCode,
          eventType: EventType.STATUS_CHANGED,
          eventSource: EventSource.WEBHOOK,
          codigoOS,
          deliveryId: entrega.id,
          externalDeliveryId: entrega.external_delivery_id,
          payload: { reatribuicao: true, nome_anterior: nomeAntigo, nome_novo: nomeNovo },
        }).catch(() => {});
        console.log(`🔄 [WebhookDispatcher] OS ${codigoOS}: troca de entregador ${nomeAntigo} → ${nomeNovo} — re-vinculado na Mapp`);
      }
    }

    // Salva posição no tracking + atualiza ultima_lat/lng na entrega (GPS enrichment)
    if (evento.location?.lat && evento.location?.lng) {
      await this.pool.query(`
        INSERT INTO logistics_tracking (codigo_os, provider_code, delivery_id, external_delivery_id, latitude, longitude, status_native)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [codigoOS, providerCode, entrega.id, evento.externalDeliveryId, evento.location.lat, evento.location.lng, evento.statusNative])
        .catch(e => console.error('[WebhookDispatcher] erro ao gravar tracking:', e.message));

      // Persiste a última posição conhecida do entregador na entrega.
      // Usado como fallback de coordenadas quando ações Mapp (informarChegada,
      // finalizarEndereco) chegam via webhook sem GPS (ex: 99Entrega).
      await this.pool.query(
        'UPDATE logistics_deliveries SET ultima_lat = $1, ultima_lng = $2, updated_at = NOW() WHERE id = $3',
        [evento.location.lat, evento.location.lng, entrega.id]
      ).catch(() => {});

      // Broadcast WebSocket (mantém compat com frontend atual)
      if (global.broadcastUberTracking) {
        global.broadcastUberTracking(codigoOS, {
          latitude: evento.location.lat,
          longitude: evento.location.lng,
          status: evento.statusNative,
          entregador: courier?.name,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Vincula motorista na Mapp. Telefone Uber vem E.164, Mapp quer sem DDI.
   * @private
   */
  async _vincularMotorista(codigoOS, entrega, courier) {
    // Telefone: Uber manda E.164 (+5571...), Mapp quer DDD+número
    const telDigits = String(courier.phone || '').replace(/\D/g, '');
    const telBR = telDigits.startsWith('55') && telDigits.length >= 12
      ? telDigits.slice(2)
      : telDigits;

    const profissional = {
      nome: courier.name,
      telefone: telBR,
      placa: courier.plate || '',
      veiculo: courier.vehicle || '',
    };

    try {
      const respMapp = await this.mapp.vincularMotorista(codigoOS, profissional);
      if (this.mapp.respostaOK(respMapp)) {
        const payload = this.mapp.payload(respMapp);
        if (payload.idMotoboy) {
          await this.pool.query(
            'UPDATE logistics_deliveries SET id_motoboy_mapp = $1, updated_at = NOW() WHERE id = $2',
            [payload.idMotoboy, entrega.id]
          );
        }
        console.log(`✅ [WebhookDispatcher] entregador vinculado na Mapp: OS=${codigoOS}, ${courier.name}`);
      } else {
        console.warn(`⚠️ [WebhookDispatcher] vincularMotorista falhou OS=${codigoOS}: ${respMapp?.msgUsuario}`);
      }
    } catch (err) {
      console.error(`❌ [WebhookDispatcher] erro vincular Mapp OS=${codigoOS}:`, err.message);
    }
  }

  /**
   * Retorna headers seguros pra log (sem expor secrets).
   * @private
   */
  _safeHeaders(req) {
    const safe = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      // Não loga headers de assinatura completos — só o tamanho
      if (k.toLowerCase().includes('signature') || k.toLowerCase().includes('authorization')) {
        safe[k] = `[${String(v).length} chars]`;
      } else {
        safe[k] = v;
      }
    }
    return safe;
  }
}

// ════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════
let _instance = null;

function getWebhookDispatcher(pool) {
  if (!_instance) {
    if (!pool) throw new Error('WebhookDispatcher: pool obrigatório na primeira chamada');
    _instance = new WebhookDispatcher(pool);
  }
  return _instance;
}

module.exports = { WebhookDispatcher, getWebhookDispatcher };
