/**
 * MODULO LOGISTICS - Migration Portal do Cliente (loja)
 *
 * Adiciona o acesso da loja DIRETO na regra de despacho (1 login por regra).
 * Colunas em logistics_dispatch_rules:
 *   - portal_login       VARCHAR(60)  -> login da loja (unico, case-insensitive)
 *   - portal_senha_hash  TEXT         -> bcrypt da senha
 *   - portal_ativo       BOOLEAN      -> liga/desliga o acesso sem apagar credencial
 *
 * Idempotente: ADD COLUMN IF NOT EXISTS + UNIQUE INDEX IF NOT EXISTS.
 * Marker: PORTAL_CLIENTE_MIGRATION_V1
 */

'use strict';

async function initLogisticsPortalTables(pool) {
  await pool.query(
    `ALTER TABLE logistics_dispatch_rules ADD COLUMN IF NOT EXISTS portal_login VARCHAR(60)`
  ).catch(() => {});
  await pool.query(
    `ALTER TABLE logistics_dispatch_rules ADD COLUMN IF NOT EXISTS portal_senha_hash TEXT`
  ).catch(() => {});
  await pool.query(
    `ALTER TABLE logistics_dispatch_rules ADD COLUMN IF NOT EXISTS portal_ativo BOOLEAN DEFAULT false`
  ).catch(() => {});

  // Login unico por regra (case-insensitive), so quando preenchido.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_logrule_portal_login
       ON logistics_dispatch_rules (LOWER(portal_login))
      WHERE portal_login IS NOT NULL`
  ).catch(() => {});
}

module.exports = { initLogisticsPortalTables };
