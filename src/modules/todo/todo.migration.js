/**
 * MÓDULO TODO - Migration
 * Tables: todo_grupos, todo_tarefas, todo_anexos, todo_comentarios,
 *         todo_historico, todo_subtarefas, todo_time_tracking,
 *         todo_dependencias, todo_templates
 */

async function initTodoTables(pool) {
    // TABELAS TO-DO
    // ============================================
    
    // Tabela de Grupos de TO-DO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_grupos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        descricao TEXT,
        icone VARCHAR(50) DEFAULT '📋',
        cor VARCHAR(20) DEFAULT '#7c3aed',
        tipo VARCHAR(20) DEFAULT 'compartilhado',
        criado_por VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        visivel_para JSONB DEFAULT '[]',
        ordem INT DEFAULT 0,
        ativo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_grupos verificada');

    // Tabela principal de Tarefas TO-DO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_tarefas (
        id SERIAL PRIMARY KEY,
        grupo_id INT REFERENCES todo_grupos(id) ON DELETE CASCADE,
        titulo VARCHAR(500) NOT NULL,
        descricao TEXT,
        status VARCHAR(30) DEFAULT 'pendente',
        prioridade VARCHAR(20) DEFAULT 'media',
        data_prazo TIMESTAMP,
        data_conclusao TIMESTAMP,
        recorrente BOOLEAN DEFAULT FALSE,
        tipo_recorrencia VARCHAR(20),
        intervalo_recorrencia INT DEFAULT 1,
        proxima_recorrencia TIMESTAMP,
        tipo VARCHAR(20) DEFAULT 'compartilhado',
        criado_por VARCHAR(50) NOT NULL,
        criado_por_nome VARCHAR(255),
        criado_por_foto TEXT,
        responsaveis JSONB DEFAULT '[]',
        ordem INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        concluido_por VARCHAR(50),
        concluido_por_nome VARCHAR(255)
      )
    `);
    // Adicionar colunas se não existirem
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS criado_por_foto TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS intervalo_recorrencia INT DEFAULT 1`).catch(() => {});
    console.log('✅ Tabela todo_tarefas verificada');

    // Tabela de Anexos das Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_anexos (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        nome_arquivo VARCHAR(500) NOT NULL,
        tipo_arquivo VARCHAR(100),
        tamanho INT,
        url TEXT NOT NULL,
        enviado_por VARCHAR(50),
        enviado_por_nome VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_anexos verificada');

    // Tabela de Comentários nas Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_comentarios (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        texto TEXT NOT NULL,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_comentarios verificada');

    // Tabela de Histórico/Log de Ações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_historico (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        acao VARCHAR(100) NOT NULL,
        descricao TEXT,
        user_cod VARCHAR(50),
        user_name VARCHAR(255),
        dados_anteriores JSONB,
        dados_novos JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_historico verificada');

    // Índices do TO-DO
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_grupo ON todo_tarefas(grupo_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_status ON todo_tarefas(status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_criador ON todo_tarefas(criado_por)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_anexos_tarefa ON todo_anexos(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_comentarios_tarefa ON todo_comentarios(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_subtarefas_tarefa ON todo_subtarefas(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_dependencias_tarefa ON todo_dependencias(tarefa_id)`).catch(() => {});

    // ============================================
    // NOVAS TABELAS TO-DO - MELHORIAS
    // ============================================

    // Tabela de Subtarefas/Checklist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_subtarefas (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        titulo VARCHAR(500) NOT NULL,
        concluida BOOLEAN DEFAULT FALSE,
        ordem INT DEFAULT 0,
        concluida_por VARCHAR(50),
        concluida_por_nome VARCHAR(255),
        concluida_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_subtarefas verificada');

    // Tabela de Time Tracking (registro de tempo)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_time_tracking (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        user_cod VARCHAR(50) NOT NULL,
        user_name VARCHAR(255),
        inicio TIMESTAMP NOT NULL,
        fim TIMESTAMP,
        duracao_segundos INT,
        descricao TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_time_tracking verificada');

    // Tabela de Dependências entre Tarefas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_dependencias (
        id SERIAL PRIMARY KEY,
        tarefa_id INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        depende_de INT REFERENCES todo_tarefas(id) ON DELETE CASCADE,
        tipo VARCHAR(30) DEFAULT 'finish_to_start',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tarefa_id, depende_de)
      )
    `);
    console.log('✅ Tabela todo_dependencias verificada');

    // Tabela de Templates de Tarefas Recorrentes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todo_templates (
        id SERIAL PRIMARY KEY,
        grupo_id INT REFERENCES todo_grupos(id) ON DELETE SET NULL,
        nome VARCHAR(255) NOT NULL,
        titulo_tarefa VARCHAR(500) NOT NULL,
        descricao TEXT,
        prioridade VARCHAR(20) DEFAULT 'media',
        checklist JSONB DEFAULT '[]',
        tempo_estimado_minutos INT,
        criado_por VARCHAR(50),
        criado_por_nome VARCHAR(255),
        ativo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela todo_templates verificada');

    // Migração: adicionar novas colunas na tabela todo_tarefas
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS coluna_kanban VARCHAR(30) DEFAULT 'todo'`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS tempo_estimado_minutos INT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS tempo_gasto_segundos INT DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_ativo BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_inicio TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS timer_user_cod VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS template_id INT`).catch(() => {});
    await pool.query(`ALTER TABLE todo_tarefas ADD COLUMN IF NOT EXISTS cor VARCHAR(20)`).catch(() => {});
    console.log('✅ Colunas adicionais todo_tarefas verificadas');

    // Índices adicionais
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_subtarefas_tarefa ON todo_subtarefas(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_time_tarefa ON todo_time_tracking(tarefa_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_todo_tarefas_kanban ON todo_tarefas(coluna_kanban)`).catch(() => {});

}

module.exports = { initTodoTables };
