/**
 * WhatsApp Notification Service — Evolution API
 * 
 * Envia notificações automáticas para grupo do WhatsApp
 * quando lotes de pagamento são gerados/finalizados.
 * 
 * ENV VARS necessárias:
 *   EVOLUTION_API_URL      = https://sua-instancia.evolution-api.com
 *   EVOLUTION_API_KEY      = seu_api_key
 *   EVOLUTION_INSTANCE     = nome_da_instancia
 *   EVOLUTION_GROUP_ID     = id_do_grupo@g.us  (ex: 120363012345678901@g.us)
 *   WHATSAPP_NOTIF_ATIVO   = true (default: false — desligado até configurar)
 */

const LIMIAR_SAQUE_DESTAQUE = 200; // Saques acima deste valor aparecem em destaque

/**
 * Formata valor em reais: 6452.00 → "6.452,00"
 */
function formatarReais(valor) {
  const num = parseFloat(valor) || 0;
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Formata data/hora atual no fuso de Salvador (UTC-3)
 */
function formatarDataHoraBR() {
  const agora = new Date();
  return agora.toLocaleString('pt-BR', { 
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Monta a mensagem de notificação para lote gerado
 */
function montarMensagemLoteGerado({ loteId, quantidade, valorTotal, saques }) {
  const dataHora = formatarDataHoraBR();

  let msg = `💰 *Lote #${loteId} gerado*\n`;
  msg += `📅 ${dataHora}\n\n`;
  msg += `📦 Quantidade de saques: *${quantidade}*\n`;
  msg += `💵 Valor total: *R$ ${formatarReais(valorTotal)}*\n`;

  // Filtrar saques acima do limiar
  const saquesDestaque = (saques || [])
    .filter(s => parseFloat(s.final_amount || s.valor || 0) >= LIMIAR_SAQUE_DESTAQUE)
    .sort((a, b) => parseFloat(b.final_amount || b.valor || 0) - parseFloat(a.final_amount || a.valor || 0));

  if (saquesDestaque.length > 0) {
    msg += `\n⚠️ *Solicitações acima de R$ ${formatarReais(LIMIAR_SAQUE_DESTAQUE)}:*\n\n`;
    for (const s of saquesDestaque) {
      const cod = s.user_cod || '—';
      const nome = (s.user_name || s.nome || 'N/A').split(' ')[0]; // Primeiro nome
      const valor = formatarReais(s.final_amount || s.valor || 0);
      msg += `• ${cod} ${nome} — R$ ${valor}\n`;
    }
  }

  return msg;
}

/**
 * Monta mensagem para lote finalizado (todos pagos)
 */
function montarMensagemLoteFinalizado({ loteId, status, pagos, erros, valorPago }) {
  const dataHora = formatarDataHoraBR();
  const emoji = status === 'concluido' ? '✅' : '⚠️';
  const statusTxt = status === 'concluido' ? 'Concluído' : 'Parcial (com erros)';

  let msg = `${emoji} *Lote #${loteId} — ${statusTxt}*\n`;
  msg += `📅 ${dataHora}\n\n`;
  msg += `✅ Pagos: *${pagos}*\n`;

  if (erros > 0) {
    msg += `❌ Com erro: *${erros}*\n`;
  }

  if (valorPago) {
    msg += `💵 Valor pago: *R$ ${formatarReais(valorPago)}*\n`;
  }

  return msg;
}

/**
 * Envia mensagem de texto para o grupo via Evolution API
 */
async function enviarMensagemWhatsApp(texto) {
  const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
  if (!ativo) {
    console.log('📱 [WhatsApp] Notificação desativada (WHATSAPP_NOTIF_ATIVO != true)');
    return { enviado: false, motivo: 'desativado' };
  }

  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  const grupoId = process.env.EVOLUTION_GROUP_ID;

  if (!baseUrl || !apiKey || !instancia || !grupoId) {
    console.warn('⚠️ [WhatsApp] Variáveis de ambiente incompletas:', {
      EVOLUTION_API_URL: !!baseUrl,
      EVOLUTION_API_KEY: !!apiKey,
      EVOLUTION_INSTANCE: !!instancia,
      EVOLUTION_GROUP_ID: !!grupoId
    });
    return { enviado: false, motivo: 'config_incompleta' };
  }

  const url = `${baseUrl}/message/sendText/${instancia}`;

  try {
    console.log(`📱 [WhatsApp] Enviando mensagem para grupo ${grupoId.substring(0, 10)}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify({
        number: grupoId,
        text: texto
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log(`✅ [WhatsApp] Mensagem enviada com sucesso!`);
      return { enviado: true, data };
    } else {
      console.error(`❌ [WhatsApp] Erro ${response.status}:`, data);
      return { enviado: false, motivo: 'erro_api', status: response.status, data };
    }
  } catch (error) {
    console.error(`❌ [WhatsApp] Exceção ao enviar:`, error.message);
    return { enviado: false, motivo: 'excecao', erro: error.message };
  }
}

/**
 * Notifica grupo sobre lote gerado (chamado após /stark/lote/executar)
 * Roda em background — nunca bloqueia a resposta do endpoint.
 */
async function notificarLoteGerado({ loteId, quantidade, valorTotal, saques }) {
  try {
    const mensagem = montarMensagemLoteGerado({ loteId, quantidade, valorTotal, saques });
    const resultado = await enviarMensagemWhatsApp(mensagem);
    return resultado;
  } catch (error) {
    console.error('❌ [WhatsApp] Erro ao notificar lote gerado:', error.message);
    return { enviado: false, motivo: 'excecao', erro: error.message };
  }
}

/**
 * Notifica grupo sobre lote finalizado (chamado pelo webhook/sync)
 * Roda em background — nunca bloqueia.
 */
async function notificarLoteFinalizado({ loteId, status, pagos, erros, valorPago }) {
  try {
    const mensagem = montarMensagemLoteFinalizado({ loteId, status, pagos, erros, valorPago });
    const resultado = await enviarMensagemWhatsApp(mensagem);
    return resultado;
  } catch (error) {
    console.error('❌ [WhatsApp] Erro ao notificar lote finalizado:', error.message);
    return { enviado: false, motivo: 'excecao', erro: error.message };
  }
}

module.exports = {
  notificarLoteGerado,
  notificarLoteFinalizado,
  enviarMensagemWhatsApp,
  montarMensagemLoteGerado,
  montarMensagemLoteFinalizado,
  LIMIAR_SAQUE_DESTAQUE
};
