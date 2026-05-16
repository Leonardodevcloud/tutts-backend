/**
 * MÓDULO MÁQUINAS - Migration
 *
 * Tabelas:
 *  - maquinas: cadastro do parque de máquinas POR cliente
 *  - maquinas_movimentacoes: log imutável de despacho/restituição
 *
 * Coluna nova em clientes_solicitacao:
 *  - horario_limite_maquinas TIME DEFAULT '17:00'
 *    Após esse horário, máquinas ainda em campo recebem flag visual.
 *    NÃO bloqueia nada — apenas sinalização para o atendente da loja.
 *
 * O bloqueio do saque emergencial Plific é por presença de máquina em mãos,
 * independente do horário (ver maquinas.shared.js).
 */

async function initMaquinasTables(pool) {
  // Tabela 1 — cadastro de máquinas (uma por cliente_id + identificador)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maquinas (
      id SERIAL PRIMARY KEY,
      cliente_id INT NOT NULL REFERENCES clientes_solicitacao(id) ON DELETE CASCADE,
      identificador VARCHAR(50) NOT NULL,
      marca VARCHAR(80) NOT NULL,
      observacao TEXT,
      ativa BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      criada_por VARCHAR(255),
      CONSTRAINT maquinas_unique_por_cliente UNIQUE (cliente_id, identificador)
    )
  `);
  console.log('✅ Tabela maquinas verificada');

  // Tabela 2 — movimentações (log imutável)
  // Quando restituida_em IS NULL, a máquina está em campo com o motoboy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maquinas_movimentacoes (
      id SERIAL PRIMARY KEY,
      maquina_id INT NOT NULL REFERENCES maquinas(id) ON DELETE CASCADE,
      cliente_id INT NOT NULL REFERENCES clientes_solicitacao(id) ON DELETE CASCADE,
      motoboy_codigo VARCHAR(50) NOT NULL,
      motoboy_nome VARCHAR(255) NOT NULL,
      despachada_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      despachada_por VARCHAR(255),
      restituida_em TIMESTAMP,
      restituida_por VARCHAR(255),
      observacao_restituicao TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Tabela maquinas_movimentacoes verificada');

  // Índices
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_maq_cliente ON maquinas(cliente_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_maq_ativa ON maquinas(cliente_id, ativa)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_maqmov_cliente ON maquinas_movimentacoes(cliente_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_maqmov_motoboy ON maquinas_movimentacoes(motoboy_codigo)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_maqmov_maquina ON maquinas_movimentacoes(maquina_id)`).catch(() => {});
  // Índice parcial: superlativo pra query de "máquina pendente" (chamada a cada saque)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_maqmov_pendente
    ON maquinas_movimentacoes(motoboy_codigo)
    WHERE restituida_em IS NULL
  `).catch(() => {});
  console.log('✅ Índices maquinas criados');

  // 🚀 Migration 2026-05-15: cross-reference com users da Central
  // ────────────────────────────────────────────────────────────────────────
  // O `codigo` da API Tutts NÃO bate com `cod_profissional` em users (Central).
  // Solução: ao despachar, resolver pelo NOME normalizado e salvar
  // motoboy_codigo já no formato da Central.
  //
  //  - motoboy_codigo        → cod_profissional Central (quando achou) ou Tutts (fallback)
  //  - motoboy_codigo_tutts  → SEMPRE o código que veio da API Tutts (auditoria)
  //  - vinculado_central     → true se cruzou com sucesso, false caso contrário
  //
  // Quando vinculado_central = false, o bloqueio do saque emergencial NÃO ativa
  // pra esse motoboy específico (ele provavelmente não tem conta na Central).
  // A UI avisa o atendente disso na hora do despacho.
  await pool.query(`
    ALTER TABLE maquinas_movimentacoes
    ADD COLUMN IF NOT EXISTS motoboy_codigo_tutts VARCHAR(50)
  `).catch(e => console.log('⚠️ motoboy_codigo_tutts:', e.message));
  await pool.query(`
    ALTER TABLE maquinas_movimentacoes
    ADD COLUMN IF NOT EXISTS vinculado_central BOOLEAN DEFAULT false
  `).catch(e => console.log('⚠️ vinculado_central:', e.message));
  console.log('✅ Colunas motoboy_codigo_tutts e vinculado_central verificadas');

  // Coluna nova em clientes_solicitacao — horário limite (default 17:00)
  await pool.query(`
    ALTER TABLE clientes_solicitacao
    ADD COLUMN IF NOT EXISTS horario_limite_maquinas TIME DEFAULT '17:00'
  `).catch(e => console.log('⚠️ horario_limite_maquinas em clientes_solicitacao:', e.message));
  console.log('✅ Coluna horario_limite_maquinas verificada em clientes_solicitacao');

  // 🚀 2026-05: liberações pontuais feitas pelo admin da Central.
  // Permite que um motoboy com máquina em mãos faça UM saque emergencial
  // sem precisar restituir a máquina. Liberação é consumida no próximo saque.
  //
  //  - movimentacao_id  → qual máquina-em-campo está sendo "perdoada"
  //  - consumida        → false enquanto a liberação não foi usada num saque
  //  - consumida_em     → quando o motoboy efetivamente sacou usando ela
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maquinas_liberacoes (
      id SERIAL PRIMARY KEY,
      movimentacao_id INT NOT NULL REFERENCES maquinas_movimentacoes(id) ON DELETE CASCADE,
      motoboy_codigo VARCHAR(50) NOT NULL,
      motoboy_nome VARCHAR(255) NOT NULL,
      liberado_por_id INT,
      liberado_por_nome VARCHAR(255),
      consumida BOOLEAN DEFAULT false,
      consumida_em TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Tabela maquinas_liberacoes verificada');
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_maqlib_mov ON maquinas_liberacoes(movimentacao_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_maqlib_motoboy ON maquinas_liberacoes(motoboy_codigo)`).catch(() => {});
  // Índice parcial: liberações ativas (não consumidas) — checado a cada saque
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_maqlib_ativa
    ON maquinas_liberacoes(motoboy_codigo)
    WHERE consumida = false
  `).catch(() => {});
  console.log('✅ Índices maquinas_liberacoes criados');
}

module.exports = { initMaquinasTables };
