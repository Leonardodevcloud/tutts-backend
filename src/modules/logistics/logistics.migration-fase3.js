/**
 * MÓDULO LOGISTICS — Migration Fase 3: provider 'noventanove'
 *
 * Adiciona a linha do provider 99 (provider_code='noventanove') na tabela
 * logistics_providers, com config VAZIA pra você preencher depois de rodar
 * os curls de descoberta (ver README-FASE-3).
 *
 * É IDEMPOTENTE: ON CONFLICT (provider_code) DO NOTHING. Roda quantas vezes
 * quiser — só insere se ainda não existe. Se você já preencheu a config e
 * rodar de novo, NÃO sobrescreve (o DO NOTHING protege seus dados).
 *
 * O provider nasce com:
 *  - ativo = false        → não é instanciado pelo ProviderRegistry até você ligar
 *  - sandbox_mode = true  → começa apontando pro sandbox da 99 (v1)
 *  - config com chaves vazias → você preenche: api_key, employee_id,
 *    cost_center_id, project_id, webhook_username, webhook_password
 *
 * Pra ativar (depois de preencher a config):
 *   UPDATE logistics_providers
 *   SET ativo = true, config = config || '{...suas chaves...}'::jsonb
 *   WHERE provider_code = 'noventanove';
 *
 * NÃO toca em nada existente — uber, tabelas, regras: tudo intacto.
 */

/**
 * Insere o provider 'noventanove' se ainda não existir.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{inserido: boolean}>}
 */
async function migrarProviderNoventaNove(pool) {
  const { rowCount } = await pool.query(`
    INSERT INTO logistics_providers (
      provider_code, display_name, ativo, sandbox_mode, prioridade,
      config, capabilities, webhook_secret
    )
    VALUES (
      'noventanove',
      '99',
      false,   -- começa DESATIVADO — ativação manual após preencher config
      true,    -- começa em SANDBOX (aponta pro sandbox-api-corp.99app.com/v1)
      20,      -- prioridade: depois do uber (10), mas isso só importa em estratégias multi-provider
      jsonb_build_object(
        'api_key',          '',
        'employee_id',      '',
        'cost_center_id',   '',
        'project_id',       '',
        'webhook_username', '',
        'webhook_password', ''
      ),
      jsonb_build_object(
        'supportsQuote',               true,
        'supportsCancel',              true,
        'supportsRedispatch',          true,
        'supportsRealtimeTracking',    true,
        'vehicleTypes',                jsonb_build_array('motorcycle','car','van'),
        'coverageRegion',              jsonb_build_array('BR'),
        'webhookAuthScheme',           'basic-auth',
        'requiresExternalRefAsString', false,
        'quoteIsReusable',             false,
        'quoteIsRange',                true
      ),
      NULL   -- 99 usa Basic Auth (webhook_username/password no config), não webhook_secret
    )
    ON CONFLICT (provider_code) DO NOTHING
  `);

  if (rowCount > 0) {
    console.log('✅ [logistics/fase3] provider "noventanove" (99) inserido — config VAZIA, preencha via curls de descoberta');
  } else {
    console.log('ℹ️  [logistics/fase3] provider "noventanove" já existe — config preservada (não sobrescrito)');
  }

  return { inserido: rowCount > 0 };
}

/**
 * Orquestra a migration da Fase 3.
 * Chamada pelo index.js dentro de initLogisticsTables.
 *
 * @param {import('pg').Pool} pool
 */
async function initLogisticsFase3(pool) {
  await migrarProviderNoventaNove(pool);
}

module.exports = {
  initLogisticsFase3,
  migrarProviderNoventaNove,
};
