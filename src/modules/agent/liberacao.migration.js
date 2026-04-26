/**
 * liberacao.migration.js
 * Tabela liberacoes_pontos — fila de jobs do agente RPA "Liberar Ponto".
 *
 * Quando o motoboy clica "Liberar OS" no app, é inserido aqui um registro
 * que o agente liberar-ponto.agent.js (worker) processa via Playwright:
 * → faz login no sistema externo
 * → busca a OS
 * → abre menu engrenagem → "Liberar App"
 * → marca checkbox "Liberar ponto 1" (regra fixa)
 * → clica "Liberar"
 * → aguarda texto "Enviado" no #divRetornoModal
 *
 * IMPORTANTE: Sempre o Ponto 1 (regra fixa atual). Se um dia precisar
 * liberar outros, basta adicionar coluna `ponto` (default 1).
 */

'use strict';

async function initLiberacaoTables(pool) {
  // Tabela principal
  await pool.query(`
    CREATE TABLE IF NOT EXISTS liberacoes_pontos (
      id              SERIAL PRIMARY KEY,
      os_numero       VARCHAR(20) NOT NULL,
      status          VARCHAR(20) NOT NULL DEFAULT 'pendente',
      usuario_id      INTEGER,
      usuario_nome    VARCHAR(200),
      cod_profissional VARCHAR(50),
      criado_em       TIMESTAMP DEFAULT NOW(),
      finalizado_em   TIMESTAMP,
      etapa_atual     VARCHAR(50),
      progresso       SMALLINT DEFAULT 0,
      erro            TEXT,
      screenshot_path TEXT,
      mensagem_retorno TEXT
    )
  `);

  // CHECK constraint do status (idempotente — drop+create caso já exista versão antiga)
  try {
    await pool.query(`ALTER TABLE liberacoes_pontos DROP CONSTRAINT IF EXISTS liberacoes_pontos_status_check`);
    await pool.query(`
      ALTER TABLE liberacoes_pontos
      ADD CONSTRAINT liberacoes_pontos_status_check
      CHECK (status IN ('pendente', 'processando', 'sucesso', 'falhou'))
    `);
  } catch (err) {
    console.log(`⚠️ Constraint status liberacoes_pontos: ${err.message}`);
  }

  // Índices
  const indices = [
    'CREATE INDEX IF NOT EXISTS idx_liberacoes_status_criado ON liberacoes_pontos(status, criado_em ASC)',
    'CREATE INDEX IF NOT EXISTS idx_liberacoes_usuario_id ON liberacoes_pontos(usuario_id)',
    'CREATE INDEX IF NOT EXISTS idx_liberacoes_os_numero ON liberacoes_pontos(os_numero)',
  ];
  for (const idx of indices) {
    try { await pool.query(idx); }
    catch (err) { console.log(`⚠️ Índice liberacoes_pontos: ${err.message}`); }
  }

  console.log('✅ Módulo Liberar Ponto — tabela liberacoes_pontos verificada/criada');
}

module.exports = initLiberacaoTables;
