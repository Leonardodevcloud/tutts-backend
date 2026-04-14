/**
 * CS Email Service — Envio de Raio-X por email via Resend
 *
 * Recursos:
 *  - Provider Resend (HTTP API, sem SMTP)
 *  - Converte <svg> do relatório em PNG inline via sharp (librsvg) — resolve o
 *    problema de clientes de email (Gmail, Outlook) que strippam tags SVG
 *  - Formata datas para DD/MM/YYYY automaticamente
 *  - Aceita assunto customizado vindo do frontend
 *
 * Configuração via .env (Railway):
 *   RESEND_API_KEY    = re_xxxxxxxxxxxxxxxx   (obrigatório)
 *   RESEND_FROM       = supervisor@tutts.com.br  (domínio verificado no Resend)
 *   RESEND_FROM_NAME  = Tutts Logística       (opcional — default "Tutts Logística")
 */

const sharp = require('sharp');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const fromName = process.env.RESEND_FROM_NAME || 'Tutts Logística';

  if (!apiKey) throw new Error('Resend não configurado: defina RESEND_API_KEY no Railway');
  if (!from) throw new Error('Resend não configurado: defina RESEND_FROM (email do domínio verificado)');
  return { apiKey, from, fromName };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Formata uma data para DD/MM/YYYY.
 * Aceita: Date (driver pg), string ISO, string DD/MM/YYYY (retorna como veio).
 */
function formatarData(valor) {
  if (!valor) return '';
  if (typeof valor === 'string' && /^\d{2}\/\d{2}\/\d{4}/.test(valor)) return valor.slice(0, 10);
  const d = valor instanceof Date ? valor : new Date(valor);
  if (isNaN(d.getTime())) return String(valor);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const ano = d.getUTCFullYear();
  return `${dia}/${mes}/${ano}`;
}

/**
 * Converte um bloco SVG (string) para um data URI PNG base64 usando sharp.
 * Retorna null em caso de erro (o chamador decide fallback).
 */
async function svgParaDataURI(svgString) {
  try {
    const pngBuffer = await sharp(Buffer.from(svgString), { density: 144 })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    const base64 = pngBuffer.toString('base64');
    return `data:image/png;base64,${base64}`;
  } catch (error) {
    console.error('❌ [Email] Falha ao converter SVG para PNG:', error.message);
    return null;
  }
}

/**
 * Extrai largura/altura de um SVG string para calcular max-width da <img>.
 */
function extrairDimensoesSVG(svgString) {
  const wMatch = svgString.match(/\bwidth="(\d+)"/);
  const hMatch = svgString.match(/\bheight="(\d+)"/);
  const vbMatch = svgString.match(/viewBox="0 0 (\d+) (\d+)"/);
  const width = wMatch ? parseInt(wMatch[1], 10) : (vbMatch ? parseInt(vbMatch[1], 10) : 600);
  const height = hMatch ? parseInt(hMatch[1], 10) : (vbMatch ? parseInt(vbMatch[2], 10) : 300);
  return { width, height };
}

/**
 * Encontra todos os blocos <svg>...</svg> no conteúdo HTML e os substitui
 * por <img src="data:image/png;base64,..."> de modo compatível com email.
 */
async function substituirSVGsPorPNGs(html) {
  const svgRegex = /<svg[\s\S]*?<\/svg>/g;
  const matches = html.match(svgRegex) || [];
  if (matches.length === 0) return html;

  const substituicoes = await Promise.all(
    matches.map(async (svg) => {
      const dataUri = await svgParaDataURI(svg);
      if (!dataUri) {
        return '<div style="padding:12px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:8px;font-size:12px;color:#92400e;text-align:center">📊 Gráfico indisponível neste email — veja a versão em PDF</div>';
      }
      const { width } = extrairDimensoesSVG(svg);
      return `<img src="${dataUri}" alt="Gráfico" width="${width}" style="display:block;max-width:100%;height:auto;margin:8px auto;border-radius:8px" />`;
    })
  );

  let i = 0;
  return html.replace(svgRegex, () => substituicoes[i++]);
}

// ─────────────────────────────────────────────────────────────
// Geração do HTML do email
// ─────────────────────────────────────────────────────────────

async function gerarEmailHTML(raioX, cliente, periodo) {
  const score = raioX.score_saude || raioX.health_score || 0;
  const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  const scoreLabel = score >= 80 ? 'Excelente' : score >= 60 ? 'Bom' : 'Atenção';

  let conteudo = raioX.analise_texto || raioX.analise || '';

  // 1) Proteger blocos HTML/SVG antes do markdown
  const htmlBlocks = [];
  conteudo = conteudo.replace(
    /<div\s+style="margin:[^"]*"[^>]*>[\s\S]*?<\/div>/g,
    (match) => {
      htmlBlocks.push(match);
      return `__HTMLBLOCK_${htmlBlocks.length - 1}__`;
    }
  );

  // 2) Markdown → HTML (inline styles para email)
  conteudo = conteudo
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:16px;color:#4f46e5;margin-top:28px;margin-bottom:8px;border-bottom:2px solid #e0e7ff;padding-bottom:4px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:18px;color:#4f46e5;margin-top:28px;margin-bottom:8px">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#1e293b">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px;color:#334155">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px;color:#334155">$1</li>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#4f46e5;text-decoration:underline">$1</a>')
    .replace(/(https?:\/\/[^\s<]+)/g, (match) => {
      if (match.includes('mapa-calor')) {
        return `<a href="${match}" style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin:12px 0">🗺️ Abrir Mapa de Calor Interativo</a>`;
      }
      return `<a href="${match}" style="color:#4f46e5">${match}</a>`;
    })
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');

  // 3) Restaurar blocos HTML protegidos
  htmlBlocks.forEach((block, i) => {
    conteudo = conteudo.replace(`__HTMLBLOCK_${i}__`, block);
  });

  // 4) Converter todos os <svg> em <img> PNG inline
  conteudo = await substituirSVGsPorPNGs(conteudo);

  const periodoInicio = formatarData(periodo.inicio);
  const periodoFim = formatarData(periodo.fim);
  const nomeCliente = cliente.nome || 'Cliente';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Roboto,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:20px 0">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

<!-- Header -->
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center">
  <h1 style="color:white;font-size:24px;margin:0 0 4px;font-family:'Segoe UI',sans-serif">🔬 Raio-X Operacional</h1>
  <p style="color:rgba(255,255,255,0.85);font-size:14px;margin:0">${nomeCliente}</p>
  <p style="color:rgba(255,255,255,0.65);font-size:12px;margin:8px 0 0">Período: ${periodoInicio} a ${periodoFim}</p>
</td></tr>

<!-- Score Badge -->
<tr><td style="padding:24px 40px 0;text-align:center">
  <table cellpadding="0" cellspacing="0" style="margin:0 auto">
  <tr>
    <td style="background:${scoreColor};color:white;font-size:32px;font-weight:800;width:72px;height:72px;border-radius:50%;text-align:center;vertical-align:middle;line-height:72px">${score}</td>
    <td style="padding-left:16px;text-align:left">
      <p style="font-size:18px;font-weight:700;color:${scoreColor};margin:0">${scoreLabel}</p>
      <p style="font-size:12px;color:#94a3b8;margin:4px 0 0">Health Score</p>
    </td>
  </tr>
  </table>
</td></tr>

<!-- Content -->
<tr><td style="padding:24px 40px 40px;font-size:13px;line-height:1.7;color:#334155">
${conteudo}
</td></tr>

<!-- Footer -->
<tr><td style="background:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;text-align:center">
  <p style="font-size:12px;color:#94a3b8;margin:0">Relatório gerado automaticamente pela plataforma Tutts</p>
  <p style="font-size:12px;color:#94a3b8;margin:4px 0 0">© ${new Date().getFullYear()} Tutts — Logística Inteligente para Autopeças</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Envio
// ─────────────────────────────────────────────────────────────

function normalizarDestinatarios(valor) {
  if (!valor) return undefined;
  if (Array.isArray(valor)) return valor.map((v) => String(v).trim()).filter(Boolean);
  return String(valor)
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Envia o relatório Raio-X por email via Resend.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.para       Email(s) destinatário
 * @param {string|string[]} [opts.cc]       CC
 * @param {Object}          opts.raioX      Objeto do raio-x (analise_texto, score_saude)
 * @param {Object}          opts.cliente    { nome }
 * @param {Object}          opts.periodo    { inicio, fim }
 * @param {string}          [opts.assunto]  Assunto customizado (sobrescreve o padrão)
 * @param {string}          [opts.remetente] Email remetente (precisa estar no domínio verificado)
 */
async function enviarRaioXEmail({ para, cc, raioX, cliente, periodo, assunto, remetente }) {
  const { apiKey, from, fromName } = getResendConfig();

  const fromEmail = remetente || from;
  const nomeCliente = cliente.nome || 'Cliente';
  const periodoInicio = formatarData(periodo.inicio);
  const periodoFim = formatarData(periodo.fim);

  const html = await gerarEmailHTML(raioX, cliente, periodo);

  const subject =
    (assunto && String(assunto).trim()) ||
    `Raio-X Operacional - ${nomeCliente} (${periodoInicio} a ${periodoFim})`;

  const destinatarios = normalizarDestinatarios(para);
  if (!destinatarios || destinatarios.length === 0) {
    throw new Error('Nenhum destinatário válido informado');
  }

  const payload = {
    from: `${fromName} <${fromEmail}>`,
    to: destinatarios,
    reply_to: fromEmail,
    subject,
    html,
  };
  const ccList = normalizarDestinatarios(cc);
  if (ccList && ccList.length > 0) payload.cc = ccList;

  let response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('❌ [Resend] Erro de rede:', error.message);
    throw new Error(`Falha de rede ao chamar Resend: ${error.message}`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('❌ [Resend] Erro HTTP', response.status, data);
    const msg = data.message || data.error || response.statusText;
    if (response.status === 401 || response.status === 403) {
      throw new Error('API key do Resend inválida ou sem permissão — verifique RESEND_API_KEY');
    }
    if (response.status === 422) {
      throw new Error(`Dados inválidos para Resend: ${msg} (verifique se ${fromEmail} está no domínio verificado)`);
    }
    if (response.status === 429) {
      throw new Error('Limite de envio do Resend atingido — aguarde alguns segundos e tente novamente');
    }
    throw new Error(`Resend ${response.status}: ${msg}`);
  }

  console.log(`📧 [Resend] Email Raio-X enviado: ${destinatarios.join(', ')} (id: ${data.id})`);
  return {
    messageId: data.id,
    accepted: destinatarios,
    rejected: [],
    response: `Resend ${response.status}`,
  };
}

/**
 * Testa a API do Resend sem enviar email.
 */
async function testarConexaoSMTP() {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return { ok: false, message: 'RESEND_API_KEY não configurada no Railway', code: 'NO_KEY' };
    if (!process.env.RESEND_FROM) return { ok: false, message: 'RESEND_FROM não configurada no Railway', code: 'NO_FROM' };

    const response = await fetch('https://api.resend.com/domains', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'API key do Resend inválida ou sem permissão', code: 'EAUTH' };
    }
    if (!response.ok) {
      return { ok: false, message: `Resend respondeu ${response.status}`, code: 'HTTP_' + response.status };
    }

    const data = await response.json().catch(() => ({}));
    const domains = Array.isArray(data.data) ? data.data : [];
    const fromDomain = process.env.RESEND_FROM.split('@')[1];
    const match = domains.find((d) => d.name === fromDomain);

    if (!match) {
      return { ok: false, message: `Domínio "${fromDomain}" não encontrado na conta Resend — verifique RESEND_FROM`, code: 'NO_DOMAIN' };
    }
    if (match.status !== 'verified') {
      return { ok: false, message: `Domínio "${fromDomain}" não está verificado no Resend (status: ${match.status})`, code: 'NOT_VERIFIED' };
    }

    return { ok: true, message: `Conexão Resend OK — domínio ${fromDomain} verificado` };
  } catch (error) {
    return { ok: false, message: error.message, code: error.code || 'UNKNOWN' };
  }
}

module.exports = { enviarRaioXEmail, testarConexaoSMTP, formatarData };
