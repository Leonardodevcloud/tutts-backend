/**
 * src/shared/migrations/performance-indices.js
 * ⚡ Índices para otimizar queries pesadas
 * 
 * EXECUTAR UMA VEZ via: node src/shared/migrations/performance-indices.js
 * Ou adicionar ao initDatabase() no server.js
 */

async function createPerformanceIndices(pool) {
  const indices = [
    // ===== TODO MODULE (tarefas query usa 4 LEFT JOINs) =====
    'CREATE INDEX IF NOT EXISTS idx_todo_anexos_tarefa_id ON todo_anexos(tarefa_id)',
    'CREATE INDEX IF NOT EXISTS idx_todo_comentarios_tarefa_id ON todo_comentarios(tarefa_id)',
    'CREATE INDEX IF NOT EXISTS idx_todo_subtarefas_tarefa_id ON todo_subtarefas(tarefa_id)',
    'CREATE INDEX IF NOT EXISTS idx_todo_subtarefas_concluida ON todo_subtarefas(tarefa_id, concluida)',
    'CREATE INDEX IF NOT EXISTS idx_todo_dependencias_tarefa_id ON todo_dependencias(tarefa_id)',
    'CREATE INDEX IF NOT EXISTS idx_todo_tarefas_grupo_id ON todo_tarefas(grupo_id)',
    'CREATE INDEX IF NOT EXISTS idx_todo_tarefas_status ON todo_tarefas(status)',
    'CREATE INDEX IF NOT EXISTS idx_todo_tarefas_criado_por ON todo_tarefas(criado_por)',
    'CREATE INDEX IF NOT EXISTS idx_todo_tarefas_coluna_kanban ON todo_tarefas(coluna_kanban)',
    // GIN index para busca em responsaveis JSONB
    'CREATE INDEX IF NOT EXISTS idx_todo_tarefas_responsaveis ON todo_tarefas USING GIN(responsaveis)',
    
    // ===== FINANCIAL MODULE (withdrawals) — ÍNDICES CRÍTICOS =====
    // Composite index para a query principal (status + created_at DESC)
    'CREATE INDEX IF NOT EXISTS idx_withdrawals_status_created ON withdrawal_requests(status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at_desc ON withdrawal_requests(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_withdrawals_user_cod ON withdrawal_requests(user_cod)',
    // Índice para pendentes (a query mais frequente)
    "CREATE INDEX IF NOT EXISTS idx_withdrawals_pending ON withdrawal_requests(created_at DESC) WHERE status IN ('pending','aguardando_aprovacao')",
    // restricted_professionals — usado no LEFT JOIN
    'CREATE INDEX IF NOT EXISTS idx_restricted_prof_user_status ON restricted_professionals(user_cod, status)',
    "CREATE INDEX IF NOT EXISTS idx_restricted_prof_ativo ON restricted_professionals(user_cod) WHERE status = 'ativo'",
    
    // ===== GRATUITIES =====
    'CREATE INDEX IF NOT EXISTS idx_gratuities_status ON gratuities(status)',
    'CREATE INDEX IF NOT EXISTS idx_gratuities_user_cod ON gratuities(user_cod)',
    
    // ===== AUTH MODULE (users) =====
    'CREATE INDEX IF NOT EXISTS idx_users_cod_profissional ON users(cod_profissional)',
    'CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)',
    
    // ===== SOCIAL MODULE =====
    'CREATE INDEX IF NOT EXISTS idx_social_messages_sender ON social_messages(sender_cod)',
    'CREATE INDEX IF NOT EXISTS idx_social_messages_receiver ON social_messages(receiver_cod)',
    
    // ===== SUBMISSIONS (solicitações) =====
    'CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status)',
    'CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC)',
    
    // ===== LOJA =====
    'CREATE INDEX IF NOT EXISTS idx_loja_pedidos_status ON loja_pedidos(status)',
    'CREATE INDEX IF NOT EXISTS idx_loja_pedidos_user ON loja_pedidos(user_cod)',

    // ===== BI ENTREGAS — ÍNDICES COMPOSTOS (2026-05) =====
    // Filtros mais comuns combinam data + cliente + centro_custo
    // Sem composto, o Postgres faz index scan parcial + filter, queimando compute
    'CREATE INDEX IF NOT EXISTS idx_bi_entregas_data_cliente ON bi_entregas(data_solicitado, cod_cliente)',
    'CREATE INDEX IF NOT EXISTS idx_bi_entregas_data_cliente_cc ON bi_entregas(data_solicitado, cod_cliente, centro_custo)',
    'CREATE INDEX IF NOT EXISTS idx_bi_entregas_data_prof ON bi_entregas(data_solicitado, cod_prof)',
    // Para o histograma de tempo (queries do dashboard-completo)
    'CREATE INDEX IF NOT EXISTS idx_bi_entregas_data_tempo ON bi_entregas(data_solicitado) WHERE tempo_execucao_minutos IS NOT NULL',
    // Para EXTRACT(HOUR FROM data_hora) — não otimiza muito, mas data_hora is not null é comum
    'CREATE INDEX IF NOT EXISTS idx_bi_entregas_data_hora ON bi_entregas(data_hora) WHERE data_hora IS NOT NULL',

    // ===== REFRESH TOKENS — para a grace window funcionar bem =====
    // Lookup por user_id + hash + revoked é a query mais comum
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_hash ON refresh_tokens(user_id, token_hash)',
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked_at ON refresh_tokens(revoked, revoked_at) WHERE revoked = true',

    // ===== WITHDRAWAL_REQUESTS — para o /resumo-contadores agregado =====
    // Conta filtrando por status — composto reduz seq scan em 12k+ linhas
    "CREATE INDEX IF NOT EXISTS idx_withdrawals_aguardando_created ON withdrawal_requests(created_at) WHERE status = 'aguardando_aprovacao'",
  ];

  console.log('⚡ Criando índices de performance...');
  let created = 0;
  let errors = 0;
  
  for (const sql of indices) {
    try {
      await pool.query(sql);
      created++;
    } catch (err) {
      // Ignorar erros se tabela não existe ainda (os módulos criam depois)
      if (!err.message.includes('does not exist')) {
        console.error(`  ❌ ${sql.split(' ON ')[1] || sql}: ${err.message}`);
        errors++;
      }
    }
  }
  
  console.log(`✅ Índices: ${created} criados/verificados, ${errors} erros`);
}

module.exports = { createPerformanceIndices };

// Executar diretamente se chamado via CLI
if (require.main === module) {
  const env = require('../../config/env');
  const { pool } = require('../../config/database');
  
  createPerformanceIndices(pool)
    .then(() => {
      console.log('✅ Migração concluída!');
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Erro na migração:', err);
      process.exit(1);
    });
}
