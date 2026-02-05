// ============================================================
// MÓDULO SCORE/GAMIFICAÇÃO - CRON JOB
// Extraído de server.js (linhas 26754-26812)
// Executa dia 1 de cada mês às 00:05
// ============================================================

const { aplicarGratuidadeProfissional } = require('./score.service');

/**
 * Registra o cron job de gratuidades do Score
 * @param {object} cron - Instância do node-cron
 * @param {object} pool - Pool de conexão PostgreSQL
 */
function initScoreCron(cron, pool) {
  // Dia 1 de cada mês às 00:05 (UTC)
  cron.schedule('5 0 1 * *', async () => {
    console.log('🎁 [CRON] Iniciando aplicação de gratuidades do Score...');
    try {
      const mesReferencia = new Date().toISOString().slice(0, 7);

      const profissionais = await pool.query(`
        SELECT cod_prof, nome_prof, score_total
        FROM score_totais
        WHERE score_total >= 80
        ORDER BY score_total DESC
      `);

      let aplicados = 0;

      for (const prof of profissionais.rows) {
        try {
          const resultado = await aplicarGratuidadeProfissional(pool, prof, mesReferencia);
          if (resultado === 'criado') aplicados++;
        } catch (err) {
          console.error(`[CRON] Erro ao aplicar gratuidade para ${prof.cod_prof}:`, err.message);
        }
      }

      console.log(`✅ [CRON] Gratuidades do Score aplicadas: ${aplicados} profissionais`);
    } catch (error) {
      console.error('❌ [CRON] Erro ao aplicar gratuidades do Score:', error);
    }
  });

  console.log('⏰ Cron job Score registrado: gratuidades dia 1 às 00:05');
}

module.exports = initScoreCron;
