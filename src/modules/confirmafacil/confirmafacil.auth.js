'use strict';

/**
 * MÓDULO CONFIRMAFÁCIL — Auth
 *
 * O token do CF é válido até 23:59:59 do mesmo dia.
 * Estratégia: um cache por cliente_id. Se o token expirou
 * (passou da meia-noite ou ainda não existe), faz novo login.
 *
 * Singleton por pool: getConfirmaFacilAuth(pool) sempre retorna
 * a mesma instância (evita logins paralelos desnecessários).
 */

const httpRequest = require('../../shared/utils/httpRequest');

const CF_LOGIN_URL = 'https://utilities.confirmafacil.com.br/login/login';

class ConfirmaFacilAuth {
  constructor() {
    // Map<cliente_id, { token, validoAte: Date }>
    this._cache = new Map();
  }

  /**
   * Retorna token válido para o cliente.
   * Faz login automático se não existe ou expirou.
   *
   * @param {number} clienteId
   * @param {{ cf_email, cf_senha, cf_id_cliente }} config
   * @returns {Promise<string>} token JWT
   */
  async obterToken(clienteId, config) {
    const agora = new Date();
    const cached = this._cache.get(clienteId);

    // Token ainda válido (antes de 23:59:59 de hoje)
    if (cached && agora < cached.validoAte) {
      return cached.token;
    }

    // Login
    // idcliente só é obrigatório quando o usuário acessa mais de uma empresa no CF.
    // Se não informado (ou 0), a API retorna o token direto com o único cliente vinculado.
    const body = { email: config.cf_email, senha: config.cf_senha };
    if (config.cf_id_cliente && Number(config.cf_id_cliente) !== 0) {
      body.idcliente = Number(config.cf_id_cliente);
      body.idproduto = config.cf_id_produto || 1;
    }

    const resp = await httpRequest(CF_LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const data = resp.json();

    if (!data?.resposta?.token) {
      throw new Error(`[CF Auth] Login falhou para cliente ${clienteId}: ${data?.mensagem || 'resposta inválida'}`);
    }

    const token = data.resposta.token;

    // Validade: fim do dia corrente (23:59:58 — 2s de margem)
    const validoAte = new Date();
    validoAte.setHours(23, 59, 58, 0);

    this._cache.set(clienteId, { token, validoAte });
    console.log(`🔑 [CF Auth] Token renovado para cliente ${clienteId} (válido até ${validoAte.toLocaleTimeString('pt-BR')})`);

    return token;
  }

  /** Invalida o cache de um cliente (útil após troca de senha). */
  invalidar(clienteId) {
    this._cache.delete(clienteId);
  }
}

// Singleton
let _instancia = null;
function getConfirmaFacilAuth() {
  if (!_instancia) _instancia = new ConfirmaFacilAuth();
  return _instancia;
}

module.exports = { getConfirmaFacilAuth };
