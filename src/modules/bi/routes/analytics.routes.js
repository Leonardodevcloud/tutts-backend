/**
 * BI Sub-Router: Mapa de Calor, Acompanhamento e Comparativos
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createAnalyticsRoutes(pool) {
  const router = express.Router();

router.get('/bi/mapa-calor', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria } = req.query;
    
    let whereClause = 'WHERE ponto >= 2'; // REGRA: apenas entregas (ponto >= 2), não conta coleta (ponto 1)
    const params = [];
    let paramIndex = 1;
    
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
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    
    // BUSCAR PONTOS COM COORDENADAS REAIS DO BANCO (apenas ponto >= 2)
    // Agrupa por coordenadas aproximadas (arredonda para 3 casas decimais ~111m de precisão)
    const pontosQuery = await pool.query(`
      SELECT 
        ROUND(latitude::numeric, 3) as lat_group,
        ROUND(longitude::numeric, 3) as lng_group,
        AVG(latitude) as latitude,
        AVG(longitude) as longitude,
        COALESCE(bairro, 'N/A') as bairro,
        COALESCE(cidade, 'N/A') as cidade,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      AND latitude IS NOT NULL 
      AND longitude IS NOT NULL
      AND latitude != 0 
      AND longitude != 0
      GROUP BY lat_group, lng_group, bairro, cidade
      ORDER BY total_entregas DESC
    `, params);
    
    // Buscar dados agrupados por cidade (para o ranking lateral)
    const cidadesQuery = await pool.query(`
      SELECT 
        COALESCE(cidade, 'Não informado') as cidade,
        COALESCE(estado, 'GO') as estado,
        COUNT(*) as total_entregas,
        COUNT(DISTINCT os) as total_os,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
        COALESCE(SUM(valor), 0) as valor_total,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY cidade, estado
      ORDER BY total_entregas DESC
    `, params);
    
    // Buscar dados agrupados por bairro (top 50)
    const bairrosQuery = await pool.query(`
      SELECT 
        COALESCE(bairro, 'Não informado') as bairro,
        COALESCE(cidade, 'Não informado') as cidade,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo
      FROM bi_entregas
      ${whereClause}
      GROUP BY bairro, cidade
      ORDER BY total_entregas DESC
      LIMIT 50
    `, params);
    
    // Resumo geral
    const resumoQuery = await pool.query(`
      SELECT 
        COUNT(*) as total_entregas,
        COUNT(DISTINCT os) as total_os,
        COUNT(DISTINCT cidade) as total_cidades,
        COUNT(DISTINCT bairro) as total_bairros,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        SUM(CASE WHEN dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo_geral,
        COUNT(DISTINCT cod_prof) as total_profissionais,
        SUM(CASE WHEN latitude IS NOT NULL AND latitude != 0 THEN 1 ELSE 0 END) as com_coordenadas
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    // Horários de pico (heatmap por hora)
    const horariosQuery = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM data_hora) as hora,
        EXTRACT(DOW FROM data_hora) as dia_semana,
        COUNT(*) as total
      FROM bi_entregas
      ${whereClause}
      AND data_hora IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM data_hora), EXTRACT(DOW FROM data_hora)
      ORDER BY dia_semana, hora
    `, params);
    
    // Converter pontos do banco para o formato do mapa
    const pontos = pontosQuery.rows.map(p => ({
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      bairro: p.bairro,
      cidade: p.cidade,
      count: parseInt(p.total_entregas),
      taxaPrazo: parseFloat(p.taxa_prazo) || 0,
      noPrazo: parseInt(p.no_prazo) || 0,
      foraPrazo: parseInt(p.fora_prazo) || 0,
      totalProfissionais: parseInt(p.total_profissionais) || 0
    })).filter(p => !isNaN(p.lat) && !isNaN(p.lng) && p.lat !== 0 && p.lng !== 0);
    
    console.log(`🗺️ Mapa de calor: ${pontos.length} pontos com coordenadas reais`);
    
    res.json({
      totalEntregas: parseInt(resumoQuery.rows[0]?.total_entregas) || 0,
      totalOS: parseInt(resumoQuery.rows[0]?.total_os) || 0,
      totalPontos: pontos.length,
      totalCidades: parseInt(resumoQuery.rows[0]?.total_cidades) || 0,
      totalBairros: parseInt(resumoQuery.rows[0]?.total_bairros) || 0,
      totalProfissionais: parseInt(resumoQuery.rows[0]?.total_profissionais) || 0,
      taxaPrazoGeral: parseFloat(resumoQuery.rows[0]?.taxa_prazo_geral) || 0,
      comCoordenadas: parseInt(resumoQuery.rows[0]?.com_coordenadas) || 0,
      pontos: pontos,
      cidadesRanking: cidadesQuery.rows.slice(0, 15).map(c => ({
        cidade: c.cidade,
        estado: c.estado,
        total: parseInt(c.total_entregas),
        noPrazo: parseInt(c.no_prazo) || 0,
        foraPrazo: parseInt(c.fora_prazo) || 0,
        taxaPrazo: parseFloat(c.taxa_prazo) || 0,
        totalProfissionais: parseInt(c.total_profissionais) || 0
      })),
      bairrosRanking: bairrosQuery.rows.slice(0, 20).map(b => ({
        bairro: b.bairro,
        cidade: b.cidade,
        total: parseInt(b.total_entregas),
        noPrazo: parseInt(b.no_prazo) || 0,
        foraPrazo: parseInt(b.fora_prazo) || 0,
        taxaPrazo: parseFloat(b.taxa_prazo) || 0
      })),
      horariosHeatmap: horariosQuery.rows.map(h => ({
        hora: parseInt(h.hora),
        diaSemana: parseInt(h.dia_semana),
        total: parseInt(h.total)
      }))
    });
    
  } catch (error) {
    console.error('Erro mapa de calor:', error);
    res.status(500).json({ error: 'Erro ao gerar mapa de calor'})   ;
  }
});

// GET - Acompanhamento Periódico (evolução temporal)
router.get('/bi/acompanhamento-periodico', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_retorno } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    // Cada métrica filtra pelo ponto apropriado internamente
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
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
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Dados por data
    // REGRA ALOCAÇÃO: Se solicitado após 17h E alocação no dia seguinte, início = 08:00 do dia da alocação
    const porDataQuery = await pool.query(`
      SELECT 
        data_solicitado,
        TO_CHAR(data_solicitado, 'DD/MM') as data_formatada,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_motoboy,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END), 0), 2) as ticket_medio,
        
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
        ), 1) as tempo_medio_entrega,
        
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
        ), 1) as tempo_medio_alocacao,
        
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
        ), 1) as tempo_medio_coleta,
        
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional
      FROM bi_entregas
      ${whereClause}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // Calcular evolução semanal
    const porData = porDataQuery.rows.map((d, idx, arr) => {
      let evolucaoSemanal = null;
      if (idx >= 7) {
        const entregas7DiasAtras = arr[idx - 7]?.total_entregas;
        if (entregas7DiasAtras > 0) {
          evolucaoSemanal = ((d.total_entregas - entregas7DiasAtras) / entregas7DiasAtras * 100).toFixed(1);
        }
      }
      return {
        ...d,
        total_os: parseInt(d.total_os) || 0,
        total_entregas: parseInt(d.total_entregas) || 0,
        dentro_prazo: parseInt(d.dentro_prazo) || 0,
        fora_prazo: parseInt(d.fora_prazo) || 0,
        taxa_prazo: parseFloat(d.taxa_prazo) || 0,
        retornos: parseInt(d.retornos) || 0,
        valor_total: parseFloat(d.valor_total) || 0,
        valor_motoboy: parseFloat(d.valor_motoboy) || 0,
        ticket_medio: parseFloat(d.ticket_medio) || 0,
        tempo_medio_entrega: parseFloat(d.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(d.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(d.tempo_medio_coleta) || 0,
        total_entregadores: parseInt(d.total_entregadores) || 0,
        media_ent_profissional: parseFloat(d.media_ent_profissional) || 0,
        evolucao_semanal: evolucaoSemanal
      };
    });
    
    // Resumo geral
    const resumoQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(*) as total_entregas,
        SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END) as total_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo_geral,
        COALESCE(SUM(valor), 0) as valor_total,
        ROUND(AVG(tempo_execucao_minutos), 1) as tempo_medio_geral,
        COUNT(DISTINCT cod_prof) as total_profissionais,
        COUNT(DISTINCT data_solicitado) as total_dias
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    res.json({
      porData: porData,
      resumo: {
        totalOS: parseInt(resumoQuery.rows[0]?.total_os) || 0,
        totalEntregas: parseInt(resumoQuery.rows[0]?.total_entregas) || 0,
        totalPrazo: parseInt(resumoQuery.rows[0]?.total_prazo) || 0,
        taxaPrazoGeral: parseFloat(resumoQuery.rows[0]?.taxa_prazo_geral) || 0,
        valorTotal: parseFloat(resumoQuery.rows[0]?.valor_total) || 0,
        tempoMedioGeral: parseFloat(resumoQuery.rows[0]?.tempo_medio_geral) || 0,
        totalProfissionais: parseInt(resumoQuery.rows[0]?.total_profissionais) || 0,
        totalDias: parseInt(resumoQuery.rows[0]?.total_dias) || 0
      }
    });
    
  } catch (error) {
    console.error('Erro acompanhamento periódico:', error);
    res.status(500).json({ error: 'Erro ao gerar acompanhamento'})   ;
  }
});

// GET - Comparativo Semanal para aba Acompanhamento
// Agrupa dados por semana e calcula variações entre semanas
router.get('/bi/comparativo-semanal', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    // Cada métrica filtra pelo ponto apropriado internamente
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
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
    
    // Agrupa por semana do ano
    const semanalQuery = await pool.query(`
      SELECT 
        EXTRACT(ISOYEAR FROM data_solicitado) as ano,
        EXTRACT(WEEK FROM data_solicitado) as semana,
        MIN(data_solicitado) as data_inicio_semana,
        MAX(data_solicitado) as data_fim_semana,
        TO_CHAR(MIN(data_solicitado), 'DD/MM') || ' - ' || TO_CHAR(MAX(data_solicitado), 'DD/MM') as periodo,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END) as dentro_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = false THEN 1 ELSE 0 END) as fora_prazo_prof,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND data_hora IS NOT NULL
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
        ), 1) as tempo_medio_entrega,
        
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
        ), 1) as tempo_medio_alocacao,
        
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
        ), 1) as tempo_medio_coleta,
        
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_entrega_prof_minutos END), 1) as tempo_medio_prof,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0)::numeric, 1) as km_total
      FROM bi_entregas
      ${whereClause}
      GROUP BY EXTRACT(ISOYEAR FROM data_solicitado), EXTRACT(WEEK FROM data_solicitado)
      ORDER BY ano DESC, semana DESC
    `, params);
    
    // Processar dados para calcular variações
    const semanas = semanalQuery.rows.map((row, idx, arr) => {
      const semanaAnterior = arr[idx + 1]; // próximo no array é a semana anterior (ordenado DESC)
      
      // Calcular variações percentuais
      const calcVariacao = (atual, anterior) => {
        if (!anterior || anterior === 0) return null;
        return ((atual - anterior) / anterior * 100).toFixed(1);
      };
      
      return {
        ano: parseInt(row.ano),
        semana: parseInt(row.semana),
        periodo: row.periodo,
        data_inicio_semana: row.data_inicio_semana,
        data_fim_semana: row.data_fim_semana,
        total_os: parseInt(row.total_os) || 0,
        total_entregas: parseInt(row.total_entregas) || 0,
        dentro_prazo: parseInt(row.dentro_prazo) || 0,
        fora_prazo: parseInt(row.fora_prazo) || 0,
        dentro_prazo_prof: parseInt(row.dentro_prazo_prof) || 0,
        fora_prazo_prof: parseInt(row.fora_prazo_prof) || 0,
        taxa_prazo: parseFloat(row.taxa_prazo) || 0,
        taxa_prazo_prof: parseFloat(row.taxa_prazo_prof) || 0,
        retornos: parseInt(row.retornos) || 0,
        valor_total: parseFloat(row.valor_total) || 0,
        valor_prof: parseFloat(row.valor_prof) || 0,
        ticket_medio: parseFloat(row.ticket_medio) || 0,
        tempo_medio_entrega: parseFloat(row.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(row.tempo_medio_coleta) || 0,
        tempo_medio_prof: parseFloat(row.tempo_medio_prof) || 0,
        total_entregadores: parseInt(row.total_entregadores) || 0,
        media_ent_profissional: parseFloat(row.media_ent_profissional) || 0,
        km_total: parseFloat(row.km_total) || 0,
        // Variações em relação à semana anterior
        var_entregas: calcVariacao(parseInt(row.total_entregas), semanaAnterior ? parseInt(semanaAnterior.total_entregas) : null),
        var_os: calcVariacao(parseInt(row.total_os), semanaAnterior ? parseInt(semanaAnterior.total_os) : null),
        var_valor: calcVariacao(parseFloat(row.valor_total), semanaAnterior ? parseFloat(semanaAnterior.valor_total) : null),
        var_prazo: semanaAnterior ? (parseFloat(row.taxa_prazo) - parseFloat(semanaAnterior.taxa_prazo)).toFixed(1) : null,
        var_prazo_prof: semanaAnterior ? (parseFloat(row.taxa_prazo_prof) - parseFloat(semanaAnterior.taxa_prazo_prof)).toFixed(1) : null,
        var_retornos: calcVariacao(parseInt(row.retornos), semanaAnterior ? parseInt(semanaAnterior.retornos) : null),
        // Dados da semana anterior para comparativo lado a lado
        anterior: semanaAnterior ? {
          total_entregas: parseInt(semanaAnterior.total_entregas) || 0,
          total_os: parseInt(semanaAnterior.total_os) || 0,
          taxa_prazo: parseFloat(semanaAnterior.taxa_prazo) || 0,
          taxa_prazo_prof: parseFloat(semanaAnterior.taxa_prazo_prof) || 0,
          valor_total: parseFloat(semanaAnterior.valor_total) || 0,
          retornos: parseInt(semanaAnterior.retornos) || 0
        } : null
      };
    });
    
    // Resumo geral (todas as semanas)
    const totalSemanas = semanas.length;
    const mediaEntregasSemana = totalSemanas > 0 ? Math.round(semanas.reduce((a, s) => a + s.total_entregas, 0) / totalSemanas) : 0;
    const melhorSemana = semanas.reduce((best, s) => (!best || s.total_entregas > best.total_entregas) ? s : best, null);
    const piorSemana = semanas.reduce((worst, s) => (!worst || s.total_entregas < worst.total_entregas) ? s : worst, null);
    
    res.json({
      semanas: semanas,
      resumo: {
        total_semanas: totalSemanas,
        media_entregas_semana: mediaEntregasSemana,
        melhor_semana: melhorSemana ? { periodo: melhorSemana.periodo, entregas: melhorSemana.total_entregas } : null,
        pior_semana: piorSemana ? { periodo: piorSemana.periodo, entregas: piorSemana.total_entregas } : null
      }
    });
    
  } catch (error) {
    console.error('Erro comparativo semanal:', error);
    res.status(500).json({ error: 'Erro ao gerar comparativo semanal'})   ;
  }
});

// GET - Comparativo semanal POR CLIENTE (detalhado)
router.get('/bi/comparativo-semanal-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo } = req.query;
    
    // Removido filtro ponto >= 2 para permitir cálculo de alocação (ponto=1) e coleta (ponto=1)
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
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
    
    // Agrupa por nome_fantasia E semana do ano (como Power BI)
    const semanalQuery = await pool.query(`
      SELECT 
        nome_fantasia,
        EXTRACT(ISOYEAR FROM data_solicitado) as ano,
        EXTRACT(WEEK FROM data_solicitado) as semana,
        MIN(data_solicitado) as data_inicio_semana,
        MAX(data_solicitado) as data_fim_semana,
        TO_CHAR(MIN(data_solicitado), 'DD/MM') || ' - ' || TO_CHAR(MAX(data_solicitado), 'DD/MM') as periodo,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as dentro_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END) as dentro_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = false THEN 1 ELSE 0 END) as fora_prazo_prof,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo_prof = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo_prof,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2) as ticket_medio,
        
        -- TEMPO MÉDIO ENTREGA (Ponto >= 2)
        ROUND(AVG(
          CASE 
            WHEN COALESCE(ponto, 1) >= 2
                 AND data_chegada IS NOT NULL 
                 AND hora_chegada IS NOT NULL
                 AND data_hora IS NOT NULL
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
        ), 1) as tempo_medio_entrega,
        
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
        ), 1) as tempo_medio_alocacao,
        
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
        ), 1) as tempo_medio_coleta,
        
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_entrega_prof_minutos END), 1) as tempo_medio_prof,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_entregadores,
        ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 1) as media_ent_profissional
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_fantasia, EXTRACT(ISOYEAR FROM data_solicitado), EXTRACT(WEEK FROM data_solicitado)
      ORDER BY nome_fantasia, ano DESC, semana DESC
    `, params);
    
    // Agrupar por nome_fantasia (não por cod_cliente)
    const clientesMap = {};
    semanalQuery.rows.forEach(row => {
      const key = row.nome_fantasia;
      if (!clientesMap[key]) {
        clientesMap[key] = {
          nome_fantasia: row.nome_fantasia,
          semanas: []
        };
      }
      clientesMap[key].semanas.push(row);
    });
    
    // Processar dados para calcular variações por cliente
    const clientes = Object.values(clientesMap).map(cliente => {
      const semanas = cliente.semanas.map((row, idx, arr) => {
        const semanaAnterior = arr[idx + 1];
        
        const calcVariacao = (atual, anterior) => {
          if (!anterior || anterior === 0) return null;
          return ((atual - anterior) / anterior * 100).toFixed(1);
        };
        
        return {
          ano: parseInt(row.ano),
          semana: parseInt(row.semana),
          periodo: row.periodo,
          total_os: parseInt(row.total_os) || 0,
          total_entregas: parseInt(row.total_entregas) || 0,
          dentro_prazo: parseInt(row.dentro_prazo) || 0,
          fora_prazo: parseInt(row.fora_prazo) || 0,
          taxa_prazo: parseFloat(row.taxa_prazo) || 0,
          taxa_prazo_prof: parseFloat(row.taxa_prazo_prof) || 0,
          retornos: parseInt(row.retornos) || 0,
          valor_total: parseFloat(row.valor_total) || 0,
          valor_prof: parseFloat(row.valor_prof) || 0,
          ticket_medio: parseFloat(row.ticket_medio) || 0,
          tempo_medio_entrega: parseFloat(row.tempo_medio_entrega) || 0,
          tempo_medio_alocacao: parseFloat(row.tempo_medio_alocacao) || 0,
          tempo_medio_coleta: parseFloat(row.tempo_medio_coleta) || 0,
          tempo_medio_prof: parseFloat(row.tempo_medio_prof) || 0,
          total_entregadores: parseInt(row.total_entregadores) || 0,
          media_ent_profissional: parseFloat(row.media_ent_profissional) || 0,
          var_entregas: calcVariacao(parseInt(row.total_entregas), semanaAnterior ? parseInt(semanaAnterior.total_entregas) : null),
          var_valor: calcVariacao(parseFloat(row.valor_total), semanaAnterior ? parseFloat(semanaAnterior.valor_total) : null),
          var_prazo: semanaAnterior ? (parseFloat(row.taxa_prazo) - parseFloat(semanaAnterior.taxa_prazo)).toFixed(1) : null,
          var_retornos: calcVariacao(parseInt(row.retornos), semanaAnterior ? parseInt(semanaAnterior.retornos) : null)
        };
      });
      
      // Calcular totais do cliente
      const totalEntregas = semanas.reduce((a, s) => a + s.total_entregas, 0);
      const mediaEntregas = semanas.length > 0 ? Math.round(totalEntregas / semanas.length) : 0;
      const mediaPrazo = semanas.length > 0 ? (semanas.reduce((a, s) => a + s.taxa_prazo, 0) / semanas.length).toFixed(1) : 0;
      
      return {
        nome_fantasia: cliente.nome_fantasia,
        semanas: semanas,
        resumo: {
          total_semanas: semanas.length,
          total_entregas: totalEntregas,
          media_entregas_semana: mediaEntregas,
          media_taxa_prazo: parseFloat(mediaPrazo)
        }
      };
    });
    
    // Ordenar por total de entregas (maiores primeiro)
    clientes.sort((a, b) => b.resumo.total_entregas - a.resumo.total_entregas);
    
    res.json({
      clientes: clientes,
      total_clientes: clientes.length
    });
    
  } catch (error) {
    console.error('Erro comparativo semanal por cliente:', error);
    res.status(500).json({ error: 'Erro ao gerar comparativo semanal por cliente'})   ;
  }
});

// GET - Dados agrupados por cliente para tabela de acompanhamento
// IMPORTANTE: Agrupa por NOME_FANTASIA (como o Power BI) e não por cod_cliente
// IMPORTANTE: Calcula média de tempo POR OS (não por linha/ponto)
// IMPORTANTE: Tempo de entrega usa Data Chegada + Hora Chegada (não Finalizado)
router.get('/bi/acompanhamento-clientes', async (req, res) => {
  try {
    const { data_inicio, data_fim, cod_cliente, centro_custo, categoria, status_retorno } = req.query;
    
    // Não filtramos por Ponto aqui para incluir coletas (Ponto 1) e entregas (Ponto >= 2)
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
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
      whereClause += ` AND categoria = $${paramIndex}`;
      params.push(categoria);
      paramIndex++;
    }
    // Filtro de retorno - usar mesma lógica da função isRetorno
    if (status_retorno === 'com_retorno') {
      whereClause += ` AND os IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    } else if (status_retorno === 'sem_retorno') {
      whereClause += ` AND os NOT IN (SELECT DISTINCT os FROM bi_entregas WHERE LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%')`;
    }
    
    // Buscar dados agrupados por COD_CLIENTE - Média direta de todas as linhas (igual ao Dashboard)
    const clientesQuery = await pool.query(`
      SELECT 
        cod_cliente,
        MAX(COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente)) as nome_display,
        COUNT(DISTINCT os) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as faturamento_total,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
              NULLIF(COUNT(DISTINCT os), 0), 2) as ticket_medio,
        -- TEMPO MÉDIO ENTREGA: média direta de todas as linhas (Ponto >= 2)
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
        ), 2) as tempo_medio_entrega_min,
        -- TEMPO MÉDIO ALOCAÇÃO: média direta de todas as linhas (Ponto = 1)
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
        ), 2) as tempo_medio_alocacao_min,
        -- TEMPO MÉDIO COLETA: média direta de todas as linhas (Ponto = 1)
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
        ), 2) as tempo_medio_coleta_min,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY cod_cliente
      ORDER BY total_entregas DESC
    `, params);
    
    // Calcular totais com média direta (igual ao Dashboard)
    const totaisQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT os) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 2) as taxa_fora_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as retornos,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as faturamento_total,
        ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / NULLIF(COUNT(DISTINCT os), 0), 2) as ticket_medio,
        -- TEMPO MÉDIO ENTREGA: média direta de todas as linhas
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
        ), 2) as tempo_medio_entrega_min,
        -- TEMPO MÉDIO ALOCAÇÃO
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
        ), 2) as tempo_medio_alocacao_min,
        -- TEMPO MÉDIO COLETA
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
        ), 2) as tempo_medio_coleta_min,
        COUNT(DISTINCT cod_prof) as total_profissionais
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    // Formatar tempo em HH:MM:SS
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    const clientes = clientesQuery.rows.map(c => ({
      cliente: c.nome_display,
      cod_cliente: parseInt(c.cod_cliente),
      os: parseInt(c.total_os) || 0,
      entregas: parseInt(c.total_entregas) || 0,
      entregasNoPrazo: parseInt(c.entregas_no_prazo) || 0,
      entregasForaPrazo: parseInt(c.entregas_fora_prazo) || 0,
      noPrazo: parseFloat(c.taxa_no_prazo) || 0,
      foraPrazo: parseFloat(c.taxa_fora_prazo) || 0,
      retornos: parseInt(c.retornos) || 0,
      valorTotal: parseFloat(c.valor_total) || 0,
      valorProf: parseFloat(c.valor_prof) || 0,
      faturamentoTotal: parseFloat(c.faturamento_total) || 0,
      ticketMedio: parseFloat(c.ticket_medio) || 0,
      tempoMedioEntrega: formatarTempo(parseFloat(c.tempo_medio_entrega_min)),
      tempoMedioAlocacao: formatarTempo(parseFloat(c.tempo_medio_alocacao_min)),
      tempoMedioColeta: formatarTempo(parseFloat(c.tempo_medio_coleta_min)),
      totalProfissionais: parseInt(c.total_profissionais) || 0,
      mediaEntProfissional: ((parseInt(c.total_entregas) || 0) / Math.max(parseInt(c.total_profissionais) || 1, 1)).toFixed(1),
      centros_custo: [] // Será preenchido abaixo
    }));
    
    // Buscar centros de custo por cliente
    const centrosCustoQuery = await pool.query(`
      WITH tempo_por_os AS (
        SELECT 
          os,
          cod_cliente,
          centro_custo,
          -- Métricas de ENTREGA (Ponto >= 2)
          MIN(CASE WHEN COALESCE(ponto, 1) >= 2 THEN dentro_prazo::int END) as dentro_prazo,
          MAX(CASE WHEN COALESCE(ponto, 1) >= 2 AND (LOWER(ocorrencia) LIKE '%cliente fechado%' OR LOWER(ocorrencia) LIKE '%clienteaus%' OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%' OR LOWER(ocorrencia) LIKE '%produto incorreto%' OR LOWER(ocorrencia) LIKE '%retorno%') THEN 1 ELSE 0 END) as eh_retorno,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END) as valor_os,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END) as valor_prof_os,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas_os,
          AVG(
            CASE 
              WHEN COALESCE(ponto, 1) >= 2
                   AND data_hora IS NOT NULL 
                   AND data_chegada IS NOT NULL 
                   AND hora_chegada IS NOT NULL
              THEN
                EXTRACT(EPOCH FROM (
                  (data_chegada + hora_chegada) - 
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
          ) as tempo_entrega_min
        FROM bi_entregas
        ${whereClause}
        AND centro_custo IS NOT NULL AND centro_custo != ''
        GROUP BY os, cod_cliente, centro_custo
      )
      SELECT 
        cod_cliente,
        centro_custo,
        COUNT(DISTINCT os) as total_os,
        SUM(total_entregas_os) as total_entregas,
        SUM(CASE WHEN dentro_prazo = 1 THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN dentro_prazo = 0 THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = 1 THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(total_entregas_os), 0) * 100, 2) as taxa_no_prazo,
        ROUND(SUM(CASE WHEN dentro_prazo = 0 THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(total_entregas_os), 0) * 100, 2) as taxa_fora_prazo,
        SUM(eh_retorno) as retornos,
        COALESCE(SUM(valor_os), 0) as valor_total,
        COALESCE(SUM(valor_prof_os), 0) as valor_prof,
        ROUND(AVG(tempo_entrega_min), 2) as tempo_medio_entrega_min
      FROM tempo_por_os
      GROUP BY cod_cliente, centro_custo
      ORDER BY cod_cliente, total_entregas DESC
    `, params);
    
    // Mapear centros de custo para os clientes
    centrosCustoQuery.rows.forEach(cc => {
      const codCliente = parseInt(cc.cod_cliente);
      const cliente = clientes.find(c => c.cod_cliente === codCliente);
      if (cliente) {
        cliente.centros_custo.push({
          centro_custo: cc.centro_custo,
          total_os: parseInt(cc.total_os) || 0,
          total_entregas: parseInt(cc.total_entregas) || 0,
          dentro_prazo: parseInt(cc.entregas_no_prazo) || 0,
          fora_prazo: parseInt(cc.entregas_fora_prazo) || 0,
          taxa_no_prazo: parseFloat(cc.taxa_no_prazo) || 0,
          taxa_fora_prazo: parseFloat(cc.taxa_fora_prazo) || 0,
          retornos: parseInt(cc.retornos) || 0,
          valor_total: parseFloat(cc.valor_total) || 0,
          valor_prof: parseFloat(cc.valor_prof) || 0,
          tempo_medio: formatarTempo(parseFloat(cc.tempo_medio_entrega_min))
        });
      }
    });
    
    const totais = {
      os: parseInt(totaisQuery.rows[0]?.total_os) || 0,
      entregas: parseInt(totaisQuery.rows[0]?.total_entregas) || 0,
      entregasNoPrazo: parseInt(totaisQuery.rows[0]?.entregas_no_prazo) || 0,
      entregasForaPrazo: parseInt(totaisQuery.rows[0]?.entregas_fora_prazo) || 0,
      noPrazo: parseFloat(totaisQuery.rows[0]?.taxa_no_prazo) || 0,
      foraPrazo: parseFloat(totaisQuery.rows[0]?.taxa_fora_prazo) || 0,
      retornos: parseInt(totaisQuery.rows[0]?.retornos) || 0,
      valorTotal: parseFloat(totaisQuery.rows[0]?.valor_total) || 0,
      valorProf: parseFloat(totaisQuery.rows[0]?.valor_prof) || 0,
      faturamentoTotal: parseFloat(totaisQuery.rows[0]?.faturamento_total) || 0,
      ticketMedio: parseFloat(totaisQuery.rows[0]?.ticket_medio) || 0,
      tempoMedioEntrega: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_entrega_min)),
      tempoMedioAlocacao: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_alocacao_min)),
      tempoMedioColeta: formatarTempo(parseFloat(totaisQuery.rows[0]?.tempo_medio_coleta_min)),
      totalProfissionais: parseInt(totaisQuery.rows[0]?.total_profissionais) || 0,
      mediaEntProfissional: ((parseInt(totaisQuery.rows[0]?.total_entregas) || 0) / Math.max(parseInt(totaisQuery.rows[0]?.total_profissionais) || 1, 1)).toFixed(1)
    };
    
    res.json({ clientes, totais });
    
  } catch (error) {
    console.error('Erro acompanhamento clientes:', error);
    res.status(500).json({ error: 'Erro ao buscar dados de clientes'})   ;
  }
});

// ============================================
// ENDPOINT ESPECIAL: Cliente 767 com prazo de 120 minutos
// ============================================
router.get('/bi/cliente-767', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const PRAZO_767 = 120; // Prazo específico de 120 minutos para cliente 767
    
    // Primeiro, buscar todos os centros de custo disponíveis para o cliente 767
    const centrosCustoQuery = await pool.query(`
      SELECT DISTINCT centro_custo 
      FROM bi_entregas 
      WHERE cod_cliente = 767 AND centro_custo IS NOT NULL AND centro_custo != ''
      ORDER BY centro_custo
    `);
    const centrosCustoDisponiveis = centrosCustoQuery.rows.map(r => r.centro_custo);
    
    let whereClause = 'WHERE cod_cliente = 767';
    const params = [];
    let paramIndex = 1;
    
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
    
    // Filtro por centro de custo (pode ser um ou vários separados por vírgula)
    const { centro_custo } = req.query;
    if (centro_custo) {
      const centros = centro_custo.split(',').map(c => c.trim()).filter(c => c);
      if (centros.length > 0) {
        whereClause += ` AND centro_custo IN (${centros.map((_, i) => `$${paramIndex + i}`).join(',')})`;
        params.push(...centros);
        paramIndex += centros.length;
      }
    }
    
    // Buscar dados do cliente 767
    const dadosQuery = await pool.query(`
      SELECT 
        os, 
        COALESCE(ponto, 1) as ponto, 
        cod_cliente, 
        nome_cliente,
        nome_fantasia,
        cod_prof, 
        nome_prof, 
        valor, 
        valor_prof, 
        distancia,
        ocorrencia, 
        centro_custo, 
        motivo, 
        finalizado,
        data_hora, 
        data_hora_alocado, 
        data_chegada, 
        hora_chegada,
        data_solicitado
      FROM bi_entregas 
      ${whereClause}
    `, params);
    
    const dados = dadosQuery.rows;
    console.log('📊 Cliente 767: Total registros:', dados.length);
    
    // Função para calcular tempo de entrega
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
    
    // Função para calcular tempo de coleta (Alocado -> Saída conforme DAX)
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
    
    // Função para calcular tempo de alocação
    const calcularTempoAlocacao = (row) => {
      const pontoNum = parseInt(row.ponto) || 1;
      if (pontoNum !== 1) return null;
      
      if (!row.data_hora || !row.data_hora_alocado) return null;
      
      const solicitado = new Date(row.data_hora);
      const alocado = new Date(row.data_hora_alocado);
      
      if (alocado < solicitado) return null;
      
      const horaSolicitado = solicitado.getHours();
      const depoisDas17 = horaSolicitado >= 17;
      const diaSolicitado = solicitado.toISOString().split('T')[0];
      const diaAlocado = alocado.toISOString().split('T')[0];
      const mesmaData = diaSolicitado === diaAlocado;
      
      let inicioContagem = solicitado;
      if (depoisDas17 && !mesmaData) {
        inicioContagem = new Date(alocado);
        inicioContagem.setHours(8, 0, 0, 0);
      }
      
      const difMinutos = (alocado - inicioContagem) / (1000 * 60);
      return difMinutos >= 0 ? difMinutos : null;
    };
    
    // Função para formatar tempo em HH:MM:SS (igual ao Acompanhamento)
    const formatarTempo = (minutos) => {
      if (!minutos || minutos <= 0 || isNaN(minutos)) return '00:00:00';
      const totalSeg = Math.round(minutos * 60);
      const h = Math.floor(totalSeg / 3600);
      const m = Math.floor((totalSeg % 3600) / 60);
      const s = totalSeg % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    
    // Agrupar por OS
    const osPorOS = {};
    dados.forEach(row => {
      const os = row.os;
      if (!osPorOS[os]) osPorOS[os] = [];
      osPorOS[os].push(row);
    });
    
    // Calcular métricas com prazo de 120 minutos
    let totalOS = new Set();
    let totalEntregas = 0, dentroPrazo = 0, foraPrazo = 0;
    let somaValor = 0, somaValorProf = 0;
    let somaTempoEntrega = 0, countTempoEntrega = 0;
    let somaTempoAlocacao = 0, countTempoAlocacao = 0;
    let somaTempoColeta = 0, countTempoColeta = 0;
    let profissionais = new Set();
    let totalRetornos = 0;
    
    // Dados por data para gráfico
    const porDataMap = {};
    
    Object.keys(osPorOS).forEach(os => {
      const linhasOS = osPorOS[os];
      totalOS.add(os);
      
      // Contagem de entregas (pontos >= 2)
      const entregasOS = linhasOS.filter(l => (parseInt(l.ponto) || 1) >= 2).length || 1;
      totalEntregas += entregasOS;
      
      linhasOS.forEach(row => {
        profissionais.add(row.cod_prof);
        
        const ocorrencia = (row.ocorrencia || '').toLowerCase();
        if (ocorrencia.includes('cliente fechado') || ocorrencia.includes('cliente ausente') || 
            ocorrencia.includes('loja fechada') || ocorrencia.includes('produto incorreto')) {
          totalRetornos++;
        }
        
        // Calcular tempos
        const tempoEnt = calcularTempoEntrega(row);
        if (tempoEnt !== null) {
          somaTempoEntrega += tempoEnt;
          countTempoEntrega++;
          
          // Verificar prazo de 120 minutos
          if (tempoEnt <= PRAZO_767) {
            dentroPrazo++;
          } else {
            foraPrazo++;
          }
        }
        
        const tempoAloc = calcularTempoAlocacao(row);
        if (tempoAloc !== null) {
          somaTempoAlocacao += tempoAloc;
          countTempoAlocacao++;
        }
        
        const tempoCol = calcularTempoColeta(row);
        if (tempoCol !== null) {
          somaTempoColeta += tempoCol;
          countTempoColeta++;
        }
        
        // Agrupar por data
        const data = row.data_solicitado;
        if (data) {
          if (!porDataMap[data]) {
            porDataMap[data] = {
              data_solicitado: data,
              total_os: new Set(),
              total_entregas: 0,
              dentro_prazo: 0,
              fora_prazo: 0,
              soma_tempo_entrega: 0,
              count_tempo_entrega: 0,
              soma_tempo_alocacao: 0,
              count_tempo_alocacao: 0,
              soma_tempo_coleta: 0,
              count_tempo_coleta: 0,
              soma_valor: 0,
              soma_valor_prof: 0,
              retornos: 0,
              profissionais: new Set()
            };
          }
          porDataMap[data].total_os.add(os);
          porDataMap[data].profissionais.add(row.cod_prof);
          
          if ((parseInt(row.ponto) || 1) >= 2) {
            porDataMap[data].total_entregas++;
          }
          
          if (tempoEnt !== null) {
            porDataMap[data].soma_tempo_entrega += tempoEnt;
            porDataMap[data].count_tempo_entrega++;
            if (tempoEnt <= PRAZO_767) {
              porDataMap[data].dentro_prazo++;
            } else {
              porDataMap[data].fora_prazo++;
            }
          }
          
          if (tempoAloc !== null) {
            porDataMap[data].soma_tempo_alocacao += tempoAloc;
            porDataMap[data].count_tempo_alocacao++;
          }
          
          if (tempoCol !== null) {
            porDataMap[data].soma_tempo_coleta += tempoCol;
            porDataMap[data].count_tempo_coleta++;
          }
        }
      });
      
      // Valores (1x por OS)
      const linhaValor = linhasOS.reduce((maior, atual) => {
        return (parseInt(atual.ponto) || 0) > (parseInt(maior?.ponto) || 0) ? atual : maior;
      }, linhasOS[0]);
      
      somaValor += parseFloat(linhaValor?.valor) || 0;
      somaValorProf += parseFloat(linhaValor?.valor_prof) || 0;
      
      // Valor por data
      const data = linhaValor?.data_solicitado;
      if (data && porDataMap[data]) {
        porDataMap[data].soma_valor += parseFloat(linhaValor?.valor) || 0;
        porDataMap[data].soma_valor_prof += parseFloat(linhaValor?.valor_prof) || 0;
      }
    });
    
    // Formatar dados por data
    const porData = Object.keys(porDataMap).sort().map(data => {
      const d = porDataMap[data];
      const totalEnt = d.total_entregas || 1;
      return {
        data_solicitado: data,
        data_formatada: new Date(data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        total_os: d.total_os.size,
        total_entregas: d.total_entregas,
        dentro_prazo: d.dentro_prazo,
        fora_prazo: d.fora_prazo,
        taxa_prazo: d.count_tempo_entrega > 0 ? ((d.dentro_prazo / d.count_tempo_entrega) * 100).toFixed(1) : 0,
        tempo_medio_entrega: d.count_tempo_entrega > 0 ? formatarTempo(d.soma_tempo_entrega / d.count_tempo_entrega) : '00:00:00',
        tempo_medio_alocacao: d.count_tempo_alocacao > 0 ? formatarTempo(d.soma_tempo_alocacao / d.count_tempo_alocacao) : '00:00:00',
        tempo_medio_coleta: d.count_tempo_coleta > 0 ? formatarTempo(d.soma_tempo_coleta / d.count_tempo_coleta) : '00:00:00',
        valor_total: d.soma_valor,
        valor_motoboy: d.soma_valor_prof,
        ticket_medio: d.total_os.size > 0 ? (d.soma_valor / d.total_os.size).toFixed(2) : 0,
        total_entregadores: d.profissionais.size
      };
    });
    
    // =============================================
    // DADOS POR CENTRO DE CUSTO
    // =============================================
    const porCentroCustoMap = {};
    
    Object.keys(osPorOS).forEach(os => {
      const linhasOS = osPorOS[os];
      
      linhasOS.forEach(row => {
        const centroCusto = row.centro_custo || 'Sem Centro de Custo';
        
        if (!porCentroCustoMap[centroCusto]) {
          porCentroCustoMap[centroCusto] = {
            centro_custo: centroCusto,
            total_os: new Set(),
            total_entregas: 0,
            dentro_prazo: 0,
            fora_prazo: 0,
            count_tempo: 0
          };
        }
        
        porCentroCustoMap[centroCusto].total_os.add(os);
        
        if ((parseInt(row.ponto) || 1) >= 2) {
          porCentroCustoMap[centroCusto].total_entregas++;
        }
        
        // Calcular tempo de entrega para verificar prazo
        const tempoEnt = calcularTempoEntrega(row);
        if (tempoEnt !== null) {
          porCentroCustoMap[centroCusto].count_tempo++;
          if (tempoEnt <= PRAZO_767) {
            porCentroCustoMap[centroCusto].dentro_prazo++;
          } else {
            porCentroCustoMap[centroCusto].fora_prazo++;
          }
        }
      });
    });
    
    // Formatar dados por centro de custo
    const porCentroCusto = Object.values(porCentroCustoMap).map(cc => ({
      centro_custo: cc.centro_custo,
      total_os: cc.total_os.size,
      total_entregas: cc.total_entregas,
      dentro_prazo: cc.dentro_prazo,
      fora_prazo: cc.fora_prazo,
      taxa_prazo: cc.count_tempo > 0 ? ((cc.dentro_prazo / cc.count_tempo) * 100).toFixed(1) : 0
    })).sort((a, b) => b.total_entregas - a.total_entregas);
    
    // =============================================
    // CÁLCULO DE META MENSAL (95%)
    // =============================================
    const META_MENSAL = 95; // Meta de 95%
    
    // Usar sempre a data atual para o cálculo de dias restantes
    const hoje = new Date();
    const diaAtual = hoje.getDate();
    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();
    
    // Determinar o mês de referência (do filtro ou mês atual)
    let mesReferencia, anoReferencia;
    if (data_inicio) {
      const dataRef = new Date(data_inicio);
      mesReferencia = dataRef.getMonth();
      anoReferencia = dataRef.getFullYear();
    } else {
      mesReferencia = mesAtual;
      anoReferencia = anoAtual;
    }
    
    // Calcular dias do mês
    const ultimoDiaMes = new Date(anoReferencia, mesReferencia + 1, 0).getDate();
    
    // Dias passados baseado no dia atual do mês
    let diasPassados;
    const mesmoMesAno = (mesReferencia === mesAtual && anoReferencia === anoAtual);
    
    if (mesmoMesAno) {
      // Estamos no mês atual - usar o dia de hoje
      diasPassados = diaAtual;
    } else if (anoReferencia < anoAtual || (anoReferencia === anoAtual && mesReferencia < mesAtual)) {
      // Mês passado - todos os dias já passaram
      diasPassados = ultimoDiaMes;
    } else {
      // Mês futuro - nenhum dia passou
      diasPassados = 0;
    }
    
    // Dias restantes = total de dias do mês - dia atual
    const diasRestantes = Math.max(0, ultimoDiaMes - diasPassados);
    
    // Total de entregas e dentro do prazo até agora
    const totalEntregasAteAgora = countTempoEntrega;
    const dentroPrazoAteAgora = dentroPrazo;
    const taxaAtual = totalEntregasAteAgora > 0 ? (dentroPrazoAteAgora / totalEntregasAteAgora) * 100 : 0;
    
    // Estimar média de entregas por dia (baseado nos dias que tiveram entregas)
    const diasComDados = porData.length || 1;
    const mediaEntregasPorDia = diasComDados > 0 ? totalEntregasAteAgora / diasComDados : 0;
    const entregasEstimadasRestantes = Math.round(mediaEntregasPorDia * diasRestantes);
    const totalEntregasEstimadoMes = totalEntregasAteAgora + entregasEstimadasRestantes;
    
    // Calcular quantas entregas no prazo são necessárias para atingir 95%
    const entregasNoPrazoNecessariasMes = Math.ceil(totalEntregasEstimadoMes * (META_MENSAL / 100));
    const entregasNoPrazoFaltam = Math.max(0, entregasNoPrazoNecessariasMes - dentroPrazoAteAgora);
    
    // Calcular a taxa mínima necessária nos dias restantes
    let taxaMinimaRestante = 0;
    let metaAtingivel = true;
    let mensagemMeta = '';
    
    if (diasRestantes > 0 && entregasEstimadasRestantes > 0) {
      taxaMinimaRestante = (entregasNoPrazoFaltam / entregasEstimadasRestantes) * 100;
      
      if (taxaMinimaRestante > 100) {
        metaAtingivel = false;
        mensagemMeta = 'Meta de 95% não é mais atingível este mês';
      } else if (taxaMinimaRestante <= 0) {
        taxaMinimaRestante = 0;
        mensagemMeta = 'Meta de 95% já foi atingida!';
      } else {
        mensagemMeta = `Precisa de ${taxaMinimaRestante.toFixed(1)}% nos próximos ${diasRestantes} dias`;
      }
    } else if (diasRestantes === 0) {
      mensagemMeta = taxaAtual >= META_MENSAL ? 'Meta atingida!' : 'Mês encerrado - meta não atingida';
      metaAtingivel = taxaAtual >= META_MENSAL;
    }
    
    const indicadorMeta = {
      meta_mensal: META_MENSAL,
      mes_referencia: new Date(anoReferencia, mesReferencia, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
      dia_atual: diaAtual,
      dias_mes: ultimoDiaMes,
      dias_passados: diasPassados,
      dias_restantes: diasRestantes,
      taxa_atual: parseFloat(taxaAtual.toFixed(1)),
      total_entregas_ate_agora: totalEntregasAteAgora,
      dentro_prazo_ate_agora: dentroPrazoAteAgora,
      media_entregas_dia: parseFloat(mediaEntregasPorDia.toFixed(1)),
      entregas_estimadas_restantes: entregasEstimadasRestantes,
      total_estimado_mes: totalEntregasEstimadoMes,
      entregas_no_prazo_necessarias: entregasNoPrazoNecessariasMes,
      entregas_no_prazo_faltam: entregasNoPrazoFaltam,
      taxa_minima_restante: parseFloat(taxaMinimaRestante.toFixed(1)),
      meta_atingivel: metaAtingivel,
      mensagem: mensagemMeta
    };
    
    // Métricas gerais
    const metricas = {
      total_os: totalOS.size,
      total_entregas: totalEntregas,
      dentro_prazo: dentroPrazo,
      fora_prazo: foraPrazo,
      taxa_prazo: countTempoEntrega > 0 ? ((dentroPrazo / countTempoEntrega) * 100).toFixed(1) : 0,
      tempo_medio: countTempoEntrega > 0 ? formatarTempo(somaTempoEntrega / countTempoEntrega) : '00:00:00',
      tempo_medio_alocacao: countTempoAlocacao > 0 ? formatarTempo(somaTempoAlocacao / countTempoAlocacao) : '00:00:00',
      tempo_medio_coleta: countTempoColeta > 0 ? formatarTempo(somaTempoColeta / countTempoColeta) : '00:00:00',
      valor_total: somaValor.toFixed(2),
      valor_prof_total: somaValorProf.toFixed(2),
      ticket_medio: totalOS.size > 0 ? (somaValor / totalOS.size).toFixed(2) : 0,
      total_profissionais: profissionais.size,
      media_entregas_por_prof: profissionais.size > 0 ? (totalEntregas / profissionais.size).toFixed(2) : 0,
      total_retornos: totalRetornos,
      prazo_minutos: PRAZO_767
    };
    
    res.json({
      metricas,
      porData,
      porCentroCusto,
      indicadorMeta,
      centrosCustoDisponiveis,
      prazo: PRAZO_767,
      cliente: {
        cod_cliente: 767,
        nome: dados[0]?.nome_cliente || dados[0]?.nome_fantasia || 'Cliente 767'
      }
    });
    
  } catch (error) {
    console.error('Erro cliente 767:', error);
    res.status(500).json({ error: 'Erro ao buscar dados do cliente 767'})   ;
  }
});



  return router;
}

module.exports = { createAnalyticsRoutes };
