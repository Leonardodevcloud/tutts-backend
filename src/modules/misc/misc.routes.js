/**
 * MÓDULO MISC - Routes
 * 6 endpoints: relatórios-diários
 */

const express = require('express');

function createMiscRouter(pool, verificarToken) {
  const router = express.Router();

  // Aplicar verificarToken apenas a rotas deste módulo (não bloquear outros módulos)
  router.use((req, res, next) => {
    if (req.path.startsWith('/relatorios-diarios')) {
      if (verificarToken) return verificarToken(req, res, next);
    }
    next();
  });

// ===== RELATÓRIOS DIÁRIOS =====
// Criar tabela se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS relatorios_diarios (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL,
    conteudo TEXT,
    usuario_id VARCHAR(100),
    usuario_nome VARCHAR(255),
    usuario_foto TEXT,
    imagem_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.log('Tabela relatorios_diarios já existe ou erro:', err.message));

// Criar tabela de visualizações
pool.query(`
  CREATE TABLE IF NOT EXISTS relatorios_visualizacoes (
    id SERIAL PRIMARY KEY,
    relatorio_id INTEGER NOT NULL REFERENCES relatorios_diarios(id) ON DELETE CASCADE,
    usuario_id VARCHAR(100) NOT NULL,
    usuario_nome VARCHAR(255),
    usuario_foto TEXT,
    visualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(relatorio_id, usuario_id)
  )
`).catch(err => console.log('Tabela relatorios_visualizacoes já existe ou erro:', err.message));

// Listar relatórios diários com visualizações (todos)
router.get('/relatorios-diarios', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        r.*,
        COALESCE(
          json_agg(
            json_build_object(
              'usuario_id', rv.usuario_id,
              'usuario_nome', rv.usuario_nome,
              'usuario_foto', rv.usuario_foto,
              'visualizado_em', rv.visualizado_em
            )
          ) FILTER (WHERE rv.id IS NOT NULL),
          '[]'
        ) as visualizacoes
      FROM relatorios_diarios r
      LEFT JOIN relatorios_visualizacoes rv ON r.id = rv.relatorio_id
      GROUP BY r.id
      ORDER BY r.created_at DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao listar relatórios:', err);
    res.status(500).json({ error: 'Erro ao listar relatórios' });
  }
});

// Buscar relatórios não lidos por um usuário
router.get('/relatorios-diarios/nao-lidos/:usuario_id', async (req, res) => {
  try {
    const { usuario_id } = req.params;
    
    const result = await pool.query(`
      SELECT r.* 
      FROM relatorios_diarios r
      WHERE NOT EXISTS (
        SELECT 1 FROM relatorios_visualizacoes rv 
        WHERE rv.relatorio_id = r.id AND rv.usuario_id = $1
      )
      AND r.usuario_id != $1
      ORDER BY r.created_at DESC
    `, [usuario_id]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Erro ao buscar relatórios não lidos:', err);
    res.status(500).json({ error: 'Erro ao buscar relatórios não lidos' });
  }
});

// Marcar relatório como lido
router.post('/relatorios-diarios/:id/visualizar', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_id, usuario_nome, usuario_foto } = req.body;
    
    if (!usuario_id) {
      return res.status(400).json({ error: 'usuario_id é obrigatório' });
    }
    
    // Inserir ou ignorar se já existe
    await pool.query(`
      INSERT INTO relatorios_visualizacoes (relatorio_id, usuario_id, usuario_nome, usuario_foto)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (relatorio_id, usuario_id) DO NOTHING
    `, [id, usuario_id, usuario_nome, usuario_foto]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao marcar como lido:', err);
    res.status(500).json({ error: 'Erro ao marcar como lido' });
  }
});

// Criar relatório diário
router.post('/relatorios-diarios', async (req, res) => {
  try {
    const { titulo, conteudo, usuario_id, usuario_nome, usuario_foto, imagem_base64 } = req.body;
    
    if (!titulo) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    
    const result = await pool.query(`
      INSERT INTO relatorios_diarios (titulo, conteudo, usuario_id, usuario_nome, usuario_foto, imagem_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [titulo, conteudo || '', usuario_id, usuario_nome, usuario_foto, imagem_base64 || null]);
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao criar relatório:', err);
    res.status(500).json({ error: 'Erro ao criar relatório' });
  }
});

// Atualizar relatório diário
router.put('/relatorios-diarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, conteudo, imagem_base64 } = req.body;
    
    if (!titulo) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    
    let updateQuery, params;
    
    if (imagem_base64) {
      updateQuery = `
        UPDATE relatorios_diarios 
        SET titulo = $1, conteudo = $2, imagem_url = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *
      `;
      params = [titulo, conteudo || '', imagem_base64, id];
    } else {
      updateQuery = `
        UPDATE relatorios_diarios 
        SET titulo = $1, conteudo = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `;
      params = [titulo, conteudo || '', id];
    }
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar relatório:', err);
    res.status(500).json({ error: 'Erro ao atualizar relatório' });
  }
});

// Excluir relatório diário
router.delete('/relatorios-diarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM relatorios_diarios WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }
    
    res.json({ success: true, message: 'Relatório excluído' });
  } catch (err) {
    console.error('❌ Erro ao excluir relatório:', err);
    res.status(500).json({ error: 'Erro ao excluir relatório' });
  }
});


  // ═══════════════════════════════════════════════════════════════════════
  // TELEMETRIA: /diag/foto-crash (PÚBLICO, sem auth)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Endpoint chamado pelo frontend ao detectar que a sessão anterior fechou
  // durante processamento de foto (OOM kill em mobile fraco). Permite
  // identificar QUAIS aparelhos crasham pra ajustarmos limites por tipo.
  //
  // Sem auth porque o crash pode ter deslogado o user. Rate-limit inline
  // (1 por IP a cada 10s) pra evitar abuso. Body é pequeno (<1KB).
  //
  // Frontend envia:
  //   { when, idadeMs, fileSize, fileType, deviceMemory, userAgent, platform }
  //
  const _crashRateLimit = new Map(); // ip → lastSubmissionMs
  const _CRASH_RL_WINDOW_MS = 10_000;

  router.post('/diag/foto-crash', async (req, res) => {
    try {
      // Rate limit por IP — proteção mínima
      const ip = (req.ip || req.headers['x-forwarded-for'] || 'unknown').toString().slice(0, 64);
      const now = Date.now();
      const last = _crashRateLimit.get(ip) || 0;
      if (now - last < _CRASH_RL_WINDOW_MS) {
        return res.status(429).json({ ok: false, erro: 'rate-limited' });
      }
      _crashRateLimit.set(ip, now);

      // Cleanup do map se ficar grande (memory bound)
      if (_crashRateLimit.size > 5000) {
        const cutoff = now - _CRASH_RL_WINDOW_MS;
        for (const [k, v] of _crashRateLimit.entries()) {
          if (v < cutoff) _crashRateLimit.delete(k);
        }
      }

      const b = req.body || {};
      // Validação leve — só aceita tipos esperados, descarta resto
      const idade_ms     = Number.isFinite(+b.idadeMs)     ? +b.idadeMs     : null;
      const file_size    = Number.isFinite(+b.fileSize)    ? +b.fileSize    : null;
      const device_mem   = Number.isFinite(+b.deviceMemory)? +b.deviceMemory: null;
      const when_iso     = (typeof b.when === 'string')    ? b.when.slice(0, 64)       : null;
      const file_type    = (typeof b.fileType === 'string')? b.fileType.slice(0, 64)   : null;
      const user_agent   = (typeof b.userAgent === 'string')? b.userAgent.slice(0, 500): null;
      const platform     = (typeof b.platform === 'string')? b.platform.slice(0, 64)   : null;

      // Validações de sanidade
      if (idade_ms !== null && (idade_ms < 0 || idade_ms > 24 * 3600 * 1000)) {
        return res.status(400).json({ ok: false, erro: 'idade_ms inválida' });
      }
      if (file_size !== null && (file_size < 0 || file_size > 100 * 1024 * 1024)) {
        return res.status(400).json({ ok: false, erro: 'file_size inválido' });
      }

      await pool.query(`
        INSERT INTO foto_crash_logs
          (when_iso, idade_ms, file_size, file_type, device_memory, user_agent, platform, ip)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [when_iso, idade_ms, file_size, file_type, device_mem, user_agent, platform, ip]);

      console.log(
        `📊 [foto-crash] reportado: file=${file_size}b type=${file_type} ` +
        `mem=${device_mem}GB idade=${Math.round((idade_ms||0)/1000)}s ` +
        `ua="${(user_agent||'').slice(0, 80)}"`
      );

      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Erro em /diag/foto-crash:', err);
      // Não expõe detalhe do erro pro cliente — endpoint público
      res.status(500).json({ ok: false });
    }
  });

  // Endpoint admin: listar últimos crashes (com auth — só admin lê telemetria)
  router.get('/diag/foto-crash', async (req, res, next) => {
    // Auth manual aqui porque o middleware do topo só pega /relatorios-diarios
    if (verificarToken) {
      return verificarToken(req, res, async () => {
        try {
          // Só admin lê telemetria
          const role = req.user?.role;
          if (role !== 'admin' && role !== 'admin_master') {
            return res.status(403).json({ erro: 'Apenas admin pode ler telemetria' });
          }

          const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
          const result = await pool.query(`
            SELECT id, criado_em, when_iso, idade_ms, file_size, file_type,
                   device_memory, user_agent, platform, ip
            FROM foto_crash_logs
            ORDER BY criado_em DESC
            LIMIT $1
          `, [limit]);

          // Estatísticas resumidas
          const stats = await pool.query(`
            SELECT
              COUNT(*)                                                   AS total,
              COUNT(*) FILTER (WHERE criado_em > NOW() - INTERVAL '24h') AS ultimas_24h,
              COUNT(*) FILTER (WHERE criado_em > NOW() - INTERVAL '7d')  AS ultimos_7d,
              ROUND(AVG(file_size)::numeric, 0)                          AS file_size_avg,
              MAX(file_size)                                             AS file_size_max,
              ROUND(AVG(device_memory)::numeric, 2)                      AS device_memory_avg
            FROM foto_crash_logs
            WHERE criado_em > NOW() - INTERVAL '30d'
          `);

          res.json({
            ok: true,
            stats: stats.rows[0],
            registros: result.rows,
          });
        } catch (err) {
          console.error('❌ Erro ao listar foto-crash:', err);
          res.status(500).json({ erro: 'Erro ao listar' });
        }
      });
    }
    res.status(401).json({ erro: 'Auth indisponível' });
  });

  return router;
}

module.exports = { createMiscRouter };
