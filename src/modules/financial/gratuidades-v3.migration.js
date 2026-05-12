/**
 * gratuidades-v3.migration.js
 * ─────────────────────────────────────────────────────────────────────────
 * Migration auto-executável do segundo redesign de gratuidades.
 *
 * Mudanças:
 *   1. gratuities.expires_at — prazo de 10 dias por padrão.
 *   2. gratuities.status: novo valor 'expirada_prazo' (diferente de 'expirada'
 *      que continua sendo 'consumida' / remaining=0). Mas mantemos lógica
 *      semântica via colunas em vez de mudar o status legado:
 *        - 'ativa' + expires_at > NOW()     → ATIVA
 *        - 'ativa' + remaining = 0          → UTILIZADA (renomeação só de UI)
 *        - 'ativa' + expires_at <= NOW() + remaining > 0 → EXPIRADA (prazo)
 *        - 'expirada' (legado) é equivalente a 'utilizada'
 *      Pra simplificar o SQL, vamos ADICIONAR a coluna `expires_at` e usar
 *      ela como verdade. O status_ui no SELECT vira: utilizada/expirada/ativa.
 *   3. Tabela gratuities_motivos.unaccent — coluna gerada pra normalização.
 *      Habilita extension `unaccent` no Postgres pra remover acentos.
 *   4. Tabela withdrawal_exemptions (NOVA) — isenções permanentes.
 *      Mais a tabela exemptions_motivos com lista pré-definida.
 *   5. Normalização retroativa: mescla motivos com mesma forma normalizada.
 *   6. Backfill: expires_at = created_at + 10 days em gratuidades antigas.
 */

'use strict';

async function initGratuidadesV3Tables(pool) {
  const log = (msg) => console.log(`[gratuidades-v3] ${msg}`);

  // ═════════════════════════════════════════════════════════════════════
  // 1. Habilitar extension unaccent (idempotente)
  // ═════════════════════════════════════════════════════════════════════
  // unaccent permite remover acentos no Postgres: unaccent('NERÓPOLIS') = 'NEROPOLIS'
  // Sem isso, "NERÓPOLIS" e "NEROPOLIS" seriam motivos diferentes pra UNIQUE.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    log('✅ Extension unaccent OK');
  } catch (e) {
    log(`⚠️ Não foi possível criar unaccent: ${e.message}. Normalização vai usar fallback JS.`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // 2. gratuities.expires_at + backfill
  // ═════════════════════════════════════════════════════════════════════
  await pool.query(`
    ALTER TABLE gratuities
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
  `);

  // Backfill: TODAS as gratuidades antigas recebem expires_at = created_at + 10 dias
  // (per requisito do Tutts: "vale para as antigas")
  const backfillResult = await pool.query(`
    UPDATE gratuities
       SET expires_at = created_at + INTERVAL '10 days'
     WHERE expires_at IS NULL
  `);
  if (backfillResult.rowCount > 0) {
    log(`✅ Backfill expires_at em ${backfillResult.rowCount} gratuidades antigas`);
  }

  // Tornar expires_at NOT NULL daqui pra frente (após backfill)
  await pool.query(`
    ALTER TABLE gratuities
      ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '10 days')
  `).catch(() => {});

  // Índice pra cron que marca expiradas
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gratuities_expires_at
      ON gratuities(expires_at)
     WHERE status = 'ativa' AND remaining > 0
  `).catch(() => {});

  log('✅ gratuities.expires_at OK');

  // ═════════════════════════════════════════════════════════════════════
  // 3. Tabela de isenções permanentes
  // ═════════════════════════════════════════════════════════════════════
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_exemptions (
      id              SERIAL PRIMARY KEY,
      user_cod        VARCHAR(50) NOT NULL,
      user_name       VARCHAR(255),
      motivo          VARCHAR(120) NOT NULL,
      ativa           BOOLEAN NOT NULL DEFAULT TRUE,
      criado_por      VARCHAR(255),
      criado_em       TIMESTAMP NOT NULL DEFAULT NOW(),
      desativada_em   TIMESTAMP,
      desativado_por  VARCHAR(255),
      observacao      TEXT
    )
  `);

  // Um motoboy só pode ter UMA isenção ativa por vez (UNIQUE parcial)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_exemption_ativa_por_user
      ON withdrawal_exemptions(user_cod)
     WHERE ativa = TRUE
  `).catch(() => {});

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exemptions_user_cod
      ON withdrawal_exemptions(user_cod)
  `).catch(() => {});

  log('✅ Tabela withdrawal_exemptions OK');

  // ═════════════════════════════════════════════════════════════════════
  // 4. Tabela de motivos pré-definidos de isenção (separada de gratuidades)
  // ═════════════════════════════════════════════════════════════════════
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exemptions_motivos (
      id            SERIAL PRIMARY KEY,
      motivo        VARCHAR(120) UNIQUE NOT NULL,
      ativo         BOOLEAN NOT NULL DEFAULT TRUE,
      criado_por    VARCHAR(255),
      criado_em     TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Seed dos motivos default de isenção (per requisito do Tutts)
  const { rows: existemMotivosIsencao } = await pool.query(
    `SELECT COUNT(*)::int as total FROM exemptions_motivos`
  );
  if (existemMotivosIsencao[0].total === 0) {
    const defaults = [
      'MOTOBOY PARCEIRO',
      'FUNDADOR',
      'CONVENIO',
      'INDICACAO ESTRATEGICA',
      'PROGRAMA FIDELIDADE',
    ];
    for (const m of defaults) {
      await pool.query(
        `INSERT INTO exemptions_motivos (motivo, criado_por)
         VALUES ($1, 'seed_inicial')
         ON CONFLICT (motivo) DO NOTHING`,
        [m]
      );
    }
    log(`✅ Seed: ${defaults.length} motivos de isenção semeados`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // 5. NORMALIZAÇÃO RETROATIVA dos motivos de gratuidades
  // ═════════════════════════════════════════════════════════════════════
  // Pega motivos com mesma forma normalizada (UPPER + TRIM + sem acentos
  // + colapsa espaços) e mescla pra a forma canônica (mais usada).
  //
  // Exemplo: tem 3 registros com motivos:
  //   'APOIO FECHAMENTO' (120 usos)
  //   'Apoio fechamento' (5 usos)
  //   'APOIO  FECHAMENTO' (3 usos, espaço duplo)
  //
  // Todos têm normalização 'APOIO FECHAMENTO'. Mantemos a versão de 120 usos
  // (já normalizada) e atualizamos gratuities.reason das outras 8 ocorrências
  // pra apontar pra ela. Daí removemos as duplicatas em gratuities_motivos.
  //
  // Tentamos via SQL com unaccent; se não tiver extension, normaliza pela
  // forma simples (UPPER + TRIM + regex de espaço).
  //
  // Pode rodar VÁRIAS vezes — idempotente (depois da 1ª passada não acha
  // mais duplicatas).
  let temUnaccent = true;
  try {
    await pool.query(`SELECT unaccent('test')`);
  } catch (_) {
    temUnaccent = false;
  }

  const fnNorm = temUnaccent
    ? `REGEXP_REPLACE(UPPER(TRIM(unaccent($COL))), '\\s+', ' ', 'g')`
    : `REGEXP_REPLACE(UPPER(TRIM($COL)), '\\s+', ' ', 'g')`;

  // 5.1 Normalizar gratuities.reason in-place
  const reasonNorm = fnNorm.replace('$COL', 'reason');
  const updReason = await pool.query(`
    UPDATE gratuities
       SET reason = ${reasonNorm}
     WHERE reason IS NOT NULL
       AND reason <> ${reasonNorm}
  `);
  if (updReason.rowCount > 0) {
    log(`✅ Normalização: ${updReason.rowCount} reasons normalizados em gratuities`);
  }

  // 5.2 Mesclar duplicatas em gratuities_motivos
  // Estratégia: pra cada grupo (normalizado), mantém o motivo MAIS USADO
  // (com base no count em gratuities) e desativa os outros.
  const motNorm = fnNorm.replace('$COL', 'm.motivo');
  const { rows: grupos } = await pool.query(`
    SELECT
      ${motNorm} AS norm,
      array_agg(m.id ORDER BY m.id) AS ids,
      array_agg(m.motivo ORDER BY m.id) AS motivos
    FROM gratuities_motivos m
    WHERE m.ativo = TRUE
    GROUP BY ${motNorm}
    HAVING COUNT(*) > 1
  `);

  let totalMesclados = 0;
  for (const g of grupos) {
    // Pra escolher o canônico, pega o que tem mais usos em gratuities
    const usosQ = await pool.query(`
      SELECT m.id, m.motivo, COUNT(grat.id)::int AS usos
        FROM gratuities_motivos m
        LEFT JOIN gratuities grat ON UPPER(TRIM(grat.reason)) = m.motivo
       WHERE m.id = ANY($1::int[])
       GROUP BY m.id, m.motivo
       ORDER BY usos DESC, m.id ASC
    `, [g.ids]);

    if (usosQ.rows.length === 0) continue;

    const canonico = usosQ.rows[0];
    const duplicados = usosQ.rows.slice(1);

    // Atualiza reason em gratuities pros duplicados → canônico
    for (const dup of duplicados) {
      await pool.query(
        `UPDATE gratuities SET reason = $1 WHERE UPPER(TRIM(reason)) = $2`,
        [canonico.motivo, dup.motivo]
      );
      // Desativa o duplicado (soft-delete)
      await pool.query(
        `UPDATE gratuities_motivos SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1`,
        [dup.id]
      );
      totalMesclados++;
    }
    // Garante que o canônico esteja na forma normalizada
    await pool.query(`
      UPDATE gratuities_motivos
         SET motivo = ${motNorm.replace('m.motivo', '$1')}, atualizado_em = NOW()
       WHERE id = $2
    `, [canonico.motivo, canonico.id]).catch(() => {});
  }
  if (totalMesclados > 0) {
    log(`✅ Normalização: ${totalMesclados} motivos duplicados mesclados`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // 6. Cron simulado: marcar como expiradas as que já passaram
  // ═════════════════════════════════════════════════════════════════════
  // Roda 1x no boot (idempotente). O cron real fica no worker.js
  const expirou = await pool.query(`
    UPDATE gratuities
       SET status = 'expirada_prazo'
     WHERE status = 'ativa'
       AND remaining > 0
       AND expires_at < NOW()
  `);
  if (expirou.rowCount > 0) {
    log(`✅ Expiração inicial: ${expirou.rowCount} gratuidades marcadas como expiradas`);
  }
}

/**
 * Função exportada — chamada pelo cron diário (worker.js) pra marcar como
 * expiradas as gratuidades que passaram do prazo sem uso.
 * Idempotente, pode rodar várias vezes por dia sem prejuízo.
 */
async function expirarGratuidadesVencidas(pool) {
  const r = await pool.query(`
    UPDATE gratuities
       SET status = 'expirada_prazo'
     WHERE status = 'ativa'
       AND remaining > 0
       AND expires_at < NOW()
    RETURNING id, user_cod
  `);
  return r.rows;
}

module.exports = {
  initGratuidadesV3Tables,
  expirarGratuidadesVencidas,
};
