const express = require('express');

const STATUS_LABEL = {
  PENDING:          { label: 'Preparando sua entrega', step: 0 },
  QUOTED:           { label: 'Preparando sua entrega', step: 0 },
  DISPATCHED:       { label: 'Procurando entregador',  step: 0 },
  COURIER_ASSIGNED: { label: 'Entregador a caminho da coleta', step: 1 },
  PICKUP_EN_ROUTE:  { label: 'Entregador a caminho da coleta', step: 1 },
  PICKED_UP:        { label: 'Pedido coletado', step: 2 },
  DROPOFF_EN_ROUTE: { label: 'Saiu para entrega', step: 2 },
  DELIVERED:        { label: 'Entrega concluida', step: 3 },
  CANCELED:         { label: 'Entrega cancelada', step: -1 },
  RETURNED:         { label: 'Entrega devolvida', step: -1 },
};

function createLogisticsRastreioRouter(pool) {
  const router = express.Router();

  router.get('/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').trim();
      if (!token || token.length < 8) {
        return res.status(404).json({ erro: 'nao_encontrado' });
      }
      const { rows } = await pool.query(
        `SELECT status_canonico, courier_data, ultima_lat, ultima_lng,
                latitude_coleta, longitude_coleta, endereco_coleta,
                latitude_entrega, longitude_entrega, endereco_entrega,
                eta_minutos, updated_at, pontos
           FROM logistics_deliveries
          WHERE rastreio_token = $1
          LIMIT 1`,
        [token]
      );
      if (rows.length === 0) {
        return res.status(404).json({ erro: 'nao_encontrado' });
      }
      const d = rows[0];
      const st = STATUS_LABEL[d.status_canonico] || { label: 'Em andamento', step: 0 };
      const courier = d.courier_data || {};
      const pts = Array.isArray(d.pontos) ? d.pontos : [];
      const nomeDestino = pts.length ? (pts[pts.length - 1] && pts[pts.length - 1].nome) || null : null;

      res.set('Cache-Control', 'no-store');
      res.json({
        status: d.status_canonico,
        status_label: st.label,
        etapa: st.step,
        finalizado: ['DELIVERED', 'CANCELED', 'RETURNED'].includes(d.status_canonico),
        entregador: courier.name ? {
          nome: courier.name,
          veiculo: courier.vehicle || null,
          placa: courier.plate || null,
          foto: courier.photo || null,
        } : null,
        posicao: (d.ultima_lat != null && d.ultima_lng != null) ? {
          lat: parseFloat(d.ultima_lat),
          lng: parseFloat(d.ultima_lng),
        } : null,
        coleta: {
          lat: d.latitude_coleta != null ? parseFloat(d.latitude_coleta) : null,
          lng: d.longitude_coleta != null ? parseFloat(d.longitude_coleta) : null,
          endereco: d.endereco_coleta || null,
        },
        entrega: {
          lat: d.latitude_entrega != null ? parseFloat(d.latitude_entrega) : null,
          lng: d.longitude_entrega != null ? parseFloat(d.longitude_entrega) : null,
          endereco: d.endereco_entrega || null,
          nome: nomeDestino,
        },
        eta_minutos: d.eta_minutos != null ? d.eta_minutos : null,
        atualizado_em: d.updated_at,
      });
    } catch (err) {
      console.error('❌ [logistics/rastreio] erro:', err.message);
      res.status(500).json({ erro: 'erro_interno' });
    }
  });

  return router;
}

module.exports = { createLogisticsRastreioRouter };
