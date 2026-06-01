/**
 * MÓDULO FILAS - Migration
 * Tabelas: filas_centrais, filas_vinculos, filas_posicoes, filas_historico, filas_notificacoes
 */

async function initFilasTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_centrais (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      endereco TEXT,
      latitude DECIMAL(10,7),
      longitude DECIMAL(10,7),
      raio_metros INTEGER DEFAULT 900,
      ativa BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_centrais verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_vinculos (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) UNIQUE NOT NULL,
      nome_profissional VARCHAR(255),
      ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_vinculos verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_posicoes (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      status VARCHAR(20) DEFAULT 'aguardando',
      posicao INTEGER,
      entrada_fila_at TIMESTAMP DEFAULT NOW(),
      saida_rota_at TIMESTAMP,
      retorno_at TIMESTAMP,
      latitude_checkin DECIMAL(10,7),
      longitude_checkin DECIMAL(10,7),
      corrida_unica BOOLEAN DEFAULT false,
      posicao_original INTEGER,
      motivo_posicao VARCHAR(50),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_posicoes verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_historico (
      id SERIAL PRIMARY KEY,
      central_id INTEGER,
      central_nome VARCHAR(255),
      cod_profissional VARCHAR(50),
      nome_profissional VARCHAR(255),
      acao VARCHAR(50),
      tempo_espera_minutos INTEGER,
      tempo_rota_minutos INTEGER,
      observacao TEXT,
      admin_cod VARCHAR(50),
      admin_nome VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_historico verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_notificacoes (
      id SERIAL PRIMARY KEY,
      cod_profissional VARCHAR(50) UNIQUE NOT NULL,
      tipo VARCHAR(50),
      mensagem TEXT,
      dados JSONB,
      lida BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela filas_notificacoes verificada');

  // 🔧 Coluna notas_liberadas para despacho gradativo
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS notas_liberadas INTEGER DEFAULT 0`).catch(() => {});
  console.log('✅ Coluna notas_liberadas verificada');

  // 🗺️ Bairros: coluna na posição + tabela de config
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS bairros JSONB DEFAULT '[]'`).catch(() => {});
  console.log('✅ Coluna bairros verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_bairros_config (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      nome VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, nome)
    )
  `);
  console.log('✅ Tabela filas_bairros_config verificada');

  // ==================== V2 ====================

  // ⏱️ Timestamp da primeira nota liberada (cronômetro admin)
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS primeira_nota_at TIMESTAMP`).catch(() => {});
  console.log('✅ Coluna primeira_nota_at verificada');

  // 🚫 Tabela de penalidades por saída voluntária
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_penalidades (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(255),
      saidas_hoje INTEGER DEFAULT 0,
      bloqueado_ate TIMESTAMP,
      anulado_por VARCHAR(50),
      anulado_em TIMESTAMP,
      data_ref DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_filas_penalidades_unico 
      ON filas_penalidades (cod_profissional, central_id, data_ref)
  `).catch(() => {});
  // 🆕 2026-05: campos pra distinguir punição automática vs aplicada manualmente pelo admin
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'automatica'`).catch(() => {});
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS motivo_admin TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS aplicado_por_cod VARCHAR(50)`).catch(() => {});
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS aplicado_por_nome VARCHAR(255)`).catch(() => {});
  console.log('✅ Tabela filas_penalidades verificada');

  // 🗺️ Regiões de rotas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_regioes (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      nome VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(central_id, nome)
    )
  `);
  console.log('✅ Tabela filas_regioes verificada');

  // FK regiao_id nos bairros
  await pool.query(`ALTER TABLE filas_bairros_config ADD COLUMN IF NOT EXISTS regiao_id INTEGER REFERENCES filas_regioes(id) ON DELETE SET NULL`).catch(() => {});
  console.log('✅ Coluna regiao_id em filas_bairros_config verificada');

  // 🆕 2026-05: Fila auto-gerenciável
  // Diferencial vs fila atual: motoboys se organizam sozinhos, agente Playwright
  // valida no sistema externo. tipo='gerenciada' (padrão, existente) ou 'auto'.
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'gerenciada'`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS validacao_agente_ativa BOOLEAN DEFAULT true`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS varredura_intervalo_seg INTEGER DEFAULT 30`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS remover_ao_pegar_corrida BOOLEAN DEFAULT true`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS mostrar_nomes_publicos BOOLEAN DEFAULT true`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS penalidade_min INTEGER DEFAULT 10`).catch(() => {});
  // Barreira de horário de ingresso
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS barreira_horario_ativa  BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS barreira_horario_corte  TIME`).catch(() => {});
  // Coluna tipo na tabela penalidades (para diferenciar barreira de saída voluntária)
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS tipo VARCHAR(30) DEFAULT 'automatica'`).catch(() => {});
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS motivo_admin TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS aplicado_por_cod VARCHAR(30)`).catch(() => {});
  await pool.query(`ALTER TABLE filas_penalidades ADD COLUMN IF NOT EXISTS aplicado_por_nome VARCHAR(120)`).catch(() => {});
  console.log('✅ Colunas de fila auto-gerenciável em filas_centrais verificadas');

  // Status do motoboy no agente. Valores possíveis:
  //  'pendente'   — entrou na fila, agente ainda não checou (default ao entrar)
  //  'validado'   — agente confirmou que está sem corrida ativa
  //  'reprovado'  — agente detectou corrida ativa (será removido em seguida)
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS agente_status VARCHAR(20) DEFAULT 'pendente'`).catch(() => {});
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS agente_ultima_validacao_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE filas_posicoes ADD COLUMN IF NOT EXISTS corridas_ativas_count INTEGER DEFAULT 0`).catch(() => {});
  console.log('✅ Colunas de status do agente em filas_posicoes verificadas');

  // Log do agente — auditoria e exibição no monitor admin
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filas_agente_logs (
      id SERIAL PRIMARY KEY,
      central_id INTEGER REFERENCES filas_centrais(id) ON DELETE CASCADE,
      cod_profissional VARCHAR(50),
      nome_profissional VARCHAR(255),
      acao VARCHAR(30),
      motivo TEXT,
      detalhes JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_filas_agente_logs_central_data ON filas_agente_logs(central_id, created_at DESC)`).catch(() => {});
  console.log('✅ Tabela filas_agente_logs verificada');

  // 🆕 2026-05-31: TRAVA DE HORÁRIO DE ABERTURA (fila tradicional/gerenciada)
  // Diferente da barreira_horario (que bloqueia acesso TARDIO, após um corte, na fila auto):
  // esta trava bloqueia o ingresso ANTES do horário e só LIBERA a partir dele.
  // Configurável por central (toggle). Ex.: só libera a fila a partir das 07:30.
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS abertura_horario_ativa BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE filas_centrais ADD COLUMN IF NOT EXISTS abertura_horario       TIME`).catch(() => {});
  console.log('✅ Colunas de trava de horário de abertura verificadas');
}

module.exports = { initFilasTables };
