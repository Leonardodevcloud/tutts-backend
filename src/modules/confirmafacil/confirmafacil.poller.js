'use strict';

/**
 * MÓDULO CONFIRMAFÁCIL — Poller
 *
 * Roda via node-cron a cada 1 minuto.
 * Para cada cliente com polling_ativo = TRUE:
 *   1. Busca NFs novas no CF (GET /filter/embarque)
 *   2. Ignora NFs que já têm vínculo em confirmafacil_vinculos
 *   3. Para cada NF nova:
 *      a. Busca endereço de coleta pelo cnpj_embarcador
 *      b. Monta pontos (coleta + destinatário)
 *      c. Cria corrida na API Tutts
 *      d. Salva solicitacao_corrida + solicitacoes_pontos
 *      e. Cria vínculo idEmbarque ↔ solicitacao_id
 */

const httpRequest     = require('../../shared/utils/httpRequest');
const { getConfirmaFacilAuth } = require('./confirmafacil.auth');
const slaMod = require('./confirmafacil.sla');
const reconcMod = require('./confirmafacil.reconciliacao');

const CF_FILTER_URL  = 'https://utilities.confirmafacil.com.br/filter/embarque';
const CF_OCORRENCIA_URL = 'https://utilities.confirmafacil.com.br/filter/ocorrencia';
const TUTTS_API_URL  = 'https://tutts.com.br/integracao';
const TUTTS_WEBHOOK  = 'https://tutts-backend-production.up.railway.app/api/webhook/tutts';
const PAGE_SIZE      = 50;

// ── 2026-07 [cf-stage-v1] Filtros como QUERY PARAM (o filtroDTO e ignorado) ──
// Sondagem na API de consulta do CF (GET /filter/embarque) provou que o CF
// ignora o filtroDTO INTEIRO — nao so page/size, como o comentario antigo dizia:
//
//   numero=137057   DENTRO do filtroDTO -> 20300 registros (todos!)
//   numero=137057   como query param    -> 1 registro
//   De/Ate janela 1 dia DENTRO          -> 20300
//   De/Ate janela 1 dia como param      -> 1237
//   stage=CANCELADAS DENTRO             -> 20300 (e devolve A_EMBARCAR)
//   stage=CANCELADAS como param         -> 45 (ARQUIVADO)   <- correto
//   stage=A_EMBARCAR como param         -> 598
//
// Consequencia: de/ate/cnpjTransportadora NUNCA filtraram nada, e o
// CF_POLLER_DIAS_JANELA era PLACEBO (o CF sempre devolveu o default dele:
// ultimos 6 meses). Agora promovemos de/ate/stage a query params soltos.
//
// ATENCAO: com isso o CF_POLLER_DIAS_JANELA passa a funcionar DE VERDADE pela
// primeira vez. Antes a janela era ignorada e a busca varria tudo (o que, por
// acidente, era abrangente). Comece com 7 dias e observe. O fallback de cache
// (_processarPendentesDoCache) e o id-tailing cobrem o que ficar fora.
//
// Kill-switch: CF_USE_STAGE_PARAM=false volta ao comportamento antigo.
const CF_USE_STAGE_PARAM = process.env.CF_USE_STAGE_PARAM !== 'false';

// ── 2026-07 [cf-canc-v1] Poll de notas CANCELADAS ────────────────────────
// O CF NAO notifica cancelamento, e a listagem padrao do /filter/embarque
// EXCLUI as canceladas. Provado pela aritmetica da sondagem:
//   stage=A_EMBARCAR   598
//   stage=EM_TRANSITO  163   -> EM_ABERTO 761 (598+163, exato)
//   stage=ENTREGUES  19539   -> 761 + 19539 = 20300 = total sem filtro (exato)
//   stage=CANCELADAS    45   -> FORA da conta. Nunca aparece por acidente.
// A unica forma de ver uma nota cancelada e pedir com ?stage=CANCELADAS.
//
// CF_POLL_CANCELADAS=false        desliga o poll inteiro
// CF_CANCELADAS_CANCELA_OS=false  so marca no cache, nao cancela OS na Mapp
// CF_CANCELADAS_ALERTA_WHATS=true liga alerta no grupo (default: off, so log)
// CF_CANCELADAS_CICLOS=N          roda 1x a cada N ciclos (default 10 = ~10min)
const CF_POLL_CANCELADAS       = process.env.CF_POLL_CANCELADAS !== 'false';
const CF_CANCELADAS_CANCELA_OS = process.env.CF_CANCELADAS_CANCELA_OS !== 'false';
const CF_CANCELADAS_ALERTA_WHATS = String(process.env.CF_CANCELADAS_ALERTA_WHATS || 'false') === 'true';
const CF_CANCELADAS_CICLOS     = parseInt(process.env.CF_CANCELADAS_CICLOS, 10) > 0
  ? parseInt(process.env.CF_CANCELADAS_CICLOS, 10) : 10;

// statusNota que significam "ja foi entregue" — nota ARQUIVADO com um destes
// e arquivamento de ROTINA (entregue e encerrada), NAO cancelamento.
// Da sondagem real das 45 canceladas: 10 vieram ENTREGUE_NO_PRAZO (diasAtraso 0,
// com Cod.1) e 35 vieram ATRASADO (22-32 dias, 25 sem ocorrencia nenhuma).
// Cancelar OS baseado so em ARQUIVADO cancelaria as 10 entregues. NAO FACA ISSO.
const CF_STATUSNOTA_ENTREGUE = [
  'ENTREGUE_NO_PRAZO', 'ENTREGUE_EM_ATRASO', 'ENTREGUE_JUSTIFICADO',
];

// ── 🕒 2026-06: Janela de criacao de corrida na MAPP (SO poller automatico) ──
// Fora de [INICIO, FIM) no fuso America/Bahia, a criacao na MAPP e ADIADA pro
// proximo INICIO (07:30). Reusa o backoff existente (proximo_retry futuro): NAO
// cria tabela/worker novo nem mexe na chamada da MAPP. Kill-switch por env.
// A rota manual /criar-corrida NAO passa por aqui (cria sempre na hora).
const CF_JANELA_CRIACAO_ATIVA = process.env.CF_JANELA_CRIACAO_ATIVA !== 'false'; // default: ligado
const CF_JANELA_TZ            = process.env.CF_JANELA_TZ || 'America/Bahia';
function _hmParaMin(hhmm, def) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (Number(m[1]) * 60 + Number(m[2])) : def;
}
const CF_JANELA_INICIO_MIN = _hmParaMin(process.env.CF_JANELA_INICIO, 7 * 60 + 30);  // 07:30
const CF_JANELA_FIM_MIN    = _hmParaMin(process.env.CF_JANELA_FIM,   18 * 60 + 20);  // 18:20

// Minuto-do-dia atual no fuso configurado (0..1439).
function _minutoDoDiaTz(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CF_JANELA_TZ, hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(d);
    const h  = Number(parts.find(p => p.type === 'hour').value);
    const mm = Number(parts.find(p => p.type === 'minute').value);
    return h * 60 + mm;
  } catch (_) {
    // Fallback: Bahia = UTC-3 fixo (sem horario de verao)
    const u = d.getUTCHours() * 60 + d.getUTCMinutes();
    return ((u - 180) % 1440 + 1440) % 1440;
  }
}
// Minutos ate a proxima abertura da janela. 0 = ja estamos dentro.
function _minutosAteJanela(d = new Date()) {
  const agora = _minutoDoDiaTz(d);
  if (agora >= CF_JANELA_INICIO_MIN && agora < CF_JANELA_FIM_MIN) return 0;
  if (agora < CF_JANELA_INICIO_MIN) return CF_JANELA_INICIO_MIN - agora;  // hoje de manha (inclui madrugada)
  return (1440 - agora) + CF_JANELA_INICIO_MIN;                          // passou do FIM -> amanha 07:30
}

// ── 2026-07 [cf-corte-diautil-v1] Corte por DIA UTIL usando a previsao do CF ──
// Regra pedida: nota fora do horario OU no fim de semana OU em vespera de
// feriado nao gera corrida no mesmo dia — gera no proximo DIA UTIL as 08:00
// (sexta a noite -> segunda; vespera de feriado -> depois do feriado).
//
// NAO recriamos calendario de feriado. O CF ja entrega isso pronto em
// EmbarqueDTO.dataPrevisao — que e "proximo dia util as 10:00" e comprovadamente
// pula fim de semana E feriado (NF 13759: qua 03/06 -> sex 05/06, pulando
// Corpus Christi na quinta). Adiamos a criacao para 2h ANTES dessa previsao
// (as 08:00 do dia que o CF definiu), preservando a folga de 2h do SLA.
//
// Fuso: dataPrevisao vem naive em parede BRT ("2026-06-05T10:00:00").
// Interpretamos com o mesmo CF_JANELA_TZ do resto do arquivo.
const CF_CORTE_USA_PREVISAO = process.env.CF_CORTE_USA_PREVISAO !== 'false';

// Minutos de AGORA ate as 08:00 (parede BRT) do dia da dataPrevisao do CF.
// Retorna 0 se nao houver previsao utilizavel (cai no corte por horario puro)
// ou se o alvo ja passou (nota antiga: gera agora, respeitando so o horario).
function _minutosAtePrevisaoCF(dataPrevisao, d = new Date()) {
  if (!dataPrevisao) return 0;
  const m = String(dataPrevisao).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;

  // [cf-corte-diautil-v2] So adia se a previsao for DEPOIS DE AMANHA.
  // Regra pedida: nota que chega em dia util dentro do horario com previsao
  // pra HOJE ou AMANHA e criada hoje (respeitando so a janela 07:30-18:20).
  // So adiamos quando a previsao do CF pula 2+ dias — que e exatamente o que
  // acontece em fim de semana (sex->seg) e vespera de feriado (o CF ja embute
  // isso na dataPrevisao). Assim o adiamento continua cobrindo fds/feriado,
  // mas para de segurar nota de dia normal cuja entrega e amanha.
  //
  // Comparacao por DATA DE CALENDARIO no fuso CF_JANELA_TZ (nao por horas),
  // pra "amanha 23:00" contar como amanha, nao como depois de amanha.
  const _ymdTz = (dt) => {
    try {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: CF_JANELA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(dt);
      const y = p.find(x => x.type === 'year').value;
      const mo = p.find(x => x.type === 'month').value;
      const da = p.find(x => x.type === 'day').value;
      return `${y}-${mo}-${da}`;
    } catch (_) {
      return dt.toISOString().slice(0, 10);
    }
  };
  // dias corridos entre HOJE (no fuso) e a data da previsao.
  const hojeYmd = _ymdTz(d);
  const prevYmd = `${m[1]}-${m[2]}-${m[3]}`;
  const hojeMs = Date.UTC(...hojeYmd.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)));
  const prevMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const diasCorridos = Math.round((prevMs - hojeMs) / 86400000);

  // Previsao hoje (0) ou amanha (1) -> NAO adia por previsao (cria hoje, so horario).
  // Previsao a 2+ dias -> adia pra 08:00 do dia da previsao (fds/feriado).
  if (diasCorridos <= 1) return 0;

  // Alvo = 08:00 BRT (= 11:00 UTC, Bahia UTC-3 sem horario de verao) do dia da previsao.
  const alvoUtcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 11, 0, 0);
  const diffMin = Math.round((alvoUtcMs - d.getTime()) / 60000);
  return diffMin > 0 ? diffMin : 0;
}

// ── 🕒 2026-06 (v2): horario de funcionamento do FULL SCAN (rede ampla) ──
// Fora desta janela, o full scan NAO roda; id-tailing + ocorrencia + cache
// seguem 24/7 a cada 60s (captacao de NF nova nunca para). TZ = CF_JANELA_TZ.
// Padrao: Seg-Sex 07:00-19:00, Sab 07:00-13:00, Dom off.
// Kill-switch: CF_FULLSCAN_HORARIO=false (volta a rodar 24h, so com o throttle).
const CF_FULLSCAN_HORARIO = process.env.CF_FULLSCAN_HORARIO !== 'false';
const _DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function _dentroHorarioFullScan(d = new Date()) {
  if (!CF_FULLSCAN_HORARIO) return true;
  let dow, min;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CF_JANELA_TZ, hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d);
    dow = _DOW[parts.find((p) => p.type === 'weekday').value];
    const h  = Number(parts.find((p) => p.type === 'hour').value);
    const mm = Number(parts.find((p) => p.type === 'minute').value);
    min = h * 60 + mm;
  } catch (_) {
    const u = d.getUTCHours() * 60 + d.getUTCMinutes();
    min = ((u - 180) % 1440 + 1440) % 1440; // Bahia = UTC-3
    dow = d.getUTCDay();
  }
  if (dow === 0) return false;                          // domingo: off
  if (dow === 6) return min >= 7 * 60 && min < 13 * 60; // sabado: 07-13
  return min >= 7 * 60 && min < 19 * 60;                // seg-sex: 07-19
}

class ConfirmaFacilPoller {
  constructor(pool) {
    this.pool    = pool;
    this.auth    = getConfirmaFacilAuth();
    this._rodando = false;
    this._ultimoFullScan = new Map(); // [CF throttle] ts do ultimo full scan por config.id
  }

  // ══════════════════════════════════════════════════
  // INICIALIZAÇÃO
  // ══════════════════════════════════════════════════

  iniciar() {
    console.log('✅ [CF Poller] iniciado — polling a cada 1 minuto (setInterval)');
    // Rodar imediatamente na inicialização
    setTimeout(async () => {
      if (this._rodando) return;
      this._rodando = true;
      try { await this._ciclo(); }
      catch (err) { console.error('❌ [CF Poller] erro ciclo inicial:', err.message); }
      finally { this._rodando = false; }
    }, 5000); // 5s após start

    // Depois a cada 60s
    setInterval(async () => {
      if (this._rodando) {
        console.log('[CF Poller] ciclo anterior ainda rodando — pulando');
        return;
      }
      this._rodando = true;
      try { await this._ciclo(); }
      catch (err) { console.error('❌ [CF Poller] erro no ciclo:', err.message); }
      finally { this._rodando = false; }
    }, 60 * 1000);

    // 🛡️ Verificação de risco de SLA + alerta WhatsApp (a cada 60s)
    setInterval(async () => {
      if (!_dentroHorarioFullScan()) return; // [CF v3] alerta de risco so em horario comercial
      try { await slaMod.verificarRiscosEAlertar(this.pool); }
      catch (err) { console.error('❌ [CF SLA] erro na verificação de risco:', err.message); }
    }, 60 * 1000);

    // 🔁 Reconciliação: reenvia entregas que não chegaram ao CF (a cada 3 min)
    setInterval(async () => {
      try { await reconcMod.reconciliarEntregas(this.pool); }
      catch (err) { console.error('❌ [CF Reconc] erro na reconciliação:', err.message); }
    }, 3 * 60 * 1000);
  }

  // ══════════════════════════════════════════════════
  // CICLO PRINCIPAL
  // ══════════════════════════════════════════════════

  async _ciclo() {
    // [CF v3] Fora do horario comercial o ciclo de descoberta (id-tailing/
    // ocorrencia/cache/full scan) e pausado. NF do CF que cair fora e importada
    // quando a janela reabrir. Operacao MANUAL via painel segue 24/7 (nao passa
    // por aqui). Alinhado ao SLA: nota apos 16:30 ja conta a partir de 08:00.
    if (!_dentroHorarioFullScan()) {
      console.log('[CF Poller] fora do horario comercial - descoberta pausada (seg-sex 07-19, sab 07-13, dom off). Painel manual segue 24/7.');
      return;
    }
    console.log('[CF Poller] iniciando ciclo...');

    // 🧹 Limpa vínculos órfãos antes de processar. Corridas que nunca viraram OS
    // (fantasma) ou foram canceladas deixam o vínculo preso, e como o poller ignora
    // NF com vínculo, a NF ficaria travada pra sempre. Removendo o órfão, a NF volta
    // a ser elegível pra recriação automática.
    try {
      const { rowCount: orfaos } = await this.pool.query(`
        DELETE FROM confirmafacil_vinculos v
        USING solicitacoes_corrida s
        WHERE v.solicitacao_id = s.id
          AND (
            LOWER(COALESCE(s.status, '')) LIKE '%cancel%'
            OR (
              s.tutts_os_numero IS NULL
              AND s.codigo_profissional IS NULL
              AND s.criado_em < NOW() - INTERVAL '15 minutes'
            )
          )
      `);
      if (orfaos > 0) console.log(`[CF Poller] 🧹 ${orfaos} vínculo(s) órfão(s) de corrida fantasma/cancelada removido(s) — NFs liberadas`);
    } catch (e) {
      console.error('[CF Poller] erro ao limpar vínculos órfãos:', e.message);
    }

    const { rows: configs } = await this.pool.query(`
      SELECT
        cf.id,
        cf.cliente_id,
        cf.cf_email,
        cf.cf_senha,
        cf.cf_id_cliente,
        cf.cf_id_produto,
        cf.cnpj_transportadora,
        cf.mapa_ocorrencias,
        cf.ultimo_polling,
        cs.tutts_token_api,
        cs.tutts_codigo_cliente,
        cs.nome AS cliente_nome,
        cs.forma_pagamento_padrao,
        cs.centro_custo_padrao
      FROM confirmafacil_config cf
      INNER JOIN clientes_solicitacao cs ON cs.id = cf.cliente_id
      WHERE cf.ativo = TRUE AND cf.polling_ativo = TRUE
    `);

    console.log(`[CF Poller] configs ativas: ${configs.length}`);
    if (configs.length === 0) return;

    for (const config of configs) {
      try {
        await this._processarCliente(config);
      } catch (err) {
        console.error(`❌ [CF Poller] erro cliente ${config.cliente_id}:`, err.message);
      }
    }
  }

  // ══════════════════════════════════════════════════
  // PROCESSAR UM CLIENTE
  // ══════════════════════════════════════════════════

  async _processarCliente(config) {
    console.log(`[CF Poller] processando cliente ${config.cliente_id} codCliente=${config.tutts_codigo_cliente}`);
    if (!this._retryTableReady) { await this._ensureTabelaRetry(); this._retryTableReady = true; }
    this._puladosBackoff = 0;
    const token = await this.auth.obterToken(config.cliente_id, config);

    // Janela de busca por DATA. Antes era fixa em 2024/01/01, o que fazia a
    // busca crescer sem limite (ex.: 4148 NFs / 83 paginas a cada minuto) e o
    // ciclo travar/ficar lento, deixando de alcancar as NFs novas (A_EMBARCAR
    // costumam estar nas ultimas paginas). Agora a janela e curta e configuravel.
    // O fallback de cache (_processarPendentesDoCache) continua cobrindo
    // qualquer A_EMBARCAR ja conhecida que ficar fora da janela.
    const agora = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const DIAS_JANELA = parseInt(process.env.CF_POLLER_DIAS_JANELA, 10) > 0
      ? parseInt(process.env.CF_POLLER_DIAS_JANELA, 10)
      : 1;
    const inicio = new Date(agora.getTime() - DIAS_JANELA * 24 * 60 * 60 * 1000);
    const deStr  = `${inicio.getFullYear()}/${p(inicio.getMonth()+1)}/${p(inicio.getDate())} 00:00:00`;
    const ateStr = `${agora.getFullYear()}/${p(agora.getMonth()+1)}/${p(agora.getDate())} 23:59:59`;

    // Buscar NFs paginando
    let page = 0;
    let totalProcessadas = 0;

    // [CF throttle 2026-06] A paginacao completa do /filter/embarque (centenas de
    // paginas / milhares de NFs por ciclo) e redundante com id-tailing + ocorrencia
    // + cache, que rodam todo ciclo e ja cacheiam/despacham. Aqui ela vira uma
    // "rede ampla" periodica. Frequencia via CF_EMBARQUE_FULLSCAN_MIN (default 60).
    const _FULLSCAN_MIN = parseInt(process.env.CF_EMBARQUE_FULLSCAN_MIN, 10) > 0
      ? parseInt(process.env.CF_EMBARQUE_FULLSCAN_MIN, 10)
      : 60;
    const _ultFS = this._ultimoFullScan.get(config.id) || 0;
    const _emHorario = _dentroHorarioFullScan();
    const _devesFullScan = _emHorario && (Date.now() - _ultFS) >= _FULLSCAN_MIN * 60 * 1000;

    if (_devesFullScan) {
      this._ultimoFullScan.set(config.id, Date.now());
      while (true) {
      // IMPORTANTE: page/size vao FORA do filtroDTO, como query params na URL.
      // O CF ignora page/size quando enviados dentro do filtroDTO (por isso
      // antes devolvia sempre a primeira pagina). Ver _buscarEmbarques.
      const filtro = {
        de:   deStr,
        ate:  ateStr,
        cnpjTransportadora: [config.cnpj_transportadora],
      };

      const resp = await this._buscarEmbarques(filtro, page, config);
      if (!resp) {
        console.warn(`⚠️ [CF Poller] pg ${page}: paginacao interrompida (falha no CF apos retries — provavel instabilidade GKO)`);
        break;
      }

      const lista = resp.respostas || resp.content || [];
      // [cf-stage-v1] totalCount deve cair de ~20.300 para a janela real.
      // Se continuar 20.300, o CF_USE_STAGE_PARAM esta off ou o CF mudou.
      console.log(`[CF Poller] pg ${page}: ${lista.length} NFs | totalCount=${resp.totalCount} totalPages=${resp.totalPages} | janela=${DIAS_JANELA}d params=${CF_USE_STAGE_PARAM ? 'on' : 'OFF'}`);
      if (!Array.isArray(lista) || lista.length === 0) break;

      for (const item of lista) {
        try {
          await this._salvarCache(item, config.cliente_id); // cache de TODA NF
          const statusNF = String(item.statusEmbarque?.nome || '').toUpperCase();
          if (statusNF !== 'A_EMBARCAR') continue;           // corrida so p/ pendente
          await this._processarNF(item, config);
          totalProcessadas++;
        } catch (err) {
          console.error(`⚠️ [CF Poller] erro NF idEmbarque ${item.idEmbarque}:`, err.message);
        }
      }

      page++;
      // O CF informa totalPages mas NAO devolve pagina vazia no fim — ele recicla
      // os dados. Entao paramos no fim real informado por ele, senao o poller fica
      // relendo duplicata por centenas de paginas (ciclo lento + atropelado).
      if (resp.totalPages && page >= Number(resp.totalPages)) {
        console.log(`[CF Poller] fim das paginas reais (totalPages=${resp.totalPages})`);
        break;
      }
      if (page > 300) {
        console.warn('[CF Poller] limite de 300 paginas atingido — parando por seguranca');
        break;
      }
    }
    } else if (!_emHorario) {
      console.log('[CF Poller] full scan fora do horario comercial (seg-sex 07-19, sab 07-13, dom off) - id-tailing/ocorrencia/cache seguem normais 24/7');
    } else {
      const _faltaMs = _FULLSCAN_MIN * 60 * 1000 - (Date.now() - _ultFS);
      const _faltaMin = Math.max(0, Math.ceil(_faltaMs / 60000));
      console.log('[CF Poller] full scan adiado (throttle ' + _FULLSCAN_MIN + 'min) - proximo em ~' + _faltaMin + 'min; id-tailing/ocorrencia/cache seguem normais');
    }

    // Fallback via /filter/ocorrencia (endpoint que FUNCIONA e e SCOPED a nossa
    // conta). O /filter/embarque (lista) entra em erro Hibernate ("is closed")
    // no lado do GKO; o /ocorrencia continua 200 e so retorna ocorrencias do
    // usuario autenticado (a propria Tutts), trazendo o objeto "embarque"
    // completo aninhado. Usamos para reconciliar status no cache e despachar
    // A_EMBARCAR ja conhecida. NUNCA le dado de terceiro. Liga/desliga via
    // CF_FALLBACK_OCORRENCIA (default ligado).
    if (String(process.env.CF_FALLBACK_OCORRENCIA || 'true') !== 'false') {
      try {
        const criadasOcc = await this._processarViaOcorrencias(config);
        if (criadasOcc > 0) totalProcessadas += criadasOcc;
      } catch (e) {
        console.error('[CF Poller] erro no fallback de ocorrencias:', e.message);
      }
    }

    // Captacao por ID-TAILING via /filter/embarque/{idEmbarque} (UNITARIO, que
    // responde 200) — varre os idEmbarque sequenciais a partir de um cursor
    // persistido e capta NOTA NOVA A_EMBARCAR (o que o /ocorrencia nao pega,
    // pois nota nova ainda nao tem ocorrencia). So trata os CNPJs configurados
    // (default: o da Tutts). Liga/desliga via CF_IDTAILING (default ligado).
    if (String(process.env.CF_IDTAILING || 'true') !== 'false') {
      try {
        const criadasTail = await this._processarViaIdTailing(config);
        if (criadasTail > 0) totalProcessadas += criadasTail;
      } catch (e) {
        console.error('[CF Poller] erro no idtailing:', e.message);
      }
    }

    // Fallback/reconciliacao pelo cache: cria corridas para A_EMBARCAR sem
    // vinculo ja conhecidas localmente. Roda sempre — se a busca ao vivo criou
    // os vinculos, este passo nao encontra nada; se o CF falhou, ele despacha.
    try {
      const criadasCache = await this._processarPendentesDoCache(config);
      if (criadasCache > 0) totalProcessadas += criadasCache;
    } catch (e) {
      console.error('[CF Poller] erro no fallback de cache:', e.message);
    }

    // [cf-canc-v1] Poll de canceladas. Roda 1x a cada CF_CANCELADAS_CICLOS
    // ciclos (default 10 = ~10min) porque sao ~45 registros e nao mudam rapido.
    try {
      await this._pollCanceladas(config);
    } catch (e) {
      console.error('[CF Poller] erro no poll de canceladas:', e.message);
    }

    // Atualizar timestamp do último polling
    await this.pool.query(
      'UPDATE confirmafacil_config SET ultimo_polling = $1 WHERE id = $2',
      [agora, config.id]
    );

    if (totalProcessadas > 0) {
      console.log(`✅ [CF Poller] cliente ${config.cliente_id}: ${totalProcessadas} NF(s) processadas`);
    }
    if (this._puladosBackoff > 0) {
      console.log(`⏳ [CF Poller] cliente ${config.cliente_id}: ${this._puladosBackoff} NF(s) em backoff (serao re-tentadas mais tarde)`);
    }
  }

  // ══════════════════════════════════════════════════
  // FALLBACK: PROCESSAR PENDENTES DO CACHE LOCAL
  // ══════════════════════════════════════════════════
  // Cria corridas para NFs A_EMBARCAR sem vinculo que ja estao no cache
  // local (confirmafacil_nfs_cache). Funciona mesmo quando a busca ao vivo
  // no CF falha (ex.: erro Hibernate do GKO), porque a criacao da corrida e
  // na API da Mapp/Tutts (outro servidor). _processarNF re-checa o vinculo,
  // entao nao ha risco de duplicar.
  async _processarPendentesDoCache(config) {
    const { rows } = await this.pool.query(`
      SELECT c.id_embarque, c.numero_nf, c.serie_nf, c.cnpj_embarcador,
             c.nome_embarcador, c.destinatario_nome, c.destinatario_cnpj,
             c.destinatario_cidade, c.destinatario_uf, c.destinatario_end,
             c.status_cf, c.payload_completo
      FROM confirmafacil_nfs_cache c
      LEFT JOIN confirmafacil_vinculos v
        ON v.id_embarque = c.id_embarque AND v.cliente_id = c.cliente_id
      WHERE c.cliente_id = $1
        AND UPPER(c.status_cf) = 'A_EMBARCAR'
        AND v.id_embarque IS NULL
    `, [config.cliente_id]);

    if (rows.length === 0) return 0;
    console.log(`[CF Poller] (cache) ${rows.length} NF(s) A_EMBARCAR sem corrida — criando a partir do cache local`);

    let criadas = 0;
    for (const row of rows) {
      try {
        // Usa o payload completo do CF (salvo no sync) quando disponivel.
        let item = (row.payload_completo && typeof row.payload_completo === 'object')
          ? row.payload_completo
          : null;

        if (!item) {
          // Reconstroi um item minimo a partir das colunas achatadas do cache
          item = {
            idEmbarque:   row.id_embarque,
            numero:       row.numero_nf,
            serie:        row.serie_nf,
            embarcador:   { cnpj: row.cnpj_embarcador || '', nome: row.nome_embarcador || '' },
            destinatario: {
              nome: row.destinatario_nome || '',
              cnpj: row.destinatario_cnpj || '',
              endereco: { cidade: row.destinatario_cidade || '', uf: row.destinatario_uf || '' },
            },
          };
        } else {
          // Garante chaves essenciais mesmo se o payload vier incompleto
          item.idEmbarque = item.idEmbarque || item.id || row.id_embarque;
          item.numero     = item.numero || row.numero_nf;
          item.serie      = item.serie  || row.serie_nf;
        }

        await this._processarNF(item, config);
        criadas++;
      } catch (err) {
        console.error(`⚠️ [CF Poller] (cache) erro NF idEmbarque ${row.id_embarque}: ${err.message}`);
      }
    }
    return criadas;
  }

  // ══════════════════════════════════════════════════
  // PROCESSAR UMA NF
  // ══════════════════════════════════════════════════

  async _processarNF(item, config) {
    // item = objeto de respostas[] do GET /filter/embarque
    const idEmbarque    = item.idEmbarque || item.id;
    const numeroNF      = item.numero     || item.embarque?.numero;
    const serieNF       = item.serie      || item.embarque?.serie || '1';
    const cnpjEmbarcador = item.embarcador?.cnpj || '';

    if (!idEmbarque || !numeroNF) {
      console.warn('[CF Poller] NF sem idEmbarque ou numero — ignorando');
      return;
    }

    // Verificar se já foi processada
    const { rows: jaExiste } = await this.pool.query(
      'SELECT id FROM confirmafacil_vinculos WHERE id_embarque = $1',
      [idEmbarque]
    );
    if (jaExiste.length > 0) return; // já criou corrida pra essa NF

    // Backoff: se esta NF falhou recentemente, nao re-tenta agora — volta no proximo
    // ciclo apos a janela de espera (evita martelar a API Tutts a cada 60s).
    const { rows: _bk } = await this.pool.query(
      'SELECT 1 FROM confirmafacil_poller_retry WHERE config_id = $1 AND id_embarque = $2 AND proximo_retry > NOW()',
      [config.id, idEmbarque]
    );
    if (_bk.length > 0) { this._puladosBackoff = (this._puladosBackoff || 0) + 1; return; }

    // 🕒 2026-06: janela de criacao (SO poller automatico).
    // [cf-corte-diautil-v1] Duas camadas de corte, nesta ordem:
    //   1) DIA UTIL: se a nota esta fora do horario / fim de semana / vespera de
    //      feriado, o proximo dia util as 08:00 (via dataPrevisao do CF) esta no
    //      futuro -> adia pra la. Cobre "sexta a noite -> segunda" e feriados.
    //   2) HORARIO puro (fallback): se nao houver dataPrevisao utilizavel, cai no
    //      corte antigo por _minutosAteJanela (proximo 07:30, sem pular fim de semana).
    if (CF_JANELA_CRIACAO_ATIVA) {
      let _minAdiar = 0;
      let _motivo   = '';

      if (CF_CORTE_USA_PREVISAO) {
        const _minPrev = _minutosAtePrevisaoCF(item.dataPrevisao);
        if (_minPrev > 0) {
          _minAdiar = _minPrev;
          _motivo   = `dia util (previsao CF ${item.dataPrevisao})`;
        }
      }
      // Fallback / reforco: mesmo com previsao no passado, respeita o horario do dia.
      const _minHorario = _minutosAteJanela();
      if (_minHorario > _minAdiar) {
        _minAdiar = _minHorario;
        _motivo   = 'fora do horario (07:30-18:20)';
      }

      if (_minAdiar > 0) {
        const _horas = (_minAdiar / 60).toFixed(1);
        console.log(`🕒 [CF Poller] adiando NF ${numeroNF} (idEmbarque ${idEmbarque}) por ~${_horas}h — ${_motivo}`);
        await this._agendarParaJanela(config.id, idEmbarque, _minAdiar, _motivo);
        return;
      }
    }

    // Buscar endereço de coleta pelo cnpj do embarcador
    const coleta = await this._buscarColeta(config.id, cnpjEmbarcador);
    if (!coleta) {
      console.warn(`⚠️ [CF Poller] embarcador ${cnpjEmbarcador} sem endereço de coleta configurado — ignorando NF ${numeroNF}`);
      await this._logarErro(config.cliente_id, idEmbarque, numeroNF, serieNF, cnpjEmbarcador,
        `Embarcador ${cnpjEmbarcador} sem endereço de coleta`);
      return;
    }

    // Montar destinatário a partir do objeto retornado pelo CF
    const dest     = item.destinatario || {};
    const endDest  = item.trecho?.[0]?.enderecoDestino || dest.endereco || item.endereco || {};

    // Montar pontos: ponto 1 = coleta, ponto 2 = entrega destinatário
    const pontos = [
      // Ponto 1: coleta
      {
        rua:           coleta.coleta_rua || '',
        numero:        coleta.coleta_numero || '',
        bairro:        coleta.coleta_bairro || '',
        cidade:        coleta.coleta_cidade,
        uf:            coleta.coleta_uf,
        cep:           coleta.coleta_cep || '',
        la:            coleta.coleta_lat ? String(coleta.coleta_lat) : undefined,
        lo:            coleta.coleta_lng ? String(coleta.coleta_lng) : undefined,
        obs:           `COLETA: ${coleta.coleta_nome_fantasia || coleta.nome_embarcador || 'Embarcador'}`,
      },
      // Ponto 2: entrega
      {
        rua:           endDest.logradouro || '',
        numero:        endDest.numero || '',
        bairro:        '',
        cidade:        endDest.cidade || '',
        uf:            endDest.uf || '',
        cep:           endDest.cep || '',
        la:            endDest.latitude  ? String(endDest.latitude)  : undefined,
        lo:            endDest.longitude ? String(endDest.longitude) : undefined,
        numeroNota:    String(numeroNF),
        obs:           [
          `NOME FANTASIA: ${dest.nome || ''}`,
          `NF: ${numeroNF}`,
          dest.celular ? `TEL: ${dest.celular}` : null,
        ].filter(Boolean).join(', '),
      },
    ];

    // Limpar undefined dos pontos
    const pontosLimpos = pontos.map(p => {
      const obj = {};
      for (const [k, v] of Object.entries(p)) {
        if (v !== undefined && v !== null && v !== '') obj[k] = v;
      }
      return obj;
    });

    const payloadTutts = {
      token:          config.tutts_token_api,
      codCliente:     config.tutts_codigo_cliente,
      Usuario:        'ConfirmaFácil Auto',
      centroCusto:    coleta.centro_custo_mapp || config.centro_custo_padrao || config.cliente_nome || 'Central',
      pontos:         pontosLimpos,
      retorno:        'N',
      formaPagamento: config.forma_pagamento_padrao || 'F',
      UrlRetorno:     TUTTS_WEBHOOK,
      numeroPedido:   String(numeroNF),
    };

    // Modalidade de frete (categoria) configurada na filial — se houver
    if (coleta.categoria_mapp && String(coleta.categoria_mapp).trim()) {
      payloadTutts.categoria = String(coleta.categoria_mapp).trim().toUpperCase();
    }

    console.log(`📤 [CF Poller] criando corrida para NF ${numeroNF} (idEmbarque ${idEmbarque}) categoria=${payloadTutts.categoria || '(nenhuma)'}`);

    // Chamar API Tutts
    const respTutts = await httpRequest(TUTTS_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payloadTutts),
    });

    const resultado = respTutts.json();

    if (resultado.Erro) {
      console.error(`❌ [CF Poller] API Tutts recusou NF ${numeroNF}: ${resultado.Erro}`);
      await this._logarErro(config.cliente_id, idEmbarque, numeroNF, serieNF, cnpjEmbarcador, resultado.Erro);
      await this._registrarFalhaRetry(config.id, idEmbarque, resultado.Erro);
      return;
    }

    const osNumero = resultado.Sucesso;
    console.log(`✅ [CF Poller] OS criada: ${osNumero} | NF ${numeroNF}`);
    await this._removerRetry(config.id, idEmbarque); // sucesso — limpa qualquer backoff

    // Salvar solicitacao_corrida
    const { rows: [solic] } = await this.pool.query(`
      INSERT INTO solicitacoes_corrida (
        cliente_id, numero_pedido, centro_custo, usuario_solicitante,
        forma_pagamento, retorno, tutts_os_numero, tutts_distancia,
        tutts_duracao, tutts_valor, tutts_url_rastreamento,
        status, provider_usado, categoria_usada
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id
    `, [
      config.cliente_id,
      String(numeroNF),
      coleta.centro_custo_mapp || config.centro_custo_padrao || config.cliente_nome || 'Central',
      'ConfirmaFácil Auto',
      config.forma_pagamento_padrao || 'F',
      false,
      osNumero,
      resultado.detalhes?.distancia || null,
      resultado.detalhes?.duracao   || null,
      resultado.detalhes?.valor ? parseFloat(resultado.detalhes.valor) : null,
      resultado.detalhes?.urlRastreamento || null,
      'enviado',
      'tutts',
      (coleta.categoria_mapp && String(coleta.categoria_mapp).trim()) ? String(coleta.categoria_mapp).trim().toUpperCase() : null,
    ]);

    const solicitacaoId = solic.id;

    // Salvar pontos
    const pontosParaSalvar = [
      // Ponto 1: coleta
      {
        ordem: 1, rua: coleta.coleta_rua, numero: coleta.coleta_numero,
        bairro: coleta.coleta_bairro, cidade: coleta.coleta_cidade,
        uf: coleta.coleta_uf, cep: coleta.coleta_cep,
        lat: coleta.coleta_lat, lng: coleta.coleta_lng,
        nome_fantasia: coleta.coleta_nome_fantasia || coleta.nome_embarcador,
        numero_nota: null,
      },
      // Ponto 2: entrega
      {
        ordem: 2, rua: endDest.logradouro, numero: endDest.numero,
        bairro: '', cidade: endDest.cidade, uf: endDest.uf, cep: endDest.cep,
        lat: endDest.latitude, lng: endDest.longitude,
        nome_fantasia: dest.nome, numero_nota: numeroNF,
        telefone: dest.celular,
      },
    ];

    for (const p of pontosParaSalvar) {
      const endCompleto = [p.rua, p.numero, p.bairro, p.cidade, p.uf].filter(Boolean).join(', ');
      await this.pool.query(`
        INSERT INTO solicitacoes_pontos (
          solicitacao_id, ordem, rua, numero, bairro, cidade, uf, cep,
          latitude, longitude, telefone, numero_nota, nome_fantasia,
          status, endereco_completo
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pendente',$14)
      `, [
        solicitacaoId, p.ordem, p.rua, p.numero, p.bairro, p.cidade, p.uf, p.cep,
        p.lat || null, p.lng || null, p.telefone || null, p.numero_nota || null,
        p.nome_fantasia || null, endCompleto,
      ]);
    }

    // Salvar vínculo
    await this.pool.query(`
      INSERT INTO confirmafacil_vinculos
        (id_embarque, solicitacao_id, cliente_id, numero_nf, serie_nf, cnpj_embarcador)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id_embarque) DO NOTHING
    `, [idEmbarque, solicitacaoId, config.cliente_id, numeroNF, serieNF, cnpjEmbarcador]);
  }

  // ══════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════

  // ══════════════════════════════════════════════════
  // [cf-canc-v1] NOTAS CANCELADAS (stage=CANCELADAS -> statusEmbarque ARQUIVADO)
  // ══════════════════════════════════════════════════

  async _pollCanceladas(config) {
    if (!CF_POLL_CANCELADAS) return 0;

    // throttle por ciclo
    this._cicloCanc = (this._cicloCanc || 0) + 1;
    if (this._cicloCanc % CF_CANCELADAS_CICLOS !== 1 && CF_CANCELADAS_CICLOS > 1) return 0;

    let marcadas = 0, canceladas = 0, alocadas = 0, page = 0;
    const MAX_PAGES = 5;

    while (page < MAX_PAGES) {
      // stage vai como query param via _buscarEmbarques (o filtroDTO e ignorado).
      const resp = await this._buscarEmbarques({ stage: 'CANCELADAS' }, page, config);
      if (!resp) break;

      const lista = resp.respostas || resp.content || [];
      if (!Array.isArray(lista) || lista.length === 0) break;
      if (page === 0) {
        console.log(`🗄️ [CF Canceladas] cliente ${config.cliente_id}: totalCount=${resp.totalCount}`);
      }

      for (const emb of lista) {
        try {
          const r = await this._tratarCancelada(emb, config);
          if (r.marcou)   marcadas++;
          if (r.cancelou) canceladas++;
          if (r.alocado)  alocadas++;
        } catch (err) {
          console.error(`⚠️ [CF Canceladas] erro NF ${emb && emb.numero}:`, err.message);
        }
      }

      if (lista.length < PAGE_SIZE) break;
      page++;
    }

    if (marcadas > 0 || canceladas > 0 || alocadas > 0) {
      console.log(`🗄️ [CF Canceladas] cliente ${config.cliente_id}: ${marcadas} marcada(s), ${canceladas} OS cancelada(s), ${alocadas} alocada(s) (nao cancelada)`);
    }
    return canceladas;
  }

  async _tratarCancelada(emb, config) {
    const out = { marcou: false, cancelou: false, alocado: false };
    const idEmb = emb.idEmbarque || emb.id;
    if (!idEmb) return out;

    // Guard: so mexe em nota da NOSSA transportadora.
    const cnpjTransp = String((emb.transportadora && emb.transportadora.cnpj) || '').replace(/\D/g, '');
    const cnpjNosso  = String(config.cnpj_transportadora || '').replace(/\D/g, '');
    if (cnpjNosso && cnpjTransp && cnpjTransp !== cnpjNosso) return out;

    // ─────────────────────────────────────────────────────────────────
    // ORDEM OBRIGATORIA: marca o cache como ARQUIVADO **ANTES** de cancelar.
    //
    // Se cancelar primeiro, a limpeza de vinculos orfaos (no topo do _ciclo)
    // apaga o vinculo assim que ve `status LIKE '%cancel%'`, a NF volta a ser
    // elegivel, e o _processarPendentesDoCache RECRIA a corrida (ele so olha
    // status_cf = 'A_EMBARCAR'). Com o cache ja em ARQUIVADO, nao recria.
    // NAO INVERTA ESTA ORDEM.
    // ─────────────────────────────────────────────────────────────────
    await this._salvarCache(emb, config.cliente_id);
    out.marcou = true;

    if (!CF_CANCELADAS_CANCELA_OS) return out;

    // ARQUIVADO e AMBIGUO: pode ser "entregue e arquivada por rotina".
    // O discriminador e o statusNota (campo REAL da API — o Swagger documenta
    // como notaStatus, mas a resposta traz statusNota. Confirmado: 45/45).
    const statusNota = String(emb.statusNota || '').toUpperCase();
    if (CF_STATUSNOTA_ENTREGUE.includes(statusNota)) return out; // rotina, nao cancelamento

    // Tem corrida viva nossa?
    const { rows: [alvo] } = await this.pool.query(`
      SELECT sc.id, sc.tutts_os_numero, sc.status
        FROM confirmafacil_vinculos v
        JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
       WHERE v.id_embarque = $1
    `, [idEmb]);

    if (!alvo || !alvo.tutts_os_numero) {
      await this._registrarCancelamento(emb, config, alvo, 'nada', null);
      return out;
    }
    const st = String(alvo.status || '').toLowerCase();
    if (st === 'finalizado' || st.includes('cancel')) {
      // ja finalizada/cancelada: registra como 'nada' (nao ha o que cancelar)
      await this._registrarCancelamento(emb, config, alvo, 'nada', null);
      return out;
    }

    const res = await this._cancelarOsTutts(config, alvo.tutts_os_numero);

    if (res.ok) {
      // [cf-fix-cancelado-em-v1] So colunas garantidas. cancelado_em vem do
      // ALTER na migration; se por algum motivo faltar, o COALESCE de colunas
      // opcionais nao existe em SQL, entao mantemos o UPDATE minimo e resiliente.
      await this.pool.query(`
        UPDATE solicitacoes_corrida
           SET status = 'cancelado', atualizado_em = NOW()
         WHERE id = $1
      `, [alvo.id]).catch((e) => console.warn('[CF Canceladas] update status:', e.message));
      // best-effort: carimba cancelado_em se a coluna existir (nao quebra se nao)
      await this.pool.query(
        `UPDATE solicitacoes_corrida SET cancelado_em = NOW() WHERE id = $1`, [alvo.id]
      ).catch(() => {});

      console.log(`❌ [CF Canceladas] OS ${alvo.tutts_os_numero} cancelada — NF ${emb.numero} arquivada no CF (statusNota=${statusNota || 'n/a'})`);
      await this._registrarCancelamento(emb, config, alvo, 'cancelada', null);
      out.cancelou = true;
      return out;
    }

    if (res.alocado) {
      // Motoboy ja alocado: a Tutts recusa o cancelamento. NAO forcamos —
      // cancelar aqui deixaria a mercadoria orfa com o profissional.
      out.alocado = true;
      await this._registrarCancelamento(emb, config, alvo, 'alocado', 'Tutts: Alocado (motoboy em execucao)');
      const msg = `🗄️ *CF: nota cancelada com motoboy alocado*\n\nNF ${emb.numero}/${emb.serie} — ${(emb.embarcador && emb.embarcador.nome) || ''}\nOS ${alvo.tutts_os_numero} (status: ${alvo.status})\n\nA nota foi ARQUIVADA no ConfirmaFacil mas ja tem profissional na corrida. A Tutts recusou o cancelamento (Alocado). Avaliar manualmente.`;
      console.warn(`⚠️ [CF Canceladas] OS ${alvo.tutts_os_numero} ALOCADA — NF ${emb.numero} cancelada no CF mas nao da pra cancelar a OS`);
      await this._alertarWhats(msg);
      return out;
    }

    console.warn(`⚠️ [CF Canceladas] falha ao cancelar OS ${alvo.tutts_os_numero}: ${res.erro}`);
    await this._registrarCancelamento(emb, config, alvo, 'falhou', res.erro);
    return out;
  }

  // [cf-badge-canceladas-v1] Persiste o resultado do cancelamento pro badge.
  // Idempotente por id_embarque. tentativas so incrementa em 'falhou'.
  async _registrarCancelamento(emb, config, alvo, resultado, erroMsg) {
    const idEmb = emb.idEmbarque || emb.id;
    if (!idEmb) return;
    try {
      await this.pool.query(`
        INSERT INTO confirmafacil_cancelamentos
          (id_embarque, cliente_id, numero_nf, serie_nf, nome_embarcador,
           solicitacao_id, os_numero, status_corrida, status_nota,
           resultado, erro_msg, tentativas, detectado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW())
        ON CONFLICT (id_embarque) DO UPDATE SET
          resultado      = EXCLUDED.resultado,
          erro_msg       = EXCLUDED.erro_msg,
          status_corrida = EXCLUDED.status_corrida,
          tentativas     = confirmafacil_cancelamentos.tentativas
                           + (CASE WHEN EXCLUDED.resultado = 'falhou' THEN 1 ELSE 0 END),
          atualizado_em  = NOW()
      `, [
        idEmb, config.cliente_id, emb.numero, emb.serie || null,
        (emb.embarcador && emb.embarcador.nome) || null,
        alvo ? alvo.id : null,
        alvo ? alvo.tutts_os_numero : null,
        alvo ? alvo.status : null,
        String(emb.statusNota || '').toUpperCase() || null,
        resultado, erroMsg || null,
        resultado === 'falhou' ? 1 : 0,
      ]);
    } catch (e) {
      console.warn('[CF Canceladas] _registrarCancelamento:', e.message);
    }
  }

  // Cancelamento na Tutts. Mesma mecanica de solicitacao/routes/cliente.routes.js
  // (PATCH /solicitacao/corrida/:id/cancelar): o token de cancelamento e o de
  // gravacao com sufixo '-cancelar' no lugar de '-gravar'.
  async _cancelarOsTutts(config, osNumero) {
    let token = String(config.tutts_token_api || '');
    if (token.includes('-gravar')) token = token.replace('-gravar', '-cancelar');
    else if (!token.includes('-cancelar')) token = token + '-cancelar';

    if (!token || !config.tutts_codigo_cliente) {
      return { ok: false, erro: 'sem token/codCliente', alocado: false };
    }

    try {
      const resp = await httpRequest(TUTTS_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          token,
          codCliente: config.tutts_codigo_cliente,
          OS:         String(osNumero),
        }),
      });
      const data = resp.json();
      if (data && (data.Sucesso || data.sucesso)) return { ok: true, erro: null, alocado: false };

      const erro = String((data && (data.Erro || data.erro)) || 'resposta inesperada');
      // 'Alocado' = servico em execucao. E a trava de seguranca da propria Tutts.
      return { ok: false, erro, alocado: erro.toLowerCase() === 'alocado' };
    } catch (err) {
      return { ok: false, erro: err.message, alocado: false };
    }
  }

  // Alerta opcional. Default OFF — a reconciliacao ja teve o alerta de WhatsApp
  // desativado a pedido; nao reintroduzimos barulho sem opt-in explicito.
  async _alertarWhats(texto) {
    if (!CF_CANCELADAS_ALERTA_WHATS) return;
    const baseUrl   = String(process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    const apiKey    = process.env.EVOLUTION_API_KEY;
    const instancia = process.env.EVOLUTION_INSTANCE;
    const grupoId   = String(process.env.EVOLUTION_GROUP_ID_DISP || '').trim();
    if (!baseUrl || !apiKey || !instancia || !grupoId) return;
    try {
      await fetch(`${baseUrl}/message/sendText/${instancia}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', apikey: apiKey },
        body:    JSON.stringify({ number: grupoId, text: texto }),
      });
    } catch (e) {
      console.warn('[CF Canceladas] alerta whats falhou:', e.message);
    }
  }

  async _salvarCache(nf, clienteId) {
    try {
      const end = nf.destinatario?.endereco || nf.endereco || {};
      await this.pool.query(`
        INSERT INTO confirmafacil_nfs_cache (
          cliente_id, id_embarque, numero_nf, serie_nf, chave_nfe,
          cnpj_embarcador, nome_embarcador,
          destinatario_nome, destinatario_cnpj,
          destinatario_cidade, destinatario_uf, destinatario_end,
          status_cf, status_nota, dias_atraso,
          data_previsao, data_emissao, valor,
          tipo_envio, tipo_frete, link_rastreamento,
          payload_completo, sincronizado_em
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
        ON CONFLICT (cliente_id, id_embarque) DO UPDATE SET
          status_cf           = EXCLUDED.status_cf,
          status_nota         = EXCLUDED.status_nota,
          dias_atraso         = EXCLUDED.dias_atraso,
          data_previsao       = EXCLUDED.data_previsao,
          destinatario_nome   = EXCLUDED.destinatario_nome,
          destinatario_cidade = EXCLUDED.destinatario_cidade,
          destinatario_uf     = EXCLUDED.destinatario_uf,
          link_rastreamento   = EXCLUDED.link_rastreamento,
          payload_completo    = EXCLUDED.payload_completo,
          sincronizado_em     = NOW()
      `, [
        clienteId,
        nf.idEmbarque || nf.id,
        nf.numero, nf.serie, nf.chave || null,
        nf.embarcador?.cnpj || '',
        nf.embarcador?.nome || '',
        nf.destinatario?.nome || '',
        nf.destinatario?.cnpj || '',
        end.cidade || '', end.uf || '',
        [end.logradouro, end.numero, end.cidade, end.uf].filter(Boolean).join(', '),
        nf.statusEmbarque?.nome || 'DESCONHECIDO',
        nf.statusNota || '',
        nf.diasAtraso || 0,
        nf.dataPrevisao ? new Date(nf.dataPrevisao) : null,
        nf.dataEmissao  ? new Date(nf.dataEmissao)  : null,
        nf.valor || null,
        nf.tipoEnvio || null,
        nf.tipoDeFrete || null,
        nf.linkExterno || null,
        nf,
      ]);
    } catch (err) {
      console.warn('[CF Poller] erro ao salvar cache NF:', err.message);
    }
  }

  async _buscarEmbarques(filtro, page, config) {
    // O CF as vezes devolve 400 (Hibernate) ou 401 (token invalidado antes do
    // fim do dia, ex.: restart do servidor deles). Tentamos a mesma pagina ate
    // 3x; em 401 forcamos um novo login antes de re-tentar.
    //
    // page e size vao como query params SEPARADOS (?filtroDTO=...&page=N&size=M).
    // O CF ignora esses campos quando enviados dentro do filtroDTO.
    const params = new URLSearchParams({
      filtroDTO: JSON.stringify(filtro),
      page:      String(page),
      size:      String(PAGE_SIZE),
    });

    // [cf-stage-v1] Promove os filtros a query param — dentro do filtroDTO o CF
    // ignora tudo (ver bloco de comentario no topo do arquivo). O filtroDTO
    // continua sendo enviado porque o Swagger o declara required:true.
    // Nomes na wire: stage, De, Ate (Spring binda case-insensitive).
    // TipoDta NAO e enviado: testado, o CF aceita e ignora (EMISSAO e
    // DATA_ATUALIZACAO devolvem resultado identico) — mandar so daria a falsa
    // impressao de que o eixo de data e configuravel.
    if (CF_USE_STAGE_PARAM) {
      if (filtro && filtro.stage) params.set('stage', String(filtro.stage));
      if (filtro && filtro.de)    params.set('De',    String(filtro.de));
      if (filtro && filtro.ate)   params.set('Ate',   String(filtro.ate));
    }

    const url    = `${CF_FILTER_URL}?${params}`;
    const MAX_TENTATIVAS = 5;

    let token = await this.auth.obterToken(config.cliente_id, config);

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      try {
        const resp = await httpRequest(url, {
          method:  'GET',
          headers: { Authorization: token, accept: 'application/json' },
        });
        const data = resp.json();

        if (resp.ok && !(data && data.error)) return data; // sucesso

        const corpo = (typeof resp.text === 'function' ? resp.text() : '') || JSON.stringify(data);
        console.error(`❌ [CF Poller] CF /filter/embarque status=${resp.status} (tentativa ${tentativa}/${MAX_TENTATIVAS}) — corpo(300): ${String(corpo).slice(0, 300)}`);

        // 401 = token morto no CF. Forca novo login para a proxima tentativa.
        if (resp.status === 401) {
          console.warn('🔑 [CF Poller] token rejeitado (401) — refazendo login no CF');
          token = await this.auth.obterToken(config.cliente_id, config, true);
        }
      } catch (err) {
        console.error(`❌ [CF Poller] erro de rede ao buscar (tentativa ${tentativa}/${MAX_TENTATIVAS}): ${err.message}`);
      }

      // backoff progressivo: 3s, 6s, 9s, 12s (teto 12s) — da tempo do
      // Hibernate do CF (GKO) reabrir a conexao antes da proxima tentativa.
      if (tentativa < MAX_TENTATIVAS) {
        await new Promise((r) => setTimeout(r, Math.min(tentativa * 3000, 12000)));
      }
    }

    console.error('❌ [CF Poller] CF falhou apos todas as tentativas — provavel instabilidade no ConfirmaFacil (GKO). Tentaremos no proximo ciclo.');
    return null;
  }

  // ══════════════════════════════════════════════════
  // FALLBACK VIA /filter/ocorrencia (SCOPED A TUTTS)
  // ══════════════════════════════════════════════════
  // O /filter/embarque (lista) entra em erro Hibernate ("is closed") no GKO.
  // Os endpoints irmaos /filter/ocorrencia e /filter/pedido seguem 200. O
  // /ocorrencia retorna SOMENTE ocorrencias do usuario autenticado (Tutts) e
  // traz, aninhado em cada ocorrencia, o objeto "embarque" COMPLETO — mesma
  // forma que o /filter/embarque devolvia. Com isso:
  //   1) reconciliamos o status real das NOSSAS notas no cache local;
  //   2) despachamos qualquer A_EMBARCAR ja conhecida que ainda nao virou corrida.
  // NAO captura nota 100% nova (sem nenhuma ocorrencia ainda) — para isso
  // depende-se do /embarque (lista) voltar ou de captacao manual pela Comolatti.
  async _processarViaOcorrencias(config) {
    const MAX_PAGES = parseInt(process.env.CF_OCORRENCIA_MAX_PAGES, 10) > 0
      ? parseInt(process.env.CF_OCORRENCIA_MAX_PAGES, 10)
      : 5;

    const vistos = new Set();   // dedup por idEmbarque dentro do ciclo
    let criadas  = 0;
    let page     = 0;

    while (page < MAX_PAGES) {
      const resp = await this._buscarOcorrencias(page, config);
      if (!resp) break; // falha apos retries — tenta no proximo ciclo

      const lista = resp.respostas || resp.content || [];
      if (!Array.isArray(lista) || lista.length === 0) break;

      for (const occ of lista) {
        const emb = occ && occ.embarque;
        if (!emb || typeof emb !== 'object') continue;

        const idEmb = emb.idEmbarque || emb.id;
        if (!idEmb || vistos.has(idEmb)) continue;
        vistos.add(idEmb);

        // Guard de seguranca: /ocorrencia ja e scoped, mas confirmamos que a
        // transportadora da nota e a NOSSA antes de tocar em qualquer coisa.
        const cnpjTransp = String(emb.transportadora && emb.transportadora.cnpj || '').replace(/\D/g, '');
        const cnpjNosso  = String(config.cnpj_transportadora || '').replace(/\D/g, '');
        if (cnpjNosso && cnpjTransp && cnpjTransp !== cnpjNosso) continue;

        try {
          await this._salvarCache(emb, config.cliente_id); // reconcilia status
          const statusNF = String(emb.statusEmbarque && emb.statusEmbarque.nome || '').toUpperCase();
          if (statusNF === 'A_EMBARCAR') {
            const antes = await this.pool.query(
              'SELECT id FROM confirmafacil_vinculos WHERE id_embarque = $1', [idEmb]
            );
            if (antes.rows.length === 0) {
              await this._processarNF(emb, config);
              criadas++;
            }
          }
        } catch (err) {
          console.error(`⚠️ [CF Poller] (ocorrencia) erro NF idEmbarque ${idEmb}:`, err.message);
        }
      }

      // /ocorrencia vem ordenado por mais recente primeiro; pagina menor que o
      // tamanho => fim dos registros.
      if (lista.length < PAGE_SIZE) break;
      page++;
    }

    if (criadas > 0) {
      console.log(`✅ [CF Poller] (fallback ocorrencia) cliente ${config.cliente_id}: ${criadas} NF(s) despachada(s)`);
    }
    return criadas;
  }

  async _buscarOcorrencias(page, config) {
    // Mesma resiliencia do _buscarEmbarques: ate 3 tentativas, re-login em 401.
    // page/size como query params separados. Token RAW (sem Bearer).
    const params = new URLSearchParams({
      page: String(page),
      size: String(PAGE_SIZE),
    });
    const url = `${CF_OCORRENCIA_URL}?${params}`;
    const MAX_TENTATIVAS = 3;

    let token = await this.auth.obterToken(config.cliente_id, config);

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      try {
        const resp = await httpRequest(url, {
          method:  'GET',
          headers: { Authorization: token, accept: 'application/json' },
        });
        const data = resp.json();
        if (resp.ok && !(data && data.error)) return data;

        const corpo = (typeof resp.text === 'function' ? resp.text() : '') || JSON.stringify(data);
        console.error(`❌ [CF Poller] CF /filter/ocorrencia status=${resp.status} (tentativa ${tentativa}/${MAX_TENTATIVAS}) — corpo(200): ${String(corpo).slice(0, 200)}`);

        if (resp.status === 401) {
          console.warn('🔑 [CF Poller] token rejeitado (401) em /ocorrencia — refazendo login');
          token = await this.auth.obterToken(config.cliente_id, config, true);
        }
      } catch (err) {
        console.error(`❌ [CF Poller] erro de rede em /ocorrencia (tentativa ${tentativa}/${MAX_TENTATIVAS}): ${err.message}`);
      }
      if (tentativa < MAX_TENTATIVAS) {
        await new Promise((r) => setTimeout(r, tentativa * 2000));
      }
    }
    console.error('❌ [CF Poller] /filter/ocorrencia falhou apos todas as tentativas. Tentaremos no proximo ciclo.');
    return null;
  }

  // ══════════════════════════════════════════════════
  // CAPTACAO POR ID-TAILING (/filter/embarque/{idEmbarque})
  // ══════════════════════════════════════════════════
  // O /filter/embarque (LISTA) esta quebrado no GKO ("is closed"), mas o
  // /filter/embarque/{idEmbarque} (UNITARIO) responde 200. Os idEmbarque sao
  // sequenciais. Mantemos um cursor persistido (confirmafacil_config.
  // idtailing_cursor) e, a cada ciclo, varremos cursor+1, cursor+2, ... ate
  // bater a fronteira (IDs inexistentes) ou um teto por ciclo. Captura NOTA
  // NOVA A_EMBARCAR (que o /ocorrencia nao ve). So trata os CNPJs configurados.
  async _processarViaIdTailing(config) {
    const cnpjsEnv = String(process.env.CF_IDTAILING_CNPJS || '')
      .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
    const tratados = new Set(cnpjsEnv.length
      ? cnpjsEnv
      : [String(config.cnpj_transportadora || '').replace(/\D/g, '')].filter(Boolean));
    if (tratados.size === 0) {
      console.warn('[CF Poller] idtailing: nenhum CNPJ para tratar — pulando');
      return 0;
    }

    let cursor = await this._getCursor(config);
    if (cursor == null) {
      const start = parseInt(process.env.CF_IDTAILING_START, 10);
      if (start > 0) {
        cursor = start;
      } else {
        const backfill = parseInt(process.env.CF_IDTAILING_BACKFILL, 10) > 0
          ? parseInt(process.env.CF_IDTAILING_BACKFILL, 10) : 200;
        let base = await this._maxIdConhecido(config);
        if (!base) base = await this._maxIdViaOcorrencia(config);
        if (!base) {
          console.warn('[CF Poller] idtailing: sem base para semear cursor — pulando este ciclo');
          return 0;
        }
        cursor = Math.max(0, base - backfill);
      }
      await this._setCursor(config, cursor);
      console.log(`[CF Poller] idtailing: cursor semeado em ${cursor}`);
    }

    const GAP  = parseInt(process.env.CF_IDTAILING_GAP, 10) > 0
      ? parseInt(process.env.CF_IDTAILING_GAP, 10) : 20;
    const MAXP = parseInt(process.env.CF_IDTAILING_MAX_PER_CYCLE, 10) > 0
      ? parseInt(process.env.CF_IDTAILING_MAX_PER_CYCLE, 10) : 150;

    let id = cursor, miss = 0, probes = 0, lastGood = cursor, criadas = 0, existentes = 0;

    while (probes < MAXP && miss < GAP) {
      id++; probes++;
      const r = await this._buscarEmbarqueUnitario(id, config);

      if (r.error) {
        // Erro transitorio (is closed / 5xx / 401 / rede). NAO trata como
        // fronteira: para o scan agora e retoma do mesmo ponto no proximo ciclo.
        console.warn(`[CF Poller] idtailing: erro transitorio no id ${id} — pausando scan ate o proximo ciclo`);
        break;
      }
      if (!r.exists) { miss++; continue; }

      miss = 0; lastGood = id; existentes++;
      const emb  = r.data;
      const cnpj = String(emb.transportadora && emb.transportadora.cnpj || '').replace(/\D/g, '');
      if (!tratados.has(cnpj)) continue; // do hub, mas nao e CNPJ tratado

      try {
        await this._salvarCache(emb, config.cliente_id);
        const st = String(emb.statusEmbarque && emb.statusEmbarque.nome || '').toUpperCase();
        if (st === 'A_EMBARCAR') {
          const { rows } = await this.pool.query(
            'SELECT id FROM confirmafacil_vinculos WHERE id_embarque = $1', [id]
          );
          if (rows.length === 0) {
            await this._processarNF(emb, config);
            criadas++;
          }
        }
      } catch (err) {
        console.error(`⚠️ [CF Poller] idtailing erro NF id ${id}:`, err.message);
      }
    }

    if (lastGood > cursor) await this._setCursor(config, lastGood);

    if (existentes > 0 || criadas > 0) {
      console.log(`[CF Poller] idtailing cliente ${config.cliente_id}: cursor ${cursor}->${lastGood} | ${probes} probes, ${existentes} existentes, ${criadas} despachada(s)`);
    }
    return criadas;
  }

  // Busca UNITARIA de uma NF pelo idEmbarque. Classifica o retorno em
  // {exists:true,data} | {exists:false} | {error:true}. Erros transitorios
  // (is closed/Deadlock/5xx/401/rede) viram {error:true} apos pequenas
  // re-tentativas, para nunca confundir instabilidade com "nota inexistente".
  async _buscarEmbarqueUnitario(id, config) {
    const url = `${CF_FILTER_URL}/${id}`;
    const MAX = 2;
    let token = await this.auth.obterToken(config.cliente_id, config);

    for (let t = 1; t <= MAX; t++) {
      try {
        const resp = await httpRequest(url, {
          method:  'GET',
          headers: { Authorization: token, accept: 'application/json' },
        });
        let data = null;
        try { data = resp.json(); } catch (_) { data = null; }

        if (resp.ok && data && (data.idEmbarque || data.id)) return { exists: true, data };
        if (resp.ok) return { exists: false }; // 200 sem corpo valido => nao existe

        const corpo = (typeof resp.text === 'function' ? resp.text() : '') || JSON.stringify(data || '');
        const txt = String(corpo);
        const transitorio = resp.status >= 500 || resp.status === 401
          || /is closed|closed|Deadlock|LockAcquisition/i.test(txt);

        if (resp.status === 404) return { exists: false };
        if (resp.status === 401) {
          token = await this.auth.obterToken(config.cliente_id, config, true);
        }
        if (!transitorio && resp.status === 400) return { exists: false }; // id invalido => nao existe
        // transitorio => cai no retry
      } catch (err) {
        // erro de rede => retry
      }
      if (t < MAX) await new Promise((r) => setTimeout(r, 800));
    }
    return { error: true };
  }

  // MAX(id_embarque) ja conhecido localmente (cache + vinculos) — usado para
  // semear o cursor sem varrer o historico inteiro.
  async _maxIdConhecido(config) {
    try {
      const { rows } = await this.pool.query(`
        SELECT GREATEST(
          COALESCE((SELECT MAX(id_embarque) FROM confirmafacil_nfs_cache WHERE cliente_id = $1), 0),
          COALESCE((SELECT MAX(id_embarque) FROM confirmafacil_vinculos), 0)
        ) AS m
      `, [config.cliente_id]);
      return Number(rows[0] && rows[0].m) || 0;
    } catch (e) {
      console.warn('[CF Poller] _maxIdConhecido:', e.message);
      return 0;
    }
  }

  // MAX(idEmbarque) a partir da 1a pagina do /ocorrencia (fallback de seed).
  async _maxIdViaOcorrencia(config) {
    try {
      const resp = await this._buscarOcorrencias(0, config);
      const lista = (resp && (resp.respostas || resp.content)) || [];
      let m = 0;
      for (const o of lista) {
        const id = o && o.embarque && o.embarque.idEmbarque;
        if (id && id > m) m = id;
      }
      return m;
    } catch (e) {
      console.warn('[CF Poller] _maxIdViaOcorrencia:', e.message);
      return 0;
    }
  }

  async _ensureIdtailingColumn() {
    if (this._idtailingColReady) return;
    await this.pool.query(
      'ALTER TABLE confirmafacil_config ADD COLUMN IF NOT EXISTS idtailing_cursor BIGINT'
    ).catch((e) => console.warn('[CF Poller] _ensureIdtailingColumn:', e.message));
    this._idtailingColReady = true;
  }

  async _getCursor(config) {
    await this._ensureIdtailingColumn();
    const { rows } = await this.pool.query(
      'SELECT idtailing_cursor FROM confirmafacil_config WHERE id = $1', [config.id]
    );
    const v = rows[0] && rows[0].idtailing_cursor;
    return (v == null) ? null : Number(v);
  }

  async _setCursor(config, id) {
    await this.pool.query(
      'UPDATE confirmafacil_config SET idtailing_cursor = $1 WHERE id = $2', [id, config.id]
    );
  }

  async _buscarColeta(configId, cnpjEmbarcador) {
    const { rows } = await this.pool.query(`
      SELECT * FROM confirmafacil_embarcadores
      WHERE config_id = $1
        AND REGEXP_REPLACE(cnpj_embarcador, '[^0-9]', '', 'g') =
            REGEXP_REPLACE($2::text, '[^0-9]', '', 'g')
        AND ativo = TRUE
      LIMIT 1
    `, [configId, cnpjEmbarcador]);

    // fallback: busca sem filtrar CNPJ (embarcador padrão)
    if (rows.length === 0) {
      const { rows: fallback } = await this.pool.query(`
        SELECT * FROM confirmafacil_embarcadores
        WHERE config_id = $1 AND ativo = TRUE
        LIMIT 1
      `, [configId]);
      return fallback[0] || null;
    }
    return rows[0];
  }

  // ══════════════════════════════════════════════════
  // BACKOFF DE RE-TENTATIVA (NFs recusadas pela API Tutts)
  // ══════════════════════════════════════════════════
  // A NF recusada NAO some: fica registrada com um proximo_retry crescente
  // (15min, 30, 45 ... ate 6h). Nos ciclos seguintes ela e pulada ate a
  // janela vencer, quando volta a ser tentada. Ao cadastrar a modalidade/
  // filial e a corrida ser criada, o backoff e limpo automaticamente.
  async _ensureTabelaRetry() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS confirmafacil_poller_retry (
        config_id     INT    NOT NULL,
        id_embarque   BIGINT NOT NULL,
        tentativas    INT    NOT NULL DEFAULT 1,
        ultimo_erro   TEXT,
        proximo_retry TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (config_id, id_embarque)
      )
    `).catch((e) => console.warn('[CF Poller] _ensureTabelaRetry:', e.message));
  }

  async _registrarFalhaRetry(configId, idEmbarque, erro) {
    await this.pool.query(`
      INSERT INTO confirmafacil_poller_retry
        (config_id, id_embarque, tentativas, ultimo_erro, proximo_retry, atualizado_em)
      VALUES ($1, $2, 1, $3, NOW() + INTERVAL '15 minutes', NOW())
      ON CONFLICT (config_id, id_embarque) DO UPDATE SET
        tentativas    = confirmafacil_poller_retry.tentativas + 1,
        ultimo_erro   = EXCLUDED.ultimo_erro,
        atualizado_em = NOW(),
        proximo_retry = NOW() + (LEAST((confirmafacil_poller_retry.tentativas + 1) * 15, 360) || ' minutes')::interval
    `, [configId, idEmbarque, String(erro || '').slice(0, 500)])
      .catch((e) => console.warn('[CF Poller] _registrarFalhaRetry:', e.message));
  }

  async _agendarParaJanela(configId, idEmbarque, minutos, motivo) {
    // Adia a criacao reusando o backoff: proximo_retry = NOW() + minutos.
    // NAO mexe em 'tentativas' (nao e falha) — so reagenda. Upsert idempotente.
    // [cf-corte-diautil-v1] motivo dinamico (dia util vs horario) para o log/debug.
    const _msg = 'adiado: ' + (motivo || 'fora da janela de criacao');
    await this.pool.query(`
      INSERT INTO confirmafacil_poller_retry
        (config_id, id_embarque, tentativas, ultimo_erro, proximo_retry, atualizado_em)
      VALUES ($1, $2, 0, $4, NOW() + ($3 || ' minutes')::interval, NOW())
      ON CONFLICT (config_id, id_embarque) DO UPDATE SET
        ultimo_erro   = $4,
        proximo_retry = NOW() + ($3 || ' minutes')::interval,
        atualizado_em = NOW()
    `, [configId, idEmbarque, String(minutos), _msg])
      .catch((e) => console.warn('[CF Poller] _agendarParaJanela:', e.message));
  }

  async _removerRetry(configId, idEmbarque) {
    await this.pool.query(
      'DELETE FROM confirmafacil_poller_retry WHERE config_id = $1 AND id_embarque = $2',
      [configId, idEmbarque]
    ).catch(() => {});
  }

  async _logarErro(clienteId, idEmbarque, numeroNF, serieNF, cnpjEmbarcador, erro) {
    await this.pool.query(`
      INSERT INTO confirmafacil_log
        (cliente_id, id_embarque, numero_nf, serie_nf, cnpj_embarcador,
         tipo, sucesso, erro_msg)
      VALUES ($1,$2,$3,$4,$5,'poller',FALSE,$6)
    `, [clienteId, idEmbarque, numeroNF, serieNF, cnpjEmbarcador, erro]).catch(() => {});
  }
}

let _instancia = null;
function getConfirmaFacilPoller(pool) {
  if (!_instancia) _instancia = new ConfirmaFacilPoller(pool);
  return _instancia;
}

module.exports = { getConfirmaFacilPoller };
