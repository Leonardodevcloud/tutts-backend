/**
 * MÓDULO LOGISTICS — ProviderRegistry
 *
 * Singleton em memória que mantém o mapa de adapters instanciados.
 *
 * Bootstrap (chamado pelo index.js durante init):
 *  1. Lê linhas de logistics_providers
 *  2. Para cada linha com ativo=true, instancia o AdapterClass correspondente
 *  3. Guarda em this._adapters indexado por provider_code
 *
 * Reload (chamado por PUT /providers/{code}/config):
 *  1. Re-lê config da tabela
 *  2. Re-instancia o adapter daquele provider só (sem afetar os outros)
 *
 * IMPORTANTE: providers cadastrados em logistics_providers MAS sem AdapterClass
 * registrado em código viram entry com erro (loga warning, não derruba). Isso
 * permite, por exemplo, criar um registro 'noventanove' no banco antes do
 * NinetyNineAdapter estar implementado (Fase 3) — o GET /providers lista o
 * registro, mas POST /quotes pra ele retorna 503.
 */

class ProviderRegistry {
  constructor(pool) {
    this.pool = pool;
    /** @type {Map<string, {AdapterClass: any, options: any}>} */
    this._classes = new Map();
    /** @type {Map<string, import('../contracts/LogisticsProviderAdapter').LogisticsProviderAdapter>} */
    this._adapters = new Map();
    /** @type {Map<string, Object>} */
    this._providerRows = new Map();
    this._initialized = false;
  }

  /**
   * Registra uma classe de adapter. Chamado pelo index.js no bootstrap,
   * ANTES de carregar os providers do banco.
   *
   * Ex: registry.registerClass('uber', UberAdapter);
   *
   * @param {string} providerCode
   * @param {Function} AdapterClass - Subclasse de LogisticsProviderAdapter
   */
  registerClass(providerCode, AdapterClass) {
    if (this._classes.has(providerCode)) {
      console.warn(`⚠️  [ProviderRegistry] classe '${providerCode}' já registrada — sobrescrevendo`);
    }
    this._classes.set(providerCode, { AdapterClass });
  }

  /**
   * Carrega providers do banco e instancia adapters ativos.
   * Chamado UMA vez no bootstrap, depois de registerClass().
   */
  async initialize() {
    if (this._initialized) return;

    try {
      const { rows } = await this.pool.query(`
        SELECT provider_code, display_name, ativo, sandbox_mode, config, capabilities, webhook_secret, prioridade
        FROM logistics_providers
        ORDER BY prioridade ASC, provider_code ASC
      `);

      for (const row of rows) {
        this._providerRows.set(row.provider_code, row);

        if (!row.ativo) {
          console.log(`ℹ️  [ProviderRegistry] '${row.provider_code}' inativo — não instanciado`);
          continue;
        }

        this._instantiate(row);
      }

      this._initialized = true;
      console.log(`✅ [ProviderRegistry] inicializado: ${this._adapters.size} adapter(s) ativo(s) de ${rows.length} cadastrado(s)`);
    } catch (err) {
      console.error('❌ [ProviderRegistry] falha ao inicializar:', err.message);
      this._initialized = true;  // marca como inicializado para não tentar de novo em loop
    }
  }

  _instantiate(row) {
    const reg = this._classes.get(row.provider_code);
    if (!reg) {
      console.warn(`⚠️  [ProviderRegistry] '${row.provider_code}' está ativo no banco mas não tem AdapterClass registrada — pulando`);
      return;
    }

    try {
      const adapter = new reg.AdapterClass({
        pool: this.pool,
        config: row.config || {},
        capabilities: row.capabilities || {},
        webhookSecret: row.webhook_secret || null,
        sandboxMode: !!row.sandbox_mode,
      });

      // Sanity check: getter providerCode deve bater
      if (adapter.providerCode !== row.provider_code) {
        console.error(`❌ [ProviderRegistry] '${row.provider_code}': adapter.providerCode='${adapter.providerCode}' não bate com banco`);
        return;
      }

      this._adapters.set(row.provider_code, adapter);
      console.log(`✅ [ProviderRegistry] '${row.provider_code}' instanciado (sandbox=${!!row.sandbox_mode})`);
    } catch (err) {
      console.error(`❌ [ProviderRegistry] erro ao instanciar '${row.provider_code}':`, err.message);
    }
  }

  /**
   * Recarrega um provider específico (útil após PUT /providers/{code}/config).
   *
   * @param {string} providerCode
   */
  async reload(providerCode) {
    const { rows } = await this.pool.query(
      'SELECT * FROM logistics_providers WHERE provider_code = $1',
      [providerCode]
    );
    if (rows.length === 0) {
      this._providerRows.delete(providerCode);
      this._adapters.delete(providerCode);
      return;
    }
    const row = rows[0];
    this._providerRows.set(providerCode, row);
    this._adapters.delete(providerCode);
    if (row.ativo) {
      this._instantiate(row);
    }
  }

  /**
   * Retorna o adapter ativo daquele provider, ou null.
   *
   * @param {string} providerCode
   * @returns {import('../contracts/LogisticsProviderAdapter').LogisticsProviderAdapter | null}
   */
  get(providerCode) {
    return this._adapters.get(providerCode) || null;
  }

  /**
   * @param {string} providerCode
   * @returns {boolean}
   */
  has(providerCode) {
    return this._adapters.has(providerCode);
  }

  /**
   * Lista todos os adapters ativos (instâncias).
   * @returns {import('../contracts/LogisticsProviderAdapter').LogisticsProviderAdapter[]}
   */
  listActive() {
    return Array.from(this._adapters.values());
  }

  /**
   * Lista os codes de todos os providers ativos.
   * @returns {string[]}
   */
  listActiveCodes() {
    return Array.from(this._adapters.keys());
  }

  /**
   * Lista TODOS os providers cadastrados (ativos e inativos), sem segredos.
   * Usado pelo endpoint GET /api/logistics/providers.
   *
   * @returns {Array<{provider_code: string, display_name: string, ativo: boolean,
   *                  sandbox_mode: boolean, capabilities: Object, prioridade: number,
   *                  has_adapter_class: boolean, instanciado: boolean}>}
   */
  listAll() {
    return Array.from(this._providerRows.values()).map(row => ({
      provider_code: row.provider_code,
      display_name: row.display_name,
      ativo: row.ativo,
      sandbox_mode: row.sandbox_mode,
      capabilities: row.capabilities || {},
      prioridade: row.prioridade,
      has_adapter_class: this._classes.has(row.provider_code),
      instanciado: this._adapters.has(row.provider_code),
    }));
  }
}

// ════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════
let _instance = null;

/**
 * Retorna a instância singleton. Cria na primeira chamada.
 *
 * @param {import('pg').Pool} pool
 * @returns {ProviderRegistry}
 */
function getProviderRegistry(pool) {
  if (!_instance) {
    if (!pool) throw new Error('ProviderRegistry: pool obrigatório na primeira chamada');
    _instance = new ProviderRegistry(pool);
  }
  return _instance;
}

module.exports = { ProviderRegistry, getProviderRegistry };
