/**
 * Score v2 — Migration (2026-05)
 *
 * Reestruturação completa do módulo Score.
 *
 * NÃO REMOVE as tabelas antigas (score_historico, score_totais, score_milestones,
 * score_conquistas, score_gratuidades, score_premios_fisicos) — elas continuam
 * existindo mas não são usadas pela v2. Isso permite rollback sem perder dados.
 *
 * 3 TABELAS NOVAS:
 *   - score_config_regiao    → admin define quais regiões têm score + valores
 *   - score_nivel_motoboy    → nível atual de cada motoboy + histórico de mudanças
 *   - score_sorteios         → sorteios mensais + ganhadores
 *
 * MODELO DE DADOS:
 *   1 região configurada = 1 row em score_config_regiao
 *   Cada motoboy ativo nessa região = 1 row em score_nivel_motoboy
 *   Cada sorteio mensal = 1 row em score_sorteios (1 por região × nível)
 */

async function initScoreV2Tables(pool) {
  console.log('📊 Inicializando tabelas Score v2...');

  // ============================================================
  // 1. CONFIGURAÇÃO POR REGIÃO (admin)
  // ============================================================
  // Match por nome com crm_leads_capturados.regiao (case-insensitive).
  // niveis_ativos: array json tipo [2,3] (admin pode habilitar só nivel 2, ou ambos)
  // Valores de sorteio: separados por nível (sorteio_valor_n2, sorteio_valor_n3)
  // Tetos de gratuidade: customizável por nível (default R$ 500 mas pode mudar)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_config_regiao (
      id SERIAL PRIMARY KEY,
      regiao VARCHAR(100) NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT true,
      niveis_ativos JSONB NOT NULL DEFAULT '[2,3]'::jsonb,
      sorteio_valor_n2 DECIMAL(10,2) DEFAULT 50.00,
      sorteio_valor_n3 DECIMAL(10,2) DEFAULT 150.00,
      saque_teto_n2 DECIMAL(10,2) DEFAULT 500.00,
      saque_teto_n3 DECIMAL(10,2) DEFAULT 500.00,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW(),
      criado_por VARCHAR(50),
      UNIQUE(regiao)
    )
  `);
  // 🚀 2026-05: thresholds configuráveis por região (ALTER pra reinicialização idempotente)
  // 🔧 2026-05 v2: dias_16h_min agora é QTD TOTAL de entregas após 16h (não mais "dias distintos").
  // Nome de coluna mantido pra não migrar; valor default aumentado (12 dias ≠ 60 entregas).
  await pool.query(`
    ALTER TABLE score_config_regiao
      ADD COLUMN IF NOT EXISTS n2_min_entregas INT DEFAULT 80,
      ADD COLUMN IF NOT EXISTS n2_min_dias_16h INT DEFAULT 15,
      ADD COLUMN IF NOT EXISTS n2_min_pct_prazo DECIMAL(5,2) DEFAULT 80.00,
      ADD COLUMN IF NOT EXISTS n3_min_entregas INT DEFAULT 150,
      ADD COLUMN IF NOT EXISTS n3_min_dias_16h INT DEFAULT 20,
      ADD COLUMN IF NOT EXISTS n3_min_pct_prazo DECIMAL(5,2) DEFAULT 88.00
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_cfg_ativo ON score_config_regiao(ativo) WHERE ativo = true').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_cfg_regiao_upper ON score_config_regiao(UPPER(regiao))').catch(() => {});
  console.log('  ✅ score_config_regiao');

  // ============================================================
  // 2. NÍVEL ATUAL DO MOTOBOY (snapshot recalculado em tempo real)
  // ============================================================
  // Atualizado em tempo real toda vez que motoboy abre tela de Score.
  // Também atualizado pelo cron mensal (para fechar mês e definir
  // quem ganha sorteio + saque-bônus do mês).
  // historico_mudancas: array json com { de, para, em, motivo }
  // entregas_periodo / dias_16h_periodo / pct_prazo: stats da última avaliação
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_nivel_motoboy (
      cod_prof VARCHAR(50) PRIMARY KEY,
      nome_prof VARCHAR(255),
      regiao VARCHAR(100),
      nivel_atual INT NOT NULL DEFAULT 1,
      entregas_periodo INT DEFAULT 0,
      dias_16h_periodo INT DEFAULT 0,
      pct_prazo DECIMAL(5,2) DEFAULT 0,
      avaliado_em TIMESTAMP DEFAULT NOW(),
      ultima_subida_em TIMESTAMP,
      ultima_descida_em TIMESTAMP,
      historico_mudancas JSONB DEFAULT '[]'::jsonb
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_nivel_regiao ON score_nivel_motoboy(regiao)').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_nivel_atual ON score_nivel_motoboy(nivel_atual) WHERE nivel_atual > 1').catch(() => {});
  console.log('  ✅ score_nivel_motoboy');

  // ============================================================
  // 3. SORTEIOS MENSAIS
  // ============================================================
  // Roda dia 1 do mês 00:05 via cron. Sorteia 1 ganhador por
  // (região, nível) entre quem terminou o mês anterior naquele nível.
  // gratuidade_id: FK pra gratuities (mesma tabela de saques-bônus)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_sorteios (
      id SERIAL PRIMARY KEY,
      mes_referencia VARCHAR(7) NOT NULL,
      regiao VARCHAR(100) NOT NULL,
      nivel INT NOT NULL,
      total_participantes INT DEFAULT 0,
      vencedor_cod_prof VARCHAR(50),
      vencedor_nome VARCHAR(255),
      valor DECIMAL(10,2),
      gratuidade_id INT,
      sorteado_em TIMESTAMP DEFAULT NOW(),
      sorteado_por VARCHAR(50) DEFAULT 'sistema',
      UNIQUE(mes_referencia, regiao, nivel)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_sorteios_mes ON score_sorteios(mes_referencia DESC)').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_sorteios_vencedor ON score_sorteios(vencedor_cod_prof)').catch(() => {});
  console.log('  ✅ score_sorteios');

  // ============================================================
  // 4. SAQUES-BÔNUS LANÇADOS (rastreabilidade)
  // ============================================================
  // Quando o sistema lança gratuidade pelo bônus de nível, registra aqui.
  // Diferente de score_sorteios (que é só pra sorteios), score_bonus_lancados
  // rastreia os saques-bônus normais (1/mês nivel 2, 1/semana nivel 3).
  // periodo: 'mensal' (nivel 2) ou 'semanal-AAAA-WW' (nivel 3, ISO week)
  // Garante UNIQUE pra não lançar 2x o mesmo bônus.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_bonus_lancados (
      id SERIAL PRIMARY KEY,
      cod_prof VARCHAR(50) NOT NULL,
      nome_prof VARCHAR(255),
      regiao VARCHAR(100),
      nivel INT NOT NULL,
      periodo VARCHAR(30) NOT NULL,
      tipo VARCHAR(20) NOT NULL,
      valor_teto DECIMAL(10,2),
      gratuidade_id INT,
      lancado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE(cod_prof, periodo, tipo)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_score_bonus_prof ON score_bonus_lancados(cod_prof)').catch(() => {});
  console.log('  ✅ score_bonus_lancados');

  console.log('📊 Score v2 inicializado com sucesso!');
}

module.exports = { initScoreV2Tables };
