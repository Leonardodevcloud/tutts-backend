/**
 * src/middleware/cache.js
 * Cache middleware para reduzir compute hours no Neon
 *
 * COMO FUNCIONA:
 * - Intercepta GETs em endpoints pesados antes de chegarem nas rotas
 * - Cacheia a resposta em memória (node-cache) com TTL por categoria
 * - Invalida SELETIVAMENTE quando há operações de escrita
 * - Zero mudança nos arquivos de rota — é transparente
 *
 * 🔧 BUGFIX PERFORMANCE (2026-05):
 * - Antes: qualquer escrita em /api/bi chamava flushAll() em TODOS os caches.
 *   Editar uma região derrubava cache de mapa-calor, dashboard, prazos, etc.
 *   Isso fazia o hit rate cair pra perto de zero em horários de uso pesado.
 * - Agora: invalidação seletiva por categoria afetada.
 * - TTL static aumentado de 10min → 30min (esses dados mudam raramente).
 * - Cache-Control adicionado para o browser também guardar (reduz RTT).
 */

const NodeCache = require('node-cache');

// ─── Caches por categoria ─────────────────────────────────
const biCache = new NodeCache({
  stdTTL: 300,        // 5 min — dashboards, analytics, mapa-calor
  checkperiod: 60,
  useClones: false
});

const staticCache = new NodeCache({
  stdTTL: 1800,       // 🔧 30 min — cidades, clientes, categorias, prazos (eram 10min)
  checkperiod: 120,
  useClones: false
});

const shortCache = new NodeCache({
  stdTTL: 30,         // 30s — notificações, contadores
  checkperiod: 15,
  useClones: false
});

// ─── Rotas que devem ser cacheadas ────────────────────────

const BI_HEAVY = new Set([
  '/api/bi/dashboard-completo',
  '/api/bi/dashboard-rapido',
  '/api/bi/dashboard',
  '/api/bi/mapa-calor',
  '/api/bi/acompanhamento-periodico',
  '/api/bi/acompanhamento-clientes',
  '/api/bi/comparativo-semanal',
  '/api/bi/comparativo-semanal-clientes',
  '/api/bi/garantido',
  '/api/bi/garantido/semanal',
  '/api/bi/garantido/por-cliente',
  '/api/bi/dados-filtro',
  '/api/bi/graficos',
  '/api/bi/analise-os',
  '/api/bi/resumo-clientes',
  '/api/bi/resumo-profissionais',
  '/api/bi/cliente-767',
  '/api/bi/relatorio-ia',
  '/api/bi/entregas-lista',
]);

const BI_STATIC = new Set([
  '/api/bi/filtros-iniciais',
  '/api/bi/cidades',
  '/api/bi/clientes',
  '/api/bi/clientes-por-regiao',
  '/api/bi/profissionais',
  '/api/bi/centros-custo',
  '/api/bi/regioes',
  '/api/bi/categorias',
  '/api/bi/prazos',
  '/api/bi/prazo-padrao',
  '/api/bi/prazos-prof',
  '/api/bi/prazo-prof-padrao',
  '/api/bi/mascaras',
  '/api/bi/regras-contagem',
  '/api/bi/localizacao-clientes',
  '/api/bi/datas',
  '/api/bi/uploads',
  '/api/bi/garantido/meta',
  '/api/bi/garantido/status',
]);

const SHORT_PREFIXES = [
  '/api/notifications/',
  '/api/withdrawals/contadores',
  '/api/withdrawals/pendentes',
];

// ─── Helpers ──────────────────────────────────────────────

function cacheKey(req) {
  const params = JSON.stringify(req.query || {});
  return `${req.path}:${params}`;
}

function invalidarBiHeavy() {
  const k = biCache.keys().length;
  biCache.flushAll();
  console.log(`🗑️ Cache BI HEAVY invalidado: ${k} keys`);
}

function invalidarBiStatic() {
  const k = staticCache.keys().length;
  staticCache.flushAll();
  console.log(`🗑️ Cache BI STATIC invalidado: ${k} keys`);
}

function invalidarShort() {
  const k = shortCache.keys().length;
  shortCache.flushAll();
  console.log(`🗑️ Cache SHORT invalidado: ${k} keys`);
}

function invalidarPath(path, cacheRef) {
  const cache = cacheRef || biCache;
  const keys = cache.keys();
  let removidas = 0;
  for (const key of keys) {
    if (key.startsWith(path + ':')) {
      cache.del(key);
      removidas++;
    }
  }
  if (removidas > 0) console.log(`🗑️ Cache ${path}: ${removidas} keys removidas`);
}

function invalidarTudo() {
  invalidarBiHeavy();
  invalidarBiStatic();
  invalidarShort();
}

// ─── Middleware: servir do cache ───────────────────────────

function cacheMiddleware(req, res, next) {
  if (req.method !== 'GET') return next();

  const path = req.path;
  let targetCache = null;
  let browserMaxAge = 0;

  if (BI_HEAVY.has(path)) {
    targetCache = biCache;
    browserMaxAge = 60; // 1min no browser
  } else if (BI_STATIC.has(path)) {
    targetCache = staticCache;
    browserMaxAge = 600; // 10min no browser
  } else if (SHORT_PREFIXES.some(p => path.startsWith(p))) {
    targetCache = shortCache;
    browserMaxAge = 0; // não cacheia no browser
  }

  if (!targetCache) return next();

  const ck = cacheKey(req);
  const cached = targetCache.get(ck);

  if (cached) {
    console.log(`📦 Cache HIT: ${path}`);
    if (browserMaxAge > 0) {
      res.setHeader('Cache-Control', `private, max-age=${browserMaxAge}`);
    }
    return res.json(cached);
  }

  const originalJson = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      targetCache.set(ck, data);
      console.log(`💾 Cache STORE: ${path}`);
      if (browserMaxAge > 0) {
        res.setHeader('Cache-Control', `private, max-age=${browserMaxAge}`);
      }
    }
    return originalJson(data);
  };

  next();
}

// ─── Middleware: invalidar cache em escritas (SELETIVO) ────

function cacheInvalidationMiddleware(req, res, next) {
  if (req.method === 'GET') return next();

  const path = req.path;
  const method = req.method;

  let acao = null;

  // Uploads/recálculos de entregas → derrubam BI HEAVY (dashboards e analytics)
  if (
    path === '/api/bi/entregas/upload' ||
    path === '/api/bi/entregas/recalcular' ||
    path === '/api/bi/entregas/recalcular-prazo-prof'
  ) {
    acao = 'bi_heavy';
  }
  // DELETE em uploads → derruba BI HEAVY + lista de uploads (static)
  else if (method === 'DELETE' && path.startsWith('/api/bi/uploads')) {
    acao = 'bi_heavy_e_static';
  }
  // Operações em regiões/clientes/centros/categorias/prazos/mascaras → só STATIC
  else if (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
    (
      path.startsWith('/api/bi/regioes') ||
      path.startsWith('/api/bi/categorias') ||
      path.startsWith('/api/bi/prazos') ||
      path.startsWith('/api/bi/prazo-padrao') ||
      path.startsWith('/api/bi/prazos-prof') ||
      path.startsWith('/api/bi/prazo-prof-padrao') ||
      path.startsWith('/api/bi/mascaras') ||
      path.startsWith('/api/bi/regras-contagem')
    )
  ) {
    acao = 'bi_static';
  }
  // Garantido (config) → static + heavy do garantido
  else if (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
    (path.startsWith('/api/bi/garantido/meta') || path.startsWith('/api/bi/garantido/status'))
  ) {
    acao = 'bi_static_e_heavy_garantido';
  }

  if (!acao) return next();

  const originalJson = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        if (acao === 'bi_heavy') {
          invalidarBiHeavy();
        } else if (acao === 'bi_static') {
          invalidarBiStatic();
        } else if (acao === 'bi_heavy_e_static') {
          invalidarBiHeavy();
          invalidarBiStatic();
        } else if (acao === 'bi_static_e_heavy_garantido') {
          invalidarBiStatic();
          invalidarPath('/api/bi/garantido', biCache);
          invalidarPath('/api/bi/garantido/semanal', biCache);
          invalidarPath('/api/bi/garantido/por-cliente', biCache);
        }
      } catch (e) {
        console.error('Erro ao invalidar cache:', e.message);
      }
    }
    return originalJson(data);
  };

  next();
}

// ─── Stats (log a cada 30 min) ────────────────────────────

setInterval(() => {
  const sb = biCache.getStats();
  const ss = staticCache.getStats();
  const tb = sb.hits + sb.misses;
  const ts = ss.hits + ss.misses;
  const rb = tb > 0 ? ((sb.hits / tb) * 100).toFixed(1) : 0;
  const rs = ts > 0 ? ((ss.hits / ts) * 100).toFixed(1) : 0;
  console.log(
    `📊 Cache — BI[hits:${sb.hits} miss:${sb.misses} rate:${rb}% keys:${biCache.keys().length}] ` +
    `STATIC[hits:${ss.hits} miss:${ss.misses} rate:${rs}% keys:${staticCache.keys().length}]`
  );
}, 30 * 60 * 1000);

// ─── Exports ──────────────────────────────────────────────

module.exports = {
  cacheMiddleware,
  cacheInvalidationMiddleware,
  invalidarTudo,
  invalidarBiHeavy,
  invalidarBiStatic,
  invalidarShort,
  invalidarPath,
};
