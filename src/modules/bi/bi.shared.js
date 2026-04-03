/**
 * BI Shared Functions
 * Functions used across multiple BI sub-routers
 * 
 * 🔧 FIX: Métricas alinhadas com DAX do Power BI:
 * - ValorTotal = SUMX(SUMMARIZE(OS, FIRSTNONBLANK(Valor))) → DISTINCT ON (os) ORDER BY ponto ASC
 * - ValorProfissional = idem para valor_prof
 * - FaturamentoLiquido = ValorTotal - ValorProfissional
 * - TicketMedio = FaturamentoLiquido / QtdEntregas
 * - QtdEntregas = COUNT rows WHERE ponto >= 2
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
        WITH os_val AS (
          SELECT DISTINCT ON (os) os, data_solicitado, valor, valor_prof
          FROM bi_entregas WHERE os IS NOT NULL ${filtroData}
          ORDER BY os, ponto ASC
        ),
        fat_dia AS (
          SELECT data_solicitado,
            COALESCE(SUM(valor), 0) as valor_total,
            COALESCE(SUM(valor_prof), 0) as valor_prof
          FROM os_val GROUP BY data_solicitado
        )
        INSERT INTO bi_resumo_diario (
          data, total_os, total_entregas, entregas_no_prazo, entregas_fora_prazo,
          taxa_prazo, total_retornos, valor_total, valor_prof, ticket_medio,
          tempo_medio_entrega, tempo_medio_alocacao, tempo_medio_coleta,
          total_profissionais, media_ent_profissional, km_total, updated_at
        )
        SELECT 
          e.data_solicitado,
          COUNT(DISTINCT e.os),
          COUNT(*),
          SUM(CASE WHEN e.dentro_prazo = true THEN 1 ELSE 0 END),
          SUM(CASE WHEN e.dentro_prazo = false THEN 1 ELSE 0 END),
          ROUND(SUM(CASE WHEN e.dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
                NULLIF(COUNT(*), 0) * 100, 2),
          SUM(CASE WHEN 
            LOWER(e.ocorrencia) LIKE '%cliente fechado%' OR 
            LOWER(e.ocorrencia) LIKE '%clienteaus%' OR 
            LOWER(e.ocorrencia) LIKE '%cliente ausente%'
          THEN 1 ELSE 0 END),
          COALESCE(f.valor_total, 0),
          COALESCE(f.valor_prof, 0),
          ROUND(COALESCE(f.valor_total - f.valor_prof, 0)::numeric / NULLIF(COUNT(*), 0), 2),
          ROUND(AVG(e.tempo_execucao_minutos), 2),
          NULL,
          NULL,
          COUNT(DISTINCT e.cod_prof),
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT e.cod_prof), 0), 2),
          COALESCE(SUM(e.distancia), 0),
          NOW()
        FROM bi_entregas e
        LEFT JOIN fat_dia f ON f.data_solicitado = e.data_solicitado
        WHERE e.data_solicitado IS NOT NULL AND COALESCE(e.ponto, 1) >= 2 ${filtroData}
        GROUP BY e.data_solicitado, f.valor_total, f.valor_prof
        ON CONFLICT (data) DO UPDATE SET
          total_os = EXCLUDED.total_os, total_entregas = EXCLUDED.total_entregas,
          entregas_no_prazo = EXCLUDED.entregas_no_prazo, entregas_fora_prazo = EXCLUDED.entregas_fora_prazo,
          taxa_prazo = EXCLUDED.taxa_prazo, total_retornos = EXCLUDED.total_retornos,
          valor_total = EXCLUDED.valor_total, valor_prof = EXCLUDED.valor_prof,
          ticket_medio = EXCLUDED.ticket_medio, tempo_medio_entrega = EXCLUDED.tempo_medio_entrega,
          tempo_medio_alocacao = COALESCE(EXCLUDED.tempo_medio_alocacao, bi_resumo_diario.tempo_medio_alocacao),
          tempo_medio_coleta = COALESCE(EXCLUDED.tempo_medio_coleta, bi_resumo_diario.tempo_medio_coleta),
          total_profissionais = EXCLUDED.total_profissionais, media_ent_profissional = EXCLUDED.media_ent_profissional,
          km_total = EXCLUDED.km_total, updated_at = NOW()
      `, params);
      console.log('📊 Resumo diário atualizado');

      // 2. RESUMO POR CLIENTE
      await pool.query(`
        WITH os_val AS (
          SELECT DISTINCT ON (os) os, data_solicitado, cod_cliente, valor, valor_prof
          FROM bi_entregas WHERE os IS NOT NULL AND cod_cliente IS NOT NULL ${filtroData}
          ORDER BY os, ponto ASC
        ),
        fat_cli AS (
          SELECT data_solicitado, cod_cliente,
            COALESCE(SUM(valor), 0) as valor_total,
            COALESCE(SUM(valor_prof), 0) as valor_prof
          FROM os_val GROUP BY data_solicitado, cod_cliente
        )
        INSERT INTO bi_resumo_cliente (
          data, cod_cliente, nome_fantasia, total_os, total_entregas,
          entregas_no_prazo, entregas_fora_prazo, taxa_prazo, total_retornos,
          valor_total, valor_prof, ticket_medio, tempo_medio_entrega,
          total_profissionais, media_ent_profissional, updated_at
        )
        SELECT 
          e.data_solicitado, e.cod_cliente, MAX(e.nome_fantasia),
          COUNT(DISTINCT e.os),
          COUNT(*),
          SUM(CASE WHEN e.dentro_prazo = true THEN 1 ELSE 0 END),
          SUM(CASE WHEN e.dentro_prazo = false THEN 1 ELSE 0 END),
          ROUND(SUM(CASE WHEN e.dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
                NULLIF(COUNT(*), 0) * 100, 2),
          SUM(CASE WHEN 
            LOWER(e.ocorrencia) LIKE '%cliente fechado%' OR 
            LOWER(e.ocorrencia) LIKE '%clienteaus%' OR 
            LOWER(e.ocorrencia) LIKE '%cliente ausente%'
          THEN 1 ELSE 0 END),
          COALESCE(f.valor_total, 0),
          COALESCE(f.valor_prof, 0),
          ROUND(COALESCE(f.valor_total - f.valor_prof, 0)::numeric / NULLIF(COUNT(*), 0), 2),
          ROUND(AVG(e.tempo_execucao_minutos), 2),
          COUNT(DISTINCT e.cod_prof),
          ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT e.cod_prof), 0), 2),
          NOW()
        FROM bi_entregas e
        LEFT JOIN fat_cli f ON f.data_solicitado = e.data_solicitado AND f.cod_cliente = e.cod_cliente
        WHERE e.data_solicitado IS NOT NULL AND e.cod_cliente IS NOT NULL
          AND COALESCE(e.ponto, 1) >= 2 ${filtroData}
        GROUP BY e.data_solicitado, e.cod_cliente, f.valor_total, f.valor_prof
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
        WITH os_val AS (
          SELECT DISTINCT ON (os) os, data_solicitado, cod_prof, valor, valor_prof
          FROM bi_entregas WHERE os IS NOT NULL AND cod_prof IS NOT NULL ${filtroData}
          ORDER BY os, ponto ASC
        ),
        fat_prof AS (
          SELECT data_solicitado, cod_prof,
            COALESCE(SUM(valor), 0) as valor_total,
            COALESCE(SUM(valor_prof), 0) as valor_prof
          FROM os_val GROUP BY data_solicitado, cod_prof
        )
        INSERT INTO bi_resumo_profissional (
          data, cod_prof, nome_prof, total_os, total_entregas,
          entregas_no_prazo, entregas_fora_prazo, taxa_prazo,
          valor_total, valor_prof, tempo_medio_entrega, km_total, updated_at
        )
        SELECT 
          e.data_solicitado, e.cod_prof, MAX(e.nome_prof),
          COUNT(DISTINCT e.os),
          COUNT(*),
          SUM(CASE WHEN e.dentro_prazo = true THEN 1 ELSE 0 END),
          SUM(CASE WHEN e.dentro_prazo = false THEN 1 ELSE 0 END),
          ROUND(SUM(CASE WHEN e.dentro_prazo = true THEN 1 ELSE 0 END)::numeric / 
                NULLIF(COUNT(*), 0) * 100, 2),
          COALESCE(f.valor_total, 0),
          COALESCE(f.valor_prof, 0),
          ROUND(AVG(e.tempo_execucao_minutos), 2),
          COALESCE(SUM(e.distancia), 0),
          NOW()
        FROM bi_entregas e
        LEFT JOIN fat_prof f ON f.data_solicitado = e.data_solicitado AND f.cod_prof = e.cod_prof
        WHERE e.data_solicitado IS NOT NULL AND e.cod_prof IS NOT NULL
          AND COALESCE(e.ponto, 1) >= 2 ${filtroData}
        GROUP BY e.data_solicitado, e.cod_prof, f.valor_total, f.valor_prof
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
