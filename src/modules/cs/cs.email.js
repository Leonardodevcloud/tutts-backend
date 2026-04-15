/**
 * CS Email Service — Envio de Raio-X por email via Resend
 *
 * Modos:
 *  - Raio-X Interno: aplica protegerBlocosHTML + markdown → HTML
 *  - Raio-X Cliente: usa o analise_texto como HTML pronto (tipo_analise='cliente')
 *  Em ambos os modos, converte <svg> em PNG anexado via CID (funciona em Roundcube, Gmail, Outlook)
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

async function svgParaPngBuffer(svgString) {
  try {
    return await sharp(Buffer.from(svgString), { density: 144 })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch (error) {
    console.error('❌ [Email] Falha ao converter SVG para PNG:', error.message);
    return null;
  }
}

function extrairDimensoesSVG(svgString) {
  const wMatch = svgString.match(/\bwidth="(\d+)"/);
  const hMatch = svgString.match(/\bheight="(\d+)"/);
  const vbMatch = svgString.match(/viewBox="0 0 (\d+) (\d+)"/);
  const width = wMatch ? parseInt(wMatch[1], 10) : (vbMatch ? parseInt(vbMatch[1], 10) : 600);
  const height = hMatch ? parseInt(hMatch[1], 10) : (vbMatch ? parseInt(vbMatch[2], 10) : 300);
  return { width, height };
}

/**
 * Substitui cada <svg>...</svg> por <img src="cid:chart-N"> e gera attachments Resend.
 */
async function prepararImagensInline(html) {
  const svgRegex = /<svg[\s\S]*?<\/svg>/g;
  const matches = html.match(svgRegex) || [];
  if (matches.length === 0) return { html, attachments: [] };

  const attachments = [];
  const timestamp = Date.now();

  const substituicoes = await Promise.all(
    matches.map(async (svg, idx) => {
      const pngBuffer = await svgParaPngBuffer(svg);
      if (!pngBuffer) {
        return '<div style="padding:12px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:8px;font-size:12px;color:#92400e;text-align:center">📊 Gráfico indisponível neste email — veja a versão em PDF</div>';
      }
      const cid = `chart-${timestamp}-${idx}`;
      const filename = `grafico-${idx + 1}.png`;
      attachments.push({
        filename,
        content: pngBuffer.toString('base64'),
        content_id: cid,
        content_type: 'image/png',
      });
      const { width } = extrairDimensoesSVG(svg);
      return `<img src="cid:${cid}" alt="Gráfico ${idx + 1}" width="${width}" style="display:block;max-width:100%;height:auto;margin:8px auto;border-radius:8px" />`;
    })
  );

  let i = 0;
  const htmlProcessado = html.replace(svgRegex, () => substituicoes[i++]);
  return { html: htmlProcessado, attachments };
}

/**
 * Substitui <img src="data:image/...;base64,..."> por <img src="cid:imgembed-N">
 * e gera attachments Resend. Resolve o problema de clientes de email (Roundcube,
 * Outlook corporativo) que strippam data URIs em img src por razões de segurança.
 *
 * Detecta qualquer <img> com src data URI, preservando os outros atributos (width, style, alt).
 */
function prepararDataURIsInline(html, timestamp) {
  // Regex captura: ([prefixo])src="data:image/TIPO;base64,DADOS"([sufixo]) dentro de <img ...>
  // Usa captura de grupos pra reconstruir o <img> mantendo todos os outros atributos
  const imgDataUriRegex = /<img\b([^>]*?)\bsrc\s*=\s*["']data:image\/([a-z]+);base64,([^"']+)["']([^>]*)\/?>/gi;
  const attachments = [];
  let idx = 0;

  const htmlProcessado = html.replace(imgDataUriRegex, (match, antes, mimeExt, base64Data, depois) => {
    const cid = `imgembed-${timestamp}-${idx}`;
    const ext = mimeExt.toLowerCase();
    const contentType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const filename = `imagem-${idx + 1}.${ext === 'jpeg' ? 'jpg' : ext}`;
    attachments.push({
      filename,
      content: base64Data,
      content_id: cid,
      content_type: contentType,
    });
    idx++;
    // Reconstroi a tag <img> mantendo atributos originais (width, style, alt), trocando só o src.
    // Remove barra "/" final que o regex pode ter capturado em "depois" pra não duplicar.
    const depoisLimpo = depois.replace(/\s*\/\s*$/, '');
    return `<img${antes} src="cid:${cid}"${depoisLimpo} />`;
  });

  return { html: htmlProcessado, attachments };
}

/**
 * Protege blocos <div style="margin:...">...</div> usando depth counter.
 */
function protegerBlocosHTML(texto) {
  const blocks = [];
  const startMarker = '<div style="margin:';
  let result = '';
  let i = 0;

  while (i < texto.length) {
    const startIdx = texto.indexOf(startMarker, i);
    if (startIdx === -1) {
      result += texto.substring(i);
      break;
    }
    result += texto.substring(i, startIdx);

    let depth = 0;
    let j = startIdx;
    let foundClose = false;

    while (j < texto.length) {
      if (texto.charCodeAt(j) === 60 /* '<' */) {
        if (texto.substring(j, j + 4) === '<div') {
          const nextChar = texto[j + 4];
          if (nextChar === ' ' || nextChar === '>' || nextChar === '\t' || nextChar === '\n' || nextChar === '\r') {
            depth++;
            const tagEnd = texto.indexOf('>', j);
            if (tagEnd === -1) break;
            j = tagEnd + 1;
            continue;
          }
        }
        if (texto.substring(j, j + 6) === '</div>') {
          depth--;
          j += 6;
          if (depth === 0) {
            foundClose = true;
            break;
          }
          continue;
        }
      }
      j++;
    }

    if (!foundClose) {
      blocks.push(texto.substring(startIdx));
      result += `__HTMLBLOCK_${blocks.length - 1}__`;
      i = texto.length;
      break;
    }

    const block = texto.substring(startIdx, j);
    blocks.push(block);
    result += `__HTMLBLOCK_${blocks.length - 1}__`;
    i = j;
  }

  return { texto: result, blocks };
}

// ─────────────────────────────────────────────────────────────
// Geração do HTML do email
// ─────────────────────────────────────────────────────────────

/**
 * Modo INTERNO: monta HTML do raio-x técnico (wrapper + markdown processing).
 */
async function gerarEmailHTMLInterno(raioX, cliente, periodo) {
  const score = raioX.score_saude || raioX.health_score || 0;
  const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  const scoreLabel = score >= 80 ? 'Excelente' : score >= 60 ? 'Bom' : 'Atenção';

  let conteudo = raioX.analise_texto || raioX.analise || '';

  // 1) Proteger blocos HTML/SVG com depth-counter
  const protegido = protegerBlocosHTML(conteudo);
  conteudo = protegido.texto;
  const htmlBlocks = protegido.blocks;

  // 2) Markdown → HTML
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

  // 3) Restaurar blocos
  htmlBlocks.forEach((block, idx) => {
    conteudo = conteudo.replace(`__HTMLBLOCK_${idx}__`, block);
  });

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
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center">
  <h1 style="color:white;font-size:24px;margin:0 0 4px;font-family:'Segoe UI',sans-serif">🔬 Raio-X Operacional</h1>
  <p style="color:rgba(255,255,255,0.85);font-size:14px;margin:0">${nomeCliente}</p>
  <p style="color:rgba(255,255,255,0.65);font-size:12px;margin:8px 0 0">Período: ${periodoInicio} a ${periodoFim}</p>
</td></tr>
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
<tr><td style="padding:24px 40px 40px;font-size:13px;line-height:1.7;color:#334155">
${conteudo}
</td></tr>
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
  return String(valor).split(/[;,]/).map((v) => v.trim()).filter(Boolean);
}

/**
 * Envia o relatório Raio-X por email via Resend.
 *
 * Se raioX.tipo_analise === 'cliente', usa raioX.analise_texto como HTML pronto
 * (não aplica markdown nem wrapper). Em ambos os modos converte SVGs → CID PNG.
 */
async function enviarRaioXEmail({ para, cc, raioX, cliente, periodo, assunto, remetente }) {
  const { apiKey, from, fromName } = getResendConfig();

  const fromEmail = remetente || from;
  const nomeCliente = cliente.nome || 'Cliente';
  const periodoInicio = formatarData(periodo.inicio);
  const periodoFim = formatarData(periodo.fim);

  // ─── Modo de geração do HTML ───
  let htmlBruto;
  const isCliente = raioX.tipo_analise === 'cliente';
  if (isCliente) {
    // Relatório Cliente: o analise_texto JÁ É um HTML completo montado pelo raioXCliente.routes.js.
    // Não re-processa markdown, apenas converte SVGs em CIDs.
    htmlBruto = raioX.analise_texto || '';
    if (!htmlBruto.trim()) {
      throw new Error('Relatório cliente sem conteúdo HTML — regenere o relatório');
    }
    console.log(`📧 [Email] Modo CLIENTE — usando HTML pré-montado (${htmlBruto.length} chars)`);
  } else {
    // Modo interno (padrão): monta HTML com wrapper + processamento de markdown
    htmlBruto = await gerarEmailHTMLInterno(raioX, cliente, periodo);
  }

  // ─── Converter SVGs → PNG + CID attachments (em ambos os modos) ───
  const svgResult = await prepararImagensInline(htmlBruto);
  // ─── Converter data URIs de imagens (ex: screenshot do mapa) → CID attachments ───
  // Roda SEMPRE, independente do modo, porque o relatório cliente embed mapa como data URI JPEG
  const dataUriResult = prepararDataURIsInline(svgResult.html, Date.now());

  const html = dataUriResult.html;
  const attachments = [...svgResult.attachments, ...dataUriResult.attachments];

  const subject =
    (assunto && String(assunto).trim()) ||
    (isCliente
      ? `Relatório Operacional - ${nomeCliente} (${periodoInicio} a ${periodoFim})`
      : `Raio-X Operacional - ${nomeCliente} (${periodoInicio} a ${periodoFim})`);

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
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments;
    console.log(`📎 [Resend] ${attachments.length} gráfico(s) anexado(s) via CID`);
  }

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
    if (response.status === 413) {
      throw new Error('Email muito grande — reduza o número de gráficos ou imagens');
    }
    throw new Error(`Resend ${response.status}: ${msg}`);
  }

  console.log(`📧 [Resend] Email ${isCliente ? 'CLIENTE' : 'interno'} enviado: ${destinatarios.join(', ')} (id: ${data.id})`);
  return {
    messageId: data.id,
    accepted: destinatarios,
    rejected: [],
    response: `Resend ${response.status}`,
  };
}

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
