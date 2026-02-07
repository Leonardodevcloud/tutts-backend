const express = require('express');
function createRoutingRouter(pool, verificarToken, httpRequest, registrarAuditoria, AUDIT_CATEGORIES) {
  const router = express.Router();
  const ORS_API_KEY = process.env.ORS_API_KEY;

  // Proxy para geocodificação ORS
  router.get('/geocode', verificarToken, async (req, res) => {
    try {
      if (!ORS_API_KEY) {
        return res.status(503).json({ error: 'Serviço de geocodificação não configurado' });
      }
      
      const { text } = req.query;
      
      if (!text || text.length < 3) {
        return res.status(400).json({ error: 'Texto de busca inválido' });
      }
      
      const sanitizedText = text.replace(/[<>\\"'&]/g, '').substring(0, 200);
      const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(sanitizedText)}&boundary.country=BR&size=1`;
      
      const response = await httpRequest(url);
      const data = response.json();
      
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Erro no serviço de geocodificação' });
      }
      
      res.json(data);
    } catch (error) {
      console.error('❌ Erro no proxy geocode:', error.message);
      res.status(500).json({ error: 'Erro interno no serviço de geocodificação' });
    }
  });

  // Proxy para otimização de rota
  router.post('/optimize', verificarToken, async (req, res) => {
    try {
      if (!ORS_API_KEY) {
        return res.status(503).json({ error: 'Serviço de roteirização não configurado' });
      }
      
      const { jobs, vehicles } = req.body;
      
      if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
        return res.status(400).json({ error: 'Jobs inválidos' });
      }
      if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
        return res.status(400).json({ error: 'Vehicles inválidos' });
      }
      if (jobs.length > 50) {
        return res.status(400).json({ error: 'Máximo de 50 pontos permitido' });
      }
      
      for (const job of jobs) {
        if (!job.location || !Array.isArray(job.location) || job.location.length !== 2) {
          return res.status(400).json({ error: 'Coordenadas de job inválidas' });
        }
        const [lng, lat] = job.location;
        if (typeof lng !== 'number' || typeof lat !== 'number' || 
            lng < -180 || lng > 180 || lat < -90 || lat > 90) {
          return res.status(400).json({ error: 'Coordenadas fora do intervalo válido' });
        }
      }
      
      const response = await httpRequest('https://api.openrouteservice.org/optimization', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': ORS_API_KEY
        },
        body: JSON.stringify({ jobs, vehicles })
      });
      
      const data = response.json();
      
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Erro no serviço de otimização' });
      }
      
      await registrarAuditoria(req, 'ROUTE_OPTIMIZE', AUDIT_CATEGORIES.DATA, 'routing', null, {
        pontos: jobs.length,
        usuario: req.user.codProfissional
      });
      
      res.json(data);
    } catch (error) {
      console.error('❌ Erro no proxy optimize:', error.message);
      res.status(500).json({ error: 'Erro interno no serviço de otimização' });
    }
  });

  // Proxy para direções (geometria da rota)
  router.post('/directions', verificarToken, async (req, res) => {
    try {
      if (!ORS_API_KEY) {
        return res.status(503).json({ error: 'Serviço de direções não configurado' });
      }
      
      const { coordinates } = req.body;
      
      if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
        return res.status(400).json({ error: 'Coordenadas inválidas (mínimo 2 pontos)' });
      }
      if (coordinates.length > 50) {
        return res.status(400).json({ error: 'Máximo de 50 pontos permitido' });
      }
      
      for (const coord of coordinates) {
        if (!Array.isArray(coord) || coord.length !== 2) {
          return res.status(400).json({ error: 'Formato de coordenada inválido' });
        }
        const [lng, lat] = coord;
        if (typeof lng !== 'number' || typeof lat !== 'number' ||
            lng < -180 || lng > 180 || lat < -90 || lat > 90) {
          return res.status(400).json({ error: 'Coordenadas fora do intervalo válido' });
        }
      }
      
      const response = await httpRequest('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': ORS_API_KEY
        },
        body: JSON.stringify({ coordinates })
      });
      
      const data = response.json();
      
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Erro no serviço de direções' });
      }
      
      res.json(data);
    } catch (error) {
      console.error('❌ Erro no proxy directions:', error.message);
      res.status(500).json({ error: 'Erro interno no serviço de direções' });
    }
  });

  return router;
}
module.exports = { createRoutingRouter };
