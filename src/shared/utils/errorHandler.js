/**
 * src/shared/utils/errorHandler.js
 * Standardized error responses - prevents information leakage
 */

const env = require('../../config/env');

/**
 * Send safe error response (hides internal details in production)
 * @param {object} res - Express response
 * @param {Error|string} error - The error
 * @param {string} publicMessage - Safe message shown to client
 * @param {number} statusCode - HTTP status (default 500)
 */
function sendError(res, error, publicMessage = 'Erro interno do servidor', statusCode = 500) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Log full error server-side
  console.error(`❌ [${statusCode}] ${publicMessage}:`, errorMessage);

  // In production, never expose internal error details
  if (env.IS_PRODUCTION) {
    return res.status(statusCode).json({ error: publicMessage });
  }

  // In development, include details for debugging
  return res.status(statusCode).json({
    error: publicMessage,
    details: errorMessage,
  });
}

module.exports = { sendError };
