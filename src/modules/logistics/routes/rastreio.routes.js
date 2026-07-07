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
                pickup_code, return_code,
                eta_minutos, updated_at, pontos, id
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

      // etapa_ts: primeiro evento de cada step na logistics_events
      // step0=DISPATCHED, step1=COURIER_ASSIGNED, step2=PICKED_UP, step3=DELIVERED
      const STEP_STATUS = [
        ['PENDING','QUOTED','DISPATCHED'],
        ['COURIER_ASSIGNED','PICKUP_EN_ROUTE'],
        ['PICKED_UP','DROPOFF_EN_ROUTE'],
        ['DELIVERED'],
      ];
      const { rows: evtRows } = await pool.query(
        `SELECT status_canonico, MIN(created_at) AS ts
           FROM logistics_events
          WHERE delivery_id = $1
            AND status_canonico IS NOT NULL
          GROUP BY status_canonico`,
        [d.id]
      );
      const evtMap = {};
      evtRows.forEach(r => { evtMap[r.status_canonico] = r.ts; });
      const etapa_ts = STEP_STATUS.map(statuses => {
        for (const s of statuses) {
          if (evtMap[s]) return evtMap[s];
        }
        return null;
      });

      // Parceiro frequente: > 3 entregas concluidas pelo mesmo telefone.
      let entregadorFrequente = false;
      if (courier.name && courier.phone) {
        const telNorm = String(courier.phone).replace(/[^0-9]/g, '');
        if (telNorm) {
          try {
            const { rows: cnt } = await pool.query(
              `SELECT COUNT(*)::int AS n FROM logistics_deliveries
                WHERE entregue_at IS NOT NULL
                  AND regexp_replace(COALESCE(courier_data->>'phone',''), '[^0-9]', '', 'g') = $1`,
              [telNorm]
            );
            entregadorFrequente = !!(cnt[0] && cnt[0].n > 3);
          } catch (_) { /* silencioso: selo e cosmetico */ }
        }
      }

      res.set('Cache-Control', 'no-store');
      res.json({
        status: d.status_canonico,
        status_label: st.label,
        etapa: st.step,
        etapa_ts,
        finalizado: ['DELIVERED', 'CANCELED', 'RETURNED'].includes(d.status_canonico),
        entregador: courier.name ? {
          nome: courier.name,
          veiculo: courier.vehicle || null,
          placa: courier.plate || null,
          foto: courier.photo || null,
          telefone: courier.phone || null,
          frequente: entregadorFrequente,
        } : null,
        posicao: (d.ultima_lat != null && d.ultima_lng != null) ? {
          lat: parseFloat(d.ultima_lat),
          lng: parseFloat(d.ultima_lng),
        } : null,
        coleta: {
          lat: d.latitude_coleta != null ? parseFloat(d.latitude_coleta) : null,
          lng: d.longitude_coleta != null ? parseFloat(d.longitude_coleta) : null,
          endereco: d.endereco_coleta || null,
          codigo: d.pickup_code || null,
        },
        entrega: {
          lat: d.latitude_entrega != null ? parseFloat(d.latitude_entrega) : null,
          lng: d.longitude_entrega != null ? parseFloat(d.longitude_entrega) : null,
          endereco: d.endereco_entrega || null,
          nome: nomeDestino,
        },
        devolucao: {
          codigo: d.return_code || null,
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
