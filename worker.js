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

// ─── WhatsApp Notifications ──────────────────────────────
let notificarLoteGerado, notificarResumoDiario;
try {
  const whatsapp = require('./src/modules/financial/routes/whatsapp.service');
  notificarLoteGerado = whatsapp.notificarLoteGerado;
  notificarResumoDiario = whatsapp.notificarResumoDiario;
  console.log('✅ [Worker] WhatsApp module carregado');
} catch (err) {
  console.warn('⚠️ [Worker] WhatsApp module não carregou:', err.message);
  notificarLoteGerado = async () => ({ enviado: false, motivo: 'modulo_indisponivel' });
  notificarResumoDiario = async () => ({ enviado: false, motivo: 'modulo_indisponivel' });
}

// ─── Stark Bank SDK (para saldo no resumo diário) ────────
let starkbank = null;
try {
  starkbank = require('starkbank');
  const projectId = process.env.STARK_PROJECT_ID;
  const privateKey = process.env.STARK_PRIVATE_KEY;
  const environment = process.env.STARK_ENVIRONMENT || 'production';

  if (projectId && privateKey) {
    let key = privateKey.replace(/\\n/g, '\n');
    if (!key.includes('\n')) {
      key = key
        .replace('-----BEGIN EC PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----\n')
        .replace('-----END EC PRIVATE KEY-----', '\n-----END EC PRIVATE KEY-----');
    }
    key = key.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n');

    const project = new starkbank.Project({ environment, id: projectId, privateKey: key });
    starkbank.setUser(project);
    console.log('✅ [Worker] Stark Bank SDK inicializado');
  } else {
    console.warn('⚠️ [Worker] Stark Bank: variáveis não configuradas — saldo não disponível no resumo');
    starkbank = null;
  }
} catch (err) {
  console.warn('⚠️ [Worker] Stark Bank SDK não carregou:', err.message);
  starkbank = null;
}

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

    // Criar registro do lote com status 'pendente' (admin executa depois)
    const loteResult = await pool.query(`
      INSERT INTO stark_lotes (quantidade, valor_total, saldo_antes, status, executado_por_id, executado_por_nome)
      VALUES ($1, $2, 0, 'pendente', 0, 'Sistema (Auto-batch)')
      RETURNING *
    `, [saques.length, valorTotal]);

    const loteId = loteResult.rows[0].id;

    // Aprovar e marcar como 'em_lote' com o lote_id real
    for (const saque of saques) {
      const novoStatus = saque.has_gratuity ? 'aprovado_gratuidade' : 'aprovado';
      await pool.query(`
        UPDATE withdrawal_requests
        SET status = $1,
            approved_at = COALESCE(approved_at, NOW()),
            lancamento_at = COALESCE(lancamento_at, NOW()),
            stark_status = 'em_lote',
            stark_lote_id = $2,
            admin_name = COALESCE(admin_name, 'Sistema (Auto-batch)'),
            updated_at = NOW()
        WHERE id = $3
      `, [novoStatus, loteId, saque.id]);
    }

    console.log(`✅ [CRON Stark] Lote #${loteId} criado — ${saques.length} saque(s) aprovados e marcados 'em_lote' — aguardando admin executar pagamento`);

    // 📱 Notificar grupo WhatsApp sobre lote criado
    notificarLoteGerado({
      loteId,
      quantidade: saques.length,
      valorTotal,
      saques
    }).catch(err => console.error('❌ [WhatsApp] Falha na notificação lote criado:', err.message));

  } catch (error) {
    console.error('❌ [CRON Stark] Erro geral:', error.message);
  }
};

// Seg-Sex: a cada hora das 8h às 18h
cron.schedule('0 8-18 * * 1-5', prepararLoteStarkAutomatico, { timezone: 'America/Bahia' });
// Sábado: a cada hora das 8h às 12h
cron.schedule('0 8-12 * * 6', prepararLoteStarkAutomatico, { timezone: 'America/Bahia' });

// ════════════════════════════════════════════════════════════
// RESUMO DIÁRIO — 19h (Seg-Sáb)
// ════════════════════════════════════════════════════════════
const enviarResumoDiario = async () => {
  console.log('📊 [CRON Resumo] Gerando resumo diário...');
  try {
    // Query espelhando a aba Validação (filtro por data de solicitação = created_at)
    const resumo = await pool.query(`
      SELECT 
        COUNT(*) as total_recebidas,
        COUNT(*) FILTER (WHERE status IN ('aprovado', 'aprovado_gratuidade', 'pago_stark')) as total_aprovadas,
        COUNT(*) FILTER (WHERE status = 'aprovado' OR (status = 'pago_stark' AND has_gratuity = false)) as sem_gratuidade,
        COUNT(*) FILTER (WHERE status = 'aprovado_gratuidade' OR (status = 'pago_stark' AND has_gratuity = true)) as com_gratuidade,
        COUNT(*) FILTER (WHERE status = 'rejeitado') as rejeitadas,
        COALESCE(SUM(requested_amount) FILTER (WHERE status = 'aprovado' OR (status = 'pago_stark' AND has_gratuity = false)), 0) as valor_sem_gratuidade,
        COALESCE(SUM(requested_amount) FILTER (WHERE status = 'aprovado_gratuidade' OR (status = 'pago_stark' AND has_gratuity = true)), 0) as valor_com_gratuidade
      FROM withdrawal_requests
      WHERE created_at >= CURRENT_DATE
        AND created_at < (CURRENT_DATE + INTERVAL '1 day')
    `);

    const r = resumo.rows[0];
    const totalRecebidas = parseInt(r.total_recebidas) || 0;
    const totalAprovadas = parseInt(r.total_aprovadas) || 0;
    const semGratuidade = parseInt(r.sem_gratuidade) || 0;
    const comGratuidade = parseInt(r.com_gratuidade) || 0;
    const rejeitadas = parseInt(r.rejeitadas) || 0;
    const valorSemGratuidade = parseFloat(r.valor_sem_gratuidade) || 0;
    const valorComGratuidade = parseFloat(r.valor_com_gratuidade) || 0;
    const valorTotalAprovado = valorSemGratuidade + valorComGratuidade;
    const lucro = valorSemGratuidade * 0.045;
    const deixouArrecadar = valorComGratuidade * 0.045;

    // Consultar saldo Stark Bank
    let saldoStark = 0;
    if (starkbank) {
      try {
        const result = await starkbank.balance.get();
        if (Array.isArray(result)) {
          saldoStark = result.length > 0 ? result[0].amount / 100 : 0;
        } else if (result && result.amount !== undefined) {
          saldoStark = result.amount / 100;
        }
      } catch (errSaldo) {
        console.error('⚠️ [CRON Resumo] Erro ao consultar saldo Stark:', errSaldo.message);
      }
    }

    console.log(`📊 [CRON Resumo] Recebidas: ${totalRecebidas} | Aprovadas: ${totalAprovadas} | Lucro: R$ ${lucro.toFixed(2)} | Saldo: R$ ${saldoStark.toFixed(2)}`);

    await notificarResumoDiario({ totalRecebidas, totalAprovadas, semGratuidade, comGratuidade, rejeitadas, valorTotalAprovado, lucro, deixouArrecadar, saldoStark });

  } catch (error) {
    console.error('❌ [CRON Resumo] Erro geral:', error.message);
  }
};

// Seg-Sex às 19h
cron.schedule('0 19 * * 1-5', enviarResumoDiario, { timezone: 'America/Bahia' });
// Sábado às 13h
cron.schedule('0 13 * * 6', enviarResumoDiario, { timezone: 'America/Bahia' });

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
    console.log('     ⏰ Resumo diário     — Seg-Sex 19h | Sáb 13h');
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
