// ============================================================
// MÓDULO SCORE/GAMIFICAÇÃO - MIGRATION (Criação de Tabelas)
// Extraído de server.js (linhas 2905-3028)
// ============================================================

/**
 * Cria/verifica todas as tabelas do módulo Score
 * Chamado durante a inicialização do servidor
 * @param {object} pool - Pool de conexão PostgreSQL
 */
async function initScoreTables(pool) {
  console.log('📊 Inicializando tabelas do módulo Score...');

  // Histórico de pontos (extrato detalhado)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_historico (
      id SERIAL PRIMARY KEY,
      cod_prof INTEGER NOT NULL,
      nome_prof VARCHAR(255),
      os VARCHAR(50) NOT NULL,
      data_os DATE NOT NULL,
      hora_solicitacao TIME,
      tempo_entrega_minutos INTEGER,
      prazo_minutos INTEGER,
      ponto_prazo DECIMAL(5,2) DEFAULT 0,
      ponto_bonus_janela DECIMAL(5,2) DEFAULT 0,
      ponto_total DECIMAL(5,2) DEFAULT 0,
      dentro_prazo BOOLEAN DEFAULT FALSE,
      janela_bonus VARCHAR(20),
      detalhamento TEXT,
      distancia_km DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(cod_prof, os)
    )
  `);
  console.log('  ✅ score_historico');

  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_hist_prof ON score_historico(cod_prof)').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_hist_data ON score_historico(data_os)').catch(() => {});

  // Totais por profissional (cache para performance)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_totais (
      id SERIAL PRIMARY KEY,
      cod_prof INTEGER UNIQUE NOT NULL,
      nome_prof VARCHAR(255),
      score_total DECIMAL(10,2) DEFAULT 0,
      total_os INTEGER DEFAULT 0,
      os_no_prazo INTEGER DEFAULT 0,
      os_fora_prazo INTEGER DEFAULT 0,
      bonus_janela_total DECIMAL(10,2) DEFAULT 0,
      ultimo_calculo TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('  ✅ score_totais');

  // Milestones/benefícios do clube
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_milestones (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL,
      descricao TEXT,
      pontos_necessarios INTEGER NOT NULL,
      icone VARCHAR(50) DEFAULT '🏆',
      cor VARCHAR(20) DEFAULT '#7c3aed',
      beneficio TEXT,
      ativo BOOLEAN DEFAULT TRUE,
      ordem INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('  ✅ score_milestones');

  // Conquistas por profissional
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_conquistas (
      id SERIAL PRIMARY KEY,
      cod_prof INTEGER NOT NULL,
      milestone_id INTEGER REFERENCES score_milestones(id),
      conquistado_em TIMESTAMP DEFAULT NOW(),
      notificado BOOLEAN DEFAULT FALSE,
      UNIQUE(cod_prof, milestone_id)
    )
  `);
  console.log('  ✅ score_conquistas');

  // Inserir milestones padrão se não existirem
  const milestonesCount = await pool.query('SELECT COUNT(*) FROM score_milestones');
  if (parseInt(milestonesCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO score_milestones (nome, descricao, pontos_necessarios, icone, cor, beneficio, ordem) VALUES
      ('Bronze', '2 saques gratuitos de R$500/mês', 80, '🥉', '#cd7f32', '2 saques gratuitos de R$500 por mês', 1),
      ('Prata', '+2 saques gratuitos/mês (total: 4)', 100, '🥈', '#c0c0c0', '+2 saques gratuitos de R$500 por mês (total: 4)', 2),
      ('Ouro', '1 Camisa Tutts', 250, '🥇', '#ffd700', '1 Camisa Tutts (Retirada única)', 3),
      ('Platina', '1 Óleo de motor', 300, '💎', '#e5e4e2', '1 Óleo de motor (Retirada única)', 4),
      ('Diamante', 'Sorteio Vale Combustível', 500, '👑', '#b9f2ff', 'Participação em sorteio de Vale Combustível R$100 por mês', 5)
    `);
    console.log('  ✅ Milestones padrão inseridos');
  }

  // Controle de gratuidades mensais
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_gratuidades (
      id SERIAL PRIMARY KEY,
      cod_prof INTEGER NOT NULL,
      nome_prof VARCHAR(255),
      mes_referencia VARCHAR(7) NOT NULL,
      score_no_momento DECIMAL(10,2),
      nivel VARCHAR(50),
      quantidade_saques INTEGER DEFAULT 0,
      gratuidade_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(cod_prof, mes_referencia)
    )
  `);
  console.log('  ✅ score_gratuidades');

  // Prêmios físicos (Camisa, Óleo, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_premios_fisicos (
      id SERIAL PRIMARY KEY,
      cod_prof INTEGER NOT NULL,
      nome_prof VARCHAR(255),
      milestone_id INTEGER REFERENCES score_milestones(id),
      tipo_premio VARCHAR(100) NOT NULL,
      status VARCHAR(50) DEFAULT 'disponivel',
      confirmado_por VARCHAR(255),
      confirmado_em TIMESTAMP,
      observacao TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(cod_prof, milestone_id)
    )
  `);
  console.log('  ✅ score_premios_fisicos');

  console.log('📊 Módulo Score inicializado com sucesso!');
}

module.exports = initScoreTables;
