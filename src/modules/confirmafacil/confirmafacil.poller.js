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
const TUTTS_API_URL  = 'https://tutts.com.br/integracao';
const TUTTS_WEBHOOK  = 'https://tutts-backend-production.up.railway.app/api/webhook/tutts';
const PAGE_SIZE      = 100;

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
    const token = await this.auth.obterToken(config.cliente_id, config);

    // Janela de busca: do último polling até agora
    // Se primeiro polling, busca últimas 24h
    const agora = new Date();
    const p = (n) => String(n).padStart(2, '0');
    // Janela AMPLA, identica a rota /sincronizar que funciona e popula o cache.
    // NFs pendentes (A_EMBARCAR) costumam ser mais antigas que poucos dias, entao
    // a janela precisa ser larga. A seguranca vem do guard de status (so cria
    // corrida para A_EMBARCAR) + do vinculo (nao recria corrida ja existente).
    const deStr  = '2024/01/01 00:00:00';
    const ateStr = `${agora.getFullYear()}/${p(agora.getMonth()+1)}/${p(agora.getDate())} 23:59:59`;

    // Buscar NFs paginando
    let page = 0;
    let totalProcessadas = 0;

    while (true) {
      const filtro = {
        page,
        size: PAGE_SIZE,
        de:   deStr,
        ate:  ateStr,
        cnpjTransportadora: [config.cnpj_transportadora],
      };

      const resp = await this._buscarEmbarques(token, filtro);
      // A API do CF as vezes devolve em "respostas", as vezes em "content"
      const lista = resp ? (resp.respostas || resp.content || []) : [];
      console.log(`[CF Poller] pg ${page}: ${lista.length} NFs encontradas`);
      if (!Array.isArray(lista) || lista.length === 0) break;

      for (const item of lista) {
        try {
          // GUARD: so cria corrida para NF pendente (nao coletada).
          // Sem isso, alargar a janela criaria corridas para NFs ja entregues.
          const statusNF = String(item.statusEmbarque?.nome || '').toUpperCase();
          if (statusNF !== 'A_EMBARCAR') continue;

          await this._salvarCache(item, config.cliente_id);
          await this._processarNF(item, config);
          totalProcessadas++;
        } catch (err) {
          console.error(`⚠️ [CF Poller] erro NF idEmbarque ${item.idEmbarque}:`, err.message);
        }
      }

      // Paginar ate vir pagina vazia (nunca para so por ter menos de PAGE_SIZE)
      page++;
    }

    // Atualizar timestamp do último polling
    await this.pool.query(
      'UPDATE confirmafacil_config SET ultimo_polling = $1 WHERE id = $2',
      [agora, config.id]
    );

    if (totalProcessadas > 0) {
      console.log(`✅ [CF Poller] cliente ${config.cliente_id}: ${totalProcessadas} NF(s) processadas`);
    }
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

    // Buscar endereço de coleta pelo cnpj do embarcador
    const coleta = await this._buscarColeta(config.id, cnpjEmbarcador);
    if (!coleta) {
      console.warn(`⚠️ [CF Poller] embarcador ${cnpjEmbarcador} sem endereço de coleta configurado — ignorando NF ${numeroNF}`);
      await this._logarErro(config.cliente_id, idEmbarque, numeroNF, serieNF, cnpjEmbarcador,
        `Embarcador ${cnpjEmbarcador} sem endereço de coleta`);
      return;
    }

    // Montar destinatário a partir do objeto retornado pelo CF
    // Prioriza trecho[0].enderecoDestino (mais completo), igual a rota manual
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
      numeroPedido:   String(idEmbarque),
    };

    console.log(`📤 [CF Poller] criando corrida para NF ${numeroNF} (idEmbarque ${idEmbarque})`);

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
      return;
    }

    const osNumero = resultado.Sucesso;
    console.log(`✅ [CF Poller] OS criada: ${osNumero} | NF ${numeroNF}`);

    // Salvar solicitacao_corrida
    const { rows: [solic] } = await this.pool.query(`
      INSERT INTO solicitacoes_corrida (
        cliente_id, numero_pedido, centro_custo, usuario_solicitante,
        forma_pagamento, retorno, tutts_os_numero, tutts_distancia,
        tutts_duracao, tutts_valor, tutts_url_rastreamento,
        status, provider_usado
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id
    `, [
      config.cliente_id,
      String(idEmbarque),
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

  async _buscarEmbarques(token, filtro) {
    try {
      // filtroDTO vai como query string serializado como JSON
      const params = new URLSearchParams({ filtroDTO: JSON.stringify(filtro) });
      const resp = await httpRequest(`${CF_FILTER_URL}?${params}`, {
        method:  'GET',
        headers: { Authorization: token, accept: 'application/json' },
      });
      return resp.json();
    } catch (err) {
      console.error('❌ [CF Poller] erro ao buscar embarques:', err.message);
      return null;
    }
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
