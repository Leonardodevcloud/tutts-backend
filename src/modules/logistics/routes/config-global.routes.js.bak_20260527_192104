/**
 * MÓDULO LOGISTICS — Config Global Routes
 *
 * GET/PUT da configuração global do hub (tabela singleton
 * logistics_config_global, id=1).
 *
 * Hoje expõe o GUARDRAIL GLOBAL DE MARGEM — o piso de margem (R$ e %) que o
 * despacho automático aplica quando a OS não casa com uma regra de cliente
 * que defina margem própria.
 *
 * Endpoints:
 *   GET /config-global   — lê a config (cria a linha se faltar)
 *   PUT /config-global   — atualiza (parcial: undefined = não mexe)
 *
 * Semântica:
 *  - global = DEFAULT. A regra do cliente, quando configurada, sobrescreve.
 *  - margem_global_ativa=false → guardrail global desligado (despacho
 *    automático não aplica piso global; só as regras de cliente valem).
 */

const express = require('express');

/**
 * Parse de valor de margem: aceita number, string numérica, '' ou null.
 * Retorna number, null (limpar) ou undefined (não mexer — só no PUT).
 * @param {*} valor
 * @param {boolean} ehUpdate
 */
function parseMargem(valor, ehUpdate = false) {
  if (valor === undefined) return ehUpdate ? undefined : null;
  if (valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Lê a linha singleton de config global. Cria (id=1, desligada) se faltar.
 * @param {import('pg').Pool} pool
 * @returns {Promise<Object>}
 */
async function lerConfigGlobal(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM logistics_config_global WHERE id = 1'
  );
  if (rows.length > 0) return rows[0];

  // Linha não existe (migration ainda não rodou ou foi apagada) — cria.
  await pool.query(`
    INSERT INTO logistics_config_global (id, margem_global_ativa)
    VALUES (1, false)
    ON CONFLICT (id) DO NOTHING
  `);
  const { rows: novo } = await pool.query(
    'SELECT * FROM logistics_config_global WHERE id = 1'
  );
  return novo[0];
}

/**
 * Factory do sub-router de config global.
 *
 * @param {import('pg').Pool} pool
 * @param {Function} verificarToken
 * @param {Function} verificarAdmin
 * @param {Function} [registrarAuditoria]
 * @returns {import('express').Router}
 */
function createConfigGlobalRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ── GET /config-global — leitura (qualquer usuário autenticado) ──
  router.get('/config-global', verificarToken, async (req, res) => {
    try {
      const cfg = await lerConfigGlobal(pool);
      res.json({ success: true, config: cfg });
    } catch (err) {
      console.error('[logistics/config-global] GET erro:', err.message);
      res.status(500).json({ error: 'Erro ao ler configuração global' });
    }
  });

  // ── PUT /config-global — atualização (admin) ──
  // Parcial: campo undefined no body → não mexe. '' / null → limpa.
  router.put('/config-global', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const body = req.body || {};

      // margem_global_ativa: só atualiza se veio como boolean explícito.
      const ativa = (typeof body.margem_global_ativa === 'boolean')
        ? body.margem_global_ativa
        : undefined;

      const margemRs  = parseMargem(body.margem_global_minima_rs, true);
      const margemPct = parseMargem(body.margem_global_minima_pct, true);

      // Monta o UPDATE dinâmico — só os campos enviados.
      const sets = [];
      const vals = [];
      let i = 1;
      if (ativa !== undefined)     { sets.push(`margem_global_ativa = $${i++}`);     vals.push(ativa); }
      if (margemRs !== undefined)  { sets.push(`margem_global_minima_rs = $${i++}`); vals.push(margemRs); }
      if (margemPct !== undefined) { sets.push(`margem_global_minima_pct = $${i++}`);vals.push(margemPct); }

      if (sets.length === 0) {
        // Nada pra atualizar — devolve o estado atual.
        const cfg = await lerConfigGlobal(pool);
        return res.json({ success: true, config: cfg, semAlteracao: true });
      }

      // Garante que a linha existe antes do UPDATE.
      await lerConfigGlobal(pool);

      sets.push('updated_at = NOW()');
      const { rows } = await pool.query(
        `UPDATE logistics_config_global SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
        vals
      );

      if (typeof registrarAuditoria === 'function') {
        registrarAuditoria(req, {
          acao: 'logistics_config_global_atualizada',
          detalhes: {
            margem_global_ativa: rows[0].margem_global_ativa,
            margem_global_minima_rs: rows[0].margem_global_minima_rs,
            margem_global_minima_pct: rows[0].margem_global_minima_pct,
          },
        }).catch(() => {});
      }

      console.log(
        `⚙️ [logistics/config-global] atualizada: ativa=${rows[0].margem_global_ativa} ` +
        `min=R$${rows[0].margem_global_minima_rs || '-'} / ${rows[0].margem_global_minima_pct || '-'}%`
      );
      res.json({ success: true, config: rows[0] });
    } catch (err) {
      console.error('[logistics/config-global] PUT erro:', err.message);
      res.status(500).json({ error: 'Erro ao salvar configuração global' });
    }
  });

  return router;
}

module.exports = { createConfigGlobalRoutes, lerConfigGlobal };
