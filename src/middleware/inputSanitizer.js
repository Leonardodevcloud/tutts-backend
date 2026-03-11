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
 */

/**
 * Sanitiza recursivamente valores string de um objeto
 */
function sanitizeValue(value, depth = 0) {
  if (depth > 10) return value;

  if (typeof value === 'string') {
    return value
      .replace(/\0/g, '')
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
      .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/javascript\s*:/gi, '')
      .trim();
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [key, val] of Object.entries(value)) {
      // Block prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      sanitized[key] = sanitizeValue(val, depth + 1);
    }
    return sanitized;
  }

  return value;
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

    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeValue(req.body);
    }
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeValue(req.query);
    }
  } catch (err) {
    console.error('❌ Erro na sanitização de input:', err.message);
  }
  next();
}

module.exports = { sanitizeInput };
