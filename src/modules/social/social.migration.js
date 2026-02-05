// ============================================================
// MÓDULO SOCIAL - MIGRATION (Criação de Tabelas)
// Extraído de server.js (linhas 2530-2627)
// Inclui: Social (perfis, status, mensagens) + Liderança
// ============================================================

/**
 * Inicializa tabelas do módulo Social
 * @param {object} pool - Pool de conexão PostgreSQL
 */
async function initSocialTables(pool) {
  try {
    // ==================== SOCIAL ====================

    // Tabela de perfis sociais (foto e nome de exibição)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_profiles (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        profile_photo TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_profiles verificada/criada');

    // Tabela de status online dos usuários
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_status (
        id SERIAL PRIMARY KEY,
        user_cod VARCHAR(50) UNIQUE NOT NULL,
        is_online BOOLEAN DEFAULT false,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_status verificada/criada');

    // Tabela de mensagens e reações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_messages (
        id SERIAL PRIMARY KEY,
        from_user_cod VARCHAR(50) NOT NULL,
        from_user_name VARCHAR(255),
        to_user_cod VARCHAR(50) NOT NULL,
        message_type VARCHAR(20) DEFAULT 'message',
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela social_messages verificada/criada');

    // ==================== MENSAGENS DA LIDERANÇA ====================

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lideranca_mensagens (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(255) NOT NULL,
        conteudo TEXT NOT NULL,
        tipo_conteudo VARCHAR(50) DEFAULT 'texto',
        midia_url TEXT,
        midia_tipo VARCHAR(50),
        criado_por_cod VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        criado_por_foto TEXT,
        recorrente BOOLEAN DEFAULT false,
        tipo_recorrencia VARCHAR(50),
        intervalo_recorrencia INT DEFAULT 1,
        proxima_exibicao TIMESTAMP,
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela lideranca_mensagens verificada/criada');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lideranca_visualizacoes (
        id SERIAL PRIMARY KEY,
        mensagem_id INT REFERENCES lideranca_mensagens(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        user_nome VARCHAR(255),
        user_foto TEXT,
        visualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mensagem_id, user_cod)
      )
    `);
    console.log('✅ Tabela lideranca_visualizacoes verificada/criada');

    // Índices da liderança
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_msg_ativo ON lideranca_mensagens(ativo)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_viz_msg ON lideranca_visualizacoes(mensagem_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_viz_user ON lideranca_visualizacoes(user_cod)`).catch(() => {});

    // Tabela de reações às mensagens
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lideranca_reacoes (
        id SERIAL PRIMARY KEY,
        mensagem_id INT REFERENCES lideranca_mensagens(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        user_nome VARCHAR(255),
        user_foto TEXT,
        emoji VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mensagem_id, user_cod, emoji)
      )
    `);
    console.log('✅ Tabela lideranca_reacoes verificada/criada');
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lideranca_reacoes_msg ON lideranca_reacoes(mensagem_id)`).catch(() => {});

    console.log('✅ Módulo SOCIAL: todas as tabelas inicializadas');
  } catch (error) {
    console.error('❌ Erro ao inicializar tabelas do Social:', error);
    throw error;
  }
}

module.exports = initSocialTables;
