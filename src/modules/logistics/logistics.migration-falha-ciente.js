'use strict';

// [hub-falha-alerta-v1] Estado "ciente" das falhas do Hub.
// Quando uma corrida falha (status FAILED/FALLBACK_QUEUE), o admin ve um modal
// de alerta e clica "Confirmar ciente". A partir dai a falha nao reabre modal
// pra NENHUM admin (o marcador vale pra todos) e fica registrado quem confirmou.
//   - falha_ciente_em   TIMESTAMP -> NULL = ninguem confirmou ainda (dispara modal)
//   - falha_ciente_por  VARCHAR   -> nome/email do admin que deu o OK
async function initLogisticsFalhaCienteTables(pool) {
  await pool.query(
    `ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS falha_ciente_em TIMESTAMP`
  ).catch(e => console.warn('[logistics] falha_ciente_em:', e.message));

  await pool.query(
    `ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS falha_ciente_por VARCHAR(160)`
  ).catch(e => console.warn('[logistics] falha_ciente_por:', e.message));

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_logdeliv_falha_ciente
       ON logistics_deliveries (falha_ciente_em)
      WHERE falha_ciente_em IS NULL`
  ).catch(e => console.warn('[logistics] idx falha_ciente:', e.message));
}

module.exports = { initLogisticsFalhaCienteTables };
