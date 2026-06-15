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

const CF_FILTER_URL  = 'https://utilities.confirmafacil.com.br/filter/embarque';
const CF_OCORRENCIA_URL = 'https://utilities.confirmafacil.com.br/filter/ocorrencia';
const TUTTS_API_URL  = 'https://tutts.com.br/integracao';
const TUTTS_WEBHOOK  = 'https://tutts-backend-production.up.railway.app/api/webhook/tutts';
const PAGE_SIZE      = 50;

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

class ConfirmaFacilPoller {
  constructor(pool) {
    this.pool    = pool;
    this.auth    = getConfirmaFacilAuth();
    this._rodando = false;
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
  }

  // ══════════════════════════════════════════════════
  // CICLO PRINCIPAL
  // ══════════════════════════════════════════════════

  async _ciclo() {
    console.log('[CF Poller] iniciando ciclo...');
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
      : 3;
    const inicio = new Date(agora.getTime() - DIAS_JANELA * 24 * 60 * 60 * 1000);
    const deStr  = `${inicio.getFullYear()}/${p(inicio.getMonth()+1)}/${p(inicio.getDate())} 00:00:00`;
    const ateStr = `${agora.getFullYear()}/${p(agora.getMonth()+1)}/${p(agora.getDate())} 23:59:59`;

    // Buscar NFs paginando
    let page = 0;
    let totalProcessadas = 0;

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
      console.log(`[CF Poller] pg ${page}: ${lista.length} NFs | totalCount=${resp.totalCount} totalPages=${resp.totalPages}`);
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

    // 🕒 2026-06: janela de criacao (SO poller automatico). Fora de 07:30-18:20
    // (Bahia), adia a criacao na MAPP pro proximo 07:30 reusando o backoff.
    // O vinculo NAO e criado aqui, entao quando a janela abrir a NF e criada normal.
    if (CF_JANELA_CRIACAO_ATIVA) {
      const _minJanela = _minutosAteJanela();
      if (_minJanela > 0) {
        const _horas = (_minJanela / 60).toFixed(1);
        console.log(`🕒 [CF Poller] fora da janela (07:30-18:20) — adiando NF ${numeroNF} (idEmbarque ${idEmbarque}) por ~${_horas}h (proximo 07:30)`);
        await this._agendarParaJanela(config.id, idEmbarque, _minJanela);
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

  async _agendarParaJanela(configId, idEmbarque, minutos) {
    // Adia a criacao reusando o backoff: proximo_retry = NOW() + minutos.
    // NAO mexe em 'tentativas' (nao e falha) — so reagenda. Upsert idempotente.
    await this.pool.query(`
      INSERT INTO confirmafacil_poller_retry
        (config_id, id_embarque, tentativas, ultimo_erro, proximo_retry, atualizado_em)
      VALUES ($1, $2, 0, 'adiado: fora da janela de criacao (07:30-18:20)', NOW() + ($3 || ' minutes')::interval, NOW())
      ON CONFLICT (config_id, id_embarque) DO UPDATE SET
        ultimo_erro   = 'adiado: fora da janela de criacao (07:30-18:20)',
        proximo_retry = NOW() + ($3 || ' minutes')::interval,
        atualizado_em = NOW()
    `, [configId, idEmbarque, String(minutos)])
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
