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
// JOB 5: Financial - Lote automático Stark Bank (a cada 1 hora)
// Envia todas as solicitações com status 'aguardando_pagamento_stark'
// para pagamento automático via Pix Stark Bank
// ════════════════════════════════════════════════════════════

let starkbankWorker = null;
let starkWorkerIniciado = false;

function inicializarStarkWorker() {
  if (starkWorkerIniciado) return !!starkbankWorker;

  const projectId = process.env.STARK_PROJECT_ID;
  const privateKey = process.env.STARK_PRIVATE_KEY;
  const environment = process.env.STARK_ENVIRONMENT || 'sandbox';

  if (!projectId || !privateKey) {
    console.warn('⚠️ [Worker Stark] STARK_PROJECT_ID ou STARK_PRIVATE_KEY não configuradas — batch automático desativado');
    starkWorkerIniciado = true;
    return false;
  }

  try {
    starkbankWorker = require('starkbank');

    // Formatar chave PEM
    let key = privateKey;
    if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
    if (!key.includes('\n') && key.includes('-----BEGIN')) {
      key = key
        .replace('-----BEGIN EC PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----\n')
        .replace('-----END EC PRIVATE KEY-----', '\n-----END EC PRIVATE KEY-----')
        .replace('-----BEGIN EC PARAMETERS-----', '\n-----BEGIN EC PARAMETERS-----\n')
        .replace('-----END EC PARAMETERS-----', '\n-----END EC PARAMETERS-----\n');
    }
    key = key.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n');

    const project = new starkbankWorker.Project({ environment, id: projectId, privateKey: key });
    starkbankWorker.setUser(project);
    starkWorkerIniciado = true;
    console.log(`✅ [Worker Stark] SDK inicializado (${environment})`);
    return true;
  } catch (err) {
    console.error('❌ [Worker Stark] Erro ao inicializar SDK:', err.message);
    starkWorkerIniciado = true;
    return false;
  }
}

async function obterSaldoReaisWorker() {
  const result = await starkbankWorker.balance.get();
  if (Array.isArray(result)) return result.length > 0 ? result[0].amount / 100 : 0;
  if (result && result.amount !== undefined) return result.amount / 100;
  return 0;
}

const processarLoteStarkAutomatico = async () => {
  console.log('🏦 [CRON Stark] Verificando saques aguardando pagamento Stark...');

  try {
    // 1. Buscar saques prontos para pagamento (débito Plific OK, aguardando envio Stark)
    const saquesProntos = await pool.query(`
      SELECT w.*, ufd.pix_tipo
      FROM withdrawal_requests w
      LEFT JOIN user_financial_data ufd ON w.user_cod = ufd.user_cod
      WHERE w.status = 'aguardando_pagamento_stark'
        AND w.debito = true
        AND (w.stark_status IS NULL OR w.stark_status = 'erro')
      ORDER BY w.created_at ASC
    `);

    if (saquesProntos.rows.length === 0) {
      console.log('🏦 [CRON Stark] Nenhum saque pendente para envio');
      return;
    }

    console.log(`🏦 [CRON Stark] ${saquesProntos.rows.length} saque(s) encontrado(s)`);

    // 2. Inicializar SDK
    if (!inicializarStarkWorker() || !starkbankWorker) {
      console.error('❌ [CRON Stark] SDK não disponível, abortando batch');
      return;
    }

    const saques = saquesProntos.rows;

    // 3. Aprovar os saques no banco (mudar status para aprovado/aprovado_gratuidade)
    for (const saque of saques) {
      const novoStatus = saque.has_gratuity ? 'aprovado_gratuidade' : 'aprovado';
      await pool.query(`
        UPDATE withdrawal_requests
        SET status = $1,
            approved_at = COALESCE(approved_at, NOW()),
            lancamento_at = COALESCE(lancamento_at, NOW()),
            stark_status = 'em_lote',
            admin_name = 'Sistema (Auto-batch)',
            updated_at = NOW()
        WHERE id = $2
      `, [novoStatus, saque.id]);
    }

    console.log(`🏦 [CRON Stark] ${saques.length} saque(s) aprovados e marcados 'em_lote'`);

    // 4. Verificar saldo
    let saldoDisponivel;
    try {
      saldoDisponivel = await obterSaldoReaisWorker();
    } catch (errSaldo) {
      console.error('❌ [CRON Stark] Não foi possível verificar saldo:', errSaldo.message);
      return;
    }

    const valorTotal = saques.reduce((acc, s) => acc + parseFloat(s.final_amount || 0), 0);

    if (saldoDisponivel < valorTotal) {
      console.error(`❌ [CRON Stark] Saldo insuficiente: R$ ${saldoDisponivel.toFixed(2)} < R$ ${valorTotal.toFixed(2)}`);
      // Não reverter aprovação — admin pode executar manualmente quando houver saldo
      return;
    }

    // 5. Criar lote
    const loteResult = await pool.query(`
      INSERT INTO stark_lotes (
        quantidade, valor_total, saldo_antes, status,
        executado_por_id, executado_por_nome
      ) VALUES ($1, $2, $3, 'processando', 0, 'Sistema (Auto-batch)')
      RETURNING *
    `, [saques.length, valorTotal, saldoDisponivel]);

    const loteId = loteResult.rows[0].id;
    console.log(`🏦 [CRON Stark] Lote #${loteId} criado — ${saques.length} saques, R$ ${valorTotal.toFixed(2)}`);

    // 6. Processar cada saque individualmente (DICT + Transfer)
    let enviados = 0;
    let erros = 0;

    for (const saque of saques) {
      const pixKeyRaw = (saque.pix_key || '').trim();
      const cpf = (saque.cpf || '').replace(/\D/g, '');
      const cpfFormatado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
      const pixTipo = (saque.pix_tipo || '').toLowerCase();

      // Normalizar chave Pix
      let chaveDict = pixKeyRaw;
      const pixSoDigitos = pixKeyRaw.replace(/\D/g, '');

      if (pixTipo === 'cpf' || (!pixTipo && pixSoDigitos.length === 11 && !pixKeyRaw.includes('@') && !pixKeyRaw.startsWith('+'))) {
        chaveDict = pixSoDigitos;
      } else if (pixTipo === 'cnpj' || (!pixTipo && pixSoDigitos.length === 14)) {
        chaveDict = pixSoDigitos;
      } else if (pixTipo === 'telefone' || pixTipo === 'phone' || pixKeyRaw.startsWith('+55')) {
        let tel = pixSoDigitos;
        if (tel.startsWith('55') && tel.length >= 12) chaveDict = '+' + tel;
        else if (tel.length === 10 || tel.length === 11) chaveDict = '+55' + tel;
        else chaveDict = pixKeyRaw.startsWith('+') ? pixKeyRaw : '+55' + tel;
      } else if (pixTipo === 'email' || pixKeyRaw.includes('@')) {
        chaveDict = pixKeyRaw.toLowerCase().trim();
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pixKeyRaw)) {
        chaveDict = pixKeyRaw.toLowerCase().trim();
      }

      try {
        // Consultar DICT
        const dictKey = await starkbankWorker.dictKey.get(chaveDict);
        const taxIdFinal = dictKey.taxId || cpfFormatado;

        // Criar transfer
        const transferData = {
          amount: Math.round(parseFloat(saque.final_amount) * 100),
          name: saque.user_name,
          taxId: taxIdFinal,
          bankCode: dictKey.ispb || '20018183',
          branchCode: dictKey.branchCode || '0001',
          accountNumber: dictKey.accountNumber || chaveDict,
          accountType: dictKey.accountType || 'checking',
          externalId: `tutts-saque-${saque.id}`,
          tags: [`lote:${loteId}`, `saque:${saque.id}`, 'auto-batch']
        };

        const resultado = await starkbankWorker.transfer.create([new starkbankWorker.Transfer(transferData)]);
        const transferId = resultado[0].id;

        // Atualizar saque
        await pool.query(`
          UPDATE withdrawal_requests
          SET stark_status = 'processando',
              stark_transfer_id = $1,
              stark_lote_id = $2,
              stark_enviado_em = NOW(),
              updated_at = NOW()
          WHERE id = $3
        `, [transferId, loteId, saque.id]);

        // Registrar item do lote
        await pool.query(`
          INSERT INTO stark_lote_itens (lote_id, withdrawal_id, stark_transfer_id, valor, status)
          VALUES ($1, $2, $3, $4, 'processando')
        `, [loteId, saque.id, transferId, saque.final_amount]);

        enviados++;
        console.log(`  ✅ Saque #${saque.id} (${saque.user_name}) → Transfer ${transferId}`);

      } catch (errTransfer) {
        const erroMsg = errTransfer.errors ? JSON.stringify(errTransfer.errors) : errTransfer.message;
        console.error(`  ❌ Saque #${saque.id} (${saque.user_name}): ${erroMsg}`);

        await pool.query(`
          UPDATE withdrawal_requests
          SET stark_status = 'erro', stark_erro = $1, stark_lote_id = $2, updated_at = NOW()
          WHERE id = $3
        `, [erroMsg.substring(0, 500), loteId, saque.id]);

        await pool.query(`
          INSERT INTO stark_lote_itens (lote_id, withdrawal_id, valor, status, erro)
          VALUES ($1, $2, $3, 'rejeitado', $4)
        `, [loteId, saque.id, saque.final_amount, erroMsg.substring(0, 500)]);

        erros++;
      }
    }

    // 7. Finalizar lote
    const statusLote = enviados === 0 ? 'erro' : (erros > 0 ? 'processando' : 'processando');
    await pool.query(`
      UPDATE stark_lotes
      SET status = $1, quantidade = $2,
          valor_total = $3,
          erro = CASE WHEN $4 = 0 THEN 'Todos falharam' ELSE NULL END
      WHERE id = $5
    `, [statusLote, enviados, saques.filter((_, i) => i < enviados).reduce((a, s) => a + parseFloat(s.final_amount || 0), 0), enviados, loteId]);

    console.log(`✅ [CRON Stark] Lote #${loteId} finalizado: ${enviados} enviados, ${erros} erros`);

  } catch (error) {
    console.error('❌ [CRON Stark] Erro geral no batch automático:', error.message);
  }
};

// Rodar a cada 1 hora
setInterval(processarLoteStarkAutomatico, 60 * 60 * 1000);
// Primeira execução após 30s (dar tempo para DB conectar)
setTimeout(processarLoteStarkAutomatico, 30000);

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
    console.log('     ⏰ Stark auto-batch  — a cada 1h');
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
