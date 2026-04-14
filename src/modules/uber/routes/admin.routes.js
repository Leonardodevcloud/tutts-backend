/**
 * Sub-Router: Uber Admin
 * CRUD config, dashboard, controle manual de entregas, métricas
 */
const express = require('express');
const {
  obterConfig, despacharParaUber, mappListarServicos,
  mappAlterarStatus, uberCancelarEntrega, uberConsultarEntrega,
  mappInformarChegada, mappFinalizarEndereco, mappFinalizarServico,
  cancelarERedespacharEntrega, cotarParaUber, pegarCotacaoCache,
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
        telefone_suporte, manifest_total_value_centavos,
        sandbox_mode, worker_janela_minutos,
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
      addCampo('telefone_suporte', telefone_suporte);
      addCampo('manifest_total_value_centavos', manifest_total_value_centavos);
      addCampo('sandbox_mode', sandbox_mode);
      addCampo('worker_janela_minutos', worker_janela_minutos);

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

  // Testar conexão com Mapp — agora também retorna amostra dos serviços abertos
  // pra facilitar descoberta dos campos reais que a Mapp retorna.
  router.post('/config/testar-mapp', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const servicos = await mappListarServicos(pool, 0, 0);

      // Monta amostra enxuta com os campos que podem servir pra identificar o cliente
      const amostra = servicos.slice(0, 20).map(s => ({
        codigoOS: s.codigoOS,
        dataHora: s.dataHora,
        valorServico: s.valorServico,
        // Tenta pegar vários campos candidatos pra identificação de cliente
        coleta_nome: s.endereco?.[0]?.nome || null,
        coleta_rua:  s.endereco?.[0]?.rua  || null,
        coleta_bairro: s.endereco?.[0]?.bairro || null,
        coleta_cidade: s.endereco?.[0]?.cidade || null,
        entrega_nome: s.endereco?.[1]?.nome || null,
        entrega_rua:  s.endereco?.[1]?.rua  || null,
        // Campos top-level que podem conter cliente
        obs: s.obs,
        // Força listagem de TODAS as chaves presentes no serviço pra debug
        _todas_chaves: Object.keys(s),
      }));

      res.json({
        success: true,
        message: `Conexão OK! ${servicos.length} serviço(s) aberto(s) encontrado(s)`,
        total: servicos.length,
        amostra,
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // 🔬 DEBUG: Retorna o JSON CRU da Mapp (primeiro serviço aberto) sem processar nada.
  // Uso: pra descobrir quais campos a Mapp realmente devolve além dos documentados.
  router.get('/debug/mapp-raw', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const servicos = await mappListarServicos(pool, 0, 0);

      if (!servicos || servicos.length === 0) {
        return res.json({
          success: true,
          message: 'Nenhum serviço aberto na Mapp agora',
          total: 0,
          primeiro: null,
        });
      }

      // Retorna o primeiro serviço INTEIRO, sem tocar em nada
      res.json({
        success: true,
        total: servicos.length,
        primeiro: servicos[0],
        todas_chaves_primeiro: Object.keys(servicos[0]),
        endereco_0_chaves: servicos[0].endereco?.[0] ? Object.keys(servicos[0].endereco[0]) : null,
        endereco_1_chaves: servicos[0].endereco?.[1] ? Object.keys(servicos[0].endereco[1]) : null,
      });
    } catch (error) {
      console.error('❌ [Debug Mapp] Erro:', error);
      res.status(500).json({ success: false, error: error.message });
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
      const {
        cliente_nome, trecho_endereco, cliente_identificador, usar_uber, prioridade,
        horario_inicio, horario_fim, valor_minimo, valor_maximo,
        regioes_permitidas, ativo,
        margem_minima_aceita, margem_pct_minima,
      } = req.body;

      if (!cliente_nome || !cliente_nome.trim()) {
        return res.status(400).json({ error: 'Nome do cliente é obrigatório' });
      }
      if (!trecho_endereco || trecho_endereco.trim().length < 5) {
        return res.status(400).json({ error: 'Trecho do endereço deve ter pelo menos 5 caracteres' });
      }

      // Normaliza regioes_permitidas: aceita array ou string CSV, salva sempre como array lowercase
      let regioesArray = null;
      if (Array.isArray(regioes_permitidas)) {
        regioesArray = regioes_permitidas.map(r => String(r).trim().toLowerCase()).filter(Boolean);
      } else if (typeof regioes_permitidas === 'string' && regioes_permitidas.trim()) {
        regioesArray = regioes_permitidas.split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
      }

      // Margens: aceita number ou string vazia/null
      const margemAbs = (margem_minima_aceita === '' || margem_minima_aceita == null)
        ? null : parseFloat(margem_minima_aceita);
      const margemPct = (margem_pct_minima === '' || margem_pct_minima == null)
        ? null : parseFloat(margem_pct_minima);

      const { rows: [regra] } = await pool.query(`
        INSERT INTO uber_regras_cliente (
          cliente_nome, trecho_endereco, cliente_identificador, usar_uber, prioridade,
          horario_inicio, horario_fim, valor_minimo, valor_maximo,
          regioes_permitidas, ativo,
          margem_minima_aceita, margem_pct_minima
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `, [
        cliente_nome.trim(), trecho_endereco.trim().toLowerCase(),
        cliente_identificador || null, usar_uber ?? true,
        prioridade || 'uber_primeiro', horario_inicio || null, horario_fim || null,
        valor_minimo || null, valor_maximo || null,
        regioesArray, ativo ?? true,
        margemAbs, margemPct,
      ]);

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
      const {
        cliente_nome, trecho_endereco, cliente_identificador, usar_uber, prioridade,
        horario_inicio, horario_fim, valor_minimo, valor_maximo,
        regioes_permitidas, ativo,
        margem_minima_aceita, margem_pct_minima,
      } = req.body;

      // Validações apenas se os campos foram enviados
      if (trecho_endereco !== undefined && (!trecho_endereco || trecho_endereco.trim().length < 5)) {
        return res.status(400).json({ error: 'Trecho do endereço deve ter pelo menos 5 caracteres' });
      }

      // Normaliza regioes_permitidas como no POST
      let regioesArray;
      if (regioes_permitidas === undefined) {
        regioesArray = undefined;  // não atualiza
      } else if (Array.isArray(regioes_permitidas)) {
        regioesArray = regioes_permitidas.map(r => String(r).trim().toLowerCase()).filter(Boolean);
      } else if (typeof regioes_permitidas === 'string') {
        regioesArray = regioes_permitidas.split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
      } else {
        regioesArray = null;
      }

      // Margens: undefined = não atualiza, '' ou null = limpa, número = atualiza
      const margemAbsParsed = margem_minima_aceita === undefined
        ? undefined
        : (margem_minima_aceita === '' || margem_minima_aceita == null ? null : parseFloat(margem_minima_aceita));
      const margemPctParsed = margem_pct_minima === undefined
        ? undefined
        : (margem_pct_minima === '' || margem_pct_minima == null ? null : parseFloat(margem_pct_minima));

      const { rows: [regra] } = await pool.query(`
        UPDATE uber_regras_cliente SET
          cliente_nome = COALESCE($1, cliente_nome),
          trecho_endereco = COALESCE($2, trecho_endereco),
          cliente_identificador = COALESCE($3, cliente_identificador),
          usar_uber = COALESCE($4, usar_uber),
          prioridade = COALESCE($5, prioridade),
          horario_inicio = $6,
          horario_fim = $7,
          valor_minimo = $8,
          valor_maximo = $9,
          regioes_permitidas = COALESCE($10::text[], regioes_permitidas),
          ativo = COALESCE($11, ativo),
          margem_minima_aceita = CASE WHEN $13::boolean THEN $12 ELSE margem_minima_aceita END,
          margem_pct_minima = CASE WHEN $15::boolean THEN $14 ELSE margem_pct_minima END,
          updated_at = NOW()
        WHERE id = $16 RETURNING *
      `, [
        cliente_nome ? cliente_nome.trim() : null,
        trecho_endereco ? trecho_endereco.trim().toLowerCase() : null,
        cliente_identificador, usar_uber, prioridade,
        horario_inicio, horario_fim, valor_minimo, valor_maximo,
        regioesArray, ativo,
        margemAbsParsed === undefined ? null : margemAbsParsed,
        margemAbsParsed !== undefined,
        margemPctParsed === undefined ? null : margemPctParsed,
        margemPctParsed !== undefined,
        id,
      ]);

      if (!regra) return res.status(404).json({ error: 'Regra não encontrada' });

      await registrarAuditoria(req, 'ATUALIZAR_REGRA_UBER', 'config', 'uber_regras_cliente', regra.id, { cliente_nome: regra.cliente_nome });

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
          r.cliente_nome AS cliente_nome_regra,
          (SELECT COUNT(*) FROM uber_tracking t WHERE t.codigo_os = e.codigo_os) as total_tracking
        FROM uber_entregas e
        LEFT JOIN uber_regras_cliente r ON r.id = e.regra_id
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

  // 💰 Cotar OS na Uber (sem criar delivery) — usado pelo modal de pré-cotação manual
  // Body: { codigoOS }
  // Retorna: { quote_id, valor_uber, valor_cliente, valor_profissional, margem,
  //           margem_pct, eta_minutos, expires_at, endereco_coleta, endereco_entrega }
  router.post('/entregas/cotar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { codigoOS } = req.body;
      if (!codigoOS) return res.status(400).json({ error: 'codigoOS obrigatório' });

      const r = await cotarParaUber(pool, parseInt(codigoOS));

      res.json({
        success: true,
        quote_id: r.cotacao.quote_id,
        valor_uber: r.valor_uber,
        valor_cliente: r.valor_cliente,
        valor_profissional: r.valor_profissional,
        margem: r.margem,
        margem_pct: r.margem_pct,
        eta_minutos: r.eta_minutos,
        expires_at: r.expires_at,
        endereco_coleta: r.coleta?.rua || null,
        endereco_entrega: r.entrega?.rua || null,
      });
    } catch (error) {
      console.error('❌ Erro ao cotar:', error);
      res.status(400).json({ error: error.message || 'Erro ao cotar entrega' });
    }
  });

  // Despachar manualmente uma OS para Uber.
  // Aceita opcionalmente quote_id pré-cotado pelo modal de cotação — nesse caso
  // não cota de novo, reusa a quote já no cache em memória do service.
  // Body: { codigoOS, quote_id? }
  router.post('/entregas/despachar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { codigoOS, quote_id } = req.body;
      if (!codigoOS) return res.status(400).json({ error: 'codigoOS obrigatório' });

      // Se veio quote_id, tenta reusar a cotação cacheada
      let servicoUsado = null;
      let quotePreCotada = null;
      if (quote_id) {
        const cache = pegarCotacaoCache(codigoOS, quote_id);
        if (!cache) {
          return res.status(410).json({ error: 'Cotação expirada ou inválida — cote novamente' });
        }
        servicoUsado = cache.servico;
        quotePreCotada = cache.cotacao;
      } else {
        // Fluxo antigo (sem cotação prévia): busca serviço na Mapp
        const servicos = await mappListarServicos(pool, 0, parseInt(codigoOS) - 1);
        servicoUsado = servicos.find(s => s.codigoOS === parseInt(codigoOS));
        if (!servicoUsado) {
          return res.status(404).json({ error: `Serviço OS ${codigoOS} não encontrado na Mapp ou não está aberto` });
        }
      }

      const resultado = await despacharParaUber(pool, servicoUsado, { quotePreCotada });

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

  // 🔄 Cancelar a entrega ATUAL e redespachar no Uber com novo endereço de entrega.
  // Usado quando o operador percebe que o endereço de entrega estava errado
  // depois que a delivery já foi criada na Uber.
  // Body: { novo_endereco: "string", nome_destinatario?, telefone_destinatario?, complemento? }
  router.post('/entregas/:id/redespachar', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { novo_endereco, nome_destinatario, telefone_destinatario, complemento } = req.body;

      if (!novo_endereco || novo_endereco.trim().length < 8) {
        return res.status(400).json({ error: 'Novo endereço de entrega obrigatório (mínimo 8 caracteres)' });
      }

      const resultado = await cancelarERedespacharEntrega(pool, parseInt(id), novo_endereco.trim(), {
        nome_destinatario,
        telefone_destinatario,
        complemento,
      });

      await registrarAuditoria(
        req, 'REDESPACHAR_UBER', 'admin', 'uber_entregas', id,
        { entrega_nova_id: resultado.entrega_nova_id, novo_endereco }
      );

      res.json({
        success: true,
        message: 'Entrega cancelada e redespachada com sucesso',
        ...resultado,
      });
    } catch (error) {
      console.error('❌ Erro ao redespachar:', error);
      res.status(500).json({ error: error.message || 'Erro ao redespachar entrega' });
    }
  });

  // 📊 Dashboard de margem por cliente / período
  // Query params: periodo=1d|7d|30d|custom, inicio=YYYY-MM-DD, fim=YYYY-MM-DD
  router.get('/dashboard/margem-clientes', verificarToken, async (req, res) => {
    try {
      const { periodo = '7d', inicio, fim } = req.query;

      // Calcula janela de datas
      let dataInicio;
      const dataFim = fim ? new Date(fim + ' 23:59:59') : new Date();
      if (periodo === '1d') {
        dataInicio = new Date(); dataInicio.setHours(0, 0, 0, 0);
      } else if (periodo === '7d') {
        dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate() - 7);
      } else if (periodo === '30d') {
        dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate() - 30);
      } else if (periodo === 'custom' && inicio) {
        dataInicio = new Date(inicio + ' 00:00:00');
      } else {
        dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate() - 7);
      }

      // Agregação por cliente: usa LEFT JOIN com regras pra trazer cliente_nome.
      // Despachos manuais (regra_id NULL) caem no bucket "Manual / sem regra".
      const { rows: porCliente } = await pool.query(`
        SELECT
          COALESCE(r.cliente_nome, 'Manual / sem regra') AS cliente,
          e.regra_id,
          COUNT(*) AS qtd,
          COUNT(*) FILTER (WHERE e.status_uber IN ('cancelado', 'canceled')) AS cancelados,
          COALESCE(SUM(e.valor_servico), 0)::numeric AS receita_total,
          COALESCE(SUM(e.valor_uber), 0)::numeric AS custo_uber_total,
          COALESCE(SUM(e.valor_servico - e.valor_uber), 0)::numeric AS margem_total,
          COALESCE(AVG(e.valor_servico - e.valor_uber), 0)::numeric AS margem_media
        FROM uber_entregas e
        LEFT JOIN uber_regras_cliente r ON r.id = e.regra_id
        WHERE e.created_at BETWEEN $1 AND $2
          AND e.valor_uber IS NOT NULL
        GROUP BY r.cliente_nome, e.regra_id
        ORDER BY margem_total DESC
      `, [dataInicio, dataFim]);

      // Margem por dia (pra gráfico)
      const { rows: porDia } = await pool.query(`
        SELECT
          DATE(e.created_at) AS dia,
          COUNT(*) AS qtd,
          COALESCE(SUM(e.valor_servico - e.valor_uber), 0)::numeric AS margem
        FROM uber_entregas e
        WHERE e.created_at BETWEEN $1 AND $2
          AND e.valor_uber IS NOT NULL
        GROUP BY DATE(e.created_at)
        ORDER BY dia ASC
      `, [dataInicio, dataFim]);

      // Totais gerais
      const { rows: [totais] } = await pool.query(`
        SELECT
          COUNT(*)::int AS qtd_total,
          COALESCE(SUM(valor_servico), 0)::numeric AS receita,
          COALESCE(SUM(valor_uber), 0)::numeric AS custo,
          COALESCE(SUM(valor_servico - valor_uber), 0)::numeric AS margem
        FROM uber_entregas
        WHERE created_at BETWEEN $1 AND $2
          AND valor_uber IS NOT NULL
      `, [dataInicio, dataFim]);

      res.json({
        success: true,
        periodo: { tipo: periodo, inicio: dataInicio, fim: dataFim },
        totais,
        por_cliente: porCliente.map(r => ({
          ...r,
          margem_pct: r.receita_total > 0
            ? (parseFloat(r.margem_total) / parseFloat(r.receita_total)) * 100
            : 0,
          taxa_cancelamento: r.qtd > 0
            ? (parseFloat(r.cancelados) / parseFloat(r.qtd)) * 100
            : 0,
        })),
        por_dia: porDia,
      });
    } catch (error) {
      console.error('❌ Erro dashboard margem:', error);
      res.status(500).json({ error: 'Erro ao buscar dashboard de margem' });
    }
  });

  /**
   * POST /entregas/:id/finalizar-manual
   * Finaliza uma entrega manualmente: chama informarChegada + finalizarEndereco
   * para todos os pontos e finalizarServico no fim. Útil quando os webhooks
   * do Uber não chegam (sandbox, debug, ou problema de assinatura).
   */
  router.post('/entregas/:id/finalizar-manual', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query('SELECT * FROM uber_entregas WHERE id = $1', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Entrega não encontrada' });

      const entrega = rows[0];
      const codigoOS = entrega.codigo_os;
      const passos = [];

      console.log(`🛠️ [Uber] Finalização MANUAL iniciada — OS=${codigoOS}, entrega.id=${id}`);

      // Determinar quantos pontos a OS tem (baseado nos endereços salvos)
      let pontos = [];
      try {
        pontos = entrega.pontos ? JSON.parse(entrega.pontos) : [];
      } catch (e) {
        pontos = [];
      }
      const totalPontos = Math.max(pontos.length, 2); // pelo menos coleta + entrega

      // 1. informarChegada + finalizarEndereco para cada ponto
      for (let i = 1; i <= totalPontos; i++) {
        const ponto = pontos[i - 1] || {};
        const lat = ponto.latitude || null;
        const lng = ponto.longitude || null;

        try {
          const r1 = await mappInformarChegada(pool, codigoOS, i, lat, lng);
          passos.push({ acao: `informarChegada ponto ${i}`, ok: true, msg: r1?.msgUsuario });
        } catch (e) {
          passos.push({ acao: `informarChegada ponto ${i}`, ok: false, erro: e.message });
        }

        try {
          const r2 = await mappFinalizarEndereco(pool, codigoOS, i, lat, lng);
          passos.push({ acao: `finalizarEndereco ponto ${i}`, ok: true, msg: r2?.msgUsuario });
        } catch (e) {
          passos.push({ acao: `finalizarEndereco ponto ${i}`, ok: false, erro: e.message });
        }
      }

      // 2. finalizarServico
      try {
        const r3 = await mappFinalizarServico(pool, codigoOS);
        passos.push({ acao: 'finalizarServico', ok: true, msg: r3?.msgUsuario });
      } catch (e) {
        passos.push({ acao: 'finalizarServico', ok: false, erro: e.message });
      }

      // 3. Atualizar status local pra delivered
      await pool.query(`
        UPDATE uber_entregas
        SET status_uber = 'delivered', updated_at = NOW()
        WHERE id = $1
      `, [id]);

      await registrarAuditoria(req, 'FINALIZAR_MANUAL_UBER', 'admin', 'uber_entregas', id, {
        codigo_os: codigoOS, total_pontos: totalPontos, passos
      });

      console.log(`✅ [Uber] Finalização MANUAL concluída — OS=${codigoOS}`);

      res.json({
        success: true,
        message: `Entrega OS ${codigoOS} finalizada manualmente em ${totalPontos} ponto(s)`,
        passos,
      });
    } catch (error) {
      console.error('❌ Erro ao finalizar manual:', error);
      res.status(500).json({ error: error.message || 'Erro ao finalizar manualmente' });
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
