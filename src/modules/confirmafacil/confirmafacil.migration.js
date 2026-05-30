'use strict';

async function initConfirmaFacilTables(pool) {

  // Config principal por cliente
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmafacil_config (
      id                   SERIAL PRIMARY KEY,
      cliente_id           INT NOT NULL REFERENCES clientes_solicitacao(id) ON DELETE CASCADE,
      ativo                BOOLEAN NOT NULL DEFAULT TRUE,
      cf_email             VARCHAR(255) NOT NULL,
      cf_senha             TEXT NOT NULL,
      cf_id_cliente        INT DEFAULT 320,
      cf_id_produto        INT DEFAULT 1,
      cnpj_transportadora  VARCHAR(20) NOT NULL,
      mapa_ocorrencias     JSONB NOT NULL DEFAULT '{}',
      polling_ativo        BOOLEAN NOT NULL DEFAULT TRUE,
      ultimo_polling       TIMESTAMP,
      criado_em            TIMESTAMP DEFAULT NOW(),
      atualizado_em        TIMESTAMP DEFAULT NOW(),
      UNIQUE (cliente_id)
    )
  `);

  // Embarcadores: cada embarcador tem seu endereço de coleta
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmafacil_embarcadores (
      id                   SERIAL PRIMARY KEY,
      config_id            INT NOT NULL REFERENCES confirmafacil_config(id) ON DELETE CASCADE,
      cnpj_embarcador      VARCHAR(20) NOT NULL,
      nome_embarcador      VARCHAR(255),
      coleta_rua           VARCHAR(500),
      coleta_numero        VARCHAR(50),
      coleta_bairro        VARCHAR(255),
      coleta_cidade        VARCHAR(255) NOT NULL,
      coleta_uf            VARCHAR(2) NOT NULL,
      coleta_cep           VARCHAR(10),
      coleta_lat           DECIMAL(10,7),
      coleta_lng           DECIMAL(10,7),
      coleta_nome_fantasia VARCHAR(255),
      coleta_telefone      VARCHAR(50),
      centro_custo_mapp    VARCHAR(100),
      ativo                BOOLEAN DEFAULT TRUE,
      criado_em            TIMESTAMP DEFAULT NOW(),
      UNIQUE (config_id, cnpj_embarcador)
    )
  `);

  // Log de cada NF processada pelo poller
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmafacil_log (
      id              SERIAL PRIMARY KEY,
      solicitacao_id  INT REFERENCES solicitacoes_corrida(id) ON DELETE SET NULL,
      cliente_id      INT NOT NULL,
      os_numero       VARCHAR(100),
      id_embarque     BIGINT,
      numero_nf       VARCHAR(100),
      serie_nf        VARCHAR(20),
      cnpj_embarcador VARCHAR(20),
      status_tutts    VARCHAR(50),
      cod_ocorrencia  VARCHAR(20),
      tipo            VARCHAR(20) NOT NULL DEFAULT 'ocorrencia',
      payload         JSONB,
      resposta        JSONB,
      sucesso         BOOLEAN DEFAULT FALSE,
      erro_msg        TEXT,
      criado_em       TIMESTAMP DEFAULT NOW()
    )
  `);

  // Vínculo idEmbarque CF ↔ solicitacao_id Tutts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmafacil_vinculos (
      id              SERIAL PRIMARY KEY,
      id_embarque     BIGINT NOT NULL UNIQUE,
      solicitacao_id  INT NOT NULL REFERENCES solicitacoes_corrida(id) ON DELETE CASCADE,
      cliente_id      INT NOT NULL,
      numero_nf       VARCHAR(100),
      serie_nf        VARCHAR(20),
      cnpj_embarcador VARCHAR(20),
      criado_em       TIMESTAMP DEFAULT NOW()
    )
  `);

  // Adiciona centro_custo_mapp se ainda não existir (idempotente para produção)
  await pool.query(`ALTER TABLE confirmafacil_embarcadores
    ADD COLUMN IF NOT EXISTS centro_custo_mapp VARCHAR(100)`).catch(() => {});

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_log_solicitacao   ON confirmafacil_log      (solicitacao_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_log_embarque      ON confirmafacil_log      (id_embarque)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_config_cliente    ON confirmafacil_config   (cliente_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_emb_config        ON confirmafacil_embarcadores (config_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_vinculos_embarque ON confirmafacil_vinculos  (id_embarque)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_vinculos_solic    ON confirmafacil_vinculos  (solicitacao_id)`).catch(() => {});

  console.log('✅ [confirmafacil] tabelas verificadas');
}

module.exports = { initConfirmaFacilTables };
