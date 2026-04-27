/**
 * src/middleware/inputSanitizer.js
 * 🔒 SECURITY: Sanitização global de inputs
 *
 * Protege contra:
 * - XSS (script tags, event handlers, javascript: protocol)
 * - Prototype pollution (__proto__, constructor)
 * - Null bytes
 *
 * Roda em TODAS as requests antes das rotas.
 *
 * 2026-04: ALLOWLIST de rotas que pulam a sanitização de campos específicos
 * (uploads de imagem em base64). Motivos:
 *   1. Performance: regex em string de 5MB bloqueia event loop por ~30ms.
 *   2. Risco: base64 contém caracteres arbitrários e pode dar falso positivo
 *      em regex como /<\/script>/i, mutando a string e quebrando a imagem.
 *   3. Sanitização XSS em base64 é semanticamente errada — base64 NUNCA
 *      é renderizado como HTML, é decodado em bytes binários no servidor.
 */

// 2026-04: campos que NÃO devem ser sanitizados nessas rotas (preservados intactos).
// Lista por path prefix → array de nomes de campo do body.
// Match é por path.startsWith(prefix). Uma rota pode ter múltiplos prefixos.
const SKIP_FIELDS_BY_PATH = [
  // Módulo Agente RPA — correção de endereço com fotos
  { prefix: '/api/agent/corrigir-endereco', fields: ['foto_fachada', 'foto_nf'] },
  { prefix: '/agent/corrigir-endereco',     fields: ['foto_fachada', 'foto_nf'] },
  // Outras rotas com upload base64 — adicionar aqui se aparecer "imagem corrompida"
  // após este fix em outras features. Padrão: { prefix, fields: ['campo1', 'campo2'] }
];

/**
 * Sanitiza recursivamente valores string de um objeto, pulando campos da skipList.
 * skipList só vale no NÍVEL TOPO do objeto — campos profundos são sanitizados normal.
 */
function sanitizeValue(value, depth = 0, skipList = null) {
  if (depth > 10) return value;

  if (typeof value === 'string') {
    return value
      .replace(/\0/g, '')                                          // Null bytes
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')        // <script>
      .replace(/<\/script>/gi, '')                                  // </script> orphan
      .replace(/<iframe\b[^>]*>([\s\S]*?)<\/iframe>/gi, '')        // <iframe>
      .replace(/<object\b[^>]*>([\s\S]*?)<\/object>/gi, '')        // <object>
      .replace(/<embed\b[^>]*\/?>/gi, '')                          // <embed>
      .replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi, '')              // <svg> (onload vector)
      .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')              // on*="..." handlers
      .replace(/\bon\w+\s*=\s*[^\s>]+/gi, '')                     // on*=alert(1) sem aspas
      .replace(/javascript\s*:/gi, '')                             // javascript:
      .replace(/vbscript\s*:/gi, '')                               // vbscript:
      .replace(/data\s*:\s*text\/html/gi, '')                      // data:text/html
      .replace(/expression\s*\(/gi, '')                            // CSS expression()
      .trim();
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1, null));
  }

  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [key, val] of Object.entries(value)) {
      // Block prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      // 2026-04: pula campo se estiver na skipList (preserva intacto)
      if (skipList && skipList.includes(key) && typeof val === 'string') {
        sanitized[key] = val;
        continue;
      }
      sanitized[key] = sanitizeValue(val, depth + 1, null);
    }
    return sanitized;
  }

  return value;
}

/**
 * Resolve a skipList aplicável ao path da request.
 * Retorna array de nomes de campo ou null se nenhum prefix matcher.
 */
function resolverSkipList(path) {
  if (!path) return null;
  for (const rule of SKIP_FIELDS_BY_PATH) {
    if (path.startsWith(rule.prefix)) return rule.fields;
  }
  return null;
}

/**
 * Middleware global de sanitização
 * Aplicar ANTES das rotas: app.use(sanitizeInput)
 */
function sanitizeInput(req, res, next) {
  try {
    // Não sanitizar webhooks — o body precisa ficar intacto para validação de assinatura
    if (req.path && (req.path.includes('/webhook') || req.path.includes('/stark/webhook'))) {
      return next();
    }

    const skipList = resolverSkipList(req.path || req.originalUrl);

    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeValue(req.body, 0, skipList);
    }
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeValue(req.query, 0, null);
    }
  } catch (err) {
    console.error('❌ Erro na sanitização de input:', err.message);
  }
  next();
}

module.exports = { sanitizeInput };
