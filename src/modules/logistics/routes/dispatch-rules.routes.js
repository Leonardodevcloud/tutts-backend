/**
 * MÓDULO LOGISTICS — Dispatch Rules Routes
 *
 * CRUD de regras de despacho (logistics_dispatch_rules).
 * Substitui os endpoints /regras do uber/admin.routes.js legado, generalizando
 * pra "regras de despacho multi-provider".
 *
 * Endpoints:
 *   GET    /dispatch-rules        — lista todas
 *   GET    /dispatch-rules/:id    — detalhe
 *   POST   /dispatch-rules        — cria
 *   PUT    /dispatch-rules/:id    — atualiza (parcial)
 *   DELETE /dispatch-rules/:id    — remove
 *
 * Diferenças vs CRUD legado (uber_regras_cliente):
 *  - `usar_uber` (bool) legado → `providers_preferidos` (array). usar_uber=true
 *    vira providers_preferidos=['uber']; false vira [].
 *  - `prioridade` ('uber_primeiro') legado → `estrategia` ('provider_unico' default).
 *  - Campos novos: `estrategia`, `providers_preferidos`, `vehicle_type_preferido`.
 *
 * Comportamento de validação portado verbatim do legado:
 *  - cliente_nome obrigatório
 *  - trecho_endereco >= 5 chars (quando enviado)
 *  - regioes_permitidas aceita array OU string CSV → salva array lowercase
 *  - margens aceitam number, '' ou null
 *  - PUT é parcial: undefined = não atualiza, '' / null = limpa
 */

const express = require('express');

// Providers válidos pra providers_preferidos. Fase 2: só uber.
// Fase 3 adiciona 'noventanove'. Mantido como lista pra validação.
const PROVIDERS_VALIDOS = ['uber', 'noventanove'];
const ESTRATEGIAS_VALIDAS = ['provider_unico', 'melhor_preco', 'melhor_eta', 'fallback'];

/**
 * Normaliza regioes_permitidas: aceita array ou CSV, retorna array lowercase.
 * @returns {string[]|null|undefined} undefined = não mexer, null = limpar
 */
function normalizarRegioes(valor, ehUpdate = false) {
  if (valor === undefined) return ehUpdate ? undefined : null;
  if (Array.isArray(valor)) {
    return valor.map(r => String(r).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof valor === 'string') {
    if (!valor.trim() && !ehUpdate) return null;
    return valor.split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
  }
  return ehUpdate ? null : null;
}

/**
 * Normaliza providers_preferidos. Aceita:
 *  - array de strings → valida cada um
 *  - undefined → comportamento conforme contexto
 * Filtra só providers válidos.
 */
function normalizarProviders(valor) {
  if (valor === undefined) return undefined;
  if (!Array.isArray(valor)) return [];
  return valor
    .map(p => String(p).trim().toLowerCase())
    .filter(p => PROVIDERS_VALIDOS.includes(p));
}

/**
 * Parse de margem: number, '' ou null → number ou null.
 */
function parseMargem(valor) {
  if (valor === '' || valor == null) return null;
  const n = parseFloat(valor);
  return isNaN(n) ? null : n;
}

function createDispatchRulesRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ───────────────────────────────────────────────────────────
  // GET /dispatch-rules — lista todas
  // ───────────────────────────────────────────────────────────
  router.get('/dispatch-rules', verificarToken, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM logistics_dispatch_rules ORDER BY cliente_nome'
      );
      res.json({ success: true, regras: rows });
    } catch (error) {
      console.error('[logistics/dispatch-rules] erro listar:', error.message);
      res.status(500).json({ error: 'Erro ao listar regras' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /dispatch-rules/:id — detalhe
  // ───────────────────────────────────────────────────────────
  router.get('/dispatch-rules/:id', verificarToken, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM logistics_dispatch_rules WHERE id = $1',
        [parseInt(req.params.id, 10)]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Regra não encontrada' });
      res.json({ success: true, regra: rows[0] });
    } catch (error) {
      console.error('[logistics/dispatch-rules] erro detalhe:', error.message);
      res.status(500).json({ error: 'Erro ao obter regra' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /dispatch-rules — cria
  // ───────────────────────────────────────────────────────────
  router.post('/dispatch-rules', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const {
        cliente_nome, trecho_endereco, cliente_identificador,
        estrategia, providers_preferidos, vehicle_type_preferido,
        horario_inicio, horario_fim, valor_minimo, valor_maximo,
        regioes_permitidas, ativo,
        margem_minima_aceita, margem_pct_minima,
        preco_valor_fixo, preco_km_base, preco_valor_km_adicional,
        alterar_valor_mapp_ativo,
        // compat: aceita usar_uber do formato legado
        usar_uber,
      } = req.body || {};

      // Validações (portadas do legado)
      if (!cliente_nome || !cliente_nome.trim()) {
        return res.status(400).json({ error: 'Nome do cliente é obrigatório' });
      }
      if (!trecho_endereco || trecho_endereco.trim().length < 5) {
        return res.status(400).json({ error: 'Trecho do endereço deve ter pelo menos 5 caracteres' });
      }

      // providers_preferidos: usa o array enviado, ou deriva de usar_uber (compat legado)
      let providers = normalizarProviders(providers_preferidos);
      if (providers === undefined) {
        // Não veio array — deriva de usar_uber (default true, = ['uber'])
        providers = (usar_uber === false) ? [] : ['uber'];
      }

      // estrategia: valida contra lista, default provider_unico
      let estrat = (estrategia || '').trim().toLowerCase();
      if (!ESTRATEGIAS_VALIDAS.includes(estrat)) estrat = 'provider_unico';

      const regioesArray = normalizarRegioes(regioes_permitidas, false);
      const margemAbs = parseMargem(margem_minima_aceita);
      const margemPct = parseMargem(margem_pct_minima);
      // preco por distancia (override do cliente). Estas variaveis eram usadas
      // no INSERT mas nunca eram declaradas aqui -> ReferenceError -> 500.
      const _numPreco = (v) => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
      const precoFixo   = _numPreco(preco_valor_fixo);
      const precoKmBase = _numPreco(preco_km_base);
      const precoKmAdic = _numPreco(preco_valor_km_adicional);
      // Toggle por regra (default true se nao enviado).
      const _alterarValorMapp = (alterar_valor_mapp_ativo === false) ? false : true;

      const { rows: [regra] } = await pool.query(`
        INSERT INTO logistics_dispatch_rules (
          cliente_nome, trecho_endereco, cliente_identificador,
          estrategia, providers_preferidos, vehicle_type_preferido,
          horario_inicio, horario_fim, valor_minimo, valor_maximo,
          regioes_permitidas, ativo,
          margem_minima_aceita, margem_pct_minima,
          preco_valor_fixo, preco_km_base, preco_valor_km_adicional,
          alterar_valor_mapp_ativo
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING *
      `, [
        cliente_nome.trim(),
        trecho_endereco.trim().toLowerCase(),
        cliente_identificador || null,
        estrat,
        providers,
        vehicle_type_preferido || null,
        horario_inicio || null,
        horario_fim || null,
        valor_minimo || null,
        valor_maximo || null,
        regioesArray,
        ativo ?? true,
        margemAbs,
        margemPct,
        precoFixo,
        precoKmBase,
        precoKmAdic,
        _alterarValorMapp,
      ]);

      if (registrarAuditoria) {
        await registrarAuditoria(req, 'CRIAR_REGRA_LOGISTICS', 'config',
          'logistics_dispatch_rules', regra.id, { cliente_nome: regra.cliente_nome })
          .catch(() => {});
      }

      res.json({ success: true, regra });
    } catch (error) {
      console.error('[logistics/dispatch-rules] erro criar:', error.message);
      res.status(500).json({ error: 'Erro ao criar regra' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // PUT /dispatch-rules/:id — atualiza (parcial)
  // ───────────────────────────────────────────────────────────
  router.put('/dispatch-rules/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const {
        cliente_nome, trecho_endereco, cliente_identificador,
        estrategia, providers_preferidos, vehicle_type_preferido,
        horario_inicio, horario_fim, valor_minimo, valor_maximo,
        regioes_permitidas, ativo,
        margem_minima_aceita, margem_pct_minima,
        alterar_valor_mapp_ativo,
        usar_uber,
      } = req.body || {};

      if (trecho_endereco !== undefined && (!trecho_endereco || trecho_endereco.trim().length < 5)) {
        return res.status(400).json({ error: 'Trecho do endereço deve ter pelo menos 5 caracteres' });
      }

      // providers: undefined = não mexe; senão normaliza. usar_uber só conta se providers não veio.
      let providers = normalizarProviders(providers_preferidos);
      if (providers === undefined && usar_uber !== undefined) {
        providers = (usar_uber === false) ? [] : ['uber'];
      }

      // estrategia: undefined = não mexe
      let estrat;
      if (estrategia === undefined) {
        estrat = undefined;
      } else {
        estrat = String(estrategia).trim().toLowerCase();
        if (!ESTRATEGIAS_VALIDAS.includes(estrat)) estrat = 'provider_unico';
      }

      const regioesArray = normalizarRegioes(regioes_permitidas, true);

      // Margens: undefined = não atualiza, '' / null = limpa, número = atualiza
      const margemAbsParsed = margem_minima_aceita === undefined ? undefined : parseMargem(margem_minima_aceita);
      const margemPctParsed = margem_pct_minima === undefined ? undefined : parseMargem(margem_pct_minima);
      // (removido) precoFixoParsed/KmBaseParsed/KmAdicParsed: era dead code (nunca usado
      // no UPDATE) que referenciava preco_* nao destructurado -> ReferenceError -> 500 no PUT.
      // O preco por regra e gravado no POST (criar). Persistir edicao de preco via PUT sera tratado a parte.

      const { rows: [regra] } = await pool.query(`
        UPDATE logistics_dispatch_rules SET
          cliente_nome           = COALESCE($1, cliente_nome),
          trecho_endereco        = COALESCE($2, trecho_endereco),
          cliente_identificador  = COALESCE($3, cliente_identificador),
          estrategia             = COALESCE($4, estrategia),
          providers_preferidos   = COALESCE($5::varchar(32)[], providers_preferidos),
          vehicle_type_preferido = COALESCE($6, vehicle_type_preferido),
          horario_inicio         = $7,
          horario_fim            = $8,
          valor_minimo           = $9,
          valor_maximo           = $10,
          regioes_permitidas     = COALESCE($11::text[], regioes_permitidas),
          ativo                  = COALESCE($12, ativo),
          margem_minima_aceita   = CASE WHEN $14::boolean THEN $13 ELSE margem_minima_aceita END,
          margem_pct_minima      = CASE WHEN $16::boolean THEN $15 ELSE margem_pct_minima END,
          alterar_valor_mapp_ativo = COALESCE($17, alterar_valor_mapp_ativo),
          updated_at             = NOW()
        WHERE id = $18
        RETURNING *
      `, [
        cliente_nome ? cliente_nome.trim() : null,
        trecho_endereco ? trecho_endereco.trim().toLowerCase() : null,
        cliente_identificador,
        estrat ?? null,
        providers ?? null,
        vehicle_type_preferido,
        horario_inicio, horario_fim, valor_minimo, valor_maximo,
        regioesArray, ativo,
        margemAbsParsed === undefined ? null : margemAbsParsed,
        margemAbsParsed !== undefined,
        margemPctParsed === undefined ? null : margemPctParsed,
        margemPctParsed !== undefined,
        typeof alterar_valor_mapp_ativo === 'boolean' ? alterar_valor_mapp_ativo : null,
        id,
      ]);

      if (!regra) return res.status(404).json({ error: 'Regra não encontrada' });

      if (registrarAuditoria) {
        await registrarAuditoria(req, 'ATUALIZAR_REGRA_LOGISTICS', 'config',
          'logistics_dispatch_rules', regra.id, { cliente_nome: regra.cliente_nome })
          .catch(() => {});
      }

      res.json({ success: true, regra });
    } catch (error) {
      console.error('[logistics/dispatch-rules] erro atualizar:', error.message);
      res.status(500).json({ error: 'Erro ao atualizar regra' });
    }
  });

  // ───────────────────────────────────────────────────────────
  // DELETE /dispatch-rules/:id — remove
  // ───────────────────────────────────────────────────────────
  router.delete('/dispatch-rules/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rowCount } = await pool.query(
        'DELETE FROM logistics_dispatch_rules WHERE id = $1',
        [id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Regra não encontrada' });

      if (registrarAuditoria) {
        await registrarAuditoria(req, 'DELETAR_REGRA_LOGISTICS', 'config',
          'logistics_dispatch_rules', id).catch(() => {});
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[logistics/dispatch-rules] erro deletar:', error.message);
      res.status(500).json({ error: 'Erro ao deletar regra' });
    }
  });

  return router;
}

module.exports = { createDispatchRulesRoutes, PROVIDERS_VALIDOS, ESTRATEGIAS_VALIDAS };
