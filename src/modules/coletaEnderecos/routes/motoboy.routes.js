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
const { buscarRegiaoProfissional } = require('../../../shared/utils/profissionaisLookup');

const TAMANHO_MAX_FOTO_KB = 800;
const LIMIAR_AUTO_APROVACAO = 90;          // % de confiança pra auto-aprovar
const RAIO_DUPLICATA_METROS = 20;          // pontos dentro desse raio + nome similar = duplicata
const LIMIAR_NOME_DUPLICATA = 0.80;        // similaridade mínima pra considerar mesmo nome

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
  const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!GOOGLE_API_KEY) {
    console.warn('[coleta] GOOGLE_MAPS_API_KEY não configurada — sem reverse geocoding');
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
 */
async function regioesDoMotoboy(pool, codProfissional) {
  const regiaoCrm = await buscarRegiaoProfissional(pool, codProfissional);
  if (!regiaoCrm || !regiaoCrm.trim()) return [];

  const result = await pool.query(`
    SELECT id, nome, uf, cidade, grupo_enderecos_id
    FROM coleta_regioes
    WHERE ativo = true
      AND UPPER(TRIM(nome)) = UPPER(TRIM($1))
    ORDER BY nome
  `, [regiaoCrm]);

  return result.rows;
}

function createColetaMotoboyRoutes(pool, verificarToken) {
  const router = express.Router();

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

  router.post('/motoboy/coleta', verificarToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const cod = req.user?.codProfissional;
      if (!cod) return res.status(401).json({ error: 'Identificação de motoboy não encontrada' });

      const { regiao_id, nome_cliente, latitude, longitude, foto_base64 } = req.body || {};

      // --- Validações básicas ---
      if (!regiao_id) return res.status(400).json({ error: 'Região é obrigatória' });
      if (!nome_cliente || !nome_cliente.trim()) return res.status(400).json({ error: 'Nome do cliente é obrigatório' });
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return res.status(400).json({ error: 'Localização é obrigatória' });
      }
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return res.status(400).json({ error: 'Coordenadas inválidas' });
      }
      if (foto_base64) {
        // Aproxima tamanho: cada char base64 ≈ 0.75 bytes
        const bytesAprox = Math.floor((foto_base64.length * 3) / 4);
        if (bytesAprox > TAMANHO_MAX_FOTO_KB * 1024) {
          return res.status(400).json({
            error: `Foto muito grande (máx ${TAMANHO_MAX_FOTO_KB}KB). Reduza a qualidade antes de enviar.`
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

      // --- Verifica duplicata: mesmo grupo, raio 20m, nome similar ≥ 80% ---
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
            error: 'Endereço já cadastrado neste grupo',
            duplicata: { id: v.id, apelido: v.apelido, distancia_m: Math.round(dist) }
          });
        }
      }

      // --- Chama IA pra validar (só se tiver foto) ---
      let resultadoIA = null;
      if (foto_base64) {
        try {
          resultadoIA = await validarLocalizacao(foto_base64, latitude, longitude);
        } catch (errIA) {
          console.error('⚠️ Falha na validação IA:', errIA.message);
          resultadoIA = null;
        }
      }

      // Foto foi rejeitada pela IA (borrada, irrelevante, etc.) → bloqueia direto
      if (resultadoIA && resultadoIA.foto_rejeitada) {
        return res.status(400).json({
          error: 'Foto inválida',
          motivo: resultadoIA.motivo || 'A foto não parece ser uma fachada de estabelecimento'
        });
      }

      const confianca = resultadoIA?.confianca || 0;
      const matchGoogle = resultadoIA?.match_google || null;

      // Endereço formatado: prioriza o do match da IA, senão faz reverse geocoding
      // do Google diretamente. Assim o admin sempre vê o endereço, mesmo sem foto.
      let enderecoFormatado = matchGoogle?.endereco || null;
      if (!enderecoFormatado) {
        enderecoFormatado = await reverseGeocode(pool, latitude, longitude);
      }

      // Sem foto → confiança máxima 0, sempre vai pra fila
      const autoAprovar = !!foto_base64 && confianca >= LIMIAR_AUTO_APROVACAO;
      const statusInicial = autoAprovar ? 'aprovado' : 'validacao_manual';

      await client.query('BEGIN');

      // Criar pendente
      const pendenteIns = await client.query(`
        INSERT INTO coleta_enderecos_pendentes (
          cod_profissional, regiao_id, nome_cliente,
          latitude, longitude, foto_base64,
          status, confianca_ia, match_google, endereco_formatado,
          analisado_em
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
        RETURNING id
      `, [
        cod, regiao_id, nomeNormalizado,
        latitude, longitude, foto_base64 || null,
        statusInicial, confianca,
        matchGoogle ? JSON.stringify(matchGoogle) : null,
        enderecoFormatado
      ]);
      const pendenteId = pendenteIns.rows[0].id;

      let favoritoId = null;

      if (autoAprovar) {
        // Buscar metadados da região (cidade, uf) pra gravar no favorito
        const regiao = await client.query(
          'SELECT cidade, uf FROM coleta_regioes WHERE id = $1',
          [regiao_id]
        );
        const { cidade, uf } = regiao.rows[0] || {};

        // Criar em solicitacao_favoritos (cliente_id = NULL, é da base colaborativa)
        const fav = await client.query(`
          INSERT INTO solicitacao_favoritos (
            cliente_id, grupo_enderecos_id, apelido, endereco_completo,
            cidade, uf, latitude, longitude
          ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [grupo_enderecos_id, nomeNormalizado, enderecoFormatado || '', cidade, uf, latitude, longitude]);
        favoritoId = fav.rows[0].id;

        // Marca pendente como aprovado e limpa foto
        await client.query(`
          UPDATE coleta_enderecos_pendentes SET
            endereco_gerado_id = $1,
            finalizado_em = CURRENT_TIMESTAMP,
            foto_base64 = NULL
          WHERE id = $2
        `, [favoritoId, pendenteId]);

        // Ganho confirmado imediato
        await client.query(`
          INSERT INTO coleta_motoboy_ganhos (
            cod_profissional, endereco_pendente_id, valor, status, descricao
          ) VALUES ($1, $2, 1.00, 'confirmado', $3)
        `, [cod, pendenteId, `Auto-aprovado com ${confianca}% de confiança`]);
      } else {
        // Ganho previsto (aguarda admin)
        await client.query(`
          INSERT INTO coleta_motoboy_ganhos (
            cod_profissional, endereco_pendente_id, valor, status, descricao
          ) VALUES ($1, $2, 1.00, 'previsto', $3)
        `, [cod, pendenteId, foto_base64
              ? `Aguardando validação manual (${confianca}% de confiança IA)`
              : 'Aguardando validação manual (sem foto)']);
      }

      await client.query('COMMIT');

      return res.json({
        sucesso: true,
        id: pendenteId,
        status: statusInicial,
        confianca,
        auto_aprovado: autoAprovar,
        favorito_id: favoritoId,
        match_google: matchGoogle,
        mensagem: autoAprovar
          ? `✅ Endereço aprovado automaticamente! R$ 1,00 confirmado.`
          : `⏳ Em análise. Admin vai revisar em breve. R$ 1,00 previsto.`
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('❌ Erro ao cadastrar endereço motoboy:', err);
      res.status(500).json({ error: 'Erro ao cadastrar endereço' });
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

      // Pendentes / rejeitados do próprio motoboy (sempre visíveis, mesmo sem região)
      const meusPendentes = await pool.query(`
        SELECT p.id, p.nome_cliente AS apelido, p.endereco_formatado AS endereco_completo,
               p.latitude, p.longitude, p.status, p.confianca_ia, p.motivo_rejeicao,
               p.criado_em, r.nome AS regiao_nome
        FROM coleta_enderecos_pendentes p
        LEFT JOIN coleta_regioes r ON r.id = p.regiao_id
        WHERE p.cod_profissional = $1 AND p.status IN ('validacao_manual', 'rejeitado')
          ${termo ? `AND (p.nome_cliente ILIKE $2 OR p.endereco_formatado ILIKE $2)` : ''}
        ORDER BY p.criado_em DESC
        LIMIT 30
      `, termo ? [cod, termo] : [cod]);

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
