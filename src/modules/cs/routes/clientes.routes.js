/**
 * CS Sub-Router: Gestão de Clientes
 * CRUD + métricas diretas do bi_entregas
 */
const express = require('express');
const { calcularHealthScore, determinarStatusCliente, STATUS_CLIENTE } = require('../cs.service');

function createClientesRoutes(pool) {
  const router = express.Router();

  // ==================== GET /cs/clientes ====================
  router.get('/cs/clientes', async (req, res) => {
    try {
      const { status, search, ordem = 'health', direcao = 'desc', page = 1, limit = 50 } = req.query;
      const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

      // Verificar se coluna centro_custo existe
      const ccExists = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'cs_clientes' AND column_name = 'centro_custo'
      `).then(r => r.rows.length > 0).catch(() => false);

      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (status) {
        whereClause += ` AND c.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (search) {
        whereClause += ` AND (c.nome_fantasia ILIKE $${paramIndex} OR c.razao_social ILIKE $${paramIndex} OR c.cnpj ILIKE $${paramIndex} OR c.cod_cliente::text ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      // Agrupar por cod_cliente para mostrar visão única do cliente
      // Métricas vêm do bi_entregas agregando TODOS os centros de custo
      const distinctSQL = ccExists
        ? `SELECT DISTINCT ON (cod_cliente) * FROM cs_clientes ORDER BY cod_cliente, centro_custo NULLS FIRST`
        : `SELECT DISTINCT ON (cod_cliente) * FROM cs_clientes ORDER BY cod_cliente`;

      const query = `
        SELECT 
          c.*,
          COALESCE(bi.total_entregas_30d, 0) as total_entregas_30d,
          COALESCE(bi.taxa_prazo_30d, 0) as taxa_prazo_30d,
          COALESCE(bi.valor_total_30d, 0) as valor_total_30d,
          bi.ultima_entrega,
          COALESCE(bi.total_retornos_30d, 0) as total_retornos_30d,
          COALESCE(bi.taxa_retorno_30d, 0) as taxa_retorno_30d,
          COALESCE(oc.ocorrencias_abertas, 0) as ocorrencias_abertas,
          COALESCE(it.ultima_interacao, NULL) as ultima_interacao,
          COALESCE(it.total_interacoes_30d, 0) as total_interacoes_30d
          ${ccExists ? ', COALESCE(cc_count.qtd_centros, 0) as qtd_centros_custo' : ', 0 as qtd_centros_custo'}
        FROM (${distinctSQL}) c
        LEFT JOIN LATERAL (
          SELECT 
            COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas_30d,
            ROUND(
              SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1
            ) as taxa_prazo_30d,
            COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total_30d,
            MAX(data_solicitado) as ultima_entrega,
            SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
              LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR 
              LOWER(ocorrencia) LIKE '%%clienteaus%%' OR 
              LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR
              LOWER(ocorrencia) LIKE '%%loja fechada%%' OR
              LOWER(ocorrencia) LIKE '%%produto incorreto%%'
            ) THEN 1 ELSE 0 END) as total_retornos_30d,
            ROUND(
              SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
                LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR 
                LOWER(ocorrencia) LIKE '%%clienteaus%%' OR 
                LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR
                LOWER(ocorrencia) LIKE '%%loja fechada%%' OR
                LOWER(ocorrencia) LIKE '%%produto incorreto%%'
              ) THEN 1 ELSE 0 END)::numeric /
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1
            ) as taxa_retorno_30d
          FROM bi_entregas bi_e
          WHERE bi_e.cod_cliente = c.cod_cliente
            AND bi_e.data_solicitado >= CURRENT_DATE - 30
            AND COALESCE(bi_e.ponto, 1) >= 2
        ) bi ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) as ocorrencias_abertas
          FROM cs_ocorrencias 
          WHERE cod_cliente = c.cod_cliente AND status IN ('aberta', 'em_andamento')
        ) oc ON true
        LEFT JOIN LATERAL (
          SELECT 
            MAX(data_interacao) as ultima_interacao,
            COUNT(*) FILTER (WHERE data_interacao >= NOW() - INTERVAL '30 days') as total_interacoes_30d
          FROM cs_interacoes WHERE cod_cliente = c.cod_cliente
        ) it ON true
        ${ccExists ? `LEFT JOIN LATERAL (
          SELECT COUNT(DISTINCT centro_custo) as qtd_centros
          FROM bi_entregas 
          WHERE cod_cliente = c.cod_cliente AND centro_custo IS NOT NULL AND centro_custo != ''
            AND data_solicitado >= CURRENT_DATE - 90
        ) cc_count ON true` : ''}
        ${whereClause}
        ORDER BY ${ordem === 'health' ? 'c.health_score' : ordem === 'entregas' ? 'bi.total_entregas_30d' : 'c.nome_fantasia'} ${direcao === 'desc' ? 'DESC' : 'ASC'} NULLS LAST
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      params.push(parseInt(limit), offset);

      const result = await pool.query(query, params);

      const countResult = await pool.query(
        `SELECT COUNT(DISTINCT cod_cliente) as total FROM cs_clientes c ${whereClause}`,
        params.slice(0, paramIndex - 1)
      );

      res.json({
        success: true,
        clientes: result.rows,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        limit: parseInt(limit),
        statusOptions: STATUS_CLIENTE,
      });
    } catch (error) {
      console.error('❌ Erro ao listar clientes CS:', error);
      res.status(500).json({ error: 'Erro ao listar clientes' });
    }
  });

  // ==================== GET /cs/clientes-debug (temporário) ====================
  router.get('/cs/clientes-debug', async (req, res) => {
    try {
      const constraints = await pool.query(`
        SELECT con.conname, pg_get_constraintdef(con.oid) as def
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'cs_clientes'
      `);
      const indexes = await pool.query(`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'cs_clientes'
      `);
      const columns = await pool.query(`
        SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'cs_clientes' ORDER BY ordinal_position
      `);
      const sample767 = await pool.query(`SELECT id, cod_cliente, centro_custo, nome_fantasia FROM cs_clientes WHERE cod_cliente = 767`);
      const biCC767 = await pool.query(`
        SELECT DISTINCT centro_custo, COUNT(*) as qtd FROM bi_entregas 
        WHERE cod_cliente = 767 AND centro_custo IS NOT NULL AND centro_custo != ''
        GROUP BY centro_custo ORDER BY COUNT(*) DESC
      `).catch(() => ({ rows: [] }));
      const totalCs = await pool.query(`SELECT COUNT(*) as total FROM cs_clientes`);

      res.json({
        constraints: constraints.rows,
        indexes: indexes.rows,
        columns: columns.rows.map(c => c.column_name),
        cs_767: sample767.rows,
        bi_centros_custo_767: biCC767.rows,
        total_cs_clientes: totalCs.rows[0].total
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== GET /cs/clientes/:cod ====================
  router.get('/cs/clientes/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      if (!cod || isNaN(cod)) return res.status(400).json({ error: 'Código inválido' });

      // Filtro de período e centro de custo
      const { data_inicio, data_fim, centro_custo } = req.query;
      const temFiltro = data_inicio && data_fim;
      const temCC = centro_custo && centro_custo !== '';

      // Verificar se coluna centro_custo existe no cs_clientes
      const csCcExists = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'cs_clientes' AND column_name = 'centro_custo'
      `).then(r => r.rows.length > 0).catch(() => false);

      // Construir parâmetros dinâmicos para métricas
      let metricasParams = [cod];
      let filtroSQL = '';
      let paramIdx = 2;
      if (temFiltro) {
        filtroSQL += ` AND data_solicitado >= $${paramIdx} AND data_solicitado <= $${paramIdx + 1}`;
        metricasParams.push(data_inicio, data_fim);
        paramIdx += 2;
      }
      if (temCC && csCcExists) {
        filtroSQL += ` AND centro_custo = $${paramIdx}`;
        metricasParams.push(centro_custo);
        paramIdx++;
      }

      // Dados da ficha — buscar por cod_cliente + centro_custo
      let fichaResult;
      if (csCcExists && temCC) {
        fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1 AND centro_custo = $2', [cod, centro_custo]);
      } else if (csCcExists) {
        fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1 AND centro_custo IS NULL', [cod]);
      } else {
        fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1', [cod]);
      }
      
      // Fallback: se não encontrou, tentar sem filtro de CC
      if (fichaResult.rows.length === 0) {
        fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1 LIMIT 1', [cod]);
      }

      let ficha = fichaResult.rows[0];
      if (!ficha) {
        const biInfo = await pool.query(
          `SELECT DISTINCT nome_fantasia, nome_cliente, cidade, estado
           FROM bi_entregas WHERE cod_cliente = $1 LIMIT 1`, [cod]
        );
        if (biInfo.rows.length > 0) {
          const bi = biInfo.rows[0];
          const insertResult = await pool.query(
            `INSERT INTO cs_clientes (cod_cliente, nome_fantasia, razao_social, cidade, estado, status)
             VALUES ($1, LEFT($2, 255), LEFT($3, 255), LEFT($4, 100), LEFT($5, 10), 'ativo')
             ON CONFLICT (cod_cliente) DO NOTHING
             RETURNING *`,
            [cod, bi.nome_fantasia || bi.nome_cliente, bi.nome_cliente, bi.cidade, bi.estado]
          );
          ficha = insertResult.rows[0] || { cod_cliente: cod, nome_fantasia: bi.nome_fantasia, status: 'ativo' };
        } else {
          return res.status(404).json({ error: 'Cliente não encontrado no BI' });
        }
      }

      // Centros de custo do cliente (do bi_entregas)
      let centrosCusto = { rows: [] };
      try {
        centrosCusto = await pool.query(`
          SELECT centro_custo, 
            COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas
          FROM bi_entregas 
          WHERE cod_cliente = $1 AND centro_custo IS NOT NULL AND centro_custo != ''
          GROUP BY centro_custo
          ORDER BY total_entregas DESC
        `, [cod]);
        console.log(`📋 Cliente ${cod}: ${centrosCusto.rows.length} centros de custo encontrados`);
      } catch (e) { console.warn('⚠️ Centros de custo não disponível:', e.message); }

      // Métricas BI — com filtro de período se informado
      const metricasBi = await pool.query(`
        SELECT 
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          COUNT(DISTINCT os) as total_os,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
          ROUND(AVG(
            CASE 
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND data_chegada IS NOT NULL 
                   AND hora_chegada IS NOT NULL
                   AND (data_chegada + hora_chegada::time) >= data_hora
              THEN EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE WHEN DATE(data_chegada) <> DATE(data_hora)
                     THEN DATE(data_chegada) + TIME '08:00:00'
                     ELSE data_hora END
              )) / 60
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND finalizado IS NOT NULL
                   AND finalizado >= data_hora
              THEN EXTRACT(EPOCH FROM (
                finalizado - 
                CASE WHEN DATE(finalizado) <> DATE(data_hora)
                     THEN DATE(finalizado) + TIME '08:00:00'
                     ELSE data_hora END
              )) / 60
              ELSE NULL
            END
          ), 1) as tempo_medio,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 1) as km_medio,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais_unicos,
          MAX(data_solicitado) as ultima_entrega,
          MIN(data_solicitado) as primeira_entrega,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR 
            LOWER(ocorrencia) LIKE '%%clienteaus%%' OR 
            LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR
            LOWER(ocorrencia) LIKE '%%loja fechada%%' OR
            LOWER(ocorrencia) LIKE '%%produto incorreto%%'
          ) THEN 1 ELSE 0 END) as total_retornos,
          CURRENT_DATE - MAX(data_solicitado) as dias_sem_entrega
        FROM bi_entregas
        WHERE cod_cliente = $1 ${filtroSQL}
      `, metricasParams);

      // Evolução por semana (últimos 180 dias — visão mais ampla)
      const evolucaoSemanal = await pool.query(`
        SELECT 
          DATE_TRUNC('week', data_solicitado)::date as semana,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= CURRENT_DATE - 180
        GROUP BY DATE_TRUNC('week', data_solicitado)
        ORDER BY semana
      `, [cod]);

      // Últimas interações
      const interacoes = await pool.query(
        `SELECT * FROM cs_interacoes WHERE cod_cliente = $1 ORDER BY data_interacao DESC LIMIT 10`, [cod]
      );

      // Ocorrências abertas
      const ocorrencias = await pool.query(
        `SELECT * FROM cs_ocorrencias WHERE cod_cliente = $1 AND status IN ('aberta', 'em_andamento') ORDER BY data_abertura DESC`, [cod]
      );

      // Últimos raio-x
      const raioXHistorico = await pool.query(
        `SELECT id, data_inicio, data_fim, score_saude, tipo_analise, created_at FROM cs_raio_x_historico WHERE cod_cliente = $1 ORDER BY created_at DESC LIMIT 5`, [cod]
      );

      // Calcular health score atualizado
      const metricas = metricasBi.rows[0];
      const healthScore = calcularHealthScore(metricas);
      const diasSemEntrega = metricas.dias_sem_entrega != null
        ? parseInt(metricas.dias_sem_entrega)
        : (metricas.ultima_entrega
            ? Math.floor((Date.now() - new Date(metricas.ultima_entrega).getTime()) / (1000 * 60 * 60 * 24))
            : 999);
      const statusSugerido = determinarStatusCliente(healthScore, diasSemEntrega);

      // Calcular taxa de retorno
      const totalEntregas = parseInt(metricas.total_entregas) || 0;
      const totalRetornos = parseInt(metricas.total_retornos) || 0;
      const taxaRetorno = totalEntregas > 0 ? parseFloat(((totalRetornos / totalEntregas) * 100).toFixed(1)) : 0;

      // Gerar alertas automáticos
      const alertas = [];
      if (taxaRetorno > 10) alertas.push({ tipo: 'critico', icone: '🔴', msg: `Taxa de retorno crítica: ${taxaRetorno}% (${totalRetornos} retornos)` });
      else if (taxaRetorno > 5) alertas.push({ tipo: 'alto', icone: '🟠', msg: `Taxa de retorno alta: ${taxaRetorno}% (${totalRetornos} retornos)` });
      else if (taxaRetorno > 3) alertas.push({ tipo: 'moderado', icone: '🟡', msg: `Taxa de retorno elevada: ${taxaRetorno}% (${totalRetornos} retornos)` });

      if (parseFloat(metricas.taxa_prazo || 0) < 70) alertas.push({ tipo: 'critico', icone: '🔴', msg: `Taxa de prazo abaixo de 70%: ${metricas.taxa_prazo}%` });
      else if (parseFloat(metricas.taxa_prazo || 0) < 85) alertas.push({ tipo: 'moderado', icone: '🟡', msg: `Taxa de prazo abaixo da meta (85%): ${metricas.taxa_prazo}%` });

      if (diasSemEntrega > 15) alertas.push({ tipo: 'alto', icone: '🟠', msg: `${diasSemEntrega} dias sem entregas — risco de churn` });
      else if (diasSemEntrega > 7) alertas.push({ tipo: 'moderado', icone: '🟡', msg: `${diasSemEntrega} dias sem entregas` });

      // Atualizar health score no banco
      await pool.query(
        'UPDATE cs_clientes SET health_score = $1, updated_at = NOW() WHERE cod_cliente = $2',
        [healthScore, cod]
      ).catch(() => {});

      // Enriquecer métricas com taxa calculada
      metricas.taxa_retorno = taxaRetorno;

      res.json({
        success: true,
        ficha: { ...ficha, health_score: healthScore },
        metricas_bi: metricas,
        centros_custo: centrosCusto.rows,
        periodo_filtrado: temFiltro ? { inicio: data_inicio, fim: data_fim } : null,
        evolucao_semanal: evolucaoSemanal.rows,
        interacoes: interacoes.rows,
        ocorrencias: ocorrencias.rows,
        raio_x_historico: raioXHistorico.rows,
        diagnostico: {
          health_score: healthScore,
          status_sugerido: statusSugerido,
          dias_sem_entrega: diasSemEntrega,
          taxa_retorno: taxaRetorno,
          alertas,
        },
      });
    } catch (error) {
      console.error('❌ Erro ao buscar detalhes CS:', error);
      res.status(500).json({ error: 'Erro ao buscar detalhes do cliente' });
    }
  });

  // ==================== PUT /cs/clientes/:cod ====================
  router.put('/cs/clientes/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      const {
        razao_social, cnpj, telefone, email, endereco, cidade, estado,
        responsavel_nome, responsavel_telefone, responsavel_email,
        segmento, porte, data_inicio_parceria, observacoes, tags, status,
      } = req.body;

      const result = await pool.query(`
        UPDATE cs_clientes SET
          razao_social = COALESCE($1, razao_social),
          cnpj = COALESCE($2, cnpj),
          telefone = COALESCE($3, telefone),
          email = COALESCE($4, email),
          endereco = COALESCE($5, endereco),
          cidade = COALESCE($6, cidade),
          estado = COALESCE($7, estado),
          responsavel_nome = COALESCE($8, responsavel_nome),
          responsavel_telefone = COALESCE($9, responsavel_telefone),
          responsavel_email = COALESCE($10, responsavel_email),
          segmento = COALESCE($11, segmento),
          porte = COALESCE($12, porte),
          data_inicio_parceria = COALESCE($13, data_inicio_parceria),
          observacoes = COALESCE($14, observacoes),
          tags = COALESCE($15, tags),
          status = COALESCE($16, status),
          updated_by = $17,
          updated_at = NOW()
        WHERE cod_cliente = $18
        RETURNING *
      `, [
        razao_social, cnpj, telefone, email, endereco, cidade, estado,
        responsavel_nome, responsavel_telefone, responsavel_email,
        segmento, porte, data_inicio_parceria, observacoes,
        tags ? JSON.stringify(tags) : null, status,
        req.user?.codProfissional, cod,
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
      }

      res.json({ success: true, cliente: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao atualizar cliente CS:', error);
      res.status(500).json({ error: 'Erro ao atualizar cliente' });
    }
  });

  // ==================== POST /cs/clientes/sync-bi ====================
  router.post('/cs/clientes/sync-bi', async (req, res) => {
    try {
      const logs = [];

      // Verificar se coluna centro_custo existe
      const csCcExists = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'cs_clientes' AND column_name = 'centro_custo'
      `).then(r => r.rows.length > 0).catch(() => false);

      // Passo 1: Limpar linhas duplicadas (de syncs anteriores que criaram 1 linha por CC)
      if (csCcExists) {
        const dupes = await pool.query(`
          SELECT cod_cliente, COUNT(*) as qtd FROM cs_clientes 
          GROUP BY cod_cliente HAVING COUNT(*) > 1
        `);
        if (dupes.rows.length > 0) {
          for (const dup of dupes.rows) {
            const principal = await pool.query(`
              SELECT id FROM cs_clientes WHERE cod_cliente = $1 
              ORDER BY centro_custo NULLS FIRST, id ASC LIMIT 1
            `, [dup.cod_cliente]);
            if (principal.rows.length > 0) {
              await pool.query(`DELETE FROM cs_clientes WHERE cod_cliente = $1 AND id != $2`, [dup.cod_cliente, principal.rows[0].id]);
            }
          }
          await pool.query(`UPDATE cs_clientes SET centro_custo = NULL WHERE centro_custo IS NOT NULL`).catch(() => {});
          logs.push(`Limpou ${dupes.rows.length} clientes com linhas duplicadas`);
        }
      }

      // Passo 2: Inserir clientes novos (1 linha por cod_cliente, sem CC)
      const insertResult = await pool.query(`
        INSERT INTO cs_clientes (cod_cliente, ${csCcExists ? 'centro_custo, ' : ''}nome_fantasia, cidade, estado, status)
        SELECT 
          e.cod_cliente, ${csCcExists ? 'NULL, ' : ''}
          LEFT(MAX(e.nome_fantasia), 255),
          LEFT(MAX(e.cidade), 100),
          LEFT(MAX(e.estado), 10),
          'ativo'
        FROM bi_entregas e
        WHERE e.cod_cliente IS NOT NULL AND e.data_solicitado >= CURRENT_DATE - 90
        GROUP BY e.cod_cliente
        ON CONFLICT DO NOTHING
        RETURNING cod_cliente
      `).catch(e => { logs.push('Insert: ' + e.message); return { rows: [] }; });
      logs.push(`Inseridos ${insertResult.rows.length} clientes novos`);

      const totalResult = await pool.query('SELECT COUNT(*) as total FROM cs_clientes');
      const total = parseInt(totalResult.rows[0].total);

      console.log(`📥 CS Sync: ${total} registros. Logs:`, logs.join(' | '));
      res.json({ success: true, importados: total, logs });
    } catch (error) {
      console.error('❌ Erro ao sincronizar clientes do BI:', error);
      res.status(500).json({ error: 'Erro ao sincronizar: ' + error.message });
    }
  });

  return router;
}

module.exports = { createClientesRoutes };
