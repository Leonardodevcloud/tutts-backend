'use strict';

// ───────────────────────────────────────────────────────────────────────────
// hub-status.shared.js  (2026-06)
// Ponte de LEITURA entre o módulo logistics (Hub 99/Uber) e a tela do cliente.
// Dado um número de OS (tutts_os_numero == logistics_deliveries.codigo_os),
// devolve status amigável + dados do motoboy + tracking + última posição.
// NÃO escreve nada; só lê. Não acopla ao fluxo de webhook do Hub.
// ───────────────────────────────────────────────────────────────────────────

// Mapa status_canonico -> { label amigável, etapa (0..6), terminal }
const STATUS_MAP = {
  PENDING:           { label: 'Buscando entregador...', etapa: 0, terminal: false },
  QUOTED:            { label: 'Buscando entregador...', etapa: 0, terminal: false },
  DISPATCHED:        { label: 'Buscando entregador...', etapa: 0, terminal: false },
  COURIER_ASSIGNED:  { label: 'Entregador a caminho da coleta', etapa: 1, terminal: false },
  PICKUP_EN_ROUTE:   { label: 'Entregador a caminho da coleta', etapa: 1, terminal: false },
  ARRIVED_PICKUP:    { label: 'Entregador chegou na coleta', etapa: 2, terminal: false },
  PICKED_UP:         { label: 'Coletado — a caminho da entrega', etapa: 3, terminal: false },
  DROPOFF_EN_ROUTE:  { label: 'A caminho da entrega', etapa: 4, terminal: false },
  ARRIVED_DROPOFF:   { label: 'Chegou no destino', etapa: 5, terminal: false },
  DELIVERED:         { label: 'Entregue', etapa: 6, terminal: true },
  CANCELED:          { label: 'Cancelada', etapa: 6, terminal: true },
  RETURNED:          { label: 'Devolvida', etapa: 6, terminal: true },
  FAILED:            { label: 'Falhou', etapa: 6, terminal: true },
  FALLBACK_QUEUE:    { label: 'Redirecionada para a fila', etapa: 0, terminal: false },
};

const PROVIDER_LABEL = { noventanove: '99', '99': '99', uber: 'Uber' };

// Base do rastreio personalizado da Central (mesma env usada no TrackingPoller).
const RASTREIO_BASE_URL = (process.env.RASTREIO_BASE_URL || 'https://centraltutts.online').replace(/\/+$/, '');

// Busca os dados do Hub para uma lista de OS. Retorna um Map osNumero(String) -> objeto hub.
async function buscarHubPorOS(pool, osNumeros) {
  // codigo_os em logistics_deliveries é INTEGER; tutts_os_numero é VARCHAR.
  // Converte pra inteiro e descarta valores não numéricos (evita erro de tipo no Postgres).
  const lista = [...new Set(
    (osNumeros || [])
      .map(o => parseInt(String(o).trim(), 10))
      .filter(n => Number.isInteger(n))
  )];
  if (lista.length === 0) return new Map();

  const { rows } = await pool.query(`
    SELECT d.codigo_os, d.provider_code, d.status_canonico, d.status_native,
           d.courier_data, d.tracking_url, d.rastreio_token,
           d.latitude_coleta, d.longitude_coleta, d.latitude_entrega, d.longitude_entrega,
           t.latitude  AS pos_lat,
           t.longitude AS pos_lng,
           t.created_at AS pos_em
    FROM logistics_deliveries d
    LEFT JOIN LATERAL (
      SELECT latitude, longitude, created_at
      FROM logistics_tracking
      WHERE delivery_id = d.id
      ORDER BY created_at DESC
      LIMIT 1
    ) t ON true
    WHERE d.codigo_os = ANY($1::int[])
    AND d.id = (
      SELECT id FROM logistics_deliveries d2
      WHERE d2.codigo_os = d.codigo_os
      ORDER BY d2.created_at DESC LIMIT 1
    )
  `, [lista]);

  const map = new Map();
  for (const r of rows) {
    const st = STATUS_MAP[r.status_canonico] || { label: r.status_native || r.status_canonico || '—', etapa: 0, terminal: false };
    const courier = r.courier_data || {};
    map.set(String(r.codigo_os), {
      via_hub: true,
      provider: r.provider_code,
      provider_label: PROVIDER_LABEL[r.provider_code] || r.provider_code,
      status_canonico: r.status_canonico,
      status_label: st.label,
      etapa: st.etapa,
      terminal: st.terminal,
      tracking_url: r.tracking_url || null,
      // 🆕 rastreio personalizado da Central (token) — /r/<token>. É o link que
      // deve ser usado na tela (não o link cru do provedor).
      rastreio_token: r.rastreio_token || null,
      rastreio_url: r.rastreio_token ? `${RASTREIO_BASE_URL}/r/${r.rastreio_token}` : null,
      motoboy: (courier.name || courier.photo || courier.phone) ? {
        nome:    courier.name    || null,
        foto:    courier.photo   || null,
        telefone:courier.phone   || null,
        placa:   courier.plate   || null,
        veiculo: courier.vehicle || null,
        rating:  courier.rating != null ? courier.rating : null,
      } : null,
      posicao: (r.pos_lat != null && r.pos_lng != null) ? {
        lat: Number(r.pos_lat), lng: Number(r.pos_lng), em: r.pos_em,
      } : null,
      coleta:  (r.latitude_coleta  != null) ? { lat: Number(r.latitude_coleta),  lng: Number(r.longitude_coleta)  } : null,
      entrega: (r.latitude_entrega != null) ? { lat: Number(r.latitude_entrega), lng: Number(r.longitude_entrega) } : null,
    });
  }
  return map;
}

module.exports = { buscarHubPorOS, STATUS_MAP, PROVIDER_LABEL };
