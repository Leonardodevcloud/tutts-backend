/**
 * Sub-Router: Uber Admin
 * CRUD config, dashboard, controle manual de entregas, métricas
 */
const express = require('express');
const {
  obterConfig, despacharParaUber, mappListarServicos,
  mappAlterarStatus, uberCancelarEntrega, uberConsultarEntrega,
} = require('../uber.service');

function createUberAdminRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ─── CONFIG ─────────────────────────────────────────────

  // Obter configuração atual
  router.get('/config', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const config = await obterConfig(pool);
      // Mascarar segredos
      if (config) {
        config.client_secret = config.client_secret ? '••••••••' : null;
        config.mapp_api_token = config.mapp_api_token ? '••••••••' : null;
        config.webhook_secret = config.webhook_secret ? '••••••••' : null;
      }
      res.json({ success: true, config });
    } catch (error) {
      console.error('❌ Erro ao obter config Uber:', error);
      res.status(500).json({ error: 'Erro ao obter configuração' });
    }
  });

  // Atualizar configuração
  router.put('/config', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const {
        ativo, client_id, client_secret, customer_id, webhook_secret,
        mapp_api_url, mapp_api_token, polling_intervalo_seg,
        auto_despacho, timeout_sem_entregador_min,
      } = req.body;

      // Montar SET dinâmico (só atualiza campos enviados)
      const campos = [];
      const valores = [];
      let idx = 1;

      const addCampo = (nome, valor) => {
        if (valor !== undefined) {
          campos.push(`${nome} = $${idx++}`);
          valores.push(valor);
        }
      };

      addCampo('ativo', ativo);
      addCampo('client_id', client_id);
      if (client_secret && client_secret !== '••••••••') addCampo('client_secret', client_secret);
      addCampo('customer_id', customer_id);
      if (webhook_secret && webhook_secret !== '••••••••') addCampo('webhook_secret', webhook_secret);
      addCampo('mapp_api_url', mapp_api_url);
      if (mapp_api_token && mapp_api_token !== '••••••••') addCampo('mapp_api_token', mapp_api_token);
      addCampo('polling_intervalo_seg', polling_intervalo_seg);
      addCampo('auto_despacho', auto_despacho);
      addCampo('timeout_sem_entregador_min', timeout_sem_entregador_min);

      if (campos.length === 0) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar' });
      }

      campos.push(`updated_at = NOW()`);

      await pool.query(`UPDATE uber_config SET ${campos.join(', ')} WHERE id = 1`, valores);

      await registrarAuditoria(req, 'ATUALIZAR_CONFIG_UBER', 'config', 'uber_config', 1, { campos_atualizados: campos.length });

      res.json({ success: true, message: 'Configuração atualizada' });
    } catch (error) {
      console.error('❌ Erro ao atualizar config Uber:', error);
      res.status(500).json({ error: 'Erro ao atualizar configuração' });
    }
  });

  // Testar conexão com Mapp
  router.post('/config/testar-mapp', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const servicos = await mappListarServicos(pool, 0, 0);
      res.json({
        success: true,
        message: `Conexão OK! ${servicos.length} serviço(s) aberto(s) encontrado(s)`,
        total: servicos.length,
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ─── REGRAS POR CLIENTE ─────────────────────────────────

  router.get('/regras', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM uber_regras_cliente ORDER BY cliente_nome');
      res.json({ success: true, regras: rows });
    } catch (error) {
      console.error('❌ Erro ao listar regras:', error);
      res.status(500).json({ error: 'Erro ao listar regras' });
    }
  });

  router.post('/regras', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { cliente_nome, cliente_identificador, usar_uber, prioridade, horario_inicio, horario_fim, valor_minimo, valor_maximo } = req.body;

      if (!cliente_nome) return res.status(400).json({ error: 'Nome do cliente obrigatório' });

      const { rows: [regra] } = await pool.query(`
        INSERT INTO uber_regras_cliente (cliente_nome, cliente_identificador, usar_uber, prioridade, horario_inicio, horario_fim, valor_minimo, valor_maximo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [cliente_nome, cliente_identificador, usar_uber ?? true, prioridade || 'uber_primeiro', horario_inicio, horario_fim, valor_minimo, valor_maximo]);

      await registrarAuditoria(req, 'CRIAR_REGRA_UBER', 'config', 'uber_regras_cliente', regra.id, { cliente_nome });

      res.json({ success: true, regra });
    } catch (error) {
      console.error('❌ Erro ao criar regra:', error);
      res.status(500).json({ error: 'Erro ao criar regra' });
    }
  });

  router.put('/regras/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { cliente_nome, usar_uber, prioridade, horario_inicio, horario_fim, valor_minimo, valor_maximo, ativo } = req.body;

      const { rows: [regra] } = await pool.query(`
        UPDATE uber_regras_cliente SET
          cliente_nome = COALESCE($1, cliente_nome),
          usar_uber = COALESCE($2, usar_uber),
          prioridade = COALESCE($3, prioridade),
          horario_inicio = $4,
          horario_fim = $5,
          valor_minimo = $6,
          valor_maximo = $7,
          ativo = COALESCE($8, ativo),
          updated_at = NOW()
        WHERE id = $9 RETURNING *
      `, [cliente_nome, usar_uber, prioridade, horario_inicio, horario_fim, valor_minimo, valor_maximo, ativo, id]);

      if (!regra) return res.status(404).json({ error: 'Regra não encontrada' });

      res.json({ success: true, regra });
    } catch (error) {
      console.error('❌ Erro ao atualizar regra:', error);
      res.status(500).json({ error: 'Erro ao atualizar regra' });
    }
  });

  router.delete('/regras/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM uber_regras_cliente WHERE id = $1', [id]);
      await registrarAuditoria(req, 'DELETAR_REGRA_UBER', 'config', 'uber_regras_cliente', id);
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao deletar regra:', error);
      res.status(500).json({ error: 'Erro ao deletar regra' });
    }
  });

  // ─── ENTREGAS ───────────────────────────────────────────

  // Listar entregas com filtros
  router.get('/entregas', verificarToken, async (req, res) => {
    try {
      const { status, data_inicio, data_fim, limit = 50, offset = 0 } = req.query;

      let where = 'WHERE 1=1';
      const params = [];
      let idx = 1;

      if (status) {
        where += ` AND e.status_uber = $${idx++}`;
        params.push(status);
      }
      if (data_inicio) {
        where += ` AND e.created_at >= $${idx++}`;
        params.push(data_inicio);
      }
      if (data_fim) {
        where += ` AND e.created_at <= $${idx++}`;
        params.push(data_fim + ' 23:59:59');
      }

      const { rows: entregas } = await pool.query(`
        SELECT e.*, 
          (SELECT COUNT(*) FROM uber_tracking t WHERE t.codigo_os = e.codigo_os) as total_tracking
        FROM uber_entregas e
        ${where}
        ORDER BY e.created_at DESC
        LIMIT $${idx++} OFFSET $${idx++}
      `, [...params, parseInt(limit), parseInt(offset)]);

      const { rows: [{ total }] } = await pool.query(
        `SELECT COUNT(*) as total FROM uber_entregas e ${where}`, params
      );

      res.json({ success: true, entregas, total: parseInt(total), limit: parseInt(limit), offset: parseInt(offset) });
    } catch (error) {
      console.error('❌ Erro ao listar entregas Uber:', error);
      res.status(500).json({ error: 'Erro ao listar entregas' });
    }
  });

  // Detalhe de uma entrega
  router.get('/entregas/:codigoOS', verificarToken, async (req, res) => {
    try {
      const { codigoOS } = req.params;

      const { rows } = await pool.query(
        'SELECT * FROM uber_entregas WHERE codigo_os = $1 ORDER BY created_at DESC LIMIT 1',
        [codigoOS]
      );

      if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });

      // Buscar tracking points
      const { rows: tracking } = await pool.query(
        'SELECT latitude, longitude, status_uber, created_at FROM uber_tracking WHERE codigo_os = $1 ORDER BY created_at',
        [codigoOS]
      );

      // Buscar webhooks recebidos
      const { rows: webhooks } = await pool.query(
        'SELECT tipo, created_at, processado, erro FROM uber_webhooks_log WHERE codigo_os = $1 ORDER BY created_at',
        [codigoOS]
      );

      res.json({ success: true, entrega: rows[0], tracking, webhooks });
    } catch (error) {
      console.error('❌ Erro ao buscar entrega:', error);
      res.status(500).json({ error: 'Erro ao buscar entrega' });
    }
  });

  // Despachar manualmente uma OS para Uber
  router.post('/entregas/despachar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { codigoOS } = req.body;
      if (!codigoOS) return res.status(400).json({ error: 'codigoOS obrigatório' });

      // Buscar serviço na Mapp
      const servicos = await mappListarServicos(pool, 0, codigoOS - 1);
      const servico = servicos.find(s => s.codigoOS === parseInt(codigoOS));

      if (!servico) {
        return res.status(404).json({ error: `Serviço OS ${codigoOS} não encontrado na Mapp ou não está aberto` });
      }

      const resultado = await despacharParaUber(pool, servico);

      if (!resultado) {
        return res.status(400).json({ error: 'Não foi possível despachar para Uber. Verifique logs.' });
      }

      await registrarAuditoria(req, 'DESPACHAR_UBER_MANUAL', 'admin', 'uber_entregas', resultado.id, { codigoOS });

      res.json({ success: true, entrega: resultado });
    } catch (error) {
      console.error('❌ Erro ao despachar:', error);
      res.status(500).json({ error: error.message || 'Erro ao despachar' });
    }
  });

  // Cancelar entrega manualmente
  router.post('/entregas/:id/cancelar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { motivo } = req.body;

      const { rows } = await pool.query('SELECT * FROM uber_entregas WHERE id = $1', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });

      const entrega = rows[0];

      // Cancelar no Uber
      if (entrega.uber_delivery_id) {
        await uberCancelarEntrega(pool, entrega.uber_delivery_id).catch(() => {});
      }

      // Reabrir na Mapp
      await mappAlterarStatus(pool, entrega.codigo_os, 0).catch(() => {});

      // Atualizar local
      await pool.query(`
        UPDATE uber_entregas
        SET status_uber = 'cancelado', cancelado_por = $1, cancelado_motivo = $2, updated_at = NOW()
        WHERE id = $3
      `, [req.user?.nome || 'admin', motivo || 'Cancelamento manual', id]);

      await registrarAuditoria(req, 'CANCELAR_UBER', 'admin', 'uber_entregas', id, { codigo_os: entrega.codigo_os, motivo });

      res.json({ success: true, message: 'Entrega cancelada e reaberta na Mapp' });
    } catch (error) {
      console.error('❌ Erro ao cancelar:', error);
      res.status(500).json({ error: 'Erro ao cancelar entrega' });
    }
  });

  // Consultar status atualizado no Uber (sync manual)
  router.post('/entregas/:id/sincronizar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query('SELECT * FROM uber_entregas WHERE id = $1', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });

      const entrega = rows[0];
      if (!entrega.uber_delivery_id) return res.status(400).json({ error: 'Entrega sem delivery_id Uber' });

      const dadosUber = await uberConsultarEntrega(pool, entrega.uber_delivery_id);

      await pool.query(`
        UPDATE uber_entregas SET status_uber = $1, updated_at = NOW() WHERE id = $2
      `, [dadosUber.status, id]);

      res.json({ success: true, status_uber: dadosUber.status, dados_uber: dadosUber });
    } catch (error) {
      console.error('❌ Erro ao sincronizar:', error);
      res.status(500).json({ error: 'Erro ao sincronizar' });
    }
  });

  // ─── MÉTRICAS ───────────────────────────────────────────

  router.get('/metricas', verificarToken, async (req, res) => {
    try {
      const { data_inicio, data_fim } = req.query;
      const inicio = data_inicio || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const fim = data_fim || new Date().toISOString().slice(0, 10);

      const { rows: [metricas] } = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status_uber = 'delivered') as entregues,
          COUNT(*) FILTER (WHERE status_uber = 'cancelado' OR cancelado_por IS NOT NULL) as cancelados,
          COUNT(*) FILTER (WHERE status_uber = 'fallback_fila') as fallback,
          COUNT(*) FILTER (WHERE status_uber NOT IN ('delivered', 'cancelado', 'fallback_fila') AND cancelado_por IS NULL) as em_andamento,
          COALESCE(AVG(valor_uber), 0) as valor_medio_uber,
          COALESCE(AVG(eta_minutos), 0) as eta_medio,
          COALESCE(SUM(valor_uber), 0) as custo_total_uber
        FROM uber_entregas
        WHERE created_at >= $1 AND created_at <= $2
      `, [inicio, fim + ' 23:59:59']);

      res.json({ success: true, metricas, periodo: { inicio, fim } });
    } catch (error) {
      console.error('❌ Erro nas métricas:', error);
      res.status(500).json({ error: 'Erro ao calcular métricas' });
    }
  });

  // ─── WEBHOOKS LOG ──────────────────────────────────────

  router.get('/webhooks-log', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { limit = 50 } = req.query;
      const { rows } = await pool.query(
        'SELECT * FROM uber_webhooks_log ORDER BY created_at DESC LIMIT $1',
        [parseInt(limit)]
      );
      res.json({ success: true, webhooks: rows });
    } catch (error) {
      console.error('❌ Erro ao listar webhooks:', error);
      res.status(500).json({ error: 'Erro ao listar webhooks' });
    }
  });

  return router;
}

module.exports = { createUberAdminRoutes };
