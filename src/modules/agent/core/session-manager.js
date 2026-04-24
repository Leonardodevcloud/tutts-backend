/**
 * core/session-manager.js
 * ─────────────────────────────────────────────────────────────────────────
 * Gerencia credenciais e arquivos de sessão (storageState do Playwright)
 * pra múltiplas contas no sistema externo.
 *
 * ESTRATÉGIAS DE SESSÃO:
 *
 *   'isolada'       — cada slot tem 1 conta dedicada. Recomendado quando
 *                     há 1 conta por slot disponível (1 IP, N navegadores =
 *                     N contas). Zero risco de conflito de sessão.
 *
 *   'compartilhada' — todos os slots usam o mesmo arquivo de sessão (1 conta).
 *                     Útil quando o sistema externo aguenta múltiplas sessões
 *                     da mesma conta. Risco: relogin numa instância pode
 *                     invalidar cookies das outras.
 *
 * NAMESPACE — cada agente tem seu próprio conjunto de arquivos de sessão.
 * Por exemplo, agente "sla-capture" e "agent-correcao" não compartilham
 * `/tmp/tutts-{namespace}-slot-N.json`. Isso preserva o isolamento que o
 * código antigo já tinha (eram 2 arquivos separados).
 *
 * VARIÁVEIS DE AMBIENTE:
 *
 *   SISTEMA_EXTERNO_EMAIL_1, SISTEMA_EXTERNO_SENHA_1   — conta 1
 *   SISTEMA_EXTERNO_EMAIL_2, SISTEMA_EXTERNO_SENHA_2   — conta 2
 *   ...até N
 *
 *   Fallback: se SISTEMA_EXTERNO_EMAIL_N não existir, cai pra
 *   SISTEMA_EXTERNO_EMAIL / SISTEMA_EXTERNO_SENHA (compatibilidade
 *   com configuração antiga de conta única).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('../../../config/logger');

const SESSION_DIR = '/tmp';

function log(msg) {
  logger.info(`[session-manager] ${msg}`);
}

/**
 * Retorna { email, senha } pra uma conta específica (1-indexada).
 * Se a numerada não existir, cai no fallback (conta única).
 *
 * @param {number} contaNum
 * @param {string} envPrefix — prefixo das vars (default 'SISTEMA_EXTERNO').
 *                             Use 'SISTEMA_EXTERNO_SLA' pra contas SLA.
 */
function obterCredenciais(contaNum, envPrefix = 'SISTEMA_EXTERNO') {
  const emailNumerado = process.env[`${envPrefix}_EMAIL_${contaNum}`];
  const senhaNumerada = process.env[`${envPrefix}_SENHA_${contaNum}`];

  if (emailNumerado && senhaNumerada) {
    return { email: emailNumerado, senha: senhaNumerada, fonte: `${envPrefix}_${contaNum}` };
  }

  // Fallback — conta única (compatibilidade com config antiga)
  const emailFallback = process.env[`${envPrefix}_EMAIL`];
  const senhaFallback = process.env[`${envPrefix}_SENHA`];

  if (emailFallback && senhaFallback) {
    return { email: emailFallback, senha: senhaFallback, fonte: `${envPrefix}_fallback` };
  }

  throw new Error(
    `Credenciais não encontradas: ${envPrefix}_EMAIL_${contaNum} ` +
    `nem ${envPrefix}_EMAIL definidos no env`
  );
}

/**
 * Quantas contas numeradas estão configuradas pro prefixo dado?
 */
function contarContasDisponiveis(envPrefix = 'SISTEMA_EXTERNO') {
  let n = 0;
  while (
    process.env[`${envPrefix}_EMAIL_${n + 1}`] &&
    process.env[`${envPrefix}_SENHA_${n + 1}`]
  ) {
    n++;
  }
  return n;
}

/**
 * Cria um session manager pra um agente específico.
 * @param {string} namespace — nome do agente, vira parte do nome do arquivo
 * @param {'isolada'|'compartilhada'} estrategia
 * @param {string} envPrefix — prefixo das vars de credencial
 *                              (default 'SISTEMA_EXTERNO').
 *                              Use 'SISTEMA_EXTERNO_SLA' pra agentes que usam
 *                              contas SLA dedicadas.
 */
function criarSessionManager(namespace, estrategia = 'isolada', envPrefix = 'SISTEMA_EXTERNO') {
  if (!namespace || typeof namespace !== 'string') {
    throw new Error('session-manager: namespace obrigatório');
  }
  if (!['isolada', 'compartilhada'].includes(estrategia)) {
    throw new Error(`session-manager: estratégia inválida: ${estrategia}`);
  }

  /**
   * Caminho do arquivo de sessão pra um slot específico.
   * - 'compartilhada': todos os slots usam o mesmo arquivo
   * - 'isolada':       cada slot tem o seu
   */
  function caminhoSessao(slotId) {
    if (estrategia === 'compartilhada') {
      return path.join(SESSION_DIR, `tutts-${namespace}-shared.json`);
    }
    return path.join(SESSION_DIR, `tutts-${namespace}-slot-${slotId}.json`);
  }

  /**
   * Credenciais pra um slot específico.
   * - 'compartilhada': todos usam conta 1 (ou fallback)
   * - 'isolada':       slot N usa conta N+1 (slot 0 = conta 1, etc)
   */
  function credenciaisDoSlot(slotId) {
    const contaNum = estrategia === 'compartilhada' ? 1 : (slotId + 1);
    return obterCredenciais(contaNum, envPrefix);
  }

  /**
   * Verifica se o arquivo de sessão existe (storageState válido em disco).
   */
  function temSessaoSalva(slotId) {
    try {
      return fs.existsSync(caminhoSessao(slotId));
    } catch {
      return false;
    }
  }

  /**
   * Apaga arquivo de sessão (pra forçar relogin no próximo uso).
   */
  function descartarSessao(slotId) {
    const p = caminhoSessao(slotId);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        log(`🗑️ Sessão descartada: ${p}`);
      }
    } catch (e) {
      logger.error(`[session-manager] falha ao descartar ${p}: ${e.message}`);
    }
  }

  return {
    namespace,
    estrategia,
    caminhoSessao,
    credenciaisDoSlot,
    temSessaoSalva,
    descartarSessao,
  };
}

module.exports = {
  criarSessionManager,
  obterCredenciais,
  contarContasDisponiveis,
};
