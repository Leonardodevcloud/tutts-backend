/**
 * BI Shared Functions
 * Functions used across multiple BI sub-routers
 */

function createAtualizarResumos(pool) {
  return async function atualizarResumos(datasAfetadas = null) {
    try {
      console.log('📊 Iniciando atualização dos resumos pré-calculados...');
      const inicio = Date.now();

      let filtroData = '';
      const params = [];
      if (datasAfetadas && datasAfetadas.length > 0) {
        filtroData = 'AND data_solicitado = ANY($1::date[])';
        params.push(datasAfetadas);
      }

      // 1. RESUMO DIÁRIO
      await pool.query(`
        INSERT INTO bi_resumo_diario (
          data, total_os, total_entregas, entregas_no_prazo, entregas_fora_prazo,
          taxa_prazo, total_retornos, valor_total, valor_prof, ticket_medio,
          tempo_medio_entrega, tempo_medio_alocacao, tempo_medio_coleta,
          total_profissionais, media_ent_profissional, km_total, updated_at
        )
        SELECT 
          data_solicitado,
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
            LOWER(ocorrencia) LIKE '%clienteaus%' OR 
            LOWER(ocorrencia) LIKE '%cliente ausente%'
          ) THEN 1 ELSE 0 END),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
          ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2),
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_execucao_minutos END), 2),
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN tempo_entrega_prof_minutos END), 2),
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END),
          ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / 
                NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 2),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0),
          NOW()
        FROM bi_entregas
        WHERE data_solicitado IS NOT NULL ${filtroData}
        GROUP BY data_solicitado
        ON CONFLICT (data) DO UPDATE SET
          total_os = EXCLUDED.total_os, total_entregas = EXCLUDED.total_entregas,
          entregas_no_prazo = EXCLUDED.entregas_no_prazo, entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
          taxa_prazo = EXCLUDED.taxa_prazo, total_retornos = EXCLUDED.total_retornos,
          valor_total = EXCLUDED.valor_total, valor_prof = EXCLUDED.valor_prof,
          ticket_medio = EXCLUDED.ticket_medio, tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
          tempo_medio_alocacao = EXCLUDED.tempo_medio_alocacao, tempo_medio_coleta = EXCLUDED.tempo_medio_coleta,
          total_profissionais = EXCLUDED.total_profissionais, media_ent_profissional = EXCLUDED.media_ent_profissional,
          km_total = EXCLUDED.km_total, updated_at = NOW()
      `, params);
      console.log('📊 Resumo diário atualizado');

      // 2. RESUMO POR CLIENTE
      await pool.query(`
        INSERT INTO bi_resumo_cliente (
          data, cod_cliente, nome_fantasia, total_os, total_entregas,
          entregas_no_prazo, entregas_fora_prazo, taxa_prazo, total_retornos,
          valor_total, valor_prof, ticket_medio, tempo_medio_entrega,
          total_profissionais, media_ent_profissional, updated_at
        )
        SELECT 
          data_solicitado, cod_cliente, MAX(nome_fantasia),
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND (
            LOWER(ocorrencia) LIKE '%cliente fechado%' OR 
            LOWER(ocorrencia) LIKE '%clienteaus%' OR 
            LOWER(ocorrencia) LIKE '%cliente ausente%'
          ) THEN 1 ELSE 0 END),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
          ROUND(COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0)::numeric / 
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0), 2),
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END),
          ROUND(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END)::numeric / 
                NULLIF(COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN cod_prof END), 0), 2),
          NOW()
        FROM bi_entregas
        WHERE data_solicitado IS NOT NULL AND cod_cliente IS NOT NULL ${filtroData}
        GROUP BY data_solicitado, cod_cliente
        ON CONFLICT (data, cod_cliente) DO UPDATE SET
          nome_fantasia = EXCLUDED.nome_fantasia, total_os = EXCLUDED.total_os,
          total_entregas = EXCLUDED.total_entregas, entregas_no_prazo = EXCLUDED.entregas_no_prazo,
          entregas_fora_prazo = EXCLUDED.entregas_fora_prazo, taxa_prazo = EXCLUDED.taxa_prazo,
          total_retornos = EXCLUDED.total_retornos, valor_total = EXCLUDED.valor_total,
          valor_prof = EXCLUDED.valor_prof, ticket_medio = EXCLUDED.ticket_medio,
          tempo_medio_entrega = EXCLUDED.tempo_medio_entrega, total_profissionais = EXCLUDED.total_profissionais,
          media_ent_profissional = EXCLUDED.media_ent_profissional, updated_at = NOW()
      `, params);
      console.log('📊 Resumo por cliente atualizado');

      // 3. RESUMO POR PROFISSIONAL
      await pool.query(`
        INSERT INTO bi_resumo_profissional (
          data, cod_prof, nome_prof, total_os, total_entregas,
          entregas_no_prazo, entregas_fora_prazo, taxa_prazo,
          valor_total, valor_prof, tempo_medio_entrega, km_total, updated_at
        )
        SELECT 
          data_solicitado, cod_prof, MAX(nome_prof),
          COUNT(DISTINCT CASE WHEN COALESCE(ponto, 1) >= 2 THEN os END),
          COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END),
          SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = false THEN 1 ELSE 0 END),
          ROUND(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 AND dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
                NULLIF(COUNT(CASE WHEN COALESCE(ponto, 1) >= 2 THEN 1 END), 0) * 100, 2),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN valor_prof ELSE 0 END), 0),
          ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN tempo_execucao_minutos END), 2),
          COALESCE(SUM(CASE WHEN COALESCE(ponto, 1) >= 2 THEN distancia ELSE 0 END), 0),
          NOW()
        FROM bi_entregas
        WHERE data_solicitado IS NOT NULL AND cod_prof IS NOT NULL ${filtroData}
        GROUP BY data_solicitado, cod_prof
        ON CONFLICT (data, cod_prof) DO UPDATE SET
          nome_prof = EXCLUDED.nome_prof, total_os = EXCLUDED.total_os,
          total_entregas = EXCLUDED.total_entregas, entregas_no_prazo = EXCLUDED.entregas_no_prazo,
          entregas_fora_prazo = EXCLUDED.entregas_fora_prazo, taxa_prazo = EXCLUDED.taxa_prazo,
          valor_total = EXCLUDED.valor_total, valor_prof = EXCLUDED.valor_prof,
          tempo_medio_entrega = EXCLUDED.tempo_medio_entrega, km_total = EXCLUDED.km_total,
          updated_at = NOW()
      `, params);
      console.log('📊 Resumo por profissional atualizado');

      const tempo = ((Date.now() - inicio) / 1000).toFixed(2);
      console.log(`✅ Resumos atualizados em ${tempo}s`);
      return { success: true, tempo };
    } catch (error) {
      console.error('❌ Erro ao atualizar resumos:', error);
      return { success: false, error: error.message };
    }
  };
}

module.exports = { createAtualizarResumos };
