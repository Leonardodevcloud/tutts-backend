'use strict';

/**
 * sla-monitor.service.js
 *
 * SLA Monitor server-side — o cálculo que a extensão Chrome v8 fazia no
 * browser do operador agora vive aqui, 24/7, independente de aba aberta.
 *
 * ARQUITETURA:
 *   tickCompleto(pool) é chamado pelo sla-detector.agent (cron 2min) e faz:
 *     1. Consulta no banco quais OS em execução JÁ têm km conhecido
 *     2. UM único coletarOsEmExecucao({ buscarKm }) — mesma coleta alimenta
 *        o snapshot SLA E o detector de rastreio (injetado via coletarFn),
 *        ou seja: ZERO scraping duplicado
 *     3. UPSERT em sla_monitor_snapshot (km/retorno só atualizam se vierem)
 *     4. OS que sumiram da tela → em_execucao=false + finalizada_em
 *     5. Repassa o resultado JÁ COLETADO pro detectarOsNovas (rastreio 814/767)
 *
 *   consultarStatus(pool) calcula o status de cada OS EM TEMPO DE LEITURA
 *   (deadline vs NOW() no Postgres) — nunca fica stale entre ticks.
 *
 * FUSO: horário do MAP é local Bahia (UTC-3, sem DST). O parse monta ISO
 * com offset explícito -03:00 — imune ao TZ do container Railway (UTC).
 */

const { logger } = require('../../config/logger');
const slaDetectorService = require('./sla-detector.service');

function log(msg) {
  logger.info(`[sla-monitor] ${msg}`);
}

// ── Limites de status (minutos restantes até o deadline) ──────────────────
const LIMITE_ATENCAO  = () => Number(process.env.SLA_MONITOR_LIMITE_ATENCAO  || 30);
const LIMITE_IMINENTE = () => Number(process.env.SLA_MONITOR_LIMITE_IMINENTE || 15);

// Teto de consultas de km (modal) por tick e concorrência do fetch
const KM_MAX_POR_TICK  = () => Number(process.env.SLA_MONITOR_KM_MAX_POR_TICK || 40);
const KM_CONCORRENCIA  = () => Number(process.env.SLA_MONITOR_KM_CONCORRENCIA || 4);

// 🆕 v2.4: clientes multi-centro — o centro de custo vem do modal do MAP
// em tempo real (o BI fica como fallback pros demais)
const CENTRO_CLIENTES = () =>
  (process.env.SLA_MONITOR_CENTRO_CLIENTES || '767,814')
    .split(',').map((s) => s.trim()).filter(Boolean);
const CENTRO_MAX_POR_TICK = () => Number(process.env.SLA_MONITOR_CENTRO_MAX_POR_TICK || 20);
const CENTRO_CONCORRENCIA = () => Number(process.env.SLA_MONITOR_CENTRO_CONCORRENCIA || 3);

// ─────────────────────────────────────────────────────────────────────────
// CONFIG DE PRAZOS — carregada do banco com cache de 60s
// ─────────────────────────────────────────────────────────────────────────
const PRAZOS_CACHE_TTL_MS = 60_000;
let _prazosCache = null;
let _prazosCacheAt = 0;

async function carregarPrazos(pool) {
  const agora = Date.now();
  if (_prazosCache && (agora - _prazosCacheAt) < PRAZOS_CACHE_TTL_MS) {
    return _prazosCache;
  }

  const [faixasRes, fixosRes] = await Promise.all([
    pool.query('SELECT km_de, km_ate, prazo_min FROM sla_monitor_prazos_km ORDER BY km_de ASC'),
    pool.query('SELECT cliente_cod, prazo_min FROM sla_monitor_prazos_fixos WHERE ativo = TRUE'),
  ]);

  const fixos = {};
  for (const r of fixosRes.rows) fixos[String(r.cliente_cod)] = Number(r.prazo_min);

  _prazosCache = {
    faixas: faixasRes.rows.map(r => ({
      de: Number(r.km_de), ate: Number(r.km_ate), prazo: Number(r.prazo_min),
    })),
    fixos,
  };
  _prazosCacheAt = agora;
  return _prazosCache;
}

function limparCachePrazos() {
  _prazosCache = null;
  _prazosCacheAt = 0;
}

// ─────────────────────────────────────────────────────────────────────────
// 🆕 2026-07 v2.2: NOMES DE EXIBIÇÃO — a mesma cadeia do módulo de
// performance diária do BI: bi_mascaras.mascara > bi_entregas.nome_cliente.
// Enriquecidos em tempo de leitura (cache 5min); se as tabelas do BI não
// existirem, degrada silenciosamente pro nome raspado do MAP.
// ─────────────────────────────────────────────────────────────────────────
const NOMES_CACHE_TTL_MS = 5 * 60_000;
let _nomesCache = null;
let _nomesCacheAt = 0;

async function carregarNomesClientes(pool) {
  const agora = Date.now();
  if (_nomesCache && (agora - _nomesCacheAt) < NOMES_CACHE_TTL_MS) return _nomesCache;

  const mapa = new Map();
  try {
    // Base: nome_cliente do BI (janela de 60 dias pra não varrer a tabela toda)
    const { rows: nomes } = await pool.query(
      `SELECT cod_cliente, MAX(nome_cliente) AS nome_cliente
         FROM bi_entregas
        WHERE data_solicitado >= CURRENT_DATE - 60
          AND cod_cliente IS NOT NULL AND nome_cliente IS NOT NULL AND nome_cliente <> ''
        GROUP BY cod_cliente`
    );
    for (const r of nomes) mapa.set(String(r.cod_cliente), r.nome_cliente);

    // Override: máscara (nome de exibição oficial do dashboard)
    const { rows: masc } = await pool.query('SELECT cod_cliente, mascara FROM bi_mascaras');
    for (const r of masc) {
      if (r.mascara) mapa.set(String(r.cod_cliente), r.mascara);
    }
  } catch (e) {
    log(`⚠️ nomes do BI indisponíveis (usando nome raspado do MAP): ${e.message}`);
  }

  _nomesCache = mapa;
  _nomesCacheAt = agora;
  return mapa;
}

function aplicarNomesExibicao(linhas, nomes) {
  for (const r of linhas) {
    const n = r.cliente_cod != null ? nomes.get(String(r.cliente_cod)) : null;
    if (n) r.cliente_nome = n;
  }
}

/**
 * 🆕 2026-07 v2.4: aplica os centros de custo consultados via MODAL do MAP
 * (fonte em tempo real, primária pros clientes multi-centro). O modal é a
 * fonte da verdade — sobrescreve inclusive valor anterior se mudou.
 */
async function aplicarCentrosModal(pool, centroPorOs) {
  if (!centroPorOs || Object.keys(centroPorOs).length === 0) return 0;
  let aplicados = 0;
  for (const [os, info] of Object.entries(centroPorOs)) {
    if (!info || !info.centro_nome) continue;
    const r = await pool.query(
      `UPDATE sla_monitor_snapshot
          SET centro_custo = $2, atualizado_em = NOW()
        WHERE os_numero = $1
          AND (centro_custo IS DISTINCT FROM $2)`,
      [os, String(info.centro_nome).slice(0, 255)]
    );
    aplicados += r.rowCount || 0;
  }
  return aplicados;
}

// ─────────────────────────────────────────────────────────────────────────
// 🆕 2026-07 v2.5: CENTRO POR TERMOS DE ENDEREÇO — mesmo padrão dos filtros
// do rastreio-clientes. O _balloon de cada linha (já capturado, uppercase,
// contém o endereço) é comparado com os termos configurados em
// sla_monitor_centros_termos. Determinístico, sem HTTP extra, editável
// pela API sem deploy. Tem a PALAVRA FINAL sobre modal e BI.
// ─────────────────────────────────────────────────────────────────────────
const TERMOS_CACHE_TTL_MS = 60_000;
let _termosCache = null;
let _termosCacheAt = 0;

async function carregarCentrosTermos(pool) {
  const agora = Date.now();
  if (_termosCache && (agora - _termosCacheAt) < TERMOS_CACHE_TTL_MS) return _termosCache;
  const { rows } = await pool.query(
    `SELECT cliente_cod, termo, centro_nome
       FROM sla_monitor_centros_termos
      WHERE ativo = TRUE
      ORDER BY LENGTH(termo) DESC` // termo mais específico primeiro
  );
  _termosCache = rows.map((r) => ({
    cliente_cod: String(r.cliente_cod),
    termo: String(r.termo).toUpperCase(),
    centro_nome: r.centro_nome,
  }));
  _termosCacheAt = agora;
  return _termosCache;
}

function limparCacheTermos() {
  _termosCache = null;
  _termosCacheAt = 0;
}

/**
 * Casa cada OS coletada com os termos do seu cliente via _balloon.
 * Retorna mapa { os_numero: { centro_nome } } (formato do aplicarCentrosModal).
 */
function detectarCentrosPorTermos(ordens, termos) {
  const mapa = {};
  if (!termos || termos.length === 0) return mapa;
  for (const o of ordens) {
    if (!o.os_numero || !o._balloon || !o.cliente_cod) continue;
    const cod = String(o.cliente_cod);
    for (const t of termos) {
      if (t.cliente_cod !== cod) continue;
      if (o._balloon.includes(t.termo)) {
        mapa[o.os_numero] = { centro_nome: t.centro_nome };
        break; // primeiro termo (mais específico) vence
      }
    }
  }
  return mapa;
}

/**
 * 🆕 2026-07 v2.3: preenche centro_custo das OS em execução a partir do
 * bi_entregas (o DOM do MAP não expõe o nome do centro — só ícones).
 * Roda no tick do worker; janela de 3 dias pra não varrer a tabela.
 * Se o BI ainda não importou a OS, fica NULL e preenche num tick futuro.
 */
async function enriquecerCentroCusto(pool) {
  try {
    const r = await pool.query(
      `UPDATE sla_monitor_snapshot s
          SET centro_custo = b.centro_custo,
              atualizado_em = NOW()
         FROM (
           SELECT DISTINCT ON (os) os, centro_custo
             FROM bi_entregas
            WHERE data_solicitado >= CURRENT_DATE - 3
              AND centro_custo IS NOT NULL AND centro_custo <> ''
            ORDER BY os, id DESC
         ) b
        WHERE s.em_execucao = TRUE
          AND s.centro_custo IS NULL
          AND s.os_numero ~ '^[0-9]+$'
          AND b.os = s.os_numero::int`
    );
    return r.rowCount || 0;
  } catch (e) {
    log(`⚠️ centro_custo do BI indisponível: ${e.message}`);
    return 0;
  }
}

/**
 * Prazo em minutos pela distância. Acima da última faixa, extrapola no
 * mesmo padrão da extensão v8: +15min a cada 5km além do teto.
 */
function getPrazoPorKm(km, faixas) {
  if (km == null || !faixas || faixas.length === 0) return null;
  for (const f of faixas) {
    if (km >= f.de && km < f.ate) return f.prazo;
  }
  const ultima = faixas[faixas.length - 1];
  if (km >= ultima.ate) {
    return ultima.prazo + Math.ceil((km - ultima.ate) / 5) * 15;
  }
  return null; // km negativo/inconsistente
}

/**
 * Parse de data BR ou ISO → ISO com offset -03:00 (Bahia). Aceita:
 *   - "DD-MM-YYYY HH:MM:SS" / "DD/MM/YY HH:MM"  (texto visível da linha)
 *   - "YYYY-MM-DD HH:MM:SS"                      (atributo data-date-hour —
 *     🔧 2026-07: descoberto via HTML inspecionado que o atributo vem em
 *     formato ISO, não BR; sem este branch ele falhava o parse → Sem dados)
 * Retorna string ISO ou null. Rejeita datas zeradas ("0000-00-00...").
 * NUNCA usa new Date(str) direto — o JS interpretaria DD-MM como MM-DD.
 */
function parseDataBRparaISO(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Formato ISO: YYYY-MM-DD HH:MM(:SS)
  const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):?(\d{2})?/);
  if (mIso) {
    const [, ano, mes, dia, hora, min, seg] = mIso;
    if (ano === '0000' || mes === '00' || dia === '00') return null; // data zerada do MAP
    return `${ano}-${mes}-${dia}T${hora}:${min}:${seg || '00'}-03:00`;
  }

  // Formato BR: DD-MM-YYYY ou DD/MM/YY(YY)
  const m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{2,4})\s+(\d{2}):(\d{2}):?(\d{2})?/);
  if (!m) return null;
  const [, dia, mes, anoRaw, hora, min, seg] = m;
  if (anoRaw === '00' || anoRaw === '0000' || mes === '00' || dia === '00') return null;
  // Ano 2 dígitos (formato do agendamento "02/07/26") → 20YY
  const ano = anoRaw.length === 2 ? `20${anoRaw}` : anoRaw;
  return `${ano}-${mes}-${dia}T${hora}:${min}:${seg || '00'}-03:00`;
}

/**
 * 🔧 2026-07: escolhe o horário de início do SLA entre os candidatos,
 * em ordem de prioridade:
 *   1. data-date-hour-collect (agendamento, atributo) — OS agendada: o
 *      relógio do SLA parte do horário combinado, não da solicitação.
 *      Vem zerado ("0000-00-00...") em OS imediata → parser rejeita → cai.
 *   2. agendamento do texto da linha (DD/MM/YY)
 *   3. data-date-hour (solicitação, atributo — formato ISO YYYY-MM-DD)
 *   4. solicitação do texto da linha (DD-MM-YYYY)
 * Retorna { iso, raw } ou { iso: null, raw: null }.
 */
function escolherHorarioInicio(o) {
  const candidatos = [
    o.horario_agendamento_attr,
    o.horario_agendamento_raw,
    o.horario_inicio_raw,
    o.horario_solicitacao_raw,
  ];
  for (const raw of candidatos) {
    const iso = parseDataBRparaISO(raw);
    if (iso) return { iso, raw };
  }
  return { iso: null, raw: null };
}

/**
 * Extrai nome legível do profissional a partir do title/atributo bruto
 * (ex: "12345-JOÃO DA SILVA (Motofrete...)" → "JOÃO DA SILVA").
 * Mesmo regex da extensão v8.
 */
function parseNomeProfissional(raw, codProfissional) {
  if (!raw) return codProfissional ? `Prof. ${codProfissional}` : null;
  const m = String(raw).match(/\d{4,6}[-–]([A-Za-zÀ-ÿ][^(\d]+?)(?:\s*\(|\s*Motofrete|$)/i);
  if (m) return m[1].trim().slice(0, 200);
  return String(raw).trim().slice(0, 200) || (codProfissional ? `Prof. ${codProfissional}` : null);
}

// ─────────────────────────────────────────────────────────────────────────
// PROCESSAR COLETA — UPSERT do snapshot
// ─────────────────────────────────────────────────────────────────────────

/**
 * Recebe o resultado de coletarOsEmExecucao (ordens + kmPorOs) e sincroniza
 * a tabela sla_monitor_snapshot.
 */
async function processarColeta(pool, resultado) {
  const { ordens = [], kmPorOs = {} } = resultado;
  const prazos = await carregarPrazos(pool);

  let upserts = 0;
  let comPrazo = 0;

  for (const o of ordens) {
    if (!o.os_numero) continue;

    const kmInfo   = kmPorOs[o.os_numero] || null;
    const km       = kmInfo && kmInfo.km != null ? kmInfo.km : null;
    // 🔧 2026-07 hotfix: prioridade data-date-hour > agendamento > solicitação
    const horaEscolhida = escolherHorarioInicio(o);
    const horaISO  = horaEscolhida.iso;
    const nomeProf = parseNomeProfissional(o.nome_profissional_raw, o.cod_profissional);

    // Prazo: fixo por cliente tem precedência; senão por km (se conhecido).
    // O cálculo definitivo de deadline acontece no SQL, que combina o km
    // recém-consultado OU o km já persistido de ticks anteriores (COALESCE).
    const prazoFixo = prazos.fixos[String(o.cliente_cod)] ?? null;
    const prazoKmNovo = km != null ? getPrazoPorKm(km, prazos.faixas) : null;

    // UPSERT:
    //   - km/retorno: só sobrescreve se veio valor novo (COALESCE novo→antigo)
    //   - prazo/deadline: recalculados combinando fixo > km novo > km antigo
    //   - ultima_vista_em: sempre NOW(); em_execucao volta a TRUE (OS pode
    //     ter “sumido” num tick por falha de página e voltado)
    const res = await pool.query(
      `INSERT INTO sla_monitor_snapshot (
         os_numero, cliente_cod, cliente_nome, cod_profissional, nome_profissional,
         cod_rastreio, link_rastreio, horario_inicio_raw, horario_inicio,
         distancia_km, prazo_min, prazo_origem, deadline,
         retorno, retorno_motivo, situacao,
         em_execucao, ultima_vista_em, atualizado_em
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9::timestamptz,
         $10,
         COALESCE($12::int, $11::int),
         CASE WHEN $12::int IS NOT NULL THEN 'fixo'
              WHEN $11::int IS NOT NULL THEN 'km'
              ELSE NULL END,
         CASE WHEN $9::timestamptz IS NOT NULL AND COALESCE($12::int, $11::int) IS NOT NULL
              THEN $9::timestamptz + (COALESCE($12::int, $11::int) || ' minutes')::interval
              ELSE NULL END,
         $13, $14, $15,
         TRUE, NOW(), NOW()
       )
       ON CONFLICT (os_numero) DO UPDATE SET
         cliente_cod        = COALESCE(EXCLUDED.cliente_cod, sla_monitor_snapshot.cliente_cod),
         cliente_nome       = COALESCE(EXCLUDED.cliente_nome, sla_monitor_snapshot.cliente_nome),
         cod_profissional   = COALESCE(EXCLUDED.cod_profissional, sla_monitor_snapshot.cod_profissional),
         nome_profissional  = COALESCE(EXCLUDED.nome_profissional, sla_monitor_snapshot.nome_profissional),
         cod_rastreio       = COALESCE(EXCLUDED.cod_rastreio, sla_monitor_snapshot.cod_rastreio),
         link_rastreio      = COALESCE(EXCLUDED.link_rastreio, sla_monitor_snapshot.link_rastreio),
         horario_inicio_raw = COALESCE(EXCLUDED.horario_inicio_raw, sla_monitor_snapshot.horario_inicio_raw),
         horario_inicio     = COALESCE(EXCLUDED.horario_inicio, sla_monitor_snapshot.horario_inicio),
         distancia_km       = COALESCE(EXCLUDED.distancia_km, sla_monitor_snapshot.distancia_km),
         retorno            = (sla_monitor_snapshot.retorno OR EXCLUDED.retorno),
         retorno_motivo     = COALESCE(EXCLUDED.retorno_motivo, sla_monitor_snapshot.retorno_motivo),
         situacao           = EXCLUDED.situacao,
         prazo_min = CASE
           WHEN $12::int IS NOT NULL THEN $12::int
           WHEN COALESCE(EXCLUDED.distancia_km, sla_monitor_snapshot.distancia_km) IS NOT NULL
             THEN COALESCE($11::int, sla_monitor_snapshot.prazo_min)
           ELSE sla_monitor_snapshot.prazo_min
         END,
         prazo_origem = CASE
           WHEN $12::int IS NOT NULL THEN 'fixo'
           WHEN COALESCE($11::int, sla_monitor_snapshot.prazo_min) IS NOT NULL THEN 'km'
           ELSE sla_monitor_snapshot.prazo_origem
         END,
         deadline = CASE
           WHEN COALESCE(EXCLUDED.horario_inicio, sla_monitor_snapshot.horario_inicio) IS NOT NULL
                AND CASE
                      WHEN $12::int IS NOT NULL THEN $12::int
                      ELSE COALESCE($11::int, sla_monitor_snapshot.prazo_min)
                    END IS NOT NULL
           THEN COALESCE(EXCLUDED.horario_inicio, sla_monitor_snapshot.horario_inicio)
                + ((CASE
                      WHEN $12::int IS NOT NULL THEN $12::int
                      ELSE COALESCE($11::int, sla_monitor_snapshot.prazo_min)
                    END) || ' minutes')::interval
           ELSE sla_monitor_snapshot.deadline
         END,
         em_execucao     = TRUE,
         finalizada_em   = NULL,
         ultima_vista_em = NOW(),
         atualizado_em   = NOW()
       RETURNING prazo_min`,
      [
        o.os_numero,                              // $1
        o.cliente_cod || null,                    // $2
        o.cliente_nome || null,                   // $3
        o.cod_profissional || null,               // $4
        nomeProf,                                 // $5
        o.cod_rastreio || null,                   // $6
        o.link_rastreio || null,                  // $7
        horaEscolhida.raw || null,                // $8 (raw da fonte escolhida)
        horaISO,                                  // $9
        km,                                       // $10
        prazoKmNovo,                              // $11 (prazo calculado do km NOVO)
        prazoFixo,                                // $12 (prazo fixo do cliente, se houver)
        kmInfo ? !!kmInfo.retorno : false,        // $13
        kmInfo ? (kmInfo.motivo || null) : null,  // $14
        o.situacao === 'sem_profissional' ? 'sem_profissional' : 'em_execucao', // $15
      ]
    );

    upserts++;
    if (res.rows[0] && res.rows[0].prazo_min != null) comPrazo++;
  }

  // ── Finaliza OS que sumiram da tela ─────────────────────────────────────
  // Só quando a coleta veio OK (ordens confiáveis). Uma coleta parcial que
  // falhou não deve "finalizar" OS por engano — por isso a chamada só
  // acontece com resultado.ok garantido pelo tickCompleto.
  let finalizadas = 0;
  const emTela = ordens.map(o => o.os_numero).filter(Boolean);
  const resFinal = await pool.query(
    `UPDATE sla_monitor_snapshot
        SET em_execucao = FALSE,
            finalizada_em = COALESCE(finalizada_em, NOW()),
            atualizado_em = NOW()
      WHERE em_execucao = TRUE
        AND NOT (os_numero = ANY($1::varchar[]))`,
    [emTela]
  );
  finalizadas = resFinal.rowCount || 0;

  return { upserts, comPrazo, finalizadas };
}

// ─────────────────────────────────────────────────────────────────────────
// TICK COMPLETO — coleta única alimenta snapshot + detector de rastreio
// ─────────────────────────────────────────────────────────────────────────

async function tickCompleto(pool) {
  // 1. Quais OS em execução já têm km? (não re-consultar modal à toa)
  const { rows: comKm } = await pool.query(
    `SELECT os_numero FROM sla_monitor_snapshot
      WHERE em_execucao = TRUE AND distancia_km IS NOT NULL`
  );
  const pular = comKm.map(r => r.os_numero);

  // 1.5 🆕 v2.4: quais OS já têm centro de custo? (modal só consulta uma vez)
  const { rows: comCentro } = await pool.query(
    `SELECT os_numero FROM sla_monitor_snapshot
      WHERE em_execucao = TRUE AND centro_custo IS NOT NULL`
  );
  const pularCentro = comCentro.map(r => r.os_numero);

  // 2. Coleta ÚNICA (com km dos que faltam + aba Sem profissional + centros)
  // require tardio — mesmo padrão do sla-detector.service (módulo já no cache)
  const { coletarOsEmExecucao } = require('./playwright-sla-capture');
  const resultado = await coletarOsEmExecucao({
    buscarKm: {
      pular,
      max: KM_MAX_POR_TICK(),
      concorrencia: KM_CONCORRENCIA(),
    },
    // 🆕 v2.4: centro de custo em tempo real pros clientes multi-centro
    buscarCentro: {
      clientes: CENTRO_CLIENTES(),
      pular: pularCentro,
      max: CENTRO_MAX_POR_TICK(),
      concorrencia: CENTRO_CONCORRENCIA(),
    },
    // 🆕 2026-07 v2.1: SLA também para OS aguardando atribuição
    coletarSemProfissional:
      (process.env.SLA_MONITOR_SEM_PROFISSIONAL || 'true').toLowerCase() === 'true',
  });

  if (!resultado.ok) {
    log(`⚠️ coleta falhou: ${resultado.motivo} — snapshot NÃO alterado`);
    return { ok: false, motivo: resultado.motivo, sessaoExpirada: !!resultado.sessaoExpirada };
  }

  // 3. Snapshot
  const stats = await processarColeta(pool, resultado);
  // 3.3 🆕 v2.4: centros vindos do MODAL (quando o parse funciona)
  const centrosModal = await aplicarCentrosModal(pool, resultado.centroPorOs);
  // 3.4 🆕 v2.5: centros por TERMOS de endereço (padrão rastreio-clientes) —
  // aplicado DEPOIS do modal: os termos configurados têm a palavra final
  const termos = await carregarCentrosTermos(pool);
  const centrosTermosMapa = detectarCentrosPorTermos(resultado.ordens, termos);
  const centrosTermos = await aplicarCentrosModal(pool, centrosTermosMapa);
  // 3.5 🆕 v2.3: fallback — centro de custo via bi_entregas (só preenche NULL)
  const centrosPreenchidos = await enriquecerCentroCusto(pool);
  log(
    `📊 snapshot: ${resultado.ordens.length} OS em tela | ` +
    `${stats.upserts} upserts (${stats.comPrazo} com prazo) | ` +
    `${stats.finalizadas} finalizadas | ` +
    `km consultados: ${Object.keys(resultado.kmPorOs || {}).length} | ` +
    `centros: ${centrosModal} via modal, ${centrosTermos} via termos, ${centrosPreenchidos} via BI`
  );

  // 4. Detector de rastreio 814/767 — reusa a MESMA coleta (injeta coletarFn
  //    que devolve o resultado pronto; detectarOsNovas nem abre browser)
  // 🛡️ 2026-07 v2.1: filtra pra SÓ OS em execução — OS sem profissional
  //    NUNCA podem disparar rastreio no WhatsApp (não há corrida ainda!)
  let detector = null;
  try {
    const resultadoSoExecucao = {
      ...resultado,
      ordens: resultado.ordens.filter((o) => (o.situacao || 'em_execucao') === 'em_execucao'),
    };
    detector = await slaDetectorService.detectarOsNovas(pool, async () => resultadoSoExecucao);
  } catch (e) {
    log(`⚠️ detector pós-snapshot falhou: ${e.message}`);
    detector = { ok: false, motivo: e.message };
  }

  return {
    ok: true,
    totalOs: resultado.ordens.length,
    paginas: resultado.paginas,
    duracaoMs: resultado.duracaoMs,
    snapshot: stats,
    detector,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CONSULTA — status calculado em tempo de leitura
// ─────────────────────────────────────────────────────────────────────────

/**
 * Retorna o painel completo: OS em execução com status SLA calculado
 * pelo Postgres contra NOW() — nunca stale entre ticks do worker.
 *
 * 🆕 2026-07 v2.1:
 *   - inclui OS 'sem_profissional' (aguardando atribuição, relógio correndo)
 *   - opts.incluirFinalizadas + opts.horasFinalizadas: retorna também as OS
 *     concluídas na janela, com veredito CONCLUIDA_NO_PRAZO / CONCLUIDA_ATRASADA
 *     (finalizada_em vs deadline — badge da aba Concluídos na extensão)
 */
async function consultarStatus(pool, opts = {}) {
  const atencao  = LIMITE_ATENCAO();
  const iminente = LIMITE_IMINENTE();

  const { rows } = await pool.query(
    `SELECT
       os_numero,
       cliente_cod,
       cliente_nome,
       cod_profissional,
       nome_profissional,
       cod_rastreio,
       link_rastreio,
       horario_inicio,
       distancia_km,
       prazo_min,
       prazo_origem,
       deadline,
       retorno,
       retorno_motivo,
       situacao,
       centro_custo,
       ultima_vista_em,
       CASE
         WHEN deadline IS NULL THEN NULL
         ELSE ROUND(EXTRACT(EPOCH FROM (deadline - NOW())) / 60)::int
       END AS minutos_restantes,
       CASE
         WHEN deadline IS NULL THEN 'SEM_DADOS'
         WHEN deadline <= NOW() THEN 'ATRASADO'
         WHEN deadline <= NOW() + ($1::int || ' minutes')::interval THEN 'IMINENTE'
         WHEN deadline <= NOW() + ($2::int || ' minutes')::interval THEN 'ATENCAO'
         ELSE 'NO_PRAZO'
       END AS status
     FROM sla_monitor_snapshot
     WHERE em_execucao = TRUE
     ORDER BY deadline ASC NULLS LAST`,
    [iminente, atencao]
  );

  const resumo = { NO_PRAZO: 0, ATENCAO: 0, IMINENTE: 0, ATRASADO: 0, SEM_DADOS: 0, RETORNO: 0 };
  const aguardandoAtribuicao = { total: 0, atrasadas: 0 };
  for (const r of rows) {
    resumo[r.status] = (resumo[r.status] || 0) + 1;
    if (r.retorno) resumo.RETORNO++;
    if (r.situacao === 'sem_profissional') {
      aguardandoAtribuicao.total++;
      if (r.status === 'ATRASADO') aguardandoAtribuicao.atrasadas++;
    }
  }

  // ── Finalizadas com veredito (badge da aba Concluídos) ───────────────────
  let finalizadas = null;
  let resumoFinalizadas = null;
  if (opts.incluirFinalizadas) {
    const horas = Math.max(1, Math.min(72, Number(opts.horasFinalizadas) || 24));
    const { rows: fins } = await pool.query(
      `SELECT
         os_numero, cliente_cod, cliente_nome, cod_profissional, nome_profissional,
         centro_custo, prazo_min, prazo_origem, distancia_km, deadline, finalizada_em, retorno,
         CASE
           WHEN deadline IS NULL THEN 'CONCLUIDA_SEM_DADOS'
           WHEN finalizada_em <= deadline THEN 'CONCLUIDA_NO_PRAZO'
           ELSE 'CONCLUIDA_ATRASADA'
         END AS status,
         CASE
           WHEN deadline IS NULL THEN NULL
           ELSE ROUND(EXTRACT(EPOCH FROM (finalizada_em - deadline)) / 60)::int
         END AS minutos_diferenca
       FROM sla_monitor_snapshot
       WHERE em_execucao = FALSE
         AND finalizada_em >= NOW() - ($1::int || ' hours')::interval
       ORDER BY finalizada_em DESC
       LIMIT 1500`,
      [horas]
    );
    finalizadas = fins;
    resumoFinalizadas = {
      total: fins.length,
      noPrazo: fins.filter((f) => f.status === 'CONCLUIDA_NO_PRAZO').length,
      atrasadas: fins.filter((f) => f.status === 'CONCLUIDA_ATRASADA').length,
      semDados: fins.filter((f) => f.status === 'CONCLUIDA_SEM_DADOS').length,
      horas,
    };
  }

  // Frescor do snapshot — pro cliente (extensão/painel) exibir heartbeat
  const { rows: [meta] } = await pool.query(
    `SELECT MAX(ultima_vista_em) AS ultima_coleta FROM sla_monitor_snapshot`
  );

  // 🆕 v2.2: nomes de exibição do BI (mascara > nome_cliente > raspado do MAP)
  const nomes = await carregarNomesClientes(pool);
  aplicarNomesExibicao(rows, nomes);
  if (finalizadas) aplicarNomesExibicao(finalizadas, nomes);

  return {
    geradoEm: new Date().toISOString(),
    ultimaColeta: meta && meta.ultima_coleta ? meta.ultima_coleta : null,
    limites: { atencaoMin: atencao, iminenteMin: iminente },
    resumo,
    aguardandoAtribuicao,
    total: rows.length,
    ordens: rows,
    ...(finalizadas ? { finalizadas, resumoFinalizadas } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PERFORMANCE DIÁRIA — compliance de SLA por dia × cliente ou × profissional
// ─────────────────────────────────────────────────────────────────────────

/**
 * 🆕 2026-07 v2.1: agrega o histórico do snapshot em performance diária.
 * Veredito: finalizada_em vs deadline. Dia calculado no fuso America/Bahia.
 *
 * ⚠️ Granularidade honesta: finalizada_em é o tick em que a OS sumiu da
 * tela (~2min de precisão), e OS concluídas fora da janela do cron são
 * marcadas no primeiro tick seguinte. Para números contratuais, cruzar
 * com bi_entregas (Fase 3). Para gestão diária, é fiel.
 *
 * @param {'cliente'|'profissional'} agruparPor
 */
async function performanceDiaria(pool, { dias = 7, agruparPor = 'cliente' } = {}) {
  const d = Math.max(1, Math.min(90, Number(dias) || 7));
  const chaveCol  = agruparPor === 'profissional' ? 'cod_profissional' : 'cliente_cod';
  const nomeCol   = agruparPor === 'profissional' ? 'nome_profissional' : 'cliente_nome';

  const { rows } = await pool.query(
    `SELECT
       (finalizada_em AT TIME ZONE 'America/Bahia')::date AS dia,
       ${chaveCol} AS chave,
       MIN(${nomeCol}) AS nome,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE deadline IS NOT NULL AND finalizada_em <= deadline)::int AS no_prazo,
       COUNT(*) FILTER (WHERE deadline IS NOT NULL AND finalizada_em >  deadline)::int AS atrasadas,
       COUNT(*) FILTER (WHERE deadline IS NULL)::int AS sem_dados,
       ROUND(AVG(EXTRACT(EPOCH FROM (finalizada_em - deadline)) / 60)
             FILTER (WHERE deadline IS NOT NULL AND finalizada_em > deadline))::int AS atraso_medio_min
     FROM sla_monitor_snapshot
     WHERE finalizada_em IS NOT NULL
       AND finalizada_em >= NOW() - ($1::int || ' days')::interval
     GROUP BY 1, 2
     ORDER BY 1 DESC, total DESC`,
    [d]
  );

  // 🆕 v2.2: nome de exibição (mascara do BI) quando agrupado por cliente
  if (agruparPor === 'cliente') {
    const nomes = await carregarNomesClientes(pool);
    for (const r of rows) {
      const n = r.chave != null ? nomes.get(String(r.chave)) : null;
      if (n) r.nome = n;
    }
  }

  return {
    geradoEm: new Date().toISOString(),
    dias: d,
    agruparPor,
    linhas: rows.map((r) => ({
      ...r,
      pct_no_prazo: (r.no_prazo + r.atrasadas) > 0
        ? Math.round((r.no_prazo / (r.no_prazo + r.atrasadas)) * 100)
        : null,
    })),
  };
}

module.exports = {
  tickCompleto,
  processarColeta,
  consultarStatus,
  performanceDiaria,
  carregarPrazos,
  limparCachePrazos,
  enriquecerCentroCusto,
  aplicarCentrosModal,
  carregarCentrosTermos,
  limparCacheTermos,
  detectarCentrosPorTermos,
  // expostos pra testes unitários
  _internal: { getPrazoPorKm, parseDataBRparaISO, parseNomeProfissional, escolherHorarioInicio },
};
