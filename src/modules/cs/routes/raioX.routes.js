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
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio_entrega,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END)::numeric, 2) as km_medio,
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0) as km_total,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END) as profissionais_unicos,
          COUNT(DISTINCT data_solicitado) as dias_com_entregas,
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%%cliente fechado%%' OR LOWER(ocorrencia) LIKE '%%clienteaus%%' OR
            LOWER(ocorrencia) LIKE '%%cliente ausente%%' OR LOWER(ocorrencia) LIKE '%%loja fechada%%' OR
            LOWER(ocorrencia) LIKE '%%produto incorreto%%'
          ) THEN 1 ELSE 0 END) as total_retornos,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio_alocacao,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN velocidade_media END)::numeric, 1) as velocidade_media
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
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
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
          COUNT(*) as entregas, ROUND(AVG(distancia)::numeric, 1) as km_medio,
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio,
          ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3 AND COALESCE(ponto, 1) >= 2
        GROUP BY COALESCE(NULLIF(bairro, ''), 'Não informado'), COALESCE(cidade, '')
        ORDER BY COUNT(*) DESC LIMIT 20
      `, [codInt, data_inicio, data_fim]);

      // 5. ANÁLISE DE CORRIDAS/ROTEIROS POR MOTOBOY
      // Agrupa OS do mesmo motoboy criadas em janela de 10 minutos = mesmo roteiro/saída
      const corridasMotoboy = await pool.query(`
        WITH entregas_ordenadas AS (
          SELECT 
            cod_prof, nome_prof, os, data_solicitado, data_hora,
            COALESCE(ponto, 1) as ponto,
            distancia
          FROM bi_entregas
          WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
            AND data_hora IS NOT NULL
        ),
        roteiros AS (
          SELECT 
            cod_prof, nome_prof, os, data_solicitado, data_hora, ponto, distancia,
            -- Detecta se esta OS pertence ao mesmo roteiro da anterior (mesma janela de 10min)
            CASE WHEN data_hora - LAG(data_hora) OVER (PARTITION BY cod_prof, data_solicitado ORDER BY data_hora)
                 <= INTERVAL '10 minutes'
            THEN 0 ELSE 1 END as nova_saida
          FROM entregas_ordenadas
        ),
        saidas_numeradas AS (
          SELECT *,
            SUM(nova_saida) OVER (PARTITION BY cod_prof, data_solicitado ORDER BY data_hora) as id_saida
          FROM roteiros
        ),
        resumo_saidas AS (
          SELECT 
            cod_prof, nome_prof, data_solicitado, id_saida,
            COUNT(DISTINCT os) as os_no_roteiro,
            COUNT(CASE WHEN ponto >= 2 THEN 1 END) as entregas_no_roteiro,
            COALESCE(SUM(CASE WHEN ponto >= 2 THEN distancia END), 0) as km_roteiro
          FROM saidas_numeradas
          GROUP BY cod_prof, nome_prof, data_solicitado, id_saida
        )
        SELECT 
          nome_prof,
          COUNT(*) as total_saidas,
          SUM(entregas_no_roteiro) as total_entregas,
          ROUND(SUM(entregas_no_roteiro)::numeric / NULLIF(COUNT(*), 0), 1) as entregas_por_saida,
          ROUND(SUM(os_no_roteiro)::numeric / NULLIF(COUNT(*), 0), 1) as os_por_saida,
          COUNT(DISTINCT data_solicitado) as dias_trabalhados,
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT data_solicitado), 0), 1) as saidas_por_dia,
          ROUND(AVG(km_roteiro)::numeric, 1) as km_medio_por_saida,
          ROUND(SUM(km_roteiro)::numeric, 1) as km_total
        FROM resumo_saidas
        WHERE entregas_no_roteiro > 0
        GROUP BY nome_prof
        ORDER BY SUM(entregas_no_roteiro) DESC LIMIT 15
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
          ROUND(AVG(tempo_execucao_minutos)::numeric, 1) as tempo_medio
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
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END)::numeric, 1) as km_medio,
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
        SELECT ROUND(AVG(taxa_prazo)::numeric, 1) as media_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY taxa_prazo)::numeric, 1) as mediana_taxa_prazo,
          ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY taxa_prazo)::numeric, 1) as p75_taxa_prazo,
          ROUND(AVG(total_entregas)::numeric, 0) as media_entregas,
          ROUND(AVG(km_medio)::numeric, 1) as media_km,
          ROUND(AVG(tempo_medio)::numeric, 1) as media_tempo_entrega,
          ROUND(AVG(taxa_retorno)::numeric, 2) as media_taxa_retorno,
          COUNT(*) as total_clientes_regiao
        FROM (
          SELECT cod_cliente,
            ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo,
            COUNT(*) as total_entregas, ROUND(AVG(distancia)::numeric, 1) as km_medio,
            ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 AND tempo_execucao_minutos <= 300 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio,
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
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 AND tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio_entrega,
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia END)::numeric, 1) as km_medio,
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

      // Link do mapa de calor interativo
      const baseUrl = process.env.BASE_URL || req.protocol + '://' + req.get('host');
      const linkMapaCalor = `${baseUrl}/api/cs/mapa-calor/${codInt}?data_inicio=${data_inicio}&data_fim=${data_fim}`;

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
        link_mapa_calor: linkMapaCalor,
      };

      // 13. PROMPT GEMINI
      const prompt = `Você é um consultor sênior de operações logísticas da Tutts, plataforma de gestão de entregas de autopeças. Você está preparando um RELATÓRIO OPERACIONAL para apresentar diretamente ao cliente ${dadosAnalise.cliente.nome}.

## REGRAS OBRIGATÓRIAS
- Este relatório será APRESENTADO AO CLIENTE FINAL. Tom: profissional, consultivo, parceiro.
- NÃO mencione valores financeiros, faturamento, ticket médio ou custos em nenhuma parte do relatório.
- Seja HONESTO: se houver problemas, aponte-os com clareza, mas sempre com a postura de "estamos juntos para resolver".
- Use os dados reais fornecidos. NÃO invente métricas.
- Formato: Markdown com emojis nos títulos. Português brasileiro.
- O horário de operação é das 08:00 às 18:00. Qualquer análise de horário deve considerar esta janela. Entregas após 18h são exceções, não rotina.
- NÃO faça observações óbvias como "quanto maior a distância, maior o tempo de entrega".
- NÃO sugira ao cliente que mude sua operação interna, centro de distribuição, ou processos internos dele. As sugestões devem ser sobre o que a TUTTS pode fazer pela operação.
- NÃO sugira serviços ou produtos fora do ramo de autopeças.
- Se dados de bairro/rua estiverem como "Não informado" ou vazios, NÃO liste esses bairros. Em vez disso, mencione que disponibilizamos um mapa de calor interativo no link abaixo.

## DADOS DA OPERAÇÃO
${JSON.stringify(dadosAnalise, null, 2)}

## ESTRUTURA DO RELATÓRIO

### 📊 VISÃO GERAL DA OPERAÇÃO
- Síntese executiva em 3-4 linhas da operação no período
- Total de entregas, dias operados, profissionais envolvidos
- Health Score: ${healthScore}/100 — explique o que significa para o cliente de forma simples
- Classificação: [🟢 Excelente | 🟡 Boa com pontos de atenção | 🔴 Requer ação imediata]

### 🚀 ENTREGAS E DESEMPENHO
- Entregas realizadas no período (vs anterior com ↑↓%)
- Taxa de entregas no prazo (vs anterior com ↑↓%)
- Tempo médio de entrega e comparação com a meta do setor (30-45min para autopeças urbano)
- Se houver retornos: quantidade, motivos principais e plano de ação imediato. Se não houver, celebre.

### 📍 COBERTURA GEOGRÁFICA E DISTÂNCIAS
- Analise as faixas de KM: onde está concentrada a maior parte da operação e como o SLA se comporta em cada faixa
- NÃO liste bairros com nome "Não informado". Se a maioria dos bairros estiver vazia, diga apenas:
  "Para uma visualização detalhada da cobertura geográfica, disponibilizamos um **mapa de calor interativo** onde é possível ver cada ponto de entrega, taxa de prazo por região e tempo médio. Acesse: ${linkMapaCalor}"
- Se houver dados de bairro válidos, mencione apenas os que têm nome real

### 🏍️ ANÁLISE DOS ROTEIROS E PROFISSIONAIS
- Os dados de corridas mostram ROTEIROS: OS do mesmo motoboy criadas em janela de 10 minutos foram agrupadas como uma "saída" (roteiro).
- Analise: quantas saídas/roteiros cada motoboy fez no período
- Média de entregas por saída — se for 1, o motoboy saiu para entregar uma peça por vez (ineficiente). Se for 3+, está otimizado.
- Saídas por dia: quantos roteiros o motoboy faz por dia
- Identifique motoboys destaque (muitas entregas, eficiente) e os que podem melhorar
- Compare a performance entre eles de forma construtiva

### ⏰ JANELA OPERACIONAL (08h às 18h)
- Analise a distribuição de entregas dentro da janela 08-18h
- Identifique os horários de maior demanda (picos)
- Compare o SLA entre faixas horárias — qual horário tem melhor/pior desempenho?
- Se houver entregas após 18h, mencione como exceção e sugira ações para que o maior volume seja concentrado no horário operacional
- NÃO sugira estender horário de operação

### 📈 COMPARATIVO COM O MERCADO (${estadoCliente})
- Compare a operação com a média dos clientes Tutts na mesma região
- Ranking: ${rankingData.rank_prazo || 'N/A'}º em prazo e ${rankingData.rank_volume || 'N/A'}º em volume entre ${rankingData.total_ranqueados || 'N/A'} operações
- Celebre onde está acima da média. Onde estiver abaixo, diga o que a Tutts vai fazer para melhorar.
- Use "média da região", "top 25% do mercado" — nunca nomes de outros clientes

### 📉 TENDÊNCIAS E PROJEÇÕES
- Evolução semanal: volume crescendo, estável ou caindo?
- Comparação período atual vs anterior (volume, prazo)
- Projeção para os próximos 30 dias
- Riscos identificados [Alta | Média | Baixa]

### ⚠️ PONTOS DE ATENÇÃO E AÇÕES
- Liste cada problema real encontrado nos dados
- Para cada: **Situação:** X → **O que faremos:** Y → **Meta:** Z
- Priorize: [🔴 Urgente | 🟠 Importante | 🟡 Melhoria contínua]
- Foque apenas em problemas reais dos dados, não genéricos

### 🎯 PLANO DE AÇÃO — PRÓXIMOS PASSOS
Top 5 ações CONCRETAS que a TUTTS vai realizar:
1. O que será feito
2. Prazo
3. Meta numérica esperada
As ações devem ser coisas que a Tutts controla (ex: realocar motoboys, ajustar roteiros, intensificar acompanhamento). NÃO peça ao cliente para mudar processos internos dele.

### 💡 OPORTUNIDADES
- Sugestões de otimização que a Tutts pode implementar para melhorar a operação do cliente
- Quick wins baseados nos dados (ex: concentrar entregas de regiões próximas no mesmo roteiro)
- NÃO sugira produtos/serviços fora do ramo de autopeças
- NÃO sugira que o cliente mude layout, equipe, ou processos internos
- Foque no que PODEMOS FAZER por ele como parceiro logístico

ENCERRAMENTO: Feche com tom de parceria — "estamos à disposição para apresentar este relatório em detalhes".`;

      // Incluir link do mapa no response final
      // Incluir link do mapa no response final
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
          link_mapa_calor: linkMapaCalor,
        },
      });
    } catch (error) {
      console.error('❌ Erro ao gerar Raio-X CS:', error.message, error.stack);
      res.status(500).json({ error: `Erro ao gerar Raio-X: ${error.message}` });
    }
  });

  // ==================== GET /cs/mapa-calor/:cod ====================
  router.get('/cs/mapa-calor/:cod', async (req, res) => {
    try {
      const cod = parseInt(req.params.cod);
      const { data_inicio, data_fim } = req.query;
      const inicio = data_inicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const fim = data_fim || new Date().toISOString().split('T')[0];

      const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
      if (!GOOGLE_API_KEY) {
        return res.status(400).send('GOOGLE_GEOCODING_API_KEY não configurada');
      }

      const clienteResult = await pool.query('SELECT nome_fantasia FROM cs_clientes WHERE cod_cliente = $1', [cod]);
      const nomeCliente = clienteResult.rows[0]?.nome_fantasia || `Cliente ${cod}`;

      const entregas = await pool.query(`
        SELECT 
          endereco, bairro, cidade, estado,
          COUNT(*) as quantidade,
          ROUND(SUM(CASE WHEN dentro_prazo = true THEN 1 ELSE 0 END)::numeric /
            NULLIF(COUNT(CASE WHEN dentro_prazo IS NOT NULL THEN 1 END), 0) * 100, 1) as taxa_prazo,
          ROUND(AVG(distancia)::numeric, 1) as km_medio,
          ROUND(AVG(CASE WHEN tempo_execucao_minutos > 0 THEN tempo_execucao_minutos END)::numeric, 1) as tempo_medio
        FROM bi_entregas
        WHERE cod_cliente = $1 AND data_solicitado >= $2 AND data_solicitado <= $3
          AND COALESCE(ponto, 1) >= 2
          AND endereco IS NOT NULL AND endereco != ''
        GROUP BY endereco, bairro, cidade, estado
        ORDER BY COUNT(*) DESC
        LIMIT 300
      `, [cod, inicio, fim]);

      const totalEntregas = entregas.rows.reduce((s, r) => s + parseInt(r.quantidade), 0);

      const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mapa de Calor — ${nomeCliente}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', -apple-system, sans-serif; background: #0f172a; }
    #header { 
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%); 
      color: white; padding: 20px 28px;
      display: flex; align-items: center; justify-content: space-between;
    }
    #header .left h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
    #header .left p { font-size: 13px; opacity: 0.85; margin-top: 4px; }
    #header .right { text-align: right; }
    #header .stat { font-size: 28px; font-weight: 800; }
    #header .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; }
    #map { height: calc(100vh - 80px); width: 100%; }
    
    .info-panel {
      background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      padding: 16px 20px; font-size: 13px; line-height: 1.7; min-width: 200px;
    }
    .info-panel h3 { font-size: 14px; font-weight: 700; color: #1e293b; margin-bottom: 8px; }
    .info-panel .progress { background: #e2e8f0; border-radius: 4px; height: 6px; margin: 4px 0 8px; }
    .info-panel .progress-bar { height: 100%; border-radius: 4px; transition: width 0.5s; }
    
    .legend { 
      background: white; border-radius: 10px; padding: 14px 18px; 
      box-shadow: 0 4px 16px rgba(0,0,0,0.12); font-size: 12px;
    }
    .legend h4 { font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .legend-item { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
    
    .toggle-btn {
      background: white; border: none; border-radius: 8px; padding: 8px 14px;
      font-size: 12px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      display: flex; align-items: center; gap: 6px; color: #334155;
    }
    .toggle-btn:hover { background: #f1f5f9; }
    .toggle-btn.active { background: #6366f1; color: white; }
  </style>
</head>
<body>
  <div id="header">
    <div class="left">
      <h1>🗺️ Mapa de Calor — ${nomeCliente}</h1>
      <p>Período: ${inicio} a ${fim}</p>
    </div>
    <div class="right">
      <div class="stat">${totalEntregas.toLocaleString('pt-BR')}</div>
      <div class="stat-label">entregas mapeadas</div>
    </div>
  </div>
  <div id="map"></div>

  <script>
    const GOOGLE_KEY = '${GOOGLE_API_KEY}';
    const enderecos = ${JSON.stringify(entregas.rows)};
    
    let map, heatmap, markers = [], heatData = [];
    let showHeat = true, showMarkers = true;

    function initMap() {
      map = new google.maps.Map(document.getElementById('map'), {
        zoom: 12, center: { lat: -12.97, lng: -38.51 },
        mapTypeId: 'roadmap',
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'simplified' }] }
        ],
        mapTypeControl: true,
        mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_LEFT },
        fullscreenControl: true,
      });

      // Legenda
      const legendDiv = document.createElement('div');
      legendDiv.className = 'legend';
      legendDiv.style.margin = '10px';
      legendDiv.innerHTML = \`
        <h4>📊 Legenda SLA</h4>
        <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div> Prazo ≥ 95%</div>
        <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div> Prazo 85-95%</div>
        <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div> Prazo < 85%</div>
        <div style="border-top: 1px solid #e2e8f0; margin: 8px 0; padding-top: 8px;">
          <div class="legend-item"><div class="legend-dot" style="background:rgba(99,102,241,0.5);width:8px;height:8px"></div> Menor volume</div>
          <div class="legend-item"><div class="legend-dot" style="background:rgba(99,102,241,0.8);width:16px;height:16px"></div> Maior volume</div>
        </div>
      \`;
      map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(legendDiv);

      // Botões de toggle
      const toggleDiv = document.createElement('div');
      toggleDiv.style.margin = '10px';
      toggleDiv.style.display = 'flex';
      toggleDiv.style.gap = '6px';
      toggleDiv.innerHTML = \`
        <button id="btnHeat" class="toggle-btn active" onclick="toggleHeat()">🔥 Calor</button>
        <button id="btnMarkers" class="toggle-btn active" onclick="toggleMarkers()">📍 Marcadores</button>
      \`;
      map.controls[google.maps.ControlPosition.TOP_RIGHT].push(toggleDiv);

      // Info panel
      const infoDiv = document.createElement('div');
      infoDiv.className = 'info-panel';
      infoDiv.id = 'infoPanel';
      infoDiv.style.margin = '10px';
      infoDiv.innerHTML = '<h3>⏳ Geocodificando endereços...</h3><p>0 / ' + enderecos.length + '</p>';
      map.controls[google.maps.ControlPosition.LEFT_BOTTOM].push(infoDiv);

      geocodeAll();
    }

    function toggleHeat() {
      showHeat = !showHeat;
      heatmap && heatmap.setMap(showHeat ? map : null);
      document.getElementById('btnHeat').classList.toggle('active', showHeat);
    }
    function toggleMarkers() {
      showMarkers = !showMarkers;
      markers.forEach(m => m.setMap(showMarkers ? map : null));
      document.getElementById('btnMarkers').classList.toggle('active', showMarkers);
    }

    async function geocode(addr) {
      return new Promise((resolve) => {
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ address: addr, region: 'BR' }, (results, status) => {
          if (status === 'OK' && results[0]) {
            resolve({ lat: results[0].geometry.location.lat(), lng: results[0].geometry.location.lng() });
          } else {
            resolve(null);
          }
        });
      });
    }

    async function geocodeAll() {
      const bounds = new google.maps.LatLngBounds();
      let geocoded = 0;
      let successCount = 0;

      for (const e of enderecos) {
        const addr = [e.endereco, e.bairro, e.cidade, e.estado].filter(Boolean).join(', ');
        const coords = await geocode(addr);
        geocoded++;

        if (coords) {
          successCount++;
          const pos = new google.maps.LatLng(coords.lat, coords.lng);
          const qty = parseInt(e.quantidade);
          const prazo = parseFloat(e.taxa_prazo || 0);
          
          // Heatmap data (weighted)
          heatData.push({ location: pos, weight: Math.min(qty, 30) });

          // Marker com cor por SLA
          const color = prazo >= 95 ? '#10b981' : prazo >= 85 ? '#f59e0b' : '#ef4444';
          const size = Math.max(8, Math.min(qty * 1.5, 24));
          
          const marker = new google.maps.Marker({
            position: pos, map: map,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: size, fillColor: color, fillOpacity: 0.7,
              strokeColor: 'white', strokeWeight: 2,
            },
          });

          const infoWindow = new google.maps.InfoWindow({
            content: \`<div style="font-family:Segoe UI,sans-serif;padding:4px;min-width:180px">
              <b style="font-size:14px;color:#1e293b">\${e.bairro || e.endereco}</b>
              <div style="color:#64748b;font-size:12px;margin-bottom:8px">\${e.cidade || ''}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:13px">
                <span>📦 Entregas</span><b>\${qty}</b>
                <span>⏱️ Prazo</span><b style="color:\${color}">\${e.taxa_prazo}%</b>
                <span>📏 KM médio</span><b>\${e.km_medio || '-'}</b>
                <span>🕐 Tempo médio</span><b>\${e.tempo_medio || '-'} min</b>
              </div>
            </div>\`
          });
          marker.addListener('click', () => infoWindow.open(map, marker));
          markers.push(marker);
          bounds.extend(pos);
        }

        // Update progress
        if (geocoded % 5 === 0 || geocoded === enderecos.length) {
          document.getElementById('infoPanel').innerHTML = \`
            <h3>📍 Mapeando entregas</h3>
            <p>\${successCount} de \${enderecos.length} endereços</p>
            <div class="progress"><div class="progress-bar" style="width:\${(geocoded/enderecos.length*100).toFixed(0)}%;background:#6366f1"></div></div>
          \`;
        }

        // Rate limit Google Geocoding (50/seg no plano pago, mas vamos ser conservadores)
        await new Promise(r => setTimeout(r, 100));
      }

      // Criar heatmap layer
      if (heatData.length > 0) {
        heatmap = new google.maps.visualization.HeatmapLayer({
          data: heatData,
          map: map,
          radius: 40,
          opacity: 0.6,
          gradient: [
            'rgba(0, 0, 0, 0)', 'rgba(99, 102, 241, 0.3)', 'rgba(59, 130, 246, 0.5)',
            'rgba(16, 185, 129, 0.6)', 'rgba(245, 158, 11, 0.7)', 'rgba(239, 68, 68, 0.8)',
            'rgba(220, 38, 38, 0.9)'
          ],
        });
        map.fitBounds(bounds);
      }

      // Final info
      document.getElementById('infoPanel').innerHTML = \`
        <h3>✅ Mapa completo</h3>
        <p><b>\${successCount}</b> de \${enderecos.length} endereços mapeados</p>
        <p style="font-size:11px;color:#94a3b8;margin-top:4px">Use os botões 🔥 e 📍 para alternar camadas</p>
      \`;
    }
  </script>
  <script src="https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&libraries=visualization&callback=initMap" async defer></script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      console.error('❌ Erro mapa de calor:', error);
      res.status(500).json({ error: 'Erro ao gerar mapa de calor' });
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
