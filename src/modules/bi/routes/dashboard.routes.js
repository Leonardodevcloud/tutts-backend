/**
 * BI Sub-Router: Dashboards e Métricas
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createDashboardRoutes(pool) {
  const router = express.Router();

router.get('/bi/dashboard-rapido', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Usar resumo diário para métricas gerais
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      whereClause += ` AND data >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    
    // Se tem filtro de cliente, usar bi_resumo_cliente
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        // Buscar métricas por cliente
        const clienteQuery = await pool.query(`
          SELECT 
            SUM(total_os) as total_os,
            SUM(total_entregas) as total_entregas,
            SUM(entregas_no_prazo) as entregas_no_prazo,
            SUM(entregas_fora_prazo) as entregas_fora_prazo,
            ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 2) as taxa_prazo,
            SUM(total_retornos) as total_retornos,
            SUM(valor_total) as valor_total,
            SUM(valor_prof) as valor_prof,
            ROUND(SUM(valor_total)::numeric / NULLIF(SUM(total_entregas), 0), 2) as ticket_medio,
            ROUND(AVG(tempo_medio_entrega), 2) as tempo_medio_entrega,
            SUM(total_profissionais) as total_profissionais
          FROM bi_resumo_cliente
          ${whereClause} AND cod_cliente = ANY($${paramIndex}::int[])
        `, [...params, clientes]);
        
        return res.json({
          metricas: clienteQuery.rows[0] || {},
          fonte: 'resumo_cliente'
        });
      }
    }
    
    // Sem filtro de cliente, usar resumo diário
    const diarioQuery = await pool.query(`
      SELECT 
        SUM(total_os) as total_os,
        SUM(total_entregas) as total_entregas,
        SUM(entregas_no_prazo) as entregas_no_prazo,
        SUM(entregas_fora_prazo) as entregas_fora_prazo,
        ROUND(SUM(entregas_no_prazo)::numeric / NULLIF(SUM(total_entregas), 0) * 100, 2) as taxa_prazo,
        SUM(total_retornos) as total_retornos,
        SUM(valor_total) as valor_total,
        SUM(valor_prof) as valor_prof,
        ROUND(SUM(valor_total)::numeric / NULLIF(SUM(total_entregas), 0), 2) as ticket_medio,
        ROUND(AVG(tempo_medio_entrega), 2) as tempo_medio_entrega,
        ROUND(AVG(tempo_medio_alocacao), 2) as tempo_medio_alocacao,
        ROUND(AVG(tempo_medio_coleta), 2) as tempo_medio_coleta,
        SUM(total_profissionais) as total_profissionais,
        ROUND(AVG(media_ent_profissional), 2) as media_ent_profissional,
        SUM(km_total) as km_total
      FROM bi_resumo_diario
      ${whereClause}
    `, params);
    
    res.json({
      metricas: diarioQuery.rows[0] || {},
      fonte: 'resumo_diario'
    });
  } catch (err) {
    console.error('❌ Erro dashboard rápido:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// ============================================
// RELATÓRIO IA COM GEMINI
// ============================================
router.get('/bi/dashboard', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, status_retorno, cidade } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (data_inicio) {
      where += ` AND data_solicitado >= $${paramIndex++}`;
      params.push(data_inicio);
    }
    if (data_fim) {
      where += ` AND data_solicitado <= $${paramIndex++}`;
      params.push(data_fim);
    }
    if (cod_cliente) {
      where += ` AND cod_cliente = $${paramIndex++}`;
      params.push(cod_cliente);
    }
    if (centro_custo) {
      where += ` AND centro_custo = $${paramIndex++}`;
      params.push(centro_custo);
    }
    if (cod_prof) {
      where += ` AND cod_prof = $${paramIndex++}`;
      params.push(cod_prof);
    }
    if (categoria) {
      where += ` AND categoria ILIKE $${paramIndex++}`;
      params.push(`%${categoria}%`);
    }
    if (status_prazo === 'dentro') {
      where += ` AND dentro_prazo = true`;
    } else if (status_prazo === 'fora') {
      where += ` AND dentro_prazo = false`;
    }
    // Filtro de prazo profissional
    const status_prazo_prof = req.query.status_prazo_prof;
    if (status_prazo_prof === 'dentro') {
      where += ` AND dentro_prazo_prof = true`;
    } else if (status_prazo_prof === 'fora') {
      where += ` AND dentro_prazo_prof = false`;
    }
    if (cidade) {
      where += ` AND cidade = $${paramIndex++}`;
      params.push(cidade);
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Métricas gerais completas
    const metricas = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo IS NULL) as sem_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_dentro,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2) as taxa_fora,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = true) as dentro_prazo_prof,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = false) as fora_prazo_prof,
        COUNT(*) FILTER (WHERE dentro_prazo_prof IS NULL) as sem_prazo_prof,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo_prof = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo_prof IS NOT NULL), 0), 2) as taxa_dentro_prof,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo_prof = false) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo_prof IS NOT NULL), 0), 2) as taxa_fora_prof,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 2) as tempo_medio,
        ROUND(AVG(tempo_execucao_prof_minutos)::numeric, 2) as tempo_medio_prof,
        ROUND(AVG(distancia)::numeric, 2) as distancia_media,
        ROUND(SUM(distancia)::numeric, 2) as distancia_total,
        ROUND(SUM(valor)::numeric, 2) as valor_total,
        ROUND(SUM(valor_prof)::numeric, 2) as valor_profissional,
        ROUND(SUM(valor)::numeric - COALESCE(SUM(valor_prof)::numeric, 0), 2) as faturamento,
        ROUND(AVG(valor)::numeric, 2) as ticket_medio,
        COUNT(DISTINCT cod_prof) as total_entregadores,
        COUNT(DISTINCT cod_cliente) as total_clientes,
        ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT cod_prof), 0), 2) as media_entregas_entregador,
        COUNT(*) FILTER (WHERE ocorrencia = 'Retorno') as retornos
      FROM bi_entregas ${where}
    `, params);
    
    // Entregas por dia
    const porDia = await pool.query(`
      SELECT 
        data_solicitado as data,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo
      FROM bi_entregas ${where}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // Por centro de custo
    const porCentro = await pool.query(`
      SELECT 
        centro_custo,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo
      FROM bi_entregas ${where}
      GROUP BY centro_custo
      ORDER BY total DESC
      LIMIT 20
    `, params);
    
    // Ranking profissionais
    const ranking = await pool.query(`
      SELECT 
        cod_prof,
        nome_prof,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo,
        ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) as taxa_prazo,
        ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio
      FROM bi_entregas ${where}
      GROUP BY cod_prof, nome_prof
      ORDER BY total DESC
      LIMIT 20
    `, params);
    
    // Por categoria
    const porCategoria = await pool.query(`
      SELECT 
        categoria,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo
      FROM bi_entregas ${where}
      GROUP BY categoria
      ORDER BY total DESC
    `, params);
    
    res.json({
      metricas: metricas.rows[0],
      porDia: porDia.rows,
      porCentro: porCentro.rows,
      ranking: ranking.rows,
      porCategoria: porCategoria.rows
    });
  } catch (err) {
    console.error('❌ Erro no dashboard:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// Dashboard BI COMPLETO - Retorna todas as métricas de uma vez
// Dashboard BI COMPLETO - Retorna todas as métricas de uma vez
router.get('/bi/dashboard-completo', async (req, res) => {
  try {
    let { data_inicio, data_fim, cod_prof, categoria, status_prazo, status_prazo_prof, status_retorno, cidade, clientes_sem_filtro_cc } = req.query;
    // Suporte a múltiplos clientes e centros de custo
    let cod_cliente = req.query.cod_cliente;
    let centro_custo = req.query.centro_custo;
    
    // Converter para array se necessário
    if (cod_cliente && !Array.isArray(cod_cliente)) cod_cliente = [cod_cliente];
    if (centro_custo && !Array.isArray(centro_custo)) centro_custo = [centro_custo];
    
    // Clientes que não devem ter filtro de centro de custo (mostrar todos CC)
    let clientesSemFiltroCC = [];
    if (clientes_sem_filtro_cc) {
      clientesSemFiltroCC = clientes_sem_filtro_cc.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }
    
    console.log('📊 Dashboard-completo:', { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, status_retorno, clientesSemFiltroCC });
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // Converter datas ISO para YYYY-MM-DD
    if (data_inicio) { 
      const dataIni = data_inicio.includes('T') ? data_inicio.split('T')[0] : data_inicio;
      where += ` AND data_solicitado >= $${paramIndex++}`; 
      params.push(dataIni); 
    }
    if (data_fim) { 
      const dataFim = data_fim.includes('T') ? data_fim.split('T')[0] : data_fim;
      where += ` AND data_solicitado <= $${paramIndex++}`; 
      params.push(dataFim); 
    }
    // Múltiplos clientes
    if (cod_cliente && cod_cliente.length > 0) { 
      where += ` AND cod_cliente = ANY($${paramIndex++}::int[])`; 
      params.push(cod_cliente.map(c => parseInt(c))); 
    }
    // Múltiplos centros de custo - COM exceção para clientes sem filtro
    if (centro_custo && centro_custo.length > 0) {
      if (clientesSemFiltroCC.length > 0) {
        // Filtrar por CC OU ser um cliente sem filtro de CC
        where += ` AND (centro_custo = ANY($${paramIndex++}::text[]) OR cod_cliente = ANY($${paramIndex++}::int[]))`;
        params.push(centro_custo);
        params.push(clientesSemFiltroCC);
      } else {
        where += ` AND centro_custo = ANY($${paramIndex++}::text[])`; 
        params.push(centro_custo); 
      }
    }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    // Filtro de prazo profissional
    if (status_prazo_prof === 'dentro') { where += ` AND dentro_prazo_prof = true`; }
    else if (status_prazo_prof === 'fora') { where += ` AND dentro_prazo_prof = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      where += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      where += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    console.log('📊 WHERE:', where, 'Params:', params);
    
    // Buscar regras de contagem
    const regrasContagem = await pool.query('SELECT cod_cliente FROM bi_regras_contagem');
    const clientesComRegra = new Set(regrasContagem.rows.map(r => String(r.cod_cliente)));
    console.log('📊 Clientes COM regra de contagem:', [...clientesComRegra]);
    console.log('📊 Total de clientes com regra:', clientesComRegra.size);
    
    // Buscar máscaras
    const mascaras = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    const mapMascaras = {};
    mascaras.rows.forEach(m => { mapMascaras[String(m.cod_cliente)] = m.mascara; });
    
    // ============================================
    // BUSCAR CONFIGURAÇÕES DE PRAZO PROFISSIONAL
    // ============================================
    let prazosProfCliente = [];
    let prazoProfPadrao = [];
    try {
      const prazosProfQuery = await pool.query(`
        SELECT pc.tipo, pc.codigo, fp.km_min, fp.km_max, fp.prazo_minutos
        FROM bi_prazos_prof_cliente pc
        JOIN bi_faixas_prazo_prof fp ON pc.id = fp.prazo_prof_cliente_id
      `);
      prazosProfCliente = prazosProfQuery.rows;
      
      const prazoProfPadraoQuery = await pool.query(`SELECT * FROM bi_prazo_prof_padrao ORDER BY km_min`);
      prazoProfPadrao = prazoProfPadraoQuery.rows;
      
      console.log('📊 Prazos Prof carregados:', { 
        especificos: prazosProfCliente.length, 
        padrao: prazoProfPadrao.length,
        faixasPadrao: prazoProfPadrao.map(f => `${f.km_min}-${f.km_max || '∞'}km=${f.prazo_minutos}min`).join(', ')
      });
    } catch (err) {
      console.log('⚠️ Tabelas de prazo profissional não encontradas, usando fallback hardcoded');
    }
    
    // Função para encontrar prazo profissional baseado no cliente/centro e distância
    const encontrarPrazoProfissional = (codCliente, centroCusto, distancia) => {
      // 1. Primeiro busca configuração específica por cliente
      let faixas = prazosProfCliente.filter(p => p.tipo === 'cliente' && p.codigo === String(codCliente));
      
      // 2. Se não achou, busca por centro de custo
      if (faixas.length === 0 && centroCusto) {
        faixas = prazosProfCliente.filter(p => p.tipo === 'centro_custo' && p.codigo === centroCusto);
      }
      
      // 3. Se tem configuração específica, usa ela
      if (faixas.length > 0) {
        for (const faixa of faixas) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
        // Se não encontrou faixa adequada nas específicas, continua para o padrão
      }
      
      // 4. Usa prazo padrão profissional do banco
      if (prazoProfPadrao.length > 0) {
        for (const faixa of prazoProfPadrao) {
          const kmMin = parseFloat(faixa.km_min) || 0;
          const kmMax = faixa.km_max ? parseFloat(faixa.km_max) : Infinity;
          if (distancia >= kmMin && distancia < kmMax) {
            return parseInt(faixa.prazo_minutos);
          }
        }
      }
      
      // 5. Fallback hardcoded (se nada configurado no banco)
      if (distancia <= 10) return 60;
      if (distancia <= 15) return 75;
      if (distancia <= 20) return 90;
      if (distancia <= 25) return 105;
      if (distancia <= 30) return 135;
      if (distancia <= 35) return 150;
      if (distancia <= 40) return 165;
      if (distancia <= 45) return 180;
      if (distancia <= 50) return 195;
      if (distancia <= 55) return 210;
      if (distancia <= 60) return 225;
      if (distancia <= 65) return 240;
      if (distancia <= 70) return 255;
      if (distancia <= 75) return 270;
      if (distancia <= 80) return 285;
      return 300;
    };
    
    // ============================================
    // BUSCAR TODOS OS CLIENTES EXISTENTES NO SISTEMA
    // ============================================
    const todosClientesQuery = await pool.query(`
      SELECT DISTINCT cod_cliente, nome_cliente 
      FROM bi_entregas 
      WHERE cod_cliente IS NOT NULL
      ORDER BY cod_cliente
    `);
    const todosClientes = todosClientesQuery.rows;
    console.log('📊 Total de clientes no sistema:', todosClientes.length);
    
    // ============================================
    // QUERY SQL PARA TEMPOS MÉDIOS 
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposQuery = await pool.query(`
      SELECT 
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
    `, params);
    
    const temposSQL = temposQuery.rows[0] || {};
    console.log('📊 Tempos calculados via SQL:', temposSQL);
    
    // Buscar todos os dados filtrados
    const dadosQuery = await pool.query(`
      SELECT os, COALESCE(ponto, 1) as ponto, cod_cliente, nome_cliente, 
        cod_prof, nome_prof, dentro_prazo, tempo_execucao_minutos,
        tempo_entrega_prof_minutos, dentro_prazo_prof,
        valor, valor_prof, distancia, ocorrencia, centro_custo, motivo, finalizado,
        data_hora, data_hora_alocado, data_chegada, hora_chegada
      FROM bi_entregas ${where}
    `, params);
    
    const dados = dadosQuery.rows;
    console.log('📊 Total registros retornados:', dados.length);
    
    // Debug: contar quantos têm data_hora_alocado
    const comAlocado = dados.filter(d => d.data_hora_alocado).length;
    const ponto1 = dados.filter(d => parseInt(d.ponto) === 1).length;
    const comAlocadoPonto1 = dados.filter(d => d.data_hora_alocado && parseInt(d.ponto) === 1).length;
    console.log('📊 Debug Alocação: comAlocado=' + comAlocado + ', ponto1=' + ponto1 + ', comAlocadoPonto1=' + comAlocadoPonto1);
    
    // ============================================
    // FUNÇÃO: Calcular tempo de alocação seguindo regra do BI (DAX)
    // Regra: Se solicitado após 17h E alocação no dia seguinte,
    //        início da contagem = 08:00 do dia da alocação
    // ============================================
    const calcularTempoAlocacao = (dataHora, dataHoraAlocado, ponto) => {
      // Ignora: Ponto != 1 OU dados inválidos
      if (!dataHora || !dataHoraAlocado) return null;
      const pontoNum = parseInt(ponto) || 1; // COALESCE(ponto, 1)
      if (pontoNum !== 1) return null;
      
      const solicitado = new Date(dataHora);
      const alocado = new Date(dataHoraAlocado);
      
      // Ignora se alocado < solicitado (dados invertidos)
      if (alocado < solicitado) return null;
      
      // Hora da solicitação
      const horaSolicitado = solicitado.getHours();
      
      // Verifica se foi solicitado após 17h
      const depoisDas17 = horaSolicitado >= 17;
      
      // Verifica se a alocação foi no dia seguinte
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem;
      
      if (depoisDas17 && !mesmaData) {
        // Se solicitado após 17h E alocação no dia seguinte,
        // início = 08:00 do dia da alocação
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      } else {
        // Caso contrário, início = data/hora solicitado
        inicioContagem = solicitado;
      }
      
      // Calcula diferença em minutos
      const difMs = alocado - inicioContagem;
      const difMinutos = difMs / (1000 * 60);
      
      // Retorna null se negativo ou inválido
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    
    // ============================================
    // FUNÇÃO: Calcular tempo de entrega (Ponto <> 1: Solicitado -> Chegada)
    // Usa data_chegada + hora_chegada (como o Power BI), com fallback para finalizado
    // Regra: Se não é mesma data, início = 08:00 do dia da chegada
    // ============================================
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null; // Apenas pontos de entrega (<> 1)
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      // DEBUG: Log primeiro registro para ver estrutura dos dados
      if (!calcularTempoEntrega.logged) {
        console.log('📊 DEBUG calcularTempoEntrega - Exemplo de row:', {
          ponto: row.ponto,
          data_hora: row.data_hora,
          data_chegada: row.data_chegada,
          hora_chegada: row.hora_chegada,
          finalizado: row.finalizado,
          tipo_data_chegada: typeof row.data_chegada,
          tipo_hora_chegada: typeof row.hora_chegada
        });
        calcularTempoEntrega.logged = true;
      }
      
      // Verificar se temos data_chegada + hora_chegada válidos
      if (row.data_chegada && row.hora_chegada) {
        try {
          // data_chegada pode ser Date ou string
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {
          console.log('📊 DEBUG calcularTempoEntrega - Erro:', e.message);
        }
      }
      
      // Fallback: usar finalizado se válido E >= solicitado
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      // Verifica se é mesma data
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        // Se não é mesma data, início = 08:00 do dia da chegada
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    calcularTempoEntrega.logged = false;
    
    // ============================================
    // FUNÇÃO: Calcular tempo de coleta (Ponto = 1: Alocado -> Saída)
    // Conforme DAX_MedColetaSegundos: usa Alocado como início
    // Regra: Se depois das 17h E não mesma data, início = 08:00 do dia da saída
    // ============================================
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null; // Apenas ponto 1 (coleta)
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      // Verificar se temos data_chegada + hora_chegada válidos
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {
          // Ignorar erro de parsing
        }
      }
      
      // Fallback: usar finalizado se válido E >= alocado
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      // Verifica hora da alocação (se depois das 17h)
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        // Se alocado após 17h E saída no dia seguinte, início = 08:00 do dia da saída
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      
      return difMinutos;
    };
    
    // ============================================
    // FUNÇÃO: Calcular T. Entrega Prof (Alocado -> Finalizado da OS)
    // Este é o tempo que o profissional leva desde que é alocado até finalizar
    // Regra: Se dias diferentes, início = 08:00 do dia do finalizado
    // NOTA: Os dados vêm em horário de Brasília, tratamos como strings para evitar problemas de timezone
    // ============================================
    const calcularTempoEntregaProf = (dataHoraAlocado, finalizado) => {
      if (!dataHoraAlocado || !finalizado) return null;
      
      // Extrair data e hora como strings para evitar problemas de timezone
      // Aceita formatos: "2025-12-01T18:12:19" ou "2025-12-01 18:12:19"
      const parseDateTime = (str) => {
        if (!str) return null;
        const s = String(str);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      const alocado = parseDateTime(dataHoraAlocado);
      const fim = parseDateTime(finalizado);
      
      if (!alocado || !fim) return null;
      
      const mesmaData = alocado.dataStr === fim.dataStr;
      
      let inicioMinutos, fimMinutos;
      
      // Fim sempre é a hora real do fim
      fimMinutos = fim.hora * 60 + fim.min + fim.seg / 60;
      
      if (!mesmaData) {
        // Dias diferentes - começa às 8h do dia do fim
        inicioMinutos = 8 * 60; // 8:00 = 480 minutos
      } else {
        inicioMinutos = alocado.hora * 60 + alocado.min + alocado.seg / 60;
      }
      
      const difMinutos = fimMinutos - inicioMinutos;
      
      // Se negativo, algo está errado
      if (difMinutos < 0) return null;
      
      return difMinutos;
    };
    
    // LÓGICA DE CONTAGEM:
    // Cliente SEM regra: 1 OS = 1 entrega (conta OS únicas)
    // Cliente COM regra: conta pontos > 1 (cada ponto de entrega conta, exclui coleta)
    
    // Agrupar por cliente/OS
    const osPorCliente = {};
    dados.forEach(row => {
      const codStr = String(row.cod_cliente);
      const os = row.os;
      if (!osPorCliente[codStr]) osPorCliente[codStr] = {};
      if (!osPorCliente[codStr][os]) osPorCliente[codStr][os] = [];
      osPorCliente[codStr][os].push(row);
    });
    
    // Log de debug por cliente
    Object.keys(osPorCliente).forEach(codCliente => {
      const totalOS = Object.keys(osPorCliente[codCliente]).length;
      const temRegra = clientesComRegra.has(codCliente);
      console.log(`📊 Cliente ${codCliente}: ${totalOS} OS distintas, tem regra: ${temRegra}`);
    });
    
    // Função para calcular entregas de uma OS
    // REGRA UNIVERSAL: conta apenas pontos >= 2 (ponto 1 é coleta, não conta)
    const calcularEntregasOS = (linhasOS) => {
      const entregasCount = linhasOS.filter(l => {
        const pontoNum = parseInt(l.ponto) || 1;
        return pontoNum >= 2;
      }).length;
      
      // Se não encontrou pontos >= 2, usa fallback: linhas - 1
      if (entregasCount === 0 && linhasOS.length > 1) {
        return linhasOS.length - 1;
      }
      
      // Mínimo 1 entrega se só tem 1 linha
      return entregasCount > 0 ? entregasCount : 1;
    };
    
    // Calcular métricas gerais - usando a lógica por OS
    let totalOS = new Set();
    let totalEntregas = 0, dentroPrazo = 0, foraPrazo = 0, semPrazo = 0;
    let dentroPrazoProf = 0, foraPrazoProf = 0; // Prazo Prof (baseado em Alocado -> Finalizado)
    let somaValor = 0, somaValorProf = 0;
    let somaTempoEntrega = 0, countTempoEntrega = 0; // Tempo de entrega (Ponto >= 2)
    let somaTempoAlocacao = 0, countTempoAlocacao = 0; // Tempo de alocação (Ponto = 1)
    let somaTempoColeta = 0, countTempoColeta = 0; // Tempo de coleta (Ponto = 1)
    let somaTempoEntregaProf = 0, countTempoEntregaProf = 0; // T. Entrega Prof (Alocado -> Finalizado)
    let profissionais = new Set();
    let totalRetornos = 0;
    let ultimaEntrega = null;
    
    // Função para verificar se é retorno baseado na Ocorrência
    const isRetorno = (ocorrencia) => {
      if (!ocorrencia) return false;
      const oc = ocorrencia.toLowerCase().trim();
      return oc.includes('cliente fechado') || 
             oc.includes('clienteaus') ||
             oc.includes('cliente ausente') ||
             oc.includes('loja fechada') ||
             oc.includes('produto incorreto');
    };
    
    // Processar por cliente/OS
    Object.keys(osPorCliente).forEach(codCliente => {
      const osDoCliente = osPorCliente[codCliente];
      
      Object.keys(osDoCliente).forEach(os => {
        const linhasOS = osDoCliente[os];
        totalOS.add(os);
        
        // Contar entregas desta OS (pontos >= 2)
        const entregasOS = calcularEntregasOS(linhasOS);
        totalEntregas += entregasOS;
        
        // Contagem de profissionais e RETORNOS (em todas as linhas)
        linhasOS.forEach((row) => {
          profissionais.add(row.cod_prof);
          
          // RETORNO = ocorrência indica problema (conta em TODAS as linhas)
          if (isRetorno(row.ocorrencia)) {
            totalRetornos++;
          }
          
          // Última entrega
          if (row.finalizado) {
            const dataFin = new Date(row.finalizado);
            if (!ultimaEntrega || dataFin > ultimaEntrega) {
              ultimaEntrega = dataFin;
            }
          }
          
          // Calcular tempo de alocação (apenas para Ponto 1)
          const tempoAloc = calcularTempoAlocacao(row.data_hora, row.data_hora_alocado, row.ponto);
          if (tempoAloc !== null) {
            somaTempoAlocacao += tempoAloc;
            countTempoAlocacao++;
          }
          
          // Calcular tempo de entrega (apenas para Ponto <> 1)
          const tempoEnt = calcularTempoEntrega(row);
          if (tempoEnt !== null) {
            somaTempoEntrega += tempoEnt;
            countTempoEntrega++;
          }
          
          // Calcular tempo de coleta (apenas para Ponto = 1)
          const tempoCol = calcularTempoColeta(row);
          if (tempoCol !== null) {
            somaTempoColeta += tempoCol;
            countTempoColeta++;
          }
        });
        
        // REGRA UNIVERSAL: métricas apenas das linhas com ponto >= 2 (entregas)
        const linhasEntrega = linhasOS.filter(l => parseInt(l.ponto) >= 2);
        
        // Para prazo: processa todas as linhas de entrega
        const processarPrazo = (l) => {
          if (l.dentro_prazo === true) dentroPrazo++;
          else if (l.dentro_prazo === false) foraPrazo++;
          else semPrazo++; // null ou undefined
        };
        
        // ===== CALCULAR T. ENTREGA PROF E PRAZO PROF POR ENTREGA =====
        // Para cada linha de entrega (ponto >= 2), calcular o tempo prof
        // T. Entrega Prof = data_hora_alocado (ponto 1) → finalizado (desta entrega)
        // Com regra: se dias diferentes, começa às 8h do dia do finalizado
        const primeiroReg = linhasOS[0]; // Ponto 1 - tem o data_hora_alocado
        
        // Função para extrair data/hora (aceita string ou objeto Date)
        const parseDateTime = (valor) => {
          if (!valor) return null;
          
          // Se for objeto Date
          if (valor instanceof Date) {
            return {
              dataStr: valor.toISOString().split('T')[0],
              hora: valor.getHours(),
              min: valor.getMinutes(),
              seg: valor.getSeconds()
            };
          }
          
          // Se for string
          const s = String(valor);
          const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
          if (!match) return null;
          return {
            dataStr: match[1] + '-' + match[2] + '-' + match[3],
            hora: parseInt(match[4]),
            min: parseInt(match[5]),
            seg: parseInt(match[6])
          };
        };
        
        const alocadoStr = primeiroReg?.data_hora_alocado;
        const alocado = parseDateTime(alocadoStr);
        
        // Determinar quais linhas processar para Prazo Prof
        // Se tem linhas com ponto >= 2, usa elas. Senão, usa todas exceto a primeira (coleta)
        const linhasParaPrazoProf = linhasEntrega.length > 0 
          ? linhasEntrega 
          : (linhasOS.length > 1 ? linhasOS.slice(1) : linhasOS);
        
        // Processar CADA ENTREGA para o Prazo Prof
        linhasParaPrazoProf.forEach((entrega) => {
          const finalizadoStr = entrega.finalizado;
          const finalizado = parseDateTime(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            
            let inicioMinutos, fimMinutos;
            
            // Fim sempre é a hora real do finalizado
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            
            if (!mesmaData) {
              // Dias diferentes - começa às 8h do dia do finalizado
              inicioMinutos = 8 * 60; // 8:00 = 480 minutos
            } else {
              inicioMinutos = alocado.hora * 60 + alocado.min + alocado.seg / 60;
            }
            
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              somaTempoEntregaProf += tempoEntProf;
              countTempoEntregaProf++;
              
              // Prazo Prof: calcular baseado no CLIENTE/CENTRO e DISTÂNCIA desta entrega
              const distanciaEntrega = parseFloat(entrega.distancia) || 0;
              const codClienteEntrega = entrega.cod_cliente;
              const centroCustoEntrega = entrega.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              
              // Log de debug (primeiras 5 entregas)
              if (countTempoEntregaProf <= 5) {
                console.log(`📊 DEBUG Prazo Prof - OS ${entrega.os}: dist=${distanciaEntrega.toFixed(1)}km, tempo=${tempoEntProf.toFixed(0)}min, prazo=${prazoMinutos}min, ${tempoEntProf <= prazoMinutos ? '✅ DENTRO' : '❌ FORA'}`);
              }
              
              if (tempoEntProf <= prazoMinutos) {
                dentroPrazoProf++;
              } else {
                foraPrazoProf++;
              }
            } else {
              // Tempo negativo = dados inconsistentes = fora do prazo
              foraPrazoProf++;
            }
          } else {
            // Sem dados de alocado ou finalizado = conta como fora do prazo
            foraPrazoProf++;
          }
        });
        // ===== FIM CALCULAR T. ENTREGA PROF =====
        
        // Para VALORES: soma apenas 1x por OS (pega a linha com maior ponto, que tem o valor da OS)
        const linhaValor = linhasOS.reduce((maior, atual) => {
          const pontoAtual = parseInt(atual.ponto) || 0;
          const pontoMaior = parseInt(maior?.ponto) || 0;
          return pontoAtual > pontoMaior ? atual : maior;
        }, linhasOS[0]);
        
        somaValor += parseFloat(linhaValor?.valor) || 0;
        somaValorProf += parseFloat(linhaValor?.valor_prof) || 0;
        
        if (linhasEntrega.length > 0) {
          linhasEntrega.forEach(processarPrazo);
        } else if (linhasOS.length > 1) {
          linhasOS.slice(1).forEach(processarPrazo);
        } else {
          processarPrazo(linhasOS[0]);
        }
      });
    });
    
    // Função para formatar tempo em HH:MM:SS (igual ao Acompanhamento)
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0 || isNaN(minutos)) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    // USAR TEMPOS DA QUERY SQL (igual ao Acompanhamento)
    // Frontend espera minutos como número, ele mesmo formata para HH:MM:SS
    // DEBUG: Log dos tempos para verificar
    console.log('📊 DEBUG Tempos SQL:', {
      tempo_medio_entrega: temposSQL.tempo_medio_entrega,
      tempo_medio_alocacao: temposSQL.tempo_medio_alocacao,
      tempo_medio_coleta: temposSQL.tempo_medio_coleta
    });
    
    // Se SQL não retornar tempos válidos, usar os cálculos JS como fallback
    const tempoMedioEntrega = parseFloat(temposSQL.tempo_medio_entrega) || 
      (countTempoEntrega > 0 ? somaTempoEntrega / countTempoEntrega : 0);
    const tempoMedioAlocacao = parseFloat(temposSQL.tempo_medio_alocacao) || 
      (countTempoAlocacao > 0 ? somaTempoAlocacao / countTempoAlocacao : 0);
    const tempoMedioColeta = parseFloat(temposSQL.tempo_medio_coleta) || 
      (countTempoColeta > 0 ? somaTempoColeta / countTempoColeta : 0);
    
    console.log('📊 DEBUG Tempos Finais (minutos):', {
      tempo_medio: tempoMedioEntrega,
      tempo_medio_alocacao: tempoMedioAlocacao,
      tempo_medio_coleta: tempoMedioColeta,
      countTempoEntrega,
      countTempoAlocacao,
      countTempoColeta
    });
    
    // Calcular tempo médio de entrega do profissional
    const tempoMedioEntregaProf = countTempoEntregaProf > 0 
      ? somaTempoEntregaProf / countTempoEntregaProf 
      : 0;
    
    console.log('📊 DEBUG T. Entrega Prof:', {
      tempo_medio_entrega_prof: tempoMedioEntregaProf,
      dentro_prazo_prof: dentroPrazoProf,
      fora_prazo_prof: foraPrazoProf,
      countTempoEntregaProf,
      totalEntregas,
      diferenca: totalEntregas - (dentroPrazoProf + foraPrazoProf)
    });
    
    const metricas = {
      total_os: totalOS.size,
      total_entregas: totalEntregas,
      dentro_prazo: dentroPrazo,
      fora_prazo: foraPrazo,
      sem_prazo: semPrazo,
      dentro_prazo_prof: dentroPrazoProf,
      fora_prazo_prof: foraPrazoProf,
      tempo_medio: tempoMedioEntrega,
      tempo_medio_alocacao: tempoMedioAlocacao,
      tempo_medio_coleta: tempoMedioColeta,
      tempo_medio_entrega_prof: tempoMedioEntregaProf,
      valor_total: somaValor.toFixed(2),
      valor_prof_total: somaValorProf.toFixed(2),
      ticket_medio: totalEntregas > 0 ? (somaValor / totalEntregas).toFixed(2) : 0,
      total_profissionais: profissionais.size,
      media_entregas_por_prof: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      total_retornos: totalRetornos,
      incentivo: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      ultima_entrega: ultimaEntrega ? ultimaEntrega.toISOString() : null
    };
    
    // ============================================
    // QUERY SQL PARA TEMPOS POR CLIENTE
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposPorClienteQuery = await pool.query(`
      SELECT 
        cod_cliente,
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
      GROUP BY cod_cliente
    `, params);
    
    // Criar mapa de tempos por cliente
    const temposPorClienteMap = {};
    temposPorClienteQuery.rows.forEach(row => {
      temposPorClienteMap[row.cod_cliente] = {
        tempo_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_coleta: parseFloat(row.tempo_medio_coleta) || 0
      };
    });
    
    // Agrupar por cliente - usando mesma lógica
    const porClienteMap = {};
    Object.keys(osPorCliente).forEach(codCliente => {
      const osDoCliente = osPorCliente[codCliente];
      
      if (!porClienteMap[codCliente]) {
        const primeiraLinha = Object.values(osDoCliente)[0][0];
        porClienteMap[codCliente] = {
          cod_cliente: primeiraLinha.cod_cliente,
          nome_cliente: primeiraLinha.nome_cliente,
          nome_display: mapMascaras[codCliente] || primeiraLinha.nome_cliente,
          tem_mascara: !!mapMascaras[codCliente],
          os_set: new Set(),
          profissionais_set: new Set(),
          centros_custo_map: {}, // Mapa de centros de custo com dados
          total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0,
          dentro_prazo_prof: 0, fora_prazo_prof: 0, // Novo: prazo profissional
          soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0, soma_dist: 0,
          soma_tempo_alocacao: 0, count_tempo_alocacao: 0, // Novo: tempo de alocação
          total_retornos: 0, ultima_entrega: null
        };
      }
      
      const c = porClienteMap[codCliente];
      
      // Função para verificar se é retorno baseado na Ocorrência
      const isRetornoCliente = (ocorrencia) => {
        if (!ocorrencia) return false;
        const oc = ocorrencia.toLowerCase().trim();
        return oc.includes('cliente fechado') || 
               oc.includes('clienteaus') ||
               oc.includes('cliente ausente') ||
               oc.includes('loja fechada') ||
               oc.includes('produto incorreto');
      };
      
      // Função para extrair data/hora (para cálculo do prazo prof)
      const parseDateTimeCliente = (valor) => {
        if (!valor) return null;
        if (valor instanceof Date) {
          return {
            dataStr: valor.toISOString().split('T')[0],
            hora: valor.getHours(),
            min: valor.getMinutes(),
            seg: valor.getSeconds()
          };
        }
        const s = String(valor);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      Object.keys(osDoCliente).forEach(os => {
        const linhasOS = osDoCliente[os];
        c.os_set.add(os);
        
        // Pegar data_hora_alocado do ponto 1 para cálculo do prazo prof
        const primeiroReg = linhasOS[0];
        const alocadoStr = primeiroReg?.data_hora_alocado;
        const alocado = parseDateTimeCliente(alocadoStr);
        
        // Coletar profissionais, última entrega e RETORNOS (em todas as linhas)
        linhasOS.forEach(l => {
          c.profissionais_set.add(l.cod_prof);
          
          // RETORNO = ocorrência indica problema (conta em TODAS as linhas)
          if (isRetornoCliente(l.ocorrencia)) {
            c.total_retornos++;
          }
          
          if (l.finalizado) {
            const dataFin = new Date(l.finalizado);
            if (!c.ultima_entrega || dataFin > c.ultima_entrega) {
              c.ultima_entrega = dataFin;
            }
          }
          
          // Calcular tempo de alocação por cliente (apenas para Ponto 1)
          const tempoAlocCliente = calcularTempoAlocacao(l.data_hora, l.data_hora_alocado, l.ponto);
          if (tempoAlocCliente !== null) {
            c.soma_tempo_alocacao += tempoAlocCliente;
            c.count_tempo_alocacao++;
          }
        });
        
        const entregasOS = calcularEntregasOS(linhasOS);
        c.total_entregas += entregasOS;
        
        // REGRA UNIVERSAL: métricas apenas das entregas (ponto >= 2)
        const linhasEntrega = linhasOS.filter(l => parseInt(l.ponto) >= 2);
        const linhasParaProcessar = linhasEntrega.length > 0 ? linhasEntrega : 
          (linhasOS.length > 1 ? linhasOS.slice(1) : linhasOS);
        
        // Para VALORES: soma apenas 1x por OS (pega a linha com maior ponto)
        const linhaValor = linhasOS.reduce((maior, atual) => {
          const pontoAtual = parseInt(atual.ponto) || 0;
          const pontoMaior = parseInt(maior?.ponto) || 0;
          return pontoAtual > pontoMaior ? atual : maior;
        }, linhasOS[0]);
        
        c.soma_valor += parseFloat(linhaValor?.valor) || 0;
        c.soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
        c.soma_dist += parseFloat(linhaValor?.distancia) || 0;
        
        // Centro de custo para valores - pega do linhaValor
        const ccValor = linhaValor?.centro_custo || 'Sem Centro';
        if (!c.centros_custo_map[ccValor]) {
          c.centros_custo_map[ccValor] = {
            centro_custo: ccValor,
            os_set: new Set(),
            total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
            dentro_prazo_prof: 0, fora_prazo_prof: 0, // Novo: prazo prof por centro
            soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0
          };
        }
        c.centros_custo_map[ccValor].soma_valor += parseFloat(linhaValor?.valor) || 0;
        c.centros_custo_map[ccValor].soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
        c.centros_custo_map[ccValor].os_set.add(os);
        
        linhasParaProcessar.forEach(l => {
          // Métricas do cliente total (prazo e tempo)
          if (l.dentro_prazo === true) c.dentro_prazo++;
          else if (l.dentro_prazo === false) c.fora_prazo++;
          else c.sem_prazo++;
          
          // ===== CALCULAR PRAZO PROF POR CLIENTE =====
          const finalizadoStr = l.finalizado;
          const finalizado = parseDateTimeCliente(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(l.distancia) || 0;
              const codClienteEntrega = l.cod_cliente;
              const centroCustoEntrega = l.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              if (tempoEntProf <= prazoMinutos) {
                c.dentro_prazo_prof++;
              } else {
                c.fora_prazo_prof++;
              }
            } else {
              c.fora_prazo_prof++;
            }
          } else {
            c.fora_prazo_prof++;
          }
          // ===== FIM PRAZO PROF =====
          
          // Usar cálculo manual de tempo de entrega (conforme DAX)
          const tempoEntCalc = calcularTempoEntrega(l);
          if (tempoEntCalc !== null) {
            c.soma_tempo += tempoEntCalc;
            c.count_tempo++;
          }
          
          // Agrupar por centro de custo (prazo e entregas)
          const cc = l.centro_custo || 'Sem Centro';
          if (!c.centros_custo_map[cc]) {
            c.centros_custo_map[cc] = {
              centro_custo: cc,
              os_set: new Set(),
              total_entregas: 0, dentro_prazo: 0, fora_prazo: 0, sem_prazo: 0, total_retornos: 0,
              dentro_prazo_prof: 0, fora_prazo_prof: 0,
              soma_tempo: 0, count_tempo: 0, soma_valor: 0, soma_valor_prof: 0
            };
          }
          const ccData = c.centros_custo_map[cc];
          ccData.total_entregas++;
          if (l.dentro_prazo === true) ccData.dentro_prazo++;
          else if (l.dentro_prazo === false) ccData.fora_prazo++;
          else ccData.sem_prazo++;
          
          // Prazo prof por centro de custo
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(l.distancia) || 0;
              const codClienteEntrega = l.cod_cliente;
              const centroCustoEntrega = l.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              if (tempoEntProf <= prazoMinutos) {
                ccData.dentro_prazo_prof++;
              } else {
                ccData.fora_prazo_prof++;
              }
            } else {
              ccData.fora_prazo_prof++;
            }
          } else {
            ccData.fora_prazo_prof++;
          }
          
          if (tempoEntCalc !== null) {
            ccData.soma_tempo += tempoEntCalc;
            ccData.count_tempo++;
          }
        });
        
        // Contar retornos por centro de custo (em TODAS as linhas da OS)
        linhasOS.forEach(l => {
          const cc = l.centro_custo || 'Sem Centro';
          if (c.centros_custo_map[cc] && isRetornoCliente(l.ocorrencia)) {
            c.centros_custo_map[cc].total_retornos++;
          }
        });
      });
    });
    
    const porCliente = Object.values(porClienteMap).map(c => {
      // Usar tempos da query SQL, com fallback para cálculos JS
      // Frontend espera minutos como número, ele mesmo formata
      const temposCliente = temposPorClienteMap[c.cod_cliente] || {};
      
      // Fallback: usar cálculos JS se SQL não retornar
      const tempoMedioCliente = temposCliente.tempo_entrega || 
        (c.count_tempo > 0 ? c.soma_tempo / c.count_tempo : 0);
      const tempoAlocacaoCliente = temposCliente.tempo_alocacao || 0;
      
      // Converter centros_custo_map em array com dados
      const centros_custo_dados = Object.values(c.centros_custo_map).map(cc => ({
        centro_custo: cc.centro_custo,
        total_os: cc.os_set.size,
        total_entregas: cc.total_entregas,
        total_retornos: cc.total_retornos,
        dentro_prazo: cc.dentro_prazo,
        fora_prazo: cc.fora_prazo,
        sem_prazo: cc.sem_prazo,
        dentro_prazo_prof: cc.dentro_prazo_prof || 0,
        fora_prazo_prof: cc.fora_prazo_prof || 0,
        tempo_medio: cc.count_tempo > 0 ? cc.soma_tempo / cc.count_tempo : 0,
        valor_total: cc.soma_valor.toFixed(2),
        valor_prof: cc.soma_valor_prof.toFixed(2)
      })).sort((a, b) => b.total_entregas - a.total_entregas);
      
      const totalProfs = c.profissionais_set.size;
      const ticketMedio = c.total_entregas > 0 ? (c.soma_valor / c.total_entregas) : 0;
      const incentivo = totalProfs > 0 ? (c.total_entregas / totalProfs) : 0;
      
      return {
        cod_cliente: c.cod_cliente, nome_cliente: c.nome_cliente,
        nome_display: c.nome_display, tem_mascara: c.tem_mascara,
        total_os: c.os_set.size, total_entregas: c.total_entregas,
        centros_custo: centros_custo_dados,
        dentro_prazo: c.dentro_prazo, fora_prazo: c.fora_prazo, sem_prazo: c.sem_prazo,
        dentro_prazo_prof: c.dentro_prazo_prof, fora_prazo_prof: c.fora_prazo_prof,
        tempo_medio: tempoMedioCliente,
        tempo_medio_alocacao: tempoAlocacaoCliente,
        valor_total: c.soma_valor.toFixed(2), valor_prof: c.soma_valor_prof.toFixed(2),
        distancia_total: c.soma_dist ? c.soma_dist.toFixed(2) : "0.00",
        ticket_medio: ticketMedio.toFixed(2),
        total_profissionais: totalProfs,
        entregas_por_prof: incentivo.toFixed(2),
        incentivo: incentivo.toFixed(2),
        total_retornos: c.total_retornos,
        retornos: c.total_retornos,
        ultima_entrega: c.ultima_entrega ? c.ultima_entrega.toISOString() : null
      };
    });
    
    // ============================================
    // ADICIONAR CLIENTES QUE NÃO TÊM ENTREGAS NO PERÍODO
    // (apenas se não houver filtro de cliente específico)
    // ============================================
    if (!cod_cliente || cod_cliente.length === 0) {
      const clientesComDados = new Set(porCliente.map(c => String(c.cod_cliente)));
      
      todosClientes.forEach(tc => {
        const codCli = String(tc.cod_cliente);
        if (!clientesComDados.has(codCli)) {
          porCliente.push({
            cod_cliente: tc.cod_cliente,
            nome_cliente: tc.nome_cliente,
            nome_display: mapMascaras[codCli] || tc.nome_cliente,
            tem_mascara: !!mapMascaras[codCli],
            total_os: 0,
            total_entregas: 0,
            centros_custo: [],
            dentro_prazo: 0,
            fora_prazo: 0,
            sem_prazo: 0,
            tempo_medio: null,
            tempo_medio_alocacao: "0.00",
            valor_total: "0.00",
            valor_prof: "0.00",
            distancia_total: "0.00",
            ticket_medio: "0.00",
            total_profissionais: 0,
            entregas_por_prof: "0.00",
            incentivo: "0.00",
            total_retornos: 0,
            retornos: 0,
            dentro_prazo_prof: 0,
            fora_prazo_prof: 0,
            ultima_entrega: null
          });
        }
      });
    }
    
    // Ordenar por total de entregas (decrescente)
    porCliente.sort((a, b) => b.total_entregas - a.total_entregas);
    
    // Log centros de custo encontrados
    console.log('📁 CENTROS DE CUSTO POR CLIENTE:');
    porCliente.slice(0, 10).forEach(c => {
      console.log(`   - ${c.cod_cliente}: ${c.centros_custo?.length || 0} centros`);
    });
    
    // Log resultado por cliente
    console.log('📊 RESULTADO POR CLIENTE (total:', porCliente.length, '):');
    porCliente.slice(0, 5).forEach(c => {
      const temRegra = clientesComRegra.has(String(c.cod_cliente));
      console.log(`   - ${c.cod_cliente} (${c.nome_display}): ${c.total_os} OS, ${c.total_entregas} entregas, regra: ${temRegra}`);
    });
    console.log('📊 TOTAL GERAL: ', metricas.total_os, 'OS,', metricas.total_entregas, 'entregas');
    
    // Agrupar por profissional - também precisa respeitar a regra
    const porProfMap = {};
    
    // Agrupar por profissional/OS para aplicar regra corretamente
    const osPorProf = {};
    dados.forEach(row => {
      const codProf = String(row.cod_prof);
      const codCliente = String(row.cod_cliente);
      const os = row.os;
      const chave = `${codProf}-${os}`;
      
      if (!osPorProf[codProf]) osPorProf[codProf] = {};
      if (!osPorProf[codProf][os]) osPorProf[codProf][os] = { codCliente, linhas: [] };
      osPorProf[codProf][os].linhas.push(row);
    });
    
    // ============================================
    // QUERY SQL PARA TEMPOS POR PROFISSIONAL
    // LÓGICA IDÊNTICA AO ACOMPANHAMENTO-CLIENTES
    // ============================================
    const temposPorProfQuery = await pool.query(`
      SELECT 
        cod_prof,
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2): Solicitado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN DATE(data_chegada) <> DATE(data_hora)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_hora IS NOT NULL 
                 AND finalizado IS NOT NULL
                 AND finalizado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                finalizado - 
                CASE 
                  WHEN DATE(finalizado) <> DATE(data_hora)
                  THEN DATE(finalizado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_entrega,
        
        -- TEMPO MÉDIO ALOCAÇÃO (Ponto = 1): Solicitado -> Alocado
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1
                 AND data_hora_alocado IS NOT NULL 
                 AND data_hora IS NOT NULL
                 AND data_hora_alocado >= data_hora
            THEN
              EXTRACT(EPOCH FROM (
                data_hora_alocado - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora) >= 17 
                       AND DATE(data_hora_alocado) > DATE(data_hora)
                  THEN DATE(data_hora_alocado) + TIME '08:00:00'
                  ELSE data_hora
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_alocacao,
        
        -- TEMPO MÉDIO COLETA (Ponto = 1): Alocado -> Chegada
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) = 1 
                 AND data_hora_alocado IS NOT NULL 
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND (data_chegada + hora_chegada::time) >= data_hora_alocado
            THEN
              EXTRACT(EPOCH FROM (
                (data_chegada + hora_chegada::time) - 
                CASE 
                  WHEN EXTRACT(HOUR FROM data_hora_alocado) >= 17 
                       AND DATE(data_chegada) > DATE(data_hora_alocado)
                  THEN DATE(data_chegada) + TIME '08:00:00'
                  ELSE data_hora_alocado
                END
              )) / 60
            ELSE NULL
          END
        ), 2) as tempo_medio_coleta
      FROM bi_entregas ${where}
      GROUP BY cod_prof
    `, params);
    
    // Criar mapa de tempos por profissional
    const temposPorProfMap = {};
    temposPorProfQuery.rows.forEach(row => {
      temposPorProfMap[row.cod_prof] = {
        tempo_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_coleta: parseFloat(row.tempo_medio_coleta) || 0
      };
    });
    
    Object.keys(osPorProf).forEach(codProf => {
      const osDoProf = osPorProf[codProf];
      
      if (!porProfMap[codProf]) {
        const primeiraLinha = Object.values(osDoProf)[0].linhas[0];
        porProfMap[codProf] = {
          cod_prof: primeiraLinha.cod_prof,
          nome_prof: primeiraLinha.nome_prof,
          total_entregas: 0, dentro_prazo: 0, fora_prazo: 0,
          dentro_prazo_prof: 0, fora_prazo_prof: 0,
          soma_tempo: 0, count_tempo: 0, 
          soma_tempo_alocacao: 0, count_tempo_alocacao: 0,
          soma_tempo_coleta: 0, count_tempo_coleta: 0,
          soma_dist: 0, soma_valor_prof: 0, retornos: 0
        };
      }
      
      const p = porProfMap[codProf];
      
      // Função para verificar se é retorno baseado na Ocorrência
      const isRetornoProf = (ocorrencia) => {
        if (!ocorrencia) return false;
        const oc = ocorrencia.toLowerCase().trim();
        return oc.includes('cliente fechado') || 
               oc.includes('clienteaus') ||
               oc.includes('cliente ausente') ||
               oc.includes('loja fechada') ||
               oc.includes('produto incorreto');
      };
      
      // Função para parsear data/hora
      const parseDateTimeProf = (valor) => {
        if (!valor) return null;
        if (valor instanceof Date) {
          return {
            dataStr: valor.toISOString().split('T')[0],
            hora: valor.getHours(),
            min: valor.getMinutes(),
            seg: valor.getSeconds()
          };
        }
        const s = String(valor);
        const match = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        return {
          dataStr: match[1] + '-' + match[2] + '-' + match[3],
          hora: parseInt(match[4]),
          min: parseInt(match[5]),
          seg: parseInt(match[6])
        };
      };
      
      Object.keys(osDoProf).forEach(os => {
        const { codCliente, linhas } = osDoProf[os];
        const entregasOS = calcularEntregasOS(linhas);
        p.total_entregas += entregasOS;
        
        // Contagem de retornos (ocorrência indica problema) - TODAS as linhas
        linhas.forEach(l => {
          if (isRetornoProf(l.ocorrencia)) p.retornos++;
        });
        
        // Separar linhas por tipo
        const linhaPonto1 = linhas.find(l => parseInt(l.ponto) === 1);
        const linhasEntrega = linhas.filter(l => parseInt(l.ponto) >= 2);
        
        // Tempo de alocação e coleta (do ponto 1)
        if (linhaPonto1) {
          const tempoAloc = calcularTempoAlocacao(linhaPonto1.data_hora, linhaPonto1.data_hora_alocado, 1);
          if (tempoAloc !== null) {
            p.soma_tempo_alocacao += tempoAloc;
            p.count_tempo_alocacao++;
          }
          
          const tempoCol = calcularTempoColeta(linhaPonto1);
          if (tempoCol !== null) {
            p.soma_tempo_coleta += tempoCol;
            p.count_tempo_coleta++;
          }
        }
        
        // Pegar data_hora_alocado do ponto 1 para cálculo do prazo prof
        const alocadoStr = linhaPonto1?.data_hora_alocado;
        const alocado = parseDateTimeProf(alocadoStr);
        
        // Função para calcular prazo prof de uma entrega
        const calcularPrazoProfEntrega = (entrega) => {
          const finalizadoStr = entrega.finalizado;
          const finalizado = parseDateTimeProf(finalizadoStr);
          
          if (alocado && finalizado) {
            const mesmaData = alocado.dataStr === finalizado.dataStr;
            let inicioMinutos, fimMinutos;
            fimMinutos = finalizado.hora * 60 + finalizado.min + finalizado.seg / 60;
            inicioMinutos = !mesmaData ? 8 * 60 : alocado.hora * 60 + alocado.min + alocado.seg / 60;
            const tempoEntProf = fimMinutos - inicioMinutos;
            
            if (tempoEntProf >= 0) {
              const distanciaEntrega = parseFloat(entrega.distancia) || 0;
              const codClienteEntrega = entrega.cod_cliente;
              const centroCustoEntrega = entrega.centro_custo;
              const prazoMinutos = encontrarPrazoProfissional(codClienteEntrega, centroCustoEntrega, distanciaEntrega);
              
              if (tempoEntProf <= prazoMinutos) {
                p.dentro_prazo_prof++;
              } else {
                p.fora_prazo_prof++;
              }
            } else {
              p.fora_prazo_prof++;
            }
          } else {
            p.fora_prazo_prof++;
          }
        };
        
        // Métricas das entregas (ponto >= 2)
        if (linhasEntrega.length > 0) {
          linhasEntrega.forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            
            // Tempo de entrega
            const tempoEnt = calcularTempoEntrega(l);
            if (tempoEnt !== null) {
              p.soma_tempo += tempoEnt;
              p.count_tempo++;
            }
            
            // Prazo profissional
            calcularPrazoProfEntrega(l);
          });
        } else if (linhas.length > 1) {
          linhas.slice(1).forEach(l => {
            if (l.dentro_prazo === true) p.dentro_prazo++;
            else if (l.dentro_prazo === false) p.fora_prazo++;
            p.soma_dist += parseFloat(l.distancia) || 0;
            p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
            
            const tempoEnt = calcularTempoEntrega(l);
            if (tempoEnt !== null) {
              p.soma_tempo += tempoEnt;
              p.count_tempo++;
            }
            
            // Prazo profissional
            calcularPrazoProfEntrega(l);
          });
        } else {
          const l = linhas[0];
          if (l.dentro_prazo === true) p.dentro_prazo++;
          else if (l.dentro_prazo === false) p.fora_prazo++;
          p.soma_dist += parseFloat(l.distancia) || 0;
          p.soma_valor_prof += parseFloat(l.valor_prof) || 0;
          
          const tempoEnt = calcularTempoEntrega(l);
          if (tempoEnt !== null) {
            p.soma_tempo += tempoEnt;
            p.count_tempo++;
          }
          
          // Prazo profissional
          calcularPrazoProfEntrega(l);
        }
      });
    });
    
    const porProfissional = Object.values(porProfMap).map(p => {
      // Usar tempos da query SQL, com fallback para cálculos JS
      // Frontend espera minutos como número, ele mesmo formata
      const temposProf = temposPorProfMap[p.cod_prof] || {};
      
      // Fallback: usar cálculos JS se SQL não retornar
      const tempoMedioProf = temposProf.tempo_entrega || 
        (p.count_tempo > 0 ? p.soma_tempo / p.count_tempo : 0);
      const tempoAlocadoProf = temposProf.tempo_alocacao || 
        (p.count_tempo_alocacao > 0 ? p.soma_tempo_alocacao / p.count_tempo_alocacao : 0);
      const tempoColetaProf = temposProf.tempo_coleta || 
        (p.count_tempo_coleta > 0 ? p.soma_tempo_coleta / p.count_tempo_coleta : 0);
      
      return {
        cod_prof: p.cod_prof, nome_prof: p.nome_prof,
        total_entregas: p.total_entregas, dentro_prazo: p.dentro_prazo, fora_prazo: p.fora_prazo,
        dentro_prazo_prof: p.dentro_prazo_prof, fora_prazo_prof: p.fora_prazo_prof,
        tempo_medio: tempoMedioProf,
        tempo_alocado: tempoAlocadoProf,
        tempo_coleta: tempoColetaProf,
        distancia_total: p.soma_dist.toFixed(2), valor_prof: p.soma_valor_prof.toFixed(2),
        retornos: p.retornos
      };
    }).sort((a, b) => b.total_entregas - a.total_entregas);
    
    // DEBUG: Log dos primeiros profissionais para verificar tempos
    if (porProfissional.length > 0) {
      console.log('📊 DEBUG - Primeiro profissional:', {
        cod_prof: porProfissional[0].cod_prof,
        nome_prof: porProfissional[0].nome_prof,
        tempo_medio: porProfissional[0].tempo_medio,
        tempo_alocado: porProfissional[0].tempo_alocado,
        tempo_coleta: porProfissional[0].tempo_coleta,
        temposSQL: temposPorProfMap[porProfissional[0].cod_prof]
      });
    }
    
    // Gráficos - retorna dados brutos para o frontend agrupar nas faixas que quiser
    const dadosGraficos = await pool.query(`
      SELECT 
        tempo_execucao_minutos as tempo,
        distancia as km
      FROM bi_entregas 
      ${where}
    `, params);
    
    res.json({ 
      metricas, 
      porCliente, 
      porProfissional, 
      dadosGraficos: dadosGraficos.rows 
    });
  } catch (err) {
    console.error('❌ Erro dashboard-completo:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dashboard', details: err.message });
  }
});

// ============================================
// ENDPOINT: OS por Profissional (para expandir na aba profissionais)
// ============================================
router.get('/bi/os-profissional/:cod_prof', async (req, res) => {
  try {
    const { cod_prof } = req.params;
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_prazo, status_retorno, cidade } = req.query;
    
    let whereClause = 'WHERE cod_prof = $1';
    const params = [cod_prof];
    let paramIndex = 2;
    
    if (data_inicio) {
      whereClause += ` AND data_solicitado >= $${paramIndex}`;
      params.push(data_inicio);
      paramIndex++;
    }
    if (data_fim) {
      whereClause += ` AND data_solicitado <= $${paramIndex}`;
      params.push(data_fim);
      paramIndex++;
    }
    if (cod_cliente) {
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
        params.push(clientes);
        paramIndex++;
      }
    }
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
        params.push(centros);
        paramIndex++;
      }
    }
    if (categoria) {
      whereClause += ` AND categoria ILIKE $${paramIndex}`;
      params.push(`%${categoria}%`);
      paramIndex++;
    }
    if (status_prazo === 'dentro') {
      whereClause += ` AND dentro_prazo = true`;
    } else if (status_prazo === 'fora') {
      whereClause += ` AND dentro_prazo = false`;
    }
    if (cidade) {
      whereClause += ` AND cidade ILIKE $${paramIndex}`;
      params.push(`%${cidade}%`);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Buscar TODAS as linhas do profissional (incluindo ponto 1 para calcular tempos)
    const query = await pool.query(`
      SELECT 
        os,
        COALESCE(ponto, 1) as ponto,
        cod_cliente,
        COALESCE(nome_fantasia, nome_cliente) as cliente,
        centro_custo,
        distancia,
        valor,
        valor_prof,
        dentro_prazo,
        data_solicitado,
        data_hora,
        data_hora_alocado,
        data_chegada,
        hora_chegada,
        finalizado,
        ocorrencia,
        motivo
      FROM bi_entregas
      ${whereClause}
      ORDER BY data_solicitado DESC, os DESC
    `, params);
    
    // Funções de cálculo (mesmas das outras abas)
    const calcularTempoAlocacao = (dataHora, dataHoraAlocado, ponto) => {
      if (!dataHora || !dataHoraAlocado) return null;
      const pontoNum = parseInt(ponto) || 1;
      if (pontoNum !== 1) return null; // Só calcula para ponto 1
      
      const solicitado = new Date(dataHora);
      const alocado = new Date(dataHoraAlocado);
      
      if (alocado < solicitado || isNaN(alocado.getTime()) || isNaN(solicitado.getTime())) return null;
      
      const horaSolicitado = solicitado.getHours();
      const depoisDas17 = horaSolicitado >= 17;
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem;
      if (depoisDas17 && !mesmaData) {
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (alocado - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    const calcularTempoEntrega = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum === 1) return null;
      
      if (!row.data_hora) return null;
      const solicitado = new Date(row.data_hora);
      if (isNaN(solicitado.getTime())) return null;
      
      let chegada = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataChegadaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataChegada = new Date(dataChegadaStr + 'T00:00:00');
          dataChegada.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataChegada.getTime()) && dataChegada >= solicitado) {
            chegada = dataChegada;
            dataParaComparacao = dataChegadaStr;
          }
        } catch (e) {}
      }
      
      if (!chegada && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= solicitado) {
          chegada = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!chegada || !dataParaComparacao) return null;
      
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (diaSolicitado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = solicitado;
      }
      
      const difMinutos = (chegada - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    const calcularTempoColeta = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora_alocado) return null;
      const alocado = new Date(row.data_hora_alocado);
      if (isNaN(alocado.getTime())) return null;
      
      let saida = null;
      let dataParaComparacao = null;
      
      if (row.data_chegada && row.hora_chegada) {
        try {
          const dataSaidaStr = row.data_chegada instanceof Date 
            ? row.data_chegada.toISOString().split('T')[0]
            : String(row.data_chegada).split('T')[0];
          
          const partes = String(row.hora_chegada || '0:0:0').split(':').map(Number);
          const dataSaida = new Date(dataSaidaStr + 'T00:00:00');
          dataSaida.setHours(partes[0] || 0, partes[1] || 0, partes[2] || 0, 0);
          
          if (!isNaN(dataSaida.getTime()) && dataSaida >= alocado) {
            saida = dataSaida;
            dataParaComparacao = dataSaidaStr;
          }
        } catch (e) {}
      }
      
      if (!saida && row.finalizado) {
        const fin = new Date(row.finalizado);
        if (!isNaN(fin.getTime()) && fin >= alocado) {
          saida = fin;
          dataParaComparacao = fin.toISOString().split('T')[0];
        }
      }
      
      if (!saida || !dataParaComparacao) return null;
      
      const horaAlocado = alocado.getHours();
      const depoisDas17 = horaAlocado >= 17;
      const diaAlocado = alocado.toISOString().split('T')[0];
      
      let inicioContagem;
      if (depoisDas17 && diaAlocado !== dataParaComparacao) {
        inicioContagem = new Date(dataParaComparacao + 'T08:00:00');
      } else {
        inicioContagem = alocado;
      }
      
      const difMinutos = (saida - inicioContagem) / (1000 * 60);
      if (difMinutos < 0 || isNaN(difMinutos)) return null;
      return difMinutos;
    };
    
    // Agrupar por OS
    const osPorNumero = {};
    query.rows.forEach(row => {
      const osNum = row.os;
      if (!osPorNumero[osNum]) {
        osPorNumero[osNum] = {
          os: osNum,
          linhas: [],
          cod_cliente: row.cod_cliente,
          cliente: row.cliente,
          centro_custo: row.centro_custo,
          data_solicitado: row.data_solicitado
        };
      }
      osPorNumero[osNum].linhas.push(row);
    });
    
    // Processar cada OS
    const oss = Object.values(osPorNumero).map(osData => {
      const { os, linhas, cod_cliente, cliente, centro_custo, data_solicitado } = osData;
      
      // Separar linhas por tipo
      const linhaPonto1 = linhas.find(l => parseInt(l.ponto) === 1);
      const linhasEntrega = linhas.filter(l => parseInt(l.ponto) >= 2);
      
      // Calcular tempos
      let tempoAlocacao = null;
      let tempoColeta = null;
      let tempoEntrega = null;
      let dentroPrazo = null;
      let distancia = 0;
      let valorProf = 0;
      
      // Tempo de alocação (do ponto 1)
      if (linhaPonto1) {
        tempoAlocacao = calcularTempoAlocacao(linhaPonto1.data_hora, linhaPonto1.data_hora_alocado, 1);
        tempoColeta = calcularTempoColeta(linhaPonto1);
      }
      
      // Tempo de entrega e demais dados (das entregas)
      if (linhasEntrega.length > 0) {
        // Pegar a primeira entrega para calcular tempo
        const primeiraEntrega = linhasEntrega[0];
        tempoEntrega = calcularTempoEntrega(primeiraEntrega);
        
        // Somar valores de todas as entregas
        linhasEntrega.forEach(l => {
          distancia += parseFloat(l.distancia) || 0;
          valorProf += parseFloat(l.valor_prof) || 0;
          if (l.dentro_prazo !== null) dentroPrazo = l.dentro_prazo;
        });
      }
      
      return {
        os,
        cod_cliente,
        cliente,
        centro_custo,
        data_solicitado,
        tempo_alocacao: tempoAlocacao,
        tempo_coleta: tempoColeta,
        tempo_entrega: tempoEntrega,
        distancia,
        dentro_prazo: dentroPrazo,
        valor_prof: valorProf
      };
    })
    .filter(os => os.tempo_entrega !== null || os.tempo_alocacao !== null) // Apenas OS com algum tempo calculado
    .sort((a, b) => new Date(b.data_solicitado) - new Date(a.data_solicitado))
    .slice(0, 100); // Limitar a 100 OS
    
    res.json({ oss, total: oss.length });
    
  } catch (error) {
    console.error('Erro OS profissional:', error);
    res.status(500).json({ error: 'Erro ao buscar OS do profissional', details: error.message });
  }
});


// Lista de entregas detalhada (para análise por OS)
router.get('/bi/entregas-lista', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, cod_prof, categoria, status_prazo, status_retorno, cidade, clientes_sem_filtro_cc } = req.query;
    
    let where = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // Clientes que não devem ter filtro de centro de custo
    let clientesSemFiltroCC = [];
    if (clientes_sem_filtro_cc) {
      clientesSemFiltroCC = clientes_sem_filtro_cc.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }
    
    // Converter datas ISO para YYYY-MM-DD
    if (data_inicio) { 
      const dataIni = data_inicio.includes('T') ? data_inicio.split('T')[0] : data_inicio;
      where += ` AND data_solicitado >= $${paramIndex++}`; 
      params.push(dataIni); 
    }
    if (data_fim) { 
      const dataFim = data_fim.includes('T') ? data_fim.split('T')[0] : data_fim;
      where += ` AND data_solicitado <= $${paramIndex++}`; 
      params.push(dataFim); 
    }
    if (cod_cliente) { 
      // Suporta múltiplos clientes separados por vírgula
      const clientes = cod_cliente.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
      if (clientes.length > 0) {
        where += ` AND cod_cliente = ANY($${paramIndex++}::int[])`; 
        params.push(clientes);
      }
    }
    if (centro_custo) { 
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        if (clientesSemFiltroCC.length > 0) {
          // Filtrar por CC OU ser um cliente sem filtro de CC
          where += ` AND (centro_custo = ANY($${paramIndex++}::text[]) OR cod_cliente = ANY($${paramIndex++}::int[]))`;
          params.push(centros);
          params.push(clientesSemFiltroCC);
        } else {
          where += ` AND centro_custo = ANY($${paramIndex++}::text[])`; 
          params.push(centros);
        }
      }
    }
    if (cod_prof) { where += ` AND cod_prof = $${paramIndex++}`; params.push(cod_prof); }
    if (categoria) { where += ` AND categoria ILIKE $${paramIndex++}`; params.push(`%${categoria}%`); }
    if (status_prazo === 'dentro') { where += ` AND dentro_prazo = true`; }
    else if (status_prazo === 'fora') { where += ` AND dentro_prazo = false`; }
    if (cidade) { where += ` AND cidade ILIKE $${paramIndex++}`; params.push(`%${cidade}%`); }
    
    // Filtro de retorno - usar mesma lógica da função isRetorno
    let retornoFilter = '';
    if (status_retorno === 'com_retorno') {
      retornoFilter = ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      retornoFilter = ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    const result = await pool.query(`
      SELECT 
        os,
        COALESCE(ponto, 1) as ponto,
        cod_prof,
        nome_prof,
        cod_cliente,
        COALESCE(nome_fantasia, nome_cliente) as cliente,
        centro_custo,
        endereco,
        cidade,
        data_solicitado,
        hora_solicitado,
        data_hora,
        data_hora_alocado,
        data_chegada,
        hora_chegada,
        data_saida,
        hora_saida,
        finalizado,
        distancia,
        dentro_prazo,
        tempo_execucao_minutos,
        prazo_minutos,
        dentro_prazo_prof,
        prazo_prof_minutos,
        tempo_entrega_prof_minutos,
        valor,
        valor_prof,
        categoria,
        ocorrencia,
        motivo,
        status
      FROM bi_entregas ${where}${retornoFilter}
      ORDER BY os DESC, COALESCE(ponto, 1) ASC
      LIMIT 2000
    `, params);
    
    // Retornar direto - campos já calculados no banco durante upload/recálculo
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar entregas:', err);
    res.status(500).json({ error: 'Erro ao listar entregas' });
  }
});

// Lista de cidades disponíveis

  return router;
}

module.exports = { createDashboardRoutes };
