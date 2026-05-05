/**
 * MÓDULO FEEDBACK - Routes
 *
 * Endpoints (todos protegidos por verificarToken + verificarAdmin):
 *
 *   GET    /feedback/itens?tipo=roadmap|bug|sugestao&status=...   → lista
 *   GET    /feedback/contadores                                    → KPIs (3 tipos x status)
 *   GET    /feedback/itens/:id                                     → detalhe + anexos meta
 *   POST   /feedback/itens                                         → criar
 *   PUT    /feedback/itens/:id                                     → atualizar campos
 *   DELETE /feedback/itens/:id                                     → deletar (cascade anexos)
 *   POST   /feedback/itens/:id/transicao                           → mudar status (com regras)
 *   POST   /feedback/itens/:id/aceitar-sugestao                    → atalho: vira roadmap
 *
 *   POST   /feedback/itens/:id/anexos                              → upload (base64 no body)
 *   GET    /feedback/anexos/:anexoId                               → download
 *   DELETE /feedback/anexos/:anexoId                               → remover
 *
 * Toda mutação registra auditoria. Validações e CHECK constraints no banco
 * protegem contra estados inválidos mesmo se o front mandar coisa errada.
 */

const express = require('express');

const STATUS_VALIDOS = {
  roadmap: ['em_avaliacao', 'planejado', 'em_desenvolvimento', 'concluido', 'cancelado'],
  bug: ['aberto', 'em_correcao', 'resolvido', 'nao_reproduzivel'],
  sugestao: ['pendente', 'aceita', 'recusada'],
};
const TIPOS_VALIDOS = ['roadmap', 'bug', 'sugestao'];
const GRAVIDADE_VALIDA = ['baixo', 'medio', 'critico'];
const PRIORIDADE_VALIDA = ['baixa', 'media', 'alta'];

const MAX_ANEXO_BYTES = 5 * 1024 * 1024; // 5MB (já decodificado de base64)
const MIMES_ANEXO_PERMITIDOS = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf', 'text/plain'];

function createFeedbackRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();

  // ============================================================
  // GET /feedback/contadores — KPIs pra header
  // ============================================================
  router.get('/contadores', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const r = await pool.query(`
        SELECT tipo, status, COUNT(*)::int AS total
        FROM feedback_items
        GROUP BY tipo, status
      `);
      // Estruturar como { roadmap: {em_avaliacao: 4, planejado: 5, ...}, bug: {...}, sugestao: {...} }
      const out = { roadmap: {}, bug: {}, sugestao: {} };
      for (const tipo of TIPOS_VALIDOS) {
        for (const st of STATUS_VALIDOS[tipo]) out[tipo][st] = 0;
      }
      r.rows.forEach(row => {
        if (out[row.tipo]) out[row.tipo][row.status] = row.total;
      });
      res.json({ success: true, contadores: out });
    } catch (error) {
      console.error('❌ Erro contadores feedback:', error);
      res.status(500).json({ error: 'Erro ao carregar contadores' });
    }
  });

  // ============================================================
  // GET /feedback/itens?tipo=...&status=...
  // ============================================================
  router.get('/itens', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { tipo, status, modulo } = req.query;
      if (tipo && !TIPOS_VALIDOS.includes(tipo)) {
        return res.status(400).json({ error: 'tipo inválido' });
      }
      const where = [];
      const params = [];
      let idx = 1;
      if (tipo)    { where.push(`tipo = $${idx++}`);    params.push(tipo); }
      if (status)  { where.push(`status = $${idx++}`);  params.push(status); }
      if (modulo)  { where.push(`modulo = $${idx++}`);  params.push(modulo); }
      const sql = `
        SELECT i.*,
          (SELECT COUNT(*)::int FROM feedback_anexos a WHERE a.item_id = i.id) AS anexos_count
        FROM feedback_items i
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY
          CASE i.status
            WHEN 'em_desenvolvimento' THEN 1
            WHEN 'em_correcao' THEN 1
            WHEN 'aberto' THEN 2
            WHEN 'planejado' THEN 3
            WHEN 'pendente' THEN 3
            WHEN 'em_avaliacao' THEN 4
            WHEN 'aceita' THEN 5
            WHEN 'concluido' THEN 6
            WHEN 'resolvido' THEN 6
            WHEN 'cancelado' THEN 7
            WHEN 'recusada' THEN 7
            WHEN 'nao_reproduzivel' THEN 7
            ELSE 8
          END,
          i.created_at DESC
      `;
      const r = await pool.query(sql, params);
      res.json({ success: true, itens: r.rows });
    } catch (error) {
      console.error('❌ Erro listar feedback itens:', error);
      res.status(500).json({ error: 'Erro ao listar itens' });
    }
  });

  // ============================================================
  // GET /feedback/itens/:id — detalhe + lista de anexos (sem conteúdo)
  // ============================================================
  router.get('/itens/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
      const item = await pool.query('SELECT * FROM feedback_items WHERE id = $1', [id]);
      if (item.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado' });
      const anexos = await pool.query(
        `SELECT id, nome_arquivo, mime_type, tamanho_bytes, created_at
         FROM feedback_anexos WHERE item_id = $1 ORDER BY created_at ASC`, [id]
      );
      res.json({ success: true, item: item.rows[0], anexos: anexos.rows });
    } catch (error) {
      console.error('❌ Erro detalhe feedback:', error);
      res.status(500).json({ error: 'Erro ao buscar detalhe' });
    }
  });

  // ============================================================
  // POST /feedback/itens — criar
  // ============================================================
  router.post('/itens', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const { tipo, titulo, descricao, modulo, gravidade, prioridade, data_prevista, status } = req.body || {};

      if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
        return res.status(400).json({ error: 'tipo inválido (roadmap/bug/sugestao)' });
      }
      const tituloLimpo = (typeof titulo === 'string' ? titulo : '').trim();
      if (tituloLimpo.length < 3) return res.status(400).json({ error: 'titulo precisa ter ao menos 3 caracteres' });
      if (tituloLimpo.length > 255) return res.status(400).json({ error: 'titulo muito longo (máx 255)' });

      // Status default por tipo (se não vier explícito)
      const statusInicial = status || (tipo === 'bug' ? 'aberto' : tipo === 'sugestao' ? 'pendente' : 'em_avaliacao');
      if (!STATUS_VALIDOS[tipo].includes(statusInicial)) {
        return res.status(400).json({ error: `status '${statusInicial}' não é válido para tipo '${tipo}'` });
      }

      // Gravidade só faz sentido em bug
      if (gravidade && !GRAVIDADE_VALIDA.includes(gravidade)) {
        return res.status(400).json({ error: 'gravidade inválida' });
      }
      const gravFinal = tipo === 'bug' ? (gravidade || 'medio') : null;

      // Prioridade só em roadmap (sugestao/bug não usam)
      if (prioridade && !PRIORIDADE_VALIDA.includes(prioridade)) {
        return res.status(400).json({ error: 'prioridade inválida' });
      }
      const prioridadeFinal = tipo === 'roadmap' ? (prioridade || 'media') : null;

      // Data prevista só em roadmap
      const dataPrevistaFinal = tipo === 'roadmap' && data_prevista ? data_prevista : null;

      const r = await pool.query(`
        INSERT INTO feedback_items (
          tipo, titulo, descricao, modulo,
          status, gravidade, prioridade, data_prevista,
          created_by_cod, created_by_nome, updated_by_cod, updated_by_nome
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $10)
        RETURNING *
      `, [
        tipo, tituloLimpo, (descricao || '').slice(0, 5000) || null,
        (modulo || '').slice(0, 50) || null,
        statusInicial, gravFinal, prioridadeFinal, dataPrevistaFinal,
        req.user.codProfissional, req.user.nome
      ]);

      res.status(201).json({ success: true, item: r.rows[0] });

      registrarAuditoria(req, 'FEEDBACK_CRIAR', 'feedback', 'feedback_items', r.rows[0].id,
        { tipo, titulo: tituloLimpo, status: statusInicial }).catch(() => {});

    } catch (error) {
      console.error('❌ Erro criar feedback:', error);
      res.status(500).json({ error: 'Erro ao criar item' });
    }
  });

  // ============================================================
  // PUT /feedback/itens/:id — atualizar (não muda status — pra isso usar /transicao)
  // ============================================================
  router.put('/itens/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

      const atual = await pool.query('SELECT * FROM feedback_items WHERE id = $1', [id]);
      if (atual.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado' });
      const itemAtual = atual.rows[0];

      const { titulo, descricao, modulo, gravidade, prioridade, data_prevista } = req.body || {};

      // Só atualiza campos que vieram no body (PATCH-like)
      const updates = [];
      const params = [];
      let idx = 1;

      if (titulo !== undefined) {
        const t = String(titulo).trim();
        if (t.length < 3 || t.length > 255) return res.status(400).json({ error: 'titulo entre 3 e 255 chars' });
        updates.push(`titulo = $${idx++}`); params.push(t);
      }
      if (descricao !== undefined) {
        updates.push(`descricao = $${idx++}`);
        params.push(typeof descricao === 'string' ? descricao.slice(0, 5000) : null);
      }
      if (modulo !== undefined) {
        updates.push(`modulo = $${idx++}`);
        params.push(modulo ? String(modulo).slice(0, 50) : null);
      }
      // Gravidade só pra bug
      if (gravidade !== undefined && itemAtual.tipo === 'bug') {
        if (gravidade && !GRAVIDADE_VALIDA.includes(gravidade)) return res.status(400).json({ error: 'gravidade inválida' });
        updates.push(`gravidade = $${idx++}`); params.push(gravidade || 'medio');
      }
      // Prioridade só pra roadmap
      if (prioridade !== undefined && itemAtual.tipo === 'roadmap') {
        if (prioridade && !PRIORIDADE_VALIDA.includes(prioridade)) return res.status(400).json({ error: 'prioridade inválida' });
        updates.push(`prioridade = $${idx++}`); params.push(prioridade || 'media');
      }
      // Data prevista só pra roadmap
      if (data_prevista !== undefined && itemAtual.tipo === 'roadmap') {
        updates.push(`data_prevista = $${idx++}`);
        params.push(data_prevista || null);
      }

      if (updates.length === 0) return res.status(400).json({ error: 'Nada pra atualizar' });

      updates.push(`updated_at = NOW()`);
      updates.push(`updated_by_cod = $${idx++}`); params.push(req.user.codProfissional);
      updates.push(`updated_by_nome = $${idx++}`); params.push(req.user.nome);
      params.push(id);

      const r = await pool.query(
        `UPDATE feedback_items SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        params
      );

      res.json({ success: true, item: r.rows[0] });

      registrarAuditoria(req, 'FEEDBACK_EDITAR', 'feedback', 'feedback_items', id,
        { campos_alterados: Object.keys(req.body || {}) }).catch(() => {});

    } catch (error) {
      console.error('❌ Erro editar feedback:', error);
      res.status(500).json({ error: 'Erro ao atualizar item' });
    }
  });

  // ============================================================
  // POST /feedback/itens/:id/transicao — mudar status (com regras)
  // ============================================================
  router.post('/itens/:id/transicao', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

      const { novo_status, motivo_recusa } = req.body || {};
      const item = await pool.query('SELECT * FROM feedback_items WHERE id = $1', [id]);
      if (item.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado' });
      const it = item.rows[0];

      if (!STATUS_VALIDOS[it.tipo].includes(novo_status)) {
        return res.status(400).json({ error: `status '${novo_status}' não válido para tipo '${it.tipo}'` });
      }

      // Marca concluido_at se for status terminal
      const statusTerminais = ['concluido','cancelado','resolvido','nao_reproduzivel','recusada'];
      const ehTerminal = statusTerminais.includes(novo_status);

      // Motivo de recusa só pra sugestao→recusada (validação amigável)
      const motivoFinal = (it.tipo === 'sugestao' && novo_status === 'recusada')
        ? (typeof motivo_recusa === 'string' ? motivo_recusa.trim().slice(0, 500) : null)
        : null;

      const r = await pool.query(`
        UPDATE feedback_items
        SET status = $1,
            concluido_at = CASE WHEN $2::boolean THEN COALESCE(concluido_at, NOW()) ELSE NULL END,
            motivo_recusa = COALESCE($3, motivo_recusa),
            updated_at = NOW(),
            updated_by_cod = $4,
            updated_by_nome = $5
        WHERE id = $6
        RETURNING *
      `, [novo_status, ehTerminal, motivoFinal, req.user.codProfissional, req.user.nome, id]);

      res.json({ success: true, item: r.rows[0] });

      registrarAuditoria(req, 'FEEDBACK_TRANSICAO', 'feedback', 'feedback_items', id,
        { de: it.status, para: novo_status, motivo: motivoFinal }).catch(() => {});

    } catch (error) {
      console.error('❌ Erro transicao feedback:', error);
      res.status(500).json({ error: 'Erro na transição' });
    }
  });

  // ============================================================
  // POST /feedback/itens/:id/aceitar-sugestao — atalho que vira roadmap
  // ============================================================
  router.post('/itens/:id/aceitar-sugestao', verificarToken, verificarAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

      await client.query('BEGIN');
      const itemRes = await client.query('SELECT * FROM feedback_items WHERE id = $1 FOR UPDATE', [id]);
      if (itemRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Item não encontrado' });
      }
      const it = itemRes.rows[0];
      if (it.tipo !== 'sugestao') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Só sugestões podem ser aceitas com este endpoint' });
      }
      if (it.status !== 'pendente') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Sugestão não está pendente (status atual: ${it.status})` });
      }

      // 1) Marcar sugestão como aceita
      await client.query(`
        UPDATE feedback_items
        SET status = 'aceita', concluido_at = NOW(), updated_at = NOW(),
            updated_by_cod = $1, updated_by_nome = $2
        WHERE id = $3
      `, [req.user.codProfissional, req.user.nome, id]);

      // 2) Criar item roadmap referenciando a sugestão original
      const novoRoadmap = await client.query(`
        INSERT INTO feedback_items (
          tipo, titulo, descricao, modulo, status, prioridade, origem_sugestao_id,
          created_by_cod, created_by_nome, updated_by_cod, updated_by_nome
        ) VALUES ('roadmap', $1, $2, $3, 'em_avaliacao', 'media', $4, $5, $6, $5, $6)
        RETURNING *
      `, [
        it.titulo, it.descricao, it.modulo, id,
        req.user.codProfissional, req.user.nome
      ]);

      await client.query('COMMIT');

      res.json({ success: true, sugestao_id: id, roadmap_id: novoRoadmap.rows[0].id, roadmap_item: novoRoadmap.rows[0] });

      registrarAuditoria(req, 'FEEDBACK_ACEITAR_SUGESTAO', 'feedback', 'feedback_items', id,
        { roadmap_id: novoRoadmap.rows[0].id }).catch(() => {});

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch(_) {}
      console.error('❌ Erro aceitar sugestao:', error);
      res.status(500).json({ error: 'Erro ao aceitar sugestão' });
    } finally {
      client.release();
    }
  });

  // ============================================================
  // DELETE /feedback/itens/:id
  // ============================================================
  router.delete('/itens/:id', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
      const r = await pool.query('DELETE FROM feedback_items WHERE id = $1 RETURNING tipo, titulo', [id]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado' });
      res.json({ success: true });
      registrarAuditoria(req, 'FEEDBACK_DELETAR', 'feedback', 'feedback_items', id,
        { tipo: r.rows[0].tipo, titulo: r.rows[0].titulo }).catch(() => {});
    } catch (error) {
      console.error('❌ Erro deletar feedback:', error);
      res.status(500).json({ error: 'Erro ao deletar' });
    }
  });

  // ============================================================
  // POST /feedback/itens/:id/anexos — upload base64
  // Body: { nome_arquivo, mime_type, conteudo_base64 }
  // ============================================================
  router.post('/itens/:id/anexos', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

      const { nome_arquivo, mime_type, conteudo_base64 } = req.body || {};
      if (!nome_arquivo || !mime_type || !conteudo_base64) {
        return res.status(400).json({ error: 'nome_arquivo, mime_type e conteudo_base64 obrigatórios' });
      }
      if (!MIMES_ANEXO_PERMITIDOS.includes(mime_type)) {
        return res.status(400).json({ error: 'mime_type não permitido (PNG/JPG/WebP/PDF/TXT apenas)' });
      }

      // Validar tamanho real (base64 → bytes ≈ length * 0.75)
      const tamanhoEstimado = Math.floor(conteudo_base64.length * 0.75);
      if (tamanhoEstimado > MAX_ANEXO_BYTES) {
        return res.status(413).json({ error: `Anexo muito grande (máx ${MAX_ANEXO_BYTES / 1024 / 1024}MB)` });
      }

      const item = await pool.query('SELECT id FROM feedback_items WHERE id = $1', [id]);
      if (item.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado' });

      const r = await pool.query(`
        INSERT INTO feedback_anexos (item_id, nome_arquivo, mime_type, tamanho_bytes, conteudo_base64)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, nome_arquivo, mime_type, tamanho_bytes, created_at
      `, [id, String(nome_arquivo).slice(0, 255), mime_type, tamanhoEstimado, conteudo_base64]);

      res.status(201).json({ success: true, anexo: r.rows[0] });

      registrarAuditoria(req, 'FEEDBACK_UPLOAD_ANEXO', 'feedback', 'feedback_anexos', r.rows[0].id,
        { item_id: id, nome: nome_arquivo, tamanho: tamanhoEstimado }).catch(() => {});

    } catch (error) {
      console.error('❌ Erro upload anexo:', error);
      res.status(500).json({ error: 'Erro no upload' });
    }
  });

  // ============================================================
  // GET /feedback/anexos/:anexoId — download
  // ============================================================
  router.get('/anexos/:anexoId', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.anexoId);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
      const r = await pool.query('SELECT * FROM feedback_anexos WHERE id = $1', [id]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'Anexo não encontrado' });
      const anexo = r.rows[0];
      res.json({
        success: true,
        anexo: {
          id: anexo.id, nome_arquivo: anexo.nome_arquivo, mime_type: anexo.mime_type,
          tamanho_bytes: anexo.tamanho_bytes, conteudo_base64: anexo.conteudo_base64,
          created_at: anexo.created_at
        }
      });
    } catch (error) {
      console.error('❌ Erro baixar anexo:', error);
      res.status(500).json({ error: 'Erro ao baixar' });
    }
  });

  // ============================================================
  // DELETE /feedback/anexos/:anexoId
  // ============================================================
  router.delete('/anexos/:anexoId', verificarToken, verificarAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.anexoId);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
      const r = await pool.query('DELETE FROM feedback_anexos WHERE id = $1 RETURNING item_id', [id]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'Anexo não encontrado' });
      res.json({ success: true });
      registrarAuditoria(req, 'FEEDBACK_DELETE_ANEXO', 'feedback', 'feedback_anexos', id,
        { item_id: r.rows[0].item_id }).catch(() => {});
    } catch (error) {
      console.error('❌ Erro deletar anexo:', error);
      res.status(500).json({ error: 'Erro ao deletar anexo' });
    }
  });

  return router;
}

module.exports = { createFeedbackRouter };
