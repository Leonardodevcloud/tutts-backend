/**
 * MÓDULO GARANTIDO - Routes
 * Admin:
 *   GET    /garantido/config/:central_id        — config + valores especiais
 *   PUT    /garantido/config/:central_id        — toggle, valor padrão, janela
 *   POST   /garantido/especiais                 — upsert valor especial por motoboy
 *   DELETE /garantido/especiais/:id             — remove valor especial
 *   GET    /garantido/registros/:central_id?data=YYYY-MM-DD  — lista do dia + total
 * Motoboy:
 *   GET    /garantido/meu                        — garantido de hoje do motoboy logado
 */
'use strict';

const express = require('express');

function hhmm(t) { return String(t || '').slice(0, 5); }

function createGarantidoRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ── Config da central + valores especiais ──
  router.get('/garantido/config/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id } = req.params;
      const cfg = await pool.query(
        `SELECT id, nome, COALESCE(garantido_ativo, false) AS garantido_ativo,
                COALESCE(garantido_valor_padrao, 0) AS garantido_valor_padrao,
                garantido_hora_inicio, garantido_hora_fim
           FROM filas_centrais WHERE id = $1`,
        [central_id]
      );
      if (cfg.rows.length === 0) return res.status(404).json({ error: 'Central não encontrada' });

      const esp = await pool.query(
        `SELECT id, cod_profissional, nome_profissional, valor
           FROM garantido_valores_especiais WHERE central_id = $1
          ORDER BY nome_profissional NULLS LAST, cod_profissional`,
        [central_id]
      );

      const c = cfg.rows[0];
      res.json({
        success: true,
        config: {
          central_id: c.id,
          central_nome: c.nome,
          garantido_ativo: c.garantido_ativo,
          garantido_valor_padrao: Number(c.garantido_valor_padrao),
          garantido_hora_inicio: hhmm(c.garantido_hora_inicio) || '08:00',
          garantido_hora_fim: hhmm(c.garantido_hora_fim) || '17:00',
        },
        especiais: esp.rows.map(r => ({ ...r, valor: Number(r.valor) })),
      });
    } catch (err) {
      console.error('❌ [garantido/config GET]', err);
      res.status(500).json({ error: 'Erro ao buscar config do garantido' });
    }
  });

  router.put('/garantido/config/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id } = req.params;
      const { garantido_ativo, garantido_valor_padrao, garantido_hora_inicio, garantido_hora_fim } = req.body;

      const result = await pool.query(
        `UPDATE filas_centrais SET
            garantido_ativo        = COALESCE($1, garantido_ativo),
            garantido_valor_padrao = COALESCE($2, garantido_valor_padrao),
            garantido_hora_inicio  = COALESCE($3, garantido_hora_inicio),
            garantido_hora_fim     = COALESCE($4, garantido_hora_fim),
            updated_at             = NOW()
          WHERE id = $5
        RETURNING id`,
        [
          (typeof garantido_ativo === 'boolean' ? garantido_ativo : null),
          (garantido_valor_padrao != null ? garantido_valor_padrao : null),
          garantido_hora_inicio || null,
          garantido_hora_fim || null,
          central_id,
        ]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Central não encontrada' });

      registrarAuditoria(req, 'GARANTIDO_CONFIG', 'admin', 'filas_centrais', central_id, req.body).catch(() => {});
      res.json({ success: true });
    } catch (err) {
      console.error('❌ [garantido/config PUT]', err);
      res.status(500).json({ error: 'Erro ao salvar config do garantido' });
    }
  });

  // ── Valores especiais ──
  router.post('/garantido/especiais', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id, cod_profissional, nome_profissional, valor } = req.body;
      if (!central_id || !cod_profissional || valor == null) {
        return res.status(400).json({ error: 'central_id, cod_profissional e valor são obrigatórios' });
      }
      const r = await pool.query(
        `INSERT INTO garantido_valores_especiais (central_id, cod_profissional, nome_profissional, valor)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (central_id, cod_profissional)
         DO UPDATE SET valor = EXCLUDED.valor, nome_profissional = EXCLUDED.nome_profissional, updated_at = NOW()
         RETURNING id, cod_profissional, nome_profissional, valor`,
        [central_id, cod_profissional, nome_profissional || null, valor]
      );
      registrarAuditoria(req, 'GARANTIDO_VALOR_ESPECIAL', 'admin', 'garantido_valores_especiais', r.rows[0].id, req.body).catch(() => {});
      res.json({ success: true, especial: { ...r.rows[0], valor: Number(r.rows[0].valor) } });
    } catch (err) {
      console.error('❌ [garantido/especiais POST]', err);
      res.status(500).json({ error: 'Erro ao salvar valor especial' });
    }
  });

  router.delete('/garantido/especiais/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      await pool.query('DELETE FROM garantido_valores_especiais WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ [garantido/especiais DELETE]', err);
      res.status(500).json({ error: 'Erro ao remover valor especial' });
    }
  });

  // ── Registros do dia (alimentado automaticamente) ──
  router.get('/garantido/registros/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { central_id } = req.params;
      const data = req.query.data || new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' })).toISOString().slice(0, 10);
      const r = await pool.query(
        `SELECT cod_profissional, nome_profissional, hora_ingresso, valor_base,
                fracao, minutos_atraso, valor_garantido
           FROM garantido_registros
          WHERE central_id = $1 AND data_ref = $2
          ORDER BY hora_ingresso ASC`,
        [central_id, data]
      );
      const registros = r.rows.map(x => ({
        ...x,
        valor_base: Number(x.valor_base),
        fracao: Number(x.fracao),
        valor_garantido: Number(x.valor_garantido),
      }));
      const total = registros.reduce((s, x) => s + x.valor_garantido, 0);
      res.json({ success: true, data, registros, total: Math.round(total * 100) / 100, qtd: registros.length });
    } catch (err) {
      console.error('❌ [garantido/registros]', err);
      res.status(500).json({ error: 'Erro ao buscar registros do garantido' });
    }
  });

  // ── Motoboy: meu garantido de hoje ──
  router.get('/garantido/meu', verificarToken, async (req, res) => {
    try {
      const cod = req.user.codProfissional;
      const vinc = await pool.query(
        `SELECT v.central_id, c.garantido_ativo, c.garantido_valor_padrao,
                c.garantido_hora_inicio, c.garantido_hora_fim
           FROM filas_vinculos v JOIN filas_centrais c ON c.id = v.central_id
          WHERE v.cod_profissional = $1 AND v.ativo = true AND c.ativa = true`,
        [cod]
      );
      if (vinc.rows.length === 0 || !vinc.rows[0].garantido_ativo) {
        return res.json({ success: true, ativo: false });
      }
      const v = vinc.rows[0];
      const data = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' })).toISOString().slice(0, 10);
      const reg = await pool.query(
        `SELECT hora_ingresso, valor_base, fracao, minutos_atraso, valor_garantido
           FROM garantido_registros
          WHERE central_id = $1 AND cod_profissional = $2 AND data_ref = $3`,
        [v.central_id, cod, data]
      );
      res.json({
        success: true,
        ativo: true,
        hora_inicio: hhmm(v.garantido_hora_inicio) || '08:00',
        hora_fim: hhmm(v.garantido_hora_fim) || '17:00',
        registrado_hoje: reg.rows.length > 0,
        registro: reg.rows.length > 0 ? {
          hora_ingresso: reg.rows[0].hora_ingresso,
          valor_base: Number(reg.rows[0].valor_base),
          fracao: Number(reg.rows[0].fracao),
          minutos_atraso: reg.rows[0].minutos_atraso,
          valor_garantido: Number(reg.rows[0].valor_garantido),
        } : null,
      });
    } catch (err) {
      console.error('❌ [garantido/meu]', err);
      res.status(500).json({ error: 'Erro ao buscar meu garantido' });
    }
  });

  return router;
}

module.exports = { createGarantidoRouter };
