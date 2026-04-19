/**
 * Sub-Router: Coleta de Endereços - ADMIN
 *
 * Endpoints pra gerenciar regiões e revisar a fila de endereços em validação
 * manual (IA não teve confiança suficiente).
 *
 * VÍNCULO AUTOMÁTICO: motoboys são associados à região pelo match de nome —
 * o campo `regiao` (ou `cidade`) do profissional é comparado com o `nome` da
 * região aqui (case-insensitive). A fonte dos motoboys é `listarProfissionais()`
 * do shared — que consulta CRM + Planilha Google Sheets (merge). Isso garante
 * que motoboys legados (só na planilha) também sejam contabilizados.
 *
 * Todos os endpoints exigem JWT válido via `verificarToken`.
 */
const express = require('express');
const { listarProfissionais, listarRegioes } = require('../../../shared/utils/profissionaisLookup');

/**
 * Reverse geocoding via Google Maps — converte lat/lng em endereço formatado.
 * Consulta cache `enderecos_geocodificados` primeiro, depois Google se miss.
 * Retorna string ou null se falhar.
 */
async function reverseGeocode(pool, latitude, longitude) {
  const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!GOOGLE_API_KEY) {
    console.warn('[coleta-reverse] ⚠️ GOOGLE_MAPS_API_KEY e GOOGLE_API_KEY não configuradas');
    return null;
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng)) return null;

  try {
    const cache = await pool.query(
      `SELECT endereco_formatado FROM enderecos_geocodificados
         WHERE latitude BETWEEN $1 - 0.0002 AND $1 + 0.0002
           AND longitude BETWEEN $2 - 0.0002 AND $2 + 0.0002
         LIMIT 1`,
      [lat, lng]
    );
    if (cache.rows.length > 0) {
      console.log(`[coleta-reverse] cache HIT ${lat},${lng}`);
      return cache.rows[0].endereco_formatado;
    }
  } catch (e) {
    console.warn('[coleta-reverse] cache falhou:', e.message);
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_API_KEY}&language=pt-BR`;
    const resp = await fetch(url);
    const data = await resp.json();
    console.log(`[coleta-reverse] Google ${lat},${lng} → status=${data.status} results=${data.results?.length || 0}`);
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const endereco = data.results[0].formatted_address;
      pool.query(
        `INSERT INTO enderecos_geocodificados (endereco_busca, endereco_busca_normalizado, endereco_formatado, latitude, longitude, fonte)
         VALUES ($1, $1, $2, $3, $4, 'google-reverse-coleta') ON CONFLICT DO NOTHING`,
        [`${lat},${lng}`, endereco, lat, lng]
      ).catch(() => {});
      return endereco;
    }
    if (data.status !== 'OK') {
      console.warn(`[coleta-reverse] Google não OK: ${data.status} ${data.error_message || ''}`);
    }
  } catch (e) {
    console.warn('[coleta-reverse] Google fetch falhou:', e.message);
  }
  return null;
}

/**
 * Normaliza texto pra match: UPPER + TRIM.
 * Retorna string vazia se null/undefined.
 */
function normalizar(str) {
  return String(str || '').trim().toUpperCase();
}

/**
 * Dada uma lista de regiões (coleta_regioes) e a lista completa de profissionais
 * (CRM + planilha), retorna um Map<regiao_id, Array<profissionais>>.
 * Match: UPPER(TRIM(prof.regiao || prof.cidade)) === UPPER(TRIM(regiao.nome))
 */
function agruparProfissionaisPorRegiao(regioes, profissionais) {
  const mapa = new Map(); // regiao_id → [profs]
  for (const r of regioes) mapa.set(r.id, []);

  const indiceNome = new Map(); // nome normalizado → regiao_id
  for (const r of regioes) {
    indiceNome.set(normalizar(r.nome), r.id);
  }

  for (const p of profissionais) {
    const chave = normalizar(p.regiao || p.cidade);
    if (!chave) continue;
    const regiaoId = indiceNome.get(chave);
    if (regiaoId) {
      mapa.get(regiaoId).push(p);
    }
  }
  return mapa;
}

function createColetaAdminRoutes(pool, verificarToken) {
  const router = express.Router();

  // ==================== REGIÕES ====================

  // Lista regiões com contadores de motoboys (CRM + Planilha) e endereços.
  // Usa listarProfissionais() pra pegar TODOS os motoboys (não só os do CRM).
  router.get('/admin/coleta/regioes', verificarToken, async (req, res) => {
    try {
      // Consulta base: regiões + grupo + contadores de pendentes/aprovados
      const result = await pool.query(`
        SELECT r.*,
          g.nome AS grupo_nome,
          COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'aprovado') AS total_aprovados,
          COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'validacao_manual') AS total_pendentes
        FROM coleta_regioes r
        LEFT JOIN grupos_enderecos g ON g.id = r.grupo_enderecos_id
        LEFT JOIN coleta_enderecos_pendentes p ON p.regiao_id = r.id
        GROUP BY r.id, g.nome
        ORDER BY r.nome
      `);

      // Enriquece com total_motoboys vindo do merge CRM+Planilha
      let profissionais = [];
      try {
        profissionais = await listarProfissionais(pool);
      } catch (err) {
        console.warn('⚠️ Falha ao listar profissionais (CRM+Planilha):', err.message);
      }

      const profPorRegiao = agruparProfissionaisPorRegiao(result.rows, profissionais);

      const enriquecido = result.rows.map(r => ({
        ...r,
        total_motoboys: (profPorRegiao.get(r.id) || []).length
      }));

      res.json(enriquecido);
    } catch (err) {
      console.error('❌ Erro ao listar regiões:', err);
      res.status(500).json({ error: 'Erro ao listar regiões' });
    }
  });

  // Criar região
  router.post('/admin/coleta/regioes', verificarToken, async (req, res) => {
    try {
      const { nome, uf, cidade, grupo_enderecos_id } = req.body;
      if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
      if (!grupo_enderecos_id) return res.status(400).json({ error: 'Grupo de endereços é obrigatório' });

      const result = await pool.query(`
        INSERT INTO coleta_regioes (nome, uf, cidade, grupo_enderecos_id)
        VALUES ($1, $2, $3, $4) RETURNING *
      `, [nome.trim(), uf?.trim().toUpperCase() || null, cidade?.trim() || null, grupo_enderecos_id]);
      res.json(result.rows[0]);
    } catch (err) {
      console.error('❌ Erro ao criar região:', err);
      res.status(500).json({ error: 'Erro ao criar região' });
    }
  });

  // Editar região (nome, uf, cidade, grupo, ativo)
  router.patch('/admin/coleta/regioes/:id', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { nome, uf, cidade, grupo_enderecos_id, ativo } = req.body;
      await pool.query(`
        UPDATE coleta_regioes SET
          nome = COALESCE($1, nome),
          uf = COALESCE($2, uf),
          cidade = COALESCE($3, cidade),
          grupo_enderecos_id = COALESCE($4, grupo_enderecos_id),
          ativo = COALESCE($5, ativo),
          atualizado_em = CURRENT_TIMESTAMP
        WHERE id = $6
      `, [nome?.trim() || null, uf?.trim().toUpperCase() || null, cidade?.trim() || null, grupo_enderecos_id || null, ativo, id]);
      res.json({ sucesso: true });
    } catch (err) {
      console.error('❌ Erro ao editar região:', err);
      res.status(500).json({ error: 'Erro ao editar região' });
    }
  });

  // Excluir região (em cascata remove vínculos e pendentes)
  router.delete('/admin/coleta/regioes/:id', verificarToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM coleta_regioes WHERE id = $1', [req.params.id]);
      res.json({ sucesso: true });
    } catch (err) {
      console.error('❌ Erro ao excluir região:', err);
      res.status(500).json({ error: 'Erro ao excluir região' });
    }
  });

  // ==================== MOTOBOYS (vinculação automática via CRM) ====================

  // Lista motoboys que AUTOMATICAMENTE estão vinculados a esta região
  // (match do campo regiao/cidade do profissional com o nome da região).
  // Usa listarProfissionais() → CRM + Planilha (merge).
  // Resultado é read-only — não há como adicionar/remover manualmente.
  router.get('/admin/coleta/regioes/:id/motoboys', verificarToken, async (req, res) => {
    try {
      const regiao = await pool.query('SELECT nome FROM coleta_regioes WHERE id = $1', [req.params.id]);
      if (regiao.rows.length === 0) return res.status(404).json({ error: 'Região não encontrada' });

      const nomeRegiao = normalizar(regiao.rows[0].nome);

      const profissionais = await listarProfissionais(pool);

      // Match case-insensitive: pega motoboys cuja regiao OU cidade bate com o nome
      const motoboys = profissionais
        .filter(p => normalizar(p.regiao || p.cidade) === nomeRegiao)
        .map(p => ({
          cod_profissional: p.codigo,
          full_name: p.nome,
          cidade: p.cidade,
          regiao: p.regiao,
          celular: p.telefone,
          origem: p.origem  // 'crm' ou 'planilha' — útil pra debug
        }))
        .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'pt-BR'))
        .slice(0, 500);

      res.json(motoboys);
    } catch (err) {
      console.error('❌ Erro ao listar motoboys da região:', err);
      res.status(500).json({ error: 'Erro ao listar motoboys' });
    }
  });

  // Lista regiões disponíveis (CRM + Planilha) pra autocomplete do modal.
  router.get('/admin/coleta/regioes-crm', verificarToken, async (req, res) => {
    try {
      const regioes = await listarRegioes(pool);
      res.json(regioes);
    } catch (err) {
      console.error('❌ Erro ao listar regiões CRM:', err);
      res.status(500).json({ error: 'Erro ao listar regiões do CRM' });
    }
  });

  // DEBUG: Inspeciona o match de uma região específica.
  // Retorna TODAS as regiões únicas que aparecem na base (CRM + Planilha) com
  // contagem por região, separadas por origem. Útil pra entender por que o
  // match não está encontrando motoboys.
  router.get('/admin/coleta/debug/:regiao_id', verificarToken, async (req, res) => {
    try {
      const regiao = await pool.query('SELECT nome FROM coleta_regioes WHERE id = $1', [req.params.regiao_id]);
      if (regiao.rows.length === 0) return res.status(404).json({ error: 'Região não encontrada' });

      const nomeBuscado = regiao.rows[0].nome;
      const nomeNormalizado = normalizar(nomeBuscado);

      const profissionais = await listarProfissionais(pool);

      // Agrupa por valor único de regiao/cidade (normalizado) com contagem e exemplos
      const stats = new Map();
      for (const p of profissionais) {
        const valor = (p.regiao || p.cidade || '').trim();
        const chave = valor.toUpperCase();
        if (!chave) continue;
        if (!stats.has(chave)) stats.set(chave, { valor_original: valor, total: 0, crm: 0, planilha: 0, exemplos: [] });
        const s = stats.get(chave);
        s.total++;
        s[p.origem] = (s[p.origem] || 0) + 1;
        if (s.exemplos.length < 3) {
          s.exemplos.push({ codigo: p.codigo, nome: p.nome, origem: p.origem });
        }
      }

      const todasRegioesUnicas = Array.from(stats.entries())
        .map(([chave, s]) => ({ chave_normalizada: chave, ...s, bate_com_busca: chave === nomeNormalizado }))
        .sort((a, b) => b.total - a.total);

      // Match exato + matches parciais (contém a palavra)
      const matchExato = todasRegioesUnicas.find(r => r.chave_normalizada === nomeNormalizado);
      const matchesParciais = todasRegioesUnicas
        .filter(r => r.chave_normalizada !== nomeNormalizado && (
          r.chave_normalizada.includes(nomeNormalizado) ||
          nomeNormalizado.includes(r.chave_normalizada)
        ))
        .slice(0, 10);

      res.json({
        regiao_buscada: {
          id: parseInt(req.params.regiao_id),
          nome_original: nomeBuscado,
          nome_normalizado: nomeNormalizado
        },
        total_profissionais_no_sistema: profissionais.length,
        match_exato: matchExato || null,
        matches_parciais_possiveis: matchesParciais,
        todas_regioes_distintas: todasRegioesUnicas.slice(0, 50),
        dica: matchExato
          ? `✅ Match exato encontrado: ${matchExato.total} motoboy(s)`
          : matchesParciais.length > 0
            ? `⚠️ Sem match exato. Talvez a região devesse se chamar "${matchesParciais[0].valor_original}"?`
            : '❌ Nenhuma região parecida. Verifique se existem motoboys cadastrados com cidade/região preenchida.'
      });
    } catch (err) {
      console.error('❌ Erro debug:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // DEBUG: força invalidação do cache da planilha (5min TTL).
  // Use quando você acabou de atualizar a planilha e quer ver o efeito imediato.
  router.post('/admin/coleta/debug/invalidar-cache', verificarToken, async (req, res) => {
    try {
      const { invalidarCachePlanilha } = require('../../../shared/utils/profissionaisLookup');
      invalidarCachePlanilha();
      res.json({ sucesso: true, mensagem: 'Cache da planilha invalidado. Próximo request busca dados frescos.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== FILA DE VALIDAÇÃO MANUAL ====================

  // Lista pendentes com filtros (status, região)
  router.get('/admin/coleta/fila', verificarToken, async (req, res) => {
    try {
      const { status, regiao_id } = req.query;
      const params = [];
      let where = '1=1';
      if (status) {
        params.push(status);
        where += ` AND p.status = $${params.length}`;
      } else {
        where += ` AND p.status = 'validacao_manual'`;
      }
      if (regiao_id) {
        params.push(regiao_id);
        where += ` AND p.regiao_id = $${params.length}`;
      }

      const result = await pool.query(`
        SELECT p.id, p.cod_profissional, p.regiao_id, p.nome_cliente,
               p.latitude, p.longitude, p.status, p.confianca_ia,
               p.match_google, p.endereco_formatado, p.motivo_rejeicao,
               p.analisado_em, p.criado_em,
               CASE WHEN p.foto_base64 IS NOT NULL THEN true ELSE false END AS tem_foto,
               r.nome AS regiao_nome,
               u.full_name AS motoboy_nome
        FROM coleta_enderecos_pendentes p
        LEFT JOIN coleta_regioes r ON r.id = p.regiao_id
        LEFT JOIN users u ON u.cod_profissional = p.cod_profissional
        WHERE ${where}
        ORDER BY p.criado_em DESC
        LIMIT 100
      `, params);

      // Backfill: itens antigos criados sem endereco_formatado → resolve agora.
      // Rodado em paralelo, fire & forget pra não travar a resposta — no próximo
      // reload já aparece populado no DB. Mas já devolvemos pro frontend o valor
      // resolvido nesta resposta.
      const linhas = result.rows;
      const semEndereco = linhas.filter(l => !l.endereco_formatado);
      if (semEndereco.length > 0) {
        await Promise.all(semEndereco.map(async (l) => {
          try {
            const end = await reverseGeocode(pool, l.latitude, l.longitude);
            if (end) {
              l.endereco_formatado = end;
              pool.query(
                `UPDATE coleta_enderecos_pendentes SET endereco_formatado = $1 WHERE id = $2`,
                [end, l.id]
              ).catch(() => {});
            }
          } catch (e) { /* silent */ }
        }));
      }

      res.json(linhas);
    } catch (err) {
      console.error('❌ Erro ao listar fila:', err);
      res.status(500).json({ error: 'Erro ao listar fila' });
    }
  });

  // Retorna a foto base64 de um item da fila (endpoint separado pra não pesar a lista)
  router.get('/admin/coleta/fila/:id/foto', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT foto_base64 FROM coleta_enderecos_pendentes WHERE id = $1',
        [req.params.id]
      );
      if (result.rows.length === 0 || !result.rows[0].foto_base64) {
        return res.status(404).json({ error: 'Sem foto' });
      }
      res.json({ foto: result.rows[0].foto_base64 });
    } catch (err) {
      console.error('❌ Erro ao buscar foto:', err);
      res.status(500).json({ error: 'Erro ao buscar foto' });
    }
  });

  // Aprovar manualmente (admin pode editar nome/coords antes de aprovar)
  router.post('/admin/coleta/fila/:id/aprovar', verificarToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { nome_cliente_editado, latitude_editada, longitude_editada } = req.body || {};
      console.log(`[coleta-aprovar] id=${id} admin=${req.user?.codProfissional || 'sem-cod'}`);
      await client.query('BEGIN');

      // Buscar pendente + região + grupo
      const pendente = await client.query(`
        SELECT p.*, r.grupo_enderecos_id, r.cidade, r.uf
        FROM coleta_enderecos_pendentes p
        LEFT JOIN coleta_regioes r ON r.id = p.regiao_id
        WHERE p.id = $1 FOR UPDATE
      `, [id]);
      if (pendente.rows.length === 0) {
        await client.query('ROLLBACK');
        console.log(`[coleta-aprovar] pendente ${id} não encontrado`);
        return res.status(404).json({ error: 'Pendente não encontrado' });
      }
      const p = pendente.rows[0];
      console.log(`[coleta-aprovar] pendente encontrado: status=${p.status} grupo=${p.grupo_enderecos_id} cidade=${p.cidade}`);
      if (p.status === 'aprovado') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Já aprovado' });
      }
      if (!p.grupo_enderecos_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Região não tem grupo de endereços vinculado' });
      }

      const nomeFinal = (nome_cliente_editado || p.nome_cliente || '').trim().toUpperCase();
      const latFinal = latitude_editada || p.latitude;
      const lngFinal = longitude_editada || p.longitude;
      const enderecoFinal = p.endereco_formatado || '';
      console.log(`[coleta-aprovar] insert fav: nome=${nomeFinal} lat=${latFinal} lng=${lngFinal} end=${enderecoFinal?.slice(0,50)}`);

      // Criar registro em solicitacao_favoritos com grupo_enderecos_id da região.
      // cliente_id fica null (é da base colaborativa, não pertence a um cliente específico).
      const favorito = await client.query(`
        INSERT INTO solicitacao_favoritos (
          cliente_id, grupo_enderecos_id, apelido, endereco_completo,
          cidade, uf, latitude, longitude
        ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [p.grupo_enderecos_id, nomeFinal, enderecoFinal, p.cidade, p.uf, latFinal, lngFinal]);
      const favoritoId = favorito.rows[0].id;
      console.log(`[coleta-aprovar] favorito criado: id=${favoritoId}`);

      // Atualizar pendente
      await client.query(`
        UPDATE coleta_enderecos_pendentes SET
          status = 'aprovado',
          endereco_gerado_id = $1,
          finalizado_em = CURRENT_TIMESTAMP,
          finalizado_por_admin = $2,
          foto_base64 = NULL
        WHERE id = $3
      `, [favoritoId, req.user?.codProfissional || 'admin', id]);

      // Confirmar ganho (previsto → confirmado)
      await client.query(`
        UPDATE coleta_motoboy_ganhos
        SET status = 'confirmado', atualizado_em = CURRENT_TIMESTAMP
        WHERE endereco_pendente_id = $1
      `, [id]);

      await client.query('COMMIT');
      res.json({ sucesso: true, favorito_id: favoritoId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('❌ Erro ao aprovar:', err);
      res.status(500).json({ error: 'Erro ao aprovar', details: err.message, code: err.code });
    } finally {
      client.release();
    }
  });

  // Rejeitar manualmente (motivo obrigatório). Remove ganho previsto.
  router.post('/admin/coleta/fila/:id/rejeitar', verificarToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { motivo } = req.body || {};
      if (!motivo || !motivo.trim()) return res.status(400).json({ error: 'Motivo é obrigatório' });

      await client.query('BEGIN');

      const pendente = await client.query(
        'SELECT status FROM coleta_enderecos_pendentes WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (pendente.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Pendente não encontrado' });
      }
      if (pendente.rows[0].status === 'aprovado') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Não é possível rejeitar um já aprovado' });
      }

      await client.query(`
        UPDATE coleta_enderecos_pendentes SET
          status = 'rejeitado',
          motivo_rejeicao = $1,
          finalizado_em = CURRENT_TIMESTAMP,
          finalizado_por_admin = $2,
          foto_base64 = NULL
        WHERE id = $3
      `, [motivo.trim(), req.user?.codProfissional || 'admin', id]);

      // Remove ganho associado (motoboy não ganha por endereço rejeitado)
      await client.query(
        'DELETE FROM coleta_motoboy_ganhos WHERE endereco_pendente_id = $1',
        [id]
      );

      await client.query('COMMIT');
      res.json({ sucesso: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('❌ Erro ao rejeitar:', err);
      res.status(500).json({ error: 'Erro ao rejeitar' });
    } finally {
      client.release();
    }
  });

  // ==================== DASHBOARD / ESTATÍSTICAS ====================

  router.get('/admin/coleta/stats', verificarToken, async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'aprovado') AS total_aprovados,
          COUNT(*) FILTER (WHERE status = 'validacao_manual') AS total_fila,
          COUNT(*) FILTER (WHERE status = 'rejeitado') AS total_rejeitados,
          COUNT(DISTINCT cod_profissional) FILTER (WHERE status = 'aprovado') AS motoboys_ativos
        FROM coleta_enderecos_pendentes
      `);
      const ganhos = await pool.query(`
        SELECT
          COALESCE(SUM(valor) FILTER (WHERE status = 'confirmado'), 0) AS total_confirmado,
          COALESCE(SUM(valor) FILTER (WHERE status = 'previsto'), 0) AS total_previsto,
          COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) AS total_pago
        FROM coleta_motoboy_ganhos
      `);
      res.json({ ...stats.rows[0], ...ganhos.rows[0] });
    } catch (err) {
      console.error('❌ Erro ao buscar stats:', err);
      res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
  });

  return router;
}

module.exports = { createColetaAdminRoutes };
