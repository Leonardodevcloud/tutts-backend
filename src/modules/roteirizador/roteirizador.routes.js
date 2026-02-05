/**
 * MÓDULO ROTEIRIZADOR - Routes
 * 19 endpoints: 3 proxy ORS + 12 roteirizador + 4 geocode
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { normalizarEndereco } = require('./roteirizador.service');

// ==================== PROXY OPENROUTESERVICE ====================

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

// ==================== ROTEIRIZADOR PÚBLICO ====================

function createRoteirizadorRouter(pool, verificarToken) {
  const router = express.Router();
  const JWT_SECRET = process.env.JWT_SECRET;

  // Middleware para verificar token do roteirizador
  const verificarTokenRoteirizador = async (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      if (decoded.tipo !== 'roteirizador') {
        return res.status(401).json({ error: 'Token inválido para roteirizador' });
      }
      
      const usuario = await pool.query(
        'SELECT id, nome, email, ativo FROM usuarios_roteirizador WHERE id = $1',
        [decoded.id]
      );
      
      if (usuario.rows.length === 0 || !usuario.rows[0].ativo) {
        return res.status(401).json({ error: 'Usuário inativo ou não encontrado' });
      }
      
      req.usuarioRoteirizador = usuario.rows[0];
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
  };

  // Login do roteirizador
  router.post('/login', async (req, res) => {
    try {
      const { email, senha } = req.body;
      
      if (!email || !senha) {
        return res.status(400).json({ error: 'Email e senha são obrigatórios' });
      }
      
      const result = await pool.query(
        'SELECT id, nome, email, senha_hash, ativo, empresa FROM usuarios_roteirizador WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Email ou senha incorretos' });
      }
      
      const usuario = result.rows[0];
      
      if (!usuario.ativo) {
        return res.status(403).json({ error: 'Conta desativada. Entre em contato com o administrador.' });
      }
      
      const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
      if (!senhaValida) {
        return res.status(401).json({ error: 'Email ou senha incorretos' });
      }
      
      // Atualizar último acesso
      await pool.query(
        'UPDATE usuarios_roteirizador SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = $1',
        [usuario.id]
      );
      
      const token = jwt.sign(
        { id: usuario.id, email: usuario.email, tipo: 'roteirizador' },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      res.json({
        token,
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          empresa: usuario.empresa
        }
      });
    } catch (err) {
      console.error('❌ Erro login roteirizador:', err);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // Verificar token
  router.get('/verificar', verificarTokenRoteirizador, (req, res) => {
    res.json({
      valido: true,
      usuario: req.usuarioRoteirizador
    });
  });

  // Salvar rota no histórico
  router.post('/rotas', verificarTokenRoteirizador, async (req, res) => {
    try {
      const { nome, origem, destinos, rota_otimizada, distancia_total, tempo_total } = req.body;
      
      const result = await pool.query(
        `INSERT INTO rotas_historico 
         (usuario_id, nome, origem, destinos, rota_otimizada, distancia_total, tempo_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          req.usuarioRoteirizador.id,
          nome || `Rota ${new Date().toLocaleDateString('pt-BR')}`,
          origem,
          JSON.stringify(destinos),
          JSON.stringify(rota_otimizada),
          distancia_total,
          tempo_total
        ]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao salvar rota:', err);
      res.status(500).json({ error: 'Erro ao salvar rota' });
    }
  });

  // Listar histórico de rotas
  router.get('/rotas', verificarTokenRoteirizador, async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      
      const result = await pool.query(
        `SELECT id, nome, origem, distancia_total, tempo_total, created_at 
         FROM rotas_historico 
         WHERE usuario_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2 OFFSET $3`,
        [req.usuarioRoteirizador.id, limit, offset]
      );
      
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM rotas_historico WHERE usuario_id = $1',
        [req.usuarioRoteirizador.id]
      );
      
      res.json({
        rotas: result.rows,
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (err) {
      console.error('❌ Erro ao listar rotas:', err);
      res.status(500).json({ error: 'Erro ao listar rotas' });
    }
  });

  // Buscar rota por ID
  router.get('/rotas/:id', verificarTokenRoteirizador, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM rotas_historico 
         WHERE id = $1 AND usuario_id = $2`,
        [req.params.id, req.usuarioRoteirizador.id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao buscar rota:', err);
      res.status(500).json({ error: 'Erro ao buscar rota' });
    }
  });

  // Deletar rota
  router.delete('/rotas/:id', verificarTokenRoteirizador, async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM rotas_historico WHERE id = $1 AND usuario_id = $2 RETURNING id',
        [req.params.id, req.usuarioRoteirizador.id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Erro ao deletar rota:', err);
      res.status(500).json({ error: 'Erro ao deletar rota' });
    }
  });

  // Salvar/atualizar favorito
  router.post('/favoritos', verificarTokenRoteirizador, async (req, res) => {
    try {
      const { endereco, apelido, latitude, longitude } = req.body;
      
      // Verificar se já existe
      const existente = await pool.query(
        'SELECT id FROM enderecos_favoritos WHERE usuario_id = $1 AND endereco = $2',
        [req.usuarioRoteirizador.id, endereco]
      );
      
      if (existente.rows.length > 0) {
        // Atualizar uso_count
        const result = await pool.query(
          `UPDATE enderecos_favoritos 
           SET uso_count = uso_count + 1, apelido = COALESCE($1, apelido), updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [apelido, existente.rows[0].id]
        );
        return res.json(result.rows[0]);
      }
      
      const result = await pool.query(
        `INSERT INTO enderecos_favoritos (usuario_id, endereco, apelido, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.usuarioRoteirizador.id, endereco, apelido, latitude, longitude]
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao salvar favorito:', err);
      res.status(500).json({ error: 'Erro ao salvar favorito' });
    }
  });

  // Listar favoritos
  router.get('/favoritos', verificarTokenRoteirizador, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM enderecos_favoritos 
         WHERE usuario_id = $1 
         ORDER BY uso_count DESC, updated_at DESC`,
        [req.usuarioRoteirizador.id]
      );
      
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar favoritos:', err);
      res.status(500).json({ error: 'Erro ao listar favoritos' });
    }
  });

  return router;
}

// ==================== ADMIN ROTEIRIZADOR ====================

function createAdminRoteirizadorRouter(pool, verificarToken) {
  const router = express.Router();

  // Criar usuário do roteirizador
  router.post('/', verificarToken, async (req, res) => {
    try {
      const { nome, email, senha, telefone, empresa, observacoes } = req.body;
      
      if (!nome || !email || !senha) {
        return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
      }
      
      // Verificar se email já existe
      const existente = await pool.query(
        'SELECT id FROM usuarios_roteirizador WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      
      if (existente.rows.length > 0) {
        return res.status(400).json({ error: 'Email já cadastrado' });
      }
      
      const senha_hash = await bcrypt.hash(senha, 10);
      
      const result = await pool.query(
        `INSERT INTO usuarios_roteirizador (nome, email, senha_hash, telefone, empresa, observacoes, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, nome, email, telefone, empresa, ativo, created_at`,
        [nome, email.toLowerCase().trim(), senha_hash, telefone, empresa, observacoes, req.user?.nome || 'admin']
      );
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar usuário roteirizador:', err);
      res.status(500).json({ error: 'Erro ao criar usuário' });
    }
  });

  // Listar usuários
  router.get('/', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, nome, email, telefone, empresa, ativo, ultimo_acesso, created_at,
               (SELECT COUNT(*) FROM rotas_historico WHERE usuario_id = usuarios_roteirizador.id) as total_rotas
        FROM usuarios_roteirizador 
        ORDER BY created_at DESC
      `);
      
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar usuários:', err);
      res.status(500).json({ error: 'Erro ao listar usuários' });
    }
  });

  // Ativar/desativar usuário
  router.patch('/:id/ativo', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { ativo } = req.body;
      
      const result = await pool.query(
        'UPDATE usuarios_roteirizador SET ativo = $1 WHERE id = $2 RETURNING id, nome, email, ativo',
        [ativo, id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao atualizar status:', err);
      res.status(500).json({ error: 'Erro ao atualizar status' });
    }
  });

  // Resetar senha
  router.patch('/:id/senha', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { nova_senha } = req.body;
      
      if (!nova_senha || nova_senha.length < 4) {
        return res.status(400).json({ error: 'Senha deve ter no mínimo 4 caracteres' });
      }
      
      const senha_hash = await bcrypt.hash(nova_senha, 10);
      
      const result = await pool.query(
        'UPDATE usuarios_roteirizador SET senha_hash = $1 WHERE id = $2 RETURNING id, nome, email',
        [senha_hash, id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      
      res.json({ ...result.rows[0], mensagem: 'Senha atualizada com sucesso' });
    } catch (err) {
      console.error('❌ Erro ao resetar senha:', err);
      res.status(500).json({ error: 'Erro ao resetar senha' });
    }
  });

  return router;
}

// ==================== GEOCODIFICAÇÃO ====================

function createGeocodeRouter(pool) {
  const router = express.Router();

  // Google Geocoding (COM CACHE)
  router.get('/google', async (req, res) => {
    try {
      const { endereco } = req.query;
      const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
      
      if (!endereco) {
        return res.status(400).json({ error: 'Informe o endereço' });
      }
      
      if (!GOOGLE_API_KEY) {
        console.log('⚠️ GOOGLE_GEOCODING_API_KEY não configurada');
        return res.status(500).json({ error: 'API Key não configurada no servidor' });
      }
      
      const enderecoNormalizado = normalizarEndereco(endereco);
      
      // ETAPA 1: Verificar cache no banco
      try {
        const cacheResult = await pool.query(
          `SELECT id, endereco_formatado, latitude, longitude, fonte 
           FROM enderecos_geocodificados 
           WHERE endereco_busca_normalizado = $1 
           LIMIT 1`,
          [enderecoNormalizado]
        );
        
        if (cacheResult.rows.length > 0) {
          const cached = cacheResult.rows[0];
          console.log('✅ Cache HIT:', endereco, '→', cached.latitude, cached.longitude);
          
          pool.query(
            `UPDATE enderecos_geocodificados 
             SET acessos = acessos + 1, ultimo_acesso = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [cached.id]
          ).catch(e => console.log('⚠️ Erro ao atualizar acessos:', e.message));
          
          return res.json({
            results: [{
              endereco: cached.endereco_formatado,
              latitude: parseFloat(cached.latitude),
              longitude: parseFloat(cached.longitude),
              fonte: cached.fonte + '-cache'
            }],
            fonte: 'cache'
          });
        }
      } catch (dbErr) {
        console.log('⚠️ Erro ao consultar cache:', dbErr.message);
      }
      
      // ETAPA 2: Buscar no Google (cache MISS)
      console.log('🔍 Cache MISS, buscando no Google:', endereco);
      
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endereco)}&key=${GOOGLE_API_KEY}&region=br&language=pt-BR`;
      
      const resp = await fetch(url);
      const data = await resp.json();
      
      if (data.status === 'OK' && data.results && data.results.length > 0) {
        console.log('✅ Google sucesso:', data.results.length, 'resultados');
        
        const primeiro = data.results[0];
        pool.query(
          `INSERT INTO enderecos_geocodificados 
           (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            endereco,
            enderecoNormalizado,
            primeiro.formatted_address,
            primeiro.geometry.location.lat,
            primeiro.geometry.location.lng,
            'google'
          ]
        ).then(() => {
          console.log('💾 Salvo no cache:', endereco);
        }).catch(e => {
          console.log('⚠️ Erro ao salvar cache:', e.message);
        });
        
        return res.json({
          results: data.results.map(r => ({
            endereco: r.formatted_address,
            latitude: r.geometry.location.lat,
            longitude: r.geometry.location.lng,
            tipos: r.types,
            componentes: r.address_components,
            fonte: 'google'
          })),
          fonte: 'google'
        });
      } else if (data.status === 'ZERO_RESULTS') {
        return res.status(404).json({ error: 'Endereço não encontrado' });
      } else {
        console.log('⚠️ Google erro:', data.status, data.error_message);
        return res.status(500).json({ error: 'Erro na API Google', status: data.status });
      }
    } catch (err) {
      console.error('❌ Erro Google Geocoding:', err);
      res.status(500).json({ error: 'Erro ao geocodificar' });
    }
  });

  // Estatísticas do cache
  router.get('/stats', async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT 
          COUNT(*) as total_enderecos,
          SUM(acessos) as total_acessos,
          SUM(acessos) - COUNT(*) as requisicoes_economizadas,
          ROUND(((SUM(acessos) - COUNT(*))::numeric / NULLIF(SUM(acessos), 0)) * 100, 2) as percentual_cache,
          MAX(criado_em) as ultimo_cadastro,
          (SELECT COUNT(*) FROM enderecos_geocodificados WHERE criado_em > CURRENT_DATE - INTERVAL '30 days') as novos_ultimo_mes
        FROM enderecos_geocodificados
      `);
      
      const topEnderecos = await pool.query(`
        SELECT endereco_formatado, acessos, criado_em
        FROM enderecos_geocodificados
        ORDER BY acessos DESC
        LIMIT 10
      `);
      
      const row = stats.rows[0];
      const economiaDolares = ((parseInt(row.requisicoes_economizadas) || 0) / 1000) * 5;
      
      res.json({
        cache: {
          total_enderecos: parseInt(row.total_enderecos) || 0,
          total_acessos: parseInt(row.total_acessos) || 0,
          requisicoes_economizadas: parseInt(row.requisicoes_economizadas) || 0,
          percentual_cache: parseFloat(row.percentual_cache) || 0,
          novos_ultimo_mes: parseInt(row.novos_ultimo_mes) || 0
        },
        economia: {
          dolares: economiaDolares.toFixed(2),
          reais: (economiaDolares * 6).toFixed(2)
        },
        top_enderecos: topEnderecos.rows
      });
    } catch (err) {
      console.error('❌ Erro stats cache:', err);
      res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
  });

  // Buscar CEP com coordenadas
  router.get('/cep/:cep', async (req, res) => {
    try {
      const cep = req.params.cep.replace(/\D/g, '');
      if (cep.length !== 8) {
        return res.status(400).json({ error: 'CEP inválido' });
      }
      
      console.log('📮 Geocode CEP:', cep);
      
      // BrasilAPI primeiro
      try {
        const respBrasil = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`);
        if (respBrasil.ok) {
          const data = await respBrasil.json();
          const lat = data.location?.coordinates?.latitude;
          const lng = data.location?.coordinates?.longitude;
          
          console.log('✅ BrasilAPI sucesso:', { lat, lng });
          return res.json({
            cep: cep,
            endereco: `${data.street || ''}, ${data.neighborhood || ''}, ${data.city} - ${data.state}`.replace(/^,\s*/, ''),
            logradouro: data.street,
            bairro: data.neighborhood,
            cidade: data.city,
            estado: data.state,
            latitude: lat ? parseFloat(lat) : null,
            longitude: lng ? parseFloat(lng) : null,
            fonte: lat ? 'brasilapi' : 'brasilapi-sem-coord'
          });
        }
      } catch (e) {
        console.log('⚠️ BrasilAPI falhou:', e.message);
      }
      
      // Fallback: ViaCEP + Nominatim
      try {
        const respViaCep = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        if (respViaCep.ok) {
          const data = await respViaCep.json();
          if (!data.erro) {
            let lat = null, lng = null;
            try {
              const query = `${data.logradouro}, ${data.bairro}, ${data.localidade}, ${data.uf}, Brasil`;
              const respNominatim = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=br`,
                { headers: { 'User-Agent': 'TuttsRoteirizador/2.0' } }
              );
              const nominatimData = await respNominatim.json();
              if (nominatimData[0]) {
                lat = parseFloat(nominatimData[0].lat);
                lng = parseFloat(nominatimData[0].lon);
              }
            } catch (e) {
              console.log('⚠️ Nominatim falhou:', e.message);
            }
            
            console.log('✅ ViaCEP + Nominatim:', { lat, lng });
            return res.json({
              cep: data.cep,
              endereco: `${data.logradouro}, ${data.bairro}, ${data.localidade} - ${data.uf}`,
              logradouro: data.logradouro,
              bairro: data.bairro,
              cidade: data.localidade,
              estado: data.uf,
              latitude: lat,
              longitude: lng,
              fonte: lat ? 'viacep-nominatim' : 'viacep'
            });
          }
        }
      } catch (e) {
        console.log('⚠️ ViaCEP falhou:', e.message);
      }
      
      res.status(404).json({ error: 'CEP não encontrado' });
    } catch (err) {
      console.error('❌ Erro geocode CEP:', err);
      res.status(500).json({ error: 'Erro ao buscar CEP' });
    }
  });

  // Geocodificar endereço (texto livre)
  router.get('/endereco', async (req, res) => {
    try {
      const { endereco, bairro, cidade, estado } = req.query;
      
      if (!endereco && !bairro && !cidade) {
        return res.status(400).json({ error: 'Informe pelo menos um campo' });
      }
      
      console.log('🔍 Geocode endereço:', { endereco, bairro, cidade, estado });
      
      const queries = [];
      if (endereco && cidade) {
        queries.push(`${endereco}, ${bairro ? bairro + ', ' : ''}${cidade}, ${estado || 'GO'}, Brasil`);
      }
      if (bairro && cidade) {
        queries.push(`${bairro}, ${cidade}, ${estado || 'GO'}, Brasil`);
      }
      if (cidade) {
        queries.push(`${cidade}, ${estado || 'GO'}, Brasil`);
      }
      
      const cidadeLower = (cidade || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      
      // Tentar Nominatim
      for (const query of queries) {
        try {
          console.log('🌍 Nominatim:', query);
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=3&countrycodes=br&addressdetails=1`,
            { headers: { 'User-Agent': 'TuttsRoteirizador/2.0' } }
          );
          const data = await resp.json();
          
          if (data && data.length > 0) {
            for (const result of data) {
              const displayName = (result.display_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              if (displayName.includes(cidadeLower) || !cidade) {
                console.log('✅ Nominatim sucesso:', result.lat, result.lon);
                return res.json({
                  latitude: parseFloat(result.lat),
                  longitude: parseFloat(result.lon),
                  endereco_encontrado: result.display_name,
                  fonte: 'nominatim'
                });
              }
            }
          }
        } catch (e) {
          console.log('⚠️ Nominatim falhou:', e.message);
        }
        
        await new Promise(r => setTimeout(r, 1000));
      }
      
      // Fallback: Photon
      const queryPhoton = `${endereco || bairro}, ${cidade}, ${estado || 'GO'}`;
      try {
        console.log('💡 Photon:', queryPhoton);
        const resp = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(queryPhoton)}&limit=3&lang=pt`
        );
        const data = await resp.json();
        
        if (data.features && data.features.length > 0) {
          for (const feature of data.features) {
            const props = feature.properties || {};
            const featureCidade = (props.city || props.county || props.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            
            if (featureCidade.includes(cidadeLower) || cidadeLower.includes(featureCidade) || !cidade) {
              const coords = feature.geometry.coordinates;
              console.log('✅ Photon sucesso:', coords[1], coords[0]);
              return res.json({
                latitude: coords[1],
                longitude: coords[0],
                endereco_encontrado: `${props.name || ''}, ${props.city || ''}, ${props.state || ''}`,
                fonte: 'photon'
              });
            }
          }
        }
      } catch (e) {
        console.log('⚠️ Photon falhou:', e.message);
      }
      
      res.status(404).json({ error: 'Endereço não encontrado' });
    } catch (err) {
      console.error('❌ Erro geocode endereço:', err);
      res.status(500).json({ error: 'Erro ao geocodificar' });
    }
  });

  return router;
}

module.exports = { createRoutingRouter, createRoteirizadorRouter, createAdminRoteirizadorRouter, createGeocodeRouter };
