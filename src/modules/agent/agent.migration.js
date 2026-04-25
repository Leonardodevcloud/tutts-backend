/**
 * MÓDULO AGENTE RPA - Migration
 * Table: ajustes_automaticos
 *
 * Fila assíncrona para correção automática de endereços via Playwright.
 * Worker processa um registro por vez a cada 10s.
 */

async function initAgentTables(pool) {
  console.log('🔧 Agent Migration v2 — ALTER individual (sem DO $$ block)');
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajustes_automaticos (
      id            SERIAL PRIMARY KEY,
      os_numero     VARCHAR(20)    NOT NULL,
      ponto         INTEGER        NOT NULL CHECK (ponto >= 2 AND ponto <= 7),
      localizacao_raw TEXT,
      latitude      DECIMAL(10, 8),
      longitude     DECIMAL(11, 8),
      motoboy_lat   DECIMAL(10, 8),
      motoboy_lng   DECIMAL(11, 8),
      foto_fachada  TEXT,
      status        VARCHAR(20)    NOT NULL DEFAULT 'pendente'
                                   CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro')),
      detalhe_erro  TEXT,
      criado_em     TIMESTAMP      DEFAULT NOW(),
      processado_em TIMESTAMP,
      validado_por  VARCHAR(100),
      validado_em   TIMESTAMP
    )
  `);

  // Adicionar colunas incrementalmente — cada uma isolada para não engolir erros
  const colunas = [
    { nome: 'motoboy_lat',        tipo: 'DECIMAL(10, 8)' },
    { nome: 'motoboy_lng',        tipo: 'DECIMAL(11, 8)' },
    { nome: 'foto_fachada',       tipo: 'TEXT' },
    { nome: 'usuario_id',         tipo: 'INTEGER' },
    { nome: 'usuario_nome',       tipo: 'VARCHAR(100)' },
    { nome: 'endereco_corrigido', tipo: 'TEXT' },
    { nome: 'endereco_antigo',    tipo: 'TEXT' },
    { nome: 'cod_profissional',   tipo: 'VARCHAR(20)' },
    { nome: 'frete_recalculado', tipo: 'BOOLEAN DEFAULT false' },
    { nome: 'ponto1_lat',        tipo: 'DECIMAL(10, 8)' },
    { nome: 'ponto1_lng',        tipo: 'DECIMAL(11, 8)' },
    { nome: 'ponto1_endereco',   tipo: 'TEXT' },
    { nome: 'endereco_antigo_lat', tipo: 'DECIMAL(10, 8)' },
    { nome: 'endereco_antigo_lng', tipo: 'DECIMAL(11, 8)' },
    { nome: 'validacao_localizacao', tipo: 'JSONB' },
    { nome: 'foto_nf',               tipo: 'TEXT' },     // base64 da NF (obrigatória pro caller)
    { nome: 'validacao_nf',          tipo: 'JSONB' },    // resultado completo: NF + Receita + cruzamento
    // 2026-04: Colunas usadas pelos agentes do pool (Etapa 1) que faltavam na migration
    { nome: 'erro',            tipo: 'TEXT' },           // mensagem de erro quando status='falhou' (usada por agent-correcao.agent.js)
    { nome: 'finalizado_em',   tipo: 'TIMESTAMP' },      // quando job terminou (sucesso ou falha)
    { nome: 'screenshot_path', tipo: 'TEXT' },           // caminho do screenshot capturado em caso de erro Playwright
    { nome: 'valores_antes', tipo: 'JSONB' },
    { nome: 'valores_depois', tipo: 'JSONB' },
    // Progresso em tempo real: atualizado pelo worker conforme Playwright avança.
    // etapa_atual codifica a fase (login/localizando/codificando/confirmando/recalculando/finalizando),
    // progresso é 0-100 — lidos pelo frontend via /agent/status/:id e exibidos na animação.
    { nome: 'etapa_atual',  tipo: 'VARCHAR(30)' },
    { nome: 'progresso',    tipo: 'SMALLINT DEFAULT 0' },
  ];

  for (const col of colunas) {
    try {
      await pool.query(`ALTER TABLE ajustes_automaticos ADD COLUMN IF NOT EXISTS ${col.nome} ${col.tipo}`);
    } catch (err) {
      console.log(`⚠️ Coluna ${col.nome}: ${err.message}`);
    }
  }

  // Índices
  const indices = [
    'CREATE INDEX IF NOT EXISTS idx_ajustes_usuario_id ON ajustes_automaticos(usuario_id)',
    'CREATE INDEX IF NOT EXISTS idx_ajustes_status_criado ON ajustes_automaticos(status, criado_em ASC)',
    'CREATE INDEX IF NOT EXISTS idx_ajustes_os_numero ON ajustes_automaticos(os_numero)',
  ];

  for (const idx of indices) {
    try {
      await pool.query(idx);
    } catch (err) {
      console.log(`⚠️ Índice: ${err.message}`);
    }
  }

  // 2026-04: Aceitar status 'falhou' (usado pelos agentes do pool — Etapa 1)
  // CHECK constraint original só aceitava 'pendente'/'processando'/'sucesso'/'erro'.
  // Idempotente: se constraint não existir ou já estiver atualizada, não quebra.
  try {
    await pool.query(`ALTER TABLE ajustes_automaticos DROP CONSTRAINT IF EXISTS ajustes_automaticos_status_check`);
    await pool.query(`
      ALTER TABLE ajustes_automaticos
      ADD CONSTRAINT ajustes_automaticos_status_check
      CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro', 'falhou'))
    `);
    console.log('✅ Constraint status atualizado (aceita "falhou")');
  } catch (err) {
    console.log(`⚠️ Constraint status: ${err.message}`);
  }

  console.log('✅ Módulo Agente RPA — tabela ajustes_automaticos verificada/criada');
}

module.exports = initAgentTables;
