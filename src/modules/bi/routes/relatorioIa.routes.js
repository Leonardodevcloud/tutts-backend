/**
 * BI Sub-Router: Relatório IA e Exportação Word
 * Auto-extracted from bi.routes.js monolith
 */
const express = require('express');

function createRelatorioIaRoutes(pool) {
  const router = express.Router();

router.get('/bi/relatorio-ia', async (req, res) => {
  try {
    const { data_inicio, data_fim, prompt_custom } = req.query;
    // Suportar múltiplos tipos
    const tipos = req.query.tipo ? (Array.isArray(req.query.tipo) ? req.query.tipo : [req.query.tipo]) : ['performance'];
    const cod_cliente = req.query.cod_cliente ? (Array.isArray(req.query.cod_cliente) ? req.query.cod_cliente : [req.query.cod_cliente]) : [];
    const centro_custo = req.query.centro_custo ? (Array.isArray(req.query.centro_custo) ? req.query.centro_custo : [req.query.centro_custo]) : [];
    
    console.log(`🤖 Gerando relatório IA: tipos=${tipos.join(', ')}, período=${data_inicio} a ${data_fim}`);
    
    // Verificar se tem API key do Gemini
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(400).json({ error: 'API Key do Gemini não configurada. Adicione GEMINI_API_KEY nas variáveis de ambiente.' });
    }
    
    // Construir filtro WHERE
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
    if (cod_cliente.length > 0) {
      whereClause += ` AND cod_cliente = ANY($${paramIndex}::int[])`;
      params.push(cod_cliente.map(c => parseInt(c)));
      paramIndex++;
    }
    if (centro_custo.length > 0) {
      whereClause += ` AND centro_custo = ANY($${paramIndex}::text[])`;
      params.push(centro_custo);
      paramIndex++;
    }
    
    // 1. Buscar métricas gerais (EXPANDIDO)
    const metricasQuery = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END) as total_os,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2) as taxa_prazo,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END), 2) as tempo_medio_entrega,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END), 2) as tempo_medio_alocacao,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_entrega_prof_minutos > 0 AND tempo_entrega_prof_minutos <= 300 THEN tempo_entrega_prof_minutos END), 2) as tempo_medio_coleta,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as total_profissionais,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_cliente END) as total_clientes,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 2) as km_medio,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END) as total_retornos,
        MIN(data_solicitado) as data_inicio_real,
        MAX(data_solicitado) as data_fim_real
      FROM bi_entregas
      ${whereClause}
    `, params);
    
    const metricas = metricasQuery.rows[0];
    
    // 2. Buscar dados por dia
    const porDiaQuery = await pool.query(`
      SELECT 
        data_solicitado as data,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor,
        COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais
      FROM bi_entregas
      ${whereClause}
      GROUP BY data_solicitado
      ORDER BY data_solicitado
    `, params);
    
    // 3. Buscar top clientes (com mais dados)
    const topClientesQuery = await pool.query(`
      SELECT 
        nome_fantasia as cliente,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 1) as km_medio,
        SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
          LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
          LOWER(ocorrencia) LIKE '%clienteaus%' OR 
          LOWER(ocorrencia) LIKE '%cliente ausente%'
        ) THEN 1 ELSE 0 END) as retornos
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_fantasia
      ORDER BY COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) DESC
      LIMIT 10
    `, params);
    
    // 4. Buscar top profissionais (com mais dados)
    const topProfsQuery = await pool.query(`
      SELECT 
        nome_prof as profissional,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
        COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_recebido
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_prof
      ORDER BY COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) DESC
      LIMIT 10
    `, params);
    
    // 5. Buscar piores profissionais (taxa baixa)
    const pioresProfsQuery = await pool.query(`
      SELECT 
        nome_prof as profissional,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio
      FROM bi_entregas
      ${whereClause}
      GROUP BY nome_prof
      HAVING COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) >= 10
      ORDER BY ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) ASC
      LIMIT 5
    `, params);
    
    // 6. Buscar distribuição por dia da semana
    const porDiaSemanaQuery = await pool.query(`
      SELECT 
        EXTRACT(DOW FROM data_solicitado) as dia_semana,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
        ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio
      FROM bi_entregas
      ${whereClause}
      GROUP BY EXTRACT(DOW FROM data_solicitado)
      ORDER BY EXTRACT(DOW FROM data_solicitado)
    `, params);
    
    // 7. Buscar distribuição por hora do dia (usando data_hora que é TIMESTAMP)
    let porHoraQuery = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM data_hora) as hora,
        COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
        ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
              NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo
      FROM bi_entregas
      ${whereClause} AND data_hora IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM data_hora)
      HAVING COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) > 0
      ORDER BY EXTRACT(HOUR FROM data_hora)
    `, params);
    
    console.log('📊 Dados por hora (data_hora):', porHoraQuery.rows.length, 'registros');
    
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const dadosDiaSemana = porDiaSemanaQuery.rows.map(r => ({
      dia: diasSemana[parseInt(r.dia_semana)],
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa_prazo) || 0,
      tempo_medio: parseFloat(r.tempo_medio) || 0
    }));
    
    const dadosPorHora = porHoraQuery.rows.map(r => ({
      hora: parseInt(r.hora),
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa_prazo) || 0
    })).sort((a, b) => a.hora - b.hora);
    
    // Calcular horário de pico
    const horarioPico = dadosPorHora.length > 0 
      ? dadosPorHora.reduce((max, h) => h.entregas > max.entregas ? h : max, dadosPorHora[0])
      : null;
    
    // Calcular total de entregas para % do pico
    const totalEntregasHora = dadosPorHora.reduce((sum, h) => sum + h.entregas, 0);
    
    // Identificar janela de pico (3 horas consecutivas com maior volume)
    let melhorJanela = { inicio: 0, fim: 0, entregas: 0 };
    for (let i = 0; i < dadosPorHora.length - 2; i++) {
      const somaJanela = dadosPorHora[i].entregas + (dadosPorHora[i+1]?.entregas || 0) + (dadosPorHora[i+2]?.entregas || 0);
      if (somaJanela > melhorJanela.entregas) {
        melhorJanela = { 
          inicio: dadosPorHora[i].hora, 
          fim: dadosPorHora[i+2]?.hora || dadosPorHora[i].hora, 
          entregas: somaJanela 
        };
      }
    }
    
    // Calcular variações e tendências
    // Função para formatar data
    const formatarData = (d) => {
      if (!d) return '';
      const data = new Date(d);
      return data.toLocaleDateString('pt-BR');
    };
    
    const evolucaoDiaria = porDiaQuery.rows.slice(-14).map(r => ({
      data: formatarData(r.data),
      entregas: parseInt(r.entregas),
      taxa_prazo: parseFloat(r.taxa) || 0,
      valor: parseFloat(r.valor) || 0,
      profissionais: parseInt(r.profissionais) || 0
    }));
    
    // Calcular média de profissionais por dia
    const todosDias = porDiaQuery.rows.map(r => parseInt(r.profissionais) || 0);
    const mediaProfissionaisDia = todosDias.length > 0 
      ? (todosDias.reduce((a, b) => a + b, 0) / todosDias.length).toFixed(1) 
      : 0;
    
    // Calcular tendência (comparar primeira metade com segunda metade)
    const metade = Math.floor(evolucaoDiaria.length / 2);
    const primeiraParte = evolucaoDiaria.slice(0, metade);
    const segundaParte = evolucaoDiaria.slice(metade);
    const mediaPrimeira = primeiraParte.length > 0 ? primeiraParte.reduce((a, b) => a + b.taxa_prazo, 0) / primeiraParte.length : 0;
    const mediaSegunda = segundaParte.length > 0 ? segundaParte.reduce((a, b) => a + b.taxa_prazo, 0) / segundaParte.length : 0;
    const tendencia = mediaSegunda - mediaPrimeira;
    
    // Montar contexto para a IA (EXPANDIDO)
    const contexto = {
      periodo: { inicio: data_inicio || metricas.data_inicio_real, fim: data_fim || metricas.data_fim_real },
      metricas_gerais: {
        total_os: parseInt(metricas.total_os) || 0,
        total_entregas: parseInt(metricas.total_entregas) || 0,
        taxa_prazo: parseFloat(metricas.taxa_prazo) || 0,
        entregas_no_prazo: parseInt(metricas.entregas_no_prazo) || 0,
        entregas_fora_prazo: parseInt(metricas.entregas_fora_prazo) || 0,
        total_retornos: parseInt(metricas.total_retornos) || 0,
        valor_total: parseFloat(metricas.valor_total) || 0,
        valor_profissionais: parseFloat(metricas.valor_prof) || 0,
        lucro_bruto: (parseFloat(metricas.valor_total) || 0) - (parseFloat(metricas.valor_prof) || 0),
        margem_percentual: parseFloat(metricas.valor_total) > 0 ? (((parseFloat(metricas.valor_total) - parseFloat(metricas.valor_prof)) / parseFloat(metricas.valor_total)) * 100).toFixed(1) : 0,
        tempo_medio_entrega: parseFloat(metricas.tempo_medio_entrega) || 0,
        tempo_medio_alocacao: parseFloat(metricas.tempo_medio_alocacao) || 0,
        tempo_medio_coleta: parseFloat(metricas.tempo_medio_coleta) || 0,
        km_total: parseFloat(metricas.km_total) || 0,
        km_medio: parseFloat(metricas.km_medio) || 0,
        total_profissionais_distintos: parseInt(metricas.total_profissionais) || 0,
        total_clientes: parseInt(metricas.total_clientes) || 0,
        total_dias_periodo: porDiaQuery.rows.length || 1,
        media_entregas_por_dia: porDiaQuery.rows.length > 0 ? (parseInt(metricas.total_entregas) / porDiaQuery.rows.length).toFixed(1) : 0,
        media_profissionais_por_dia: mediaProfissionaisDia,
        profissionais_ideais_por_dia: porDiaQuery.rows.length > 0 ? Math.ceil((parseInt(metricas.total_entregas) / porDiaQuery.rows.length) / 10) : 0,
        media_entregas_por_profissional_dia: mediaProfissionaisDia > 0 ? ((parseInt(metricas.total_entregas) / porDiaQuery.rows.length) / mediaProfissionaisDia).toFixed(1) : 0,
        ticket_medio: parseInt(metricas.total_entregas) > 0 ? (parseFloat(metricas.valor_total) / parseInt(metricas.total_entregas)).toFixed(2) : 0
      },
      tendencia: {
        variacao_taxa: tendencia.toFixed(1),
        direcao: tendencia > 1 ? 'MELHORANDO' : tendencia < -1 ? 'PIORANDO' : 'ESTÁVEL'
      },
      evolucao_diaria: evolucaoDiaria,
      top_clientes: topClientesQuery.rows.map(r => ({
        cliente: r.cliente,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        valor: parseFloat(r.valor) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0,
        km_medio: parseFloat(r.km_medio) || 0,
        retornos: parseInt(r.retornos) || 0
      })),
      top_profissionais: topProfsQuery.rows.map(r => ({
        profissional: r.profissional,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0,
        km_total: parseFloat(r.km_total) || 0,
        valor_recebido: parseFloat(r.valor_recebido) || 0
      })),
      piores_profissionais: pioresProfsQuery.rows.map(r => ({
        profissional: r.profissional,
        entregas: parseInt(r.entregas),
        taxa_prazo: parseFloat(r.taxa_prazo) || 0,
        tempo_medio: parseFloat(r.tempo_medio) || 0
      })),
      distribuicao_dia_semana: dadosDiaSemana,
      distribuicao_hora: dadosPorHora,
      horario_pico: horarioPico ? {
        hora: horarioPico.hora,
        entregas_total_periodo: horarioPico.entregas,
        entregas_media_dia: (horarioPico.entregas / (porDiaQuery.rows.length || 1)).toFixed(1),
        percentual_do_total: totalEntregasHora > 0 ? ((horarioPico.entregas / totalEntregasHora) * 100).toFixed(1) : 0,
        // Profissionais para o pico: 3 pedidos por moto (considerando retorno e nova coleta)
        profissionais_necessarios: Math.ceil(horarioPico.entregas / (porDiaQuery.rows.length || 1) / 3)
      } : null,
      janela_pico: {
        inicio: melhorJanela.inicio,
        fim: melhorJanela.fim,
        duracao_horas: melhorJanela.fim - melhorJanela.inicio + 1,
        entregas_total_periodo: melhorJanela.entregas,
        entregas_media_dia: (melhorJanela.entregas / (porDiaQuery.rows.length || 1)).toFixed(1),
        percentual_do_total: totalEntregasHora > 0 ? ((melhorJanela.entregas / totalEntregasHora) * 100).toFixed(1) : 0,
        // Profissionais para o pico: 3 pedidos por moto por hora (ida + volta + nova coleta ~20min cada)
        // Em uma janela de 3 horas, cada moto pode fazer ~3 entregas por hora = 9 entregas na janela
        // Mas para ser conservador, consideramos 3 entregas por moto na janela toda
        profissionais_necessarios: Math.ceil(melhorJanela.entregas / (porDiaQuery.rows.length || 1) / 3)
      }
    };
    
    // Definir prompt base por tipo
    const promptsBase = {
      performance: `## 📈 PERFORMANCE GERAL
Analise a performance OPERACIONAL (NÃO mencione valores financeiros, faturamento ou margem):
- Taxa de prazo atual vs benchmark (85%+ é bom)
- Tempo médio de entrega (adequado ou não, ideal < 60min)
- Pontos fortes operacionais (máx 3) - ex: taxa de prazo, tempo, eficiência
- Pontos fracos operacionais (máx 3) - ex: atrasos, tempo alto, retornos
- **NOTA GERAL: X/10** (baseada apenas em métricas operacionais)

⚠️ NÃO inclua informações de faturamento, valores, lucro ou margem nesta seção.`,
      
      tendencias: `## 📉 TENDÊNCIAS E PREDIÇÃO

⚠️ IMPORTANTE: Use EXATAMENTE os dados fornecidos na seção "HORÁRIO DE PICO" e "JANELA DE PICO". NÃO invente números.

**1️⃣ COMPORTAMENTO DA DEMANDA**
- Analise a seção "TENDÊNCIA" do contexto
- Informe se está: 📈 CRESCIMENTO | 📉 QUEDA | ➡️ ESTÁVEL
- Se queda >15%: emita 🔴 ALERTA

**2️⃣ SAZONALIDADE E PICOS**
Use EXATAMENTE os dados da seção "POR DIA DA SEMANA":
| Ranking | Dia | Volume | 
|---------|-----|--------|
| 🥇 | [copie do contexto] | X ent |
| 🥈 | [copie do contexto] | X ent |
| 🥉 | [copie do contexto] | X ent |

**Horário de Pico:** Copie EXATAMENTE da seção "JANELA DE PICO"
- Janela: [copie inicio]h às [copie fim]h
- Média diária no pico: [copie entregas_media_dia] entregas/dia
- % do total diário: [copie percentual_do_total]%

**3️⃣ DIMENSIONAMENTO PREDITIVO PARA O PICO**
COPIE os valores da seção "JANELA DE PICO":
- Média de entregas/dia no pico: [entregas_media_dia do contexto]
- Regra: 3 pedidos por motoboy no pico (moto faz ida, volta e pega novo pedido)
- **👥 Profissionais necessários:** [profissionais_necessarios do contexto] motoboys
- Cálculo: [entregas_media_dia] ÷ 3 = [profissionais_necessarios]

**4️⃣ INSIGHTS ESTRATÉGICOS**
- Status geral: 🟢 SAUDÁVEL | 🟡 ATENÇÃO | 🔴 CRÍTICO
- Recomendação (1-2 frases)`,
      
      alertas: `## ⚠️ ALERTAS URGENTES
Liste APENAS problemas críticos:
🔴 CRÍTICO: [problema] → [ação]
🟡 ATENÇÃO: [problema] → [ação]
🟢 MONITORAR: [problema] → [ação]
Máximo 5 alertas.`,
      
      gestao_profissionais: `## 👥 GESTÃO DE PROFISSIONAIS

**1️⃣ EQUILÍBRIO DE CARGA (Meta: 10 entregas/profissional/DIA)**
Use os dados de "MÉTRICAS DE DIMENSIONAMENTO":
- Média de entregas/dia: [media_entregas_por_dia do contexto]
- Média de profissionais/dia (real): [media_profissionais_por_dia do contexto]
- Profissionais ideais/dia: [profissionais_ideais_por_dia do contexto]
- Média entregas/moto/dia: [media_entregas_por_profissional_dia do contexto]

**Status da operação:**
Compare "Média de profissionais/dia (real)" com "Profissionais ideais/dia":
- ✅ ADEQUADO: se real ≈ ideal (diferença < 20%)
- ⚠️ SUBDIMENSIONADO: se real < ideal (poucos motoboys, cada um faz mais de 10/dia)
- 🔴 SUPERDIMENSIONADO: se real > ideal (muitos motoboys, cada um faz menos de 10/dia)

**Apresente:**
| Métrica | Valor |
|---------|-------|
| Entregas/dia (média) | [copie do contexto] |
| Profissionais/dia (real) | [copie do contexto] |
| Profissionais ideais/dia | [copie do contexto] |
| Entregas/moto/dia | [copie do contexto] |
| Status | ✅/⚠️/🔴 |
| Recomendação | [ação se necessário] |

**2️⃣ ANÁLISE DE ROTATIVIDADE (CHURN)**
- Total de profissionais distintos que trabalharam no período: X
- Profissionais necessários por dia: X
- Proporção: (distintos ÷ necessários/dia)
- Status:
  - ✅ NORMAL: proporção < 2x
  - ⚠️ ALTA ROTATIVIDADE: proporção entre 2x e 4x
  - 🔴 ROTATIVIDADE CRÍTICA: proporção > 4x
- Se alta rotatividade: explicar impacto e recomendar ação

**3️⃣ DISPARIDADE DE CARGA/REMUNERAÇÃO**
Identificar OUTLIERS (profissionais com volume muito diferente da média):
| Profissional | Entregas | Desvio da Média | Status |
Sinalize com ⚠️ quem está >50% acima ou abaixo da média do grupo.

**4️⃣ RANKING DE PERFORMANCE (por % de entregas no prazo)**
🏆 **TOP 3 - Melhores Taxas de Prazo:**
🥇 [nome] - [X]% no prazo - [X] entregas
🥈 [nome] - [X]% no prazo - [X] entregas
🥉 [nome] - [X]% no prazo - [X] entregas

⚠️ **DETRATORES - Piores Taxas de Prazo:**
1. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]
2. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]
3. [nome] - [X]% no prazo - [problema identificado] - [sugestão de ação]

**Se TODOS estiverem com baixa performance (<85% no prazo), emita:**
🔴 **ALERTA: BAIXA PERFORMANCE GERAL DA EQUIPE**
- Taxa média de prazo: X%
- Meta: 85%
- Ação recomendada: [sugestão]`,
      
      personalizado: prompt_custom ? `## ✨ ANÁLISE PERSONALIZADA\n${prompt_custom}` : null
    };
    
    // Reordenar tipos para alertas vir sempre por último
    const tiposOrdenados = [...tipos].sort((a, b) => {
      if (a === 'alertas') return 1;
      if (b === 'alertas') return -1;
      return 0;
    });
    
    // Combinar prompts dos tipos selecionados
    const promptsCombinados = tiposOrdenados
      .map(t => promptsBase[t])
      .filter(p => p !== null)
      .join('\n\n');
    
    const tiposLabel = tipos.map(t => {
      const labels = {performance: 'Performance', tendencias: 'Tendências', alertas: 'Alertas', gestao_profissionais: 'Gestão de Profissionais', personalizado: 'Personalizado'};
      return labels[t] || t;
    }).join(', ');
    
    const promptCompleto = `Você é um analista de operações de delivery. Seja DIRETO e VISUAL. Use emojis, tabelas e formatação para facilitar a leitura. Evite textos longos.

📊 **DADOS DA OPERAÇÃO** (${contexto.periodo.inicio} a ${contexto.periodo.fim})

📦 **RESUMO GERAL**
| Métrica | Valor |
|---------|-------|
| Total Entregas | ${contexto.metricas_gerais.total_entregas.toLocaleString()} |
| ✅ No Prazo | ${contexto.metricas_gerais.entregas_no_prazo.toLocaleString()} (${contexto.metricas_gerais.taxa_prazo}%) |
| ❌ Fora Prazo | ${contexto.metricas_gerais.entregas_fora_prazo.toLocaleString()} |
| 🔄 Retornos | ${contexto.metricas_gerais.total_retornos.toLocaleString()} |
| ⏱️ Tempo Médio | ${contexto.metricas_gerais.tempo_medio_entrega} min |
| 🚗 KM Médio | ${contexto.metricas_gerais.km_medio} km |
| 👥 Profissionais distintos | ${contexto.metricas_gerais.total_profissionais_distintos} |
| 🏢 Clientes | ${contexto.metricas_gerais.total_clientes} |

📊 **MÉTRICAS DE DIMENSIONAMENTO**
| Métrica | Valor |
|---------|-------|
| Total de dias no período | ${contexto.metricas_gerais.total_dias_periodo} dias |
| Média de entregas/dia | ${contexto.metricas_gerais.media_entregas_por_dia} ent/dia |
| **👥 Média de profissionais/dia (real)** | ${contexto.metricas_gerais.media_profissionais_por_dia} motoboys |
| **👥 Profissionais ideais/dia** | ${contexto.metricas_gerais.profissionais_ideais_por_dia} motoboys |
| Média entregas/profissional/dia | ${contexto.metricas_gerais.media_entregas_por_profissional_dia} ent/moto/dia |
| Meta por profissional | 10 ent/dia |
| Profissionais distintos no período | ${contexto.metricas_gerais.total_profissionais_distintos} |

💵 **FINANCEIRO**
| Métrica | Valor |
|---------|-------|
| Faturamento | R$ ${contexto.metricas_gerais.valor_total.toLocaleString('pt-BR')} |
| Custo Profissionais | R$ ${contexto.metricas_gerais.valor_profissionais.toLocaleString('pt-BR')} |
| Lucro Bruto | R$ ${contexto.metricas_gerais.lucro_bruto.toLocaleString('pt-BR')} |
| Margem | ${contexto.metricas_gerais.margem_percentual}% |
| Ticket Médio | R$ ${contexto.metricas_gerais.ticket_medio} |

📈 **TENDÊNCIA:** ${contexto.tendencia.direcao} (${contexto.tendencia.variacao_taxa > 0 ? '+' : ''}${contexto.tendencia.variacao_taxa}%)

📅 **EVOLUÇÃO DIÁRIA (últimos ${contexto.evolucao_diaria.length} dias)**
${contexto.evolucao_diaria.map(d => `${d.data}: ${d.entregas} ent | ${d.taxa_prazo}% ✓ | R$${d.valor.toLocaleString('pt-BR')}`).join('\n')}

🏢 **TOP CLIENTES**
${contexto.top_clientes.map((c, i) => `${i+1}. ${c.cliente}: ${c.entregas} ent | ${c.taxa_prazo}% | R$${c.valor.toLocaleString('pt-BR')} | ${c.tempo_medio}min | ${c.retornos} ret`).join('\n')}

👤 **TOP PROFISSIONAIS**
${contexto.top_profissionais.map((p, i) => `${i+1}. ${p.profissional}: ${p.entregas} ent | ${p.taxa_prazo}% | ${p.tempo_medio}min | ${p.km_total.toLocaleString()}km | R$${p.valor_recebido.toLocaleString('pt-BR')}`).join('\n')}

⚠️ **PROFISSIONAIS COM BAIXA PERFORMANCE** (mín 10 entregas)
${contexto.piores_profissionais.map((p, i) => `${i+1}. ${p.profissional}: ${p.taxa_prazo}% prazo | ${p.tempo_medio}min | ${p.entregas} ent`).join('\n')}

📆 **POR DIA DA SEMANA**
${contexto.distribuicao_dia_semana.map(d => `${d.dia}: ${d.entregas} ent | ${d.taxa_prazo}% | ${d.tempo_medio}min`).join('\n')}

⏰ **DISTRIBUIÇÃO POR HORÁRIO**
${contexto.distribuicao_hora.filter(h => h.entregas > 0).map(h => `${h.hora}h: ${h.entregas} ent | ${h.taxa_prazo}%`).join('\n')}

🔥 **HORÁRIO DE PICO (hora única com maior volume)**
${contexto.horario_pico ? `- Hora: ${contexto.horario_pico.hora}h
- Média por dia: ${contexto.horario_pico.entregas_media_dia} entregas/dia
- % do total diário: ${contexto.horario_pico.percentual_do_total}%
- **👥 Profissionais necessários no pico: ${contexto.horario_pico.profissionais_necessarios} motoboys**
- Regra: 3 pedidos/moto no horário de pico (ida + volta + nova coleta)
- Cálculo: ${contexto.horario_pico.entregas_media_dia} ÷ 3 = ${contexto.horario_pico.profissionais_necessarios}` : '- Sem dados de horário disponíveis'}

🔥 **JANELA DE PICO (${contexto.janela_pico ? contexto.janela_pico.duracao_horas : 3} horas consecutivas com maior volume)**
${contexto.janela_pico ? `- Janela: ${contexto.janela_pico.inicio}h às ${contexto.janela_pico.fim + 1}h (${contexto.janela_pico.duracao_horas}h de duração)
- Média por dia nesta janela: ${contexto.janela_pico.entregas_media_dia} entregas/dia
- % do total diário: ${contexto.janela_pico.percentual_do_total}% das entregas do dia
- **👥 Profissionais necessários na janela: ${contexto.janela_pico.profissionais_necessarios} motoboys**
- Regra: 3 pedidos/moto durante a janela de pico
- Cálculo: ${contexto.janela_pico.entregas_media_dia} ÷ 3 = ${contexto.janela_pico.profissionais_necessarios}` : '- Sem dados disponíveis'}

---
🎯 **SUAS TAREFAS:**
${promptsCombinados}

---
📝 **REGRAS OBRIGATÓRIAS:**
🚨 **CRÍTICO: Use SOMENTE os números fornecidos acima. NÃO invente dados!**
- Para HORÁRIO DE PICO: copie os valores das seções "HORÁRIO DE PICO" e "JANELA DE PICO"
- Para PROFISSIONAIS NO PICO: use o cálculo (média_dia ÷ 3), pois cada moto faz 3 pedidos no pico
- Seja DIRETO, sem enrolação
- Use emojis para facilitar leitura
- Use tabelas quando possível
- Bullets curtos, máximo 1 linha
- Destaque números importantes em **negrito**
- Para rankings use 🥇🥈🥉
- Para status use ✅❌⚠️🔴🟡🟢
${tipos.length > 1 ? '- Faça TODAS as análises solicitadas, separadas por seção' : ''}`;

    console.log('🤖 Chamando API Gemini...');
    
    // Chamar API do Gemini - aumentar tokens para múltiplas análises
    const maxTokens = tipos.length > 1 ? 4096 : 2048;
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptCompleto }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: maxTokens
        }
      })
    });
    
    const geminiData = await geminiResponse.json();
    
    if (geminiData.error) {
      console.error('❌ Erro Gemini:', geminiData.error);
      return res.status(500).json({ error: 'Erro na API Gemini: ' + geminiData.error.message });
    }
    
    const relatorio = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'Não foi possível gerar o relatório.';
    
    console.log('✅ Relatório IA gerado com sucesso');
    
    // Buscar nome do cliente se filtrado
    let clienteInfo = null;
    if (cod_cliente.length > 0) {
      try {
        const clienteQuery = await pool.query(`
          SELECT DISTINCT cod_cliente, 
                 COALESCE(nome_fantasia, nome_cliente, 'Cliente ' || cod_cliente::text) as nome
          FROM bi_entregas 
          WHERE cod_cliente = ANY($1::int[])
          LIMIT 1
        `, [cod_cliente.map(c => parseInt(c))]);
        if (clienteQuery.rows.length > 0) {
          clienteInfo = {
            codigo: clienteQuery.rows[0].cod_cliente,
            nome: clienteQuery.rows[0].nome
          };
        }
      } catch (e) {
        console.log('⚠️ Não foi possível buscar nome do cliente:', e.message);
        clienteInfo = {
          codigo: cod_cliente[0],
          nome: null
        };
      }
    }
    
    // Salvar no histórico
    const usuario_id = req.query.usuario_id || null;
    const usuario_nome = req.query.usuario_nome || null;
    
    try {
      await pool.query(`
        INSERT INTO bi_relatorios_ia 
        (usuario_id, usuario_nome, cod_cliente, nome_cliente, centro_custo, tipo_analise, data_inicio, data_fim, metricas, relatorio, filtros)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        usuario_id,
        usuario_nome,
        clienteInfo?.codigo || null,
        clienteInfo?.nome || null,
        centro_custo.length > 0 ? centro_custo.join(', ') : null,
        tiposLabel,
        data_inicio || null,
        data_fim || null,
        JSON.stringify(contexto.metricas_gerais),
        relatorio,
        JSON.stringify({
          cliente: clienteInfo,
          centro_custo: centro_custo.length > 0 ? centro_custo : null
        })
      ]);
      console.log('✅ Relatório salvo no histórico');
    } catch (histErr) {
      console.error('⚠️ Erro ao salvar histórico:', histErr.message);
    }
    
    res.json({
      success: true,
      tipo_analise: tiposLabel,
      tipos_selecionados: tipos,
      periodo: contexto.periodo,
      metricas: contexto.metricas_gerais,
      relatorio,
      // Filtros aplicados
      filtros: {
        cliente: clienteInfo,
        centro_custo: centro_custo.length > 0 ? centro_custo : null
      },
      // Dados para gráficos
      graficos: {
        evolucao_diaria: contexto.evolucao_diaria,
        distribuicao_dia_semana: contexto.distribuicao_dia_semana,
        distribuicao_hora: contexto.distribuicao_hora,
        top_clientes: contexto.top_clientes.slice(0, 5),
        top_profissionais: contexto.top_profissionais.slice(0, 5),
        horario_pico: contexto.horario_pico,
        janela_pico: contexto.janela_pico
      }
    });
    
  } catch (err) {
    console.error('❌ Erro ao gerar relatório IA:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório: ' + err.message });
  }
});

// Endpoint para listar histórico de relatórios IA
router.get('/bi/relatorio-ia/historico', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, usuario_id, usuario_nome, cod_cliente, nome_cliente, centro_custo, 
             tipo_analise, data_inicio, data_fim, metricas, filtros, created_at
      FROM bi_relatorios_ia 
      ORDER BY created_at DESC 
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar histórico:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para buscar relatório específico do histórico
router.get('/bi/relatorio-ia/historico/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM bi_relatorios_ia WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao buscar relatório:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para deletar relatório do histórico
router.delete('/bi/relatorio-ia/historico/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM bi_relatorios_ia WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao deletar relatório:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para gerar relatório Word (.docx nativo)
router.post('/bi/relatorio-ia/word', async (req, res) => {
  try {
    const { tipo_analise, periodo, metricas, relatorio, filtros } = req.body;
    
    console.log('📄 Gerando relatório Word (.docx)...');
    
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, 
            Header, Footer, AlignmentType, BorderStyle, WidthType, 
            ShadingType, PageNumber, ImageRun, PageBreak, VerticalAlign } = require('docx');
    const https = require('https');
    
    // Baixar logo
    let logoBuffer = null;
    try {
      logoBuffer = await new Promise((resolve, reject) => {
        https.get('https://raw.githubusercontent.com/Leonardodevcloud/tutts-frontend/main/Gemini_Generated_Image_s64zrms64zrms64z.png', (response) => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', reject);
        }).on('error', reject);
      });
      console.log('✅ Logo baixada com sucesso');
    } catch (e) {
      console.log('⚠️ Não foi possível baixar a logo:', e.message);
    }
    
    // Montar título dinâmico
    let tituloRelatorio = "RELATÓRIO OPERACIONAL";
    let subtituloCliente = "";
    
    if (filtros?.cliente) {
      tituloRelatorio += ` - ${filtros.cliente.codigo}`;
      subtituloCliente = filtros.cliente.nome || "";
      if (filtros.centro_custo && filtros.centro_custo.length > 0) {
        subtituloCliente += ` | Centro de Custo: ${filtros.centro_custo.join(', ')}`;
      }
    } else if (filtros?.centro_custo && filtros.centro_custo.length > 0) {
      subtituloCliente = `Centro de Custo: ${filtros.centro_custo.join(', ')}`;
    }
    
    const m = metricas || {};
    
    // Função para criar célula de métrica
    const criarCelulaMetrica = (valor, label, corValor, corFundo) => {
      return new TableCell({
        width: { size: 2340, type: WidthType.DXA },
        shading: { fill: corFundo, type: ShadingType.CLEAR },
        margins: { top: 200, bottom: 200, left: 100, right: 100 },
        verticalAlign: VerticalAlign.CENTER,
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
            children: [new TextRun({ text: valor, bold: true, size: 40, color: corValor })]
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: label, size: 18, color: "64748B" })]
          })
        ]
      });
    };
    
    // Criar tabela de métricas
    const tabelaMetricas = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [2340, 2340, 2340, 2340],
      borders: {
        top: { style: BorderStyle.NONE },
        bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE },
        right: { style: BorderStyle.NONE },
        insideHorizontal: { style: BorderStyle.NONE },
        insideVertical: { style: BorderStyle.NONE }
      },
      rows: [
        new TableRow({
          children: [
            criarCelulaMetrica((m.total_entregas || 0).toLocaleString('pt-BR'), "ENTREGAS", "2563EB", "DBEAFE"),
            criarCelulaMetrica((m.taxa_prazo || 0).toFixed(1) + "%", "TAXA PRAZO", "16A34A", "DCFCE7"),
            criarCelulaMetrica((m.tempo_medio_entrega || 0).toFixed(0) + " min", "TEMPO MÉDIO", "7C3AED", "EDE9FE"),
            criarCelulaMetrica(String(m.media_profissionais_por_dia || 0), "MOTOS/DIA", "EA580C", "FFEDD5")
          ]
        })
      ]
    });
    
    // Processar relatório em parágrafos - SEM TEXTO BRANCO
    const processarRelatorio = (texto) => {
      if (!texto) return [];
      
      const paragrafos = [];
      const linhas = texto.split('\n');
      
      for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        if (!linha.trim()) {
          paragrafos.push(new Paragraph({ spacing: { before: 150, after: 150 }, children: [] }));
          continue;
        }
        
        const isTituloSecao = /^##\s/.test(linha);
        const isAlertaCritico = /🔴/.test(linha);
        const isAlertaAtencao = /🟡/.test(linha);
        const isAlertaOk = /🟢|✅/.test(linha);
        const isSubtitulo = /^[1️⃣2️⃣3️⃣4️⃣]/.test(linha);
        const isItemLista = /^[-*•]\s/.test(linha.trim()) || /^[🥇🥈🥉]/.test(linha);
        const isTabelaSeparador = /^\|[-\s|]+\|$/.test(linha);
        
        if (isTabelaSeparador) continue;
        
        let textoLimpo = linha
          .replace(/^##\s*/, '')
          .replace(/\*\*/g, '');
        
        if (isTituloSecao) {
          // Título de seção - BORDA COLORIDA em vez de fundo (mais compatível)
          paragrafos.push(new Paragraph({ spacing: { before: 400, after: 0 }, children: [] }));
          paragrafos.push(new Paragraph({
            spacing: { before: 0, after: 200 },
            border: {
              top: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" },
              bottom: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" },
              left: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" },
              right: { style: BorderStyle.SINGLE, size: 24, color: "7C3AED" }
            },
            shading: { fill: "EDE9FE", type: ShadingType.CLEAR },
            children: [new TextRun({ text: "  " + textoLimpo + "  ", bold: true, size: 26, color: "6D28D9" })]
          }));
        } else if (isAlertaCritico) {
          paragrafos.push(new Paragraph({
            spacing: { before: 200, after: 200 },
            shading: { fill: "FEE2E2", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 30, color: "DC2626" } },
            indent: { left: 200 },
            children: [new TextRun({ text: " " + textoLimpo, bold: true, size: 22, color: "DC2626" })]
          }));
        } else if (isAlertaAtencao) {
          paragrafos.push(new Paragraph({
            spacing: { before: 200, after: 200 },
            shading: { fill: "FEF3C7", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 30, color: "F59E0B" } },
            indent: { left: 200 },
            children: [new TextRun({ text: " " + textoLimpo, bold: true, size: 22, color: "92400E" })]
          }));
        } else if (isAlertaOk) {
          paragrafos.push(new Paragraph({
            spacing: { before: 200, after: 200 },
            shading: { fill: "EDE9FE", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 30, color: "7C3AED" } },
            indent: { left: 200 },
            children: [new TextRun({ text: " " + textoLimpo, size: 22, color: "6D28D9" })]
          }));
        } else if (isSubtitulo) {
          paragrafos.push(new Paragraph({ spacing: { before: 350, after: 0 }, children: [] }));
          paragrafos.push(new Paragraph({
            spacing: { before: 0, after: 150 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: "7C3AED" } },
            children: [new TextRun({ text: textoLimpo, bold: true, size: 26, color: "7C3AED" })]
          }));
        } else if (isItemLista) {
          paragrafos.push(new Paragraph({
            spacing: { before: 100, after: 100 },
            indent: { left: 500 },
            children: [new TextRun({ text: textoLimpo, size: 22, color: "374151" })]
          }));
        } else {
          paragrafos.push(new Paragraph({
            spacing: { before: 120, after: 120 },
            children: [new TextRun({ text: textoLimpo, size: 22, color: "374151" })]
          }));
        }
      }
      
      return paragrafos;
    };
    
    // ==================== SEÇÃO 1: CAPA ====================
    const secaoCapa = {
      properties: {
        page: {
          margin: { top: 720, right: 720, bottom: 720, left: 720 }
        }
      },
      children: [
        // Espaço superior
        new Paragraph({ spacing: { before: 2000, after: 0 }, children: [] }),
        new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }),
        new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }),
        
        // Logo centralizada
        ...(logoBuffer ? [new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
          children: [new ImageRun({
            data: logoBuffer,
            transformation: { width: 200, height: 200 },
            type: 'png'
          })]
        })] : []),
        
        // Espaço
        new Paragraph({ spacing: { before: 400, after: 400 }, children: [] }),
        
        // Título principal
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
          children: [new TextRun({ text: tituloRelatorio, bold: true, size: 56, color: "7C3AED" })]
        }),
        
        // Subtítulo cliente
        ...(subtituloCliente ? [new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: subtituloCliente, bold: true, size: 32, color: "374151" })]
        })] : []),
        
        // Espaço
        new Paragraph({ spacing: { before: 400, after: 400 }, children: [] }),
        
        // Linha decorativa
        new Paragraph({
          alignment: AlignmentType.CENTER,
          border: { bottom: { style: BorderStyle.SINGLE, size: 20, color: "7C3AED" } },
          spacing: { after: 400 },
          children: [new TextRun({ text: "                                                                                    ", size: 8 })]
        }),
        
        // Tipo de análise
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 150 },
          children: [new TextRun({ text: tipo_analise || 'Análise Geral', size: 28, color: "6B7280" })]
        }),
        
        // Período
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 150 },
          children: [new TextRun({ text: `Período: ${periodo?.inicio || ''} a ${periodo?.fim || ''}`, size: 24, color: "6B7280" })]
        }),
        
        // Data de geração
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 0 },
          children: [new TextRun({ text: `Gerado em: ${new Date().toLocaleString('pt-BR')}`, size: 22, color: "9CA3AF" })]
        }),
        
        // Espaço grande
        new Paragraph({ spacing: { before: 2000, after: 0 }, children: [] }),
        new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }),
        
        // Rodapé da capa
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "Sistema Tutts - Business Intelligence", size: 20, color: "9CA3AF" })]
        })
      ]
    };
    
    // ==================== SEÇÃO 2: CONTEÚDO ====================
    const secaoConteudo = {
      properties: {
        page: {
          margin: { top: 720, right: 720, bottom: 720, left: 720 }
        }
      },
      headers: {
        default: new Header({
          children: [
            ...(logoBuffer ? [new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new ImageRun({
                data: logoBuffer,
                transformation: { width: 60, height: 60 },
                type: 'png'
              })]
            })] : [])
          ]
        })
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              border: { top: { style: BorderStyle.SINGLE, size: 6, color: "E5E7EB" } },
              spacing: { before: 200 },
              children: [
                new TextRun({ text: "Sistema Tutts - Business Intelligence  •  Página ", size: 18, color: "9CA3AF" }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "9CA3AF" }),
                new TextRun({ text: " de ", size: 18, color: "9CA3AF" }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "9CA3AF" })
              ]
            })
          ]
        })
      },
      children: [
        // Título do relatório
        new Paragraph({
          spacing: { after: 100 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 20, color: "7C3AED" } },
          children: [new TextRun({ text: "📋 " + tituloRelatorio, bold: true, size: 36, color: "7C3AED" })]
        }),
        
        // Info
        new Paragraph({
          spacing: { before: 150, after: 300 },
          children: [new TextRun({ text: `${tipo_analise || 'Análise'} • Período: ${periodo?.inicio || ''} a ${periodo?.fim || ''}`, size: 20, color: "6B7280" })]
        }),
        
        // Métricas
        tabelaMetricas,
        
        // Espaço
        new Paragraph({ spacing: { before: 500, after: 300 }, children: [] }),
        
        // Título análise detalhada
        new Paragraph({
          spacing: { after: 300 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: "7C3AED" } },
          children: [new TextRun({ text: "📊 ANÁLISE DETALHADA", bold: true, size: 32, color: "7C3AED" })]
        }),
        
        // Espaço
        new Paragraph({ spacing: { before: 200, after: 200 }, children: [] }),
        
        // Conteúdo
        ...processarRelatorio(relatorio)
      ]
    };
    
    // Criar documento com 2 seções
    const doc = new Document({
      styles: {
        default: {
          document: {
            run: { font: "Arial", size: 22, color: "374151" }
          }
        }
      },
      sections: [secaoCapa, secaoConteudo]
    });
    
    // Gerar buffer
    const buffer = await Packer.toBuffer(doc);
    
    // Montar nome do arquivo
    let nomeArquivo = 'relatorio-operacional';
    if (filtros?.cliente) {
      nomeArquivo += '-' + filtros.cliente.codigo;
    }
    nomeArquivo += '-' + new Date().toISOString().split('T')[0] + '.docx';
    
    // Enviar arquivo
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=' + nomeArquivo);
    res.send(buffer);
    
    console.log('✅ Relatório Word (.docx) gerado com sucesso');
    
  } catch (err) {
    console.error('❌ Erro ao gerar Word:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: 'Erro ao gerar documento: ' + err.message });
  }
});

// Atualizar data_hora_alocado em massa (para registros existentes)

  return router;
}

module.exports = { createRelatorioIaRoutes };
