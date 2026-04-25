/**
 * Sub-Router: Coleta de Endereços - MOTOBOY
 *
 * Endpoints consumidos pelo app/página do motoboy.
 * Autenticação via JWT padrão (`verificarToken`) — o `req.user.codProfissional`
 * é usado pra identificar o motoboy em todas as operações.
 *
 * VÍNCULO AUTOMÁTICO: a região do motoboy é descoberta via
 * `buscarRegiaoProfissional()` (que consulta CRM → planilha → fallbacks).
 * O motoboy só enxerga regiões do módulo Coleta cujo `nome` bate com a região
 * dele no CRM (UPPER, TRIM, case-insensitive).
 *
 * Fluxo de cadastro:
 *   1. Motoboy envia POST /motoboy/coleta com nome, lat, lng, foto opcional
 *   2. Backend valida: região bate com a do CRM? duplicata? tamanho da foto?
 *   3. Chama validarLocalizacao() do módulo agent (Gemini Vision + Google Places)
 *   4. Confiança ≥ 90 → auto-aprova, cria solicitacao_favoritos, ganho confirmado
 *   5. Confiança < 90 ou sem foto → fila admin, ganho previsto
 *   6. Foto rejeitada pela IA (borrada, irrelevante) → bloqueia antes de criar pendente
 */
const express = require('express');
const { validarLocalizacao, similaridade } = require('../../agent/validar-localizacao');
const { validarNotaFiscal } = require('../../agent/validar-nota-fiscal');
const { buscarRegiaoProfissional } = require('../../../shared/utils/profissionaisLookup');
const { regioesBate } = require('../../../shared/utils/normalizarRegiao');

const TAMANHO_MAX_FOTO_KB = 800;
const LIMIAR_AUTO_APROVACAO = 90;          // % de confiança pra auto-aprovar
const RAIO_DUPLICATA_METROS = 20;          // pontos dentro desse raio + nome similar = duplicata
const LIMIAR_NOME_DUPLICATA = 0.80;        // similaridade mínima pra considerar mesmo nome

/**
 * Parser do endereço Google: "Rua X, 123 - Bairro, Cidade - UF, CEP, País"
 * Retorna { rua, numero, bairro, cidade, uf, cep }. Espelha a função do admin.routes.
 */
function parsearEnderecoGoogle(s) {
  const out = { rua: '', numero: '', bairro: '', cidade: '', uf: '', cep: '' };
  if (!s) return out;
  const partes = s.split(',').map(x => x.trim());
  out.rua = partes[0] || '';
  if (partes[1]) {
    const m = partes[1].match(/^(.+?)\s*-\s*(.+)$/);
    if (m) {
      out.numero = m[1].trim();
      out.bairro = m[2].trim();
    } else if (/^[\d\w\/]+$/.test(partes[1])) {
      out.numero = partes[1];
    } else {
      out.bairro = partes[1];
    }
  }
  if (partes[2]) {
    const m = partes[2].match(/^(.+?)\s*-\s*([A-Z]{2})$/);
    if (m) { out.cidade = m[1].trim(); out.uf = m[2].trim(); }
    else { out.cidade = partes[2]; }
  }
  for (let i = 3; i < partes.length; i++) {
    const cepMatch = partes[i].match(/(\d{5}-?\d{3})/);
    if (cepMatch && !out.cep) out.cep = cepMatch[1];
  }
  return out;
}

/**
 * Forward geocoding: endereço (texto) → { lat, lng } via Google Maps.
 * Usado pra geocodar o endereço impresso na NF e comparar com GPS do motoboy.
 * Retorna null se a key não tá configurada ou Google não achou.
 */
async function forwardGeocode(endereco) {
  const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!GOOGLE_API_KEY || !endereco) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endereco)}&key=${GOOGLE_API_KEY}&region=br&language=pt-BR&components=country:br`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Haversine simples (m). Só pra filtro grosso de duplicatas.
 */
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Reverse geocoding via Google Maps — converte lat/lng em endereço formatado.
 * Consulta cache `enderecos_geocodificados` primeiro, depois Google se miss.
 * Retorna string ou null se falhar.
 */
async function reverseGeocode(pool, latitude, longitude) {
  const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!GOOGLE_API_KEY) {
    console.warn('[coleta] GOOGLE_GEOCODING_API_KEY não configurada — sem reverse geocoding');
    return null;
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng)) return null;

  // 1) Cache (raio ~22m — 0.0002 grau)
  try {
    const cache = await pool.query(
      `SELECT endereco_formatado FROM enderecos_geocodificados
         WHERE latitude BETWEEN $1 - 0.0002 AND $1 + 0.0002
           AND longitude BETWEEN $2 - 0.0002 AND $2 + 0.0002
         LIMIT 1`,
      [lat, lng]
    );
    if (cache.rows.length > 0) return cache.rows[0].endereco_formatado;
  } catch (e) {
    console.warn('[coleta] reverse cache falhou:', e.message);
  }

  // 2) Google
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_API_KEY}&language=pt-BR`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const endereco = data.results[0].formatted_address;
      // Salva no cache (fire & forget)
      pool.query(
        `INSERT INTO enderecos_geocodificados (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte)
         VALUES ($1, $1, $2, $3, $4, 'google-reverse-coleta') ON CONFLICT DO NOTHING`,
        [`${lat},${lng}`, endereco, lat, lng]
      ).catch(() => {});
      return endereco;
    }
  } catch (e) {
    console.warn('[coleta] reverseGeocode Google falhou:', e.message);
  }
  return null;
}

/**
 * Retorna as regiões ativas do módulo Coleta que batem com a região do motoboy no CRM.
 * Retorna array vazio se o motoboy não tem região cadastrada ou nenhuma região bate.
 *
 * Match usa `regioesBate()` — tolerante a acentos, caixa, pontuação, UF no final,
 * stopwords ("de", "da", "do") e letras faltando (fuzzy ≥85%). Isso evita motoboys
 * ficarem de fora quando a região foi cadastrada com typo ou variação ortográfica.
 */
async function regioesDoMotoboy(pool, codProfissional) {
  const regiaoCrm = await buscarRegiaoProfissional(pool, codProfissional);
  if (!regiaoCrm || !regiaoCrm.trim()) return [];

  // Busca TODAS as regiões ativas e filtra em JS com match tolerante.
  // Em bases pequenas (< algumas centenas de regiões) isso é barato.
  const result = await pool.query(`
    SELECT id, nome, uf, cidade, grupo_enderecos_id
    FROM coleta_regioes
    WHERE ativo = true
    ORDER BY nome
  `);

  return result.rows.filter(r => regioesBate(regiaoCrm, r.nome));
}

function createColetaMotoboyRoutes(pool, verificarToken) {
  const router = express.Router();

  // DEBUG: o motoboy logado consulta o que o sistema enxerga dele
  // (região no CRM, regiões disponíveis, endereços visíveis).
  // Útil pra entender por que ele "não vê" um endereço.
  router.get('/motoboy/coleta/debug', verificarToken, async (req, res) => {
    try {
      const cod = req.user?.codProfissional;
      if (!cod) return res.status(401).json({ error: 'Sem cod_profissional no token' });

      const { buscarProfissional } = require('../../../shared/utils/profissionaisLookup');
      const perfil = await buscarProfissional(pool, cod);

      const regioesDoSistema = await pool.query(
        `SELECT id, nome, ativo, grupo_enderecos_id FROM coleta_regioes ORDER BY nome`
      );

      const regioesPermitidas = await regioesDoMotoboy(pool, cod);

      // Endereços visíveis pra ele
      const gruposIds = regioesPermitidas.map(r => r.grupo_enderecos_id).filter(Boolean);
      let totalEnderecos = 0;
      let amostraEnderecos = [];
      if (gruposIds.length > 0) {
        const placeholders = gruposIds.map((_, i) => `$${i + 1}`).join(',');
        const r = await pool.query(`
          SELECT id, apelido, endereco_completo, grupo_enderecos_id
          FROM solicitacao_favoritos
          WHERE grupo_enderecos_id IN (${placeholders})
          ORDER BY created_at DESC
          LIMIT 5
        `, gruposIds);
        totalEnderecos = r.rowCount;
        amostraEnderecos = r.rows;
      }

      res.json({
        motoboy: {
          cod_profissional: cod,
          perfil_encontrado_em: perfil?.origem || null,
          nome: perfil?.nome || null,
          cidade: perfil?.cidade || null,
          regiao: perfil?.regiao || null,
          regiao_resolvida: perfil ? (perfil.regiao || perfil.cidade) : null
        },
        regioes_cadastradas_no_sistema: regioesDoSistema.rows.map(r => ({
          id: r.id,
          nome: r.nome,
          ativo: r.ativo,
          tem_grupo: !!r.grupo_enderecos_id,
          bate_com_motoboy: perfil
            ? (r.nome || '').trim().toUpperCase() === ((perfil.regiao || perfil.cidade || '').trim().toUpperCase())
            : false
        })),
        regioes_que_voce_pode_atuar: regioesPermitidas.map(r => ({
          id: r.id, nome: r.nome, grupo_enderecos_id: r.grupo_enderecos_id
        })),
        enderecos_visiveis: {
          total: totalEnderecos,
          amostra: amostraEnderecos
        },
        diagnostico: !perfil ? '❌ Motoboy não encontrado no CRM/Planilha'
                   : !(perfil.regiao || perfil.cidade) ? '❌ Motoboy sem região/cidade preenchida no cadastro'
                   : regioesPermitidas.length === 0 ? `⚠️ Sua região "${perfil.regiao || perfil.cidade}" não bate com nenhuma região cadastrada no sistema. Crie uma região com esse nome exato.`
                   : gruposIds.length === 0 ? '⚠️ Suas regiões existem mas nenhuma tem grupo de endereços vinculado'
                   : totalEnderecos === 0 ? '⚠️ Tudo configurado, mas nenhum endereço foi aprovado ainda no(s) grupo(s) das suas regiões'
                   : `✅ Tudo OK — você vê ${totalEnderecos} endereço(s)`
      });
    } catch (err) {
      console.error('❌ Erro debug motoboy:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== REGIÕES DO MOTOBOY ====================

  // Lista as regiões ativas que batem automaticamente com a região do motoboy
  // no CRM. Se o motoboy não tem região no CRM ou nenhuma região do sistema bate,
  // retorna array vazio (o frontend mostra aviso "entre em contato com o admin").
  router.get('/motoboy/coleta/minhas-regioes', verificarToken, async (req, res) => {
    try {
      const cod = req.user?.codProfissional;
      if (!cod) return res.status(401).json({ error: 'Identificação de motoboy não encontrada' });

      const regioes = await regioesDoMotoboy(pool, cod);
      // Omitir grupo_enderecos_id na resposta (info interna)
      const publico = regioes.map(r => ({ id: r.id, nome: r.nome, uf: r.uf, cidade: r.cidade }));
      res.json(publico);
    } catch (err) {
      console.error('❌ Erro minhas-regioes:', err);
      res.status(500).json({ error: 'Erro ao buscar regiões' });
    }
  });

  // ==================== CADASTRAR ENDEREÇO ====================
  //
  // Fluxo:
  //   1. Motoboy envia: regiao_id, lat, lng, foto_nf_base64 (OBRIGATÓRIA), foto_base64 (fachada, OPCIONAL)
  //   2. IA analisa NF — extrai CNPJ, razão social, nome fantasia, endereço NF, número NF
  //      - Se foto não é NF / ilegível / CNPJ inválido → bloqueia direto
  //   3. Reverse geocode do GPS → endereço Google (fonte da verdade pra localização)
  //   4. Dedup por CNPJ no mesmo grupo (UNIQUE constraint)
  //   5. Se foto da fachada veio, IA também analisa fachada (bonus de confiança)
  //   6. Decide auto-aprovar (≥90% confiança IA) ou jogar pra fila admin

  router.post('/motoboy/coleta', verificarToken, async (req, res) => {
    // 2026-04: Função de cadastro pelo motoboy DESATIVADA.
    // Motoboys agora apenas consultam endereços já cadastrados pelos admins.
    // Mantemos a rota com 410 Gone pra clientes antigos receberem mensagem clara.
    return res.status(410).json({
      error: 'Cadastro de endereços desativado. Esta tela agora é apenas para consulta.',
      codigo: 'FEATURE_DEPRECATED'
    });
  });

  // ===== Implementação antiga preservada como dead code (caso queiramos reativar) =====
  router.post('/motoboy/coleta/_deprecated', verificarToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const cod = req.user?.codProfissional;
      if (!cod) return res.status(401).json({ error: 'Identificação de motoboy não encontrada' });

      const { regiao_id, nome_cliente, latitude, longitude, foto_nf_base64, foto_base64 } = req.body || {};

      // --- Validações básicas ---
      if (!regiao_id) return res.status(400).json({ error: 'Região é obrigatória' });
      if (!nome_cliente || !nome_cliente.trim()) return res.status(400).json({ error: 'Nome do cliente é obrigatório' });
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return res.status(400).json({ error: 'Localização é obrigatória' });
      }
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return res.status(400).json({ error: 'Coordenadas inválidas' });
      }
      if (!foto_nf_base64) {
        return res.status(400).json({ error: '📄 Foto da Nota Fiscal é obrigatória pra cadastrar' });
      }
      // Tamanho da NF (mais permissivo: 1.5MB) — fotos de NF tendem a ser maiores
      const bytesNF = Math.floor((foto_nf_base64.length * 3) / 4);
      if (bytesNF > 1500 * 1024) {
        return res.status(400).json({ error: 'Foto da NF muito grande (máx 1.5MB). Reduza a qualidade.' });
      }
      // Tamanho da fachada (opcional)
      if (foto_base64) {
        const bytesAprox = Math.floor((foto_base64.length * 3) / 4);
        if (bytesAprox > TAMANHO_MAX_FOTO_KB * 1024) {
          return res.status(400).json({
            error: `Foto da fachada muito grande (máx ${TAMANHO_MAX_FOTO_KB}KB). Reduza a qualidade.`
          });
        }
      }

      // --- Verifica se o motoboy pode atuar nessa região (match CRM) ---
      const regioesPermitidas = await regioesDoMotoboy(pool, cod);
      const regiao = regioesPermitidas.find(r => r.id === parseInt(regiao_id));
      if (!regiao) {
        return res.status(403).json({
          error: 'Esta região não corresponde à sua região cadastrada no sistema'
        });
      }
      const { grupo_enderecos_id } = regiao;
      if (!grupo_enderecos_id) {
        return res.status(500).json({ error: 'Região sem grupo de endereços configurado — fale com o admin' });
      }

      const nomeNormalizado = nome_cliente.trim().toUpperCase();

      // --- Reverse geocode do GPS (sempre — fonte da verdade pra localização) ---
      const enderecoFormatadoGoogle = await reverseGeocode(pool, latitude, longitude);

      // --- Valida NF via IA (Gemini OCR) ---
      let resultadoNF;
      try {
        resultadoNF = await validarNotaFiscal(foto_nf_base64, {
          latitude, longitude, enderecoGoogle: enderecoFormatadoGoogle
        });
      } catch (errNF) {
        console.error('⚠️ Falha na análise da NF:', errNF.message);
        // IA fora do ar — joga pra fila com 0% e admin decide
        resultadoNF = { nf_rejeitada: false, motivo: 'IA indisponível', confianca: 0, dados: null };
      }

      // NF foi rejeitada (não é NF, ilegível, CNPJ inválido) → bloqueia
      if (resultadoNF.nf_rejeitada) {
        return res.status(400).json({
          error: '📄 Nota fiscal inválida',
          motivo: resultadoNF.motivo
        });
      }

      const dadosNF = resultadoNF.dados || {};

      // --- Dedup por CNPJ no mesmo grupo ---
      if (dadosNF.cnpj) {
        const dup = await client.query(
          `SELECT id, apelido, endereco_completo
             FROM solicitacao_favoritos
            WHERE cnpj = $1 AND grupo_enderecos_id = $2
            LIMIT 1`,
          [dadosNF.cnpj, grupo_enderecos_id]
        );
        if (dup.rows.length > 0) {
          return res.status(409).json({
            error: '🔁 Endereço já cadastrado neste grupo',
            motivo: `O CNPJ ${dadosNF.cnpj_formatado} (${dup.rows[0].apelido}) já existe na base.`,
            duplicata: dup.rows[0]
          });
        }
      } else {
        // Fallback: dedup por proximidade + similaridade de nome (caso CNPJ falte)
        const vizinhos = await client.query(`
          SELECT id, apelido, latitude, longitude
            FROM solicitacao_favoritos
            WHERE grupo_enderecos_id = $1
              AND latitude BETWEEN $2 - 0.0005 AND $2 + 0.0005
              AND longitude BETWEEN $3 - 0.0005 AND $3 + 0.0005
        `, [grupo_enderecos_id, latitude, longitude]);
        for (const v of vizinhos.rows) {
          const dist = distanciaMetros(latitude, longitude, parseFloat(v.latitude), parseFloat(v.longitude));
          if (dist > RAIO_DUPLICATA_METROS) continue;
          const sim = similaridade(nomeNormalizado, v.apelido || '');
          if (sim >= LIMIAR_NOME_DUPLICATA) {
            return res.status(409).json({
              error: 'Endereço já cadastrado neste grupo (proximidade + nome)',
              duplicata: { id: v.id, apelido: v.apelido, distancia_m: Math.round(dist) }
            });
          }
        }
      }

      // --- Análise da foto da fachada (opcional) — só pra somar confiança ---
      let resultadoFachada = null;
      if (foto_base64) {
        try {
          resultadoFachada = await validarLocalizacao(foto_base64, latitude, longitude);
        } catch (errF) {
          console.warn('⚠️ Fachada IA falhou (ignorando):', errF.message);
        }
        // Se a fachada foi explicitamente rejeitada, ignora ela mas não bloqueia
        // (a NF é a obrigatória)
        if (resultadoFachada && resultadoFachada.foto_rejeitada) {
          console.log(`[coleta-fachada] rejeitada: ${resultadoFachada.motivo}`);
          resultadoFachada = null;
        }
      }

      // --- Score combinado: 3 caminhos INDEPENDENTES, basta um dar ≥90% pra aprovar ---
      // Auto-aprova quando QUALQUER UM dos critérios atinge 90+:
      //   A) Match da fachada com Google Places                  → confiança da fachada
      //   B) Endereço da NF geocodado bate com GPS (≤15m)        → 90-100 conforme distância
      //   C) Nome/razão social da NF bate com nome lido na fachada → 95 fixo
      // Score final = MAX(A, B, C). Se nenhum passa, vai pra fila admin.

      // === Caminho A: Fachada validada via Google Places ===
      const scoreFachada = resultadoFachada?.confianca || 0;

      // === Caminho B: Endereço da NF é o mesmo lugar que o GPS ===
      // Forward-geocode o endereço impresso na NF e mede distância até o GPS.
      let scoreEnderecoNF = 0;
      let distanciaMetrosNF = null;
      let coordsEnderecoNF = null;
      if (dadosNF.endereco_nf) {
        try {
          coordsEnderecoNF = await forwardGeocode(dadosNF.endereco_nf);
          if (coordsEnderecoNF) {
            distanciaMetrosNF = distanciaMetros(
              latitude, longitude,
              coordsEnderecoNF.lat, coordsEnderecoNF.lng
            );
            // ≤15m: bate (95-100). 15-50m: razoável (70-90). >50m: divergente (≤50)
            if (distanciaMetrosNF <= 15) scoreEnderecoNF = 100;
            else if (distanciaMetrosNF <= 30) scoreEnderecoNF = 90;
            else if (distanciaMetrosNF <= 50) scoreEnderecoNF = 75;
            else if (distanciaMetrosNF <= 200) scoreEnderecoNF = 50;
            else scoreEnderecoNF = 20;
            console.log(`[coleta-score] B endereco_nf=${distanciaMetrosNF.toFixed(0)}m → ${scoreEnderecoNF}`);
          }
        } catch (e) {
          console.warn('[coleta-score] forwardGeocode NF falhou:', e.message);
        }
      }

      // === Caminho C: Nome da NF bate com nome lido na fachada ===
      let scoreNomeMatch = 0;
      const nomeFachada = resultadoFachada?.nome_foto || resultadoFachada?.match_google?.nome || '';
      const nomeNF = dadosNF.nome_fantasia || dadosNF.razao_social || '';
      if (nomeFachada && nomeNF) {
        const sim = similaridade(
          nomeFachada.toUpperCase().trim(),
          nomeNF.toUpperCase().trim()
        );
        if (sim >= 0.80) scoreNomeMatch = 95;
        else if (sim >= 0.60) scoreNomeMatch = 75;
        console.log(`[coleta-score] C nome match: "${nomeFachada}" ↔ "${nomeNF}" sim=${sim.toFixed(2)} → ${scoreNomeMatch}`);
      }

      // Score final = melhor dos 3 caminhos
      const scoreFinal = Math.max(scoreFachada, scoreEnderecoNF, scoreNomeMatch);
      console.log(`[coleta-score] A=${scoreFachada} B=${scoreEnderecoNF} C=${scoreNomeMatch} → final=${scoreFinal}`);

      const matchGoogle = resultadoFachada?.match_google || null;

      // Endereço final: do match da IA fachada se disponível, senão do reverse geocode
      const enderecoFormatado = matchGoogle?.endereco || enderecoFormatadoGoogle;

      const autoAprovar = scoreFinal >= LIMIAR_AUTO_APROVACAO;
      const statusInicial = autoAprovar ? 'aprovado' : 'validacao_manual';

      await client.query('BEGIN');

      // Criar pendente — agora com dados da NF
      const pendenteIns = await client.query(`
        INSERT INTO coleta_enderecos_pendentes (
          cod_profissional, regiao_id, nome_cliente,
          latitude, longitude, foto_base64, foto_nf_base64,
          status, confianca_ia, match_google, endereco_formatado,
          cnpj, razao_social, nome_fantasia, numero_nf, endereco_nf, cidade_nf,
          analisado_em
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP)
        RETURNING id
      `, [
        cod, regiao_id, nomeNormalizado,
        latitude, longitude, foto_base64 || null, foto_nf_base64,
        statusInicial, scoreFinal,
        matchGoogle ? JSON.stringify(matchGoogle) : null,
        enderecoFormatado,
        dadosNF.cnpj, dadosNF.razao_social, dadosNF.nome_fantasia,
        dadosNF.numero_nf, dadosNF.endereco_nf, dadosNF.cidade_nf
      ]);
      const pendenteId = pendenteIns.rows[0].id;

      let favoritoId = null;

      if (autoAprovar) {
        // Buscar metadados da região (cidade, uf) pra gravar no favorito
        const regiaoRow = await client.query(
          'SELECT cidade, uf FROM coleta_regioes WHERE id = $1',
          [regiao_id]
        );
        const { cidade, uf } = regiaoRow.rows[0] || {};

        // Parse do endereço Google pra preencher rua/numero/bairro/cep
        const parsed = parsearEnderecoGoogle(enderecoFormatado || '');

        // Cria em solicitacao_favoritos com CNPJ (pra dedup futura)
        const fav = await client.query(`
          INSERT INTO solicitacao_favoritos (
            cliente_id, grupo_enderecos_id, apelido, endereco_completo,
            rua, numero, bairro, cidade, uf, cep,
            latitude, longitude, cnpj, razao_social
          ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id
        `, [
          grupo_enderecos_id, nomeNormalizado, enderecoFormatado || '',
          parsed.rua || enderecoFormatado || `Lat ${latitude}, Lng ${longitude}`,
          parsed.numero || 'S/N',
          parsed.bairro || null,
          parsed.cidade || cidade || dadosNF.cidade_nf || null,
          parsed.uf || uf || dadosNF.uf_nf || null,
          parsed.cep || dadosNF.cep_nf || null,
          latitude, longitude,
          dadosNF.cnpj || null, dadosNF.razao_social || null
        ]);
        favoritoId = fav.rows[0].id;

        await client.query(`
          UPDATE coleta_enderecos_pendentes SET
            endereco_gerado_id = $1,
            finalizado_em = CURRENT_TIMESTAMP,
            foto_base64 = NULL
          WHERE id = $2
        `, [favoritoId, pendenteId]);

        await client.query(`
          INSERT INTO coleta_motoboy_ganhos (
            cod_profissional, endereco_pendente_id, valor, status, descricao
          ) VALUES ($1, $2, 1.00, 'confirmado', $3)
        `, [cod, pendenteId, `Auto-aprovado com ${scoreFinal}% de confiança (NF: ${dadosNF.cnpj_formatado || 'sem CNPJ'})`]);
      } else {
        await client.query(`
          INSERT INTO coleta_motoboy_ganhos (
            cod_profissional, endereco_pendente_id, valor, status, descricao
          ) VALUES ($1, $2, 1.00, 'previsto', $3)
        `, [cod, pendenteId, `Aguardando validação manual (${scoreFinal}% NF: ${dadosNF.cnpj_formatado || 'sem CNPJ'})`]);
      }

      await client.query('COMMIT');

      // Identifica qual caminho deu o melhor score (pro feedback ao motoboy)
      let caminhoAprovacao = null;
      if (autoAprovar) {
        if (scoreFachada >= LIMIAR_AUTO_APROVACAO && scoreFachada === scoreFinal) caminhoAprovacao = 'fachada';
        else if (scoreEnderecoNF >= LIMIAR_AUTO_APROVACAO && scoreEnderecoNF === scoreFinal) caminhoAprovacao = 'endereco_nf';
        else if (scoreNomeMatch >= LIMIAR_AUTO_APROVACAO && scoreNomeMatch === scoreFinal) caminhoAprovacao = 'nome_match';
      }

      return res.json({
        sucesso: true,
        id: pendenteId,
        status: statusInicial,
        confianca: scoreFinal,
        scores: {
          fachada: scoreFachada,
          endereco_nf: scoreEnderecoNF,
          nome_match: scoreNomeMatch,
          distancia_nf_metros: distanciaMetrosNF !== null ? Math.round(distanciaMetrosNF) : null
        },
        caminho_aprovacao: caminhoAprovacao,
        auto_aprovado: autoAprovar,
        favorito_id: favoritoId,
        dados_nf: dadosNF,
        mensagem: autoAprovar
          ? `✅ Endereço aprovado automaticamente! R$ 1,00 confirmado.`
          : `⏳ Em análise. Admin vai revisar em breve. R$ 1,00 previsto.`
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Bate na UNIQUE (cnpj, grupo) → 409
      if (err.code === '23505' && /cnpj/i.test(err.constraint || '')) {
        return res.status(409).json({
          error: '🔁 CNPJ já cadastrado neste grupo (race condition)',
          details: err.detail
        });
      }
      console.error('❌ Erro ao cadastrar endereço motoboy:', err);
      res.status(500).json({ error: 'Erro ao cadastrar endereço', details: err.message });
    } finally {
      client.release();
    }
  });

  // ==================== CONSULTAR ENDEREÇOS ====================

  // Motoboy vê:
  //   - endereços que ele cadastrou (inclusive pendentes, rejeitados)
  //   - endereços aprovados das regiões que batem com a região dele no CRM
  router.get('/motoboy/coleta/enderecos', verificarToken, async (req, res) => {
    try {
      const cod = req.user?.codProfissional;
      if (!cod) return res.status(401).json({ error: 'Identificação não encontrada' });

      const { q } = req.query;
      const termo = q && q.trim() ? `%${q.trim()}%` : null;

      // Descobre regiões permitidas (via CRM). Se não tem, só mostra pendentes dele.
      const regioesPermitidas = await regioesDoMotoboy(pool, cod);
      const gruposIds = regioesPermitidas
        .map(r => r.grupo_enderecos_id)
        .filter(Boolean);

      let enderecosGrupo = { rows: [] };
      if (gruposIds.length > 0) {
        const gruposPlaceholders = gruposIds.map((_, i) => `$${i + 1}`).join(',');
        const paramsEnderecos = [...gruposIds];
        let filtroTermo = '';
        if (termo) {
          paramsEnderecos.push(termo);
          filtroTermo = ` AND (f.apelido ILIKE $${paramsEnderecos.length} OR f.endereco_completo ILIKE $${paramsEnderecos.length})`;
        }

        enderecosGrupo = await pool.query(`
          SELECT f.id, f.apelido, f.endereco_completo, f.cidade, f.uf,
                 f.latitude, f.longitude, f.vezes_usado, f.ultimo_uso,
                 f.procurar_por_padrao, f.telefone_padrao, f.observacao_padrao,
                 f.razao_social, f.nome_fantasia,
                 p.cod_profissional AS cadastrado_por,
                 p.criado_em AS cadastrado_em,
                 CASE WHEN p.foto_base64 IS NOT NULL THEN true ELSE false END AS tem_foto,
                 p.id AS pendente_id,
                 r.nome AS regiao_nome
          FROM solicitacao_favoritos f
          LEFT JOIN coleta_regioes r ON r.grupo_enderecos_id = f.grupo_enderecos_id
          LEFT JOIN coleta_enderecos_pendentes p ON p.endereco_gerado_id = f.id
          WHERE f.grupo_enderecos_id IN (${gruposPlaceholders})
            ${filtroTermo}
          ORDER BY f.vezes_usado DESC, f.ultimo_uso DESC NULLS LAST
          LIMIT 100
        `, paramsEnderecos);
      }

      // 2026-04: motoboy não cadastra mais endereços (função desativada).
      // meus_pendentes retorna sempre vazio — frontend antigo continua funcionando, novo nem renderiza.
      const meusPendentes = { rows: [] };

      res.json({
        aprovados: enderecosGrupo.rows,
        meus_pendentes: meusPendentes.rows
      });
    } catch (err) {
      console.error('❌ Erro ao listar endereços motoboy:', err);
      res.status(500).json({ error: 'Erro ao listar endereços' });
    }
  });

  // Retorna a foto de um endereço específico (sob demanda, pra não pesar a lista)
  router.get('/motoboy/coleta/enderecos/:pendente_id/foto', verificarToken, async (req, res) => {
    try {
      const cod = req.user?.codProfissional;
      const { pendente_id } = req.params;

      // Busca regiões do motoboy via CRM
      const regioesPermitidas = await regioesDoMotoboy(pool, cod);
      const regioesIds = regioesPermitidas.map(r => r.id);

      // Acesso: é do próprio motoboy OU está numa região que ele atende
      let query, params;
      if (regioesIds.length > 0) {
        const placeholders = regioesIds.map((_, i) => `$${i + 2}`).join(',');
        query = `
          SELECT foto_base64 FROM coleta_enderecos_pendentes
          WHERE id = $1 AND (
            cod_profissional = $${regioesIds.length + 2}
            OR regiao_id IN (${placeholders})
          )
        `;
        params = [pendente_id, ...regioesIds, cod];
      } else {
        // Sem região, só pode ver o próprio
        query = `SELECT foto_base64 FROM coleta_enderecos_pendentes WHERE id = $1 AND cod_profissional = $2`;
        params = [pendente_id, cod];
      }

      const check = await pool.query(query, params);

      if (check.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
      if (!check.rows[0].foto_base64) return res.status(404).json({ error: 'Sem foto' });
      res.json({ foto: check.rows[0].foto_base64 });
    } catch (err) {
      console.error('❌ Erro ao buscar foto motoboy:', err);
      res.status(500).json({ error: 'Erro ao buscar foto' });
    }
  });

  // Foto da NF (acesso só ao próprio motoboy — auditoria)
  router.get('/motoboy/coleta/enderecos/:pendente_id/foto-nf', verificarToken, async (req, res) => {
    try {
      const cod = req.user?.codProfissional;
      const r = await pool.query(
        `SELECT foto_nf_base64 FROM coleta_enderecos_pendentes
           WHERE id = $1 AND cod_profissional = $2`,
        [req.params.pendente_id, cod]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
      if (!r.rows[0].foto_nf_base64) return res.status(404).json({ error: 'Sem foto da NF' });
      res.json({ foto: r.rows[0].foto_nf_base64 });
    } catch (err) {
      console.error('❌ Erro ao buscar foto NF motoboy:', err);
      res.status(500).json({ error: 'Erro ao buscar foto NF' });
    }
  });

  // ==================== WALLET / GANHOS ====================

  router.get('/motoboy/coleta/ganhos', verificarToken, async (req, res) => {
    try {
      const cod = req.user?.codProfissional;
      if (!cod) return res.status(401).json({ error: 'Identificação não encontrada' });

      const stats = await pool.query(`
        SELECT
          COALESCE(SUM(valor) FILTER (WHERE status = 'confirmado'), 0) AS total_confirmado,
          COALESCE(SUM(valor) FILTER (WHERE status = 'previsto'), 0) AS total_previsto,
          COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) AS total_pago,
          COUNT(*) FILTER (WHERE status = 'confirmado') AS qtd_confirmada,
          COUNT(*) FILTER (WHERE status = 'previsto') AS qtd_prevista
        FROM coleta_motoboy_ganhos
        WHERE cod_profissional = $1
      `, [cod]);

      const historico = await pool.query(`
        SELECT g.id, g.valor, g.status, g.descricao, g.criado_em,
               p.nome_cliente, p.status AS status_pendente, p.confianca_ia,
               r.nome AS regiao_nome
        FROM coleta_motoboy_ganhos g
        JOIN coleta_enderecos_pendentes p ON p.id = g.endereco_pendente_id
        LEFT JOIN coleta_regioes r ON r.id = p.regiao_id
        WHERE g.cod_profissional = $1
        ORDER BY g.criado_em DESC
        LIMIT 50
      `, [cod]);

      res.json({
        saldo: stats.rows[0],
        historico: historico.rows
      });
    } catch (err) {
      console.error('❌ Erro ao buscar ganhos:', err);
      res.status(500).json({ error: 'Erro ao buscar ganhos' });
    }
  });

  return router;
}

module.exports = { createColetaMotoboyRoutes };
