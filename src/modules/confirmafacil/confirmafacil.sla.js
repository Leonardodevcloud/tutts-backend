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
const DEADLINE_UTC = `((${INICIO_BRT} + INTERVAL '2 hours') AT TIME ZONE 'America/Sao_Paulo')`;
// Entrega real (data_finalizado é UTC naive) -> timestamptz
const ENTREGA_UTC  = `((SELECT MAX(sp.data_finalizado) FROM solicitacoes_pontos sp
                        WHERE sp.solicitacao_id = v.solicitacao_id) AT TIME ZONE 'UTC')`;

// Busca as corridas do DIA já classificadas (uma linha por corrida)
async function _buscarClassificado(pool) {
  const sql = `
    WITH base AS (
      SELECT
        c.cnpj_embarcador,
        c.nome_embarcador,
        c.status_cf,
        COALESCE(c.dias_atraso, 0) AS dias_atraso,
        c.destinatario_nome, c.destinatario_cidade, c.destinatario_uf,
        v.solicitacao_id,
        sc.tutts_os_numero,
        ${DEADLINE_UTC} AS deadline,
        ${ENTREGA_UTC}  AS entregue_em
      FROM confirmafacil_nfs_cache c
      JOIN confirmafacil_vinculos v
        ON v.id_embarque = c.id_embarque AND v.cliente_id = c.cliente_id
      JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
      WHERE date(${CRIADO_BRT}) = (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND COALESCE(c.status_cf, '') NOT IN ('CANCELADO', 'DEVOLVIDO')
    )
    SELECT
      cnpj_embarcador, nome_embarcador, status_cf,
      destinatario_nome, destinatario_cidade, destinatario_uf,
      solicitacao_id, tutts_os_numero, deadline, entregue_em,
      (status_cf = 'ENTREGUE' OR entregue_em IS NOT NULL) AS entregue,
      CASE
        WHEN entregue_em IS NOT NULL
          THEN CASE WHEN entregue_em <= deadline THEN 'no_prazo' ELSE 'estourada' END
        WHEN status_cf = 'ENTREGUE'
          THEN CASE WHEN dias_atraso > 0 THEN 'estourada' ELSE 'no_prazo' END
        WHEN now() > deadline THEN 'estourada'
        WHEN (deadline - now()) <= INTERVAL '${RISCO_MIN} minutes' THEN 'em_risco'
        ELSE 'em_rota'
      END AS bucket
    FROM base
  `;
  const { rows } = await pool.query(sql);
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

// Endpoint do painel: filiais + lista de risco (para a aba)
async function calcularPainel(pool) {
  const rows = await _buscarClassificado(pool);
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
  return { geradoEm: new Date().toISOString(), filiais, riscos };
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

module.exports = { metaPorCnpj, calcularPainel, verificarRiscosEAlertar, enviarTeste };
