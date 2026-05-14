/**
 * MÓDULO LOGISTICS — MappClient (STUB)
 *
 * Encapsula todas as chamadas para a API Mapp/Tutts. É a ÚNICA ponte entre
 * o hub e a Mapp — adapters NÃO podem chamar a Mapp diretamente. Quem
 * orquestra ações Mapp em resposta a status canônico é o core.
 *
 * ⚠️  FASE 0: implementação completa NÃO está aqui ainda.
 *
 * Na Fase 1, quando o UberAdapter for criado, as 6 funções abaixo serão
 * extraídas integralmente de src/modules/uber/uber.service.js:
 *  - mappListarServicos
 *  - mappAlterarStatus
 *  - mappVincularMotorista
 *  - mappInformarChegada
 *  - mappFinalizarEndereco
 *  - mappFinalizarServico
 *
 * Além dos helpers:
 *  - mappRespostaOK (validador do envelope { status, dados: { status: true/false } })
 *  - mappPayload (extrai dados.dados internos, normaliza double-nesting)
 *
 * A configuração da Mapp (mapp_api_url, mapp_api_token) vem de
 * logistics_providers.config para o provider 'uber' (mantém compatibilidade
 * com a estrutura atual). Quando 99 entrar, vai consumir a mesma config —
 * a Mapp é externa ao hub, não pertence a um provider específico.
 *
 * Por ora, o stub abaixo lança Error em qualquer chamada — propositalmente,
 * para que se alguém esquecer e tentar usar antes da Fase 1, falhe imediato.
 */

class MappClient {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
    this._mapppConfigCache = null;
    this._cacheUpdatedAt = 0;
  }

  /**
   * Lê config Mapp de logistics_providers (provider 'uber' por enquanto — a
   * Mapp config vive lá por questão de compatibilidade com a migração).
   *
   * Cache simples: válido por 60s para evitar query em cada chamada Mapp.
   *
   * @returns {Promise<{mapp_api_url: string, mapp_api_token: string}>}
   */
  async _obterConfigMapp() {
    const agora = Date.now();
    if (this._mapppConfigCache && (agora - this._cacheUpdatedAt) < 60_000) {
      return this._mapppConfigCache;
    }

    const { rows } = await this.pool.query(`
      SELECT config FROM logistics_providers WHERE provider_code = 'uber' LIMIT 1
    `);
    const cfg = rows[0]?.config || {};

    if (!cfg.mapp_api_url || !cfg.mapp_api_token) {
      throw new Error('MappClient: mapp_api_url e mapp_api_token não configurados em logistics_providers');
    }

    this._mapppConfigCache = {
      mapp_api_url: cfg.mapp_api_url,
      mapp_api_token: cfg.mapp_api_token,
    };
    this._cacheUpdatedAt = agora;
    return this._mapppConfigCache;
  }

  /**
   * Invalida o cache de config Mapp. Chamado após PUT /providers/uber/config.
   */
  invalidateConfigCache() {
    this._mapppConfigCache = null;
    this._cacheUpdatedAt = 0;
  }

  // ════════════════════════════════════════════════════════════
  // FASE 1 — métodos serão implementados extraindo de uber.service.js
  // ════════════════════════════════════════════════════════════

  async listarServicos(status = 0, ultimoId = 0) {
    throw new Error('MappClient.listarServicos: Fase 1 — implementação será extraída de uber.service.js:mappListarServicos');
  }

  async alterarStatus(codigoOS, status) {
    throw new Error('MappClient.alterarStatus: Fase 1');
  }

  async vincularMotorista(codigoOS, profissional) {
    throw new Error('MappClient.vincularMotorista: Fase 1');
  }

  async informarChegada(codigoOS, ponto, lat, lng) {
    throw new Error('MappClient.informarChegada: Fase 1');
  }

  async finalizarEndereco(codigoOS, ponto, lat, lng) {
    throw new Error('MappClient.finalizarEndereco: Fase 1');
  }

  async finalizarServico(codigoOS) {
    throw new Error('MappClient.finalizarServico: Fase 1');
  }

  // Helpers de envelope (serão extraídos junto)
  respostaOK(resp) {
    throw new Error('MappClient.respostaOK: Fase 1');
  }

  payload(resp) {
    throw new Error('MappClient.payload: Fase 1');
  }
}

// ════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════
let _instance = null;

/**
 * @param {import('pg').Pool} pool
 * @returns {MappClient}
 */
function getMappClient(pool) {
  if (!_instance) {
    if (!pool) throw new Error('MappClient: pool obrigatório na primeira chamada');
    _instance = new MappClient(pool);
  }
  return _instance;
}

module.exports = { MappClient, getMappClient };
