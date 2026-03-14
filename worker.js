/**
 * Tutts Backend - worker.js
 * Processo separado para tarefas agendadas (crons)
 * Não serve HTTP — só executa jobs no banco
 * 
 * Deploy: Railway → New Service → worker.js
 * Env: mesmas variáveis do server principal
 */

const cron = require('node-cron');
const { pool, testConnection } = require('./src/config/database');
const { logger } = require('./src/config/logger');

// ─── Score ────────────────────────────────────────────────
const { aplicarGratuidadeProfissional } = require('./src/modules/score/score.service');

// ─── Auth cleanup ─────────────────────────────────────────
const bcrypt = require('bcrypt');
const { REFRESH_SECRET } = require('./src/modules/auth/auth.service');

console.log('🔧 Tutts Worker iniciando...');
console.log(`📅 ${new Date().toISOString()}`);
console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

// ════════════════════════════════════════════════════════════
// JOB 1: Score - Gratuidades (dia 1 de cada mês, 00:05 UTC)
// ════════════════════════════════════════════════════════════
cron.schedule('5 0 1 * *', async () => {
  console.log('🎁 [CRON] Iniciando aplicação de gratuidades do Score...');
  try {
    const mesReferencia = new Date().toISOString().slice(0, 7);
    const profissionais = await pool.query(`
      SELECT cod_prof, nome_prof, score_total
      FROM score_totais
      WHERE score_total >= 80
      ORDER BY score_total DESC
    `);

    let aplicados = 0;
    for (const prof of profissionais.rows) {
      try {
        const resultado = await aplicarGratuidadeProfissional(pool, prof, mesReferencia);
        if (resultado === 'criado') aplicados++;
      } catch (err) {
        console.error(`[CRON] Erro gratuidade ${prof.cod_prof}:`, err.message);
      }
    }

    console.log(`✅ [CRON] Gratuidades Score aplicadas: ${aplicados} profissionais`);
  } catch (error) {
    console.error('❌ [CRON] Erro gratuidades Score:', error.message);
  }
});

// ════════════════════════════════════════════════════════════
// JOB 2: TODO - Recorrências (a cada 1 hora)
// ════════════════════════════════════════════════════════════
const processarRecorrencias = async () => {
  try {
    const result = await pool.query(`
      SELECT * FROM todo_tarefas 
      WHERE recorrencia IS NOT NULL 
        AND recorrencia != 'nenhuma'
        AND status = 'concluida'
        AND proxima_recorrencia IS NOT NULL 
        AND proxima_recorrencia <= NOW()
    `);

    let reabertas = 0;
    for (const tarefa of result.rows) {
      try {
        await pool.query(`
          UPDATE todo_tarefas 
          SET status = 'pendente', 
              atualizado_em = NOW(),
              proxima_recorrencia = CASE recorrencia
                WHEN 'diaria' THEN proxima_recorrencia + INTERVAL '1 day'
                WHEN 'semanal' THEN proxima_recorrencia + INTERVAL '7 days'
                WHEN 'mensal' THEN proxima_recorrencia + INTERVAL '1 month'
                ELSE NULL
              END
          WHERE id = $1
        `, [tarefa.id]);
        reabertas++;
      } catch (err) {
        console.error(`[CRON] Erro recorrência tarefa ${tarefa.id}:`, err.message);
      }
    }
    if (reabertas > 0) console.log(`🔄 [CRON] ${reabertas} tarefas recorrentes reabertas`);
  } catch (err) {
    console.error('❌ [CRON] Erro recorrências:', err.message);
  }
};

// Rodar a cada hora
setInterval(processarRecorrencias, 60 * 60 * 1000);
// Primeira execução após 10s
setTimeout(processarRecorrencias, 10000);

// ════════════════════════════════════════════════════════════
// JOB 3: Auth - Limpeza de bloqueios expirados (a cada 5 min)
// ════════════════════════════════════════════════════════════
const limparBloqueiosExpirados = async () => {
  try {
    const result = await pool.query(`
      DELETE FROM login_attempts 
      WHERE blocked_until IS NOT NULL 
        AND blocked_until < NOW()
    `);
    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} bloqueio(s) de login expirado(s) removido(s)`);
    }
  } catch (err) {
    console.error('❌ [CRON] Erro limpeza bloqueios:', err.message);
  }
};

setInterval(limparBloqueiosExpirados, 5 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// JOB 4: Auth - Limpeza de refresh tokens expirados (a cada 1h)
// ════════════════════════════════════════════════════════════
const limparRefreshTokensExpirados = async () => {
  try {
    const result = await pool.query(`
      DELETE FROM refresh_tokens 
      WHERE expires_at < NOW() 
         OR revoked = true
    `);
    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} refresh token(s) expirado(s) removido(s)`);
    }
  } catch (err) {
    console.error('❌ [CRON] Erro limpeza refresh tokens:', err.message);
  }
};

setInterval(limparRefreshTokensExpirados, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// JOB 5: Financial - Preparar lote Stark Bank (a cada 1 hora)
// APENAS aprova saques e marca 'em_lote' para o admin revisar
// ⚠️  NÃO EXECUTA PAGAMENTO — admin faz isso manualmente via /stark/lote/executar
// ════════════════════════════════════════════════════════════

const prepararLoteStarkAutomatico = async () => {
  console.log('🏦 [CRON Stark] Verificando saques aguardando pagamento Stark...');
  try {
    const saquesProntos = await pool.query(`
      SELECT w.*
      FROM withdrawal_requests w
      WHERE w.status = 'aguardando_pagamento_stark'
        AND w.debito = true
        AND (w.stark_status IS NULL OR w.stark_status = 'erro')
      ORDER BY w.created_at ASC
    `);

    if (saquesProntos.rows.length === 0) {
      console.log('🏦 [CRON Stark] Nenhum saque pendente');
      return;
    }

    const saques = saquesProntos.rows;
    const valorTotal = saques.reduce((acc, s) => acc + parseFloat(s.final_amount || 0), 0);

    console.log(`🏦 [CRON Stark] ${saques.length} saque(s) encontrado(s) — R$ ${valorTotal.toFixed(2)}`);

    // Aprovar e marcar como 'em_lote' — admin executa o pagamento manualmente
    for (const saque of saques) {
      const novoStatus = saque.has_gratuity ? 'aprovado_gratuidade' : 'aprovado';
      await pool.query(`
        UPDATE withdrawal_requests
        SET status = $1,
            approved_at = COALESCE(approved_at, NOW()),
            lancamento_at = COALESCE(lancamento_at, NOW()),
            stark_status = 'em_lote',
            admin_name = COALESCE(admin_name, 'Sistema (Auto-batch)'),
            updated_at = NOW()
        WHERE id = $2
      `, [novoStatus, saque.id]);
    }

    console.log(`✅ [CRON Stark] ${saques.length} saque(s) aprovados e marcados 'em_lote' — aguardando admin executar pagamento`);

  } catch (error) {
    console.error('❌ [CRON Stark] Erro geral:', error.message);
  }
};

// Seg-Sex: a cada hora das 8h às 18h
cron.schedule('0 8-18 * * 1-5', prepararLoteStarkAutomatico, { timezone: 'America/Bahia' });
// Sábado: a cada hora das 8h às 12h
cron.schedule('0 8-12 * * 6', prepararLoteStarkAutomatico, { timezone: 'America/Bahia' });

// ════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════
(async () => {
  try {
    await testConnection();
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  🔧 Tutts Worker ONLINE');
    console.log('  📋 Jobs ativos:');
    console.log('     ⏰ Score gratuidades — dia 1/mês 00:05');
    console.log('     ⏰ TODO recorrências — a cada 1h');
    console.log('     ⏰ Auth bloqueios    — a cada 5min');
    console.log('     ⏰ Auth tokens       — a cada 1h');
    console.log('     ⏰ Stark auto-batch  — Seg-Sex 8h-18h | Sáb 8h-12h');
    console.log('══════════════════════════════════════════');
    console.log('');
  } catch (error) {
    console.error('❌ Worker falhou ao conectar no banco:', error.message);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Worker recebeu SIGTERM, encerrando...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Worker recebeu SIGINT, encerrando...');
  await pool.end();
  process.exit(0);
});
