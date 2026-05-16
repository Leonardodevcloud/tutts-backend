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

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 2026-05 Filtros de data com correção de fuso (Salvador/BA — UTC-3)
// ───────────────────────────────────────────────────────────────────────────
// O <input type="date"> do front manda 'YYYY-MM-DD'. As colunas de data no
// banco (created_at, approved_at, lancamento_at, debito_plific_at, etc.) são
// `timestamp` armazenados em UTC (NOW() do Neon / new Date() ISO).
//
// Comparar direto com `$1::date` trata a meia-noite como UTC. Como Salvador é
// UTC-3, um saque feito às 21h-23h59 (horário local) cai no dia UTC SEGUINTE.
// Resultado: o saque "vaza" pro filtro de D+1 e some do D que o usuário espera.
//
// Estas funções convertem a borda do dia LOCAL para o instante UTC equivalente:
//   - `($n::date)::timestamp AT TIME ZONE TZ` → interpreta a meia-noite como
//      horário local e devolve o timestamptz (instante real)
//   - `... AT TIME ZONE 'UTC'` → reconverte pro relógio UTC, que é o fuso em
//      que a coluna está gravada.
// É DST-safe (usa o tz database do Postgres).
const TZ_NEGOCIO = 'America/Bahia';

// coluna >= 00:00 (horário local) do dia informado em $idxParam
function sqlDataInicio(coluna, idxParam) {
  return `${coluna} >= (($${idxParam}::date)::timestamp AT TIME ZONE '${TZ_NEGOCIO}') AT TIME ZONE 'UTC'`;
}

// coluna < 00:00 (horário local) do dia SEGUINTE — cobre o dia inteiro de $idxParam
function sqlDataFim(coluna, idxParam) {
  return `${coluna} < ((($${idxParam}::date + 1)::timestamp AT TIME ZONE '${TZ_NEGOCIO}') AT TIME ZONE 'UTC')`;
}

module.exports = { createFinancialHelpers, TZ_NEGOCIO, sqlDataInicio, sqlDataFim };
