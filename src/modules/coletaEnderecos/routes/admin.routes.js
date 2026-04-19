/**
 * Sub-Router: Coleta de Endereços - ADMIN
 *
 * Endpoints pra gerenciar regiões, vincular motoboys e revisar a fila de
 * endereços que caíram em validação manual (IA não teve confiança suficiente).
 *
 * Todos os endpoints exigem JWT válido via `verificarToken`.
 */
const express = require('express');

function createColetaAdminRoutes(pool, verificarToken) {
  const router = express.Router();

  // ==================== REGIÕES ====================

  // Lista regiões com contadores de motoboys vinculados e endereços já cadastrados
  router.get('/admin/coleta/regioes', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT r.*,
          g.nome AS grupo_nome,
          COUNT(DISTINCT mr.cod_profissional) FILTER (WHERE mr.ativo = true) AS total_motoboys,
          COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'aprovado') AS total_aprovados,
          COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'validacao_manual') AS total_pendentes
        FROM coleta_regioes r
        LEFT JOIN grupos_enderecos g ON g.id = r.grupo_enderecos_id
        LEFT JOIN coleta_motoboy_regioes mr ON mr.regiao_id = r.id
        LEFT JOIN coleta_enderecos_pendentes p ON p.regiao_id = r.id
        GROUP BY r.id, g.nome
        ORDER BY r.nome
      `);
      res.json(result.rows);
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

  // ==================== VÍNCULO MOTOBOY × REGIÃO ====================

  // Lista motoboys vinculados a uma região
  router.get('/admin/coleta/regioes/:id/motoboys', verificarToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT mr.*, u.full_name
        FROM coleta_motoboy_regioes mr
        LEFT JOIN users u ON u.cod_profissional = mr.cod_profissional
        WHERE mr.regiao_id = $1
        ORDER BY u.full_name NULLS LAST, mr.cod_profissional
      `, [req.params.id]);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao listar vínculos:', err);
      res.status(500).json({ error: 'Erro ao listar vínculos' });
    }
  });

  // Adicionar motoboy à região (idempotente)
  router.post('/admin/coleta/regioes/:id/motoboys', verificarToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { cod_profissional } = req.body;
      if (!cod_profissional) return res.status(400).json({ error: 'cod_profissional é obrigatório' });

      // Valida se o motoboy existe
      const user = await pool.query('SELECT id FROM users WHERE LOWER(cod_profissional) = LOWER($1)', [cod_profissional]);
      if (user.rows.length === 0) return res.status(404).json({ error: 'Motoboy não encontrado' });

      await pool.query(`
        INSERT INTO coleta_motoboy_regioes (cod_profissional, regiao_id, ativo)
        VALUES ($1, $2, true)
        ON CONFLICT (cod_profissional, regiao_id) DO UPDATE SET ativo = true
      `, [cod_profissional.trim(), id]);
      res.json({ sucesso: true });
    } catch (err) {
      console.error('❌ Erro ao vincular motoboy:', err);
      res.status(500).json({ error: 'Erro ao vincular motoboy' });
    }
  });

  // Remover motoboy da região (desvincula fisicamente)
  router.delete('/admin/coleta/regioes/:regiao_id/motoboys/:cod', verificarToken, async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM coleta_motoboy_regioes WHERE regiao_id = $1 AND cod_profissional = $2',
        [req.params.regiao_id, req.params.cod]
      );
      res.json({ sucesso: true });
    } catch (err) {
      console.error('❌ Erro ao desvincular motoboy:', err);
      res.status(500).json({ error: 'Erro ao desvincular motoboy' });
    }
  });

  // Busca motoboys pra autocomplete no modal de vínculo (role = 'user')
  router.get('/admin/coleta/motoboys-disponiveis', verificarToken, async (req, res) => {
    try {
      const { q } = req.query;
      const termo = `%${(q || '').trim()}%`;
      const result = await pool.query(`
        SELECT cod_profissional, full_name, role
        FROM users
        WHERE role = 'user'
          AND ($1 = '%%' OR cod_profissional ILIKE $1 OR full_name ILIKE $1)
        ORDER BY full_name NULLS LAST
        LIMIT 30
      `, [termo]);
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Erro ao buscar motoboys:', err);
      res.status(500).json({ error: 'Erro ao buscar motoboys' });
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
      res.json(result.rows);
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
        return res.status(404).json({ error: 'Pendente não encontrado' });
      }
      const p = pendente.rows[0];
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
      res.status(500).json({ error: 'Erro ao aprovar' });
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
