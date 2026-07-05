'use strict';

/**
 * permissao-modulo.js (2026-07) — FASE 4 do refactor de permissoes
 * ---------------------------------------------------------------------------
 * ENFORCEMENT no backend da permissao por modulo (fecha o Bug 4: antes a
 * restricao era so no frontend / cosmetica).
 *
 * Desenho SEGURO (fail-open — nunca tranca por engano):
 *   - So enforca para role === 'admin'. Master, financeiro, user, viewer e
 *     requests sem token passam direto.
 *   - Mapeia req.path -> modulo pelo registry (ownedPaths). Caminho NAO mapeado
 *     => passa (fail-open). Modulo sempreLiberado => passa.
 *   - allowed_modules do usuario (cacheado): VAZIO = acesso total; se cobre
 *     TODOS os modulos = acesso total; senao, so os da lista.
 *   - Qualquer erro (banco, etc.) => passa (fail-open).
 *
 * Montado UMA vez, global, apos verificarTokenOpcional:
 *   app.use('/api', verificarTokenOpcional, permissaoModulo)
 * Nao enfraquece a auth: o verificarToken real de cada rota continua rodando.
 */

const CACHE_TTL_MS = Number(process.env.PERM_MODULO_TTL_MS || 30000);

function criarPermissaoModulo(pool) {
  const registry = require('../shared/modulos.registry');
  const cache = new Map(); // cod -> { mods:[], exp:number }

  async function allowedDoUsuario(cod) {
    const hit = cache.get(cod);
    if (hit && hit.exp > Date.now()) return hit.mods;

    let mods = [];
    try {
      const { rows } = await pool.query(
        'SELECT allowed_modules FROM users WHERE LOWER(cod_profissional) = LOWER($1) LIMIT 1',
        [cod]
      );
      if (rows[0]) {
        const v = rows[0].allowed_modules;
        if (Array.isArray(v)) mods = v;
        else if (typeof v === 'string') { try { mods = JSON.parse(v || '[]'); } catch (_) { mods = []; } }
      }
    } catch (_) {
      mods = []; // fail-open: banco fora => acesso total (nao tranca)
    }
    if (!Array.isArray(mods)) mods = [];
    cache.set(cod, { mods, exp: Date.now() + CACHE_TTL_MS });
    return mods;
  }

  async function middleware(req, res, next) {
    try {
      const user = req.user;
      if (!user || user.role !== 'admin') return next();

      const cod = user.codProfissional || user.cod_profissional;
      if (!cod) return next();

      const mod = registry.moduloDoCaminho(req.path);
      if (!mod || mod.sempreLiberado) return next();

      const allowed = await allowedDoUsuario(cod);
      if (!Array.isArray(allowed) || allowed.length === 0) return next();          // vazio = total
      if (registry.idsCanonicos().every((id) => allowed.includes(id))) return next(); // cobre todos = total

      if (!allowed.includes(mod.id)) {
        return res.status(403).json({
          error: 'Sem acesso a este modulo.',
          modulo: mod.id,
        });
      }
      return next();
    } catch (e) {
      console.error('[permissao-modulo]', e && e.message);
      return next(); // fail-open
    }
  }

  function invalidar(cod) {
    if (cod) cache.delete(cod);
    else cache.clear();
  }

  return { middleware, invalidar };
}

module.exports = { criarPermissaoModulo };
