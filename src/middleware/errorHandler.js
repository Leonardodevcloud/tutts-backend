/**
 * src/middleware/errorHandler.js
 * Tratamento centralizado de erros
 */

const env = require('../config/env');
const { AppError } = require('../shared/errors/AppError');

// Handler genérico para uso nos módulos
const handleError = (res, error, contexto, statusCode = 500) => {
  console.error(`❌ ${contexto}:`, error.message || error);

  const mensagemCliente = env.IS_PRODUCTION
    ? 'Erro interno do servidor'
    : `${contexto}: ${error.message || 'Erro desconhecido'}`;

  return res.status(statusCode).json({
    error: mensagemCliente,
    ref: Date.now().toString(36),
  });
};

// Middleware 404 - rota não encontrada
const notFoundHandler = (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.status(404).json({ error: 'Rota não encontrada', path: req.path });
};

// Middleware global de erros (DEVE ser o último app.use)
const globalErrorHandler = (err, req, res, _next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Se é um AppError nosso, usar status e mensagem
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ref: Date.now().toString(36),
    });
  }

  console.error('❌ Erro não tratado:', err.message);
  res.status(err.status || 500).json({ error: 'Erro interno do servidor' });
};

module.exports = { handleError, notFoundHandler, globalErrorHandler };
