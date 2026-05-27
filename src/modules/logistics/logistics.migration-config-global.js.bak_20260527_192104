/**
 * MÓDULO LOGISTICS — Migration: configuração global do hub
 *
 * Cria a tabela `logistics_config_global` — uma única linha (singleton) que
 * guarda parâmetros que valem pra TODO o hub, independente de cliente.
 *
 * Hoje guarda o GUARDRAIL GLOBAL DE MARGEM: o piso de margem (R$ e %) usado
 * pelo despacho AUTOMÁTICO quando a OS não casa com uma regra de cliente que
 * defina margem própria.
 *
 * Semântica (decidida com o Tutts):
 *  - global = DEFAULT. A regra específica do cliente, quando configurada,
 *    SOBRESCREVE o global pra aquele cliente (override total — a regra manda
 *    inteira, pode inclusive ser mais frouxa que o global).
 *  - O guardrail global age SÓ no despacho automático (worker). O despacho
 *    manual continua mostrando a margem e deixando o operador decidir.
 *
 * Tabela singleton: a coluna `id` é fixada em 1 via CHECK — só existe uma
 * linha. UPSERT sempre em id=1.
 *
 * Idempotente: CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING.
 */

async function initLogisticsConfigGlobal(pool) {
  // ── Tabela singleton ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logistics_config_global (
      id                          INTEGER PRIMARY KEY DEFAULT 1,
      -- guardrail global de margem (despacho automático)
      margem_global_ativa         BOOLEAN DEFAULT false,
      margem_global_minima_rs     DECIMAL(10,2),
      margem_global_minima_pct    DECIMAL(5,2),
      updated_at                  TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT logistics_config_global_singleton CHECK (id = 1)
    )
  `);
  console.log('✅ [logistics] tabela logistics_config_global verificada');

  // ── Garante a linha singleton (id=1), desligada por padrão ──
  // Desligada = comportamento idêntico ao de antes desta migration (o
  // guardrail global só passa a agir quando o operador o ativa pelo painel).
  await pool.query(`
    INSERT INTO logistics_config_global (id, margem_global_ativa)
    VALUES (1, false)
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('✅ [logistics] linha singleton de config global garantida');
}

module.exports = { initLogisticsConfigGlobal };
