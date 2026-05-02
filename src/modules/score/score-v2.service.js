/**
 * Score v2 — Service (2026-05)
 *
 * Lógica de cálculo de nível por janela rolling 28 dias.
 *
 * REGRAS:
 *   Nível 1 (default): qualquer motoboy ativo
 *   Nível 2: ≥150 entregas (28d) E ≥15 dias com 1+ entrega após 16h E 85% ≤ prazo < 90%
 *   Nível 3: ≥200 entregas (28d) E ≥20 dias com 1+ entrega após 16h E prazo ≥ 90%
 *
 * BÔNUS:
 *   N2 → 1 saque/mês até R$ 500 + concorre a sorteio mensal
 *   N3 → 1 saque/semana até R$ 500 + concorre a sorteio mensal
 *
 * UX SUBIDA PROPORCIONAL: motoboy que sobe de nível MEIO do mês ganha
 *   1 saque-bônus pro mês corrente (proporcional). Mesmo cálculo para
 *   semana (nível 3). Sistema usa `score_bonus_lancados` com UNIQUE
 *   (cod_prof, periodo, tipo) pra não duplicar.
 *
 * UX DESCIDA: motoboy que cai de nível mantém o que já sacou (regra A
 *   confirmada pelo Tutts). Não revoga gratuidades já lançadas.
 */

'use strict';

// ============================================================
// CONSTANTES
// ============================================================

const NIVEL_2 = {
  entregas_min: 150,
  dias_16h_min: 15,
  pct_prazo_min: 85,
  pct_prazo_max: 90, // exclusivo (<90)
};

const NIVEL_3 = {
  entregas_min: 200,
  dias_16h_min: 20,
  pct_prazo_min: 90, // ≥90
};

const HORA_CORTE_NOTURNO = 16; // "após 16h"
const JANELA_DIAS = 28;

// ============================================================
// CÁLCULO DE NÍVEL (rolling 28d)
// ============================================================

/**
 * Calcula o nível atual do motoboy + métricas + progresso pro próximo nível.
 *
 * Retorno:
 *   {
 *     nivel: 1|2|3,
 *     stats: { entregas, dias_16h, pct_prazo },
 *     progresso: {
 *       proximo_nivel: 2|3|null,
 *       requisitos: [
 *         { metrica: 'entregas', atual: 87, meta: 150, ok: false },
 *         { metrica: 'dias_16h', atual: 8, meta: 15, ok: false },
 *         { metrica: 'pct_prazo', atual: 88.2, meta: 85, ok: true }
 *       ]
 *     }
 *   }
 */
async function calcularNivelMotoboy(pool, codProf) {
  // Query única que retorna 3 contagens da janela 28d:
  //   total_entregas: total de OS finalizadas
  //   dias_16h: dias distintos com pelo menos 1 entrega solicitada após 16h
  //   pct_prazo: % de OS dentro do prazo
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_entregas,
      COUNT(DISTINCT data_solicitado) FILTER (
        WHERE EXTRACT(HOUR FROM hora_solicitado) >= $2
      )::int AS dias_16h,
      CASE 
        WHEN COUNT(*) > 0 THEN
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / COUNT(*), 2)
        ELSE 0
      END AS pct_prazo
    FROM bi_entregas
    WHERE cod_prof = $1::int
      AND data_solicitado >= CURRENT_DATE - ($3::int - 1)
      AND data_solicitado <= CURRENT_DATE
  `, [codProf, HORA_CORTE_NOTURNO, JANELA_DIAS]);

  const stats = {
    entregas: parseInt(result.rows[0].total_entregas) || 0,
    dias_16h: parseInt(result.rows[0].dias_16h) || 0,
    pct_prazo: parseFloat(result.rows[0].pct_prazo) || 0,
  };

  // Determina nível
  let nivel = 1;
  if (
    stats.entregas >= NIVEL_3.entregas_min &&
    stats.dias_16h >= NIVEL_3.dias_16h_min &&
    stats.pct_prazo >= NIVEL_3.pct_prazo_min
  ) {
    nivel = 3;
  } else if (
    stats.entregas >= NIVEL_2.entregas_min &&
    stats.dias_16h >= NIVEL_2.dias_16h_min &&
    stats.pct_prazo >= NIVEL_2.pct_prazo_min &&
    stats.pct_prazo < NIVEL_2.pct_prazo_max
  ) {
    nivel = 2;
  }

  // Calcula progresso pro PRÓXIMO nível (mostrar barra ao motoboy)
  let progresso = null;
  if (nivel === 1) {
    progresso = montarProgresso(stats, 2);
  } else if (nivel === 2) {
    progresso = montarProgresso(stats, 3);
  }

  return { nivel, stats, progresso };
}

function montarProgresso(stats, alvo) {
  const config = alvo === 3 ? NIVEL_3 : NIVEL_2;
  const reqs = [
    {
      metrica: 'entregas',
      label: 'Entregas no período (28 dias)',
      atual: stats.entregas,
      meta: config.entregas_min,
      ok: stats.entregas >= config.entregas_min,
      pct: Math.min(100, Math.round((stats.entregas / config.entregas_min) * 100)),
    },
    {
      metrica: 'dias_16h',
      label: 'Dias com entregas após 16h',
      atual: stats.dias_16h,
      meta: config.dias_16h_min,
      ok: stats.dias_16h >= config.dias_16h_min,
      pct: Math.min(100, Math.round((stats.dias_16h / config.dias_16h_min) * 100)),
    },
  ];
  if (alvo === 3) {
    reqs.push({
      metrica: 'pct_prazo',
      label: '% no prazo',
      atual: stats.pct_prazo,
      meta: config.pct_prazo_min,
      ok: stats.pct_prazo >= config.pct_prazo_min,
      pct: Math.min(100, Math.round((stats.pct_prazo / config.pct_prazo_min) * 100)),
      sufixo: '%',
    });
  } else {
    // N2 tem faixa: precisa estar entre 85 e 90
    reqs.push({
      metrica: 'pct_prazo',
      label: '% no prazo (entre 85% e 90%)',
      atual: stats.pct_prazo,
      meta: config.pct_prazo_min,
      ok: stats.pct_prazo >= config.pct_prazo_min && stats.pct_prazo < config.pct_prazo_max,
      pct: Math.min(100, Math.round((stats.pct_prazo / config.pct_prazo_min) * 100)),
      sufixo: '%',
      faixa: true,
    });
  }
  return { proximo_nivel: alvo, requisitos: reqs };
}

// ============================================================
// PERSISTÊNCIA DO NÍVEL (snapshot + histórico de mudanças)
// ============================================================

/**
 * Salva/atualiza o nível do motoboy no banco. Detecta subida/descida
 * e dispara lançamento de bônus quando aplicável.
 *
 * Retorno: { mudou: bool, de: int, para: int, bonus_lancado: object|null }
 */
async function persistirNivelMotoboy(pool, { codProf, nomeProf, regiao, nivel, stats }) {
  // Lê estado anterior
  const anterior = await pool.query(
    'SELECT nivel_atual, historico_mudancas FROM score_nivel_motoboy WHERE cod_prof = $1',
    [String(codProf)]
  );
  const nivelAnterior = anterior.rows[0]?.nivel_atual || 1;
  const historicoMudancas = anterior.rows[0]?.historico_mudancas || [];

  const mudou = nivelAnterior !== nivel;
  const subiu = mudou && nivel > nivelAnterior;
  const desceu = mudou && nivel < nivelAnterior;

  // Atualiza histórico se mudou
  let novoHistorico = historicoMudancas;
  if (mudou) {
    novoHistorico = [
      ...historicoMudancas,
      {
        de: nivelAnterior,
        para: nivel,
        em: new Date().toISOString(),
        stats: { ...stats },
      },
    ].slice(-20); // mantém só últimas 20
  }

  await pool.query(`
    INSERT INTO score_nivel_motoboy (
      cod_prof, nome_prof, regiao, nivel_atual,
      entregas_periodo, dias_16h_periodo, pct_prazo,
      avaliado_em, ultima_subida_em, ultima_descida_em, historico_mudancas
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, NOW(),
      ${subiu ? 'NOW()' : 'NULL'},
      ${desceu ? 'NOW()' : 'NULL'},
      $8::jsonb
    )
    ON CONFLICT (cod_prof) DO UPDATE SET
      nome_prof = EXCLUDED.nome_prof,
      regiao = EXCLUDED.regiao,
      nivel_atual = EXCLUDED.nivel_atual,
      entregas_periodo = EXCLUDED.entregas_periodo,
      dias_16h_periodo = EXCLUDED.dias_16h_periodo,
      pct_prazo = EXCLUDED.pct_prazo,
      avaliado_em = NOW(),
      ${subiu ? 'ultima_subida_em = NOW(),' : ''}
      ${desceu ? 'ultima_descida_em = NOW(),' : ''}
      historico_mudancas = $8::jsonb
  `, [
    String(codProf), nomeProf, regiao, nivel,
    stats.entregas, stats.dias_16h, stats.pct_prazo,
    JSON.stringify(novoHistorico),
  ]);

  return { mudou, de: nivelAnterior, para: nivel, subiu, desceu };
}

// ============================================================
// LANÇAMENTO DE BÔNUS (saque proporcional ao subir de nível)
// ============================================================

/**
 * Lança gratuidade pro motoboy quando aplicável.
 *
 * Regras:
 *   - N2: 1 saque/MÊS até R$ 500 (ou teto da config) — periodo = 'YYYY-MM'
 *   - N3: 1 saque/SEMANA até R$ 500 (ou teto) — periodo = 'YYYY-Www' (ISO week)
 *
 * UNIQUE (cod_prof, periodo, tipo) garante que não duplica.
 *
 * Retorno: { lancado: bool, periodo, tipo, valor, gratuidade_id }
 */
async function lancarBonusSeAplicavel(pool, { codProf, nomeProf, regiao, nivel }) {
  if (nivel < 2) return { lancado: false, motivo: 'nivel_insuficiente' };

  // Busca config da região (pra teto customizado)
  const cfg = await pool.query(
    `SELECT saque_teto_n2, saque_teto_n3, ativo FROM score_config_regiao WHERE UPPER(regiao) = UPPER($1)`,
    [regiao || '']
  );
  if (cfg.rows.length === 0 || !cfg.rows[0].ativo) {
    return { lancado: false, motivo: 'regiao_nao_configurada' };
  }
  const teto = nivel === 3
    ? parseFloat(cfg.rows[0].saque_teto_n3) || 500
    : parseFloat(cfg.rows[0].saque_teto_n2) || 500;

  // Periodo: mensal pra N2, semanal pra N3
  const agora = new Date();
  const ano = agora.getFullYear();
  let periodo, tipo;
  if (nivel === 2) {
    periodo = `${ano}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
    tipo = 'saque_mensal';
  } else {
    // ISO week
    const semana = isoWeek(agora);
    periodo = `${ano}-W${String(semana).padStart(2, '0')}`;
    tipo = 'saque_semanal';
  }

  // Verifica se já foi lançado
  const existente = await pool.query(
    `SELECT id, gratuidade_id FROM score_bonus_lancados WHERE cod_prof = $1 AND periodo = $2 AND tipo = $3`,
    [String(codProf), periodo, tipo]
  );
  if (existente.rows.length > 0) {
    return { lancado: false, motivo: 'ja_lancado_no_periodo', gratuidade_id: existente.rows[0].gratuidade_id };
  }

  // Cria gratuidade no Plific
  const grat = await pool.query(`
    INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by)
    VALUES ($1, $2, 1, 1, $3, $4, 'ativa', 'Score v2')
    RETURNING id
  `, [
    String(codProf),
    nomeProf,
    teto,
    `Score Nível ${nivel} - ${periodo} (${tipo === 'saque_semanal' ? 'semanal' : 'mensal'})`
  ]);

  // Registra o lançamento
  await pool.query(`
    INSERT INTO score_bonus_lancados (cod_prof, nome_prof, regiao, nivel, periodo, tipo, valor_teto, gratuidade_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [String(codProf), nomeProf, regiao, nivel, periodo, tipo, teto, grat.rows[0].id]);

  return {
    lancado: true,
    periodo,
    tipo,
    valor: teto,
    gratuidade_id: grat.rows[0].id,
  };
}

// ISO week number (segunda como início da semana)
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ============================================================
// PIPELINE COMPLETO (calcula + persiste + lança bônus)
// ============================================================

/**
 * Roda pipeline completo: calcula nível, persiste mudança, lança bônus se subiu.
 * Use este como entrypoint da rota motoboy (`GET /api/score/meu-nivel`).
 *
 * Retorno: { nivel, stats, progresso, mudou, bonus_lancado, regiao_configurada }
 */
async function avaliarMotoboy(pool, codProf) {
  // 1. Identifica motoboy + região
  const profQ = await pool.query(`
    SELECT cod_profissional AS cod_prof, full_name AS nome, regiao
    FROM users
    WHERE cod_profissional = $1
    LIMIT 1
  `, [String(codProf)]);
  if (profQ.rows.length === 0) {
    // Fallback: tenta no CRM
    const crmQ = await pool.query(
      `SELECT codigo AS cod_prof, nome, regiao FROM crm_leads_capturados WHERE codigo = $1 LIMIT 1`,
      [String(codProf)]
    );
    if (crmQ.rows.length === 0) {
      return { erro: 'profissional_nao_encontrado' };
    }
    profQ.rows = crmQ.rows;
  }
  const { nome, regiao } = profQ.rows[0];

  // 2. Confere se a região tem score ativo
  let regiaoConfigurada = false;
  if (regiao) {
    const cfg = await pool.query(
      `SELECT ativo, niveis_ativos FROM score_config_regiao WHERE UPPER(regiao) = UPPER($1)`,
      [regiao]
    );
    regiaoConfigurada = cfg.rows.length > 0 && cfg.rows[0].ativo === true;
  }

  if (!regiaoConfigurada) {
    return {
      regiao_configurada: false,
      regiao,
      mensagem: 'Score não está disponível na sua região',
    };
  }

  // 3. Calcula nível atual
  const { nivel, stats, progresso } = await calcularNivelMotoboy(pool, codProf);

  // 4. Persiste (snapshot + histórico de mudanças)
  const persistencia = await persistirNivelMotoboy(pool, {
    codProf, nomeProf: nome, regiao, nivel, stats,
  });

  // 5. Se está em nível 2 ou 3, tenta lançar bônus do período (idempotente)
  let bonusLancado = null;
  if (nivel >= 2) {
    bonusLancado = await lancarBonusSeAplicavel(pool, {
      codProf, nomeProf: nome, regiao, nivel,
    });
  }

  return {
    regiao_configurada: true,
    regiao,
    nivel,
    stats,
    progresso,
    mudou: persistencia.mudou,
    subiu: persistencia.subiu,
    desceu: persistencia.desceu,
    nivel_anterior: persistencia.de,
    bonus: bonusLancado,
  };
}

// ============================================================
// SORTEIO MENSAL (chamado pelo cron dia 1)
// ============================================================

/**
 * Roda sorteio mensal pra todas as regiões configuradas.
 * Chamado pelo cron dia 1 do mês 00:05.
 *
 * Lógica:
 *   1. Pega mês passado (YYYY-MM-01 → último dia)
 *   2. Pra cada região configurada:
 *      Pra cada nível ativo (2 e/ou 3):
 *        a. Lista motoboys que terminaram o mês passado naquele nível
 *        b. Sorteia 1 vencedor aleatório
 *        c. Lança gratuidade
 *        d. Registra em score_sorteios
 *
 * IDEMPOTENTE: UNIQUE(mes_referencia, regiao, nivel) impede dupla execução.
 */
async function rodarSorteiosMensais(pool, mesRef) {
  console.log(`🎲 [Score v2] Rodando sorteios para ${mesRef}...`);

  const regioes = await pool.query(
    `SELECT regiao, niveis_ativos, sorteio_valor_n2, sorteio_valor_n3 
     FROM score_config_regiao WHERE ativo = true`
  );

  const resultados = [];

  for (const r of regioes.rows) {
    const niveis = r.niveis_ativos || [2, 3];

    for (const nivel of niveis) {
      try {
        // Pega valor configurado
        const valor = nivel === 3
          ? parseFloat(r.sorteio_valor_n3) || 150
          : parseFloat(r.sorteio_valor_n2) || 50;

        // Lista candidatos: motoboys da região que ESTÃO no nível agora
        // (o ideal seria ter snapshot do fim do mês — TODO: cron de fechamento)
        const candidatos = await pool.query(`
          SELECT cod_prof, nome_prof
          FROM score_nivel_motoboy
          WHERE UPPER(regiao) = UPPER($1)
            AND nivel_atual = $2
        `, [r.regiao, nivel]);

        if (candidatos.rows.length === 0) {
          console.log(`  ⏭️ ${r.regiao} N${nivel}: 0 candidatos`);
          continue;
        }

        // Sorteia
        const ix = Math.floor(Math.random() * candidatos.rows.length);
        const vencedor = candidatos.rows[ix];

        // Cria gratuidade
        const grat = await pool.query(`
          INSERT INTO gratuities (user_cod, user_name, quantity, remaining, value, reason, status, created_by)
          VALUES ($1, $2, 1, 1, $3, $4, 'ativa', 'Score v2 Sorteio')
          RETURNING id
        `, [
          vencedor.cod_prof,
          vencedor.nome_prof,
          valor,
          `Sorteio Score Nível ${nivel} - ${mesRef} - ${r.regiao}`
        ]);

        // Registra sorteio (UNIQUE constraint protege contra dupla execução)
        await pool.query(`
          INSERT INTO score_sorteios (
            mes_referencia, regiao, nivel, total_participantes,
            vencedor_cod_prof, vencedor_nome, valor, gratuidade_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (mes_referencia, regiao, nivel) DO NOTHING
        `, [
          mesRef, r.regiao, nivel, candidatos.rows.length,
          vencedor.cod_prof, vencedor.nome_prof, valor, grat.rows[0].id
        ]);

        console.log(`  🏆 ${r.regiao} N${nivel}: ${vencedor.nome_prof} (R$ ${valor})`);
        resultados.push({
          regiao: r.regiao,
          nivel,
          vencedor: vencedor.nome_prof,
          valor,
          total_participantes: candidatos.rows.length,
        });
      } catch (err) {
        console.error(`  ❌ ${r.regiao} N${nivel}:`, err.message);
      }
    }
  }

  return resultados;
}

module.exports = {
  // Constantes
  NIVEL_2,
  NIVEL_3,
  HORA_CORTE_NOTURNO,
  JANELA_DIAS,
  // Calculo
  calcularNivelMotoboy,
  persistirNivelMotoboy,
  lancarBonusSeAplicavel,
  // Pipeline alto nível
  avaliarMotoboy,
  // Sorteio
  rodarSorteiosMensais,
};
