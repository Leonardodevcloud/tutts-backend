'use strict';

async function initConfirmaFacilTables(pool) {

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmafacil_embarcadores (
      id                   SERIAL PRIMARY KEY,
      config_id            INT NOT NULL REFERENCES confirmafacil_config(id) ON DELETE CASCADE,
      cnpj_embarcador      VARCHAR(20) NOT NULL,
      nome_embarcador      VARCHAR(255),
      coleta_rua           VARCHAR(500),
      coleta_numero        VARCHAR(50),
      coleta_bairro        VARCHAR(255),
      coleta_cidade        VARCHAR(255),
      coleta_uf            VARCHAR(2),
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

  await pool.query(`ALTER TABLE confirmafacil_embarcadores
    ADD COLUMN IF NOT EXISTS centro_custo_mapp VARCHAR(100)`).catch(() => {});

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

  // Cache de NFs do CF — evita chamar a API CF a cada busca
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmafacil_nfs_cache (
      id                   SERIAL PRIMARY KEY,
      cliente_id           INT NOT NULL,
      id_embarque          BIGINT NOT NULL,
      numero_nf            VARCHAR(100),
      serie_nf             VARCHAR(20),
      chave_nfe            VARCHAR(100),
      cnpj_embarcador      VARCHAR(20),
      nome_embarcador      VARCHAR(255),
      destinatario_nome    VARCHAR(255),
      destinatario_cnpj    VARCHAR(20),
      destinatario_cidade  VARCHAR(100),
      destinatario_uf      VARCHAR(2),
      destinatario_end     VARCHAR(500),
      status_cf            VARCHAR(50),
      status_nota          VARCHAR(50),
      dias_atraso          INT DEFAULT 0,
      data_previsao        TIMESTAMP,
      data_emissao         TIMESTAMP,
      valor                DECIMAL(12,2),
      tipo_envio           VARCHAR(50),
      tipo_frete           VARCHAR(50),
      link_rastreamento    TEXT,
      payload_completo     JSONB,
      sincronizado_em      TIMESTAMP DEFAULT NOW(),
      UNIQUE (cliente_id, id_embarque)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_cache_cliente    ON confirmafacil_nfs_cache (cliente_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_cache_status     ON confirmafacil_nfs_cache (status_cf)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_cache_embarque   ON confirmafacil_nfs_cache (id_embarque)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_cache_previsao   ON confirmafacil_nfs_cache (data_previsao)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_log_solicitacao  ON confirmafacil_log      (solicitacao_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_vinculos_embarque ON confirmafacil_vinculos (id_embarque)`).catch(() => {});

  console.log('✅ [confirmafacil] tabelas verificadas');
}

module.exports = { initConfirmaFacilTables };
