/**
 * MODULO LOGISTICS - Migration Extraviados
 *
 * "Extraviado" e um MARCADOR, nao um status canonico.
 *
 * POR QUE MARCADOR E NAO STATUS:
 *   status_canonico e status_native sao escritos pelos webhooks do provedor
 *   (Uber/99). Se "extraviado" virasse status, o proximo webhook sobrescreveria
 *   a marcacao do admin. Como coluna separada, o marcador e soberano e
 *   independente — o provedor continua atualizando o status dele normalmente,
 *   e o kanban decide a coluna olhando o marcador primeiro.
 *
 * Marcar extraviado NAO cancela a corrida no provedor (cancelamento so via
 * orch.cancel -> adapter.cancelDelivery).
 *
 * Colunas em logistics_deliveries:
 *   - extraviado_em     TIMESTAMP  -> NULL = nao extraviado (fonte da verdade)
 *   - extraviado_por    VARCHAR    -> quem marcou (nome/email do admin)
 *   - extraviado_motivo TEXT       -> opcional, texto livre. Interno: a loja
 *                                     ve so o selo, nunca o motivo.
 *
 * Idempotente: ADD COLUMN IF NOT EXISTS.
 * Marker: EXTRAVIADOS_MIGRATION_V1
 */

'use strict';

async function initLogisticsExtraviadosTables(pool) {
  await pool.query(
    `ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS extraviado_em TIMESTAMP`
  ).catch(e => console.warn('[logistics] extraviado_em:', e.message));

  await pool.query(
    `ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS extraviado_por VARCHAR(160)`
  ).catch(e => console.warn('[logistics] extraviado_por:', e.message));

  await pool.query(
    `ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS extraviado_motivo TEXT`
  ).catch(e => console.warn('[logistics] extraviado_motivo:', e.message));

  // Indice parcial: a coluna Extraviados do kanban filtra por NOT NULL, que e
  // sempre uma fatia minima do total.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_logdeliv_extraviado
       ON logistics_deliveries (extraviado_em)
      WHERE extraviado_em IS NOT NULL`
  ).catch(e => console.warn('[logistics] idx extraviado:', e.message));
}

module.exports = { initLogisticsExtraviadosTables };
