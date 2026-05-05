/**
 * MÓDULO FEEDBACK - Migration
 * Tabelas: feedback_items (3 tipos: roadmap/bug/sugestao), feedback_anexos
 *
 * Decisão de design: 1 tabela só pra os 3 tipos, distinguidos pela coluna `tipo`.
 * Vantagens:
 *   - Endpoints reutilizáveis (CRUD genérico)
 *   - Conversão sugestão→roadmap é só UPDATE (não migra dados entre tabelas)
 *   - Auditoria/histórico unificados
 *
 * Os 3 tipos compartilham: titulo, descricao, modulo, status, datas, autor.
 * Diferem em: status válidos + campos específicos (gravidade só em bug,
 * prioridade/data_prevista só em roadmap).
 */

async function initFeedbackTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_items (
      id SERIAL PRIMARY KEY,
      tipo VARCHAR(20) NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      modulo VARCHAR(50),

      status VARCHAR(30) NOT NULL DEFAULT 'em_avaliacao',

      gravidade VARCHAR(20),
      prioridade VARCHAR(20) DEFAULT 'media',
      data_prevista DATE,

      origem_sugestao_id INTEGER REFERENCES feedback_items(id) ON DELETE SET NULL,
      motivo_recusa TEXT,

      created_by_cod VARCHAR(50),
      created_by_nome VARCHAR(255),
      updated_by_cod VARCHAR(50),
      updated_by_nome VARCHAR(255),

      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      concluido_at TIMESTAMP,

      CONSTRAINT feedback_items_tipo_check CHECK (tipo IN ('roadmap', 'bug', 'sugestao')),
      CONSTRAINT feedback_items_status_check CHECK (
        (tipo = 'roadmap'  AND status IN ('em_avaliacao','planejado','em_desenvolvimento','concluido','cancelado'))
        OR (tipo = 'bug'      AND status IN ('aberto','em_correcao','resolvido','nao_reproduzivel'))
        OR (tipo = 'sugestao' AND status IN ('pendente','aceita','recusada'))
      ),
      CONSTRAINT feedback_items_gravidade_check CHECK (gravidade IS NULL OR gravidade IN ('baixo','medio','critico')),
      CONSTRAINT feedback_items_prioridade_check CHECK (prioridade IS NULL OR prioridade IN ('baixa','media','alta'))
    )
  `);

  // Índices pra filtros frequentes (lista por tipo+status, ordenação por data)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_items_tipo_status ON feedback_items (tipo, status)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_items_created_at ON feedback_items (created_at DESC)`).catch(() => {});

  console.log('✅ Tabela feedback_items verificada');

  // Anexos (usado principalmente em bugs — screenshots/logs)
  // Armazenamos o conteúdo como base64 (até 5MB por arquivo) pra evitar
  // dependência de S3/Cloudinary. Tabela separada pra não inflar feedback_items.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_anexos (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      nome_arquivo VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100),
      tamanho_bytes INTEGER,
      conteudo_base64 TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_anexos_item ON feedback_anexos (item_id)`).catch(() => {});
  console.log('✅ Tabela feedback_anexos verificada');
}

module.exports = { initFeedbackTables };
