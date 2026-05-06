/**
 * BI Monitoramento - Aba "Hora a Hora"
 * v2: montarWhere async.
 */
const express = require('express');
const { montarWhere } = require('./dashboard.routes');

function createHoraAHoraRoutes(pool) {
  const router = express.Router();

  router.get('/bi-monitoramento/hora-a-hora', async (req, res) => {
    try {
      const { where, params } = await montarWhere(pool, req.query);

      const horasQuery = await pool.query(`
        SELECT
          EXTRACT(HOUR FROM data_hora)::int as hora,
          COUNT(DISTINCT os) as total_os,
          COUNT(*) as total_entregas,
          COUNT(*) FILTER (WHERE dentro_prazo = true) as dentro_prazo,
          COUNT(*) FILTER (WHERE dentro_prazo = false) as fora_prazo
        FROM bi_entregas ${where}
          AND data_hora IS NOT NULL
        GROUP BY EXTRACT(HOUR FROM data_hora)
        ORDER BY hora
      `, params);

      const mapa = new Map(horasQuery.rows.map(r => [Number(r.hora), r]));
      const horas = [];
      for (let h = 0; h < 24; h++) {
        const r = mapa.get(h);
        horas.push({
          hora: h,
          total_os: r ? Number(r.total_os) : 0,
          total_entregas: r ? Number(r.total_entregas) : 0,
          dentro_prazo: r ? Number(r.dentro_prazo) : 0,
          fora_prazo: r ? Number(r.fora_prazo) : 0
        });
      }

      const totalOs = horas.reduce((s, h) => s + h.total_os, 0);
      const osPico = horas.slice(8, 19).reduce((s, h) => s + h.total_os, 0);
      const foraPico = totalOs - osPico;

      let horaPico = null, maxOs = -1;
      for (const h of horas) {
        if (h.total_os > maxOs) { maxOs = h.total_os; horaPico = h.hora; }
      }

      const horasDentroPico = horas.slice(8, 19).filter(h => h.total_os > 0).length;
      const mediaPorHoraPico = horasDentroPico > 0 ? Math.round(osPico / horasDentroPico) : 0;

      res.json({
        horas,
        resumo: {
          total_os: totalOs,
          os_pico: osPico,
          os_fora_pico: foraPico,
          pct_pico: totalOs > 0 ? Math.round((100 * osPico / totalOs) * 10) / 10 : 0,
          pct_fora_pico: totalOs > 0 ? Math.round((100 * foraPico / totalOs) * 10) / 10 : 0,
          hora_pico: horaPico,
          os_hora_pico: maxOs > 0 ? maxOs : 0,
          media_por_hora_pico: mediaPorHoraPico
        }
      });
    } catch (err) {
      console.error('❌ [bi-monitoramento] Erro hora-a-hora:', err);
      res.status(500).json({ error: 'Erro ao carregar hora a hora', detail: err.message });
    }
  });

  return router;
}

module.exports = { createHoraAHoraRoutes };
