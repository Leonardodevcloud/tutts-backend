/**
 * src/shared/utils/cronMutex.js
 * 🔒 SECURITY FIX (AUDIT-08): Mutex para cron jobs via pg_advisory_xact_lock
 * 
 * Previne execução duplicada quando server.js e worker.js rodam simultaneamente.
 * 
 * ⚠️  FIX CRÍTICO: Migrado de pg_try_advisory_lock (session-level) para
 *     pg_try_advisory_xact_lock (transaction-level). Locks de sessão ficavam
 *     presos na conexão do pool quando pg_advisory_unlock falhava, travando
 *     TODOS os crons subsequentes permanentemente. Locks transacionais são
 *     liberados automaticamente no COMMIT/ROLLBACK — impossível travar.
 * 
 * Uso:
 *   const { withCronLock } = require('./src/shared/utils/cronMutex');
 *   cron.schedule('0 8 * * *', withCronLock(pool, 'prepararLote', async () => { ... }));
 */

// Mapa de lock IDs — cada job tem um ID numérico único para pg_advisory_lock
const LOCK_IDS = {};

function getLockId(jobName) {
  if (!LOCK_IDS[jobName]) {
    let hash = 0;
    for (let i = 0; i < jobName.length; i++) {
      hash = ((hash << 5) - hash) + jobName.charCodeAt(i);
      hash = hash & hash;
    }
    LOCK_IDS[jobName] = Math.abs(hash % 900000) + 100000;
  }
  return LOCK_IDS[jobName];
}

/**
 * Wrapper para cron jobs com mutex via pg_advisory_xact_lock (transaction-level)
 * 
 * O lock é adquirido dentro de uma transação dedicada (BEGIN/COMMIT).
 * Quando o job termina — com sucesso, erro ou timeout — o COMMIT/ROLLBACK
 * libera o lock automaticamente. Se o processo crashar, a conexão morre
 * e o PostgreSQL faz ROLLBACK automático, liberando o lock.
 * 
 * → Impossível travar, diferente do session-level lock antigo.
 */
function withCronLock(pool, jobName, fn, opts = {}) {
  const lockId = getLockId(jobName);
  const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
  const processId = process.env.WORKER_ENABLED === 'true' ? 'worker' : 'server';

  return async function cronWithMutex() {
    let client;

    try {
      client = await pool.connect();

      // ── Abrir transação dedicada para o lock ──
      await client.query('BEGIN');

      // pg_try_advisory_xact_lock = lock TRANSACIONAL (auto-release no COMMIT/ROLLBACK)
      const lockResult = await client.query(
        'SELECT pg_try_advisory_xact_lock($1) as acquired', [lockId]
      );

      if (!lockResult.rows[0].acquired) {
        console.log(`⏭️ [CronMutex] Job "${jobName}" já em execução em outra instância — pulando (${processId})`);
        try { await client.query('ROLLBACK'); } catch (_) {}
        try { client.release(); } catch (_) {}
        return;
      }

      console.log(`🔒 [CronMutex] Lock adquirido para "${jobName}" (lockId=${lockId}, ${processId})`);

      // ── Executar o job com timeout ──
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout: job "${jobName}" excedeu ${timeoutMs}ms`)), timeoutMs);
      });

      await Promise.race([fn(), timeoutPromise]);

      console.log(`✅ [CronMutex] Job "${jobName}" concluído (${processId})`);

    } catch (error) {
      console.error(`❌ [CronMutex] Erro no job "${jobName}" (${processId}):`, error.message);
    } finally {
      // ── Liberar lock via COMMIT (ou ROLLBACK se COMMIT falhar) ──
      if (client) {
        try {
          await client.query('COMMIT');
        } catch (commitErr) {
          try { await client.query('ROLLBACK'); } catch (_) {}
        }

        // Liberar conexão de volta ao pool
        try {
          client.release();
        } catch (releaseErr) {
          // Se release falhar, destruir a conexão para não poluir o pool
          try { client.release(true); } catch (_) {}
          console.warn(`⚠️ [CronMutex] Conexão destruída para "${jobName}" — release falhou`);
        }
      }
    }
  };
}

/**
 * Força liberação de TODOS os advisory locks na sessão atual.
 * Chamar no startup do server para limpar locks órfãos de deploys anteriores.
 */
async function liberarLocksOrfaos(pool) {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_unlock_all()');
      console.log('🧹 [CronMutex] Advisory locks órfãos liberados nesta sessão');
    } finally {
      try { client.release(); } catch (_) {}
    }
  } catch (e) {
    console.warn('⚠️ [CronMutex] Falha ao liberar locks órfãos:', e.message);
  }
}

module.exports = { withCronLock, getLockId, liberarLocksOrfaos };
