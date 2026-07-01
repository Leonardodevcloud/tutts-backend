'use strict';

const express = require('express');
const { normalizarTelefone, normalizarPlaca } = require('../logistics.bloqueados');

/**
 * Rotas de Ocorrencias + Bloqueio de entregadores + Motoboys frequentes.
 *
 * Endpoints (todos sob /api/logistics):
 *   POST   /ocorrencias           -> registra ocorrencia (+ bloqueia se pedido)
 *   GET    /bloqueados            -> lista blacklist ativa + metricas
 *   DELETE /bloqueados/:id        -> desbloqueia (ativo=false)
 *   GET    /frequentes            -> motoboys com > 3 pedidos concluidos
 */
function createOcorrenciasRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  const nomeOperador = (req) =>
    (req.user && (req.user.nome || req.user.email || req.user.usuario)) || 'operador';

  // ──────────────────────────────────────────────────────────────────
  // POST /ocorrencias — registra ocorrencia e, se bloquear=true, insere
  // (ou reativa) o entregador na blacklist.
  // Body: { codigo_os, delivery_id?, provider_code?, courier:{name,phone,plate},
  //         descricao, bloquear:boolean }
  // ──────────────────────────────────────────────────────────────────
  router.post('/ocorrencias', verificarToken, verificarAdmin, async (req, res) => {
    const b = req.body || {};
    const courier = b.courier || {};
    const descricao = (b.descricao || '').trim();
    const bloquear = b.bloquear !== false; // default: bloqueia

    if (!descricao) {
      return res.status(400).json({ error: 'Descreva a ocorrencia (campo descricao obrigatorio).' });
    }

    const telNorm = normalizarTelefone(courier.phone);
    const placaNorm = normalizarPlaca(courier.plate);
    const operador = nomeOperador(req);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) grava a ocorrencia (sempre)
      const ocorr = await client.query(
        `INSERT INTO logistics_ocorrencias
           (codigo_os, delivery_id, provider_code, courier_nome, courier_telefone,
            courier_placa, descricao, bloqueou, reportado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          b.codigo_os || null,
          b.delivery_id || null,
          b.provider_code || null,
          courier.name || null,
          telNorm || null,
          placaNorm || null,
          descricao,
          bloquear,
          operador,
        ]
      );
      const ocorrenciaId = ocorr.rows[0].id;

      let bloqueio = null;
      if (bloquear) {
        if (!telNorm && !placaNorm) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'Sem telefone nem placa do entregador — nao ha como bloquear com seguranca.',
          });
        }

        // Se ja existe bloqueio ativo casando por telefone OU placa, reaproveita
        // (atualiza motivo/ocorrencia). Senao, cria novo.
        const cond = [];
        const params = [];
        if (telNorm) { params.push(telNorm); cond.push(`telefone_norm = $${params.length}`); }
        if (placaNorm) { params.push(placaNorm); cond.push(`placa_norm = $${params.length}`); }

        const existente = await client.query(
          `SELECT id FROM logistics_couriers_bloqueados
            WHERE ativo = true AND (${cond.join(' OR ')})
            ORDER BY criado_em DESC LIMIT 1`,
          params
        );

        if (existente.rows.length) {
          const upd = await client.query(
            `UPDATE logistics_couriers_bloqueados
               SET motivo = $1, ultima_ocorrencia_id = $2, nome = COALESCE($3, nome)
             WHERE id = $4 RETURNING *`,
            [descricao, ocorrenciaId, courier.name || null, existente.rows[0].id]
          );
          bloqueio = upd.rows[0];
        } else {
          const ins = await client.query(
            `INSERT INTO logistics_couriers_bloqueados
               (telefone_norm, placa_norm, nome, provider_code, motivo,
                bloqueado_por, ultima_ocorrencia_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING *`,
            [
              telNorm || null,
              placaNorm || null,
              courier.name || null,
              b.provider_code || null,
              descricao,
              operador,
              ocorrenciaId,
            ]
          );
          bloqueio = ins.rows[0];
        }
      }

      await client.query('COMMIT');

      if (registrarAuditoria) {
        registrarAuditoria(req, {
          acao: bloquear ? 'HUB_OCORRENCIA_BLOQUEIO' : 'HUB_OCORRENCIA',
          detalhes: `OS ${b.codigo_os || '-'}: ${courier.name || 'entregador'} — ${descricao.slice(0, 120)}`,
        }).catch(() => {});
      }

      res.json({ ok: true, ocorrencia_id: ocorrenciaId, bloqueio });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[logistics/ocorrencias] erro:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /bloqueados — lista blacklist ativa + metricas do painel.
  // Query opcional: ?busca=texto (nome ou telefone)
  // ──────────────────────────────────────────────────────────────────
  router.get('/bloqueados', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const busca = (req.query.busca || '').trim();
      const params = [];
      let filtro = 'WHERE ativo = true';
      if (busca) {
        params.push(`%${busca.toLowerCase()}%`);
        params.push(`%${busca.replace(/\D+/g, '')}%`);
        filtro += ` AND (LOWER(nome) LIKE $1 OR telefone_norm LIKE $2)`;
      }

      const lista = await pool.query(
        `SELECT id, nome, telefone_norm, placa_norm, provider_code, motivo,
                bloqueado_por, reatribuicoes, criado_em
           FROM logistics_couriers_bloqueados
           ${filtro}
           ORDER BY criado_em DESC`,
        params
      );

      // Metricas (independentes da busca)
      const mAtivos = await pool.query(
        `SELECT COUNT(*)::int AS n FROM logistics_couriers_bloqueados WHERE ativo = true`
      );
      const mReatrib = await pool.query(
        `SELECT COALESCE(SUM(reatribuicoes),0)::int AS n
           FROM logistics_couriers_bloqueados
          WHERE criado_em >= NOW() - INTERVAL '7 days'`
      );
      const mCancelHoje = await pool.query(
        `SELECT COUNT(*)::int AS n FROM logistics_ocorrencias
          WHERE bloqueou = true AND criado_em::date = NOW()::date`
      );

      res.json({
        bloqueados: lista.rows,
        metricas: {
          bloqueados_ativos: mAtivos.rows[0].n,
          reatribuicoes_7d: mReatrib.rows[0].n,
          cancelamentos_hoje: mCancelHoje.rows[0].n,
        },
      });
    } catch (err) {
      console.error('[logistics/bloqueados] erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /bloqueados/:id — desbloqueia (ativo=false, mantem historico).
  // ──────────────────────────────────────────────────────────────────
  router.delete('/bloqueados/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE logistics_couriers_bloqueados
            SET ativo = false, desbloqueado_em = NOW(), desbloqueado_por = $1
          WHERE id = $2 AND ativo = true
          RETURNING id, nome`,
        [nomeOperador(req), req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Bloqueio nao encontrado ou ja desbloqueado.' });
      }
      if (registrarAuditoria) {
        registrarAuditoria(req, {
          acao: 'HUB_DESBLOQUEIO',
          detalhes: `Desbloqueou ${rows[0].nome || 'entregador'} (id ${rows[0].id})`,
        }).catch(() => {});
      }
      res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      console.error('[logistics/desbloquear] erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /frequentes — motoboys com MAIS DE 3 pedidos concluidos.
  // Agrupa por telefone do courier (courier_data->>'phone', so digitos).
  // Query opcional: ?dias=30 (janela; default 30) &busca=texto
  // ──────────────────────────────────────────────────────────────────
  router.get('/frequentes', verificarToken, async (req, res) => {
    try {
      const dias = Math.max(1, Math.min(365, parseInt(req.query.dias, 10) || 30));
      const busca = (req.query.busca || '').trim().toLowerCase();

      // Normaliza telefone no SQL (regexp_replace pra so digitos) e agrupa.
      // Conta so entregas concluidas (entregue_at) com courier identificado.
      const { rows } = await pool.query(
        `WITH base AS (
           SELECT
             regexp_replace(COALESCE(courier_data->>'phone',''), '[^0-9]', '', 'g') AS tel,
             MAX(courier_data->>'name')    AS nome,
             MAX(courier_data->>'plate')   AS placa,
             MAX(provider_code)            AS provider,
             (array_agg(courier_data->>'photo' ORDER BY entregue_at DESC)
                FILTER (WHERE COALESCE(courier_data->>'photo','') <> ''))[1] AS foto,
             COUNT(*)                      AS pedidos,
             MAX(entregue_at)              AS ultimo
           FROM logistics_deliveries
           WHERE entregue_at IS NOT NULL
             AND entregue_at >= NOW() - ($1 || ' days')::interval
             AND COALESCE(courier_data->>'phone','') <> ''
           GROUP BY 1
         )
         SELECT * FROM base
          WHERE tel <> '' AND pedidos > 3
          ORDER BY pedidos DESC, ultimo DESC`,
        [String(dias)]
      );

      let frequentes = rows;
      if (busca) {
        frequentes = frequentes.filter(r =>
          (r.nome || '').toLowerCase().includes(busca) || (r.tel || '').includes(busca.replace(/\D+/g, ''))
        );
      }

      const totalPedidos = frequentes.reduce((s, r) => s + Number(r.pedidos), 0);
      const top = frequentes.length ? Number(frequentes[0].pedidos) : 0;

      res.json({
        frequentes: frequentes.map(r => ({
          nome: r.nome,
          telefone: r.tel,
          placa: r.placa,
          provider: r.provider,
          foto: r.foto || null,
          pedidos: Number(r.pedidos),
          ultimo: r.ultimo,
        })),
        metricas: {
          parceiros: frequentes.length,
          pedidos_periodo: totalPedidos,
          top_parceiro: top,
          dias,
        },
      });
    } catch (err) {
      console.error('[logistics/frequentes] erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createOcorrenciasRoutes };
