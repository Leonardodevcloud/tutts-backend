/**
 * Financial Shared - PLIFIC config + cache
 */
const rateLimit = require('express-rate-limit');

function createFinancialHelpers(getClientIP) {
  const withdrawalCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Limite de solicitações de saque atingido. Tente novamente em 1 hora.' },
    keyGenerator: (req) => {
      if (req.user && req.user.codProfissional) {
        return `withdrawal_${req.user.codProfissional}`;
      }
      return getClientIP(req);
    }
  });

  const PLIFIC_CONFIG = {
    BASE_URL_TESTE: 'https://mototaxionline.com/sem/v1/rotas.php/integracao-plific-saldo-prof',
    BASE_URL_PRODUCAO: 'https://tutts.com.br/sem/v1/rotas.php/integracao-plific-saldo-prof',
    RATE_LIMIT: 10,
    RATE_LIMIT_WINDOW: 1000,
    CACHE_TTL: 1 * 60 * 1000
  };

  const PLIFIC_AMBIENTE = process.env.PLIFIC_AMBIENTE || 'teste';
  const PLIFIC_BASE_URL = PLIFIC_AMBIENTE === 'producao' ? PLIFIC_CONFIG.BASE_URL_PRODUCAO : PLIFIC_CONFIG.BASE_URL_TESTE;
  const PLIFIC_TOKEN = process.env.PLIFIC_TOKEN;
  const plificSaldoCache = new Map();

  const limparCachePlific = () => {
    const agora = Date.now();
    for (const [key, value] of plificSaldoCache.entries()) {
      if (agora - value.timestamp > PLIFIC_CONFIG.CACHE_TTL) {
        plificSaldoCache.delete(key);
      }
    }
  };
  setInterval(limparCachePlific, PLIFIC_CONFIG.CACHE_TTL);

  return {
    withdrawalCreateLimiter,
    PLIFIC_CONFIG, PLIFIC_AMBIENTE, PLIFIC_BASE_URL, PLIFIC_TOKEN,
    plificSaldoCache
  };
}

module.exports = { createFinancialHelpers };
