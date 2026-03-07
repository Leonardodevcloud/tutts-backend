/**
 * MÓDULO ANTI-FRAUDE — Routes
 * Dashboard, alertas, configurações, disparar varredura manual.
 */

'use strict';

const express = require('express');
const { executarVarreduraCompleta } = require('./antifraude-worker');

function createAntiFraudeRouter(pool, verificarAdmin) {
  const router = express.Router();

  // ============================================
  // DASHBOARD — KPIs e resumo
  // ============================================
  router.get('/dashboard', verificarAdmin, async (req, res) => {
    try {
      const [
        totalAlertas,
        alertasPorTipo,
        alertasPorSeveridade,
        alertasPendentes,
        ultimaVarredura,
        topMotoboys,
        topClientes,
        varreduras
      ] = await Promise.all([
        pool.query('SELECT COUNT(*) as total FROM antifraude_alertas'),
        pool.query(`
          SELECT tipo, COUNT(*) as total FROM antifraude_alertas
          GROUP BY tipo ORDER BY total DESC
        `),
        pool.query(`
          SELECT severidade, COUNT(*) as total FROM antifraude_alertas
          GROUP BY severidade ORDER BY total DESC
        `),
        pool.query("SELECT COUNT(*) as total FROM antifraude_alertas WHERE status = 'pendente'"),
        pool.query('SELECT * FROM antifraude_varreduras ORDER BY id DESC LIMIT 1'),
        pool.query(`
          SELECT profissional_cod, profissional_nome, COUNT(*) as total_alertas
          FROM antifraude_alertas
          WHERE profissional_cod IS NOT NULL
          GROUP BY profissional_cod, profissional_nome
          ORDER BY total_alertas DESC LIMIT 10
        `),
        pool.query(`
          SELECT solicitante_cod, solicitante_nome, COUNT(*) as total_alertas
          FROM antifraude_alertas
          WHERE solicitante_cod IS NOT NULL
          GROUP BY solicitante_cod, solicitante_nome
          ORDER BY total_alertas DESC LIMIT 10
        `),
        pool.query('SELECT * FROM antifraude_varreduras ORDER BY id DESC LIMIT 10'),
      ]);

      res.json({
        total_alertas: parseInt(totalAlertas.rows[0].total),
        alertas_pendentes: parseInt(alertasPendentes.rows[0].total),
        por_tipo: alertasPorTipo.rows,
        por_severidade: alertasPorSeveridade.rows,
        ultima_varredura: ultimaVarredura.rows[0] || null,
        top_motoboys: topMotoboys.rows,
        top_clientes: topClientes.rows,
        varreduras_recentes: varreduras.rows,
      });
    } catch (err) {
      console.error('[antifraude/dashboard]', err.message);
      res.status(500).json({ error: 'Erro ao carregar dashboard' });
    }
  });

  // ============================================
  // ALERTAS — Listagem com filtros
  // ============================================
  router.get('/alertas', verificarAdmin, async (req, res) => {
    try {
      const { tipo, severidade, status, profissional, solicitante, page = 1, per_page = 30 } = req.query;
      const conditions = [];
      const params = [];
      let p = 1;

      if (tipo) { conditions.push(`tipo = $${p++}`); params.push(tipo); }
      if (severidade) { conditions.push(`severidade = $${p++}`); params.push(severidade); }
      if (status) { conditions.push(`status = $${p++}`); params.push(status); }
      if (profissional) { conditions.push(`(profissional_cod ILIKE $${p} OR profissional_nome ILIKE $${p})`); params.push(`%${profissional}%`); p++; }
      if (solicitante) { conditions.push(`(solicitante_cod ILIKE $${p} OR solicitante_nome ILIKE $${p})`); params.push(`%${solicitante}%`); p++; }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const offset = (parseInt(page) - 1) * parseInt(per_page);

      const [dataRes, countRes] = await Promise.all([
        pool.query(
          `SELECT * FROM antifraude_alertas ${where}
           ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
          [...params, parseInt(per_page), offset]
        ),
        pool.query(`SELECT COUNT(*) as total FROM antifraude_alertas ${where}`, params),
      ]);

      res.json({
        alertas: dataRes.rows,
        total: parseInt(countRes.rows[0].total),
        page: parseInt(page),
        per_page: parseInt(per_page),
      });
    } catch (err) {
      console.error('[antifraude/alertas]', err.message);
      res.status(500).json({ error: 'Erro ao carregar alertas' });
    }
  });

  // ============================================
  // ALERTAS — Atualizar status (analisar)
  // ============================================
  router.patch('/alertas/:id', verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, observacao_analise } = req.body;

      const statusValidos = ['pendente', 'analisado', 'confirmado_fraude', 'falso_positivo'];
      if (!statusValidos.includes(status)) {
        return res.status(400).json({ error: 'Status inválido' });
      }

      const nomeAdmin = req.user?.fullName || req.user?.nome || 'Admin';

      const result = await pool.query(
        `UPDATE antifraude_alertas
         SET status = $1, analisado_por = $2, analisado_em = NOW(), observacao_analise = $3
         WHERE id = $4 RETURNING *`,
        [status, nomeAdmin, observacao_analise || null, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Alerta não encontrado' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('[antifraude/alertas/patch]', err.message);
      res.status(500).json({ error: 'Erro ao atualizar alerta' });
    }
  });

  // ============================================
  // VARREDURA — Disparar manual
  // ============================================
  router.post('/varredura', verificarAdmin, async (req, res) => {
    try {
      const nomeAdmin = req.user?.fullName || req.user?.nome || 'Admin';
      const { data_inicio, data_fim } = req.body || {};

      // Verificar se já tem uma varredura executando
      const emExecucao = await pool.query(
        "SELECT id FROM antifraude_varreduras WHERE status = 'executando'"
      );
      if (emExecucao.rows.length > 0) {
        return res.status(409).json({
          error: 'Já existe uma varredura em execução',
          varredura_id: emExecucao.rows[0].id,
        });
      }

      // Responder imediatamente (análise é rápida mas não bloqueia)
      res.json({ message: 'Varredura iniciada', status: 'executando' });

      // Executar de forma assíncrona com período opcional
      executarVarreduraCompleta(pool, 'manual', nomeAdmin, data_inicio || null, data_fim || null).catch(err => {
        console.error('[antifraude/varredura] Erro:', err.message);
      });
    } catch (err) {
      console.error('[antifraude/varredura]', err.message);
      res.status(500).json({ error: 'Erro ao iniciar varredura' });
    }
  });

  // ============================================
  // VARREDURA — Status da última
  // ============================================
  router.get('/varredura/status', verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM antifraude_varreduras ORDER BY id DESC LIMIT 1'
      );
      res.json(rows[0] || null);
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar status' });
    }
  });

  // ============================================
  // VARREDURA — Histórico
  // ============================================
  router.get('/varreduras', verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM antifraude_varreduras ORDER BY id DESC LIMIT 50'
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
  });

  // ============================================
  // CONFIG — Ler
  // ============================================
  router.get('/config', verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM antifraude_config ORDER BY chave');
      const config = {};
      rows.forEach(r => { config[r.chave] = { valor: r.valor, descricao: r.descricao }; });
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar configurações' });
    }
  });

  // ============================================
  // CONFIG — Atualizar
  // ============================================
  router.put('/config', verificarAdmin, async (req, res) => {
    try {
      const updates = req.body; // { chave: valor, chave2: valor2, ... }

      for (const [chave, valor] of Object.entries(updates)) {
        await pool.query(
          `UPDATE antifraude_config SET valor = $1, updated_at = NOW() WHERE chave = $2`,
          [String(valor), chave]
        );
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[antifraude/config]', err.message);
      res.status(500).json({ error: 'Erro ao atualizar configurações' });
    }
  });

  // ============================================
  // RELATÓRIO — Gerar texto para compartilhar
  // ============================================
  router.get('/relatorio', verificarAdmin, async (req, res) => {
    try {
      const { dias = 7 } = req.query;

      const [alertas, motoboys, clientes] = await Promise.all([
        pool.query(`
          SELECT tipo, severidade, titulo, profissional_nome, profissional_cod,
                 solicitante_nome, os_codigos, numeros_nf, created_at
          FROM antifraude_alertas
          WHERE status = 'pendente' AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          ORDER BY severidade DESC, created_at DESC
        `, [dias]),
        pool.query(`
          SELECT profissional_cod, profissional_nome, COUNT(*) as total
          FROM antifraude_alertas
          WHERE profissional_cod IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY profissional_cod, profissional_nome
          ORDER BY total DESC LIMIT 10
        `, [dias]),
        pool.query(`
          SELECT solicitante_cod, solicitante_nome, COUNT(*) as total
          FROM antifraude_alertas
          WHERE solicitante_cod IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY solicitante_cod, solicitante_nome
          ORDER BY total DESC LIMIT 10
        `, [dias]),
      ]);

      // Gerar texto formatado para WhatsApp
      let texto = `🔍 *RELATÓRIO ANTI-FRAUDE*\n`;
      texto += `📅 Últimos ${dias} dias\n\n`;
      texto += `🚨 *${alertas.rows.length} alerta(s) pendente(s)*\n\n`;

      if (alertas.rows.length > 0) {
        const altas = alertas.rows.filter(a => a.severidade === 'alta');
        const medias = alertas.rows.filter(a => a.severidade === 'media');

        if (altas.length > 0) {
          texto += `🔴 *Severidade ALTA (${altas.length}):*\n`;
          altas.forEach(a => {
            texto += `  • ${a.titulo}\n`;
          });
          texto += '\n';
        }

        if (medias.length > 0) {
          texto += `🟡 *Severidade MÉDIA (${medias.length}):*\n`;
          medias.forEach(a => {
            texto += `  • ${a.titulo}\n`;
          });
          texto += '\n';
        }
      }

      if (motoboys.rows.length > 0) {
        texto += `🏍️ *Top Motoboys com alertas:*\n`;
        motoboys.rows.forEach((m, i) => {
          texto += `  ${i + 1}. ${m.profissional_nome || m.profissional_cod} — ${m.total} alerta(s)\n`;
        });
        texto += '\n';
      }

      if (clientes.rows.length > 0) {
        texto += `🏢 *Top Clientes com alertas:*\n`;
        clientes.rows.forEach((c, i) => {
          texto += `  ${i + 1}. ${c.solicitante_nome || c.solicitante_cod} — ${c.total} alerta(s)\n`;
        });
      }

      res.json({ texto, total_alertas: alertas.rows.length });
    } catch (err) {
      console.error('[antifraude/relatorio]', err.message);
      res.status(500).json({ error: 'Erro ao gerar relatório' });
    }
  });

  console.log('✅ Módulo Anti-Fraude — rotas montadas');
  return router;
}

module.exports = { createAntiFraudeRouter };
