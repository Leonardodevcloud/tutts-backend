/**
 * src/shared/migrations/bi-materialized-views.js
 * 🚀 Materialized Views para reduzir compute hours do Neon
 *
 * COMO FUNCIONA:
 * - View `bi_entregas_diario_mat` agrega métricas POR DIA + cliente + centro_custo.
 * - Dashboard pode consultar essa view (1 linha por dia/cliente/centro) em vez
 *   da bi_entregas crua (N linhas).
 * - REFRESH é disparado:
 *   1) Após upload/recálculo de entregas (já existem hooks no cache invalidation)
 *   2) Por cron horário no worker (failsafe)
 *
 * QUANDO USAR:
 * - Endpoints de dashboards que mostram totais agregados por período
 * - Comparativo semanal/mensal
 * - Resumos de cliente
 *
 * QUANDO NÃO USAR:
 * - Drill-down por OS específica (ainda usa bi_entregas direto)
 * - Filtros muito específicos (cidade exata + categoria + retorno) que não se
 *   beneficiam de pré-agregação
 *
 * ROLLBACK: DROP MATERIALIZED VIEW IF EXISTS bi_entregas_diario_mat;
 */

async function createBiMaterializedViews(pool) {
  console.log('🚀 Criando materialized views do BI...');

  try {
    // View principal: agregação por dia + cliente + centro_custo
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS bi_entregas_diario_mat AS
      SELECT
        data_solicitado,
        cod_cliente,
        nome_cliente,
        centro_custo,
        COUNT(DISTINCT os) AS total_os,
        COUNT(*) AS total_entregas,
        COUNT(*) FILTER (WHERE dentro_prazo = true) AS dentro_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo = false) AS fora_prazo,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = true) AS dentro_prazo_prof,
        COUNT(*) FILTER (WHERE dentro_prazo_prof = false) AS fora_prazo_prof,
        AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos IS NOT NULL) AS tempo_medio,
        AVG(tempo_entrega_prof_minutos) FILTER (WHERE tempo_entrega_prof_minutos IS NOT NULL) AS tempo_medio_prof,
        SUM(COALESCE(valor, 0)) AS valor_total,
        SUM(COALESCE(valor_prof, 0)) AS valor_prof_total,
        AVG(distancia) FILTER (WHERE distancia IS NOT NULL) AS distancia_media
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL
      GROUP BY data_solicitado, cod_cliente, nome_cliente, centro_custo
    `);

    // Índices na view para consultas rápidas
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bi_diario_mat_pk 
      ON bi_entregas_diario_mat(data_solicitado, cod_cliente, COALESCE(centro_custo, ''))
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_diario_mat_data ON bi_entregas_diario_mat(data_solicitado)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bi_diario_mat_cliente ON bi_entregas_diario_mat(cod_cliente)`);

    console.log('✅ bi_entregas_diario_mat criada');

    // View leve: contadores totais para o filtro inicial (por mês)
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS bi_entregas_mensal_mat AS
      SELECT
        DATE_TRUNC('month', data_solicitado) AS mes,
        cod_cliente,
        COUNT(DISTINCT os) AS total_os,
        COUNT(*) FILTER (WHERE dentro_prazo = true) AS dentro_prazo,
        COUNT(*) AS total
      FROM bi_entregas
      WHERE data_solicitado IS NOT NULL
      GROUP BY DATE_TRUNC('month', data_solicitado), cod_cliente
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bi_mensal_mat_pk 
      ON bi_entregas_mensal_mat(mes, cod_cliente)
    `);

    console.log('✅ bi_entregas_mensal_mat criada');
    console.log('💡 Para refresh manual: REFRESH MATERIALIZED VIEW CONCURRENTLY bi_entregas_diario_mat;');
  } catch (err) {
    // Se as tabelas-fonte ainda não existem (bootstrap inicial), só ignora
    if (err.message.includes('does not exist')) {
      console.log('⏭️  bi_entregas ainda não existe — views serão criadas no próximo restart');
      return;
    }
    console.error('❌ Erro ao criar materialized views:', err.message);
    // Não trava o boot — views podem ser criadas manualmente depois
  }
}

/**
 * Refresh CONCURRENTLY (não bloqueia leitura).
 * Chame após uploads/recálculos de bi_entregas.
 */
async function refreshBiMaterializedViews(pool) {
  try {
    const t0 = Date.now();
    // CONCURRENTLY = não bloqueia SELECTs em paralelo (precisa de unique index)
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY bi_entregas_diario_mat');
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY bi_entregas_mensal_mat');
    console.log(`✅ Materialized views refreshed em ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('❌ Erro ao refresh materialized views:', err.message);
  }
}

module.exports = { createBiMaterializedViews, refreshBiMaterializedViews };

// Executar diretamente via CLI
if (require.main === module) {
  const { pool } = require('../../config/database');
  
  createBiMaterializedViews(pool)
    .then(() => refreshBiMaterializedViews(pool))
    .then(() => {
      console.log('✅ Concluído!');
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Erro:', err);
      process.exit(1);
    });
}
