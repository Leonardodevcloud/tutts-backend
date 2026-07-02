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
 * Parse de "DD-MM-YYYY HH:MM:SS" (ou DD/MM) → ISO com offset -03:00 (Bahia).
 * Retorna string ISO ou null. NUNCA usa new Date(str) direto — o JS
 * interpretaria DD-MM como MM-DD (formato US).
 */
function parseDataBRparaISO(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{2})[-/](\d{2})[-/](\d{4})\s+(\d{2}):(\d{2}):?(\d{2})?/);
  if (!m) return null;
  const [, dia, mes, ano, hora, min, seg] = m;
  return `${ano}-${mes}-${dia}T${hora}:${min}:${seg || '00'}-03:00`;
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
    const horaISO  = parseDataBRparaISO(o.horario_inicio_raw);
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
         retorno, retorno_motivo,
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
         $13, $14,
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
        o.horario_inicio_raw || null,             // $8
        horaISO,                                  // $9
        km,                                       // $10
        prazoKmNovo,                              // $11 (prazo calculado do km NOVO)
        prazoFixo,                                // $12 (prazo fixo do cliente, se houver)
        kmInfo ? !!kmInfo.retorno : false,        // $13
        kmInfo ? (kmInfo.motivo || null) : null,  // $14
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

  // 2. Coleta ÚNICA (com km dos que faltam)
  // require tardio — mesmo padrão do sla-detector.service (módulo já no cache)
  const { coletarOsEmExecucao } = require('./playwright-sla-capture');
  const resultado = await coletarOsEmExecucao({
    buscarKm: {
      pular,
      max: KM_MAX_POR_TICK(),
      concorrencia: KM_CONCORRENCIA(),
    },
  });

  if (!resultado.ok) {
    log(`⚠️ coleta falhou: ${resultado.motivo} — snapshot NÃO alterado`);
    return { ok: false, motivo: resultado.motivo, sessaoExpirada: !!resultado.sessaoExpirada };
  }

  // 3. Snapshot
  const stats = await processarColeta(pool, resultado);
  log(
    `📊 snapshot: ${resultado.ordens.length} OS em tela | ` +
    `${stats.upserts} upserts (${stats.comPrazo} com prazo) | ` +
    `${stats.finalizadas} finalizadas | ` +
    `km consultados: ${Object.keys(resultado.kmPorOs || {}).length}`
  );

  // 4. Detector de rastreio 814/767 — reusa a MESMA coleta (injeta coletarFn
  //    que devolve o resultado pronto; detectarOsNovas nem abre browser)
  let detector = null;
  try {
    detector = await slaDetectorService.detectarOsNovas(pool, async () => resultado);
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
 */
async function consultarStatus(pool) {
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
  for (const r of rows) {
    resumo[r.status] = (resumo[r.status] || 0) + 1;
    if (r.retorno) resumo.RETORNO++;
  }

  // Frescor do snapshot — pro cliente (extensão/painel) exibir heartbeat
  const { rows: [meta] } = await pool.query(
    `SELECT MAX(ultima_vista_em) AS ultima_coleta FROM sla_monitor_snapshot`
  );

  return {
    geradoEm: new Date().toISOString(),
    ultimaColeta: meta && meta.ultima_coleta ? meta.ultima_coleta : null,
    limites: { atencaoMin: atencao, iminenteMin: iminente },
    resumo,
    total: rows.length,
    ordens: rows,
  };
}

module.exports = {
  tickCompleto,
  processarColeta,
  consultarStatus,
  carregarPrazos,
  limparCachePrazos,
  // expostos pra testes unitários
  _internal: { getPrazoPorKm, parseDataBRparaISO, parseNomeProfissional },
};
