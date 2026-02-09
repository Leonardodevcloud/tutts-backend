/**
 * src/middleware/cache.js
 * Cache middleware para reduzir compute hours no Neon
 * 
 * COMO FUNCIONA:
 * - Intercepta GETs em endpoints pesados antes de chegarem nas rotas
 * - Cacheia a resposta em memória (node-cache) com TTL por categoria
 * - Invalida tudo quando há operações de escrita (upload, delete, recalcular)
 * - Zero mudança nos arquivos de rota — é transparente
 */

const NodeCache = require('node-cache');

// ─── Caches por categoria ─────────────────────────────────
const biCache = new NodeCache({ 
  stdTTL: 300,        // 5 min — dashboards, analytics, mapa-calor
  checkperiod: 60,
  useClones: false
});

const staticCache = new NodeCache({ 
  stdTTL: 600,        // 10 min — cidades, clientes, categorias, prazos
  checkperiod: 120
});

const shortCache = new NodeCache({ 
  stdTTL: 30,         // 30s — notificações, contadores
  checkperiod: 15
});

// ─── Rotas que devem ser cacheadas ────────────────────────

// Cache 5 min: endpoints pesados (muitas queries, aggregations)
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

// Cache 10 min: dados que mudam raramente
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

// Cache 30s: endpoints polled com frequência
const SHORT_PREFIXES = [
  '/api/notifications/',
  '/api/withdrawals/contadores',
  '/api/withdrawals/pendentes',
];

// Operações que invalidam o cache
const WRITE_PATHS = [
  '/api/bi/entregas/upload',
  '/api/bi/entregas/recalcular',
  '/api/bi/entregas/recalcular-prazo-prof',
];

// ─── Helpers ──────────────────────────────────────────────

function cacheKey(req) {
  const params = JSON.stringify(req.query || {});
  return `${req.path}:${params}`;
}

function invalidarTudo() {
  const k1 = biCache.keys().length;
  const k2 = staticCache.keys().length;
  const k3 = shortCache.keys().length;
  biCache.flushAll();
  staticCache.flushAll();
  shortCache.flushAll();
  console.log(`🗑️ Cache invalidado: ${k1} BI + ${k2} static + ${k3} short`);
}

// ─── Middleware: servir do cache ───────────────────────────

function cacheMiddleware(req, res, next) {
  if (req.method !== 'GET') return next();

  const path = req.path;
  let targetCache = null;

  if (BI_HEAVY.has(path)) {
    targetCache = biCache;
  } else if (BI_STATIC.has(path)) {
    targetCache = staticCache;
  } else if (SHORT_PREFIXES.some(p => path.startsWith(p))) {
    targetCache = shortCache;
  }

  if (!targetCache) return next();

  const ck = cacheKey(req);
  const cached = targetCache.get(ck);

  if (cached) {
    console.log(`📦 Cache HIT: ${path}`);
    return res.json(cached);
  }

  // Interceptar res.json para salvar no cache
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      targetCache.set(ck, data);
      console.log(`💾 Cache STORE: ${path}`);
    }
    return originalJson(data);
  };

  next();
}

// ─── Middleware: invalidar cache em escritas ───────────────

function cacheInvalidationMiddleware(req, res, next) {
  if (req.method === 'GET') return next();

  const isWrite = WRITE_PATHS.includes(req.path) ||
    (req.method === 'DELETE' && req.path.startsWith('/api/bi/uploads'));

  if (!isWrite) return next();

  const originalJson = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      invalidarTudo();
    }
    return originalJson(data);
  };

  next();
}

// ─── Stats (log a cada 30 min) ────────────────────────────

setInterval(() => {
  const s = biCache.getStats();
  const total = s.hits + s.misses;
  const rate = total > 0 ? ((s.hits / total) * 100).toFixed(1) : 0;
  console.log(`📊 Cache BI — Hits: ${s.hits}, Misses: ${s.misses}, Rate: ${rate}%, Keys: ${biCache.keys().length}`);
}, 30 * 60 * 1000);

// ─── Exports ──────────────────────────────────────────────

module.exports = { cacheMiddleware, cacheInvalidationMiddleware, invalidarTudo };
