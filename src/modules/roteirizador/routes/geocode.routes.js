const express = require('express');
const { normalizarEndereco } = require('../roteirizador.service');

// Detecta se a query corresponde a um endereço "posicional" típico de Brasília,
// cidades-satélite do DF (Taguatinga, Ceilândia, Guará, Águas Claras etc) e Goiânia.
// Esses endereços usam sistema de setor/quadra/lote em vez de rua+número linear,
// e o Google frequentemente classifica o resultado como `sublocality`/`neighborhood`
// em vez de `premise`/`street_address` — fazendo o filtro padrão rejeitar.
function detectarEnderecoPosicional(endereco) {
    if (!endereco) return false;
    const norm = endereco.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Padrão 1: sigla maiúscula de 2-5 letras seguida (com ou sem espaço) de número.
    // Cobre SQN 302, CLN 310, QI 23, SHIS 12, AOS 5, EQN 404, QNL 20, QMSW 1, AE 4, etc.
    if (/\b[A-Z]{2,5}\s*\d/.test(norm)) return true;
    // Padrão 2: palavras-chave explícitas de endereço posicional seguidas de identificador
    if (/\b(QUADRA|QD\.?|LOTE|LT\.?|SETOR|BLOCO|CONJUNTO|CONJ\.?)\s+[A-Z0-9]/.test(norm)) return true;
    return false;
}

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
      
      // Detectar se a entrada são coordenadas (lat,lng) para usar reverse geocoding
      const coordRegex = /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/;
      const isCoords = coordRegex.test(endereco.trim());
      
      let url;
      if (isCoords) {
        // Reverse geocoding: coordenadas → endereço
        const latlng = endereco.trim();
        url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(latlng)}&key=${GOOGLE_API_KEY}&language=pt-BR&result_type=street_address|route|premise|subpremise|establishment|point_of_interest`;
        console.log('📍 Usando reverse geocoding para coordenadas:', latlng);
      } else {
        // Forward geocoding: endereço → coordenadas
        url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endereco)}&key=${GOOGLE_API_KEY}&region=br&language=pt-BR&components=country:br`;
      }
      
      const resp = await fetch(url);
      const data = await resp.json();
      
      if (data.status === 'OK' && data.results && data.results.length > 0) {
        console.log('✅ Google sucesso:', data.results.length, 'resultados');
        
        let primeiro;
        let resultadosPrecisos;
        
        if (isCoords) {
          // Reverse geocoding: o usuário já escolheu a posição no mapa,
          // aceitar o resultado mais preciso que o Google retornar
          primeiro = data.results[0];
          console.log('📍 Reverse geocoding aceito:', primeiro.formatted_address, '| tipos:', primeiro.types);
        } else {
          // Forward geocoding: validar que o resultado é preciso
          // Rejeita se só retornar resultado genérico (cidade, estado, região)
          const TIPOS_GENERICOS = [
            'country', 'administrative_area_level_1', 'administrative_area_level_2',
            'locality', 'sublocality', 'sublocality_level_1', 'political', 'neighborhood'
          ];
          const TIPOS_PRECISOS = [
            'street_address', 'premise', 'subpremise', 'route',
            'establishment', 'point_of_interest', 'postal_code', 'plus_code'
          ];
          
          const ehPreciso = (r) => {
            const tipos = r.types || [];
            if (tipos.some(t => TIPOS_PRECISOS.includes(t))) return true;
            if (tipos.every(t => TIPOS_GENERICOS.includes(t))) return false;
            return true;
          };
          
          resultadosPrecisos = data.results.filter(ehPreciso);
          
          if (resultadosPrecisos.length === 0) {
            // FALLBACK: se a query é um endereço posicional (Brasília/Goiânia/cidades-satélite)
            // e o Google retornou resultados só com `sublocality` ou `neighborhood`, aceitamos.
            // Esses endereços (SQN 302, QI 23, CLN 310 etc) raramente são classificados como
            // `premise` pelo Google, mas o resultado ainda aponta pra região certa.
            if (detectarEnderecoPosicional(endereco)) {
              const TIPOS_POSICIONAIS_OK = ['sublocality', 'sublocality_level_1', 'sublocality_level_2', 'neighborhood'];
              const candidatosPosicionais = data.results.filter(r => {
                const tipos = r.types || [];
                return tipos.some(t => TIPOS_POSICIONAIS_OK.includes(t));
              });
              if (candidatosPosicionais.length > 0) {
                console.log(`⚠️ [GEOCODE] Filtro relaxado p/ endereço posicional: "${endereco}" → "${candidatosPosicionais[0].formatted_address}" tipos=${JSON.stringify(candidatosPosicionais[0].types)}`);
                resultadosPrecisos = candidatosPosicionais;
              }
            }
          }
          
          if (resultadosPrecisos.length === 0) {
            console.log('⚠️ Google retornou só resultados genéricos, rejeitando:', data.results[0]?.types);
            return res.status(404).json({ 
              error: 'Endereço muito genérico — informe rua e número específicos',
              tipos_retornados: data.results[0]?.types 
            });
          }
          
          primeiro = resultadosPrecisos[0];
        }
        // Para reverse geocoding, usar coords originais; para forward, usar coords do resultado
        var resultadosParaResponse = isCoords ? data.results.slice(0, 3) : (resultadosPrecisos || [primeiro]);
        
        pool.query(
          `INSERT INTO enderecos_geocodificados 
           (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            endereco,
            enderecoNormalizado,
            primeiro.formatted_address,
            isCoords ? parseFloat(endereco.split(',')[0]) : primeiro.geometry.location.lat,
            isCoords ? parseFloat(endereco.split(',')[1]) : primeiro.geometry.location.lng,
            'google'
          ]
        ).then(() => {
          console.log('💾 Salvo no cache:', endereco);
        }).catch(e => {
          console.log('⚠️ Erro ao salvar cache:', e.message);
        });
        
        return res.json({
          results: resultadosParaResponse.map(r => ({
            endereco: r.formatted_address,
            latitude: isCoords ? parseFloat(endereco.split(',')[0]) : r.geometry.location.lat,
            longitude: isCoords ? parseFloat(endereco.split(',')[1]) : r.geometry.location.lng,
            tipos: r.types,
            componentes: r.address_components,
            fonte: 'google'
          })),
          fonte: 'google'
        });
      } else if (data.status === 'ZERO_RESULTS') {
        // Para reverse geocoding, tentar sem filtro result_type
        if (isCoords) {
          console.log('📍 Reverse geocoding sem result_type (fallback)...');
          const latlng = endereco.trim();
          const fallbackUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(latlng)}&key=${GOOGLE_API_KEY}&language=pt-BR`;
          const fbResp = await fetch(fallbackUrl);
          const fbData = await fbResp.json();
          if (fbData.status === 'OK' && fbData.results && fbData.results.length > 0) {
            const r = fbData.results[0];
            console.log('📍 Fallback aceito:', r.formatted_address);
            return res.json({
              results: [{
                endereco: r.formatted_address,
                latitude: parseFloat(latlng.split(',')[0]),
                longitude: parseFloat(latlng.split(',')[1]),
                tipos: r.types,
                componentes: r.address_components,
                fonte: 'google'
              }],
              fonte: 'google'
            });
          }
        }
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

  // Geocodificacao REVERSA (coordenadas -> endereco)
  router.get('/reverse', async (req, res) => {
    try {
      const { lat, lng } = req.query;
      const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;

      if (!lat || !lng) {
        return res.status(400).json({ error: 'Informe lat e lng' });
      }

      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
        return res.status(400).json({ error: 'Coordenadas invalidas' });
      }

      if (!GOOGLE_API_KEY) {
        console.log('GOOGLE_GEOCODING_API_KEY nao configurada para reverse');
        return res.status(500).json({ error: 'API Key nao configurada no servidor' });
      }

      // Verificar cache reverso no banco
      try {
        const cacheResult = await pool.query(
          `SELECT endereco_formatado FROM enderecos_geocodificados WHERE ABS(latitude - $1) < 0.0001 AND ABS(longitude - $2) < 0.0001 LIMIT 1`,
          [latNum, lngNum]
        );
        if (cacheResult.rows.length > 0) {
          console.log('Reverse cache HIT:', latNum, lngNum);
          return res.json({ endereco: cacheResult.rows[0].endereco_formatado, fonte: 'cache' });
        }
      } catch (dbErr) {
        console.log('Erro cache reverso:', dbErr.message);
      }

      // Google Reverse Geocoding
      console.log('Reverse geocode Google:', latNum, lngNum);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latNum},${lngNum}&key=${GOOGLE_API_KEY}&language=pt-BR`;

      const resp = await fetch(url);
      const data = await resp.json();

      if (data.status === 'OK' && data.results && data.results.length > 0) {
        const endereco = data.results[0].formatted_address;
        console.log('Reverse geocode OK:', endereco);

        // Salvar no cache
        const endNorm = normalizarEndereco(endereco);
        pool.query(
          `INSERT INTO enderecos_geocodificados (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [`${latNum},${lngNum}`, endNorm, endereco, latNum, lngNum, 'google-reverse']
        ).catch(e => console.log('Erro ao salvar cache reverso:', e.message));

        return res.json({ endereco, latitude: latNum, longitude: lngNum, fonte: 'google-reverse' });
      }

      if (data.status === 'ZERO_RESULTS') {
        return res.status(404).json({ error: 'Endereco nao encontrado para estas coordenadas' });
      }

      console.log('Google reverse erro:', data.status, data.error_message);
      return res.status(500).json({ error: 'Erro na API Google', status: data.status });
    } catch (err) {
      console.error('Erro Reverse Geocoding:', err);
      res.status(500).json({ error: 'Erro ao geocodificar reversamente' });
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
module.exports = { createGeocodeRouter };
