/**
 * CS Sub-Router: Raio-X IA
 * Análise inteligente via Gemini com benchmarks anônimos,
 * análises preditivas e referências de mercado
 */
const express = require('express');
const { calcularHealthScore } = require('../cs.service');

function createRaioXRoutes(pool) {
  const router = express.Router();

  // ==================== POST /cs/raio-x ====================
  // Gera Raio-X completo do cliente com IA
  router.post('/cs/raio-x', async (req, res) => {
    try {
      const { cod_cliente, data_inicio, data_fim, tipo = 'completo' } = req.body;

      if (!cod_cliente || !data_inicio || !data_fim) {
        return res.status(400).json({ error: 'cod_cliente, data_inicio e data_fim são obrigatórios' });
      }

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) {
        return res.status(400).json({ error: 'API Key do Gemini não configurada' });
      }

      console.log(`🔬 Gerando Raio-X IA: cliente=${cod_cliente}, período=${data_inicio} a ${data_fim}`);

      // ═══════════════════════════════════════════════
      // 1. DADOS DO CLIENTE
      // ═══════════════════════════════════════════════
      const fichaResult = await pool.query(
        'SELECT * FROM cs_clientes WHERE cod_cliente = $1', [parseInt(cod_cliente)]
      );
      const ficha = fichaResult.rows[0] || {};

      // ═══════════════════════════════════════════════
      // 2. MÉTRICAS BI DO CLIENTE (período selecionado)
      // ═══════════════════════════════════════════════
      const metricasCliente = await pool.query(`
        SELECT 
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          COUNT(DISTINCT os) as total_os,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2) as taxa_prazo,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0) as valor_prof,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END), 2) as tempo_medio_entrega,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 2) as km_medio,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais_unicos,
          COUNT(DISTINCT data_solicitado) as dias_com_entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
            LOWER(ocorrencia) LIKE '%clienteaus%' OR 
            LOWER(ocorrencia) LIKE '%cliente ausente%'
          ) THEN 1 ELSE 0 END) as total_retornos,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END), 2) as tempo_medio_alocacao
        FROM bi_entregas
        WHERE cod_cliente = $1
          AND data_solicitado >= $2 AND data_solicitado <= $3
      `, [parseInt(cod_cliente), data_inicio, data_fim]);

      // ═══════════════════════════════════════════════
      // 3. EVOLUÇÃO DIÁRIA DO CLIENTE
      // ═══════════════════════════════════════════════
      const evolucaoDiaria = await pool.query(`
        SELECT 
          data_solicitado as data,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
        GROUP BY data_solicitado ORDER BY data_solicitado
      `, [parseInt(cod_cliente), data_inicio, data_fim]);

      // ═══════════════════════════════════════════════
      // 4. TOP PROFISSIONAIS DO CLIENTE
      // ═══════════════════════════════════════════════
      const topProfissionais = await pool.query(`
        SELECT 
          nome_prof,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 1) as taxa_prazo,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 1) as tempo_medio
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
          AND COALESCE(ponto, 1) >= 2
        GROUP BY nome_prof
        ORDER BY COUNT(*) DESC LIMIT 10
      `, [parseInt(cod_cliente), data_inicio, data_fim]);

      // ═══════════════════════════════════════════════
      // 5. BENCHMARK ANÔNIMO (performance vs plataforma)
      // ═══════════════════════════════════════════════
      const benchmarkGlobal = await pool.query(`
        SELECT 
          ROUND(AVG(taxa_prazo), 1) as media_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY taxa_prazo), 1) as p25_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY taxa_prazo), 1) as mediana_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY taxa_prazo), 1) as p75_taxa_prazo,
          ROUND(AVG(total_entregas), 0) as media_entregas,
          ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_entregas), 0) as mediana_entregas,
          ROUND(AVG(ticket_medio), 2) as media_ticket,
          ROUND(AVG(tempo_medio_entrega), 1) as media_tempo_entrega,
          COUNT(*) as total_clientes_ativos
        FROM (
          SELECT 
            cod_cliente,
            ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
            COUNT(*) as total_entregas,
            ROUND(AVG(valor), 2) as ticket_medio,
            ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END), 1) as tempo_medio_entrega
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2
            AND COALESCE(ponto, 1) >= 2
            AND cod_cliente IS NOT NULL
          GROUP BY cod_cliente
          HAVING COUNT(*) >= 5
        ) sub
      `, [data_inicio, data_fim]);

      // ═══════════════════════════════════════════════
      // 6. RANKING DO CLIENTE (posição sem revelar nomes)
      // ═══════════════════════════════════════════════
      const ranking = await pool.query(`
        WITH ranking_clientes AS (
          SELECT 
            cod_cliente,
            ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as taxa_prazo,
            COUNT(*) as total_entregas,
            RANK() OVER (ORDER BY SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100 DESC) as rank_prazo,
            RANK() OVER (ORDER BY COUNT(*) DESC) as rank_volume
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2
            AND COALESCE(ponto, 1) >= 2 AND cod_cliente IS NOT NULL
          GROUP BY cod_cliente HAVING COUNT(*) >= 5
        )
        SELECT rank_prazo, rank_volume, 
               (SELECT COUNT(*) FROM ranking_clientes) as total_ranqueados
        FROM ranking_clientes WHERE cod_cliente = $3
      `, [data_inicio, data_fim, parseInt(cod_cliente)]);

      // ═══════════════════════════════════════════════
      // 7. OCORRÊNCIAS DO PERÍODO
      // ═══════════════════════════════════════════════
      const ocorrenciasPeriodo = await pool.query(`
        SELECT tipo, severidade, status, titulo, data_abertura, data_resolucao
        FROM cs_ocorrencias
        WHERE cod_cliente = $1
          AND data_abertura >= $2 AND data_abertura <= $3::date + 1
        ORDER BY data_abertura DESC
      `, [parseInt(cod_cliente), data_inicio, data_fim]);

      // ═══════════════════════════════════════════════
      // 8. INTERAÇÕES DO PERÍODO
      // ═══════════════════════════════════════════════
      const interacoesPeriodo = await pool.query(`
        SELECT tipo, titulo, data_interacao, resultado, proxima_acao
        FROM cs_interacoes
        WHERE cod_cliente = $1
          AND data_interacao >= $2 AND data_interacao <= $3::date + 1
        ORDER BY data_interacao DESC LIMIT 20
      `, [parseInt(cod_cliente), data_inicio, data_fim]);

      // ═══════════════════════════════════════════════
      // 9. PERÍODO ANTERIOR (para comparação)
      // ═══════════════════════════════════════════════
      const diasPeriodo = Math.ceil((new Date(data_fim) - new Date(data_inicio)) / (1000 * 60 * 60 * 24));
      const inicioAnterior = new Date(new Date(data_inicio) - diasPeriodo * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const fimAnterior = new Date(new Date(data_inicio) - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const metricasAnteriores = await pool.query(`
        SELECT 
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2) as taxa_prazo,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0) as valor_total,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END), 2) as tempo_medio_entrega
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
      `, [parseInt(cod_cliente), inicioAnterior, fimAnterior]);

      // ═══════════════════════════════════════════════
      // 10. MONTAR DADOS E ENVIAR AO GEMINI
      // ═══════════════════════════════════════════════
      const metricas = metricasCliente.rows[0];
      const benchmark = benchmarkGlobal.rows[0];
      const rankingData = ranking.rows[0] || {};
      const metrAnterior = metricasAnteriores.rows[0];
      const healthScore = calcularHealthScore(metricas);

      const dadosAnalise = {
        cliente: {
          nome: ficha.nome_fantasia || `Cliente ${cod_cliente}`,
          segmento: ficha.segmento || 'autopeças',
          porte: ficha.porte || 'indefinido',
          status: ficha.status || 'ativo',
          health_score: healthScore,
          data_inicio_parceria: ficha.data_inicio_parceria,
        },
        periodo: { inicio: data_inicio, fim: data_fim, dias: diasPeriodo },
        metricas_periodo_atual: metricas,
        metricas_periodo_anterior: metrAnterior,
        evolucao_diaria: evolucaoDiaria.rows.slice(0, 30), // limitar para token
        top_profissionais: topProfissionais.rows,
        benchmark_plataforma: benchmark,
        ranking_anonimo: {
          posicao_prazo: rankingData.rank_prazo,
          posicao_volume: rankingData.rank_volume,
          total_clientes: rankingData.total_ranqueados,
        },
        ocorrencias_periodo: ocorrenciasPeriodo.rows,
        interacoes_periodo: interacoesPeriodo.rows,
      };

      // ═══════════════════════════════════════════════
      // 11. PROMPT GEMINI (Raio-X Profissional)
      // ═══════════════════════════════════════════════
      const prompt = `Você é um consultor sênior de Customer Success especializado em operações logísticas de delivery (last-mile). Seu objetivo é criar um RAIO-X OPERACIONAL profundo, impactante e acionável.

## CONTEXTO DA OPERAÇÃO
A Tutts é uma plataforma de gestão de entregas de autopeças que conecta lojas a motoboys profissionais. Atua em múltiplas regiões do Brasil com ~2.500 entregas/dia.

## DADOS DO CLIENTE ANALISADO
${JSON.stringify(dadosAnalise, null, 2)}

## INSTRUÇÕES DE ANÁLISE
Gere um relatório RAIO-X seguindo EXATAMENTE esta estrutura em Markdown:

### 📊 RESUMO EXECUTIVO
- Síntese em 3-4 linhas do estado atual do cliente
- Health Score: ${healthScore}/100 com justificativa
- Classificação: [🟢 Saudável | 🟡 Atenção | 🔴 Crítico]

### 📈 PERFORMANCE OPERACIONAL
- Análise detalhada das métricas de entregas, prazos, tempos
- Comparação período atual vs anterior (evolução % com setas ↑↓)
- Destaque para métricas que merecem atenção imediata

### 🏆 BENCHMARKING (vs Plataforma)
- Compare o cliente com a média da plataforma SEM revelar nomes de outros clientes
- Use termos como "média da plataforma", "top 25%", "mediana do mercado"
- Posição no ranking: ${rankingData.rank_prazo || 'N/A'}º em prazo, ${rankingData.rank_volume || 'N/A'}º em volume, de ${rankingData.total_ranqueados || 'N/A'} clientes
- Identifique se o cliente está acima ou abaixo dos benchmarks

### 🔮 ANÁLISE PREDITIVA
- Tendências identificadas nos dados (crescimento, estagnação, declínio)
- Projeção para os próximos 30 dias baseada na evolução
- Riscos identificados (churn, queda de volume, deterioração de SLA)
- Probabilidade estimada de cada risco (Alta/Média/Baixa)

### 🏭 REFERÊNCIAS DE MERCADO
- Compare com benchmarks do setor de logística last-mile brasileiro
- No setor de autopeças, a taxa de entrega no prazo padrão de mercado é 85-90%
- Tempo médio de entrega aceitável: 30-45 minutos para entregas urbanas
- Taxa de retorno/ocorrência tolerável: até 3%
- Cite tendências do mercado relevantes

### ⚠️ ALERTAS E RISCOS
- Liste os principais pontos de atenção em ordem de prioridade
- Para cada alerta: impacto estimado + urgência
- Classifique: [🔴 Crítico | 🟠 Alto | 🟡 Moderado]

### 🎯 PLANO DE AÇÃO (TOP 5)
Para cada ação, forneça:
1. **Ação**: O que fazer
2. **Responsável sugerido**: Quem deve executar
3. **Prazo sugerido**: Quando completar
4. **Impacto esperado**: Qual melhoria esperar
5. **Prioridade**: [P1 Urgente | P2 Importante | P3 Ideal]

### 💡 INSIGHTS ESTRATÉGICOS
- Oportunidades de upsell ou expansão da operação
- Sugestões para fortalecer o relacionamento
- Quick wins que podem ser implementados imediatamente

IMPORTANTE:
- Seja ESPECÍFICO com números e porcentagens, não genérico
- Use os dados fornecidos, NÃO invente métricas
- Linguagem profissional mas acessível
- Formato Markdown com emojis nos títulos para facilitar leitura
- Se algum dado estiver faltando ou for zero, mencione que precisa de mais dados para análise completa
- Responda em português brasileiro`;

      // ═══════════════════════════════════════════════
      // 12. CHAMADA GEMINI
      // ═══════════════════════════════════════════════
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
          }),
        }
      );

      const geminiData = await geminiResponse.json();

      if (geminiData.error) {
        console.error('❌ Erro Gemini Raio-X:', geminiData.error);
        return res.status(500).json({ error: `Erro Gemini: ${geminiData.error.message}` });
      }

      const analiseTexto = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'Erro ao gerar análise';
      const tokensUsados = geminiData.usageMetadata?.totalTokenCount || 0;

      // ═══════════════════════════════════════════════
      // 13. SALVAR NO HISTÓRICO
      // ═══════════════════════════════════════════════
      const saveResult = await pool.query(`
        INSERT INTO cs_raio_x_historico (
          cod_cliente, nome_cliente, data_inicio, data_fim,
          metricas_snapshot, benchmark_snapshot, analise_texto,
          tipo_analise, score_saude, alertas, recomendacoes,
          gerado_por, gerado_por_nome, tokens_utilizados
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `, [
        parseInt(cod_cliente),
        ficha.nome_fantasia || `Cliente ${cod_cliente}`,
        data_inicio, data_fim,
        JSON.stringify(metricas),
        JSON.stringify(benchmark),
        analiseTexto,
        tipo,
        healthScore,
        JSON.stringify([]), // alertas extraídos depois se necessário
        JSON.stringify([]),
        req.user?.codProfissional,
        req.user?.nome,
        tokensUsados,
      ]);

      console.log(`✅ Raio-X gerado: cliente=${cod_cliente}, health=${healthScore}, tokens=${tokensUsados}`);

      res.json({
        success: true,
        raio_x: {
          id: saveResult.rows[0].id,
          analise: analiseTexto,
          health_score: healthScore,
          dados_utilizados: dadosAnalise,
          tokens: tokensUsados,
          gerado_em: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('❌ Erro ao gerar Raio-X CS:', error);
      res.status(500).json({ error: 'Erro ao gerar Raio-X' });
    }
  });

  // ==================== GET /cs/raio-x/:id ====================
  // Recuperar Raio-X do histórico
  router.get('/cs/raio-x/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Raio-X não encontrado' });
      }

      res.json({ success: true, raio_x: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao buscar Raio-X:', error);
      res.status(500).json({ error: 'Erro ao buscar Raio-X' });
    }
  });

  // ==================== GET /cs/raio-x/historico/:cod ====================
  // Histórico de Raio-X de um cliente
  router.get('/cs/raio-x/historico/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      const result = await pool.query(
        `SELECT id, data_inicio, data_fim, tipo_analise, score_saude, gerado_por_nome, tokens_utilizados, created_at
         FROM cs_raio_x_historico WHERE cod_cliente = $1 ORDER BY created_at DESC LIMIT 20`,
        [cod]
      );
      res.json({ success: true, historico: result.rows });
    } catch (error) {
      console.error('❌ Erro ao buscar histórico Raio-X:', error);
      res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
  });

  return router;
}

module.exports = { createRaioXRoutes };
