/**
 * CS Sub-Router: Raio-X IA
 * Relatório operacional profissional via Gemini
 * Focado em apresentação ao cliente final — sem dados financeiros
 */
const express = require('express');
const { calcularHealthScore } = require('../cs.service');

function createRaioXRoutes(pool) {
  const router = express.Router();

  router.post('/cs/raio-x', async (req, res) => {
    try {
      const { cod_cliente, data_inicio, data_fim, tipo = 'completo' } = req.body;
      if (!cod_cliente || !data_inicio || !data_fim) {
        return res.status(400).json({ error: 'cod_cliente, data_inicio e data_fim são obrigatórios' });
      }
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) {
        return res.status(400).json({ error: 'API Key do Gemini não configurada. Configure GEMINI_API_KEY no .env' });
      }
      console.log(`🔬 Gerando Raio-X IA: cliente=${cod_cliente}, período=${data_inicio} a ${data_fim}`);
      const codInt = parseInt(cod_cliente);

      // 1. DADOS DO CLIENTE
      const fichaResult = await pool.query('SELECT * FROM cs_clientes WHERE cod_cliente = $1', [codInt]);
      const ficha = fichaResult.rows[0] || {};

      // 2. MÉTRICAS OPERACIONAIS DO PERÍODO
      const metricasCliente = await pool.query(`
        SELECT 
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          COUNT(DISTINCT os) as total_os,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as entregas_no_prazo,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END) as entregas_fora_prazo,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 2) as taxa_prazo,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END), 1) as tempo_medio_entrega,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 2) as km_medio,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais_unicos,
          COUNT(DISTINCT data_solicitado) as dias_com_entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR LOWER(ocorrencia) LIKE '%%clienteaus%%' OR
            LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR LOWER(ocorrencia) LIKE '%%loja fechada%%' OR
            LOWER(ocorrencia) LIKE '%%produto incorreto%%'
          ) THEN 1 ELSE 0 END) as total_retornos,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END), 1) as tempo_medio_alocacao,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN velocidade_media END), 1) as velocidade_media
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
      `, [codInt, data_inicio, data_fim]);

      // 3. FAIXAS DE KM
      const faixasKm = await pool.query(`
        SELECT 
          CASE WHEN distancia <= 3 THEN '0-3 km' WHEN distancia <= 5 THEN '3-5 km'
               WHEN distancia <= 10 THEN '5-10 km' WHEN distancia <= 20 THEN '10-20 km'
               WHEN distancia <= 30 THEN '20-30 km' ELSE '30+ km' END as faixa,
          COUNT(*) as quantidade,
          ROUND(AVG(tempo_execucao_minutos), 1) as tempo_medio,
          ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo_faixa
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
          AND COALESCE(ponto, 1) >= 2 AND distancia IS NOT NULL AND distancia > 0
        GROUP BY CASE WHEN distancia <= 3 THEN '0-3 km' WHEN distancia <= 5 THEN '3-5 km'
               WHEN distancia <= 10 THEN '5-10 km' WHEN distancia <= 20 THEN '10-20 km'
               WHEN distancia <= 30 THEN '20-30 km' ELSE '30+ km' END
        ORDER BY MIN(distancia)
      `, [codInt, data_inicio, data_fim]);

      // 4. MAPA DE CALOR — por bairro/cidade
      const mapaCalor = await pool.query(`
        SELECT COALESCE(NULLIF(bairro, ''), 'Não informado') as bairro, COALESCE(cidade, '') as cidade,
          COUNT(*) as entregas, ROUND(AVG(distancia), 1) as km_medio,
          ROUND(AVG(tempo_execucao_minutos), 1) as tempo_medio,
          ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3 AND COALESCE(ponto, 1) >= 2
        GROUP BY COALESCE(NULLIF(bairro, ''), 'Não informado'), COALESCE(cidade, '')
        ORDER BY COUNT(*) DESC LIMIT 20
      `, [codInt, data_inicio, data_fim]);

      // 5. ANÁLISE DE CORRIDAS POR MOTOBOY
      const corridasMotoboy = await pool.query(`
        WITH saidas AS (
          SELECT cod_prof, nome_prof, os, data_solicitado,
            COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as pontos_entrega,
            COALESCE(SUM(distancia), 0) as km_total_os
          FROM bi_entregas
          WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
          GROUP BY cod_prof, nome_prof, os, data_solicitado
        )
        SELECT nome_prof,
          COUNT(DISTINCT os) as total_corridas,
          SUM(pontos_entrega) as total_entregas,
          ROUND(SUM(pontos_entrega)::numeric / NULLIF(COUNT(DISTINCT os), 0), 1) as entregas_por_corrida,
          COUNT(DISTINCT data_solicitado) as dias_trabalhados,
          ROUND(COUNT(DISTINCT os)::numeric / NULLIF(COUNT(DISTINCT data_solicitado), 0), 1) as corridas_por_dia,
          ROUND(AVG(km_total_os), 1) as km_medio_por_corrida,
          ROUND(SUM(km_total_os), 1) as km_total
        FROM saidas GROUP BY nome_prof
        ORDER BY SUM(pontos_entrega) DESC LIMIT 15
      `, [codInt, data_inicio, data_fim]);

      // 6. PADRÕES DE HORÁRIO
      const padroesHorario = await pool.query(`
        SELECT 
          CASE WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 6 AND 8 THEN '06-09h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 9 AND 11 THEN '09-12h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 12 AND 13 THEN '12-14h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 14 AND 16 THEN '14-17h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 17 AND 19 THEN '17-20h'
               ELSE '20h+' END as faixa_horaria,
          COUNT(*) as entregas,
          ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo,
          ROUND(AVG(tempo_execucao_minutos), 1) as tempo_medio
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
          AND COALESCE(ponto, 1) >= 2 AND data_hora IS NOT NULL
        GROUP BY CASE WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 6 AND 8 THEN '06-09h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 9 AND 11 THEN '09-12h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 12 AND 13 THEN '12-14h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 14 AND 16 THEN '14-17h'
               WHEN EXTRACT(HOUR FROM data_hora) BETWEEN 17 AND 19 THEN '17-20h'
               ELSE '20h+' END
        ORDER BY MIN(EXTRACT(HOUR FROM data_hora))
      `, [codInt, data_inicio, data_fim]);

      // 7. EVOLUÇÃO SEMANAL
      const evolucaoSemanal = await pool.query(`
        SELECT DATE_TRUNC('week', data_solicitado)::date as semana,
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END) as no_prazo,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 1) as km_medio,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
        GROUP BY DATE_TRUNC('week', data_solicitado) ORDER BY semana
      `, [codInt, data_inicio, data_fim]);

      // 8. RETORNOS DETALHADOS
      const retornosDetalhe = await pool.query(`
        SELECT ocorrencia, COUNT(*) as quantidade,
          ROUND(COUNT(*)::numeric / NULLIF((
            SELECT COUNT(*) FROM bi_entregas WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3 AND COALESCE(ponto, 1) >= 2
          ), 0) * 100, 2) as percentual
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
          AND COALESCE(ponto, 1) >= 2 AND ocorrencia IS NOT NULL AND ocorrencia != ''
        GROUP BY ocorrencia ORDER BY COUNT(*) DESC LIMIT 10
      `, [codInt, data_inicio, data_fim]);

      // 9. BENCHMARK DA REGIÃO
      const estadoCliente = ficha.estado || (await pool.query(
        `SELECT estado FROM bi_entregas WHERE cod_cliente = $1 AND estado IS NOT NULL LIMIT 1`, [codInt]
      )).rows[0]?.estado || 'N/A';

      const benchmarkRegiao = await pool.query(`
        SELECT ROUND(AVG(taxa_prazo), 1) as media_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY taxa_prazo), 1) as mediana_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY taxa_prazo), 1) as p75_taxa_prazo,
          ROUND(AVG(total_entregas), 0) as media_entregas,
          ROUND(AVG(km_medio), 1) as media_km,
          ROUND(AVG(tempo_medio), 1) as media_tempo_entrega,
          ROUND(AVG(taxa_retorno), 2) as media_taxa_retorno,
          COUNT(*) as total_clientes_regiao
        FROM (
          SELECT cod_cliente,
            ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo,
            COUNT(*) as total_entregas, ROUND(AVG(distancia), 1) as km_medio,
            ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END), 1) as tempo_medio,
            ROUND(SUM(CASE WHEN (LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR LOWER(ocorrencia) LIKE '%%clienteaus%%' OR
              LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR LOWER(ocorrencia) LIKE '%%loja fechada%%'
            ) THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as taxa_retorno
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2 AND COALESCE(ponto, 1) >= 2
            AND cod_cliente IS NOT NULL AND estado = $3
          GROUP BY cod_cliente HAVING COUNT(*) >= 5
        ) sub
      `, [data_inicio, data_fim, estadoCliente]);

      // 10. RANKING REGIONAL
      const ranking = await pool.query(`
        WITH ranking_clientes AS (
          SELECT cod_cliente,
            ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo,
            COUNT(*) as total_entregas,
            RANK() OVER (ORDER BY SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100 DESC) as rank_prazo,
            RANK() OVER (ORDER BY COUNT(*) DESC) as rank_volume
          FROM bi_entregas
          WHERE data_solicitado >= $1 AND data_solicitado <= $2
            AND COALESCE(ponto, 1) >= 2 AND cod_cliente IS NOT NULL AND estado = $3
          GROUP BY cod_cliente HAVING COUNT(*) >= 5
        )
        SELECT rank_prazo, rank_volume, (SELECT COUNT(*) FROM ranking_clientes) as total_ranqueados
        FROM ranking_clientes WHERE cod_cliente = $4
      `, [data_inicio, data_fim, estadoCliente, codInt]);

      // 11. PERÍODO ANTERIOR
      const diasPeriodo = Math.ceil((new Date(data_fim) - new Date(data_inicio)) / (1000 * 60 * 60 * 24));
      const inicioAnterior = new Date(new Date(data_inicio) - diasPeriodo * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const fimAnterior = new Date(new Date(data_inicio) - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const metricasAnteriores = await pool.query(`
        SELECT COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END) as total_entregas,
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 2) as taxa_prazo,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END), 1) as tempo_medio_entrega,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END), 1) as km_medio,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais_unicos
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
      `, [codInt, inicioAnterior, fimAnterior]);

      // 12. MONTAR DADOS
      const metricas = metricasCliente.rows[0];
      const benchmark = benchmarkRegiao.rows[0] || {};
      const rankingData = ranking.rows[0] || {};
      const metrAnterior = metricasAnteriores.rows[0];
      const healthScore = calcularHealthScore(metricas);

      const dadosAnalise = {
        cliente: { nome: ficha.nome_fantasia || `Cliente ${cod_cliente}`, cidade: ficha.cidade || '', estado: estadoCliente, segmento: ficha.segmento || 'autopeças', health_score: healthScore },
        periodo: { inicio: data_inicio, fim: data_fim, dias: diasPeriodo },
        metricas_atuais: metricas,
        metricas_periodo_anterior: metrAnterior,
        faixas_km: faixasKm.rows,
        mapa_calor_bairros: mapaCalor.rows,
        corridas_por_motoboy: corridasMotoboy.rows,
        padroes_horario: padroesHorario.rows,
        evolucao_semanal: evolucaoSemanal.rows,
        retornos_detalhados: retornosDetalhe.rows,
        benchmark_regiao: { ...benchmark, estado: estadoCliente },
        ranking_regiao: { posicao_prazo: rankingData.rank_prazo, posicao_volume: rankingData.rank_volume, total_clientes: rankingData.total_ranqueados },
      };

      // 13. PROMPT GEMINI
      const prompt = `Você é um consultor sênior de operações logísticas da Tutts, plataforma de gestão de entregas de autopeças. Você está preparando um RELATÓRIO OPERACIONAL para apresentar diretamente ao cliente ${dadosAnalise.cliente.nome}.

## REGRAS IMPORTANTES
- Este relatório será APRESENTADO AO CLIENTE. Tom: profissional, consultivo, parceiro.
- NÃO mencione valores financeiros, faturamento, ticket médio ou custos. Foque 100% na operação.
- Seja HONESTO: se houver problemas, aponte-os com clareza, mas sempre com a postura de "estamos juntos para resolver".
- Use os dados reais fornecidos. NÃO invente métricas.
- Formato: Markdown com emojis nos títulos. Português brasileiro.

## DADOS DA OPERAÇÃO
${JSON.stringify(dadosAnalise, null, 2)}

## ESTRUTURA DO RELATÓRIO

### 📊 VISÃO GERAL DA OPERAÇÃO
- Síntese executiva em 3-4 linhas da operação no período
- Total de entregas, dias operados, profissionais envolvidos
- Health Score: ${healthScore}/100 — explique o que significa para o cliente
- Classificação: [🟢 Excelente | 🟡 Boa com pontos de atenção | 🔴 Requer ação imediata]

### 🚀 ENTREGAS E DESEMPENHO
- Entregas realizadas no período (vs anterior com ↑↓%)
- Taxa de entregas no prazo (vs anterior com ↑↓%)
- Tempo médio de entrega e comparação com a meta
- Retornos: quantidade, motivos, o que está causando e como resolver

### 📍 MAPA DE COBERTURA E DISTÂNCIAS
- Faixas de km: onde concentra a operação
- Top bairros/regiões do mapa de calor
- Regiões com SLA crítico
- Correlação distância vs prazo

### 🏍️ ANÁLISE DAS CORRIDAS
- Motoboys ativos e corridas de cada um
- Entregas por saída — estão otimizadas?
- Padrões: muitas corridas curtas vs rotas longas
- Motoboys com performance acima/abaixo da média

### ⏰ PADRÕES DE HORÁRIO
- Horários de pico de demanda
- SLA por faixa horária
- Sugestão de janelas operacionais

### 📈 COMPARATIVO COM O MERCADO (${estadoCliente})
- Operação vs média regional
- Ranking: ${rankingData.rank_prazo || 'N/A'}º prazo, ${rankingData.rank_volume || 'N/A'}º volume de ${rankingData.total_ranqueados || 'N/A'}
- Onde está acima (celebre) e abaixo (proponha ação)

### 📉 TENDÊNCIAS E PROJEÇÕES
- Evolução semanal: crescendo, estável ou caindo?
- Atual vs anterior
- Projeção 30 dias
- Riscos [Alta | Média | Baixa]

### ⚠️ PROBLEMAS E COMO VAMOS RESOLVER
- Cada problema com: **Problema:** X → **Ação:** Y → **Resultado esperado:** Z
- Prioridade: [🔴 Urgente | 🟠 Importante | 🟡 Melhoria]

### 🎯 PLANO DE AÇÃO — PRÓXIMOS PASSOS
Top 5 ações: o que fazer, prazo, resultado esperado com meta numérica

### 💡 OPORTUNIDADES DE MELHORIA
- Otimizações de roteiro
- Melhorias de SLA por região/horário
- Quick wins imediatos
- Oportunidades de crescimento

IMPORTANTE: Celebre o que está bom. Seja honesto sobre problemas. Mostre que há um plano. Use números exatos.`;

      // 14. CHAMADA GEMINI
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
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

      // 15. SALVAR HISTÓRICO
      const saveResult = await pool.query(`
        INSERT INTO cs_raio_x_historico (
          cod_cliente, nome_cliente, data_inicio, data_fim,
          metricas_snapshot, benchmark_snapshot, analise_texto,
          tipo_analise, score_saude, alertas, recomendacoes,
          gerado_por, gerado_por_nome, tokens_utilizados
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `, [
        codInt, ficha.nome_fantasia || `Cliente ${cod_cliente}`, data_inicio, data_fim,
        JSON.stringify(dadosAnalise), JSON.stringify(benchmark), analiseTexto,
        tipo, healthScore, JSON.stringify([]), JSON.stringify([]),
        req.user?.codProfissional, req.user?.nome, tokensUsados,
      ]);

      console.log(`✅ Raio-X gerado: cliente=${cod_cliente}, health=${healthScore}, tokens=${tokensUsados}`);

      res.json({
        success: true,
        raio_x: {
          id: saveResult.rows[0].id, analise: analiseTexto, health_score: healthScore,
          dados_utilizados: dadosAnalise, tokens: tokensUsados, gerado_em: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('❌ Erro ao gerar Raio-X CS:', error);
      res.status(500).json({ error: 'Erro ao gerar Raio-X' });
    }
  });

  router.get('/cs/raio-x/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = await pool.query('SELECT * FROM cs_raio_x_historico WHERE id = $1', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Raio-X não encontrado' });
      res.json({ success: true, raio_x: result.rows[0] });
    } catch (error) {
      console.error('❌ Erro ao buscar Raio-X:', error);
      res.status(500).json({ error: 'Erro ao buscar Raio-X' });
    }
  });

  router.get('/cs/raio-x/historico/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      const result = await pool.query(
        `SELECT id, data_inicio, data_fim, tipo_analise, score_saude, gerado_por_nome, tokens_utilizados, created_at
         FROM cs_raio_x_historico WHERE cod_cliente = $1 ORDER BY created_at DESC LIMIT 20`, [cod]
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
