/**
 * agents/crm-leads.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente de captura de leads CRM via Playwright.
 * Substitui o background processing do POST /executar (leads-captura.routes.js).
 *
 * MODELO: item-por-item, FOR UPDATE SKIP LOCKED.
 * SLOTS: 1 (capturarLeadsCadastrados é pesado, melhor 1 por vez)
 *
 * O endpoint POST /executar continua existindo, mas agora apenas INSERE o job
 * em crm_captura_jobs com status='pendente'. O agente pega e processa.
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const crmLeadsService = require('../../crm/crm-leads.service');

module.exports = defineAgent({
  nome: 'crm-leads',
  slots: 1,                    // 1 slot — captura é pesada e demora alguns minutos
  sessionStrategy: null,       // playwright-crm-leads.js gerencia sua própria sessão
  intervalo: 10_000,           // 10s entre ticks quando fila vazia

  buscarPendentes: async (pool) => {
    const { rows } = await pool.query(`
      SELECT * FROM crm_captura_jobs
      WHERE status = 'pendente'
      ORDER BY iniciado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return rows[0] || null;
  },

  marcarProcessando: async (pool, registro) => {
    await pool.query(
      `UPDATE crm_captura_jobs SET status = 'executando' WHERE id = $1`,
      [registro.id]
    );
  },

  processar: async (pool, registro, ctx) => {
    ctx.log(`📦 Captura CRM job #${registro.id} (${registro.data_inicio} → ${registro.data_fim})`);
    await crmLeadsService.processarCapturaJob(pool, registro.id, ctx.log);
    ctx.log(`✅ Job #${registro.id} concluído`);
  },

  onErro: async (pool, registro, err) => {
    if (registro?.id) {
      try {
        await pool.query(
          `UPDATE crm_captura_jobs SET status='erro', erro=$2, concluido_em=NOW() WHERE id=$1 AND status='executando'`,
          [registro.id, `pool_exception: ${err.message}`.slice(0, 500)]
        );
      } catch (_) {}
    }
  },
});
