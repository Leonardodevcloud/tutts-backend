/**
 * MÓDULO CONFIG - Migration
 * 14 tabelas: admin_permissions, horarios_atendimento, horarios_especiais,
 *             avisos_financeiro, promocoes_indicacao, indicacoes, indicacao_links,
 *             promocoes_novatos, promocoes_novatos_clientes, inscricoes_novatos,
 *             quiz_procedimentos_config, quiz_procedimentos_respostas,
 *             recrutamento_necessidades, recrutamento_atribuicoes
 */

async function initConfigTables(pool) {

  // ==================== PROMOÇÕES E INDICAÇÕES ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promocoes_indicacao (
      id SERIAL PRIMARY KEY,
      regiao VARCHAR(255) NOT NULL,
      valor_bonus DECIMAL(10,2) NOT NULL,
      detalhes TEXT,
      status VARCHAR(20) DEFAULT 'ativa',
      created_at TIMESTAMP DEFAULT NOW(),
      created_by VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela promocoes_indicacao verificada');

  try {
    await pool.query(`ALTER TABLE promocoes_indicacao ADD COLUMN IF NOT EXISTS detalhes TEXT`);
  } catch (e) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS indicacoes (
      id SERIAL PRIMARY KEY,
      promocao_id INTEGER REFERENCES promocoes_indicacao(id),
      user_cod VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      indicado_nome VARCHAR(255) NOT NULL,
      indicado_cpf VARCHAR(14),
      indicado_contato VARCHAR(20) NOT NULL,
      status VARCHAR(20) DEFAULT 'pendente',
      valor_bonus DECIMAL(10,2),
      regiao VARCHAR(255),
      motivo_rejeicao TEXT,
      credito_lancado BOOLEAN DEFAULT FALSE,
      lancado_por VARCHAR(255),
      lancado_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      resolved_at TIMESTAMP,
      resolved_by VARCHAR(255),
      link_token VARCHAR(100)
    )
  `);
  console.log('✅ Tabela indicacoes verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS indicacao_links (
      id SERIAL PRIMARY KEY,
      user_cod VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      token VARCHAR(100) UNIQUE NOT NULL,
      promocao_id INTEGER,
      regiao VARCHAR(255),
      valor_bonus DECIMAL(10,2),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela indicacao_links verificada');

  try {
    await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS promocao_id INTEGER`);
    await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS regiao VARCHAR(255)`);
    await pool.query(`ALTER TABLE indicacao_links ADD COLUMN IF NOT EXISTS valor_bonus DECIMAL(10,2)`);
  } catch (e) {}

  try {
    await pool.query(`ALTER TABLE indicacoes ADD COLUMN IF NOT EXISTS link_token VARCHAR(100)`);
  } catch (e) {}

  // ==================== PROMOÇÕES NOVATOS ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promocoes_novatos (
      id SERIAL PRIMARY KEY,
      regiao VARCHAR(255) NOT NULL,
      cliente VARCHAR(255) NOT NULL,
      valor_bonus DECIMAL(10,2) NOT NULL,
      detalhes TEXT,
      status VARCHAR(20) DEFAULT 'ativa',
      created_at TIMESTAMP DEFAULT NOW(),
      created_by VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela promocoes_novatos verificada');

  try {
    await pool.query(`ALTER TABLE promocoes_novatos ADD COLUMN IF NOT EXISTS quantidade_entregas INTEGER DEFAULT 50`);
    await pool.query(`ALTER TABLE promocoes_novatos ADD COLUMN IF NOT EXISTS apelido VARCHAR(255)`);
    await pool.query(`UPDATE promocoes_novatos SET apelido = cliente WHERE apelido IS NULL`);
  } catch (e) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promocoes_novatos_clientes (
      id SERIAL PRIMARY KEY,
      promocao_id INTEGER REFERENCES promocoes_novatos(id) ON DELETE CASCADE,
      cod_cliente INTEGER NOT NULL,
      nome_cliente VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(promocao_id, cod_cliente)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_promo_novatos_clientes_promocao ON promocoes_novatos_clientes(promocao_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_promo_novatos_clientes_cod ON promocoes_novatos_clientes(cod_cliente)`).catch(() => {});
  console.log('✅ Tabela promocoes_novatos_clientes verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inscricoes_novatos (
      id SERIAL PRIMARY KEY,
      promocao_id INTEGER REFERENCES promocoes_novatos(id),
      user_cod VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      status VARCHAR(20) DEFAULT 'pendente',
      valor_bonus DECIMAL(10,2),
      regiao VARCHAR(255),
      cliente VARCHAR(255),
      motivo_rejeicao TEXT,
      credito_lancado BOOLEAN DEFAULT FALSE,
      lancado_por VARCHAR(255),
      lancado_at TIMESTAMP,
      debito BOOLEAN DEFAULT FALSE,
      debitado_por VARCHAR(255),
      debitado_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      resolved_at TIMESTAMP,
      resolved_by VARCHAR(255)
    )
  `);
  console.log('✅ Tabela inscricoes_novatos verificada');

  try {
    await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debito BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debitado_por VARCHAR(255)`);
    await pool.query(`ALTER TABLE inscricoes_novatos ADD COLUMN IF NOT EXISTS debitado_at TIMESTAMP`);
  } catch (e) {}

  // ==================== QUIZ PROCEDIMENTOS ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_procedimentos_config (
      id SERIAL PRIMARY KEY,
      titulo VARCHAR(500) DEFAULT 'Acerte os procedimentos e ganhe saque gratuito de R$ 500,00',
      imagem1 TEXT,
      imagem2 TEXT,
      imagem3 TEXT,
      imagem4 TEXT,
      pergunta1 TEXT,
      resposta1 BOOLEAN,
      pergunta2 TEXT,
      resposta2 BOOLEAN,
      pergunta3 TEXT,
      resposta3 BOOLEAN,
      pergunta4 TEXT,
      resposta4 BOOLEAN,
      pergunta5 TEXT,
      resposta5 BOOLEAN,
      valor_gratuidade DECIMAL(10,2) DEFAULT 500.00,
      ativo BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela quiz_procedimentos_config verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_procedimentos_respostas (
      id SERIAL PRIMARY KEY,
      user_cod VARCHAR(50) NOT NULL UNIQUE,
      user_name VARCHAR(255),
      acertos INTEGER,
      passou BOOLEAN,
      gratuidade_criada BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela quiz_procedimentos_respostas verificada');

  // ==================== HORÁRIOS E AVISOS ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS horarios_atendimento (
      id SERIAL PRIMARY KEY,
      dia_semana INT NOT NULL,
      hora_inicio TIME,
      hora_fim TIME,
      ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela horarios_atendimento verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS horarios_especiais (
      id SERIAL PRIMARY KEY,
      data DATE NOT NULL UNIQUE,
      descricao VARCHAR(255),
      hora_inicio TIME,
      hora_fim TIME,
      fechado BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela horarios_especiais verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS avisos_financeiro (
      id SERIAL PRIMARY KEY,
      titulo VARCHAR(255) NOT NULL,
      mensagem TEXT NOT NULL,
      tipo VARCHAR(50) DEFAULT 'info',
      ativo BOOLEAN DEFAULT true,
      exibir_fora_horario BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela avisos_financeiro verificada');

  // Seed horários padrão
  const horariosExistentes = await pool.query('SELECT COUNT(*) FROM horarios_atendimento');
  if (parseInt(horariosExistentes.rows[0].count) === 0) {
    for (let dia = 1; dia <= 5; dia++) {
      await pool.query(
        'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
        [dia, '09:00', '18:00', true]
      );
    }
    await pool.query(
      'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
      [6, '08:00', '12:00', true]
    );
    await pool.query(
      'INSERT INTO horarios_atendimento (dia_semana, hora_inicio, hora_fim, ativo) VALUES ($1, $2, $3, $4)',
      [0, null, null, false]
    );
    console.log('✅ Horários padrão inseridos');
  }

  // ==================== RECRUTAMENTO ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recrutamento_necessidades (
      id SERIAL PRIMARY KEY,
      nome_cliente VARCHAR(255) NOT NULL,
      data_conclusao DATE NOT NULL,
      quantidade_motos INTEGER NOT NULL DEFAULT 1,
      quantidade_backup INTEGER NOT NULL DEFAULT 0,
      observacao TEXT,
      status VARCHAR(50) DEFAULT 'em_andamento',
      criado_por VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Tabela recrutamento_necessidades verificada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recrutamento_atribuicoes (
      id SERIAL PRIMARY KEY,
      necessidade_id INTEGER REFERENCES recrutamento_necessidades(id) ON DELETE CASCADE,
      tipo VARCHAR(20) NOT NULL DEFAULT 'titular',
      cod_profissional VARCHAR(50) NOT NULL,
      nome_profissional VARCHAR(200),
      atribuido_por VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Tabela recrutamento_atribuicoes verificada');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recrutamento_necessidade_status ON recrutamento_necessidades(status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recrutamento_atribuicoes_necessidade ON recrutamento_atribuicoes(necessidade_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recrutamento_atribuicoes_cod ON recrutamento_atribuicoes(cod_profissional)`).catch(() => {});

  // ==================== ADMIN PERMISSIONS ====================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id SERIAL PRIMARY KEY,
      user_cod VARCHAR(50) NOT NULL UNIQUE,
      user_name VARCHAR(255),
      modules JSONB DEFAULT '[]',
      tabs JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela admin_permissions verificada');

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_modules JSONB DEFAULT '[]'`).catch(() => {});
}

module.exports = { initConfigTables };
