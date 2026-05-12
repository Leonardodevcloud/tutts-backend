/**
 * gratuidades-v2.migration.js
 * ─────────────────────────────────────────────────────────────────────────
 * Migration auto-executável do redesign do módulo de gratuidades.
 *
 * O que cria:
 *   1. Tabela gratuities_motivos — motivos pré-definidos gerenciáveis pelo
 *      admin direto do modal de cadastro. Soft-delete via coluna `ativo`.
 *   2. Índices em gratuities — listagem com filtros (status, created_by,
 *      created_at desc) ficava lenta com >1000 registros.
 *   3. Seed inicial com motivos já em uso na base (extraídos via DISTINCT).
 *
 * Padrão idempotente: roda sempre no boot do server, IF NOT EXISTS em tudo.
 */

'use strict';

async function initGratuidadesV2Tables(pool) {
  // ═════════════════════════════════════════════════════════════════════
  // 1. Tabela de motivos pré-definidos
  // ═════════════════════════════════════════════════════════════════════
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gratuities_motivos (
      id SERIAL PRIMARY KEY,
      motivo VARCHAR(120) UNIQUE NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_por VARCHAR(255),
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Índice pra busca rápida quando filtra por ativo
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gratuities_motivos_ativo
      ON gratuities_motivos(ativo)
  `).catch(() => {});

  console.log('✅ Tabela gratuities_motivos verificada');

  // ═════════════════════════════════════════════════════════════════════
  // 2. Índices em gratuities para a listagem nova
  // ═════════════════════════════════════════════════════════════════════
  // ORDER BY created_at DESC com filtros por status e created_by
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gratuities_status_created
      ON gratuities(status, created_at DESC)
  `).catch(() => {});

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gratuities_created_by
      ON gratuities(created_by)
  `).catch(() => {});

  // Busca por código (filtro de busca livre da listagem)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gratuities_user_cod
      ON gratuities(user_cod)
  `).catch(() => {});

  console.log('✅ Índices de gratuities verificados');

  // ═════════════════════════════════════════════════════════════════════
  // 3. Seed inicial: aproveita motivos já em uso pra não começar vazio
  // ═════════════════════════════════════════════════════════════════════
  // Só roda se a tabela estiver vazia (1ª vez). Pega motivos distintos
  // da tabela `gratuities` que tenham >= 2 usos (filtra digitação isolada).
  const { rows: existentes } = await pool.query(
    `SELECT COUNT(*)::int as total FROM gratuities_motivos`
  );

  if (existentes[0].total === 0) {
    const { rows: motivosUsados } = await pool.query(`
      SELECT UPPER(TRIM(reason)) as motivo, COUNT(*) as usos
        FROM gratuities
       WHERE reason IS NOT NULL
         AND TRIM(reason) <> ''
         AND LENGTH(TRIM(reason)) <= 120
       GROUP BY UPPER(TRIM(reason))
      HAVING COUNT(*) >= 2
       ORDER BY usos DESC
       LIMIT 30
    `);

    if (motivosUsados.length > 0) {
      for (const m of motivosUsados) {
        await pool.query(
          `INSERT INTO gratuities_motivos (motivo, criado_por)
           VALUES ($1, 'seed_inicial')
           ON CONFLICT (motivo) DO NOTHING`,
          [m.motivo]
        );
      }
      console.log(`✅ Seed inicial: ${motivosUsados.length} motivos importados do histórico`);
    } else {
      // Base nova / sem histórico — semeia com defaults razoáveis
      const defaults = [
        'APOIO FECHAMENTO',
        'APOIO OPERACIONAL',
        'SCORE NÍVEL 1',
        'SCORE NÍVEL 2',
        'SCORE NÍVEL 3',
        'EMPRÉSTIMO',
        'AJUSTE OPERACIONAL',
      ];
      for (const m of defaults) {
        await pool.query(
          `INSERT INTO gratuities_motivos (motivo, criado_por)
           VALUES ($1, 'seed_inicial')
           ON CONFLICT (motivo) DO NOTHING`,
          [m]
        );
      }
      console.log(`✅ Seed inicial: ${defaults.length} motivos padrão semeados`);
    }
  }
}

module.exports = { initGratuidadesV2Tables };
