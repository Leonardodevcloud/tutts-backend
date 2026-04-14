/**
 * CS Email Service — Envio de Raio-X por email via Resend
 *
 * Usa a API HTTP do Resend (https://resend.com/docs/api-reference/emails/send-email)
 * em vez de SMTP, o que elimina problemas de porta bloqueada no Railway e latência
 * de cold start na negociação TLS.
 *
 * Configuração via .env (Railway):
 *   RESEND_API_KEY    = re_xxxxxxxxxxxxxxxx   (obrigatório)
 *   RESEND_FROM       = supervisor@tutts.com.br  (precisa estar no domínio verificado no Resend)
 *   RESEND_FROM_NAME  = Tutts Logística       (opcional — default "Tutts Logística")
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const fromName = process.env.RESEND_FROM_NAME || 'Tutts Logística';

  if (!apiKey) {
    throw new Error('Resend não configurado: defina RESEND_API_KEY no Railway');
  }
  if (!from) {
    throw new Error('Resend não configurado: defina RESEND_FROM (email do domínio verificado)');
  }
  return { apiKey, from, fromName };
}

function gerarEmailHTML(raioX, cliente, periodo) {
  const score = raioX.score_saude || raioX.health_score || 0;
  const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  const scoreLabel = score >= 80 ? 'Excelente' : score >= 60 ? 'Bom' : 'Atenção';

  let conteudo = raioX.analise_texto || raioX.analise || '';

  // Proteger blocos SVG/HTML inline antes do processamento markdown
  const htmlBlocks = [];
  let safetyCounter = 0;
  while (safetyCounter < 20) {
    const startIdx = conteudo.indexOf('<div style="margin:');
    if (startIdx === -1) break;
    let depth = 0, endIdx = -1;
    for (let i = startIdx; i < conteudo.length - 5; i++) {
      if (conteudo.substring(i, i + 4) === '<div') depth++;
      if (conteudo.substring(i, i + 6) === '</div>') {
        depth--;
        if (depth === 0) { endIdx = i + 6; break; }
      }
    }
    if (endIdx === -1) break;
    const block = conteudo.substring(startIdx, endIdx);
    htmlBlocks.push(block);
    conteudo = conteudo.substring(0, startIdx) + `__HTMLBLOCK_${htmlBlocks.length - 1}__` + conteudo.substring(endIdx);
    safetyCounter++;
  }

  // Markdown → HTML (inline styles para compatibilidade com clientes de email)
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

  // Restaurar blocos SVG/HTML protegidos
  htmlBlocks.forEach((block, i) => {
    conteudo = conteudo.replace(`__HTMLBLOCK_${i}__`, block);
  });

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
  <p style="color:rgba(255,255,255,0.85);font-size:14px;margin:0">${cliente.nome || 'Cliente'}</p>
  <p style="color:rgba(255,255,255,0.65);font-size:12px;margin:8px 0 0">Período: ${periodo.inicio} a ${periodo.fim}</p>
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

/**
 * Normaliza destinatários para array de strings (formato esperado pelo Resend).
 */
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
 * @param {string|string[]} opts.para  Email(s) destinatário
 * @param {string|string[]} [opts.cc]  CC
 * @param {Object} opts.raioX          Objeto do raio-x (analise_texto, score_saude)
 * @param {Object} opts.cliente        { nome }
 * @param {Object} opts.periodo        { inicio, fim }
 * @param {string} [opts.remetente]    Email remetente customizado (precisa estar no domínio verificado)
 */
async function enviarRaioXEmail({ para, cc, raioX, cliente, periodo, remetente }) {
  const { apiKey, from, fromName } = getResendConfig();

  const fromEmail = remetente || from;
  const html = gerarEmailHTML(raioX, cliente, periodo);
  const nomeCliente = cliente.nome || 'Cliente';
  const subject = `Raio-X Operacional - ${nomeCliente} (${periodo.inicio} a ${periodo.fim})`;

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
      // timeout implícito — Resend responde em <2s normalmente
    });
  } catch (error) {
    console.error('❌ [Resend] Erro de rede:', error.message);
    throw new Error(`Falha de rede ao chamar Resend: ${error.message}`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('❌ [Resend] Erro HTTP', response.status, data);
    // Mensagens amigáveis para os erros mais comuns do Resend
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
 * Testa a API do Resend sem enviar email — valida a API key chamando o endpoint
 * de listagem de domínios (read-only, não consome cota de envio).
 */
async function testarConexaoSMTP() {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return { ok: false, message: 'RESEND_API_KEY não configurada no Railway', code: 'NO_KEY' };
    }
    if (!process.env.RESEND_FROM) {
      return { ok: false, message: 'RESEND_FROM não configurada no Railway', code: 'NO_FROM' };
    }

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
      return {
        ok: false,
        message: `Domínio "${fromDomain}" não encontrado na conta Resend — verifique RESEND_FROM`,
        code: 'NO_DOMAIN',
      };
    }
    if (match.status !== 'verified') {
      return {
        ok: false,
        message: `Domínio "${fromDomain}" não está verificado no Resend (status: ${match.status})`,
        code: 'NOT_VERIFIED',
      };
    }

    return { ok: true, message: `Conexão Resend OK — domínio ${fromDomain} verificado` };
  } catch (error) {
    return { ok: false, message: error.message, code: error.code || 'UNKNOWN' };
  }
}

module.exports = { enviarRaioXEmail, testarConexaoSMTP };
