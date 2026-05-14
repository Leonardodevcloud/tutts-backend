/**
 * MÓDULO LOGISTICS — EventLogger
 *
 * Insert único em logistics_events. Todo evento operacional do hub passa por aqui:
 *  - Webhook recebido / processado / rejeitado
 *  - Decisão de despacho (qual provider escolhido, por que os outros foram rejeitados)
 *  - Erro de cotação
 *  - Erro técnico (auth, rede, etc)
 *  - Timeout do worker
 *  - Mudança de status
 *  - Ação manual do admin
 *
 * O dashboard consome esta tabela diretamente para mostrar histórico unificado
 * por provider, sem precisar fazer UNION de tabelas separadas.
 *
 * Falhas no logger NUNCA derrubam o fluxo de negócio — sempre catch+log.
 */

/**
 * Tipos de evento padronizados. Use estas constantes em vez de strings soltas.
 */
const EventType = Object.freeze({
  // Webhook
  WEBHOOK_RECEIVED:  'webhook_received',
  WEBHOOK_PROCESSED: 'webhook_processed',
  WEBHOOK_REJECTED:  'webhook_rejected',
  WEBHOOK_INVALID_SIGNATURE: 'webhook_invalid_signature',

  // Despacho
  DISPATCH_DECISION: 'dispatch_decision',
  DISPATCH_ATTEMPT:  'dispatch_attempt',
  DISPATCH_SUCCESS:  'dispatch_success',
  DISPATCH_FAILED:   'dispatch_failed',
  DISPATCH_REJECTED_BY_RULE: 'dispatch_rejected_by_rule',
  DISPATCH_REJECTED_BY_MARGIN: 'dispatch_rejected_by_margin',

  // Cotação
  QUOTE_CREATED: 'quote_created',
  QUOTE_FAILED:  'quote_failed',
  QUOTE_EXPIRED: 'quote_expired',

  // Status
  STATUS_CHANGED: 'status_changed',

  // Operações
  CANCELED: 'canceled',
  REDISPATCHED: 'redispatched',
  TIMEOUT_FALLBACK: 'timeout_fallback',

  // Sistema
  ERROR: 'error',
  AUTH_REFRESH: 'auth_refresh',
});

/**
 * Origem do evento (quem disparou).
 */
const EventSource = Object.freeze({
  WEBHOOK: 'webhook',
  WORKER:  'worker',
  ADMIN:   'admin',
  API:     'api',
  SYSTEM:  'system',
});

class EventLogger {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Registra um evento. Retorna o id inserido ou null em caso de erro.
   *
   * @param {Object} evt
   * @param {string} evt.providerCode
   * @param {string} evt.eventType - Use EventType.*
   * @param {string} [evt.eventSource='system'] - Use EventSource.*
   * @param {number} [evt.deliveryId] - logistics_deliveries.id
   * @param {number} [evt.codigoOS] - codigoOS da Mapp
   * @param {string} [evt.externalDeliveryId]
   * @param {string} [evt.statusCanonico]
   * @param {string} [evt.statusNative]
   * @param {Object} [evt.payload]
   * @param {string} [evt.erro]
   * @param {boolean} [evt.processado=true]
   * @returns {Promise<number|null>}
   */
  async log(evt) {
    if (!evt || !evt.providerCode || !evt.eventType) {
      console.warn('⚠️  [EventLogger] log() ignorado — providerCode e eventType obrigatórios');
      return null;
    }

    try {
      const { rows } = await this.pool.query(`
        INSERT INTO logistics_events (
          provider_code, delivery_id, codigo_os, external_delivery_id,
          event_type, event_source,
          status_canonico, status_native,
          payload, erro, processado
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `, [
        evt.providerCode,
        evt.deliveryId || null,
        evt.codigoOS || null,
        evt.externalDeliveryId || null,
        evt.eventType,
        evt.eventSource || EventSource.SYSTEM,
        evt.statusCanonico || null,
        evt.statusNative || null,
        evt.payload ? JSON.stringify(evt.payload) : null,
        evt.erro || null,
        evt.processado !== false,
      ]);
      return rows[0]?.id || null;
    } catch (err) {
      // Log mas não derruba — eventos são auditoria, não fluxo crítico
      console.error('❌ [EventLogger] falha ao inserir evento:', err.message, {
        providerCode: evt.providerCode,
        eventType: evt.eventType,
      });
      return null;
    }
  }

  /**
   * Helper: log de erro. Inverte processado=false automaticamente.
   *
   * @param {string} providerCode
   * @param {Error|string} erro
   * @param {Object} [contexto] - Campos extras (deliveryId, codigoOS, etc)
   */
  async logError(providerCode, erro, contexto = {}) {
    return this.log({
      providerCode,
      eventType: EventType.ERROR,
      eventSource: contexto.eventSource || EventSource.SYSTEM,
      erro: erro instanceof Error ? erro.message : String(erro),
      processado: false,
      payload: contexto.payload || null,
      deliveryId: contexto.deliveryId,
      codigoOS: contexto.codigoOS,
      externalDeliveryId: contexto.externalDeliveryId,
    });
  }

  /**
   * Helper: log de decisão de despacho. Estrutura padronizada para análise.
   *
   * @param {Object} args
   * @param {number} args.codigoOS
   * @param {string} args.providerEscolhido
   * @param {string[]} args.providersCotados
   * @param {Object[]} args.cotacoes - Array de { providerCode, valor, etaMinutos, available, erro? }
   * @param {string} args.estrategia
   * @param {string} [args.motivoEscolha]
   */
  async logDispatchDecision(args) {
    return this.log({
      providerCode: args.providerEscolhido || 'none',
      eventType: EventType.DISPATCH_DECISION,
      eventSource: EventSource.WORKER,
      codigoOS: args.codigoOS,
      payload: {
        provider_escolhido: args.providerEscolhido,
        providers_cotados: args.providersCotados,
        cotacoes: args.cotacoes,
        estrategia: args.estrategia,
        motivo_escolha: args.motivoEscolha,
      },
    });
  }

  /**
   * Query de auditoria — usada pelo endpoint GET /api/logistics/events.
   *
   * @param {Object} filtros
   * @param {string} [filtros.providerCode]
   * @param {string} [filtros.eventType]
   * @param {number} [filtros.codigoOS]
   * @param {number} [filtros.deliveryId]
   * @param {Date} [filtros.desde]
   * @param {Date} [filtros.ate]
   * @param {number} [filtros.limit=100]
   * @param {number} [filtros.offset=0]
   */
  async query(filtros = {}) {
    const where = [];
    const params = [];
    let idx = 1;

    if (filtros.providerCode) { where.push(`provider_code = $${idx++}`); params.push(filtros.providerCode); }
    if (filtros.eventType)    { where.push(`event_type = $${idx++}`); params.push(filtros.eventType); }
    if (filtros.codigoOS)     { where.push(`codigo_os = $${idx++}`); params.push(filtros.codigoOS); }
    if (filtros.deliveryId)   { where.push(`delivery_id = $${idx++}`); params.push(filtros.deliveryId); }
    if (filtros.desde)        { where.push(`created_at >= $${idx++}`); params.push(filtros.desde); }
    if (filtros.ate)          { where.push(`created_at <= $${idx++}`); params.push(filtros.ate); }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(parseInt(filtros.limit, 10) || 100, 500);
    const offset = parseInt(filtros.offset, 10) || 0;

    const { rows } = await this.pool.query(
      `SELECT * FROM logistics_events ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return rows;
  }
}

// ════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════
let _instance = null;

/**
 * @param {import('pg').Pool} pool
 * @returns {EventLogger}
 */
function getEventLogger(pool) {
  if (!_instance) {
    if (!pool) throw new Error('EventLogger: pool obrigatório na primeira chamada');
    _instance = new EventLogger(pool);
  }
  return _instance;
}

module.exports = { EventLogger, getEventLogger, EventType, EventSource };
