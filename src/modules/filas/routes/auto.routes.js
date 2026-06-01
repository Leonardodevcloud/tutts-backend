/**
 * routes/auto.routes.js — Endpoints da fila auto-gerenciável.
 *
 * Estrutura:
 *   Motoboy (autenticado):
 *     POST /filas/auto/entrar
 *     POST /filas/auto/sair
 *     GET  /filas/auto/minha-posicao
 *     GET  /filas/auto/fila-publica/:central_id     — lista pública (todos da fila)
 *
 *   Admin (verificarAdmin):
 *     PATCH /filas/auto/admin/centrais/:id/config   — toggles e config
 *     POST  /filas/auto/admin/reordenar             — move motoboy de posição
 *     POST  /filas/auto/admin/remover-emergencia    — tira motoboy
 *     GET   /filas/auto/admin/logs/:central_id      — log do agente
 *     GET   /filas/auto/admin/fila-completa/:central_id — dashboard completo
 *
 * Não toca em endpoints da fila clássica — fila auto é OPCIONAL por central
 * (campo filas_centrais.tipo = 'auto').
 */
'use strict';

const express = require('express');
const { calcularDistanciaHaversine, compactarPosicoes, reordenarMotoboy, registrarLog } = require('../filas-auto.service');
// 🆕 2026-05-24: integração filas → disponibilidade (marcar EM LOJA automático)
const { marcarMotoboyEmLoja } = require('../../disponibilidade/disponibilidade.shared');
// 🆕 2026-05-31: integração filas → garantido (registra 1º ingresso do dia)
const { registrarGarantidoIngresso } = require('../../garantido/garantido.shared');

function createFilasAutoRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════════════
  //   MOTOBOY — entrar na fila
  // ═══════════════════════════════════════════════════════════════════════
  // Hibrído: motoboy entra na hora (com GPS + sem corrida ativa cacheada);
  // o agente Playwright valida em background (varredura ~30s) e remove
  // automaticamente se detectar corrida ativa.
  router.post('/auto/entrar', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      const nome_profissional = req.user.nome;
      const { latitude, longitude } = req.body;

      if (!latitude || !longitude) {
        return res.status(400).json({ error: 'Localização GPS é obrigatória' });
      }

      // 1) Resolve a central (vínculo + central tipo='auto')
      const vincR = await pool.query(`
        SELECT v.*, c.nome AS central_nome, c.latitude AS central_lat,
               c.longitude AS central_lng, c.raio_metros, c.tipo,
               c.id AS central_id_resolved, c.penalidade_min,
               COALESCE(c.barreira_horario_ativa, false) AS barreira_horario_ativa,
               c.barreira_horario_corte
          FROM filas_vinculos v
          JOIN filas_centrais c ON c.id = v.central_id
         WHERE v.cod_profissional = $1 AND v.ativo = true AND c.ativa = true AND c.tipo = 'auto'`,
        [cod_profissional]
      );
      if (vincR.rows.length === 0) {
        return res.status(403).json({
          error: 'sem_vinculo',
          mensagem: 'Você não está vinculado a nenhuma fila auto-gerenciável',
        });
      }
      const central = vincR.rows[0];

      // 2) GPS dentro do raio
      const dist = calcularDistanciaHaversine(
        parseFloat(latitude), parseFloat(longitude),
        parseFloat(central.central_lat), parseFloat(central.central_lng)
      );
      if (dist > central.raio_metros) {
        return res.status(403).json({
          error: 'fora_do_raio',
          distancia_atual: Math.round(dist),
          raio_permitido: central.raio_metros,
          mensagem: `Você está a ${Math.round(dist)}m da central. Aproxime-se para entrar (máx ${central.raio_metros}m).`,
        });
      }

      // 3) Penalidade ativa?
      const penR = await pool.query(
        `SELECT bloqueado_ate FROM filas_penalidades
          WHERE cod_profissional = $1 AND central_id = $2
            AND bloqueado_ate > NOW() AND anulado_em IS NULL
          ORDER BY bloqueado_ate DESC LIMIT 1`,
        [cod_profissional, central.central_id_resolved]
      );
      if (penR.rows.length > 0) {
        const minRest = Math.ceil((new Date(penR.rows[0].bloqueado_ate).getTime() - Date.now()) / 60000);
        return res.status(403).json({
          error: 'penalidade_ativa',
          bloqueado_ate: penR.rows[0].bloqueado_ate,
          mensagem: `Você saiu há pouco da fila. Aguarde ${minRest}min para reentrar.`,
        });
      }

      // 3b) Barreira de horário — só para o PRIMEIRO ingresso do dia, após horário corte
      if (central.barreira_horario_ativa && central.barreira_horario_corte) {
        // Verificar se é o primeiro ingresso do motoboy HOJE nesta central
        // 🔧 2026-05-31 BUGFIX: a fila auto registra ingresso como 'entrada_auto'
        // (auto.routes.js: INSERT ... 'entrada_auto'). A lista ANTERIOR só tinha
        // 'entrada'/'entrada_manual', então NUNCA encontrava o 1º ingresso do dia
        // na fila auto → primeiroIngressoHoje era sempre true → todo RETORNO da
        // rota após o corte era barrado indevidamente. Incluído 'entrada_auto'.
        const primeiroHojeR = await pool.query(
          `SELECT id FROM filas_historico
            WHERE cod_profissional = $1 AND central_id = $2
              AND acao IN ('entrada', 'entrada_manual', 'entrada_auto')
              AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Bahia'
            LIMIT 1`,
          [cod_profissional, central.central_id_resolved]
        );
        const primeiroIngressoHoje = primeiroHojeR.rows.length === 0;

        if (primeiroIngressoHoje) {
          // Comparar hora atual (Bahia) com horário corte configurado
          const agoraBahia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
          const [hCorte, mCorte] = central.barreira_horario_corte.split(':').map(Number);
          const minutosAgora  = agoraBahia.getHours() * 60 + agoraBahia.getMinutes();
          const minutosCorte  = hCorte * 60 + mCorte;

          if (minutosAgora >= minutosCorte) {
            // Inserir como penalidade tipo 'barreira_horario' — aparece na aba Punidos
            // Bloqueio: até meia-noite (expira sozinho no dia seguinte)
            await pool.query(
              `INSERT INTO filas_penalidades
                 (cod_profissional, nome_profissional, central_id, bloqueado_ate, saidas_hoje, tipo, motivo_admin)
               VALUES ($1, $2, $3,
                 (CURRENT_DATE + 1)::timestamp AT TIME ZONE 'America/Bahia',
                 0, 'barreira_horario',
                 $4)
               ON CONFLICT DO NOTHING`,
              [
                cod_profissional,
                nome_profissional,
                central.central_id_resolved,
                `Acesso tardio: tentou entrar às ${agoraBahia.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})} (corte: ${central.barreira_horario_corte.slice(0,5)})`,
              ]
            );

            // Broadcast para admins verem na aba Punidos
            if (global.broadcastFilasAuto) {
              global.broadcastFilasAuto('FILA_PENALIDADE_NOVA', {
                central_id: central.central_id_resolved,
                cod_profissional,
                nome_profissional,
                bloqueado_ate: new Date(new Date().setHours(23,59,59,999)).toISOString(),
                saidas_hoje: 0,
                tipo: 'barreira_horario',
                motivo_admin: `Acesso tardio (corte: ${central.barreira_horario_corte.slice(0,5)})`,
              });
            }

            return res.status(403).json({
              error: 'barreira_horario',
              horario_corte: central.barreira_horario_corte.slice(0,5),
              nome_profissional,
              mensagem: `Acesso bloqueado após ${central.barreira_horario_corte.slice(0,5)}.`,
            });
          }
        }
      }

      // 4) Já está na fila?
      const jaR = await pool.query(
        `SELECT id, status, posicao FROM filas_posicoes WHERE cod_profissional = $1`,
        [cod_profissional]
      );
      if (jaR.rows.length > 0 && jaR.rows[0].status === 'aguardando') {
        return res.status(409).json({
          error: 'ja_na_fila',
          posicao: jaR.rows[0].posicao,
          mensagem: 'Você já está nesta fila',
        });
      }

      // 5) Calcular nova posição (última + 1)
      const ultR = await pool.query(
        `SELECT COALESCE(MAX(posicao), 0) AS max_pos FROM filas_posicoes
          WHERE central_id = $1 AND status = 'aguardando'`,
        [central.central_id_resolved]
      );
      const novaPosicao = parseInt(ultR.rows[0].max_pos, 10) + 1;

      // 6) Inserir ou reaproveitar registro existente
      if (jaR.rows.length > 0) {
        await pool.query(
          `UPDATE filas_posicoes
              SET central_id = $1, status = 'aguardando', posicao = $2,
                  entrada_fila_at = NOW(), saida_rota_at = NULL, retorno_at = NULL,
                  latitude_checkin = $3, longitude_checkin = $4,
                  agente_status = 'pendente', agente_ultima_validacao_at = NULL,
                  corridas_ativas_count = 0, motivo_posicao = NULL,
                  notas_liberadas = 0, primeira_nota_at = NULL, bairros = '[]'::jsonb,
                  updated_at = NOW()
            WHERE id = $5`,
          [central.central_id_resolved, novaPosicao, latitude, longitude, jaR.rows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO filas_posicoes
             (central_id, cod_profissional, nome_profissional, status, posicao,
              latitude_checkin, longitude_checkin, agente_status, entrada_fila_at)
           VALUES ($1, $2, $3, 'aguardando', $4, $5, $6, 'pendente', NOW())`,
          [central.central_id_resolved, cod_profissional, nome_profissional, novaPosicao, latitude, longitude]
        );
      }

      await pool.query(
        `INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao)
         VALUES ($1, $2, $3, $4, 'entrada_auto')`,
        [central.central_id_resolved, central.central_nome, cod_profissional, nome_profissional]
      );

      // 🆕 2026-05-24: marca o motoboy como EM LOJA na disponibilidade (fire-and-forget)
      marcarMotoboyEmLoja(pool, cod_profissional, {
        origem: 'fila_auto',
        alterado_por: `Auto (entrou na fila: ${nome_profissional})`,
      }).catch(() => {});

      // 🆕 2026-05-31: registra/recupera o garantido do dia (1º ingresso trava o valor)
      const garantido = await registrarGarantidoIngresso(pool, {
        central_id: central.central_id_resolved, cod_profissional, nome_profissional,
      });

      res.json({
        success: true,
        posicao: novaPosicao,
        central: central.central_nome,
        distancia: Math.round(dist),
        mensagem: 'Você entrou! O agente vai confirmar que está sem corrida ativa em alguns segundos.',
        agente_status: 'pendente',
        garantido,
      });

      registrarAuditoria(req, 'FILA_AUTO_ENTRAR', 'user', 'filas_posicoes', null, {
        central_id: central.central_id_resolved, posicao: novaPosicao,
      }).catch(() => {});
    } catch (err) {
      console.error('❌ [fila-auto/entrar]', err);
      res.status(500).json({ error: 'Erro ao entrar na fila' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   MOTOBOY — sair da fila (manual)
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/auto/sair', verificarToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const cod_profissional = req.user.codProfissional;
      const nome_profissional = req.user.nome;

      await client.query('BEGIN');

      const posR = await client.query(
        `SELECT id, central_id, posicao FROM filas_posicoes
          WHERE cod_profissional = $1 AND status = 'aguardando' FOR UPDATE`,
        [cod_profissional]
      );
      if (posR.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Você não está na fila' });
      }
      const { central_id, posicao } = posR.rows[0];

      // Buscar config de penalidade
      const cfgR = await client.query(
        `SELECT penalidade_min, nome FROM filas_centrais WHERE id = $1`,
        [central_id]
      );
      const penMin = parseInt(cfgR.rows[0]?.penalidade_min, 10) || 0;
      const centralNome = cfgR.rows[0]?.nome || '';

      // Remove o registro (não há volta gradual como na fila clássica)
      await client.query(`DELETE FROM filas_posicoes WHERE id = $1`, [posR.rows[0].id]);

      // Compactar posições abertas
      await compactarPosicoes(client, central_id, client);

      // Aplica penalidade se configurada
      // 🔧 v2 (2026-05-28): ON CONFLICT — motoboy pode sair 2x no mesmo dia;
      // sem isso o INSERT explode com 23505 (unique constraint data_ref) → 500 → circuit breaker.
      if (penMin > 0) {
        await client.query(
          `INSERT INTO filas_penalidades (cod_profissional, nome_profissional, central_id, bloqueado_ate, saidas_hoje)
           VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, 1)
           ON CONFLICT (cod_profissional, central_id, data_ref)
           DO UPDATE SET
             saidas_hoje  = filas_penalidades.saidas_hoje + 1,
             bloqueado_ate = EXCLUDED.bloqueado_ate`,
          [cod_profissional, nome_profissional, central_id, String(penMin)]
        );
      }

      await client.query(
        `INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao)
         VALUES ($1, $2, $3, $4, 'saida_voluntaria')`,
        [central_id, centralNome, cod_profissional, nome_profissional]
      );

      await client.query('COMMIT');

      // Log fora da transação
      registrarLog(pool, central_id, 'saida_voluntaria', {
        cod_profissional, nome_profissional, motivo: `Posição ${posicao} liberada por saída manual`,
      });

      res.json({
        success: true,
        penalidade_min: penMin,
        mensagem: penMin > 0
          ? `Você saiu da fila. Pode voltar em ${penMin} minutos.`
          : 'Você saiu da fila.',
      });

      // Broadcast WS para admins atualizarem aba Punidos em tempo real
      if (penMin > 0 && global.broadcastFilasAuto) {
        try {
          global.broadcastFilasAuto('FILA_PENALIDADE_NOVA', {
            central_id,
            cod_profissional,
            nome_profissional,
            bloqueado_ate: new Date(Date.now() + penMin * 60000).toISOString(),
            saidas_hoje: 1,
            tipo: 'automatica',
          });
        } catch (_) {}
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('❌ [fila-auto/sair]', err);
      res.status(500).json({ error: 'Erro ao sair da fila' });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   MOTOBOY — minha posição
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/auto/minha-posicao', verificarToken, async (req, res) => {
    try {
      const cod_profissional = req.user.codProfissional;
      const r = await pool.query(
        `SELECT p.id, p.central_id, p.posicao, p.status, p.entrada_fila_at,
                p.agente_status, p.agente_ultima_validacao_at, p.corridas_ativas_count,
                c.nome AS central_nome, c.latitude, c.longitude, c.raio_metros,
                c.mostrar_nomes_publicos
           FROM filas_posicoes p
           JOIN filas_centrais c ON c.id = p.central_id
          WHERE p.cod_profissional = $1 AND p.status = 'aguardando'
            AND c.tipo = 'auto'`,
        [cod_profissional]
      );
      if (r.rows.length === 0) return res.json({ success: true, na_fila: false });

      const row = r.rows[0];
      const totalR = await pool.query(
        `SELECT COUNT(*)::int AS total FROM filas_posicoes
          WHERE central_id = $1 AND status = 'aguardando'`,
        [row.central_id]
      );

      res.json({
        success: true, na_fila: true,
        central_id: row.central_id, central_nome: row.central_nome,
        posicao: row.posicao, total_fila: totalR.rows[0].total,
        entrada_fila_at: row.entrada_fila_at,
        agente_status: row.agente_status, // 'pendente' | 'validado' | 'reprovado'
        agente_ultima_validacao_at: row.agente_ultima_validacao_at,
        corridas_ativas_count: row.corridas_ativas_count,
        mostrar_nomes_publicos: row.mostrar_nomes_publicos,
      });
    } catch (err) {
      console.error('❌ [fila-auto/minha-posicao]', err);
      res.status(500).json({ error: 'Erro ao consultar posição' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   MOTOBOY — fila pública (vê todos)
  // ═══════════════════════════════════════════════════════════════════════
  // Respeita config mostrar_nomes_publicos: se false, retorna apenas posições.
  // Foto vem via /perfil/fotos no frontend (padrão Saques/Filas).
  router.get('/auto/fila-publica/:central_id', verificarToken, async (req, res) => {
    try {
      const centralId = parseInt(req.params.central_id, 10);
      if (isNaN(centralId)) return res.status(400).json({ error: 'central_id inválido' });

      const cfgR = await pool.query(
        `SELECT mostrar_nomes_publicos, tipo FROM filas_centrais WHERE id = $1`,
        [centralId]
      );
      if (cfgR.rows.length === 0 || cfgR.rows[0].tipo !== 'auto') {
        return res.status(404).json({ error: 'Central não é auto-gerenciável' });
      }
      const mostrarNomes = cfgR.rows[0].mostrar_nomes_publicos !== false;

      const fila = await pool.query(
        `SELECT cod_profissional,
                ${mostrarNomes ? 'nome_profissional' : 'NULL AS nome_profissional'},
                posicao, entrada_fila_at, agente_status
           FROM filas_posicoes
          WHERE central_id = $1 AND status = 'aguardando'
          ORDER BY posicao ASC`,
        [centralId]
      );

      res.json({
        success: true,
        mostrar_nomes_publicos: mostrarNomes,
        total: fila.rows.length,
        fila: fila.rows,
      });
    } catch (err) {
      console.error('❌ [fila-auto/fila-publica]', err);
      res.status(500).json({ error: 'Erro ao listar fila' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   ADMIN — config da central
  // ═══════════════════════════════════════════════════════════════════════
  router.patch('/auto/admin/centrais/:id/config', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const centralId = parseInt(req.params.id, 10);
      if (isNaN(centralId)) return res.status(400).json({ error: 'id inválido' });

      const allow = ['tipo', 'validacao_agente_ativa', 'varredura_intervalo_seg',
                     'remover_ao_pegar_corrida', 'mostrar_nomes_publicos', 'penalidade_min',
                     'raio_metros'];
      const updates = [];
      const params = [];
      let i = 1;
      for (const k of allow) {
        if (req.body[k] !== undefined) {
          updates.push(`${k} = $${i++}`);
          params.push(req.body[k]);
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

      params.push(centralId);
      const r = await pool.query(
        `UPDATE filas_centrais SET ${updates.join(', ')}, updated_at = NOW()
          WHERE id = $${i} RETURNING *`,
        params
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Central não encontrada' });

      registrarAuditoria(req, 'FILA_AUTO_CONFIG', 'admin', 'filas_centrais', centralId, req.body).catch(() => {});
      res.json({ success: true, central: r.rows[0] });
    } catch (err) {
      console.error('❌ [fila-auto/admin/config]', err);
      res.status(500).json({ error: 'Erro ao atualizar config' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   ADMIN — reordenar motoboy
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/auto/admin/reordenar', verificarToken, verificarAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const { central_id, cod_profissional, nova_posicao } = req.body;
      if (!central_id || !cod_profissional || !nova_posicao) {
        return res.status(400).json({ error: 'central_id, cod_profissional e nova_posicao obrigatórios' });
      }
      await client.query('BEGIN');
      const result = await reordenarMotoboy(client, parseInt(central_id, 10), cod_profissional, parseInt(nova_posicao, 10));
      if (!result.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: result.mensagem });
      }
      await client.query('COMMIT');

      registrarLog(pool, central_id, 'admin_reordenou', {
        cod_profissional, motivo: `Movido para posição ${nova_posicao}`,
        detalhes: { admin: req.user.nome, nova_posicao },
      });
      registrarAuditoria(req, 'FILA_AUTO_REORDENAR', 'admin', 'filas_posicoes', null, req.body).catch(() => {});

      res.json({ success: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('❌ [fila-auto/admin/reordenar]', err);
      res.status(500).json({ error: 'Erro ao reordenar' });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   ADMIN — remover motoboy (emergência)
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/auto/admin/remover-emergencia', verificarToken, verificarAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const { central_id, cod_profissional, motivo } = req.body;
      if (!central_id || !cod_profissional) {
        return res.status(400).json({ error: 'central_id e cod_profissional obrigatórios' });
      }
      await client.query('BEGIN');

      // 🔄 2026-05-24: remove tanto aguardando quanto em_rota
      // (admin pode tirar motoboy que travou ou foi despachado errado)
      const r = await client.query(
        `DELETE FROM filas_posicoes
          WHERE central_id = $1 AND cod_profissional = $2
            AND status IN ('aguardando', 'em_rota')
          RETURNING nome_profissional, status`,
        [parseInt(central_id, 10), cod_profissional]
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Motoboy não está nesta fila' });
      }
      const nomeProf = r.rows[0].nome_profissional;
      const statusAnterior = r.rows[0].status;

      await compactarPosicoes(client, parseInt(central_id, 10), client);

      await client.query(
        `INSERT INTO filas_historico (central_id, cod_profissional, nome_profissional, acao, observacao, admin_nome)
         VALUES ($1, $2, $3, 'admin_removeu', $4, $5)`,
        [central_id, cod_profissional, nomeProf, motivo || null, req.user.nome]
      );
      await client.query('COMMIT');

      registrarLog(pool, central_id, 'admin_removeu', {
        cod_profissional, nome_profissional: nomeProf,
        motivo: motivo || 'Sem motivo informado',
        detalhes: { admin: req.user.nome },
      });
      registrarAuditoria(req, 'FILA_AUTO_REMOVER_EMERGENCIA', 'admin', 'filas_posicoes', null, req.body).catch(() => {});

      res.json({ success: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('❌ [fila-auto/admin/remover-emergencia]', err);
      res.status(500).json({ error: 'Erro ao remover' });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   ADMIN — log do agente (últimos N eventos)
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/auto/admin/logs/:central_id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const centralId = parseInt(req.params.central_id, 10);
      const limite = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      if (isNaN(centralId)) return res.status(400).json({ error: 'central_id inválido' });

      const r = await pool.query(
        `SELECT id, cod_profissional, nome_profissional, acao, motivo, detalhes, created_at
           FROM filas_agente_logs
          WHERE central_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [centralId, limite]
      );
      res.json({ success: true, logs: r.rows });
    } catch (err) {
      console.error('❌ [fila-auto/admin/logs]', err);
      res.status(500).json({ error: 'Erro ao listar logs' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   ADMIN — dashboard completo da central
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/auto/admin/fila-completa/:central_id', verificarToken, async (req, res) => {
    try {
      const centralId = parseInt(req.params.central_id, 10);
      if (isNaN(centralId)) return res.status(400).json({ error: 'central_id inválido' });

      const centralR = await pool.query(
        `SELECT * FROM filas_centrais WHERE id = $1 AND tipo = 'auto'`,
        [centralId]
      );
      if (centralR.rows.length === 0) return res.status(404).json({ error: 'Central não encontrada ou não é auto' });

      // 🆕 2026-05-24: enriquece cada motoboy com info de alocação na disponibilidade.
      // LEFT JOIN LATERAL pega a primeira linha do motoboy em disponibilidade_linhas
      // (se existir). Se não tiver linha, alocado=NULL → frontend mostra badge
      // vermelho "Sem disponibilidade" pra forçar admin a alocar.
      // 🔧 v3 (2026-05-24): LOWER(TRIM(...)) em ambos os lados — alinhado com o
      // resto do sistema (auth usa case-insensitive); evita falsos negativos por
      // diferença de case/whitespace entre fontes.
      const filaR = await pool.query(
        `SELECT p.cod_profissional, p.nome_profissional, p.posicao, p.status, p.entrada_fila_at,
                p.agente_status, p.agente_ultima_validacao_at, p.corridas_ativas_count,
                (d.loja_id IS NOT NULL) AS disponibilidade_alocado,
                d.loja_nome              AS disponibilidade_loja,
                d.status_atual           AS disponibilidade_status
           FROM filas_posicoes p
           LEFT JOIN LATERAL (
             SELECT dl.loja_id, l.nome AS loja_nome, dl.status AS status_atual
               FROM disponibilidade_linhas dl
               JOIN disponibilidade_lojas l ON l.id = dl.loja_id
              WHERE LOWER(TRIM(dl.cod_profissional)) = LOWER(TRIM(p.cod_profissional))
              ORDER BY dl.id ASC
              LIMIT 1
           ) d ON TRUE
          WHERE p.central_id = $1 AND p.status = 'aguardando'
          ORDER BY p.posicao ASC`,
        [centralId]
      );

      // 🆕 2026-05-24: também retorna motoboys em rota (status='em_rota')
      // pra admin visualizar quem foi despachado, no layout 2 colunas idêntico
      // ao da fila clássica.
      const emRotaR = await pool.query(
        `SELECT p.cod_profissional, p.nome_profissional, p.status, p.saida_rota_at,
                p.agente_status, p.corridas_ativas_count,
                ROUND(EXTRACT(EPOCH FROM (NOW() - p.saida_rota_at))/60)::int AS minutos_em_rota,
                (d.loja_id IS NOT NULL) AS disponibilidade_alocado,
                d.loja_nome              AS disponibilidade_loja,
                d.status_atual           AS disponibilidade_status
           FROM filas_posicoes p
           LEFT JOIN LATERAL (
             SELECT dl.loja_id, l.nome AS loja_nome, dl.status AS status_atual
               FROM disponibilidade_linhas dl
               JOIN disponibilidade_lojas l ON l.id = dl.loja_id
              WHERE LOWER(TRIM(dl.cod_profissional)) = LOWER(TRIM(p.cod_profissional))
              ORDER BY dl.id ASC
              LIMIT 1
           ) d ON TRUE
          WHERE p.central_id = $1 AND p.status = 'em_rota'
          ORDER BY p.saida_rota_at ASC`,
        [centralId]
      );

      // Alertas: em rota há mais de 90 min
      const alertasArr = emRotaR.rows.filter(r => (r.minutos_em_rota || 0) > 90);

      // 🆕 2026-05-24: KPI de motoboys aguardando SEM alocação na disponibilidade
      const semAlocacao = filaR.rows.filter(p => !p.disponibilidade_alocado).length;

      // Bloqueados recentes (últimos eventos de bloqueou_entrada nas últimas 24h)
      const bloqR = await pool.query(
        `SELECT DISTINCT ON (cod_profissional)
                cod_profissional, nome_profissional, motivo, detalhes, created_at
           FROM filas_agente_logs
          WHERE central_id = $1 AND acao = 'bloqueou_entrada'
            AND created_at >= NOW() - INTERVAL '24 hours'
          ORDER BY cod_profissional, created_at DESC`,
        [centralId]
      );

      // KPIs
      const kpisR = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM filas_posicoes WHERE central_id = $1 AND status = 'aguardando') AS total_aguardando,
            (SELECT COUNT(*)::int FROM filas_posicoes WHERE central_id = $1 AND status = 'em_rota') AS total_em_rota,
            (SELECT COUNT(*)::int FROM filas_agente_logs WHERE central_id = $1 AND acao = 'bloqueou_entrada' AND created_at >= NOW() - INTERVAL '1 hour') AS bloqueados_ultima_hora,
            (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - entrada_fila_at))/60), 0)::int
               FROM filas_posicoes WHERE central_id = $1 AND status = 'aguardando') AS tempo_medio_min`,
        [centralId]
      );

      res.json({
        success: true,
        central: centralR.rows[0],
        fila: filaR.rows,
        em_rota: emRotaR.rows,         // 🆕 2026-05-24
        alertas: alertasArr,           // 🆕 2026-05-24
        bloqueados: bloqR.rows,
        kpis: kpisR.rows[0],
        total_sem_disponibilidade: semAlocacao,  // 🆕 2026-05-24
      });
    } catch (err) {
      console.error('❌ [fila-auto/admin/fila-completa]', err);
      res.status(500).json({ error: 'Erro ao montar dashboard' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   ADMIN — colocar motoboy na fila (manual)
  // ═══════════════════════════════════════════════════════════════════════
  // 🆕 2026-05-24: admin força inserção de motoboy vinculado na fila auto,
  // pulando GPS/raio. Útil quando o motoboy não tem como entrar sozinho.
  router.post('/auto/admin/colocar-na-fila', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cod_profissional, central_id } = req.body;
      if (!cod_profissional || !central_id) {
        return res.status(400).json({ error: 'cod_profissional e central_id são obrigatórios' });
      }

      // Confere vínculo + central auto
      const vinc = await pool.query(`
        SELECT v.cod_profissional, v.nome_profissional, c.nome AS central_nome, c.tipo
          FROM filas_vinculos v
          JOIN filas_centrais c ON c.id = v.central_id
         WHERE v.cod_profissional = $1 AND v.central_id = $2
           AND v.ativo = true AND c.ativa = true`,
        [cod_profissional, central_id]
      );
      if (vinc.rows.length === 0) {
        return res.status(403).json({ error: 'Motoboy não está vinculado a esta central' });
      }
      if (vinc.rows[0].tipo !== 'auto') {
        return res.status(400).json({ error: 'Central não é auto-gerenciável' });
      }

      // Já está na fila?
      const ja = await pool.query(
        'SELECT id, status, posicao FROM filas_posicoes WHERE cod_profissional = $1',
        [cod_profissional]
      );
      if (ja.rows.length > 0) {
        if (ja.rows[0].status === 'aguardando') {
          return res.status(400).json({ error: 'Motoboy já está aguardando', posicao: ja.rows[0].posicao });
        }
        if (ja.rows[0].status === 'em_rota') {
          return res.status(400).json({ error: 'Motoboy está em rota — aguarde finalizar' });
        }
      }

      // Última posição + 1
      const ultPos = await pool.query(
        `SELECT COALESCE(MAX(posicao), 0) AS max_pos FROM filas_posicoes
          WHERE central_id = $1 AND status = 'aguardando'`,
        [central_id]
      );
      const novaPosicao = parseInt(ultPos.rows[0].max_pos) + 1;

      if (ja.rows.length > 0) {
        await pool.query(`
          UPDATE filas_posicoes
             SET central_id = $1, status = 'aguardando', posicao = $2,
                 entrada_fila_at = NOW(), saida_rota_at = NULL, retorno_at = NULL,
                 latitude_checkin = NULL, longitude_checkin = NULL,
                 agente_status = 'pendente', agente_ultima_validacao_at = NULL,
                 corridas_ativas_count = 0, motivo_posicao = 'colocado_admin',
                 notas_liberadas = 0, primeira_nota_at = NULL, bairros = '[]'::jsonb,
                 updated_at = NOW()
           WHERE id = $3
        `, [central_id, novaPosicao, ja.rows[0].id]);
      } else {
        await pool.query(`
          INSERT INTO filas_posicoes
            (central_id, cod_profissional, nome_profissional, status, posicao,
             agente_status, motivo_posicao, entrada_fila_at)
          VALUES ($1, $2, $3, 'aguardando', $4, 'pendente', 'colocado_admin', NOW())
        `, [central_id, cod_profissional, vinc.rows[0].nome_profissional, novaPosicao]);
      }

      await pool.query(`
        INSERT INTO filas_historico (central_id, central_nome, cod_profissional, nome_profissional, acao)
        VALUES ($1, $2, $3, $4, 'colocado_admin')
      `, [central_id, vinc.rows[0].central_nome, cod_profissional, vinc.rows[0].nome_profissional]);

      registrarLog(pool, central_id, 'colocado_admin', {
        cod_profissional, nome_profissional: vinc.rows[0].nome_profissional,
        motivo: 'Admin inseriu manualmente',
      });

      // 🆕 2026-05-24: marca o motoboy como EM LOJA na disponibilidade (fire-and-forget)
      marcarMotoboyEmLoja(pool, cod_profissional, {
        origem: 'fila_auto_admin',
        alterado_por: `Admin: ${req.user?.nome || 'desconhecido'}`,
      }).catch(() => {});

      res.json({
        success: true,
        posicao: novaPosicao,
        cod_profissional,
        nome_profissional: vinc.rows[0].nome_profissional,
      });

      registrarAuditoria(req, 'FILA_AUTO_COLOCAR_ADMIN', 'admin', 'filas_posicoes', null, {
        central_id, cod_profissional, posicao: novaPosicao,
      }).catch(() => {});
    } catch (err) {
      console.error('❌ [fila-auto/admin/colocar-na-fila]', err);
      res.status(500).json({ error: 'Erro ao colocar na fila' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   ADMIN — disparar varredura agora (manual)
  // ═══════════════════════════════════════════════════════════════════════
  // Útil pra troubleshooting e pra ver efeito imediato sem esperar o cron.
  // O agente principal continua rodando no intervalo normal.
  router.post('/auto/admin/varredura-agora', verificarToken, verificarAdmin, async (req, res) => {
    try {
      // Lazy-require pra evitar circular se o agente decidir importar daqui
      const filaValidador = require('../fila-validador.service');
      let slaCapture;
      try {
        slaCapture = require('../../agent/playwright-sla-capture');
      } catch (e) {
        return res.status(500).json({ error: 'playwright-sla-capture não disponível', detalhe: e.message });
      }
      if (typeof slaCapture.coletarOsEmExecucao !== 'function') {
        return res.status(500).json({ error: 'coletarOsEmExecucao não exportada pelo sla-capture' });
      }

      // coletarOsEmExecucao() retorna { ok, ordens, motivo, sessaoExpirada }
      // NÃO é um array — mesmo fix já aplicado no fila-validador.agent.js
      const capResult = await slaCapture.coletarOsEmExecucao();
      if (!capResult || !capResult.ok) {
        return res.status(502).json({
          error: 'Falha ao coletar OS em execução do sistema externo',
          motivo: capResult?.motivo || 'desconhecido',
          sessao_expirada: capResult?.sessaoExpirada || false,
        });
      }
      const todasOs = capResult.ordens || [];
      const mapa = new Map();
      for (const os of todasOs) {
        const cod = String(os.cod_profissional || '').trim();
        if (!cod) continue;
        if (!mapa.has(cod)) mapa.set(cod, []);
        mapa.get(cod).push({ os_numero: os.os_numero || null });
      }
      const resultado = await filaValidador.aplicarResultadoVarredura(pool, mapa);
      res.json({ success: true, resultado, motoboys_no_externo: mapa.size, ordens_coletadas: todasOs.length });
    } catch (err) {
      console.error('❌ [fila-auto/admin/varredura-agora]', err);
      res.status(500).json({ error: 'Erro ao disparar varredura', detalhe: err.message });
    }
  });

  return router;
}

module.exports = { createFilasAutoRoutes };
