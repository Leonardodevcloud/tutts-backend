/**
 * MÓDULO LOGISTICS — Migration Fase 2: Backfill de entregas
 *
 * Copia o histórico de uber_entregas → logistics_deliveries.
 *
 * É IDEMPOTENTE: usa NOT EXISTS pra não duplicar. Pode rodar quantas vezes
 * quiser — só copia o que ainda não está lá.
 *
 * MAPEAMENTO DE CAMPOS (uber_entregas → logistics_deliveries):
 *   codigo_os            → codigo_os
 *   (literal 'uber')     → provider_code
 *   uber_delivery_id     → external_delivery_id
 *   uber_quote_id        → external_quote_id
 *   status_uber          → status_native
 *   (derivado)           → status_canonico   [via mapa UBER_TO_CANONICAL]
 *   valor_servico        → valor_servico
 *   valor_uber           → valor_provider
 *   valor_profissional   → valor_profissional
 *   eta_minutos          → eta_minutos
 *   entregador_* (x7)    → courier_data (JSONB consolidado)
 *   endereco_*, lat/long → idem
 *   pontos, obs          → idem
 *   tracking_url         → (não existe no legado — fica NULL)
 *   tentativas           → tentativas
 *   erro_ultimo          → erro_ultimo
 *   id_motoboy_mapp      → id_motoboy_mapp
 *   cancelado_*          → cancelado_*
 *   finalizado_at        → finalizado_at
 *   created_at/updated_at→ idem (preserva timestamps originais)
 *   status_mapp          → (NÃO migra — campo legado pouco usado)
 *
 * Esta migration é chamada explicitamente (não pela initLogisticsTables).
 * O index.js da Fase 2 a expõe via initLogisticsBackfill(pool), e há também
 * um endpoint POST /_admin/resync-deliveries pra re-rodar sob demanda.
 *
 * IMPORTANTE — sobre "espelhamento contínuo":
 * O Orchestrator (Fase 1) ainda ESCREVE em uber_entregas (decisão Opção A).
 * Este backfill é um SNAPSHOT — copia o que existe no momento da execução.
 * Entregas criadas DEPOIS do backfill não aparecem em logistics_deliveries
 * até o próximo resync. O espelhamento contínuo (escrever nas duas, ou migrar
 * a escrita) fica pra Fase 5, quando o frontend migrar junto. Por ora:
 * logistics_deliveries = histórico consultável; uber_entregas = fonte viva.
 */

// Mapa status nativo Uber → canônico. Mantido em sincronia com
// adapters/uber/uber.status-map.js (não importamos de lá pra a migration
// ser auto-contida e não quebrar se o adapter mudar de assinatura).
const UBER_STATUS_TO_CANONICAL = {
  pending:          'DISPATCHED',
  pickup:           'PICKUP_EN_ROUTE',
  pickup_complete:  'PICKED_UP',
  dropoff:          'ARRIVED_DROPOFF',
  delivered:        'DELIVERED',
  canceled:         'CANCELED',
  cancelled:        'CANCELED',
  returned:         'RETURNED',
  failed:           'FAILED',
  // Status internos do uber_entregas legado que não são status "oficiais" da Uber:
  aguardando_cotacao: 'PENDING',
  cotacao_recebida:   'QUOTED',
  enviado_uber:       'DISPATCHED',
  entregador_atribuido: 'COURIER_ASSIGNED',
  erro:               'FAILED',
  fallback_fila:      'FALLBACK_QUEUE',
  fallback_queue:     'FALLBACK_QUEUE',
};

/**
 * Faz o backfill de uber_entregas → logistics_deliveries.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{copiadas: number, ja_existiam: number, total_origem: number}>}
 */
async function backfillDeliveries(pool) {
  // 1. Verifica se uber_entregas existe (defensivo — pode não existir num ambiente limpo)
  const { rows: existeTabela } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'uber_entregas'
    ) AS existe
  `);

  if (!existeTabela[0]?.existe) {
    console.log('ℹ️  [logistics/backfill] uber_entregas não existe — nada a copiar');
    return { copiadas: 0, ja_existiam: 0, total_origem: 0 };
  }

  // 2. Conta origem
  const { rows: [{ total }] } = await pool.query('SELECT COUNT(*)::int AS total FROM uber_entregas');

  if (total === 0) {
    console.log('ℹ️  [logistics/backfill] uber_entregas vazia — nada a copiar');
    return { copiadas: 0, ja_existiam: 0, total_origem: 0 };
  }

  // 3. Monta o CASE de tradução de status inline (mais eficiente que loop em JS)
  const casoStatus = Object.entries(UBER_STATUS_TO_CANONICAL)
    .map(([nativo, canonico]) => `WHEN LOWER(ue.status_uber) = '${nativo}' THEN '${canonico}'`)
    .join('\n        ');

  // 4. Insere o que ainda não existe.
  //    Idempotência: NOT EXISTS por (provider_code, codigo_os, external_delivery_id).
  //    courier_data: consolida os 7 campos entregador_* num JSONB. Se todos forem
  //    NULL, courier_data fica NULL (não cria objeto vazio).
  const { rowCount } = await pool.query(`
    INSERT INTO logistics_deliveries (
      codigo_os, provider_code, external_delivery_id, external_quote_id,
      status_canonico, status_native,
      valor_servico, valor_provider, valor_profissional, eta_minutos,
      vehicle_type, courier_data,
      endereco_coleta, endereco_entrega,
      latitude_coleta, longitude_coleta, latitude_entrega, longitude_entrega,
      pontos, obs, tracking_url, raw_provider_payload,
      regra_id, id_motoboy_mapp, tentativas, erro_ultimo,
      finalizado_at, cancelado_por, cancelado_motivo,
      created_at, updated_at
    )
    SELECT
      ue.codigo_os,
      'uber',
      ue.uber_delivery_id,
      ue.uber_quote_id,
      CASE
        ${casoStatus}
        ELSE 'PENDING'
      END,
      ue.status_uber,
      ue.valor_servico,
      ue.valor_uber,
      ue.valor_profissional,
      ue.eta_minutos,
      NULL,  -- vehicle_type: legado não armazena
      CASE
        WHEN ue.entregador_nome IS NULL AND ue.entregador_telefone IS NULL
         AND ue.entregador_placa IS NULL AND ue.entregador_veiculo IS NULL
         AND ue.entregador_documento IS NULL AND ue.entregador_foto IS NULL
         AND ue.entregador_rating IS NULL
        THEN NULL
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'name',     ue.entregador_nome,
          'phone',    ue.entregador_telefone,
          'plate',    ue.entregador_placa,
          'vehicle',  ue.entregador_veiculo,
          'document', ue.entregador_documento,
          'photo',    ue.entregador_foto,
          'rating',   ue.entregador_rating
        ))
      END,
      ue.endereco_coleta,
      ue.endereco_entrega,
      ue.latitude_coleta,
      ue.longitude_coleta,
      ue.latitude_entrega,
      ue.longitude_entrega,
      COALESCE(ue.pontos, '[]'::jsonb),
      ue.obs,
      NULL,  -- tracking_url: legado não armazena
      NULL,  -- raw_provider_payload: legado não armazena
      ue.regra_id,
      ue.id_motoboy_mapp,
      COALESCE(ue.tentativas, 0),
      ue.erro_ultimo,
      ue.finalizado_at,
      ue.cancelado_por,
      ue.cancelado_motivo,
      ue.created_at,
      ue.updated_at
    FROM uber_entregas ue
    WHERE NOT EXISTS (
      SELECT 1 FROM logistics_deliveries ld
      WHERE ld.provider_code = 'uber'
        AND ld.codigo_os = ue.codigo_os
        AND COALESCE(ld.external_delivery_id, '') = COALESCE(ue.uber_delivery_id, '')
        AND ld.created_at = ue.created_at
    )
  `);

  const jaExistiam = total - rowCount;
  console.log(`✅ [logistics/backfill] ${rowCount} entrega(s) copiada(s), ${jaExistiam} já existiam (origem: ${total})`);

  return { copiadas: rowCount, ja_existiam: jaExistiam, total_origem: total };
}

/**
 * Verifica se o schema de uber_entregas tem a coluna regra_id.
 * O Orchestrator da Fase 1B.1 insere regra_id em uber_entregas — mas se o
 * schema legado não tiver essa coluna (versão antiga), o backfill quebraria.
 * Esta função adiciona a coluna se faltar (idempotente).
 *
 * @param {import('pg').Pool} pool
 */
async function garantirColunaRegraId(pool) {
  try {
    await pool.query(`
      ALTER TABLE uber_entregas ADD COLUMN IF NOT EXISTS regra_id INTEGER
    `);
  } catch (err) {
    // Se uber_entregas não existe, ignora — backfillDeliveries já trata isso
    if (!String(err.message).includes('does not exist')) {
      console.warn('[logistics/backfill] aviso ao garantir regra_id:', err.message);
    }
  }
}

/**
 * Cria índice composto pra performance de queries por provider+OS.
 * Idempotente (IF NOT EXISTS).
 *
 * @param {import('pg').Pool} pool
 */
async function criarIndices(pool) {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_logistics_deliveries_provider_os
    ON logistics_deliveries (provider_code, codigo_os)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_logistics_deliveries_external_id
    ON logistics_deliveries (external_delivery_id)
    WHERE external_delivery_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_logistics_deliveries_status
    ON logistics_deliveries (status_canonico)
  `);
  console.log('✅ [logistics/backfill] índices verificados');
}

/**
 * Orquestra a migration completa da Fase 2.
 * Chamado pelo index.js (initLogisticsBackfill) e pelo endpoint de resync.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{copiadas, ja_existiam, total_origem}>}
 */
async function initLogisticsBackfill(pool) {
  console.log('🔄 [logistics/backfill] iniciando backfill Fase 2...');
  await garantirColunaRegraId(pool);
  await criarIndices(pool);
  const resultado = await backfillDeliveries(pool);
  console.log('✅ [logistics/backfill] concluído');
  return resultado;
}

module.exports = {
  initLogisticsBackfill,
  backfillDeliveries,
  criarIndices,
  garantirColunaRegraId,
  UBER_STATUS_TO_CANONICAL,
};
