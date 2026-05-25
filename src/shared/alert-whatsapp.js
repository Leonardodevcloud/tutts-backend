/**
 * Tutts Backend — src/shared/alert-whatsapp.js
 * ─────────────────────────────────────────────────────────────────────────
 * Envia alertas de sistema (memória, circuit breaker, falhas) pra grupo
 * WhatsApp configurado em EVOLUTION_GROUP_ID_ALERTAS (fallback: EVOLUTION_GROUP_ID).
 *
 * Anti-spam: cada chave de alerta tem cooldown de 30min — se já enviou o
 * mesmo tipo de alerta nesse intervalo, ignora. Evita que um problema
 * persistente gere uma enxurrada de mensagens.
 *
 * Habilitação: ALERTAS_WHATSAPP_ATIVO=true. Se desativado, vira no-op.
 *
 * Uso:
 *   const { enviarAlerta } = require('../shared/alert-whatsapp');
 *   await enviarAlerta('mem-kill', '🚨 Memória crítica: 1700MB. Reiniciando.');
 */

'use strict';

const COOLDOWN_MS = 30 * 60_000; // 30min entre alertas do mesmo tipo
const _ultimoEnvio = new Map(); // chave → timestamp ms

function ativo() {
  return (process.env.ALERTAS_WHATSAPP_ATIVO || 'false').toLowerCase() === 'true';
}

/**
 * Envia alerta WhatsApp com anti-spam.
 *
 * @param {string} chave - Identificador único do tipo de alerta (ex: 'mem-warn',
 *   'fila-validador-circuit'). Mesma chave em <30min é ignorada.
 * @param {string} mensagem - Texto a enviar.
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 */
async function enviarAlerta(chave, mensagem) {
  if (!ativo()) {
    console.log(`📱 [alerta:${chave}] Desativado (ALERTAS_WHATSAPP_ATIVO != true)`);
    return { enviado: false, motivo: 'desativado' };
  }

  const agora = Date.now();
  const ultimo = _ultimoEnvio.get(chave) || 0;
  if (agora - ultimo < COOLDOWN_MS) {
    const restanteMin = Math.ceil((COOLDOWN_MS - (agora - ultimo)) / 60_000);
    console.log(`📱 [alerta:${chave}] Cooldown ativo (${restanteMin}min restantes) — ignorando`);
    return { enviado: false, motivo: 'cooldown' };
  }

  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  const grupoId = process.env.EVOLUTION_GROUP_ID_ALERTAS || process.env.EVOLUTION_GROUP_ID;

  if (!baseUrl || !apiKey || !instancia || !grupoId) {
    console.warn(`⚠️ [alerta:${chave}] Config Evolution incompleta`);
    return { enviado: false, motivo: 'config_incompleta' };
  }

  const url = `${baseUrl}/message/sendText/${instancia}`;
  const corpo = `🚨 *Tutts Sistema* — alerta\n\n${mensagem}\n\n_Hora: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Bahia' })}_`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: grupoId, text: corpo }),
    });
    if (response.ok) {
      _ultimoEnvio.set(chave, agora);
      console.log(`✅ [alerta:${chave}] enviado`);
      return { enviado: true };
    }
    const data = await response.json().catch(() => ({}));
    console.error(`❌ [alerta:${chave}] Erro ${response.status}:`, data);
    return { enviado: false, motivo: 'erro_api', status: response.status };
  } catch (err) {
    console.error(`❌ [alerta:${chave}] Exceção:`, err.message);
    return { enviado: false, motivo: 'excecao', erro: err.message };
  }
}

/**
 * Limpa cooldowns (útil pra testes ou pra forçar próximo alerta).
 */
function limparCooldowns() {
  _ultimoEnvio.clear();
}

module.exports = {
  enviarAlerta,
  limparCooldowns,
};
