/**
 * MÓDULO LOGISTICS — logistics.whatsapp.js
 *
 * Envia mensagens WhatsApp de verificação para o destinatário de uma entrega.
 *
 * Segue o mesmo padrão de shared/whatsapp-motoboy.js:
 *  - Usa Evolution API (EVOLUTION_API_URL + EVOLUTION_API_KEY + EVOLUTION_INSTANCE)
 *  - Habilitação via WHATSAPP_NOTIF_ATIVO=true
 *  - Falha silenciosa — nunca bloqueia o fluxo de despacho
 *
 * Quando enviar:
 *  1. Uber Direct: logo após o despacho (código gerado por nós)
 *  2. 99Entrega: após o TrackingPoller detectar o código no /v2/order/detail
 *
 * Hierarquia de telefone (fallback em cascata):
 *  1. telefone_entrega (salvo no dispatch a partir do último ponto da OS)
 *  2. Se null: loga aviso e não envia (não usa telefone_suporte — seria o telefone
 *     da loja, não do cliente)
 */

'use strict';

/**
 * Formata número para o padrão Evolution API (55DDDXXXXXXXX, só dígitos).
 * @param {string|null} numero
 * @returns {string|null}
 */
function normalizarTelefone(numero) {
  if (!numero) return null;
  const digitos = String(numero).replace(/\D/g, '');
  if (digitos.length < 10) return null;
  // Garante prefixo 55 (Brasil)
  if (digitos.startsWith('55') && digitos.length >= 12) return digitos;
  if (digitos.length === 11 || digitos.length === 10) return `55${digitos}`;
  return digitos;
}

/**
 * Envia o código de verificação de COLETA para o telefone da loja/remetente.
 * A loja precisa informar esse código ao motoboy antes de entregar o pacote.
 *
 * @param {string} telefone - Telefone do remetente (loja)
 * @param {Object} opts
 * @param {string|number} opts.codigoOS
 * @param {string} opts.codigo - PIN de verificação
 * @param {string} [opts.providerNome='parceiro logístico']
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 */
async function enviarCodigoColeta(telefone, opts) {
  const { codigoOS, codigo, providerNome = 'parceiro logístico' } = opts;
  const tel = normalizarTelefone(telefone);
  if (!tel) {
    console.warn(`⚠️ [Logistics-WPP] enviarCodigoColeta OS ${codigoOS}: telefone inválido (${telefone})`);
    return { enviado: false, motivo: 'telefone_invalido' };
  }

  const texto =
    `📦 *Tutts Logística — OS ${codigoOS}*\n\n` +
    `Um motoboy do *${providerNome}* irá buscar o seu pedido.\n\n` +
    `Ao chegar, ele vai solicitar o código de verificação abaixo:\n\n` +
    `🔑 Código: *${codigo}*\n\n` +
    `Informe este código ao motoboy antes de entregar o pacote.\n` +
    `_Não compartilhe com ninguém além do entregador._`;

  return _enviar(tel, texto, `coleta OS ${codigoOS}`);
}

/**
 * Envia o código de verificação de ENTREGA para o destinatário.
 * O destinatário precisa informar esse código ao motoboy no momento da entrega.
 *
 * @param {string} telefone - Telefone do destinatário
 * @param {Object} opts
 * @param {string|number} opts.codigoOS
 * @param {string} opts.codigo - PIN de verificação
 * @param {string} [opts.providerNome='parceiro logístico']
 * @param {string} [opts.nomeDestinatario='']
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 */
async function enviarCodigoEntrega(telefone, opts) {
  const { codigoOS, codigo, providerNome = 'parceiro logístico', nomeDestinatario = '' } = opts;
  const tel = normalizarTelefone(telefone);
  if (!tel) {
    console.warn(`⚠️ [Logistics-WPP] enviarCodigoEntrega OS ${codigoOS}: telefone inválido (${telefone})`);
    return { enviado: false, motivo: 'telefone_invalido' };
  }

  const saudacao = nomeDestinatario ? `Olá, *${nomeDestinatario.split(' ')[0]}*!` : 'Olá!';
  const texto =
    `🛵 *Tutts Logística — Entrega a caminho!*\n\n` +
    `${saudacao} O seu pedido (OS ${codigoOS}) está sendo entregue por um motoboy do *${providerNome}*.\n\n` +
    `Ao receber, informe o código abaixo ao entregador:\n\n` +
    `🔑 Código: *${codigo}*\n\n` +
    `Mantenha este código em mãos. _Só informe ao entregador no momento da entrega._`;

  return _enviar(tel, texto, `entrega OS ${codigoOS}`);
}

/**
 * Envia o LINK de rastreio em tempo real (tracking_link da 99) pro cliente.
 * Usado quando o entregador aceita (status waiting) e a 99 expoe o link.
 * @param {string} telefone
 * @param {{codigoOS:(number|string), link:string, providerNome?:string, nomeDestinatario?:string, papel?:string}} opts
 */
async function enviarRastreioCliente(telefone, opts) {
  const { codigoOS, link, providerNome = 'parceiro logístico', nomeDestinatario = '', papel = '', codigoColeta = '' } = opts || {};
  const tel = normalizarTelefone(telefone);
  if (!tel) {
    console.warn(`⚠️ [Logistics-WPP] enviarRastreioCliente OS ${codigoOS}: telefone inválido (${telefone})`);
    return { enviado: false, motivo: 'telefone_invalido' };
  }
  if (!link) {
    return { enviado: false, motivo: 'sem_link' };
  }

  const saudacao = nomeDestinatario ? `Olá, *${nomeDestinatario.split(' ')[0]}*!` : 'Olá!';
  // Codigo de coleta so faz sentido pra loja (ponto de retirada).
  const linhaCodigo = (papel === 'loja' && codigoColeta)
    ? `\n\n🔑 Código de coleta: *${codigoColeta}* (informe ao entregador na retirada)`
    : '';
  const texto =
    `🛵 *Tutts Logística — Entregador a caminho!*\n\n` +
    `${saudacao} A entrega (OS ${codigoOS}) já tem um motoboy do *${providerNome}* designado.\n\n` +
    `Acompanhe em tempo real pelo link:\n${link}` +
    linhaCodigo;

  return _enviar(tel, texto, `rastreio OS ${codigoOS}${papel ? ' (' + papel + ')' : ''}`);
}

/**
 * Função interna de envio via Evolution API.
 * @private
 */
async function _enviar(telefone, texto, contexto) {
  const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
  if (!ativo) {
    console.log(`📵 [Logistics-WPP] ${contexto}: notificações desativadas (WHATSAPP_NOTIF_ATIVO=false)`);
    return { enviado: false, motivo: 'desativado' };
  }

  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey  = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;

  if (!baseUrl || !apiKey || !instancia) {
    console.warn(`⚠️ [Logistics-WPP] ${contexto}: config Evolution incompleta`);
    return { enviado: false, motivo: 'config_incompleta' };
  }

  const url = `${baseUrl}/message/sendText/${instancia}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ number: telefone, text: texto }),
    });
    if (res.ok) {
      console.log(`✅ [Logistics-WPP] ${contexto}: enviado pra ${telefone.slice(0, 6)}...${telefone.slice(-4)}`);
      return { enviado: true };
    }
    const d = await res.json().catch(() => ({}));
    console.error(`❌ [Logistics-WPP] ${contexto}: HTTP ${res.status}:`, d?.message || d);
    return { enviado: false, motivo: 'erro_api', status: res.status };
  } catch (err) {
    console.error(`❌ [Logistics-WPP] ${contexto}: exceção:`, err.message);
    return { enviado: false, motivo: 'excecao', erro: err.message };
  }
}

module.exports = { enviarCodigoColeta, enviarCodigoEntrega, enviarRastreioCliente, normalizarTelefone };
