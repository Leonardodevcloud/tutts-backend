/**
 * Tutts Backend — src/shared/whatsapp-motoboy.js
 * ─────────────────────────────────────────────────────────────────────────
 * Envia mensagens WhatsApp diretas pro número pessoal do motoboy.
 *
 * Diferente de:
 *   - financial/routes/whatsapp.service.js → envia pra GRUPO financeiro
 *   - shared/alert-whatsapp.js              → envia pra GRUPO alertas técnicos
 *
 * Este aqui é 1-pra-1: número do motoboy salvo em users.whatsapp.
 * Habilitação via WHATSAPP_NOTIF_ATIVO=true (mesma env do helper financial,
 * pra que um único toggle controle TODOS os envios WhatsApp do sistema).
 *
 * Falha silenciosa: erros logam mas NUNCA bloqueiam o fluxo principal.
 * Despachar uma corrida não deve quebrar se Evolution estiver fora.
 *
 * Uso típico (fire-and-forget):
 *   const { enviarParaMotoboy } = require('../../shared/whatsapp-motoboy');
 *   enviarParaMotoboy(numeroWhatsapp, mensagem).catch(() => {});
 */

'use strict';

/**
 * Envia mensagem WhatsApp pro número do motoboy.
 *
 * @param {string} numero - Número no formato 55DDDXXXXXXXX (já normalizado em
 *   users.whatsapp). Se vier null/vazio/inválido, retorna ignorado sem erro.
 * @param {string} texto - Conteúdo da mensagem (suporta *negrito* e _italico_).
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 */
async function enviarParaMotoboy(numero, texto) {
  const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
  if (!ativo) {
    return { enviado: false, motivo: 'desativado' };
  }

  // Validação defensiva: número precisa ter ao menos 12 dígitos (55 + DDD + 8/9 dígitos)
  if (!numero || typeof numero !== 'string') {
    return { enviado: false, motivo: 'sem_numero' };
  }
  const digitos = numero.replace(/\D/g, '');
  if (digitos.length < 12) {
    return { enviado: false, motivo: 'numero_invalido', valor: digitos };
  }

  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;

  if (!baseUrl || !apiKey || !instancia) {
    console.warn('⚠️ [WhatsApp-Motoboy] Config Evolution incompleta');
    return { enviado: false, motivo: 'config_incompleta' };
  }

  const url = `${baseUrl}/message/sendText/${instancia}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: digitos, text: texto }),
    });

    if (response.ok) {
      console.log(`✅ [WhatsApp-Motoboy] Enviado pra ${digitos.substring(0, 4)}...${digitos.slice(-4)}`);
      return { enviado: true };
    }

    const data = await response.json().catch(() => ({}));
    console.error(`❌ [WhatsApp-Motoboy] Erro ${response.status} pra ${digitos.substring(0, 4)}...${digitos.slice(-4)}:`, data?.message || data);
    return { enviado: false, motivo: 'erro_api', status: response.status };
  } catch (err) {
    console.error(`❌ [WhatsApp-Motoboy] Exceção:`, err.message);
    return { enviado: false, motivo: 'excecao', erro: err.message };
  }
}

/**
 * Monta mensagem padrão de despacho de rota.
 *
 * @param {string} nomeMotoboy - Primeiro nome ou nome completo do motoboy.
 *   Se vier vazio, usa "motoboy" genérico (fallback defensivo).
 * @returns {string} Texto pronto pra enviar.
 */
function montarMensagemDespacho(nomeMotoboy) {
  // Pega só o primeiro nome pra ficar mais pessoal e curto
  const primeiroNome = (nomeMotoboy || '').trim().split(/\s+/)[0] || 'motoboy';

  return `🛵 *Tutts — Atenção ${primeiroNome}*\n\n` +
    `O suporte já disponibilizou o roteiro no seu aplicativo.\n\n` +
    `Por favor realize a coleta das mercadorias e avance para a entrega.\n\n` +
    `⏱️ *Atenção ao tempo de entrega — evite atrasos.*`;
}

module.exports = {
  enviarParaMotoboy,
  montarMensagemDespacho,
};
