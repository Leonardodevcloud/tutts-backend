/**
 * WhatsApp Notification Service — Evolution API
 * 
 * Envia notificações automáticas para grupo do WhatsApp
 * quando lotes de pagamento são gerados/finalizados..
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

/**
 * Monta mensagem de resumo diário (cron 19h) — espelha a aba Validação
 */
function montarMensagemResumoDiario({ totalRecebidas, totalAprovadas, semGratuidade, comGratuidade, rejeitadas, valorTotalAprovado, lucro, deixouArrecadar, saldoStark }) {
  const dataHora = formatarDataHoraBR();

  let msg = `📊 *Resumo do dia*\n`;
  msg += `📅 ${dataHora}\n\n`;
  msg += `📥 Total recebidas: *${totalRecebidas}*\n`;
  msg += `✅ Total aprovadas: *${totalAprovadas}*\n`;
  msg += `📋 Sem gratuidade: *${semGratuidade}*\n`;
  msg += `🎁 Com gratuidade: *${comGratuidade}*\n`;
  msg += `❌ Rejeitadas: *${rejeitadas}*\n\n`;
  msg += `💵 Valor total aprovado: *R$ ${formatarReais(valorTotalAprovado)}*\n`;
  msg += `💰 Lucro com saque (4,5%): *R$ ${formatarReais(lucro)}*\n`;
  msg += `📉 Deixou de arrecadar: *R$ ${formatarReais(deixouArrecadar)}*\n`;
  msg += `🏦 Saldo Stark Bank: *R$ ${formatarReais(saldoStark)}*\n`;
  msg += `\n_*Argos, seu sentinela operacional!*_`;

  return msg;
}

/**
 * Envia resumo diário para o grupo (chamado pelo cron às 19h)
 * 🆕 2026-04-30: agora gera uma IMAGEM PNG (1080x1080) via Playwright
 * em vez de mandar texto cru. Usa o mesmo padrão do CRM-Resumo
 * (leads-captura.routes.js) e do Raio-X CS.
 *
 * Fallback: se a geração da imagem falhar (Playwright morto, EAGAIN, etc),
 * cai pro envio de texto cru pra não perder o resumo.
 */
async function notificarResumoDiario(dados) {
  try {
    // 1. Tentar enviar como IMAGEM (caminho preferido)
    const imgResult = await enviarImagemResumoDiario(dados);
    if (imgResult.enviado) {
      return imgResult;
    }

    // 2. Fallback: texto cru se imagem falhou (não perder o resumo)
    console.warn(`⚠️ [WhatsApp] Imagem do resumo falhou (${imgResult.motivo}), caindo pro texto cru`);
    const mensagem = montarMensagemResumoDiario(dados);
    return await enviarMensagemWhatsApp(mensagem);
  } catch (error) {
    console.error('❌ [WhatsApp] Erro ao enviar resumo diário:', error.message);
    return { enviado: false, motivo: 'excecao', erro: error.message };
  }
}

// ==================== GERAÇÃO DE IMAGEM ====================
// 🆕 2026-04-30: Renderiza dashboard HTML em PNG 1080x1080 e envia
// via Evolution API endpoint /message/sendMedia. Mesmo padrão do CRM
// (leads-captura.routes.js linha ~280).

/**
 * Monta o HTML do dashboard de resumo diário (formato quadrado 1080x1080)
 * Usa CSS inline + paleta light/clean aprovada no mockup.
 */
function montarHtmlResumoDiario({
  totalRecebidas, totalAprovadas, rejeitadas, semGratuidade, comGratuidade,
  valorTotalAprovado, lucro, deixouArrecadar, saldoStark
}) {
  const dataHora = formatarDataHoraBR();
  const [dataPart, horaPart] = dataHora.split(', ');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .square {
    width: 1080px; height: 1080px;
    background: #FAFAFA;
    padding: 56px 48px 44px;
    display: flex; flex-direction: column;
    color: #1f2937;
  }
  .head {
    display: flex; align-items: center; gap: 24px;
    padding-bottom: 28px;
    border-bottom: 2px solid #e5e7eb;
    margin-bottom: 32px;
  }
  .logo {
    width: 88px; height: 88px; border-radius: 20px;
    background: #534AB7;
    display: flex; align-items: center; justify-content: center;
    color: white; font-weight: 600; font-size: 36px;
  }
  .brand-block { flex: 1; }
  .brand-name { font-size: 22px; color: #6b7280; margin: 0 0 6px; }
  .title { font-size: 36px; font-weight: 600; color: #111827; }
  .date {
    text-align: right;
    font-size: 22px; color: #6b7280;
    line-height: 1.4;
  }
  .date strong { color: #111827; font-weight: 600; }

  .hero {
    background: white;
    border: 1px solid #d1d5db;
    border-left: 8px solid #1D9E75;
    border-radius: 16px;
    padding: 32px 36px;
    margin-bottom: 28px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .hero-label { font-size: 18px; color: #6b7280; text-transform: uppercase; letter-spacing: 1.2px; margin: 0 0 10px; }
  .hero-value { font-size: 56px; font-weight: 600; color: #1D9E75; line-height: 1; }
  .hero-meta { text-align: right; }
  .hero-meta-label { font-size: 18px; color: #6b7280; text-transform: uppercase; letter-spacing: 1.2px; margin: 0 0 10px; }
  .hero-meta-value { font-size: 32px; font-weight: 600; color: #1D9E75; }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 18px;
    margin-bottom: 28px;
  }
  .card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    padding: 24px 28px;
    position: relative;
    overflow: hidden;
  }
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; bottom: 0; width: 6px;
  }
  .card-info::before    { background: #378ADD; }
  .card-success::before { background: #1D9E75; }
  .card-danger::before  { background: #993C1D; }
  .card-neutral::before { background: #888780; }
  .card-warn::before    { background: #BA7517; }
  .card-label {
    font-size: 16px; color: #6b7280;
    text-transform: uppercase; letter-spacing: 0.8px;
    margin: 0 0 10px;
  }
  .card-value { font-size: 38px; font-weight: 600; color: #111827; line-height: 1; }
  .card-value-money { font-size: 28px; }
  .text-success { color: #1D9E75; }
  .text-warn { color: #BA7517; }
  .text-danger { color: #993C1D; }

  .foot {
    margin-top: auto;
    padding-top: 22px;
    border-top: 2px solid #e5e7eb;
    display: flex; justify-content: space-between; align-items: center;
  }
  .saldo-block { display: flex; align-items: center; gap: 14px; }
  .saldo-icon {
    width: 56px; height: 56px; border-radius: 12px;
    background: #EEEDFE;
    display: flex; align-items: center; justify-content: center;
    color: #534AB7; font-weight: 600; font-size: 24px;
  }
  .saldo-label { font-size: 16px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.8px; }
  .saldo-value { font-size: 26px; font-weight: 600; color: #111827; }
  .sig {
    font-size: 18px; font-style: italic; color: #534AB7;
  }
</style></head><body>
  <div class="square">
    <div class="head">
      <div class="logo">T</div>
      <div class="brand-block">
        <p class="brand-name">Tutts · Argos Financeiro</p>
        <p class="title">Resumo do dia</p>
      </div>
      <div class="date">
        ${dataPart || dataHora}<br/>
        <strong>${horaPart || ''}</strong>
      </div>
    </div>

    <div class="hero">
      <div>
        <p class="hero-label">Valor total aprovado</p>
        <p class="hero-value">R$ ${formatarReais(valorTotalAprovado)}</p>
      </div>
      <div class="hero-meta">
        <p class="hero-meta-label">Lucro 4,5%</p>
        <p class="hero-meta-value">R$ ${formatarReais(lucro)}</p>
      </div>
    </div>

    <div class="grid">
      <div class="card card-info">
        <p class="card-label">Recebidas</p>
        <p class="card-value">${totalRecebidas}</p>
      </div>
      <div class="card card-success">
        <p class="card-label">Aprovadas</p>
        <p class="card-value text-success">${totalAprovadas}</p>
      </div>
      <div class="card card-danger">
        <p class="card-label">Rejeitadas</p>
        <p class="card-value text-danger">${rejeitadas}</p>
      </div>
      <div class="card card-neutral">
        <p class="card-label">Sem gratuidade</p>
        <p class="card-value">${semGratuidade}</p>
      </div>
      <div class="card card-neutral">
        <p class="card-label">Com gratuidade</p>
        <p class="card-value">${comGratuidade}</p>
      </div>
      <div class="card card-warn">
        <p class="card-label">Não arrecadou</p>
        <p class="card-value text-warn card-value-money">R$ ${formatarReais(deixouArrecadar)}</p>
      </div>
    </div>

    <div class="foot">
      <div class="saldo-block">
        <div class="saldo-icon">$</div>
        <div>
          <p class="saldo-label">Saldo Stark Bank</p>
          <p class="saldo-value">R$ ${formatarReais(saldoStark)}</p>
        </div>
      </div>
      <p class="sig">Argos · sentinela operacional</p>
    </div>
  </div>
</body></html>`;
}

/**
 * Monta a caption curta que vai junto com a imagem no WhatsApp
 */
function montarCaptionResumoDiario({ totalAprovadas, valorTotalAprovado, lucro }) {
  const dia = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  return `📊 *Resumo do dia · ${dia}*\n${totalAprovadas} saques aprovados · R$ ${formatarReais(valorTotalAprovado)} movimentados · lucro de R$ ${formatarReais(lucro)}`;
}

/**
 * Gera PNG 1080x1080 do dashboard via Playwright e envia pra Evolution API
 * usando endpoint /message/sendMedia (igual o CRM-Resumo faz há tempos).
 *
 * Retorno padrão: { enviado: bool, motivo?: string, ... }
 */
async function enviarImagemResumoDiario(dados) {
  const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
  if (!ativo) {
    return { enviado: false, motivo: 'desativado' };
  }

  const baseUrl   = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey    = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  const grupoId   = process.env.EVOLUTION_GROUP_ID;

  if (!baseUrl || !apiKey || !instancia || !grupoId) {
    return { enviado: false, motivo: 'config_incompleta' };
  }

  // 1. Renderizar HTML → PNG via Playwright (mesmo padrão CRM-Resumo)
  let screenshotBuffer;
  try {
    const html = montarHtmlResumoDiario(dados);
    const { lancarChromiumSeguro } = require('../../../shared/playwright-launch');
    const { browser, fechar } = await lancarChromiumSeguro({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      // Captura só o .square (1080x1080) — mesmo padrão CRM (element.screenshot)
      const element = await page.$('.square');
      if (!element) throw new Error('Elemento .square não encontrado no HTML');
      screenshotBuffer = await element.screenshot({ type: 'png' });
      console.log(`📸 [WhatsApp Resumo] Imagem 1080x1080 gerada (${(screenshotBuffer.length / 1024).toFixed(0)}KB)`);
    } finally {
      await fechar();
    }
  } catch (errImg) {
    console.error('❌ [WhatsApp Resumo] Falha ao gerar imagem:', errImg.message);
    return { enviado: false, motivo: 'erro_render', erro: errImg.message };
  }

  // 2. Enviar via /message/sendMedia (mesmo payload do CRM-Resumo)
  try {
    const imageBase64 = screenshotBuffer.toString('base64');
    const caption = montarCaptionResumoDiario(dados);

    const url = `${baseUrl}/message/sendMedia/${instancia}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({
        number: grupoId,
        mediatype: 'image',
        mimetype: 'image/png',
        caption: caption,
        media: imageBase64,
        fileName: 'resumo-diario.png',
      }),
    });

    if (response.ok) {
      console.log('✅ [WhatsApp Resumo] Imagem enviada com sucesso!');
      return { enviado: true, tamanho_kb: Math.round(screenshotBuffer.length / 1024) };
    } else {
      const errBody = await response.text().catch(() => '');
      console.error(`❌ [WhatsApp Resumo] Evolution retornou ${response.status}:`, errBody.slice(0, 200));
      return { enviado: false, motivo: 'erro_api', status: response.status };
    }
  } catch (errSend) {
    console.error('❌ [WhatsApp Resumo] Erro ao enviar mídia:', errSend.message);
    return { enviado: false, motivo: 'excecao_envio', erro: errSend.message };
  }
}

/**
 * Monta mensagem de falha do auto-saque (cai pro fluxo manual)
 * Formato básico: motoboy + valor + erro + nº do saque
 */
function montarMensagemFalhaAutoSaque({ saqueId, motoboyNome, motoboyCod, valor, erro }) {
  const valorStr = formatarReais(valor);
  const erroLimpo = String(erro || 'erro desconhecido').slice(0, 200);

  let msg = `⚠️ *Saque automático falhou*\n\n`;
  msg += `Motoboy: *${motoboyNome}* (cod: ${motoboyCod})\n`;
  msg += `Valor: *R$ ${valorStr}*\n`;
  msg += `Erro: ${erroLimpo}\n\n`;
  msg += `Saque #${saqueId} caiu no fluxo manual (lote do dia)`;

  return msg;
}

/**
 * Notifica grupo financeiro quando o auto-saque tentou pagar mas falhou.
 * Disparado pelo POST /withdrawals quando modoAutoTentado && !modoAutoOk.
 * Fire-and-forget: nunca propaga exception.
 */
async function notificarFalhaAutoSaque({ saqueId, motoboyNome, motoboyCod, valor, erro }) {
  try {
    const mensagem = montarMensagemFalhaAutoSaque({ saqueId, motoboyNome, motoboyCod, valor, erro });
    const resultado = await enviarMensagemWhatsApp(mensagem);
    return resultado;
  } catch (error) {
    console.error('❌ [WhatsApp] Erro ao enviar notificação de falha auto-saque:', error.message);
    return { enviado: false, motivo: 'excecao', erro: error.message };
  }
}

module.exports = {
  notificarLoteGerado,
  notificarLoteFinalizado,
  enviarMensagemWhatsApp,
  notificarResumoDiario,
  notificarFalhaAutoSaque,
  enviarImagemResumoDiario,
  montarMensagemLoteGerado,
  montarMensagemLoteFinalizado,
  montarMensagemResumoDiario,
  montarMensagemFalhaAutoSaque,
  montarHtmlResumoDiario,
  montarCaptionResumoDiario,
  LIMIAR_SAQUE_DESTAQUE
};
