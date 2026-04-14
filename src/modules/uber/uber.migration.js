/**
 * MÓDULO UBER - Migration
 * Tabelas: uber_config, uber_entregas, uber_webhooks_log, uber_tracking
 */

async function initUberTables(pool) {

  // ─── Configuração global do Uber Direct ───────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uber_config (
      id SERIAL PRIMARY KEY,
      ativo BOOLEAN DEFAULT false,
      client_id VARCHAR(255),
      client_secret VARCHAR(500),
      customer_id VARCHAR(255),
      webhook_secret VARCHAR(255),
      mapp_api_url VARCHAR(500),
      mapp_api_token VARCHAR(255),
      polling_intervalo_seg INTEGER DEFAULT 30,
      auto_despacho BOOLEAN DEFAULT false,
      timeout_sem_entregador_min INTEGER DEFAULT 10,
      telefone_suporte VARCHAR(20),
      manifest_total_value_centavos INTEGER DEFAULT 10000,
      sandbox_mode BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela uber_config verificada');

  // Migrations idempotentes — adiciona colunas se não existirem (instalações antigas)
  await pool.query(`ALTER TABLE uber_config ADD COLUMN IF NOT EXISTS telefone_suporte VARCHAR(20)`).catch(() => {});
  await pool.query(`ALTER TABLE uber_config ADD COLUMN IF NOT EXISTS manifest_total_value_centavos INTEGER DEFAULT 10000`).catch(() => {});
  await pool.query(`ALTER TABLE uber_config ADD COLUMN IF NOT EXISTS sandbox_mode BOOLEAN DEFAULT false`).catch(() => {});

  // Garantir que existe pelo menos uma linha de config
  await pool.query(`
    INSERT INTO uber_config (id, ativo)
    VALUES (1, false)
    ON CONFLICT (id) DO NOTHING
  `);

  // ─── Regras por cliente (quando despachar pro Uber) ───────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uber_regras_cliente (
      id SERIAL PRIMARY KEY,
      cliente_nome VARCHAR(255) NOT NULL,
      cliente_identificador VARCHAR(255),
      usar_uber BOOLEAN DEFAULT true,
      prioridade VARCHAR(20) DEFAULT 'uber_primeiro',
      horario_inicio TIME,
      horario_fim TIME,
      valor_minimo DECIMAL(10,2),
      valor_maximo DECIMAL(10,2),
      regioes_permitidas TEXT[],
      ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela uber_regras_cliente verificada');

  // ─── De-para: codigoOS (Mapp) ↔ delivery_id (Uber) ───────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uber_entregas (
      id SERIAL PRIMARY KEY,
      codigo_os INTEGER NOT NULL,
      uber_delivery_id VARCHAR(255),
      uber_quote_id VARCHAR(255),
      status_mapp VARCHAR(20) DEFAULT '0',
      status_uber VARCHAR(50) DEFAULT 'pending',
      valor_servico DECIMAL(10,2),
      valor_profissional DECIMAL(10,2),
      valor_uber DECIMAL(10,2),
      eta_minutos INTEGER,
      entregador_nome VARCHAR(255),
      entregador_telefone VARCHAR(50),
      entregador_placa VARCHAR(20),
      entregador_veiculo VARCHAR(255),
      entregador_documento VARCHAR(20),
      entregador_foto VARCHAR(500),
      entregador_rating VARCHAR(10),
      id_motoboy_mapp INTEGER,
      endereco_coleta TEXT,
      endereco_entrega TEXT,
      latitude_coleta DECIMAL(10,7),
      longitude_coleta DECIMAL(10,7),
      latitude_entrega DECIMAL(10,7),
      longitude_entrega DECIMAL(10,7),
      obs TEXT,
      pontos JSONB DEFAULT '[]',
      tentativas INTEGER DEFAULT 0,
      erro_ultimo TEXT,
      cancelado_por VARCHAR(50),
      cancelado_motivo TEXT,
      finalizado_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela uber_entregas verificada');

  // ─── Migrations idempotentes em colunas adicionadas após o create inicial ──
  // tracking_url: link público de rastreio do Uber Direct
  await pool.query(`
    ALTER TABLE uber_entregas ADD COLUMN IF NOT EXISTS tracking_url TEXT
  `).catch(() => {});

  // Índices para consultas frequentes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uber_entregas_codigo_os ON uber_entregas (codigo_os)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uber_entregas_delivery_id ON uber_entregas (uber_delivery_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uber_entregas_status ON uber_entregas (status_uber)`).catch(() => {});

  // ─── Log de webhooks recebidos (auditoria) ────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uber_webhooks_log (
      id SERIAL PRIMARY KEY,
      tipo VARCHAR(50),
      delivery_id VARCHAR(255),
      codigo_os INTEGER,
      payload JSONB,
      processado BOOLEAN DEFAULT false,
      erro TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela uber_webhooks_log verificada');

  // Índice para busca por delivery_id
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uber_webhooks_delivery ON uber_webhooks_log (delivery_id)`).catch(() => {});

  // ─── Histórico de posições do entregador (tracking) ───────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uber_tracking (
      id SERIAL PRIMARY KEY,
      codigo_os INTEGER NOT NULL,
      uber_delivery_id VARCHAR(255),
      latitude DECIMAL(10,7),
      longitude DECIMAL(10,7),
      status_uber VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela uber_tracking verificada');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uber_tracking_os ON uber_tracking (codigo_os)`).catch(() => {});

  // ─── Token OAuth2 cacheado ────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uber_oauth_token (
      id SERIAL PRIMARY KEY,
      access_token TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela uber_oauth_token verificada');
}

module.exports = { initUberTables };
