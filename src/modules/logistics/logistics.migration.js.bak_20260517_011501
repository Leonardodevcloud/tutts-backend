/**
 * MÓDULO LOGISTICS — Migration
 *
 * Cria as 7 tabelas do hub multi-provider e faz backfill dos dados existentes
 * do módulo Uber legado (sem dropar nada — tabelas uber_* continuam intactas).
 *
 * Todas as operações são idempotentes:
 *  - CREATE TABLE IF NOT EXISTS
 *  - ALTER TABLE ADD COLUMN IF NOT EXISTS
 *  - INSERT … ON CONFLICT DO NOTHING
 *  - Backfill verifica se tabela uber_* existe antes de tentar copiar
 *
 * Pode ser executada N vezes sem efeitos colaterais.
 *
 * Fase 0 do plano: cria infra, não ativa nada.
 *  - logistics_providers tem 1 linha 'uber' (espelho de uber_config) com ativo=false
 *  - logistics_worker_state tem 1 linha 'mapp_polling' com ativo=false
 *  - logistics_deliveries / logistics_events / logistics_tracking começam vazios
 *    (backfill de uber_entregas será feito sob demanda na Fase 1, depois que
 *    UberAdapter estiver consumindo o core — não vale a pena copiar histórico
 *    de uma vez se o esquema ainda pode ajustar)
 */

const { CANONICAL_STATUS_VALUES } = require('./contracts/CanonicalStatus');

async function initLogisticsTables(pool) {
  // ──────────────────────────────────────────────────────────────────
  // 1. logistics_providers — registro dos parceiros logísticos
  // ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_providers (
      id              SERIAL PRIMARY KEY,
      provider_code   VARCHAR(32) UNIQUE NOT NULL,
      display_name    VARCHAR(120) NOT NULL,
      ativo           BOOLEAN DEFAULT false,
      sandbox_mode    BOOLEAN DEFAULT false,
      prioridade      INTEGER DEFAULT 100,
      config          JSONB NOT NULL DEFAULT '{}',
      capabilities    JSONB NOT NULL DEFAULT '{}',
      webhook_secret  TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ [logistics] tabela logistics_providers verificada');

  // ──────────────────────────────────────────────────────────────────
  // 2. logistics_deliveries — entregas (substitui uber_entregas)
  // ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_deliveries (
      id                      SERIAL PRIMARY KEY,
      codigo_os               INTEGER NOT NULL,
      provider_code           VARCHAR(32) NOT NULL,
      external_delivery_id    VARCHAR(255),
      external_quote_id       VARCHAR(255),
      status_canonico         VARCHAR(40) NOT NULL DEFAULT 'PENDING',
      status_native           VARCHAR(80),
      valor_servico           DECIMAL(10,2),
      valor_provider          DECIMAL(10,2),
      valor_profissional      DECIMAL(10,2),
      eta_minutos             INTEGER,
      vehicle_type            VARCHAR(40),
      courier_data            JSONB,
      endereco_coleta         TEXT,
      endereco_entrega        TEXT,
      latitude_coleta         DECIMAL(10,7),
      longitude_coleta        DECIMAL(10,7),
      latitude_entrega        DECIMAL(10,7),
      longitude_entrega       DECIMAL(10,7),
      pontos                  JSONB DEFAULT '[]',
      obs                     TEXT,
      tracking_url            TEXT,
      raw_provider_payload    JSONB,
      regra_id                INTEGER,
      id_motoboy_mapp         INTEGER,
      tentativas              INTEGER DEFAULT 0,
      erro_ultimo             TEXT,
      finalizado_at           TIMESTAMPTZ,
      cancelado_por           VARCHAR(50),
      cancelado_motivo        TEXT,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ [logistics] tabela logistics_deliveries verificada');

  // FK provider_code → logistics_providers.provider_code (validação na app, não no DB,
  // pra permitir que um provider seja removido sem cascata destruir histórico de entregas)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logdelivery_os ON logistics_deliveries (codigo_os)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logdelivery_extid ON logistics_deliveries (external_delivery_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logdelivery_provstatus ON logistics_deliveries (provider_code, status_canonico)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logdelivery_created ON logistics_deliveries (created_at DESC)`).catch(() => {});

  // ──────────────────────────────────────────────────────────────────
  // 3. logistics_events — auditoria/eventos centralizados
  // ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_events (
      id                    BIGSERIAL PRIMARY KEY,
      provider_code         VARCHAR(32) NOT NULL,
      delivery_id           INTEGER,
      codigo_os             INTEGER,
      external_delivery_id  VARCHAR(255),
      event_type            VARCHAR(60) NOT NULL,
      event_source          VARCHAR(40) DEFAULT 'system',
      status_canonico       VARCHAR(40),
      status_native         VARCHAR(80),
      payload               JSONB,
      erro                  TEXT,
      processado            BOOLEAN DEFAULT true,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ [logistics] tabela logistics_events verificada');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logevt_delivery ON logistics_events (delivery_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logevt_provtype ON logistics_events (provider_code, event_type)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logevt_created ON logistics_events (created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logevt_extid ON logistics_events (external_delivery_id)`).catch(() => {});

  // ──────────────────────────────────────────────────────────────────
  // 4. logistics_tracking — posições do entregador
  // ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_tracking (
      id                    BIGSERIAL PRIMARY KEY,
      provider_code         VARCHAR(32) NOT NULL,
      delivery_id           INTEGER,
      codigo_os             INTEGER,
      external_delivery_id  VARCHAR(255),
      latitude              DECIMAL(10,7),
      longitude             DECIMAL(10,7),
      status_native         VARCHAR(80),
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ [logistics] tabela logistics_tracking verificada');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logtrk_delivery ON logistics_tracking (delivery_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logtrk_os ON logistics_tracking (codigo_os)`).catch(() => {});

  // ──────────────────────────────────────────────────────────────────
  // 5. logistics_oauth_tokens — tokens OAuth (Uber, futuros)
  // ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_oauth_tokens (
      id              SERIAL PRIMARY KEY,
      provider_code   VARCHAR(32) NOT NULL,
      access_token    TEXT NOT NULL,
      refresh_token   TEXT,
      scope           VARCHAR(255),
      expires_at      TIMESTAMPTZ NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ [logistics] tabela logistics_oauth_tokens verificada');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_logoauth_prov_exp ON logistics_oauth_tokens (provider_code, expires_at DESC)`).catch(() => {});

  // ──────────────────────────────────────────────────────────────────
  // 6. logistics_dispatch_rules — regras (substitui uber_regras_cliente)
  // ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_dispatch_rules (
      id                      SERIAL PRIMARY KEY,
      cliente_nome            VARCHAR(255) NOT NULL,
      trecho_endereco         TEXT,
      cliente_identificador   VARCHAR(255),
      ativo                   BOOLEAN DEFAULT true,
      estrategia              VARCHAR(40) DEFAULT 'provider_unico',
      providers_preferidos    VARCHAR(32)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(32)[],
      horario_inicio          TIME,
      horario_fim             TIME,
      valor_minimo            DECIMAL(10,2),
      valor_maximo            DECIMAL(10,2),
      regioes_permitidas      TEXT[],
      margem_minima_aceita    DECIMAL(10,2),
      margem_pct_minima       DECIMAL(5,2),
      vehicle_type_preferido  VARCHAR(40),
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ [logistics] tabela logistics_dispatch_rules verificada');

  // ──────────────────────────────────────────────────────────────────
  // 7. logistics_worker_state — cursor de polling do worker
  // ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_worker_state (
      id                  SERIAL PRIMARY KEY,
      worker_name         VARCHAR(64) UNIQUE NOT NULL DEFAULT 'mapp_polling',
      ultimo_id_mapp      INTEGER DEFAULT 0,
      janela_minutos      INTEGER DEFAULT 30,
      intervalo_segundos  INTEGER DEFAULT 30,
      ativo               BOOLEAN DEFAULT false,
      auto_despacho       BOOLEAN DEFAULT false,
      ultimo_ciclo_em     TIMESTAMPTZ,
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✅ [logistics] tabela logistics_worker_state verificada');

  // Garante linha default
  await pool.query(`
    INSERT INTO logistics_worker_state (worker_name, ativo, auto_despacho)
    VALUES ('mapp_polling', false, false)
    ON CONFLICT (worker_name) DO NOTHING
  `);

  // ──────────────────────────────────────────────────────────────────
  // BACKFILL: Uber config → logistics_providers
  // ──────────────────────────────────────────────────────────────────
  // Espelha uber_config (se existir) como provider 'uber'. Idempotente —
  // ON CONFLICT DO NOTHING significa que rodar de novo não sobrescreve config.
  // Para refazer manualmente: DELETE FROM logistics_providers WHERE provider_code='uber';
  // e rodar a migration de novo.
  try {
    const { rows: hasUberConfig } = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'uber_config'
      ) AS exists
    `);

    if (hasUberConfig[0]?.exists) {
      const { rowCount } = await pool.query(`
        INSERT INTO logistics_providers (
          provider_code, display_name, ativo, sandbox_mode, prioridade, config, capabilities, webhook_secret
        )
        SELECT
          'uber',
          'Uber Direct',
          false,  -- IMPORTANTE: começa desativado, ativação manual via PUT /providers/uber/config
          COALESCE(sandbox_mode, false),
          10,
          jsonb_build_object(
            'client_id',                      client_id,
            'client_secret',                  client_secret,
            'customer_id',                    customer_id,
            'mapp_api_url',                   mapp_api_url,
            'mapp_api_token',                 mapp_api_token,
            'telefone_suporte',               telefone_suporte,
            'manifest_total_value_centavos',  COALESCE(manifest_total_value_centavos, 10000),
            'polling_intervalo_seg',          COALESCE(polling_intervalo_seg, 30),
            'timeout_sem_entregador_min',     COALESCE(timeout_sem_entregador_min, 10),
            'worker_janela_minutos',          30
          ),
          jsonb_build_object(
            'supportsQuote',            true,
            'supportsCancel',           true,
            'supportsRedispatch',       true,
            'supportsRealtimeTracking', true,
            'vehicleTypes',             jsonb_build_array('motorcycle','car'),
            'coverageRegion',           jsonb_build_array('BR'),
            'webhookAuthScheme',        'hmac-sha256',
            'requiresExternalRefAsString', false
          ),
          webhook_secret
        FROM uber_config
        WHERE id = 1
        ON CONFLICT (provider_code) DO NOTHING
      `);

      if (rowCount > 0) {
        console.log('✅ [logistics] backfill: uber_config → logistics_providers (1 linha criada, ativo=false)');
      } else {
        console.log('ℹ️  [logistics] backfill: logistics_providers já tem registro \'uber\', mantido como está');
      }
    } else {
      console.log('ℹ️  [logistics] backfill: uber_config não existe — pulando (instalação nova)');
    }
  } catch (err) {
    console.error('⚠️  [logistics] erro no backfill uber_config:', err.message);
  }

  // ──────────────────────────────────────────────────────────────────
  // BACKFILL: uber_config.worker_ultimo_id → logistics_worker_state
  // ──────────────────────────────────────────────────────────────────
  try {
    const { rows: hasWorkerCols } = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'uber_config'
          AND column_name = 'worker_ultimo_id'
      ) AS exists
    `);

    if (hasWorkerCols[0]?.exists) {
      await pool.query(`
        UPDATE logistics_worker_state lw
        SET
          ultimo_id_mapp     = COALESCE(uc.worker_ultimo_id, lw.ultimo_id_mapp),
          janela_minutos     = COALESCE(uc.worker_janela_minutos, lw.janela_minutos),
          intervalo_segundos = COALESCE(uc.polling_intervalo_seg, lw.intervalo_segundos),
          updated_at         = NOW()
        FROM uber_config uc
        WHERE lw.worker_name = 'mapp_polling' AND uc.id = 1
          AND lw.ultimo_id_mapp = 0  -- só sobrescreve se ainda não foi inicializado
      `);
      console.log('ℹ️  [logistics] backfill: cursor do worker copiado de uber_config (se aplicável)');
    }
  } catch (err) {
    console.error('⚠️  [logistics] erro no backfill worker_state:', err.message);
  }

  // ──────────────────────────────────────────────────────────────────
  // BACKFILL: uber_regras_cliente → logistics_dispatch_rules
  // ──────────────────────────────────────────────────────────────────
  // Cada regra Uber vira uma regra logística com providers_preferidos=['uber'].
  // Idempotente: só insere regras que ainda não existem (match por cliente_nome + trecho_endereco).
  try {
    const { rows: hasUberRules } = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'uber_regras_cliente'
      ) AS exists
    `);

    if (hasUberRules[0]?.exists) {
      const { rowCount } = await pool.query(`
        INSERT INTO logistics_dispatch_rules (
          cliente_nome, trecho_endereco, cliente_identificador, ativo,
          estrategia, providers_preferidos,
          horario_inicio, horario_fim, valor_minimo, valor_maximo,
          regioes_permitidas, margem_minima_aceita, margem_pct_minima
        )
        SELECT
          urc.cliente_nome,
          COALESCE(urc.trecho_endereco, urc.cliente_nome),
          urc.cliente_identificador,
          urc.ativo,
          'provider_unico',
          ARRAY['uber']::VARCHAR(32)[],
          urc.horario_inicio,
          urc.horario_fim,
          urc.valor_minimo,
          urc.valor_maximo,
          urc.regioes_permitidas,
          urc.margem_minima_aceita,
          urc.margem_pct_minima
        FROM uber_regras_cliente urc
        WHERE NOT EXISTS (
          SELECT 1 FROM logistics_dispatch_rules ldr
          WHERE ldr.cliente_nome = urc.cliente_nome
            AND COALESCE(ldr.trecho_endereco, '') = COALESCE(urc.trecho_endereco, urc.cliente_nome, '')
        )
      `);

      if (rowCount > 0) {
        console.log(`✅ [logistics] backfill: ${rowCount} regra(s) copiada(s) de uber_regras_cliente → logistics_dispatch_rules`);
      } else {
        console.log('ℹ️  [logistics] backfill: regras já espelhadas em logistics_dispatch_rules');
      }
    }
  } catch (err) {
    console.error('⚠️  [logistics] erro no backfill regras:', err.message);
  }

  // ──────────────────────────────────────────────────────────────────
  // BACKFILL: uber_oauth_token → logistics_oauth_tokens
  // ──────────────────────────────────────────────────────────────────
  try {
    const { rows: hasUberToken } = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'uber_oauth_token'
      ) AS exists
    `);

    if (hasUberToken[0]?.exists) {
      // Copia só tokens AINDA válidos (expires_at > now), pra evitar lixo
      const { rowCount } = await pool.query(`
        INSERT INTO logistics_oauth_tokens (provider_code, access_token, expires_at, created_at)
        SELECT 'uber', access_token, expires_at, COALESCE(created_at, NOW())
        FROM uber_oauth_token
        WHERE expires_at > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM logistics_oauth_tokens lot
            WHERE lot.provider_code = 'uber' AND lot.access_token = uber_oauth_token.access_token
          )
      `);
      if (rowCount > 0) {
        console.log(`✅ [logistics] backfill: ${rowCount} token OAuth Uber válido copiado`);
      }
    }
  } catch (err) {
    console.error('⚠️  [logistics] erro no backfill oauth_token:', err.message);
  }

  // ──────────────────────────────────────────────────────────────────
  // Sanity check final
  // ──────────────────────────────────────────────────────────────────
  // Confere que CanonicalStatus está alinhado com o enum tácito da coluna
  // (a coluna status_canonico é VARCHAR(40) sem CHECK constraint, mas log
  // se algum valor canônico definido em código não couber).
  for (const status of CANONICAL_STATUS_VALUES) {
    if (status.length > 40) {
      console.error(`❌ [logistics] CanonicalStatus '${status}' tem ${status.length} chars — excede VARCHAR(40)`);
    }
  }

  console.log('🎯 [logistics] migration Fase 0 concluída');
}

module.exports = { initLogisticsTables };
