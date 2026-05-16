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

// 🚀 2026-05: usa o helper compartilhado que já tem cascata
//   CRM → Planilha Google Sheets → disponibilidade_linhas → users
// (mesmo que outros módulos como avisos.routes.js já usam)
const { buscarProfissional, listarProfissionais } = require('../../shared/utils/profissionaisLookup');

// ============================================================
// CONSTANTES
// ============================================================

// 🚀 2026-05: defaults aplicados quando a config da região NÃO tem valores customizados.
// Baseados em dados reais (top performers tinham 5-15 dias após-16h, não 20).
// Esses valores podem ser sobrescritos por região via score_config_regiao.
//
// 🔧 2026-05 v2: dias_16h_min agora é QTD TOTAL de entregas após 16h
// (não mais "dias distintos com pelo menos 1"). Nome mantido pra compat com banco.
const NIVEL_2_DEFAULT = {
  entregas_min: 80,
  dias_16h_min: 15, // qtd total de entregas após 16h no período (28d)
  pct_prazo_min: 80,
};

const NIVEL_3_DEFAULT = {
  entregas_min: 150,
  dias_16h_min: 20, // qtd total de entregas após 16h no período (28d)
  pct_prazo_min: 88,
};

// Aliases legados (mantidos pra exports/compat — não usar internamente)
const NIVEL_2 = NIVEL_2_DEFAULT;
const NIVEL_3 = NIVEL_3_DEFAULT;

/**
 * Resolve thresholds a partir da config da região.
 * Se algum campo está NULL/undefined na config, usa o default.
 * Se config inteira está faltando (null), retorna defaults puros.
 */
function resolverThresholds(cfg) {
  return {
    n2: {
      entregas_min: cfg?.n2_min_entregas != null ? parseInt(cfg.n2_min_entregas, 10) : NIVEL_2_DEFAULT.entregas_min,
      dias_16h_min: cfg?.n2_min_dias_16h != null ? parseInt(cfg.n2_min_dias_16h, 10) : NIVEL_2_DEFAULT.dias_16h_min,
      pct_prazo_min: cfg?.n2_min_pct_prazo != null ? parseFloat(cfg.n2_min_pct_prazo) : NIVEL_2_DEFAULT.pct_prazo_min,
    },
    n3: {
      entregas_min: cfg?.n3_min_entregas != null ? parseInt(cfg.n3_min_entregas, 10) : NIVEL_3_DEFAULT.entregas_min,
      dias_16h_min: cfg?.n3_min_dias_16h != null ? parseInt(cfg.n3_min_dias_16h, 10) : NIVEL_3_DEFAULT.dias_16h_min,
      pct_prazo_min: cfg?.n3_min_pct_prazo != null ? parseFloat(cfg.n3_min_pct_prazo) : NIVEL_3_DEFAULT.pct_prazo_min,
    },
  };
}

const HORA_CORTE_NOTURNO = 16; // "após 16h"
const JANELA_DIAS = 28;

// ============================================================
// 🆕 2026-05 v3: PERÍODO DE CARÊNCIA PÓS-SUBIDA
// ============================================================
// Motoboy que sobe de nível precisa MANTER o nível por 7 dias antes de
// receber bônus. Conta a partir do timestamp EXATO da subida
// (score_nivel_motoboy.ultima_subida_em).
//
// Comportamento:
//   - SOBE: gera ultima_subida_em = NOW(). Por 7 dias não recebe bônus.
//   - DESCE: gratuidade já lançada do mês corrente NÃO é revogada
//            (mas próximas avaliações não vão lançar enquanto não voltar a subir).
//   - RETROATIVO: motoboys com ultima_subida_em IS NULL (subida anterior
//     ao tracking) são considerados FORA da carência (subida "antiga").
//
// Override via env CARENCIA_SCORE_DIAS pra testes.
const CARENCIA_SCORE_DIAS = parseInt(process.env.CARENCIA_SCORE_DIAS, 10) || 7;
const CARENCIA_SCORE_MS = CARENCIA_SCORE_DIAS * 24 * 60 * 60 * 1000;

/**
 * Calcula estado de carência de um motoboy.
 *
 * 🆕 2026-05 v4: a carência conta a partir de `nivel_desde` — timestamp de
 * quando o motoboy ENTROU no nível atual. QUALQUER mudança de nível (subida
 * OU descida) reseta nivel_desde, então a carência é reiniciada tanto ao
 * subir quanto ao cair (regra: cai N3→N2 precisa de nova carência no N2).
 *
 * @param {Date|null} nivelDesde  timestamp de entrada no nível atual (ou null)
 * @returns {object}
 *   em_carencia: bool     — true se ainda dentro do período
 *   libera_em:   ISOString|null — quando libera
 *   dias_restantes: int   — dias inteiros até liberar (0 se já liberou)
 *   ms_restantes:   int   — ms exatos até liberar
 *   motivo: string        — 'liberado' | 'sem_subida_registrada' | 'em_carencia'
 */
function calcularCarencia(nivelDesde) {
  // Sem registro — assume liberado (motoboy antigo, retroativo)
  if (!nivelDesde) {
    return {
      em_carencia: false,
      libera_em: null,
      dias_restantes: 0,
      ms_restantes: 0,
      motivo: 'sem_subida_registrada',
    };
  }

  const entrou = new Date(nivelDesde);
  const liberaEm = new Date(entrou.getTime() + CARENCIA_SCORE_MS);
  const agora = new Date();
  const msRestantes = liberaEm.getTime() - agora.getTime();

  if (msRestantes <= 0) {
    return {
      em_carencia: false,
      libera_em: liberaEm.toISOString(),
      dias_restantes: 0,
      ms_restantes: 0,
      motivo: 'liberado',
    };
  }

  const diasRestantes = Math.ceil(msRestantes / (24 * 60 * 60 * 1000));

  return {
    em_carencia: true,
    libera_em: liberaEm.toISOString(),
    dias_restantes: diasRestantes,
    ms_restantes: msRestantes,
    motivo: 'em_carencia',
  };
}

/**
 * 🆕 2026-05 v4: calcula há quantos dias o motoboy está no nível atual.
 * Usado pra elegibilidade do sorteio (mínimo 20 dias).
 *
 * @param {Date|null} nivelDesde
 * @returns {number} dias inteiros no nível (0 se sem registro)
 */
function diasNoNivel(nivelDesde) {
  if (!nivelDesde) return 9999; // sem registro = motoboy antigo, considera elegível
  const ms = Date.now() - new Date(nivelDesde).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

// 🆕 2026-05 v4: mínimo de dias no nível pra concorrer ao sorteio
const SORTEIO_DIAS_MIN_NIVEL = parseInt(process.env.SORTEIO_DIAS_MIN_NIVEL, 10) || 20;

/**
 * 🔧 Helper de normalização de região pra SQL.
 * Match case + acento + espaço insensitive.
 * Use assim:
 *   `WHERE ${SQL_NORM_REGIAO('coluna')} = ${SQL_NORM_REGIAO('$1::text')}`
 */
const ACENTOS_DE = 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿ';
const ACENTOS_PARA = 'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyy';
function SQL_NORM_REGIAO(expr) {
  return `TRIM(UPPER(translate(${expr}, '${ACENTOS_DE}', '${ACENTOS_PARA}')))`;
}

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
async function calcularNivelMotoboy(pool, codProf, cfg = null) {
  // Resolve thresholds (config da região OU defaults)
  const thresholds = resolverThresholds(cfg);

  const codProfInt = parseInt(codProf, 10);
  if (!Number.isFinite(codProfInt)) {
    console.warn('[score-v2] cod_prof não é número:', codProf);
    return {
      nivel: 1,
      stats: { entregas: 0, dias_16h: 0, pct_prazo: 0 },
      progresso: montarProgresso({ entregas: 0, dias_16h: 0, pct_prazo: 0 }, 2, thresholds),
    };
  }
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_entregas,
      COUNT(*) FILTER (
        WHERE hora_solicitado IS NOT NULL AND EXTRACT(HOUR FROM hora_solicitado) >= $2
      )::int AS dias_16h,
      CASE 
        WHEN COUNT(*) > 0 THEN
          ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / COUNT(*), 2)
        ELSE 0
      END AS pct_prazo
    FROM bi_entregas
    WHERE cod_prof = $1
      AND data_solicitado >= (CURRENT_DATE - INTERVAL '27 days')::date
      AND data_solicitado <= CURRENT_DATE
  `, [codProfInt, HORA_CORTE_NOTURNO]);
  // 🔧 2026-05: dias_16h agora é QUANTIDADE TOTAL de entregas após 16h
  // (não mais "dias distintos"). Nome da chave/coluna mantido pra não migrar banco.

  const stats = {
    entregas: parseInt(result.rows[0].total_entregas) || 0,
    dias_16h: parseInt(result.rows[0].dias_16h) || 0,
    pct_prazo: parseFloat(result.rows[0].pct_prazo) || 0,
  };

  // 🚀 2026-05: lógica nova SEM faixa (≥80% = N2, ≥88% sobe pra N3)
  // Quem tem entregas/dias suficientes mas % menor que pct_prazo_min do N2 → fica N1
  let nivel = 1;
  if (
    stats.entregas >= thresholds.n3.entregas_min &&
    stats.dias_16h >= thresholds.n3.dias_16h_min &&
    stats.pct_prazo >= thresholds.n3.pct_prazo_min
  ) {
    nivel = 3;
  } else if (
    stats.entregas >= thresholds.n2.entregas_min &&
    stats.dias_16h >= thresholds.n2.dias_16h_min &&
    stats.pct_prazo >= thresholds.n2.pct_prazo_min
  ) {
    nivel = 2;
  }

  // Calcula progresso pro PRÓXIMO nível (mostrar barra ao motoboy)
  let progresso = null;
  if (nivel === 1) {
    progresso = montarProgresso(stats, 2, thresholds);
  } else if (nivel === 2) {
    progresso = montarProgresso(stats, 3, thresholds);
  }

  return { nivel, stats, progresso, thresholds };
}

function montarProgresso(stats, alvo, thresholds) {
  const config = alvo === 3 ? thresholds.n3 : thresholds.n2;
  const reqs = [
    {
      metrica: 'entregas',
      label: 'Entregas no período (28 dias)',
      atual: stats.entregas,
      meta: config.entregas_min,
      ok: stats.entregas >= config.entregas_min,
      pct: Math.min(100, Math.round((stats.entregas / Math.max(config.entregas_min, 1)) * 100)),
    },
    {
      metrica: 'dias_16h',
      label: 'Entregas após 16h',
      atual: stats.dias_16h,
      meta: config.dias_16h_min,
      ok: stats.dias_16h >= config.dias_16h_min,
      pct: Math.min(100, Math.round((stats.dias_16h / Math.max(config.dias_16h_min, 1)) * 100)),
    },
    {
      metrica: 'pct_prazo',
      label: '% no prazo',
      atual: stats.pct_prazo,
      meta: config.pct_prazo_min,
      ok: stats.pct_prazo >= config.pct_prazo_min,
      pct: Math.min(100, Math.round((stats.pct_prazo / Math.max(config.pct_prazo_min, 1)) * 100)),
      sufixo: '%',
    },
  ];
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

  // 🔧 FIX (2026-05): timestamps via parâmetro explícito (evita SQL dinâmico frágil)
  const subidaTs = subiu ? new Date() : null;
  const descidaTs = desceu ? new Date() : null;
  // 🆕 2026-05 v4: nivel_desde reseta em QUALQUER mudança (subida ou descida).
  // Se não mudou, mantém o valor atual (COALESCE no UPDATE abaixo).
  const nivelDesdeTs = mudou ? new Date() : null;

  await pool.query(`
    INSERT INTO score_nivel_motoboy (
      cod_prof, nome_prof, regiao, nivel_atual,
      entregas_periodo, dias_16h_periodo, pct_prazo,
      avaliado_em, ultima_subida_em, ultima_descida_em, nivel_desde, historico_mudancas
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, COALESCE($10, NOW()), $11::jsonb
    )
    ON CONFLICT (cod_prof) DO UPDATE SET
      nome_prof = EXCLUDED.nome_prof,
      regiao = EXCLUDED.regiao,
      nivel_atual = EXCLUDED.nivel_atual,
      entregas_periodo = EXCLUDED.entregas_periodo,
      dias_16h_periodo = EXCLUDED.dias_16h_periodo,
      pct_prazo = EXCLUDED.pct_prazo,
      avaliado_em = NOW(),
      ultima_subida_em = COALESCE(EXCLUDED.ultima_subida_em, score_nivel_motoboy.ultima_subida_em),
      ultima_descida_em = COALESCE(EXCLUDED.ultima_descida_em, score_nivel_motoboy.ultima_descida_em),
      nivel_desde = COALESCE($10, score_nivel_motoboy.nivel_desde),
      historico_mudancas = EXCLUDED.historico_mudancas
  `, [
    String(codProf), nomeProf, regiao, nivel,
    stats.entregas, stats.dias_16h, stats.pct_prazo,
    subidaTs, descidaTs, nivelDesdeTs,
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

  // 🆕 2026-05 v4: respeita carência de 7 dias a partir de nivel_desde.
  // nivel_desde reseta em QUALQUER mudança de nível — então cair de N3 pra N2
  // também reinicia a carência (regra confirmada: cai pro N2 → nova carência).
  const subidaRow = await pool.query(
    `SELECT nivel_desde FROM score_nivel_motoboy WHERE cod_prof = $1`,
    [String(codProf)]
  );
  const nivelDesde = subidaRow.rows[0]?.nivel_desde || null;
  const carencia = calcularCarencia(nivelDesde);

  if (carencia.em_carencia) {
    return {
      lancado: false,
      motivo: 'em_carencia',
      dias_restantes: carencia.dias_restantes,
      libera_em: carencia.libera_em,
    };
  }

  // Busca config da região (pra teto customizado)
  const cfg = await pool.query(
    `SELECT saque_teto_n2, saque_teto_n3, ativo FROM score_config_regiao
     WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')}`,
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
  // 1. Identifica motoboy + região via helper compartilhado
  // 🚀 2026-05: usa profissionaisLookup.buscarProfissional() que faz
  // cascata CRM → Planilha Google Sheets → disponibilidade_linhas → users.
  // Mesma fonte usada por avisos, promo-novatos, indicações.
  let nome = null;
  let regiao = null;
  let fonte = null;

  try {
    const prof = await buscarProfissional(pool, codProf);
    if (prof) {
      nome = prof.nome;
      regiao = prof.regiao || prof.cidade;
      fonte = prof.origem;
    }
  } catch (err) {
    console.warn('[score-v2] buscarProfissional falhou:', err.message);
  }

  console.log(`[score-v2] cod=${codProf} fonte=${fonte} nome="${nome}" regiao="${regiao}"`);

  if (!nome && !regiao) {
    return { erro: 'profissional_nao_encontrado', cod_prof: codProf };
  }

  // 2. Confere se a região tem score ativo
  // 🔧 FIX (2026-05): match agressivo case + acentos + espaços via SQL_NORM_REGIAO.
  // Antes só fazia UPPER(); falhava com "Salvador " vs "Salvador" ou "Goiânia" vs "GOIANIA".
  let regiaoConfigurada = false;
  let regiaoConfig = null;
  if (regiao) {
    // 🚀 Puxa TODAS as colunas da config (incluindo thresholds customizados)
    const cfg = await pool.query(`
      SELECT * FROM score_config_regiao
      WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')}
      LIMIT 1
    `, [regiao]);
    regiaoConfigurada = cfg.rows.length > 0 && cfg.rows[0].ativo === true;
    if (cfg.rows.length > 0) regiaoConfig = cfg.rows[0];
    console.log(`[score-v2] cod=${codProf} regiao_motoboy="${regiao}" config_match=${cfg.rows.length > 0 ? `id${cfg.rows[0].id} regiao="${cfg.rows[0].regiao}" ativo=${cfg.rows[0].ativo}` : 'NENHUM'}`);
  } else {
    console.log(`[score-v2] cod=${codProf} sem regiao no CRM`);
  }

  if (!regiaoConfigurada) {
    return {
      regiao_configurada: false,
      regiao,
      mensagem: regiao
        ? `Score não está ativo para a região "${regiao}"`
        : 'Sua região não está cadastrada no sistema',
      debug: {
        regiao_motoboy: regiao,
        config_encontrada: regiaoConfig,
      },
    };
  }

  // 3. Calcula nível atual usando thresholds da região
  const { nivel, stats, progresso, thresholds } = await calcularNivelMotoboy(pool, codProf, regiaoConfig);

  // 4. Persiste (snapshot + histórico de mudanças)
  // 🔧 FIX: usa a grafia canônica da config (regiaoConfig.regiao) em vez da do CRM/planilha,
  // que pode ter variações como "GOIANIA" vs "Goiânia". Isso garante que todo motoboy da
  // mesma região salva com o mesmo texto, e contagens/filtros ficam consistentes.
  const regiaoCanonica = regiaoConfig?.regiao || regiao;
  const persistencia = await persistirNivelMotoboy(pool, {
    codProf, nomeProf: nome, regiao: regiaoCanonica, nivel, stats,
  });

  // 5. Se está em nível 2 ou 3, tenta lançar bônus do período (idempotente).
  // 2026-05 v3: pode bater na carência de 7 dias e retornar lancado:false
  // com motivo:'em_carencia' — o frontend usa isso pra mostrar contagem regressiva.
  let bonusLancado = null;
  if (nivel >= 2) {
    bonusLancado = await lancarBonusSeAplicavel(pool, {
      codProf, nomeProf: nome, regiao: regiaoCanonica, nivel,
    });
  }

  // 6. Estado de carência + dias no nível
  // 🆕 2026-05 v4: usa nivel_desde (reseta em qualquer mudança de nível).
  const subidaRow = await pool.query(
    `SELECT nivel_desde FROM score_nivel_motoboy WHERE cod_prof = $1`,
    [String(codProf)]
  );
  const nivelDesde = subidaRow.rows[0] ? subidaRow.rows[0].nivel_desde : null;
  const carencia = calcularCarencia(nivelDesde);
  const dias_no_nivel = diasNoNivel(nivelDesde);
  const elegivel_sorteio = nivel >= 2 && dias_no_nivel >= SORTEIO_DIAS_MIN_NIVEL;

  // 7. 🆕 2026-05 v4: grava snapshot semanal (idempotente via UNIQUE)
  try {
    const semanaRef = `${new Date().getFullYear()}-W${String(isoWeek(new Date())).padStart(2, '0')}`;
    await pool.query(`
      INSERT INTO score_snapshots_semanais
        (cod_prof, nome_prof, regiao, nivel, entregas, entregas_16h, pct_prazo, semana_referencia)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (cod_prof, semana_referencia) DO UPDATE SET
        nivel = EXCLUDED.nivel, entregas = EXCLUDED.entregas,
        entregas_16h = EXCLUDED.entregas_16h, pct_prazo = EXCLUDED.pct_prazo,
        avaliado_em = NOW()
    `, [String(codProf), nome, regiaoCanonica, nivel, stats.entregas, stats.dias_16h, stats.pct_prazo, semanaRef]);
  } catch (errSnap) {
    console.warn('[score-v2] snapshot semanal falhou (não-crítico):', errSnap.message);
  }

  return {
    regiao_configurada: true,
    regiao,
    nivel,
    stats,
    progresso,
    thresholds, // 🚀 enviado pro frontend mostrar critérios reais da região no roadmap
    // Valores monetários da config (pro roadmap mostrar)
    sorteio_valor_n2: regiaoConfig?.sorteio_valor_n2 != null ? Number(regiaoConfig.sorteio_valor_n2) : 50,
    sorteio_valor_n3: regiaoConfig?.sorteio_valor_n3 != null ? Number(regiaoConfig.sorteio_valor_n3) : 150,
    saque_teto_n2: regiaoConfig?.saque_teto_n2 != null ? Number(regiaoConfig.saque_teto_n2) : 500,
    saque_teto_n3: regiaoConfig?.saque_teto_n3 != null ? Number(regiaoConfig.saque_teto_n3) : 500,
    mudou: persistencia.mudou,
    subiu: persistencia.subiu,
    desceu: persistencia.desceu,
    nivel_anterior: persistencia.de,
    bonus: bonusLancado,
    // 🆕 2026-05 v3: estado de carência (frontend mostra contagem regressiva)
    carencia,
    // 🆕 2026-05 v4: dias no nível + elegibilidade do sorteio
    dias_no_nivel,
    elegivel_sorteio,
    sorteio_dias_min: SORTEIO_DIAS_MIN_NIVEL,
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

        // Lista candidatos: motoboys da região no nível há SORTEIO_DIAS_MIN_NIVEL+ dias.
        // 🆕 2026-05 v4: nivel_desde garante que só concorre quem está ESTÁVEL
        // no nível há pelo menos 20 dias (quem subiu/oscilou recente fica de fora).
        const candidatos = await pool.query(`
          SELECT cod_prof, nome_prof
          FROM score_nivel_motoboy
          WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')}
            AND nivel_atual = $2
            AND (
              nivel_desde IS NULL
              OR nivel_desde <= (NOW() - ($3 || ' days')::interval)
            )
        `, [r.regiao, nivel, String(SORTEIO_DIAS_MIN_NIVEL)]);

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

// ============================================================
// PRÉ-AVALIAÇÃO EM MASSA (popular score_nivel_motoboy de uma região)
// ============================================================

/**
 * Avalia TODOS os motoboys de uma região (CRM + Planilha) de uma vez.
 *
 * Usado quando o admin salva uma config nova: dispara em background pra
 * popular score_nivel_motoboy com todo mundo da região, sem esperar
 * cada motoboy abrir a tela.
 *
 * Match de região é case+acento+espaço insensitive (mesmo helper SQL).
 *
 * Em vez de processar 5000 motoboys em paralelo (estoura o pool), processa
 * em batches de 25. Total controlado por MAX_MOTOBOYS (default 5000).
 *
 * Retorno: { regiao, total_encontrados, processados, niveis: {1,2,3} }
 */
async function avaliarRegiaoCompleta(pool, regiao, opts = {}) {
  const MAX_MOTOBOYS = opts.maxMotoboys || 5000;
  const BATCH_SIZE = opts.batchSize || 25;

  console.log(`🔄 [Score v2] Pré-avaliando regiao="${regiao}" (max ${MAX_MOTOBOYS}, batch ${BATCH_SIZE})`);

  // 1. Lista todos os profissionais (CRM + Planilha)
  let todos;
  try {
    todos = await listarProfissionais(pool);
  } catch (err) {
    console.error('[Score v2] Falha ao listar profissionais:', err.message);
    return { erro: err.message };
  }

  // 2. Filtra os da região (normalizando p/ comparar)
  const normalizar = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .trim()
    .toUpperCase();
  const regiaoAlvo = normalizar(regiao);

  const daRegiao = todos.filter(p => {
    const r = normalizar(p.regiao || p.cidade || '');
    return r === regiaoAlvo;
  });

  console.log(`  📋 ${daRegiao.length} motoboys encontrados em "${regiao}" (de ${todos.length} total)`);

  if (daRegiao.length === 0) {
    return { regiao, total_encontrados: 0, processados: 0, niveis: { 1: 0, 2: 0, 3: 0 } };
  }

  const limitados = daRegiao.slice(0, MAX_MOTOBOYS);
  const niveis = { 1: 0, 2: 0, 3: 0 };
  let processados = 0;
  let erros = 0;

  // 3. Processa em batches paralelos pra não estourar o pool
  for (let i = 0; i < limitados.length; i += BATCH_SIZE) {
    const batch = limitados.slice(i, i + BATCH_SIZE);
    const resultados = await Promise.allSettled(
      batch.map(p => avaliarMotoboy(pool, p.codigo))
    );
    for (const r of resultados) {
      processados++;
      if (r.status === 'rejected') {
        erros++;
        continue;
      }
      const nivel = r.value?.nivel;
      if (nivel === 3) niveis[3]++;
      else if (nivel === 2) niveis[2]++;
      else niveis[1]++;
    }
  }

  console.log(`  ✅ ${processados} processados (${erros} erros) — N1: ${niveis[1]}, N2: ${niveis[2]}, N3: ${niveis[3]}`);

  return {
    regiao,
    total_encontrados: daRegiao.length,
    processados,
    erros,
    niveis,
  };
}

// ============================================================
// 🆕 2026-05 v4: LEITURA DO NÍVEL (sem recalcular)
// ============================================================
// O GET /meu-nivel passa a SÓ LER o nível congelado da última avaliação
// de sábado. O nível não muda quando o motoboy abre a tela — só no cron
// semanal. A barra de progresso continua sendo calculada ao vivo (mostra
// "se a avaliação fosse agora..."), mas o NÍVEL é estável.

async function lerNivelMotoboy(pool, codProf) {
  // 1. Identifica motoboy + região
  let nome = null, regiao = null;
  try {
    const prof = await buscarProfissional(pool, codProf);
    if (prof) { nome = prof.nome; regiao = prof.regiao || prof.cidade; }
  } catch (err) {
    console.warn('[score-v2] buscarProfissional falhou:', err.message);
  }
  if (!nome && !regiao) {
    return { erro: 'profissional_nao_encontrado', cod_prof: codProf };
  }

  // 2. Config da região
  let regiaoConfig = null;
  if (regiao) {
    const cfg = await pool.query(`
      SELECT * FROM score_config_regiao
      WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')} LIMIT 1
    `, [regiao]);
    if (cfg.rows.length > 0) regiaoConfig = cfg.rows[0];
  }
  if (!regiaoConfig || regiaoConfig.ativo !== true) {
    return {
      regiao_configurada: false,
      regiao,
      mensagem: regiao
        ? `Score não está ativo para a região "${regiao}"`
        : 'Sua região não está cadastrada no sistema',
    };
  }

  const thresholds = resolverThresholds(regiaoConfig);

  // 3. Lê o nível CONGELADO (última avaliação semanal)
  const row = await pool.query(
    `SELECT nivel_atual, entregas_periodo, dias_16h_periodo, pct_prazo,
            avaliado_em, nivel_desde, ultima_subida_em
       FROM score_nivel_motoboy WHERE cod_prof = $1`,
    [String(codProf)]
  );

  // Motoboy ainda não avaliado (nunca rodou o cron pra ele) — nível 1 provisório
  const nivel = row.rows[0] ? row.rows[0].nivel_atual : 1;
  const nivelDesde = row.rows[0] ? row.rows[0].nivel_desde : null;
  const avaliadoEm = row.rows[0] ? row.rows[0].avaliado_em : null;

  // 4. Stats AO VIVO (pra barra de progresso — mostra situação atual)
  const { stats: statsAoVivo } = await calcularNivelMotoboy(pool, codProf, regiaoConfig);

  // Progresso pro próximo nível (baseado no nível CONGELADO + stats ao vivo)
  let progresso = null;
  if (nivel === 1) progresso = montarProgresso(statsAoVivo, 2, thresholds);
  else if (nivel === 2) progresso = montarProgresso(statsAoVivo, 3, thresholds);

  const carencia = calcularCarencia(nivelDesde);
  const dias_no_nivel = diasNoNivel(nivelDesde);
  const elegivel_sorteio = nivel >= 2 && dias_no_nivel >= SORTEIO_DIAS_MIN_NIVEL;

  return {
    regiao_configurada: true,
    regiao,
    nivel,
    // stats congelados da última avaliação + stats ao vivo (pra barra)
    stats: {
      entregas: row.rows[0] ? row.rows[0].entregas_periodo : statsAoVivo.entregas,
      dias_16h: row.rows[0] ? row.rows[0].dias_16h_periodo : statsAoVivo.dias_16h,
      pct_prazo: row.rows[0] ? Number(row.rows[0].pct_prazo) : statsAoVivo.pct_prazo,
    },
    stats_ao_vivo: statsAoVivo,
    progresso,
    thresholds,
    sorteio_valor_n2: regiaoConfig.sorteio_valor_n2 != null ? Number(regiaoConfig.sorteio_valor_n2) : 50,
    sorteio_valor_n3: regiaoConfig.sorteio_valor_n3 != null ? Number(regiaoConfig.sorteio_valor_n3) : 150,
    saque_teto_n2: regiaoConfig.saque_teto_n2 != null ? Number(regiaoConfig.saque_teto_n2) : 500,
    saque_teto_n3: regiaoConfig.saque_teto_n3 != null ? Number(regiaoConfig.saque_teto_n3) : 500,
    carencia,
    dias_no_nivel,
    elegivel_sorteio,
    sorteio_dias_min: SORTEIO_DIAS_MIN_NIVEL,
    avaliado_em: avaliadoEm,
    // sinaliza pro frontend que o nível é semanal (avaliado aos sábados)
    avaliacao_semanal: true,
  };
}

// ============================================================
// 🆕 2026-05 v4: AVALIAÇÃO DE TODAS AS REGIÕES (cron semanal)
// ============================================================
// Chamado pelo cron de sábado 12h. Percorre cada região ativa e roda
// avaliarRegiaoCompleta. Retorna lista de quem mudou de nível — preparado
// pra disparar notificação no futuro (quando houver telefone do motoboy).

async function avaliarTodasRegioes(pool) {
  console.log('📅 [Score v2] Avaliação semanal — iniciando...');
  const regioes = await pool.query(
    `SELECT regiao FROM score_config_regiao WHERE ativo = true`
  );
  const resumo = { regioes: 0, processados: 0, mudancas: [] };

  for (const r of regioes.rows) {
    try {
      // Snapshot dos níveis ANTES (pra detectar quem mudou)
      const antes = await pool.query(
        `SELECT cod_prof, nivel_atual FROM score_nivel_motoboy
          WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')}`,
        [r.regiao]
      );
      const mapaAntes = {};
      antes.rows.forEach(x => { mapaAntes[String(x.cod_prof)] = x.nivel_atual; });

      const res = await avaliarRegiaoCompleta(pool, r.regiao);
      resumo.regioes++;
      resumo.processados += res.processados || 0;

      // Detecta mudanças (compara depois com antes)
      const depois = await pool.query(
        `SELECT cod_prof, nome_prof, nivel_atual FROM score_nivel_motoboy
          WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')}`,
        [r.regiao]
      );
      for (const x of depois.rows) {
        const antesNivel = mapaAntes[String(x.cod_prof)] || 1;
        if (antesNivel !== x.nivel_atual) {
          resumo.mudancas.push({
            cod_prof: x.cod_prof,
            nome: x.nome_prof,
            regiao: r.regiao,
            de: antesNivel,
            para: x.nivel_atual,
            tipo: x.nivel_atual > antesNivel ? 'subiu' : 'desceu',
          });
        }
      }
    } catch (err) {
      console.error(`❌ [Score v2] Avaliação semanal ${r.regiao}:`, err.message);
    }
  }

  console.log(`📅 [Score v2] Avaliação semanal concluída — ${resumo.regioes} regiões, ${resumo.processados} motoboys, ${resumo.mudancas.length} mudanças de nível`);
  // 🔔 TODO (notificação): quando houver telefone do motoboy cadastrado,
  // percorrer resumo.mudancas e disparar mensagem via Evolution aqui.
  return resumo;
}

module.exports = {
  // Constantes
  NIVEL_2,
  NIVEL_3,
  HORA_CORTE_NOTURNO,
  JANELA_DIAS,
  CARENCIA_SCORE_DIAS,
  // Calculo
  calcularNivelMotoboy,
  persistirNivelMotoboy,
  lancarBonusSeAplicavel,
  calcularCarencia,
  diasNoNivel,
  // Pipeline alto nível
  avaliarMotoboy,
  avaliarRegiaoCompleta,
  avaliarTodasRegioes,
  lerNivelMotoboy,
  // Sorteio
  rodarSorteiosMensais,
};
