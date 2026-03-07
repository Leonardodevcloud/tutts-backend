/**
 * MÓDULO ANTI-FRAUDE - Migration
 * Tabelas: antifraude_varreduras, antifraude_os_dados, antifraude_alertas, antifraude_config
 */

async function initAntiFraudeTables(pool) {
  console.log('🔧 Anti-Fraude Migration — criando tabelas...');

  // Configurações do módulo (janela de tempo, thresholds, cron ativo)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS antifraude_config (
      id         SERIAL PRIMARY KEY,
      chave      VARCHAR(100) UNIQUE NOT NULL,
      valor      TEXT NOT NULL,
      descricao  TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Inserir configs padrão (só se não existirem)
  const configsPadrao = [
    { chave: 'janela_dias', valor: '7', descricao: 'Janela de tempo em dias para considerar duplicata' },
    { chave: 'cron_ativo', valor: 'true', descricao: 'Se o cron automático está ativo' },
    { chave: 'cron_intervalo_min', valor: '60', descricao: 'Intervalo do cron em minutos' },
    { chave: 'max_paginas_concluidos', valor: '3', descricao: 'Quantas páginas de concluídos varrer por execução' },
    { chave: 'threshold_reincidente', valor: '3', descricao: 'Quantidade de duplicatas para marcar como reincidente' },
  ];

  for (const cfg of configsPadrao) {
    await pool.query(
      `INSERT INTO antifraude_config (chave, valor, descricao)
       VALUES ($1, $2, $3)
       ON CONFLICT (chave) DO NOTHING`,
      [cfg.chave, cfg.valor, cfg.descricao]
    );
  }

  // Log de varreduras executadas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS antifraude_varreduras (
      id              SERIAL PRIMARY KEY,
      tipo            VARCHAR(20) NOT NULL DEFAULT 'manual',
      status          VARCHAR(20) NOT NULL DEFAULT 'executando',
      os_analisadas   INTEGER DEFAULT 0,
      alertas_gerados INTEGER DEFAULT 0,
      detalhes        TEXT,
      erro            TEXT,
      iniciado_em     TIMESTAMP DEFAULT NOW(),
      finalizado_em   TIMESTAMP,
      iniciado_por    VARCHAR(100)
    )
  `);

  // Dados extraídos das OSs pelo Playwright
  await pool.query(`
    CREATE TABLE IF NOT EXISTS antifraude_os_dados (
      id                 SERIAL PRIMARY KEY,
      os_codigo          VARCHAR(20) NOT NULL,
      numero_pedido_nf   VARCHAR(100),
      solicitante_cod    VARCHAR(20),
      solicitante_nome   VARCHAR(200),
      profissional_cod   VARCHAR(20),
      profissional_nome  VARCHAR(200),
      categoria          VARCHAR(100),
      centro_custo       VARCHAR(100),
      status_os          VARCHAR(30),
      data_solicitacao   TIMESTAMP,
      valor_servico      DECIMAL(10,2),
      valor_profissional DECIMAL(10,2),
      pontos_dados       JSONB,
      varredura_id       INTEGER REFERENCES antifraude_varreduras(id),
      extraido_em        TIMESTAMP DEFAULT NOW(),
      UNIQUE(os_codigo, numero_pedido_nf)
    )
  `);

  // Alertas de fraude detectados
  await pool.query(`
    CREATE TABLE IF NOT EXISTS antifraude_alertas (
      id                  SERIAL PRIMARY KEY,
      tipo                VARCHAR(50) NOT NULL,
      severidade          VARCHAR(20) NOT NULL DEFAULT 'media',
      titulo              TEXT NOT NULL,
      descricao           TEXT,
      os_codigos          TEXT[],
      numeros_nf          TEXT[],
      profissional_cod    VARCHAR(20),
      profissional_nome   VARCHAR(200),
      solicitante_cod     VARCHAR(20),
      solicitante_nome    VARCHAR(200),
      dados_evidencia     JSONB,
      status              VARCHAR(20) NOT NULL DEFAULT 'pendente',
      analisado_por       VARCHAR(100),
      analisado_em        TIMESTAMP,
      observacao_analise  TEXT,
      varredura_id        INTEGER REFERENCES antifraude_varreduras(id),
      created_at          TIMESTAMP DEFAULT NOW()
    )
  `);

  // Colunas incrementais (seguro para re-run)
  const colunasExtras = [
    { tabela: 'antifraude_varreduras', nome: 'tipo', tipo: "VARCHAR(20) DEFAULT 'manual'" },
    { tabela: 'antifraude_alertas', nome: 'severidade', tipo: "VARCHAR(20) DEFAULT 'media'" },
  ];

  for (const col of colunasExtras) {
    try {
      await pool.query(`ALTER TABLE ${col.tabela} ADD COLUMN IF NOT EXISTS ${col.nome} ${col.tipo}`);
    } catch (err) {
      // Ignora se já existe
    }
  }

  // Índices
  const indices = [
    'CREATE INDEX IF NOT EXISTS idx_af_os_dados_os ON antifraude_os_dados(os_codigo)',
    'CREATE INDEX IF NOT EXISTS idx_af_os_dados_nf ON antifraude_os_dados(numero_pedido_nf)',
    'CREATE INDEX IF NOT EXISTS idx_af_os_dados_prof ON antifraude_os_dados(profissional_cod)',
    'CREATE INDEX IF NOT EXISTS idx_af_os_dados_solic ON antifraude_os_dados(solicitante_cod)',
    'CREATE INDEX IF NOT EXISTS idx_af_alertas_status ON antifraude_alertas(status)',
    'CREATE INDEX IF NOT EXISTS idx_af_alertas_tipo ON antifraude_alertas(tipo)',
    'CREATE INDEX IF NOT EXISTS idx_af_alertas_prof ON antifraude_alertas(profissional_cod)',
    'CREATE INDEX IF NOT EXISTS idx_af_alertas_created ON antifraude_alertas(created_at DESC)',
  ];

  for (const idx of indices) {
    try { await pool.query(idx); } catch (err) { /* ignora */ }
  }

  console.log('✅ Módulo Anti-Fraude — tabelas verificadas/criadas');
}

module.exports = { initAntiFraudeTables };
