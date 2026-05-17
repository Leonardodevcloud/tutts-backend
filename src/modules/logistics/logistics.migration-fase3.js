/**
 * MÓDULO LOGISTICS — Migration Fase 3: provider 'noventanove' (99Entrega)
 *
 * ⚠️ ATUALIZADO 2026-05 — esta migration agora semeia a config no formato da
 * API 99Entrega (OAuth client_credentials), e não mais da "99 Corp API".
 *
 * Faz duas coisas, ambas IDEMPOTENTES (rodam quantas vezes quiser):
 *
 *  1. INSERT do provider 'noventanove' se ainda não existir
 *     (ON CONFLICT DO NOTHING — não sobrescreve config preenchida).
 *
 *  2. UPGRADE da linha já existente pro novo schema 99Entrega:
 *     - remove chaves legadas da "99 Corp API" (api_key, employee_id, etc.)
 *     - adiciona as chaves novas que faltarem, COM defaults, SEM sobrescrever
 *       valores já preenchidos pelo usuário (merge "defaults || config_atual"
 *       → config atual vence)
 *     - corrige `capabilities` e `display_name` pro novo formato
 *     Isso é seguro pra repos que já rodaram a versão antiga da migration.
 *
 * O provider nasce/permanece:
 *  - ativo = false        → não é instanciado até você ligar pelo painel
 *  - sandbox_mode = true  → começa em sandbox
 *
 * Config (preencher pelo painel Provedores → 99Entrega):
 *  - client_id, client_secret  → credenciais OAuth da 99Entrega
 *  - telefone_suporte          → fallback de telefone (OS sem telefone)
 *  - package_type/package_weight → padrões do pacote (create exige)
 *  - need_pickup_code/need_dropoff_code → toggles de código de verificação
 *  - cancel_reason_id          → reason_id default pro cancelamento
 *  webhook_secret (coluna top-level) → HMAC do webhook; se vazio, usa client_secret.
 *
 * NÃO toca em nada de outros providers — uber, tabelas, regras: tudo intacto.
 */

// Defaults da config 99Entrega — usados tanto no INSERT quanto no merge do UPGRADE.
const CONFIG_DEFAULTS_99 = {
  client_id: '',
  client_secret: '',
  telefone_suporte: '',
  package_type: 'documents',
  package_weight: '1kg',
  need_pickup_code: false,
  need_dropoff_code: false,
  cancel_reason_id: 410013,
};

// Capabilities da 99Entrega (formato delivery / OAuth / HMAC).
const CAPABILITIES_99 = {
  supportsQuote: true,
  supportsCancel: true,
  supportsRedispatch: true,
  supportsRealtimeTracking: false,   // webhook da 99 não traz posição
  vehicleTypes: ['motorcycle'],
  coverageRegion: ['BR'],
  webhookAuthScheme: 'hmac-sha256',
  requiresExternalRefAsString: true,
  quoteIsReusable: true,
  quoteIsRange: false,
};

// Chaves legadas da "99 Corp API" — removidas no UPGRADE.
const CHAVES_LEGADAS = [
  'api_key', 'employee_id', 'cost_center_id', 'project_id',
  'webhook_username', 'webhook_password',
];

/**
 * Insere o provider 'noventanove' se ainda não existir.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{inserido: boolean}>}
 */
async function inserirProviderNoventaNove(pool) {
  const { rowCount } = await pool.query(`
    INSERT INTO logistics_providers (
      provider_code, display_name, ativo, sandbox_mode, prioridade,
      config, capabilities, webhook_secret
    )
    VALUES (
      'noventanove',
      '99Entrega',
      false,   -- começa DESATIVADO — ativação manual após preencher config
      true,    -- começa em SANDBOX
      20,      -- prioridade: depois do uber (10) em estratégias multi-provider
      $1::jsonb,
      $2::jsonb,
      NULL     -- webhook_secret: opcional; se vazio o adapter usa o client_secret
    )
    ON CONFLICT (provider_code) DO NOTHING
  `, [JSON.stringify(CONFIG_DEFAULTS_99), JSON.stringify(CAPABILITIES_99)]);

  if (rowCount > 0) {
    console.log('✅ [logistics/fase3] provider "noventanove" (99Entrega) inserido — preencha client_id/client_secret no painel');
  }
  return { inserido: rowCount > 0 };
}

/**
 * Atualiza uma linha 'noventanove' já existente pro schema 99Entrega.
 * Idempotente e não-destrutivo: preserva valores de config já preenchidos.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{atualizado: boolean}>}
 */
async function upgradeProviderNoventaNove(pool) {
  // `config - 'k1' - 'k2' ...` remove as chaves legadas.
  // `defaults || (config_limpa)` faz o merge: o lado direito vence, então os
  // valores já preenchidos pelo usuário são preservados e só as chaves
  // faltantes recebem o default.
  const stripLegadas = CHAVES_LEGADAS.map(k => `- '${k}'`).join(' ');

  const { rowCount } = await pool.query(`
    UPDATE logistics_providers
    SET
      display_name = '99Entrega',
      capabilities = $1::jsonb,
      config = $2::jsonb || (config ${stripLegadas}),
      updated_at = NOW()
    WHERE provider_code = 'noventanove'
  `, [JSON.stringify(CAPABILITIES_99), JSON.stringify(CONFIG_DEFAULTS_99)]);

  if (rowCount > 0) {
    console.log('ℹ️  [logistics/fase3] provider "noventanove" atualizado pro schema 99Entrega (config preenchida preservada)');
  }
  return { atualizado: rowCount > 0 };
}

/**
 * Orquestra a migration da Fase 3.
 * Chamada pelo index.js dentro de initLogisticsTables.
 *
 * @param {import('pg').Pool} pool
 */
async function initLogisticsFase3(pool) {
  await inserirProviderNoventaNove(pool);
  await upgradeProviderNoventaNove(pool);
}

module.exports = {
  initLogisticsFase3,
  inserirProviderNoventaNove,
  upgradeProviderNoventaNove,
  CONFIG_DEFAULTS_99,
  CAPABILITIES_99,
};
