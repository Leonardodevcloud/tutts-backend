/**
 * Sub-Router: Uber Tracking
 * Endpoints para o frontend consultar posição do entregador
 * (complementa o WebSocket — fallback HTTP para quando WS não estiver disponível)
 */
const express = require('express');

function createUberTrackingRoutes(pool, verificarToken) {
  const router = express.Router();

  // Última posição do entregador de uma OS
  router.get('/:codigoOS/posicao', verificarToken, async (req, res) => {
    try {
      const { codigoOS } = req.params;

      const { rows } = await pool.query(`
        SELECT t.latitude, t.longitude, t.status_uber, t.created_at,
               e.entregador_nome, e.entregador_telefone, e.entregador_placa,
               e.entregador_veiculo, e.entregador_foto, e.entregador_rating,
               e.status_uber as status_entrega, e.endereco_coleta, e.endereco_entrega,
               e.latitude_coleta, e.longitude_coleta, e.latitude_entrega, e.longitude_entrega
        FROM uber_tracking t
        INNER JOIN uber_entregas e ON e.codigo_os = t.codigo_os
        WHERE t.codigo_os = $1
        ORDER BY t.created_at DESC
        LIMIT 1
      `, [codigoOS]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Sem dados de tracking para esta OS' });
      }

      res.json({ success: true, tracking: rows[0] });
    } catch (error) {
      console.error('❌ Erro tracking:', error);
      res.status(500).json({ error: 'Erro ao buscar tracking' });
    }
  });

  // Histórico de posições (rota percorrida)
  router.get('/:codigoOS/historico', verificarToken, async (req, res) => {
    try {
      const { codigoOS } = req.params;
      const { limit = 500 } = req.query;

      const { rows } = await pool.query(`
        SELECT latitude, longitude, status_uber, created_at
        FROM uber_tracking
        WHERE codigo_os = $1
        ORDER BY created_at ASC
        LIMIT $2
      `, [codigoOS, parseInt(limit)]);

      res.json({ success: true, pontos: rows, total: rows.length });
    } catch (error) {
      console.error('❌ Erro histórico tracking:', error);
      res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
  });

  // Entregas ativas (em andamento) — para painel de tracking
  router.get('/ativas', verificarToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT e.*,
          (SELECT jsonb_build_object('lat', t.latitude, 'lng', t.longitude, 'at', t.created_at)
           FROM uber_tracking t WHERE t.codigo_os = e.codigo_os ORDER BY t.created_at DESC LIMIT 1
          ) as ultima_posicao
        FROM uber_entregas e
        WHERE e.status_uber NOT IN ('delivered', 'cancelado', 'fallback_fila', 'erro')
          AND e.cancelado_por IS NULL
        ORDER BY e.created_at DESC
      `);

      res.json({ success: true, entregas: rows, total: rows.length });
    } catch (error) {
      console.error('❌ Erro entregas ativas:', error);
      res.status(500).json({ error: 'Erro ao buscar entregas ativas' });
    }
  });

  return router;
}

module.exports = { createUberTrackingRoutes };
