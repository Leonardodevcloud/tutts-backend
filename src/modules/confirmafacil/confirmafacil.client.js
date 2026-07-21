'use strict';

/**
 * MÓDULO CONFIRMAFÁCIL — Client HTTP
 *
 * Encapsula as duas chamadas de saída para a API CF:
 *  - enviarEmbarque(token, array)    → POST /business/v2/embarque
 *  - enviarLocalizacao(token, body)  → POST /rastreamento/localizacao
 *
 * Limite da API: 20 objetos por request no embarque.
 * Este client faz o chunking automaticamente.
 */

const httpRequest = require('../../shared/utils/httpRequest');

const CF_EMBARQUE_URL    = 'https://utilities.confirmafacil.com.br/business/v2/embarque';
const CF_LOCALIZACAO_URL = 'https://utilities.confirmafacil.com.br/rastreamento/localizacao';
const CHUNK_SIZE          = 20;

class ConfirmaFacilClient {
  /**
   * Envia array de embarques/ocorrências para o CF.
   * Divide automaticamente em lotes de 20.
   *
   * @param {string} token
   * @param {Array<Object>} itens  — array de CamposEmbarqueDTO
   * @returns {Promise<Array<{ok, status, body}>>}  — resultado de cada lote
   */
  async enviarEmbarque(token, itens) {
    if (!Array.isArray(itens) || itens.length === 0) return [];

    const resultados = [];

    for (let i = 0; i < itens.length; i += CHUNK_SIZE) {
      const lote = itens.slice(i, i + CHUNK_SIZE);
      const numLote = i / CHUNK_SIZE + 1;
      // [cf-envio-retry-v1] retry na hora: HTTP 0 (falha de conexao/timeout) e
      // 5xx (erro do servidor CF) sao transitorios -> tenta de novo com backoff
      // 2s, 4s, 8s, 16s, 30s. Erros 4xx (payload/regra) NAO re-tentam (nao
      // adianta insistir num pedido invalido).
      const ESPERAS_MS = [2000, 4000, 8000, 16000, 30000];
      let resultado = null;
      for (let tentativa = 0; tentativa <= ESPERAS_MS.length; tentativa++) {
        try {
          const resp = await httpRequest(CF_EMBARQUE_URL, {
            method:  'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': token,
            },
            body: JSON.stringify(lote),
          });

          const status = resp.status;
          let body = null;
          try { body = resp.json(); } catch (_) { body = resp.text(); }

          const ok = status >= 200 && status < 300;
          resultado = { ok, status, body, lote: numLote };

          // sucesso OU erro definitivo (4xx) -> para de tentar
          if (ok || (status >= 400 && status < 500)) {
            if (!ok) {
              console.warn(`⚠️ [CF Client] /embarque lote ${numLote} retornou ${status} (nao re-tenta):`, JSON.stringify(body).slice(0, 200));
            } else if (tentativa > 0) {
              console.log(`✅ [CF Client] /embarque lote ${numLote} OK na tentativa ${tentativa + 1}`);
            }
            break;
          }
          // status 0 (conexao) ou 5xx -> transitorio, vai re-tentar
          console.warn(`⚠️ [CF Client] /embarque lote ${numLote} status ${status} (transitorio, tentativa ${tentativa + 1})`);
        } catch (err) {
          resultado = { ok: false, status: 0, body: null, erro: err.message, lote: numLote };
          console.error(`❌ [CF Client] /embarque lote ${numLote} falhou (tentativa ${tentativa + 1}):`, err.message);
        }

        // se ainda ha tentativas, espera o backoff antes da proxima
        if (tentativa < ESPERAS_MS.length) {
          await new Promise(r => setTimeout(r, ESPERAS_MS[tentativa]));
        }
      }
      resultados.push(resultado);
    }

    return resultados;
  }

  /**
   * Envia geolocalização do motoboy para o CF.
   *
   * @param {string} token
   * @param {{
   *   placa: string,
   *   latitude: string,
   *   longitude: string,
   *   dataFormatada?: string,
   *   notas: Array<{ numero, serie, cnpjEmbarcador }>
   * }} payload
   * @returns {Promise<{ok, status, body}>}
   */
  async enviarLocalizacao(token, payload) {
    try {
      const resp = await httpRequest(CF_LOCALIZACAO_URL, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
        },
        body: JSON.stringify(payload),
      });

      const status = resp.status;
      let body = null;
      try { body = resp.json(); } catch (_) { body = resp.text(); }

      return { ok: status >= 200 && status < 300, status, body };
    } catch (err) {
      console.error('❌ [CF Client] /localizacao falhou:', err.message);
      return { ok: false, status: 0, body: null, erro: err.message };
    }
  }
}

// Singleton
let _instancia = null;
function getConfirmaFacilClient() {
  if (!_instancia) _instancia = new ConfirmaFacilClient();
  return _instancia;
}

module.exports = { getConfirmaFacilClient };
