// ============================================================
// MÓDULO CRM - ROUTES (4 Endpoints)
// Extraído de server.js (linhas 24003-24218)
//
// Endpoints:
//   GET  /api/crm/profissionais-em-operacao   - Profissionais ativos
//   POST /api/crm/verificar-operacao          - Verificar status de lista
//   GET  /api/crm/estatisticas-conversao      - Estatísticas gerais
//   GET  /api/crm/detalhes-profissional/:cod  - Detalhes de um profissional
//
// Segurança: Endpoints abertos (sem verificarToken no original)
// NOTA: Considerar adicionar verificarToken futuramente
// ============================================================

const express = require('express');

/**
 * Inicializa rotas do módulo CRM
 * @param {object} pool - Pool de conexão PostgreSQL
 * @returns {express.Router}
 */
function initCrmRoutes(pool) {
  const router = express.Router();

  // ==================== GET /profissionais-em-operacao ====================
  router.get('/profissionais-em-operacao', async (req, res) => {
    try {
      const dias = parseInt(req.query.dias) || 30;

      const result = await pool.query(`
        SELECT 
          cod_prof,
          nome_prof,
          COUNT(*) as total_entregas,
          MAX(data_solicitado) as ultima_entrega,
          MIN(data_solicitado) as primeira_entrega
        FROM bi_entregas
        WHERE cod_prof IS NOT NULL
          AND data_solicitado >= CURRENT_DATE - INTERVAL '${dias} days'
        GROUP BY cod_prof, nome_prof
        ORDER BY total_entregas DESC
      `);

      console.log(`[CRM] Profissionais em operação: ${result.rows.length} (últimos ${dias} dias)`);

      res.json({
        success: true,
        periodo_dias: dias,
        total_profissionais: result.rows.length,
        profissionais: result.rows
      });
    } catch (error) {
      console.error('Erro ao buscar profissionais em operação:', error);
      res.status(500).json({ error: 'Erro interno', details: error.message });
    }
  });

  // ==================== POST /verificar-operacao ====================
  // Recebe lista de códigos e retorna status de cada um
  router.post('/verificar-operacao', async (req, res) => {
    try {
      const { codigos, dias = 30 } = req.body;

      if (!codigos || !Array.isArray(codigos) || codigos.length === 0) {
        return res.status(400).json({ error: 'Lista de códigos é obrigatória' });
      }

      // Converter para inteiros (remover caracteres não numéricos)
      const codigosInt = codigos
        .map(c => parseInt(String(c).replace(/\D/g, '')))
        .filter(c => !isNaN(c) && c > 0);

      if (codigosInt.length === 0) {
        return res.status(400).json({ error: 'Nenhum código válido fornecido' });
      }

      console.log(`[CRM] Verificando operação de ${codigosInt.length} profissionais...`);

      const result = await pool.query(`
        SELECT 
          cod_prof,
          nome_prof,
          COUNT(*) as total_entregas,
          MAX(data_solicitado) as ultima_entrega
        FROM bi_entregas
        WHERE cod_prof = ANY($1::int[])
          AND data_solicitado >= CURRENT_DATE - INTERVAL '${dias} days'
        GROUP BY cod_prof, nome_prof
      `, [codigosInt]);

      // Mapear resultados
      const emOperacao = new Map(result.rows.map(r => [r.cod_prof, r]));

      const resultado = codigosInt.map(cod => ({
        cod_profissional: cod,
        em_operacao: emOperacao.has(cod),
        dados: emOperacao.get(cod) || null
      }));

      console.log(`[CRM] Resultado: ${result.rows.length}/${codigosInt.length} em operação`);

      res.json({
        success: true,
        periodo_dias: dias,
        total_verificados: codigosInt.length,
        em_operacao: result.rows.length,
        nao_operando: codigosInt.length - result.rows.length,
        resultado
      });
    } catch (error) {
      console.error('Erro ao verificar operação:', error);
      res.status(500).json({ error: 'Erro interno', details: error.message });
    }
  });

  // ==================== GET /estatisticas-conversao ====================
  router.get('/estatisticas-conversao', async (req, res) => {
    try {
      const dias = parseInt(req.query.dias) || 30;

      // Total de profissionais únicos que fizeram entregas
      const profissionais = await pool.query(`
        SELECT 
          COUNT(DISTINCT cod_prof) as total_profissionais,
          COUNT(*) as total_entregas,
          AVG(valor_prof) as ticket_medio
        FROM bi_entregas
        WHERE data_solicitado >= CURRENT_DATE - INTERVAL '${dias} days'
          AND cod_prof IS NOT NULL
      `);

      // Novos profissionais (primeira entrega no período)
      const novos = await pool.query(`
        SELECT COUNT(DISTINCT cod_prof) as novos
        FROM bi_entregas
        WHERE cod_prof IN (
          SELECT cod_prof 
          FROM bi_entregas 
          GROUP BY cod_prof 
          HAVING MIN(data_solicitado) >= CURRENT_DATE - INTERVAL '${dias} days'
        )
      `);

      res.json({
        success: true,
        periodo_dias: dias,
        total_profissionais: parseInt(profissionais.rows[0].total_profissionais) || 0,
        total_entregas: parseInt(profissionais.rows[0].total_entregas) || 0,
        ticket_medio: parseFloat(profissionais.rows[0].ticket_medio) || 0,
        novos_no_periodo: parseInt(novos.rows[0].novos) || 0
      });
    } catch (error) {
      console.error('Erro ao buscar estatísticas:', error);
      res.status(500).json({ error: 'Erro interno', details: error.message });
    }
  });

  // ==================== GET /detalhes-profissional/:codigo ====================
  router.get('/detalhes-profissional/:codigo', async (req, res) => {
    try {
      const codigo = parseInt(req.params.codigo);
      const dias = parseInt(req.query.dias) || 30;

      if (!codigo || isNaN(codigo)) {
        return res.status(400).json({ error: 'Código inválido' });
      }

      // Dados gerais do profissional
      const geral = await pool.query(`
        SELECT 
          cod_prof,
          nome_prof,
          COUNT(*) as total_entregas,
          SUM(valor_prof) as valor_total,
          AVG(valor_prof) as ticket_medio,
          MIN(data_solicitado) as primeira_entrega,
          MAX(data_solicitado) as ultima_entrega,
          COUNT(DISTINCT data_solicitado) as dias_trabalhados
        FROM bi_entregas
        WHERE cod_prof = $1
          AND data_solicitado >= CURRENT_DATE - INTERVAL '${dias} days'
        GROUP BY cod_prof, nome_prof
      `, [codigo]);

      if (geral.rows.length === 0) {
        return res.json({
          success: true,
          encontrado: false,
          codigo,
          mensagem: 'Profissional não encontrado ou sem entregas no período'
        });
      }

      // Entregas por dia da semana
      const porDia = await pool.query(`
        SELECT 
          EXTRACT(DOW FROM data_solicitado) as dia_semana,
          COUNT(*) as entregas
        FROM bi_entregas
        WHERE cod_prof = $1
          AND data_solicitado >= CURRENT_DATE - INTERVAL '${dias} days'
        GROUP BY EXTRACT(DOW FROM data_solicitado)
        ORDER BY dia_semana
      `, [codigo]);

      // Regiões/Cidades atendidas
      const regioes = await pool.query(`
        SELECT 
          cidade,
          COUNT(*) as entregas
        FROM bi_entregas
        WHERE cod_prof = $1
          AND data_solicitado >= CURRENT_DATE - INTERVAL '${dias} days'
          AND cidade IS NOT NULL
        GROUP BY cidade
        ORDER BY entregas DESC
        LIMIT 10
      `, [codigo]);

      res.json({
        success: true,
        encontrado: true,
        periodo_dias: dias,
        profissional: geral.rows[0],
        entregas_por_dia_semana: porDia.rows,
        regioes_atendidas: regioes.rows
      });
    } catch (error) {
      console.error('Erro ao buscar detalhes do profissional:', error);
      res.status(500).json({ error: 'Erro interno', details: error.message });
    }
  });

  console.log('✅ APIs de integração CRM carregadas');

  return router;
}

module.exports = initCrmRoutes;
