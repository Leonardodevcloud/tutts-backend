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
// 🆕 2026-06: notificacao 1-pra-1 do ganhador do sorteio (Evolution).
const { enviarParaMotoboy } = require('../../shared/whatsapp-motoboy');

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

// 🆕 2026-07: MODELO NOVO. Qualidade (% no prazo) define o nivel merecido;
// presenca no pico (dias com entrega apos o corte) destrava/veta; volume vira
// so porta de entrada. Todos os valores sao configuraveis por praca.
const MODELO_DEFAULT = {
  min_entregas_elegivel: 40,
  pct_prata: 85.0,
  pct_ouro: 92.0,
  dias_pico_prata: 12,
  dias_pico_ouro: 18,
  hora_corte_pico: 16,
};

/**
 * Resolve os parametros do modelo novo a partir da config da praca.
 * Campo NULL/ausente cai no default. Config inteira null = defaults puros.
 */
function resolverConfigModelo(cfg) {
  return {
    min_elegivel: cfg?.min_entregas_elegivel != null ? parseInt(cfg.min_entregas_elegivel, 10) : MODELO_DEFAULT.min_entregas_elegivel,
    pct_prata: cfg?.pct_prata != null ? parseFloat(cfg.pct_prata) : MODELO_DEFAULT.pct_prata,
    pct_ouro: cfg?.pct_ouro != null ? parseFloat(cfg.pct_ouro) : MODELO_DEFAULT.pct_ouro,
    dias_pico_prata: cfg?.dias_pico_prata != null ? parseInt(cfg.dias_pico_prata, 10) : MODELO_DEFAULT.dias_pico_prata,
    dias_pico_ouro: cfg?.dias_pico_ouro != null ? parseInt(cfg.dias_pico_ouro, 10) : MODELO_DEFAULT.dias_pico_ouro,
    hora_corte: cfg?.hora_corte_pico != null ? parseInt(cfg.hora_corte_pico, 10) : MODELO_DEFAULT.hora_corte_pico,
  };
}

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

// 🆕 2026-06: janela da regra de aproveitamento semanal (últimos 7 dias).
const JANELA_APROVEITAMENTO_DIAS = 7;

// ============================================================
// 🆕 2026-06: NOVA RÉGUA DE PRAZO (padrão de TODO o score)
// ============================================================
// O prazo passa a contar do ACEITE da corrida (data_hora_alocado) até
// finalizado — NÃO mais da criação. Régua por faixa de distância:
//   ≤10km=50  ≤15=60  ≤20=70  ≤25=80  ≤30=90  ≤35=100  ≤40=110  ≤50=120
//   acima de 50km: trava em 120 min.
// Aplicada tanto no nível (N1/N2/N3) quanto na regra de aproveitamento.
const PRAZO_REGUA_SQL = `(CASE
  WHEN distancia <= 10 THEN 50
  WHEN distancia <= 15 THEN 60
  WHEN distancia <= 20 THEN 70
  WHEN distancia <= 25 THEN 80
  WHEN distancia <= 30 THEN 90
  WHEN distancia <= 35 THEN 100
  WHEN distancia <= 40 THEN 110
  WHEN distancia <= 50 THEN 120
  ELSE 120
END)`;

// Tempo do profissional em minutos: do aceite (data_hora_alocado) até finalizado.
const TEMPO_PROF_MIN_SQL = `CASE
  WHEN finalizado IS NOT NULL AND data_hora_alocado IS NOT NULL
  THEN EXTRACT(EPOCH FROM (finalizado - data_hora_alocado)) / 60.0
  ELSE NULL
END`;

// Uma entrega é "avaliável" pro prazo quando dá pra medir tempo e distância.
const ENTREGA_AVALIAVEL_SQL = `finalizado IS NOT NULL AND data_hora_alocado IS NOT NULL AND distancia IS NOT NULL`;

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
  // 🆕 2026-07: modelo novo (qualidade define + presenca no pico destrava)
  const modelo = resolverConfigModelo(cfg);

  const codProfInt = parseInt(codProf, 10);
  if (!Number.isFinite(codProfInt)) {
    console.warn('[score-v2] cod_prof não é número:', codProf);
    return {
      nivel: 1,
      stats: { entregas: 0, dias_16h: 0, pct_prazo: 0 },
      progresso: montarProgresso({ entregas: 0, dias_16h: 0, pct_prazo: 0 }, 2, modelo),
    };
  }
  const result = await pool.query(`
    WITH base AS (
      SELECT
        data_solicitado,
        hora_solicitado,
        distancia,
        ${PRAZO_REGUA_SQL} AS prazo_regua,
        (${TEMPO_PROF_MIN_SQL}) AS tempo_prof_min,
        (${ENTREGA_AVALIAVEL_SQL}) AS avaliavel
      FROM bi_entregas
      WHERE cod_prof = $1
        AND COALESCE(ponto, 1) >= 2
        AND data_solicitado >= (CURRENT_DATE - INTERVAL '27 days')::date
        AND data_solicitado <= CURRENT_DATE
    )
    SELECT
      COUNT(*)::int AS total_entregas,
      COUNT(DISTINCT data_solicitado) FILTER (
        WHERE hora_solicitado IS NOT NULL AND EXTRACT(HOUR FROM hora_solicitado) >= $2
      )::int AS dias_pico,
      CASE
        WHEN COUNT(*) FILTER (WHERE avaliavel) > 0 THEN
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE avaliavel AND tempo_prof_min <= prazo_regua)
            / COUNT(*) FILTER (WHERE avaliavel), 2)
        ELSE 0
      END AS pct_prazo
    FROM base
  `, [codProfInt, modelo.hora_corte]);
  // 🆕 2026-07: dias_pico = DIAS DISTINTOS com >=1 entrega apos o corte (presenca
  // recorrente no pico), nao mais a quantidade total. Hora de corte vem da praca.
  // total_entregas e pct_prazo alinhados com o BI (ponto>=2, sobre avaliaveis).

  const stats = {
    entregas: parseInt(result.rows[0].total_entregas) || 0,
    dias_16h: parseInt(result.rows[0].dias_pico) || 0, // dias distintos no pico (chave mantida p/ persistencia)
    pct_prazo: parseFloat(result.rows[0].pct_prazo) || 0,
  };

  // 🆕 2026-07: MODELO NOVO. Qualidade define o nivel merecido; presenca no pico
  // destrava (teto); porta de entrada filtra quem tem poucos dados. Nivel final =
  // o MENOR entre o que a qualidade da e o que a presenca permite.
  let nivel = 1;
  if (stats.entregas >= modelo.min_elegivel) {
    let candQualidade = 1;
    if (stats.pct_prazo >= modelo.pct_ouro) candQualidade = 3;
    else if (stats.pct_prazo >= modelo.pct_prata) candQualidade = 2;

    let tetoPresenca = 1;
    if (stats.dias_16h >= modelo.dias_pico_ouro) tetoPresenca = 3;
    else if (stats.dias_16h >= modelo.dias_pico_prata) tetoPresenca = 2;

    nivel = Math.min(candQualidade, tetoPresenca);
  }

  // Progresso pro próximo nível (barra ao motoboy)
  let progresso = null;
  if (nivel === 1) {
    progresso = montarProgresso(stats, 2, modelo);
  } else if (nivel === 2) {
    progresso = montarProgresso(stats, 3, modelo);
  }

  return { nivel, stats, progresso, modelo };
}

function montarProgresso(stats, alvo, modelo) {
  const pctMeta = alvo === 3 ? modelo.pct_ouro : modelo.pct_prata;
  const diasMeta = alvo === 3 ? modelo.dias_pico_ouro : modelo.dias_pico_prata;
  const reqs = [
    {
      metrica: 'elegibilidade',
      label: 'Entregas no período (mínimo pra competir)',
      atual: stats.entregas,
      meta: modelo.min_elegivel,
      ok: stats.entregas >= modelo.min_elegivel,
      pct: Math.min(100, Math.round((stats.entregas / Math.max(modelo.min_elegivel, 1)) * 100)),
    },
    {
      metrica: 'pct_prazo',
      label: '% no prazo',
      atual: stats.pct_prazo,
      meta: pctMeta,
      ok: stats.pct_prazo >= pctMeta,
      pct: Math.min(100, Math.round((stats.pct_prazo / Math.max(pctMeta, 1)) * 100)),
      sufixo: '%',
    },
    {
      metrica: 'dias_pico',
      label: `Dias com entrega após ${modelo.hora_corte}h`,
      atual: stats.dias_16h,
      meta: diasMeta,
      ok: stats.dias_16h >= diasMeta,
      pct: Math.min(100, Math.round((stats.dias_16h / Math.max(diasMeta, 1)) * 100)),
    },
  ];
  return { proximo_nivel: alvo, requisitos: reqs };
}

function montarProgressoLegado(stats, alvo, thresholds) {
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

  // 3. Calcula nível atual (modelo novo: qualidade + presença)
  const { nivel, stats, progresso, modelo } = await calcularNivelMotoboy(pool, codProf, regiaoConfig);

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
    modelo, // 🆕 parâmetros do modelo novo (pro frontend mostrar as metas da praça)
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
async function rodarSorteiosMensais(pool, mesRef, opts = {}) {
  console.log(`🎲 [Score v2] Rodando sorteios para ${mesRef}...`);

  // 🆕 2026-07: FIX "sorteando fora do patamar" — reavalia todas as praças ativas
  // ANTES de sortear, pra que score_nivel_motoboy.nivel_atual reflita a realidade
  // (o snapshot só atualizava quando o motoboy abria a tela / no cron de sábado, então
  // gente que havia caído de nível continuava congelada no nível antigo e era sorteada).
  // Pode desligar com { reavaliar: false } (ex: refazer um mês antigo sem mexer no nível de agora).
  const reavaliar = opts.reavaliar !== false;
  if (reavaliar) {
    try {
      const ativas = await pool.query(`SELECT regiao FROM score_config_regiao WHERE ativo = true`);
      console.log(`  🔄 [sorteio] reavaliando ${ativas.rows.length} praça(s) antes de sortear...`);
      for (const rr of ativas.rows) {
        try { await avaliarRegiaoCompleta(pool, rr.regiao); }
        catch (e) { console.error(`  ⚠️ [sorteio] reavaliar "${rr.regiao}":`, e.message); }
      }
    } catch (e) {
      console.error('  ⚠️ [sorteio] reavaliação prévia falhou (segue com snapshot atual):', e.message);
    }
  }

  // 🆕 2026-06: congela a colocacao do mes ANTES de sortear (mesmo regioes
  // sem candidato ficam registradas, pra dar pra ver a colocacao depois).
  try {
    await congelarRankingMensal(pool, mesRef);
  } catch (err) {
    console.error(`  ❌ [ranking] falha ao congelar ${mesRef}:`, err.message);
  }

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
        const insSorteio = await pool.query(`
          INSERT INTO score_sorteios (
            mes_referencia, regiao, nivel, total_participantes,
            vencedor_cod_prof, vencedor_nome, valor, gratuidade_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (mes_referencia, regiao, nivel) DO NOTHING
          RETURNING id
        `, [
          mesRef, r.regiao, nivel, candidatos.rows.length,
          vencedor.cod_prof, vencedor.nome_prof, valor, grat.rows[0].id
        ]);

        // Se nao retornou id, ja existia (mes ja sorteado) — nao duplica nada.
        if (insSorteio.rows.length === 0) {
          console.log(`  ⏭️ ${r.regiao} N${nivel}: ja sorteado para ${mesRef} (ignorado)`);
          continue;
        }
        const sorteioId = insSorteio.rows[0].id;

        // 🆕 Salva a lista de participantes (concorrentes) deste sorteio.
        for (const cand of candidatos.rows) {
          await pool.query(`
            INSERT INTO score_sorteio_participantes (
              sorteio_id, mes_referencia, regiao, nivel, cod_prof, nome_prof, foi_vencedor
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (sorteio_id, cod_prof) DO NOTHING
          `, [
            sorteioId, mesRef, r.regiao, nivel,
            cand.cod_prof, cand.nome_prof, cand.cod_prof === vencedor.cod_prof
          ]).catch((e) => console.error(`  ⚠️ [participante] ${cand.cod_prof}:`, e.message));
        }

        // 🆕 Notifica o ganhador via WhatsApp (Evolution). Fire-and-forget.
        try {
          const u = await pool.query(
            'SELECT whatsapp FROM users WHERE cod_profissional = $1',
            [vencedor.cod_prof]
          );
          const numero = u.rows[0]?.whatsapp;
          if (numero) {
            const valorFmt = Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const msg =
              `🎉 Parabéns, ${vencedor.nome_prof}!\n\n` +
              `Você foi o GANHADOR do sorteio do Score (${r.regiao}) referente a ${mesRef}! 🏆\n\n` +
              `Prêmio: ${valorFmt} em gratuidade (1 saque grátis).\n` +
              `O crédito já está disponível na sua conta. 🚀`;
            enviarParaMotoboy(numero, msg)
              .then((rEnv) => console.log(`  🔔 [sorteio] notificacao ${vencedor.cod_prof}: ${rEnv?.enviado ? 'enviada' : (rEnv?.motivo || 'ignorada')}`))
              .catch(() => {});
          } else {
            console.log(`  🔕 [sorteio] ${vencedor.cod_prof} sem whatsapp cadastrado`);
          }
        } catch (eNotif) {
          console.error(`  ⚠️ [sorteio] erro ao notificar ${vencedor.cod_prof}:`, eNotif.message);
        }

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

  const modeloAoVivo = resolverConfigModelo(regiaoConfig);

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
  if (nivel === 1) progresso = montarProgresso(statsAoVivo, 2, modeloAoVivo);
  else if (nivel === 2) progresso = montarProgresso(statsAoVivo, 3, modeloAoVivo);

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
    modelo: modeloAoVivo,
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

  // 🆕 2026-06: roda a regra de aproveitamento semanal (últimos 7 dias) logo
  // após a avaliação de nível. Só atinge praças com regra_aproveitamento_ativa.
  try {
    const aprov = await avaliarAproveitamentoSemanal(pool);
    resumo.aproveitamento = aprov;
    console.log(`📉 [Score v2] Aproveitamento: ${aprov.alertas} alerta(s) em ${aprov.regioes} praça(s)`);
  } catch (errAprov) {
    console.error('❌ [Score v2] Aproveitamento semanal falhou:', errAprov.message);
  }

  // 🔔 TODO (notificação): quando houver telefone do motoboy cadastrado,
  // percorrer resumo.mudancas e disparar mensagem via Evolution aqui.
  return resumo;
}

/**
 * 🆕 2026-06: Congela a colocação do mês (snapshot por região).
 * Roda junto com o sorteio (dia 1). Como score_nivel_motoboy muda toda
 * semana, sem este congelamento não dá pra ver a colocação passada.
 * Idempotente: UNIQUE(mes, regiao, cod_prof) + ON CONFLICT DO NOTHING.
 */
async function congelarRankingMensal(pool, mesRef) {
  console.log(`🧊 [Score v2] Congelando ranking mensal de ${mesRef}...`);
  const regioes = await pool.query(
    `SELECT regiao FROM score_config_regiao WHERE ativo = true`
  );
  let totalLinhas = 0;
  for (const r of regioes.rows) {
    try {
      const inserted = await pool.query(`
        INSERT INTO score_ranking_mensal
          (mes_referencia, regiao, cod_prof, nome_prof, nivel, entregas, pct_prazo, posicao)
        SELECT
          $1, regiao, cod_prof, nome_prof, nivel_atual,
          COALESCE(entregas_periodo, 0), COALESCE(pct_prazo, 0),
          ROW_NUMBER() OVER (
            ORDER BY nivel_atual DESC, COALESCE(entregas_periodo,0) DESC, COALESCE(pct_prazo,0) DESC
          )
        FROM score_nivel_motoboy
        WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$2::text')}
        ON CONFLICT (mes_referencia, regiao, cod_prof) DO NOTHING
        RETURNING id
      `, [mesRef, r.regiao]);
      totalLinhas += inserted.rows.length;
    } catch (err) {
      console.error(`  ❌ [ranking] ${r.regiao}:`, err.message);
    }
  }
  console.log(`🧊 [Score v2] Ranking ${mesRef} congelado: ${totalLinhas} linha(s)`);
  return { mes: mesRef, linhas: totalLinhas };
}

// ============================================================
// 🆕 2026-06: REGRA DE APROVEITAMENTO SEMANAL (por praça)
// ============================================================
// Todo sábado o cron avalia os ÚLTIMOS 7 DIAS de cada praça com
// regra_aproveitamento_ativa = true. Motoboy abaixo de pct_min_aproveitamento
// vira um alerta (pro admin) + aviso ao abrir o app. Consequência é MANUAL.

/**
 * Calcula o % de aproveitamento (no prazo, do aceite) de um motoboy nos
 * últimos N dias usando a nova régua. Retorna null se não houver entrega
 * avaliável no período.
 */
async function calcularAproveitamento7d(pool, codProf, dias = JANELA_APROVEITAMENTO_DIAS, dataRef = null) {
  const codInt = parseInt(codProf, 10);
  if (!Number.isFinite(codInt)) return null;
  // 🆕 2026-07: fim da janela = dataRef ('YYYY-MM-DD') OU hoje. Permite reprocessar
  // semanas passadas (aba Aproveitamento "processar períodos antigos").
  const temRef = !!dataRef;
  const fimSQL = temRef ? '$3::date' : 'CURRENT_DATE';
  const params = temRef ? [codInt, String(dias - 1), dataRef] : [codInt, String(dias - 1)];
  const r = await pool.query(`
    WITH base AS (
      SELECT
        distancia,
        ${PRAZO_REGUA_SQL} AS prazo_regua,
        (${TEMPO_PROF_MIN_SQL}) AS tempo_prof_min,
        (${ENTREGA_AVALIAVEL_SQL}) AS avaliavel
      FROM bi_entregas
      WHERE cod_prof = $1
        AND COALESCE(ponto, 1) >= 2
        AND data_solicitado >= (${fimSQL} - ($2 || ' days')::interval)::date
        AND data_solicitado <= ${fimSQL}
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE avaliavel)::int AS avaliaveis,
      COUNT(*) FILTER (WHERE avaliavel AND tempo_prof_min <= prazo_regua)::int AS no_prazo
    FROM base
  `, params);
  // 🆕 2026-07: total = entregas reais (ponto>=2), alinhado com o BI. O % de prazo
  // continua sobre as AVALIAVEIS (que tem aceite+distancia+finalizado), pois so
  // essas dao pra medir tempo. Sem nenhuma avaliavel, nao sinaliza.
  const total = parseInt(r.rows[0].total, 10) || 0;
  const avaliaveis = parseInt(r.rows[0].avaliaveis, 10) || 0;
  const noPrazo = parseInt(r.rows[0].no_prazo, 10) || 0;
  if (avaliaveis === 0) return null;
  return { total, avaliaveis, no_prazo: noPrazo, pct: Math.round((10000 * noPrazo) / avaliaveis) / 100 };
}

/**
 * Roda a regra de aproveitamento pra todas as praças com a regra ativa.
 * Registra um alerta por motoboy que ficou abaixo do piso, calculando
 * a reincidência (semanas_consecutivas). Idempotente via UNIQUE.
 */
async function avaliarAproveitamentoSemanal(pool, opts = {}) {
  // 🆕 2026-07: opts.dataRef ('YYYY-MM-DD') define o FIM da janela de 7 dias.
  // Sem dataRef = últimos 7 dias a partir de hoje (comportamento do cron de sábado).
  const dataRef = opts.dataRef || null;
  const refDate = dataRef ? new Date(dataRef + 'T12:00:00') : new Date();
  const semanaRef = opts.semanaRef || `${refDate.getFullYear()}-W${String(isoWeek(refDate)).padStart(2, '0')}`;
  const regioes = await pool.query(`
    SELECT regiao, COALESCE(pct_min_aproveitamento, 95) AS pct_min
    FROM score_config_regiao
    WHERE ativo = true AND regra_aproveitamento_ativa = true
  `);

  let totalAlertas = 0;
  for (const r of regioes.rows) {
    const pctMin = parseFloat(r.pct_min) || 95;
    // Motoboys da praça (usa o snapshot de nível, que já lista todos da região)
    const motoboys = await pool.query(`
      SELECT cod_prof, nome_prof FROM score_nivel_motoboy
      WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')}
    `, [r.regiao]);

    for (const m of motoboys.rows) {
      try {
        const aprov = await calcularAproveitamento7d(pool, m.cod_prof, JANELA_APROVEITAMENTO_DIAS, dataRef);
        if (!aprov) continue; // sem entrega avaliável na semana — não sinaliza
        if (aprov.pct >= pctMin) continue; // dentro do piso — ok

        // Reincidência: olha o alerta anterior (de outra semana) mais recente.
        const ant = await pool.query(`
          SELECT semanas_consecutivas, criado_em
          FROM score_alertas_aproveitamento
          WHERE cod_prof = $1 AND semana_referencia <> $2
          ORDER BY criado_em DESC LIMIT 1
        `, [String(m.cod_prof), semanaRef]);
        let consecutivas = 1;
        if (ant.rows.length > 0) {
          const diasAtras = (Date.now() - new Date(ant.rows[0].criado_em).getTime()) / 86400000;
          if (diasAtras <= 10) consecutivas = (parseInt(ant.rows[0].semanas_consecutivas, 10) || 1) + 1;
        }

        await pool.query(`
          INSERT INTO score_alertas_aproveitamento (
            cod_prof, nome_prof, regiao, semana_referencia,
            pct_prazo, entregas_prazo, entregas_total, pct_min_aplicado, semanas_consecutivas
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (cod_prof, semana_referencia) DO UPDATE SET
            pct_prazo = EXCLUDED.pct_prazo,
            entregas_prazo = EXCLUDED.entregas_prazo,
            entregas_total = EXCLUDED.entregas_total,
            pct_min_aplicado = EXCLUDED.pct_min_aplicado,
            semanas_consecutivas = EXCLUDED.semanas_consecutivas
        `, [
          String(m.cod_prof), m.nome_prof, r.regiao, semanaRef,
          aprov.pct, aprov.no_prazo, aprov.total, pctMin, consecutivas,
        ]);
        totalAlertas++;
      } catch (err) {
        console.error(`  ⚠️ [aproveitamento] ${m.cod_prof}:`, err.message);
      }
    }
  }
  return { semana: semanaRef, regioes: regioes.rows.length, alertas: totalAlertas };
}

/**
 * Lista alertas de aproveitamento de uma praça na semana corrente (pro admin).
 * Reincidentes (mais semanas seguidas) primeiro, depois pior pct.
 */
async function listarAlertasAproveitamento(pool, regiao, semanaRef = null) {
  const semana = semanaRef || `${new Date().getFullYear()}-W${String(isoWeek(new Date())).padStart(2, '0')}`;
  const rows = await pool.query(`
    SELECT cod_prof, nome_prof, regiao, semana_referencia, pct_prazo,
           entregas_prazo, entregas_total, pct_min_aplicado, semanas_consecutivas,
           visto_em, criado_em
    FROM score_alertas_aproveitamento
    WHERE semana_referencia = $1
      ${regiao ? `AND ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$2::text')}` : ''}
    ORDER BY semanas_consecutivas DESC, pct_prazo ASC
  `, regiao ? [semana, regiao] : [semana]);
  return { semana, total: rows.rows.length, alertas: rows.rows };
}

/**
 * Aviso pendente (não visto) do motoboy na semana corrente — pro modal do app.
 * Retorna null se não houver alerta nesta semana ou se já foi visto.
 */
async function buscarMeuAvisoAproveitamento(pool, codProf) {
  const semana = `${new Date().getFullYear()}-W${String(isoWeek(new Date())).padStart(2, '0')}`;
  const r = await pool.query(`
    SELECT cod_prof, nome_prof, regiao, semana_referencia, pct_prazo,
           entregas_prazo, entregas_total, pct_min_aplicado, semanas_consecutivas
    FROM score_alertas_aproveitamento
    WHERE cod_prof = $1 AND semana_referencia = $2 AND visto_em IS NULL
    LIMIT 1
  `, [String(codProf), semana]);
  if (r.rows.length === 0) return { tem_aviso: false };
  return { tem_aviso: true, aviso: r.rows[0] };
}

/** Marca o aviso da semana corrente como visto (motoboy fechou o modal). */
async function marcarAvisoAproveitamentoVisto(pool, codProf) {
  const semana = `${new Date().getFullYear()}-W${String(isoWeek(new Date())).padStart(2, '0')}`;
  await pool.query(`
    UPDATE score_alertas_aproveitamento
    SET visto_em = NOW()
    WHERE cod_prof = $1 AND semana_referencia = $2 AND visto_em IS NULL
  `, [String(codProf), semana]);
  return { ok: true, semana };
}

// ============================================================
// 🆕 2026-07: GRID DE CORRIDAS AO VIVO (Score corridas por motoboy)
// ============================================================
// Le a bi_entregas AO VIVO (mesma fonte do BI, mesmo instante) — por isso os
// numeros batem com o BI. Total = corridas ponto>=2 (igual BI). O prazo de
// cada corrida usa data_hora_alocado (aceite) ate finalizado, comparado com a
// regua por distancia. Corridas sem aceite/finalizado/distancia sao "sem
// dados": contam no total mas ficam fora do % (nao da pra medir).

// Monta o filtro de janela por data_solicitado (DATE). de/ate 'YYYY-MM-DD'.
// Sem ate = hoje. Sem de = ate - 6 dias (janela padrao de 7 dias).
function _janelaCorridas(de, ate) {
  const ateFim = ate || null;
  const deIni = de || null;
  return { deIni, ateFim };
}

/**
 * Grid ESQUERDO: motoboys de uma praca com total de corridas, avaliaveis e
 * % no prazo, no periodo. Le ao vivo.
 */
async function listarMotoboysComCorridas(pool, { regiao, de, ate } = {}) {
  if (!regiao) return { periodo: { de, ate }, motoboys: [] };
  const { deIni, ateFim } = _janelaCorridas(de, ate);

  // motoboys da praca (mesmo criterio do aproveitamento)
  const mb = await pool.query(
    `SELECT cod_prof, nome_prof FROM score_nivel_motoboy
      WHERE ${SQL_NORM_REGIAO('regiao')} = ${SQL_NORM_REGIAO('$1::text')}`,
    [regiao]
  );
  if (mb.rows.length === 0) return { periodo: { de: deIni, ate: ateFim }, motoboys: [] };

  const codigos = mb.rows.map(r => parseInt(r.cod_prof, 10)).filter(Number.isFinite);
  if (codigos.length === 0) return { periodo: { de: deIni, ate: ateFim }, motoboys: [] };

  // janela: ate = ateFim OU hoje; de = deIni OU (ate - 6 dias)
  const fimSQL = ateFim ? '$2::date' : 'CURRENT_DATE';
  const iniSQL = deIni ? '$3::date' : `(${fimSQL} - INTERVAL '6 days')::date`;
  const params = [codigos];
  if (ateFim) params.push(ateFim);
  if (deIni) params.push(deIni);

  const r = await pool.query(`
    WITH base AS (
      SELECT
        cod_prof, nome_prof,
        distancia,
        ${PRAZO_REGUA_SQL} AS prazo_regua,
        (${TEMPO_PROF_MIN_SQL}) AS tempo_prof_min,
        (${ENTREGA_AVALIAVEL_SQL}) AS avaliavel
      FROM bi_entregas
      WHERE cod_prof = ANY($1)
        AND COALESCE(ponto, 1) >= 2
        AND data_solicitado >= ${iniSQL}
        AND data_solicitado <= ${fimSQL}
    )
    SELECT
      cod_prof,
      MAX(nome_prof) AS nome_prof,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE avaliavel)::int AS avaliaveis,
      COUNT(*) FILTER (WHERE avaliavel AND tempo_prof_min <= prazo_regua)::int AS no_prazo
    FROM base
    GROUP BY cod_prof
    HAVING COUNT(*) > 0
    ORDER BY MAX(nome_prof)
  `, params);

  const motoboys = r.rows.map(row => {
    const total = parseInt(row.total, 10) || 0;
    const avaliaveis = parseInt(row.avaliaveis, 10) || 0;
    const noPrazo = parseInt(row.no_prazo, 10) || 0;
    return {
      cod_prof: row.cod_prof,
      nome_prof: row.nome_prof,
      total,
      avaliaveis,
      no_prazo: noPrazo,
      fora: avaliaveis - noPrazo,
      pct: avaliaveis > 0 ? Math.round((10000 * noPrazo) / avaliaveis) / 100 : null,
    };
  });
  return { periodo: { de: deIni, ate: ateFim }, motoboys };
}

/**
 * Grid DIREITO: todas as corridas (ponto>=2) de um motoboy no periodo, com
 * criacao, alocacao, finalizado e status de prazo. Le ao vivo.
 */
async function listarCorridasMotoboy(pool, { codProf, de, ate } = {}) {
  const codInt = parseInt(codProf, 10);
  if (!Number.isFinite(codInt)) return { corridas: [] };
  const { deIni, ateFim } = _janelaCorridas(de, ate);

  const fimSQL = ateFim ? '$2::date' : 'CURRENT_DATE';
  const iniSQL = deIni ? '$3::date' : `(${fimSQL} - INTERVAL '6 days')::date`;
  const params = [codInt];
  if (ateFim) params.push(ateFim);
  if (deIni) params.push(deIni);

  const r = await pool.query(`
    SELECT
      os,
      data_hora            AS criacao,
      data_hora_alocado    AS alocacao,
      finalizado,
      distancia,
      ${PRAZO_REGUA_SQL}   AS prazo_regua,
      (${TEMPO_PROF_MIN_SQL}) AS tempo_prof_min,
      (${ENTREGA_AVALIAVEL_SQL}) AS avaliavel
    FROM bi_entregas
    WHERE cod_prof = $1
      AND COALESCE(ponto, 1) >= 2
      AND data_solicitado >= ${iniSQL}
      AND data_solicitado <= ${fimSQL}
    ORDER BY data_hora DESC NULLS LAST, os DESC
  `, params);

  const corridas = r.rows.map(row => {
    const avaliavel = row.avaliavel === true;
    let status = 'sem_dados';
    if (avaliavel) {
      status = (parseFloat(row.tempo_prof_min) <= parseFloat(row.prazo_regua)) ? 'no_prazo' : 'fora';
    }
    return {
      os: row.os,
      criacao: row.criacao,
      alocacao: row.alocacao,
      finalizado: row.finalizado,
      distancia: row.distancia != null ? parseFloat(row.distancia) : null,
      prazo_regua: row.prazo_regua != null ? parseInt(row.prazo_regua, 10) : null,
      tempo_prof_min: row.tempo_prof_min != null ? Math.round(parseFloat(row.tempo_prof_min)) : null,
      status,
    };
  });
  return { corridas };
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
  congelarRankingMensal,
  // 🆕 2026-06: Aproveitamento semanal
  JANELA_APROVEITAMENTO_DIAS,
  calcularAproveitamento7d,
  avaliarAproveitamentoSemanal,
  listarAlertasAproveitamento,
  buscarMeuAvisoAproveitamento,
  marcarAvisoAproveitamentoVisto,
  // 🆕 2026-07: grid de corridas ao vivo (substitui a tela de aproveitamento)
  listarMotoboysComCorridas,
  listarCorridasMotoboy,
};
