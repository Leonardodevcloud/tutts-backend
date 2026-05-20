/**
 * whatsapp-rastreio.service.js
 *
 * Validação de número via Evolution API + envio do link de rastreio
 * pro cliente final. Reusa as mesmas env vars do whatsapp.service.js
 * do módulo financial (mesma instância Evolution já configurada):
 *
 *   EVOLUTION_API_URL    = https://sua-instancia.evolution-api.com
 *   EVOLUTION_API_KEY    = api key
 *   EVOLUTION_INSTANCE   = nome da instância
 *
 * Funções:
 *   - normalizarTelefoneBR(raw)  → '5571XXXXXXXXX' | null
 *   - validarFormatoBR(raw)      → { ok, motivo, numero }
 *   - validarWhatsApp(raw)       → { numero, tem_whatsapp, jid? }
 *   - enviarRastreioCliente(...) → { enviado, motivo? }
 */

// 67 DDDs válidos do Brasil (Anatel)
const DDDS_VALIDOS = new Set([
  11,12,13,14,15,16,17,18,19, 21,22,24,27,28, 31,32,33,34,35,37,38,
  41,42,43,44,45,46,47,48,49, 51,53,54,55, 61,62,63,64,65,66,67,68,69,
  71,73,74,75,77,79, 81,82,83,84,85,86,87,88,89,
  91,92,93,94,95,96,97,98,99,
]);

// Remove tudo que não for dígito
function soDigitos(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Normaliza um telefone brasileiro para o formato E.164 sem o '+',
 * que é o que a Evolution espera: 55 + DDD + 9 dígitos = 13 dígitos.
 * Aceita entrada com ou sem 55, com ou sem máscara.
 * Retorna null se não conseguir normalizar para um celular válido.
 */
function normalizarTelefoneBR(raw) {
  let d = soDigitos(raw);
  // Remove 55 do início se já vier com código do país
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2); // fixo c/ 55
  // Agora d deve ter 11 (celular) ou 10 (fixo) dígitos
  if (d.length !== 11) return null;          // celular = DDD(2) + 9 dígitos
  if (d[2] !== '9') return null;             // celular começa com 9
  const ddd = parseInt(d.slice(0, 2), 10);
  if (!DDDS_VALIDOS.has(ddd)) return null;
  return '55' + d;
}

/**
 * Validação de formato + anti-sequência (sem chamar API).
 * Barra digitação preguiçosa: 99999-9999, 11111-1111, etc.
 */
function validarFormatoBR(raw) {
  const numero = normalizarTelefoneBR(raw);
  if (!numero) {
    return { ok: false, motivo: 'Número inválido. Use DDD + celular (11 dígitos).', numero: null };
  }
  // numero = 55 + DDD(2) + 9 dígitos. Pega só os 9 dígitos do celular.
  const cel = numero.slice(4); // após 55 + DDD
  // Todos iguais? (999999999, 000000000...)
  if (/^(\d)\1{8}$/.test(cel)) {
    return { ok: false, motivo: 'Número parece inválido (dígitos repetidos).', numero: null };
  }
  // Sequência crescente/decrescente óbvia
  if (cel === '912345678' || cel === '987654321') {
    return { ok: false, motivo: 'Número parece inválido (sequência).', numero: null };
  }
  return { ok: true, motivo: null, numero };
}

function evolutionConfig() {
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  return { baseUrl, apiKey, instancia, ok: !!(baseUrl && apiKey && instancia) };
}

/**
 * Valida se o número tem conta no WhatsApp via Evolution.
 * Endpoint: POST /chat/whatsappNumbers/{instance}
 * Body: { numbers: ['5571...'] }
 *
 * Retorna sempre um objeto — nunca lança. Em caso de erro de infra,
 * tem_whatsapp vem como null (indeterminado) e o frontend trata como aviso.
 */
async function validarWhatsApp(raw) {
  const fmt = validarFormatoBR(raw);
  if (!fmt.ok) {
    return { numero: null, tem_whatsapp: false, formato_ok: false, motivo: fmt.motivo };
  }

  const cfg = evolutionConfig();
  if (!cfg.ok) {
    console.warn('[rastreio/validarWhatsApp] Evolution não configurada — pulando check de WhatsApp');
    return { numero: fmt.numero, tem_whatsapp: null, formato_ok: true, motivo: 'Evolution não configurada' };
  }

  try {
    const url = `${cfg.baseUrl}/chat/whatsappNumbers/${cfg.instancia}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.apiKey },
      body: JSON.stringify({ numbers: [fmt.numero] }),
    });
    if (!response.ok) {
      console.warn(`[rastreio/validarWhatsApp] Evolution respondeu ${response.status}`);
      return { numero: fmt.numero, tem_whatsapp: null, formato_ok: true, motivo: 'Não foi possível verificar agora' };
    }
    const data = await response.json();
    // Evolution retorna array: [{ exists: true/false, jid: '...', number: '...' }]
    const item = Array.isArray(data) ? data[0] : null;
    const existe = !!(item && (item.exists === true));
    return {
      numero: fmt.numero,
      tem_whatsapp: existe,
      formato_ok: true,
      jid: item && item.jid ? item.jid : null,
      motivo: existe ? null : 'Este número não tem WhatsApp',
    };
  } catch (err) {
    console.error('[rastreio/validarWhatsApp] exceção:', err.message);
    return { numero: fmt.numero, tem_whatsapp: null, formato_ok: true, motivo: 'Não foi possível verificar agora' };
  }
}

/**
 * Envia a mensagem de rastreio pro cliente final.
 * Não-bloqueante por natureza — quem chama deve tratar como "best effort".
 *
 * @param {object} args
 *   - telefone         (string) número bruto do destinatário
 *   - nomeDestinatario (string) nome fantasia do ponto de entrega, vai em negrito
 *   - osNumero         (string|number) número da OS Tutts
 *   - urlRastreamento  (string) URL tutts.com.br/rastreamento?cod=...
 */
function saudacaoPorHorario() {
  // Horário de Bahia (UTC-3)
  const hora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' })).getHours();
  if (hora >= 5  && hora < 12) return 'Bom dia';
  if (hora >= 12 && hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

async function enviarRastreioCliente({ telefone, nomeDestinatario, osNumero, urlRastreamento }) {
  const fmt = validarFormatoBR(telefone);
  if (!fmt.ok) {
    return { enviado: false, motivo: 'telefone_invalido', detalhe: fmt.motivo };
  }
  if (!urlRastreamento) {
    return { enviado: false, motivo: 'sem_url_rastreamento' };
  }

  const cfg = evolutionConfig();
  if (!cfg.ok) {
    return { enviado: false, motivo: 'evolution_nao_configurada' };
  }

  // Saudação com o nome do destinatário da entrega (nome fantasia do ponto)
  // em *negrito* do WhatsApp. É quem está com o celular e vai receber a mercadoria.
  const periodo = saudacaoPorHorario();
  const saud = `${periodo}! 👋`;
  const linhaPedido = osNumero
    ? `Seu pedido *#${osNumero}* já foi confirmado e está em rota de entrega. 🚚`
    : 'Seu pedido já foi confirmado e está em rota de entrega. 🚚';
  // Aviso em itálico (_..._) — WhatsApp não tem translúcido; itálico dá o tom
  // discreto de "observação" sem competir com a mensagem principal.
  const texto =
    `${saud}\n\n` +
    `${linhaPedido}\n\n` +
    `Acompanhe o rastreio em tempo real pelo link abaixo:\n` +
    `${urlRastreamento}\n\n` +
    `⚠️ *Importante:*\n` +
    `_Este número é automático e não recebe mensagens nem ligações. ` +
    `Caso precise de suporte, entre em contato diretamente com a loja onde realizou a compra._`;

  try {
    const url = `${cfg.baseUrl}/message/sendText/${cfg.instancia}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.apiKey },
      body: JSON.stringify({ number: fmt.numero, text: texto }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(`✅ [rastreio] Enviado para ${fmt.numero} (OS ${osNumero})`);
      return { enviado: true, numero: fmt.numero };
    }
    console.error(`❌ [rastreio] Evolution ${response.status}:`, data);
    return { enviado: false, motivo: 'erro_api', status: response.status };
  } catch (err) {
    console.error('❌ [rastreio] exceção ao enviar:', err.message);
    return { enviado: false, motivo: 'excecao', detalhe: err.message };
  }
}

module.exports = {
  normalizarTelefoneBR,
  validarFormatoBR,
  validarWhatsApp,
  enviarRastreioCliente,
};
