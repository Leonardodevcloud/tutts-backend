/**
 * ════════════════════════════════════════════════════════════════════════
 *  CONFIRMAFÁCIL — SLA (painel por filial + alerta de risco no WhatsApp)
 * ════════════════════════════════════════════════════════════════════════
 *  - Meta por CNPJ: Goiânia (42.580.092/0011-48) = 98%, demais = 95%.
 *  - Janela: DIA (corridas criadas hoje em BRT).
 *  - Prazo (deadline): marco zero (criação da corrida) + 2h, com a regra das
 *    16:30 (se criada após 16:30 BRT, conta a partir das 08:00 do dia seguinte).
 *    Mesma regra que o CF usa para gerar o data_previsao. created_at/criado_em
 *    são UTC (servidor Railway) -> convertidos para BRT via AT TIME ZONE.
 *  - Entrega real: MAX(solicitacoes_pontos.data_finalizado) da corrida.
 *  - Risco = ≤15 min do prazo e não entregue. Estouro = passou do prazo e
 *    não entregue. Alerta no grupo EVOLUTION_GROUP_ID_DISP (mesmo da
 *    performance diária da disponibilidade), com dedupe por estágio.
 * ════════════════════════════════════════════════════════════════════════
 */

const RISCO_MIN = 15;                    // minutos para entrar em risco
const CNPJ_GOIANIA = '42580092001148';   // 42.580.092/0011-48
const META_GOIANIA = 98;
const META_DEFAULT = 95;

// Apenas estes embarcadores disparam alerta de SLA no WhatsApp (somente digitos).
// 42.580.092/0011-48 e 42.580.092/0047-59
const CNPJS_ALERTA_SLA = new Set(['42580092001148', '42580092004759']);

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
function metaPorCnpj(cnpj) {
  return soDigitos(cnpj) === CNPJ_GOIANIA ? META_GOIANIA : META_DEFAULT;
}

// ── Expressões SQL reaproveitadas ───────────────────────────────────────
// Marco zero -> BRT (created_at/criado_em são UTC naive no Railway)
const CRIADO_BRT   = `((COALESCE(sc.created_at, v.criado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')`;
const INICIO_BRT   = `(CASE WHEN ${CRIADO_BRT}::time > TIME '16:30'
                            THEN ((date(${CRIADO_BRT}) + 1) + TIME '08:00')
                            ELSE ${CRIADO_BRT} END)`;

// ── 2026-07 [cf-sla-prev-v1] O DEADLINE AGORA VEM DO CF ──────────────────
// O CF calcula a previsao e nos ENTREGA em EmbarqueDTO.dataPrevisao — e o
// _salvarCache ja grava isso em confirmafacil_nfs_cache.data_previsao desde
// sempre. O dado estava no banco, sem uso.
//
// Medido nas 45 notas reais: dataPrevisao = dataEmissao + 120 min em 37 delas.
// E o mesmo SLA de 2h. Os 8 outliers revelaram a regra completa do CF:
//
//   NF  13759  emissao qua 03/06 17:21 -> previsao sex 05/06 10:00
//   NF  20069  emissao sex 12/06 16:33 -> previsao seg 15/06 10:00
//   NF 227685  emissao qui 11/06 23:04 -> previsao sex 12/06 10:00
//
// Apos as 16:30 -> proximo DIA UTIL as 10:00. A 20069 pula o fim de semana.
// A 13759 pula a quinta 04/06 = Corpus Christi. O calendario do CF conhece
// feriado.
//
// O calculo antigo (mantido abaixo como fallback) diverge em DOIS pontos:
//   1) ANCORA: contava de sc.created_at (criacao da CORRIDA). O CF conta de
//      dataEmissao (emissao da NOTA). A diferenca e a nossa latencia de
//      despacho (poller + backoff + janela 07:30-18:20) — ou seja, o painel
//      tirava o nosso proprio atraso da nossa propria regua.
//   2) CALENDARIO: fazia date+1 (dia corrido). O CF vai pro proximo dia UTIL.
//      Sexta 16:33 -> nosso deadline caia num sabado; o do cliente e segunda.
//
// FUSO: a API do CF devolve timestamp naive em hora de parede BRT
// ("2026-06-03T10:43:00"), e o poller grava com new Date(...) num servidor em
// UTC, preservando a parede. Por isso interpretamos como America/Sao_Paulo.
// Se a validacao do LEIA-ME mostrar o contrario, use CF_PREVISAO_TZ=UTC.
const CF_PREVISAO_TZ = process.env.CF_PREVISAO_TZ || 'America/Sao_Paulo';

// Deadline calculado por nos — vira FALLBACK (nota sem data_previsao no CF).
const DEADLINE_CALC = `((${INICIO_BRT} + INTERVAL '2 hours') AT TIME ZONE 'America/Sao_Paulo')`;
// Deadline oficial do CF.
const DEADLINE_CF   = `(c.data_previsao AT TIME ZONE '${CF_PREVISAO_TZ}')`;
// Kill-switch: CF_SLA_USA_PREVISAO=false volta a usar so o calculo antigo.
const DEADLINE_UTC  = String(process.env.CF_SLA_USA_PREVISAO || 'true') === 'false'
  ? DEADLINE_CALC
  : `COALESCE(${DEADLINE_CF}, ${DEADLINE_CALC})`;
// Entrega real -> timestamptz. Prioriza o horario CF-owned (finalizado_em,
// que respeita a correcao manual de horario); se ausente, cai no MAX(data_finalizado)
// do Tutts. Ambos sao UTC naive -> AT TIME ZONE 'UTC'.
const ENTREGA_UTC  = `COALESCE(
                        (v.finalizado_em AT TIME ZONE 'UTC'),
                        ((SELECT MAX(sp.data_finalizado) FROM solicitacoes_pontos sp
                          WHERE sp.solicitacao_id = v.solicitacao_id) AT TIME ZONE 'UTC')
                      )`;

// Busca as corridas de um DIA (BRT) já classificadas (uma linha por corrida).
// dataRef = 'YYYY-MM-DD' (BRT) ou null = hoje.
async function _buscarClassificado(pool, dataRef = null) {
  const sql = `
    WITH base AS (
      SELECT
        c.cnpj_embarcador,
        c.nome_embarcador,
        c.status_cf,
        COALESCE(c.dias_atraso, 0) AS dias_atraso,
        -- [cf-sla-prev-v1] veredito do proprio CF sobre a entrega.
        -- Campo REAL da API e statusNota (o Swagger documenta como notaStatus,
        -- mas a resposta traz statusNota — confirmado 45/45). O _salvarCache
        -- ja gravava isso em status_nota; nunca foi usado.
        UPPER(COALESCE(c.status_nota, '')) AS status_nota,
        (c.data_previsao IS NOT NULL) AS tem_previsao_cf,
        c.destinatario_nome, c.destinatario_cidade, c.destinatario_uf,
        c.numero_nf, c.serie_nf,
        v.solicitacao_id,
        sc.tutts_os_numero,
        ${DEADLINE_UTC} AS deadline,
        ${ENTREGA_UTC}  AS entregue_em
      FROM confirmafacil_nfs_cache c
      JOIN confirmafacil_vinculos v
        ON v.id_embarque = c.id_embarque AND v.cliente_id = c.cliente_id
      JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
      WHERE date(${CRIADO_BRT}) = COALESCE($1::date, (now() AT TIME ZONE 'America/Sao_Paulo')::date)
        -- [cf-canc-v1] 'CANCELADO' NUNCA existiu no CF: sondagem em 20.347 NFs
        -- devolveu so 4 valores de statusEmbarque.nome — ENTREGUE, A_EMBARCAR,
        -- NAO ENTREGUE e ARQUIVADO. Nota cancelada vem como ARQUIVADO. Esta
        -- exclusao era codigo morto e deixava as canceladas contarem no SLA.
        -- 'NAO ENTREGUE' NAO entra aqui: significa "em transito, ainda nao
        -- entregue" (stage=EM_TRANSITO), que e o estado normal de voo.
        AND COALESCE(c.status_cf, '') NOT IN ('ARQUIVADO', 'DEVOLVIDO')
    )
    SELECT
      cnpj_embarcador, nome_embarcador, status_cf,
      destinatario_nome, destinatario_cidade, destinatario_uf,
      numero_nf, serie_nf,
      solicitacao_id, tutts_os_numero, deadline, entregue_em,
      (status_cf = 'ENTREGUE' OR entregue_em IS NOT NULL) AS entregue,
      CASE
        WHEN entregue_em IS NOT NULL
          THEN CASE WHEN entregue_em <= deadline THEN 'no_prazo' ELSE 'estourada' END
        -- [cf-sla-prev-v1] Entrega sem data_finalizado nossa: usa o veredito do
        -- CF. O dias_atraso vira ULTIMO recurso porque a granularidade dele e
        -- em DIAS — inutil para um SLA de 2 HORAS: nota entregue 90 minutos
        -- atrasada tem diasAtraso = 0 e era contada como 'no_prazo', inflando
        -- o percentual do painel.
        -- ENTREGUE_JUSTIFICADO conta como no_prazo: e a contabilidade do
        -- proprio CF (atraso justificado nao pesa contra a transportadora).
        WHEN status_cf = 'ENTREGUE'
          THEN CASE
                 WHEN status_nota = 'ENTREGUE_EM_ATRASO' THEN 'estourada'
                 WHEN status_nota IN ('ENTREGUE_NO_PRAZO', 'ENTREGUE_JUSTIFICADO') THEN 'no_prazo'
                 ELSE CASE WHEN dias_atraso > 0 THEN 'estourada' ELSE 'no_prazo' END
               END
        WHEN now() > deadline THEN 'estourada'
        WHEN (deadline - now()) <= INTERVAL '${RISCO_MIN} minutes' THEN 'em_risco'
        ELSE 'em_rota'
      END AS bucket
    FROM base
  `;
  const { rows } = await pool.query(sql, [dataRef]);
  return rows;
}

// Agrega por filial e calcula pct / margem / projeção
function _agregar(rows) {
  const porFilial = {};
  for (const r of rows) {
    const cnpj = soDigitos(r.cnpj_embarcador);
    if (!porFilial[cnpj]) {
      porFilial[cnpj] = {
        cnpj: r.cnpj_embarcador,
        nome: r.nome_embarcador || r.cnpj_embarcador || 'Sem nome',
        meta: metaPorCnpj(cnpj),
        no_prazo: 0, estourada: 0, em_risco: 0, em_rota: 0,
      };
    }
    const f = porFilial[cnpj];
    if (f[r.bucket] !== undefined) f[r.bucket]++;
  }
  const filiais = Object.values(porFilial).map((f) => {
    const fin = f.no_prazo + f.estourada;
    const m = f.meta / 100;
    const pct = fin ? (f.no_prazo / fin) * 100 : 100;
    const maxFalhas = Math.floor(f.no_prazo * (1 - m) / m);
    const margem = maxFalhas - f.estourada;
    const projTotal = fin + f.em_risco + f.em_rota;
    const proj = projTotal ? (f.no_prazo / projTotal) * 100 : 100; // pessimista
    return {
      ...f,
      pct: Math.round(pct * 10) / 10,
      margem,
      proj: Math.round(proj * 10) / 10,
      finalizadas: fin,
    };
  });
  filiais.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return filiais;
}

// Endpoint do painel: filiais + lista de risco + finalizadas (para a aba).
// dataRef = 'YYYY-MM-DD' (BRT) ou null = hoje (historico).
async function calcularPainel(pool, dataRef = null) {
  const rows = await _buscarClassificado(pool, dataRef);
  const filiais = _agregar(rows);
  const riscos = rows
    .filter((r) => r.bucket === 'em_risco' || (r.bucket === 'estourada' && !r.entregue))
    .map((r) => ({
      solicitacao_id: r.solicitacao_id,
      os: r.tutts_os_numero,
      cnpj: r.cnpj_embarcador,
      filial: r.nome_embarcador,
      cliente: r.destinatario_nome,
      destino: [r.destinatario_cidade, r.destinatario_uf].filter(Boolean).join(' / '),
      deadline: r.deadline,
      bucket: r.bucket,
    }))
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

  // 🆕 Finalizadas do dia (entregues), classificadas dentro/fora do prazo,
  // com o horario efetivo de finalizacao (entregue_em).
  const finalizadas = rows
    .filter((r) => r.entregue && (r.bucket === 'no_prazo' || r.bucket === 'estourada'))
    .map((r) => ({
      solicitacao_id: r.solicitacao_id,
      os: r.tutts_os_numero,
      cnpj: r.cnpj_embarcador,
      filial: r.nome_embarcador,
      cliente: r.destinatario_nome,
      destino: [r.destinatario_cidade, r.destinatario_uf].filter(Boolean).join(' / '),
      numero_nf: r.numero_nf,
      serie_nf: r.serie_nf,
      deadline: r.deadline,
      entregue_em: r.entregue_em,
      bucket: r.bucket, // 'no_prazo' | 'estourada'
    }))
    .sort((a, b) => new Date(b.entregue_em || 0) - new Date(a.entregue_em || 0));

  return { geradoEm: new Date().toISOString(), dataRef: dataRef || null, filiais, riscos, finalizadas };
}

// ── Alerta WhatsApp (mesmo padrão/grupo da disponibilidade) ─────────────
async function _enviarWhats(texto) {
  const ativo = (process.env.WHATSAPP_NOTIF_ATIVO || 'false').toLowerCase() === 'true';
  if (!ativo) return { enviado: false, motivo: 'WHATSAPP_NOTIF_ATIVO desativado' };
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instancia = process.env.EVOLUTION_INSTANCE;
  const grupoId = (process.env.EVOLUTION_GROUP_ID_DISP || '').trim();
  if (!grupoId || !baseUrl || !apiKey || !instancia) {
    return { enviado: false, motivo: 'config_incompleta' };
  }
  const url = `${baseUrl}/message/sendText/${instancia}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ number: grupoId, text: texto }),
  });
  return resp.ok ? { enviado: true } : { enviado: false, motivo: 'erro_api', status: resp.status };
}

function _hmBRT(d) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
  }).format(new Date(d));
}

function _montarMensagem(estagio, r, filial) {
  const deadline = new Date(r.deadline);
  const remMin = Math.round((deadline - Date.now()) / 60000);
  const perf = filial
    ? `\n📊 Performance hoje (${filial.nome}): ${filial.pct.toFixed(1)}% / meta ${filial.meta}% · margem ${filial.margem <= 0 ? '0 (no limite!)' : filial.margem}`
    : '';
  const cab = estagio === 'estouro'
    ? `🔴 *SLA ESTOUROU — ${r.nome_embarcador || ''}*`
    : `🚨 *SLA EM RISCO — ${r.nome_embarcador || ''}*`;
  const linhaTempo = estagio === 'estouro'
    ? `Venceu ${_hmBRT(deadline)} e ainda não foi entregue.`
    : `Vence ${_hmBRT(deadline)} (faltam ${remMin > 0 ? remMin : 0} min).`;
  return [
    cab,
    `OS ${r.tutts_os_numero || '—'} · ${r.destinatario_nome || ''}`,
    linhaTempo,
    `Destino: ${[r.destinatario_cidade, r.destinatario_uf].filter(Boolean).join(' / ')}`,
    `👉 Priorize a entrega AGORA.${perf}`,
  ].join('\n');
}

// Detecta corridas em risco/estouro e dispara alerta (com dedupe por estágio)
async function verificarRiscosEAlertar(pool) {
  const rows = await _buscarClassificado(pool);
  if (!rows.length) return { verificadas: 0, enviados: 0 };
  const filiais = _agregar(rows);
  const fmap = {};
  filiais.forEach((f) => { fmap[soDigitos(f.cnpj)] = f; });

  let enviados = 0;
  for (const r of rows) {
    let estagio = null;
    if (!r.entregue && r.bucket === 'estourada') estagio = 'estouro';
    else if (r.bucket === 'em_risco') estagio = 'risco';
    if (!estagio || !r.solicitacao_id) continue;
    // So alerta para os embarcadores configurados (os demais ficam apenas no painel).
    if (!CNPJS_ALERTA_SLA.has(soDigitos(r.cnpj_embarcador))) continue;

    // dedupe atômico: só envia se for a 1ª vez deste (corrida, estágio)
    const ins = await pool.query(
      `INSERT INTO confirmafacil_sla_alertas (solicitacao_id, estagio)
       VALUES ($1, $2) ON CONFLICT (solicitacao_id, estagio) DO NOTHING RETURNING id`,
      [r.solicitacao_id, estagio]
    );
    if (ins.rowCount !== 1) continue; // já alertado

    try {
      const msg = _montarMensagem(estagio, r, fmap[soDigitos(r.cnpj_embarcador)]);
      const res = await _enviarWhats(msg);
      if (res.enviado) enviados++;
      else {
        // se não enviou (config/api), remove o registro para tentar de novo depois
        await pool.query(
          `DELETE FROM confirmafacil_sla_alertas WHERE solicitacao_id = $1 AND estagio = $2`,
          [r.solicitacao_id, estagio]
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[CF SLA] erro ao enviar alerta:', e.message);
      await pool.query(
        `DELETE FROM confirmafacil_sla_alertas WHERE solicitacao_id = $1 AND estagio = $2`,
        [r.solicitacao_id, estagio]
      ).catch(() => {});
    }
  }
  return { verificadas: rows.length, enviados };
}

// Envia uma mensagem de TESTE no mesmo grupo (valida o disparo)
async function enviarTeste(texto) {
  const msg = (texto && String(texto).trim()) || [
    '🧪 *TESTE — Alerta de SLA (ConfirmaFácil)*',
    'Mensagem de teste do painel de SLA.',
    'Se você está vendo isso, o disparo no grupo está OK. ✅',
    '📊 Exemplo: Performance hoje (Goiânia): 98.0% / meta 98% · margem 0',
  ].join('\n');
  const res = await _enviarWhats(msg);
  return { ...res, mensagem: msg };
}

// ══════════════════════════════════════════════════
// [cf-sla-historico-v1] Histórico de SLA por período (mensal/semanal)
// ══════════════════════════════════════════════════
// Agrega as corridas de um RANGE de datas, classificando cada uma pelo mesmo
// criterio do painel diario (deadline do CF via DEADLINE_UTC + statusNota).
// Devolve, por filial: totais do periodo, e uma serie temporal (por dia) do %
// no prazo — para o grafico de tendencia.
//
// Reusa DEADLINE_UTC/ENTREGA_UTC/CRIADO_BRT ja definidos acima, entao o
// deadline segue a previsao do CF igual ao painel diario.
async function calcularHistorico(pool, { de, ate, cnpj = null } = {}) {
  // Sem range explicito: mes corrente.
  const hojeBRT = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
  const deExpr  = de  ? '$1::date' : `date_trunc('month', ${hojeBRT})::date`;
  const ateExpr = ate ? '$2::date' : hojeBRT;

  const params = [];
  // Mantemos posicoes fixas $1=de $2=ate $3=cnpj mesmo quando nulos, com COALESCE.
  params.push(de || null);
  params.push(ate || null);
  params.push(cnpj ? cnpj.replace(/\D/g, '') : null);

  const sql = `
    WITH base AS (
      SELECT
        c.cnpj_embarcador,
        c.nome_embarcador,
        c.status_cf,
        COALESCE(c.dias_atraso, 0) AS dias_atraso,
        UPPER(COALESCE(c.status_nota, '')) AS status_nota,
        date(${CRIADO_BRT}) AS dia_brt,
        ${DEADLINE_UTC} AS deadline,
        ${ENTREGA_UTC}  AS entregue_em
      FROM confirmafacil_nfs_cache c
      JOIN confirmafacil_vinculos v
        ON v.id_embarque = c.id_embarque AND v.cliente_id = c.cliente_id
      JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
      WHERE date(${CRIADO_BRT}) >= COALESCE($1::date, date_trunc('month', ${hojeBRT})::date)
        AND date(${CRIADO_BRT}) <= COALESCE($2::date, ${hojeBRT})
        AND ($3::text IS NULL OR REGEXP_REPLACE(c.cnpj_embarcador,'[^0-9]','','g') = $3)
        AND COALESCE(c.status_cf, '') NOT IN ('ARQUIVADO', 'DEVOLVIDO')
    ),
    classificado AS (
      SELECT cnpj_embarcador, nome_embarcador, dia_brt,
        (status_cf = 'ENTREGUE' OR entregue_em IS NOT NULL) AS entregue,
        CASE
          WHEN entregue_em IS NOT NULL
            THEN CASE WHEN entregue_em <= deadline THEN 'no_prazo' ELSE 'estourada' END
          WHEN status_cf = 'ENTREGUE'
            THEN CASE
                   WHEN status_nota = 'ENTREGUE_EM_ATRASO' THEN 'estourada'
                   WHEN status_nota IN ('ENTREGUE_NO_PRAZO','ENTREGUE_JUSTIFICADO') THEN 'no_prazo'
                   ELSE CASE WHEN dias_atraso > 0 THEN 'estourada' ELSE 'no_prazo' END
                 END
          ELSE NULL  -- ainda nao finalizada: nao entra no historico
        END AS bucket
      FROM base
    )
    SELECT cnpj_embarcador, nome_embarcador, dia_brt,
      COUNT(*) FILTER (WHERE bucket = 'no_prazo')  AS no_prazo,
      COUNT(*) FILTER (WHERE bucket = 'estourada') AS estourada
    FROM classificado
    WHERE bucket IS NOT NULL
    GROUP BY cnpj_embarcador, nome_embarcador, dia_brt
    ORDER BY nome_embarcador, dia_brt
  `;
  const { rows } = await pool.query(sql, params);

  // Monta por filial: totais + serie diaria
  const porFilial = {};
  for (const r of rows) {
    const key = soDigitos(r.cnpj_embarcador);
    if (!porFilial[key]) {
      porFilial[key] = {
        cnpj: r.cnpj_embarcador,
        nome: r.nome_embarcador || r.cnpj_embarcador || 'Sem nome',
        meta: metaPorCnpj(key),
        no_prazo: 0, estourada: 0,
        serie: [],
      };
    }
    const f = porFilial[key];
    const np = Number(r.no_prazo), es = Number(r.estourada);
    f.no_prazo += np;
    f.estourada += es;
    const fin = np + es;
    f.serie.push({
      dia: (r.dia_brt instanceof Date) ? r.dia_brt.toISOString().slice(0, 10) : String(r.dia_brt),
      no_prazo: np, estourada: es,
      pct: fin ? Math.round((np / fin) * 1000) / 10 : null,
    });
  }

  const filiais = Object.values(porFilial).map((f) => {
    const fin = f.no_prazo + f.estourada;
    return {
      ...f,
      total: fin,
      pct: fin ? Math.round((f.no_prazo / fin) * 1000) / 10 : null,
    };
  }).sort((a, b) => a.nome.localeCompare(b.nome));

  return { de: de || null, ate: ate || null, filiais };
}

module.exports = { metaPorCnpj, calcularPainel, calcularHistorico, verificarRiscosEAlertar, enviarTeste };
