/**
 * MÓDULO LOGISTICS — MappClient
 *
 * Encapsula todas as chamadas para a API Mapp/Tutts. É a ÚNICA ponte entre
 * o hub e a Mapp — adapters NÃO podem chamar a Mapp diretamente.
 *
 * Fase 1A: implementação real, extraída verbatim de src/modules/uber/uber.service.js
 * (funções mappListarServicos, mappAlterarStatus, mappVincularMotorista,
 *  mappInformarChegada, mappFinalizarEndereco, mappFinalizarServico,
 *  mappRespostaOK, mappPayload).
 *
 * Comportamento preservado 100%. Apenas mudanças:
 *  - Lê config de logistics_providers PRIMEIRO, fallback uber_config se faltar
 *    (compatibilidade durante migração — Fase 0 backfillou mas pode ter divergência)
 *  - Cache em memória da config (TTL 60s) — evita query a cada chamada Mapp
 *  - invalidateConfigCache() para forçar reload após PUT /providers/uber/config
 *
 * Quem o usa nesta fase:
 *  - uber.service.js (via facades — as funções mapp* antigas agora delegam aqui)
 *  - UberAdapter (Fase 1B)
 *  - Webhook dispatcher (Fase 1B)
 */

const httpRequest = require('../../../shared/utils/httpRequest');

class MappClient {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
    this._configCache = null;
    this._cacheUpdatedAt = 0;
    this._CACHE_TTL_MS = 60_000;
  }

  // ════════════════════════════════════════════════════════════
  // CONFIG — busca config Mapp com fallback duplo
  // ════════════════════════════════════════════════════════════

  /**
   * Retorna { mapp_api_url, mapp_api_token }.
   *
   * Estratégia:
   *  1. Tenta logistics_providers.config (provider 'uber') — fonte canônica nova
   *  2. Se faltar URL ou token, fallback pra uber_config (fonte legada)
   *  3. Cache em memória 60s
   *
   * Lança Error se nenhuma das duas tiver config completa.
   *
   * @returns {Promise<{mapp_api_url: string, mapp_api_token: string}>}
   */
  async _obterConfigMapp() {
    const agora = Date.now();
    if (this._configCache && (agora - this._cacheUpdatedAt) < this._CACHE_TTL_MS) {
      return this._configCache;
    }

    let mapp_api_url = null;
    let mapp_api_token = null;

    // Tentativa 1: logistics_providers (canônico)
    try {
      const { rows } = await this.pool.query(`
        SELECT config FROM logistics_providers WHERE provider_code = 'uber' LIMIT 1
      `);
      if (rows[0]?.config) {
        mapp_api_url = rows[0].config.mapp_api_url || null;
        mapp_api_token = rows[0].config.mapp_api_token || null;
      }
    } catch (err) {
      // Se logistics_providers ainda não foi criada (deploy parcial), só loga e cai pro fallback
      console.warn('[MappClient] logistics_providers indisponível, usando uber_config:', err.message);
    }

    // Tentativa 2: fallback uber_config (legado, sempre existe enquanto Fase 6 não rolou)
    if (!mapp_api_url || !mapp_api_token) {
      try {
        const { rows } = await this.pool.query('SELECT mapp_api_url, mapp_api_token FROM uber_config WHERE id = 1');
        if (rows[0]) {
          mapp_api_url = mapp_api_url || rows[0].mapp_api_url;
          mapp_api_token = mapp_api_token || rows[0].mapp_api_token;
        }
      } catch (err) {
        // Ignora — vai cair no throw abaixo
      }
    }

    if (!mapp_api_url || !mapp_api_token) {
      throw new Error('MappClient: mapp_api_url e mapp_api_token não configurados (nem em logistics_providers nem em uber_config)');
    }

    this._configCache = { mapp_api_url, mapp_api_token };
    this._cacheUpdatedAt = agora;
    return this._configCache;
  }

  /**
   * Invalida o cache. Chamado após PUT /providers/uber/config ou
   * PUT /uber/config (porque o legado também afeta a fonte do fallback).
   */
  invalidateConfigCache() {
    this._configCache = null;
    this._cacheUpdatedAt = 0;
  }

  // ════════════════════════════════════════════════════════════
  // HELPERS DE ENVELOPE — extraídos verbatim de uber.service.js:92-107
  // ════════════════════════════════════════════════════════════

  /**
   * Verifica se uma resposta da API Mapp foi sucesso.
   * A Mapp sempre retorna { status: '200', dados: { status: true|false, dados: {...} }, msgUsuario }
   * O verdadeiro indicador é o boolean dados.status (interno).
   */
  respostaOK(resp) {
    if (!resp || typeof resp !== 'object') return false;
    if (String(resp.status) !== '200') return false;
    // O envelope interno tem o boolean status === true quando deu certo
    if (resp.dados?.status === true) return true;
    if (resp.dados?.status === 'true') return true;
    return false;
  }

  /**
   * Extrai o payload "real" de uma resposta Mapp (lida com double-nesting).
   * Ex: { dados: { dados: { codigoOS: 123 } } } → { codigoOS: 123 }
   */
  payload(resp) {
    return resp?.dados?.dados || resp?.dados || {};
  }

  // ════════════════════════════════════════════════════════════
  // CHAMADAS MAPP — extraídas verbatim de uber.service.js:109-211
  // ════════════════════════════════════════════════════════════

  async listarServicos(status = 0, ultimoId = 0) {
    const config = await this._obterConfigMapp();

    const url = `${config.mapp_api_url}/integracao-app-externos/listarServicos?status=${status}&ultimoId=${ultimoId}`;
    const resp = await httpRequest(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
    });

    const data = resp.json();
    if (data.status === '401') {
      throw new Error('Token Mapp inválido ou integração desativada');
    }

    // FIX: A API Mapp retorna estrutura double-nested { dados: { dados: { servicos: [...] } } }
    // Aceitamos os dois formatos pra robustez (caso a Mapp normalize no futuro).
    const servicos = data?.dados?.dados?.servicos || data?.dados?.servicos || [];
    return Array.isArray(servicos) ? servicos : [];
  }

  async alterarStatus(codigoOS, status) {
    const config = await this._obterConfigMapp();
    const url = `${config.mapp_api_url}/integracao-app-externos/alterarStatus`;

    const resp = await httpRequest(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
      body: JSON.stringify({ codigoOS, status }),
    });

    const data = resp.json();
    console.log(`📡 [Mapp] alterarStatus OS=${codigoOS} → ${status}:`, data.msgUsuario);
    return data;
  }

  async vincularMotorista(codigoOS, profissional) {
    const config = await this._obterConfigMapp();
    const url = `${config.mapp_api_url}/integracao-app-externos/vincularMotorista`;

    const resp = await httpRequest(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
      body: JSON.stringify({ codigoOS, profissional }),
    });

    const data = resp.json();
    console.log(`📡 [Mapp] vincularMotorista OS=${codigoOS}:`, data.msgUsuario);
    return data;
  }

  async informarChegada(codigoOS, ponto, lat, long) {
    const config = await this._obterConfigMapp();
    const url = `${config.mapp_api_url}/integracao-app-externos/informarChegada`;

    const payload = { codigoOS, ponto };
    if (lat && long) { payload.lat = lat; payload.long = long; }

    const resp = await httpRequest(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
      body: JSON.stringify(payload),
    });

    const data = resp.json();
    console.log(`📡 [Mapp] informarChegada OS=${codigoOS} ponto=${ponto}:`, data.msgUsuario);
    return data;
  }

  async finalizarEndereco(codigoOS, ponto, lat, long) {
    const config = await this._obterConfigMapp();
    const url = `${config.mapp_api_url}/integracao-app-externos/informarFinalizacaoEndereco`;

    const payload = { codigoOS, ponto };
    if (lat && long) { payload.lat = lat; payload.long = long; }

    const resp = await httpRequest(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
      body: JSON.stringify(payload),
    });

    const data = resp.json();
    console.log(`📡 [Mapp] finalizarEndereco OS=${codigoOS} ponto=${ponto}:`, data.msgUsuario);
    return data;
  }

  async finalizarServico(codigoOS) {
    const config = await this._obterConfigMapp();
    const url = `${config.mapp_api_url}/integracao-app-externos/finalizarServico`;

    const resp = await httpRequest(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${config.mapp_api_token}` },
      body: JSON.stringify({ codigoOS }),
    });

    const data = resp.json();
    console.log(`📡 [Mapp] finalizarServico OS=${codigoOS}:`, data.msgUsuario);
    return data;
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
