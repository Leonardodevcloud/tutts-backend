/**
 * MÓDULO CS — Sub-router de Automação de Email
 *
 * Endpoints (todos admin via verificarToken global em /api):
 *   GET    /cs/email-automacao/config              — config global (dia do envio)
 *   PUT    /cs/email-automacao/config              — atualiza dia (1-28)
 *   GET    /cs/email-automacao                     — lista todas configs (agrupado por cliente)
 *   GET    /cs/email-automacao/clientes-disponiveis — clientes com seus centros (pra modal de criação)
 *   POST   /cs/email-automacao                     — cria nova config
 *   PUT    /cs/email-automacao/:id                 — atualiza emails / ativa / pausa
 *   DELETE /cs/email-automacao/:id                 — remove config
 *   POST   /cs/email-automacao/:id/disparar-agora  — dispara manual (testa fora do cron)
 *
 * O cron real fica no worker.js — esse arquivo só gerencia configurações.
 * O endpoint /disparar-agora delega pra mesma função que o worker usa
 * (executarAutomacaoUnica em cs.email-automacao.worker.js), garantindo
 * que teste manual e disparo automático passem pelo MESMO caminho.
 */

'use strict';

const express = require('express');
const { executarAutomacaoUnica, calcularPeriodoMesAnterior, calcularProximoEnvio } = require('../cs.email-automacao.worker');

// Validações compartilhadas
function validarEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizarDestinatarios(arr) {
  if (!Array.isArray(arr)) return { ok: false, erro: 'destinatarios deve ser um array' };
  const limpos = [];
  for (const e of arr) {
    if (typeof e !== 'string') return { ok: false, erro: `destinatário inválido: ${JSON.stringify(e)}` };
    const t = e.trim().toLowerCase();
    if (!t) continue;
    if (!validarEmail(t)) return { ok: false, erro: `email inválido: ${e}` };
    if (!limpos.includes(t)) limpos.push(t);
  }
  return { ok: true, destinatarios: limpos };
}

function createEmailAutomacaoRoutes(pool) {
  const router = express.Router();

  // ════════════════════════════════════════════════════════════
  // GET /cs/email-automacao/config — config global
  // ════════════════════════════════════════════════════════════
  router.get('/cs/email-automacao/config', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT chave, valor, descricao, atualizada_em, atualizada_por
           FROM cs_config WHERE chave = 'automacao_email_dia'`
      );
      const dia = parseInt(r.rows[0]?.valor || '1', 10);
      res.json({
        success: true,
        dia_envio: dia,
        proximo_envio: calcularProximoEnvio(dia).toISOString(),
        atualizada_em: r.rows[0]?.atualizada_em || null,
        atualizada_por: r.rows[0]?.atualizada_por || null,
      });
    } catch (err) {
      console.error('[CS Automação] Erro GET config:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // PUT /cs/email-automacao/config — atualiza dia (1-28)
  // ════════════════════════════════════════════════════════════
  router.put('/cs/email-automacao/config', async (req, res) => {
    try {
      const dia = parseInt(req.body.dia_envio, 10);
      if (!Number.isFinite(dia) || dia < 1 || dia > 28) {
        return res.status(400).json({ success: false, error: 'dia_envio deve ser inteiro entre 1 e 28' });
      }
      const userCod = req.user?.codProfissional || req.user?.cod || null;
      await pool.query(
        `UPDATE cs_config
            SET valor = $1, atualizada_em = NOW(), atualizada_por = $2
          WHERE chave = 'automacao_email_dia'`,
        [String(dia), userCod ? String(userCod) : null]
      );
      res.json({
        success: true,
        dia_envio: dia,
        proximo_envio: calcularProximoEnvio(dia).toISOString(),
      });
    } catch (err) {
      console.error('[CS Automação] Erro PUT config:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // GET /cs/email-automacao — lista todas configs agrupado por cliente
  // ════════════════════════════════════════════════════════════
  router.get('/cs/email-automacao', async (req, res) => {
    try {
      // nome_cliente vem salvo da criação (consistente com BI no momento do INSERT).
      // Se vier NULL (config antiga), fallback pra busca no bi_entregas usando MODE()
      // — pega o nome MAIS COMUM, não o mais recente, pra evitar nome dançando.
      const r = await pool.query(`
        SELECT a.*,
               COALESCE(
                 a.nome_cliente,
                 (SELECT MODE() WITHIN GROUP (ORDER BY COALESCE(nome_cliente, nome_fantasia))
                    FROM bi_entregas
                   WHERE cod_cliente = a.cod_cliente
                     AND COALESCE(nome_cliente, nome_fantasia) IS NOT NULL
                     AND data_solicitado >= NOW() - INTERVAL '180 days'),
                 'Cliente #' || a.cod_cliente
               ) AS nome_cliente_resolvido
          FROM cs_email_automacao a
         ORDER BY a.cod_cliente ASC, a.centro_custo NULLS FIRST
      `);

      // Agrupa por cod_cliente
      const grupos = {};
      for (const row of r.rows) {
        const key = row.cod_cliente;
        if (!grupos[key]) {
          grupos[key] = {
            cod_cliente: row.cod_cliente,
            nome_cliente: row.nome_cliente_resolvido,
            configs: [],
          };
        }
        grupos[key].configs.push({
          id: row.id,
          centro_custo: row.centro_custo,
          ativa: row.ativa,
          destinatarios: row.destinatarios || [],
          ultimo_envio_em: row.ultimo_envio_em,
          ultimo_envio_status: row.ultimo_envio_status,
          ultimo_envio_resend_id: row.ultimo_envio_resend_id,
          ultimo_envio_erro: row.ultimo_envio_erro,
          pausada_desde: row.pausada_desde,
          pausada_motivo: row.pausada_motivo,
          criada_em: row.criada_em,
          atualizada_em: row.atualizada_em,
        });
      }

      // Estatísticas pro topo da tela
      const stats = await pool.query(`
        SELECT
          COUNT(DISTINCT cod_cliente)::int AS clientes_configurados,
          COUNT(*) FILTER (WHERE ativa)::int AS centros_ativos,
          COUNT(*)::int AS centros_total,
          COALESCE(SUM(jsonb_array_length(destinatarios)), 0)::int AS destinatarios_totais
          FROM cs_email_automacao
      `);

      // Próximo disparo agendado
      const cfg = await pool.query(`SELECT valor FROM cs_config WHERE chave = 'automacao_email_dia'`);
      const dia = parseInt(cfg.rows[0]?.valor || '1', 10);

      res.json({
        success: true,
        clientes: Object.values(grupos),
        estatisticas: stats.rows[0],
        dia_envio: dia,
        proximo_envio: calcularProximoEnvio(dia).toISOString(),
      });
    } catch (err) {
      console.error('[CS Automação] Erro GET lista:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // GET /cs/email-automacao/clientes-disponiveis
  // Lista clientes operacionais (vindos de bi_entregas — fonte de truth do BI).
  // Usa nome_fantasia do BI (com fallback nome_cliente), dedup por cod_cliente.
  // Centros vêm dos centros_custo distintos vistos nas entregas dos últimos 90d.
  // ════════════════════════════════════════════════════════════
  router.get('/cs/email-automacao/clientes-disponiveis', async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim().toLowerCase();
      const params = [];
      let extraWhere = '';
      if (q) {
        params.push(`%${q}%`);
        params.push(parseInt(q, 10) || 0);
        extraWhere = ` AND (LOWER(COALESCE(nome_fantasia, nome_cliente, '')) LIKE $1 OR cod_cliente = $2)`;
      }

      // CTE: dedup por cod_cliente, pegando o nome MAIS FREQUENTE do BI
      // (cliente com vários centros tem nome_fantasia diferente por centro —
      // usar MODE() pega o mais comum e evita o nome "dançar" entre queries).
      // COALESCE prioriza nome_cliente (nome corporativo, estável) sobre
      // nome_fantasia (nome da loja, varia por centro).
      const sql = `
        WITH clientes_bi AS (
          SELECT cod_cliente,
                 MODE() WITHIN GROUP (ORDER BY COALESCE(nome_cliente, nome_fantasia)) AS nome,
                 COUNT(*)::int AS total_entregas_90d,
                 COALESCE(
                   json_agg(DISTINCT centro_custo) FILTER (WHERE centro_custo IS NOT NULL AND centro_custo <> ''),
                   '[]'::json
                 ) AS centros
            FROM bi_entregas
           WHERE data_solicitado >= NOW() - INTERVAL '90 days'
             AND cod_cliente IS NOT NULL
             AND COALESCE(nome_cliente, nome_fantasia) IS NOT NULL
             ${extraWhere}
           GROUP BY cod_cliente
        )
        SELECT cod_cliente,
               COALESCE(nome, 'Cliente #' || cod_cliente) AS nome,
               total_entregas_90d,
               centros
          FROM clientes_bi
         ORDER BY nome ASC
         LIMIT 50
      `;

      const r = await pool.query(sql, params);
      res.json({ success: true, clientes: r.rows });
    } catch (err) {
      console.error('[CS Automação] Erro GET clientes-disponiveis:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // POST /cs/email-automacao — cria N configs (1 por centro selecionado)
  // Body: { cod_cliente, centros: [{ centro_custo, destinatarios: [...] }] }
  //       OU { cod_cliente, centro_custo: null, destinatarios: [...] } (sem CC)
  // ════════════════════════════════════════════════════════════
  router.post('/cs/email-automacao', async (req, res) => {
    try {
      const codCliente = parseInt(req.body.cod_cliente, 10);
      if (!codCliente) return res.status(400).json({ success: false, error: 'cod_cliente é obrigatório' });

      // Aceita 2 formatos: array de centros (multi-CC) OU campos diretos (single)
      let centrosInput = [];
      if (Array.isArray(req.body.centros) && req.body.centros.length > 0) {
        centrosInput = req.body.centros;
      } else {
        centrosInput = [{ centro_custo: req.body.centro_custo || null, destinatarios: req.body.destinatarios || [] }];
      }

      const userCod = req.user?.codProfissional || req.user?.cod || null;

      // Resolve nome_cliente do BI (mesma fonte de truth) — uma vez só pra todos os centros
      // MODE() pega o nome MAIS FREQUENTE entre as entregas (não o mais recente),
      // garantindo que seja o nome canônico mesmo pra clientes com vários centros.
      const nomeRes = await pool.query(`
        SELECT MODE() WITHIN GROUP (ORDER BY COALESCE(nome_cliente, nome_fantasia)) AS nome
          FROM bi_entregas
         WHERE cod_cliente = $1
           AND COALESCE(nome_cliente, nome_fantasia) IS NOT NULL
           AND data_solicitado >= NOW() - INTERVAL '180 days'
      `, [codCliente]);
      const nomeCliente = nomeRes.rows[0]?.nome || null;

      const criados = [];
      const erros = [];

      for (const c of centrosInput) {
        const centro = c.centro_custo && c.centro_custo.trim() ? c.centro_custo.trim() : null;
        const norm = normalizarDestinatarios(c.destinatarios || []);
        if (!norm.ok) {
          erros.push({ centro_custo: centro, erro: norm.erro });
          continue;
        }
        if (norm.destinatarios.length === 0) {
          erros.push({ centro_custo: centro, erro: 'Pelo menos 1 destinatário é obrigatório' });
          continue;
        }
        try {
          const ins = await pool.query(
            `INSERT INTO cs_email_automacao
               (cod_cliente, centro_custo, nome_cliente, ativa, destinatarios, criada_por)
             VALUES ($1, $2, $3, true, $4, $5)
             RETURNING id`,
            [codCliente, centro, nomeCliente, JSON.stringify(norm.destinatarios), userCod ? String(userCod) : null]
          );
          criados.push({ id: ins.rows[0].id, centro_custo: centro, destinatarios: norm.destinatarios });
        } catch (e) {
          if (e.code === '23505') { // unique violation
            erros.push({ centro_custo: centro, erro: 'Já existe configuração para esse cliente/centro' });
          } else {
            erros.push({ centro_custo: centro, erro: e.message });
          }
        }
      }

      const status = criados.length === 0 ? 400 : (erros.length > 0 ? 207 : 201);
      res.status(status).json({ success: criados.length > 0, criados, erros });
    } catch (err) {
      console.error('[CS Automação] Erro POST:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // PUT /cs/email-automacao/:id — atualiza config existente
  // Aceita atualização parcial: ativa, destinatarios, pausada_motivo
  // ════════════════════════════════════════════════════════════
  router.put('/cs/email-automacao/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'id inválido' });

      const updates = ['atualizada_em = NOW()'];
      const params = [];
      let p = 1;

      if (typeof req.body.ativa === 'boolean') {
        updates.push(`ativa = $${p++}`);
        params.push(req.body.ativa);
        if (req.body.ativa) {
          updates.push('pausada_desde = NULL');
          updates.push('pausada_motivo = NULL');
        } else {
          updates.push('pausada_desde = NOW()');
          if (typeof req.body.pausada_motivo === 'string') {
            updates.push(`pausada_motivo = $${p++}`);
            params.push(req.body.pausada_motivo);
          }
        }
      }

      if (Array.isArray(req.body.destinatarios)) {
        const norm = normalizarDestinatarios(req.body.destinatarios);
        if (!norm.ok) return res.status(400).json({ success: false, error: norm.erro });
        if (norm.destinatarios.length === 0) {
          return res.status(400).json({ success: false, error: 'Pelo menos 1 destinatário é obrigatório' });
        }
        updates.push(`destinatarios = $${p++}`);
        params.push(JSON.stringify(norm.destinatarios));
      }

      if (updates.length === 1) {
        return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
      }

      params.push(id);
      const r = await pool.query(
        `UPDATE cs_email_automacao SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
        params
      );
      if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Config não encontrada' });
      res.json({ success: true, config: r.rows[0] });
    } catch (err) {
      console.error('[CS Automação] Erro PUT:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // DELETE /cs/email-automacao/:id
  // ════════════════════════════════════════════════════════════
  router.delete('/cs/email-automacao/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'id inválido' });
      const r = await pool.query('DELETE FROM cs_email_automacao WHERE id = $1 RETURNING id', [id]);
      if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Config não encontrada' });
      res.json({ success: true, deleted_id: id });
    } catch (err) {
      console.error('[CS Automação] Erro DELETE:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  // POST /cs/email-automacao/:id/disparar-agora
  // Reusa a MESMA função do worker — garante paridade absoluta
  // entre teste manual e disparo automático mensal.
  // ════════════════════════════════════════════════════════════
  router.post('/cs/email-automacao/:id/disparar-agora', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'id inválido' });

      const cfg = await pool.query('SELECT * FROM cs_email_automacao WHERE id = $1', [id]);
      if (cfg.rows.length === 0) return res.status(404).json({ success: false, error: 'Config não encontrada' });

      const periodo = calcularPeriodoMesAnterior();
      const userNome = req.user?.nome || 'Admin';
      console.log(`🚀 [CS Automação] Disparo MANUAL solicitado por ${userNome} — config #${id}`);

      // Não bloqueia o response — pode demorar 30-60s (Gemini + screenshot + Resend)
      res.json({
        success: true,
        message: 'Disparo iniciado em background',
        periodo,
        ver_status_em: `/api/cs/email-automacao/${id}` + ' (após ~60s)',
      });

      // Roda em background depois do response. Erros vão pro log + atualizam ultimo_envio_status.
      executarAutomacaoUnica(pool, cfg.rows[0], periodo, { manual: true, disparado_por: userNome })
        .then((r) => console.log(`✅ [CS Automação] Disparo manual #${id} concluído:`, r.status))
        .catch((e) => console.error(`❌ [CS Automação] Disparo manual #${id} falhou:`, e.message));
    } catch (err) {
      console.error('[CS Automação] Erro disparo manual:', err.message);
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createEmailAutomacaoRoutes };
