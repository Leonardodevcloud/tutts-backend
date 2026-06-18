'use strict';

const express = require('express');
const { getConfirmaFacilAuth }   = require('./confirmafacil.auth');
const { getConfirmaFacilPoller } = require('./confirmafacil.poller');
const AppError = require('../../shared/errors/AppError');
const { resolverCodigo } = require('./confirmafacil.map');
const slaMod = require('./confirmafacil.sla');

function createConfirmaFacilRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  const auth   = getConfirmaFacilAuth();

  // ── SLA: dispara uma mensagem de TESTE no grupo (diagnóstico) ──
  router.post('/sla-teste', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      res.json(await slaMod.enviarTeste(req.body && req.body.texto));
    } catch (err) { next(err); }
  });

  // ── SLA: painel por filial + lista de risco (para a aba "Risco de SLA") ──
  router.get('/sla-painel', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      res.json(await slaMod.calcularPainel(pool));
    } catch (err) { next(err); }
  });

  // ── Config principal ──────────────────────────────
  router.get('/config/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, cliente_id, ativo, cf_email, cf_id_cliente, cnpj_transportadora,
               mapa_ocorrencias, polling_ativo, ultimo_polling, criado_em
        FROM confirmafacil_config WHERE cliente_id = $1
      `, [req.params.clienteId]);
      res.json({ config: rows[0] || null });
    } catch (err) { next(err); }
  });

  router.post('/config', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { cliente_id, cf_email, cf_senha, cf_id_cliente, cf_id_produto,
              cnpj_transportadora, mapa_ocorrencias, polling_ativo, ativo } = req.body;

      if (!cliente_id || !cf_email || !cf_senha || !cnpj_transportadora)
        throw new AppError('cliente_id, cf_email, cf_senha e cnpj_transportadora são obrigatórios', 400);

      const { rows } = await pool.query(`
        INSERT INTO confirmafacil_config
          (cliente_id, cf_email, cf_senha, cf_id_cliente, cf_id_produto,
           cnpj_transportadora, mapa_ocorrencias, polling_ativo, ativo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (cliente_id) DO UPDATE SET
          cf_email            = EXCLUDED.cf_email,
          cf_senha            = EXCLUDED.cf_senha,
          cf_id_cliente       = EXCLUDED.cf_id_cliente,
          cf_id_produto       = EXCLUDED.cf_id_produto,
          cnpj_transportadora = EXCLUDED.cnpj_transportadora,
          mapa_ocorrencias    = EXCLUDED.mapa_ocorrencias,
          polling_ativo       = EXCLUDED.polling_ativo,
          ativo               = EXCLUDED.ativo,
          atualizado_em       = NOW()
        RETURNING id, cliente_id, ativo, polling_ativo, cf_email, cnpj_transportadora
      `, [cliente_id, cf_email, cf_senha, cf_id_cliente || 320, cf_id_produto || 1,
          cnpj_transportadora, JSON.stringify(mapa_ocorrencias || {}),
          polling_ativo !== false, ativo !== false]);

      auth.invalidar(cliente_id);
      res.json({ ok: true, config: rows[0] });
    } catch (err) { next(err); }
  });

  // ── Embarcadores ──────────────────────────────────
  router.get('/embarcadores/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT e.* FROM confirmafacil_embarcadores e
        INNER JOIN confirmafacil_config c ON c.id = e.config_id
        WHERE c.cliente_id = $1 ORDER BY e.nome_embarcador
      `, [req.params.clienteId]);
      res.json({ embarcadores: rows });
    } catch (err) { next(err); }
  });

  router.post('/embarcadores', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { cliente_id, cnpj_embarcador, nome_embarcador,
              endereco_texto, coleta_lat, coleta_lng, centro_custo_mapp } = req.body;

      if (!cliente_id || !cnpj_embarcador || !endereco_texto)
        throw new AppError('cliente_id, cnpj_embarcador e endereco_texto são obrigatórios', 400);

      // Geocoding se não vieram coordenadas
      let lat = coleta_lat || null;
      let lng = coleta_lng || null;

      if ((!lat || !lng) && endereco_texto) {
        try {
          const httpRequest = require('../../shared/utils/httpRequest');
          const apiKey = process.env.GOOGLE_MAPS_API_KEY;
          if (apiKey) {
            const geoResp = await httpRequest(
              'https://maps.googleapis.com/maps/api/geocode/json?address='+
              encodeURIComponent(endereco_texto)+'&key='+apiKey
            );
            const geoData = geoResp.json();
            if (geoData.results?.[0]?.geometry?.location) {
              lat = String(geoData.results[0].geometry.location.lat);
              lng = String(geoData.results[0].geometry.location.lng);
            }
          }
        } catch(geoErr) {
          console.warn('[CF Embarcador] geocoding falhou:', geoErr.message);
        }
      }

      // Parsear endereço_texto nos campos separados (melhor esforço)
      const partes = endereco_texto.split(',').map(p => p.trim());
      const coleta_rua    = partes[0] || '';
      const coleta_numero = partes[1] || '';
      const coleta_bairro = partes[2] || '';
      const coleta_cidade = partes[3] || '';
      // UF: pegar só 2 letras maiúsculas — ex: "AL - 57061-51" → "AL"
      const ufRaw = partes[4] || '';
      const ufMatch = ufRaw.match(/[A-Z]{2}/);
      const coleta_uf  = ufMatch ? ufMatch[0] : ufRaw.substring(0, 2);
      // CEP: buscar padrão XXXXX-XX em qualquer parte do endereço
      const cepMatch = endereco_texto.match(/\d{5}-?\d{2,3}/);
      const coleta_cep = cepMatch ? cepMatch[0] : (partes[5] || '');

      // Buscar config_id
      const { rows: cfg } = await pool.query(
        'SELECT id FROM confirmafacil_config WHERE cliente_id = $1', [cliente_id]);
      if (!cfg[0]) throw new AppError('Config CF não encontrada para este cliente', 404);

      const { rows } = await pool.query(`
        INSERT INTO confirmafacil_embarcadores
          (config_id, cnpj_embarcador, nome_embarcador,
           coleta_rua, coleta_numero, coleta_bairro,
           coleta_cidade, coleta_uf, coleta_cep,
           coleta_lat, coleta_lng, coleta_nome_fantasia,
           centro_custo_mapp)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (config_id, cnpj_embarcador) DO UPDATE SET
          nome_embarcador     = EXCLUDED.nome_embarcador,
          coleta_rua          = EXCLUDED.coleta_rua,
          coleta_numero       = EXCLUDED.coleta_numero,
          coleta_bairro       = EXCLUDED.coleta_bairro,
          coleta_cidade       = EXCLUDED.coleta_cidade,
          coleta_uf           = EXCLUDED.coleta_uf,
          coleta_cep          = EXCLUDED.coleta_cep,
          coleta_lat          = EXCLUDED.coleta_lat,
          coleta_lng          = EXCLUDED.coleta_lng,
          coleta_nome_fantasia= EXCLUDED.coleta_nome_fantasia,
          centro_custo_mapp   = EXCLUDED.centro_custo_mapp
        RETURNING *
      `, [cfg[0].id, cnpj_embarcador, nome_embarcador,
          coleta_rua, coleta_numero, coleta_bairro,
          coleta_cidade, coleta_uf, coleta_cep,
          lat || null, lng || null,
          nome_embarcador || null,
          centro_custo_mapp || null]);

      res.json({ ok: true, embarcador: rows[0] });
    } catch (err) { next(err); }
  });

  router.delete('/embarcadores/:id', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      await pool.query(
        'UPDATE confirmafacil_embarcadores SET ativo = FALSE WHERE id = $1',
        [req.params.id]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Log e vínculos ────────────────────────────────
  router.get('/log/:solicitacaoId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, numero_nf, id_embarque, status_tutts, cod_ocorrencia,
               tipo, sucesso, erro_msg, criado_em
        FROM confirmafacil_log WHERE solicitacao_id = $1
        ORDER BY criado_em DESC LIMIT 100
      `, [req.params.solicitacaoId]);
      res.json({ logs: rows });
    } catch (err) { next(err); }
  });

  // ── Busca direta no CF (teste — não cria corrida) ────────────
  router.post('/buscar-nfs', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { de, ate, page, size } = req.body;

      // Busca todas as configs ativas
      const { rows: configs } = await pool.query(`
        SELECT cf.*, cs.nome AS cliente_nome
        FROM confirmafacil_config cf
        INNER JOIN clientes_solicitacao cs ON cs.id = cf.cliente_id
        WHERE cf.ativo = TRUE
        LIMIT 10
      `);

      if (configs.length === 0) {
        // Fallback: aceita credenciais direto no body pra teste sem cliente configurado
        const { cf_email, cf_senha, cf_id_cliente, cnpj_transportadora } = req.body;
        if (cf_email && cf_senha) {
          configs.push({
            cliente_id:          0,
            cliente_nome:        'Teste direto',
            cf_email,
            cf_senha,
            cf_id_cliente:       cf_id_cliente || 320,
            cnpj_transportadora: cnpj_transportadora || '',
          });
        } else {
          return res.json({ ok: false, mensagem: 'Nenhum cliente CF configurado. Configure na aba Configuração ou informe cf_email e cf_senha no body.' });
        }
      }

      const resultados = [];

      for (const config of configs) {
        try {
          const token = await auth.obterToken(config.cliente_id, config);

          const agora = new Date();
          const inicio = de || (() => {
            const d = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
            return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} 00:00:00`;
          })();
          const fim = ate || (() => {
            return `${agora.getFullYear()}/${String(agora.getMonth()+1).padStart(2,'0')}/${String(agora.getDate()).padStart(2,'0')} 23:59:59`;
          })();

          const filtro = {
            page: page || 0,
            size: size || 20,
            de: inicio,
            ate: fim,
            cnpjTransportadora: [config.cnpj_transportadora],
          };

          const params = new URLSearchParams({ filtroDTO: JSON.stringify(filtro) });
          const httpRequest = require('../../shared/utils/httpRequest');
          const resp = await httpRequest(
            `https://utilities.confirmafacil.com.br/filter/embarque?${params}`,
            { method: 'GET', headers: { Authorization: token, accept: 'application/json' } }
          );

          const data = resp.json();
          resultados.push({
            cliente_id:   config.cliente_id,
            cliente_nome: config.cliente_nome,
            filtro_usado: filtro,
            total:        data.totalCount || data.respostas?.length || 0,
            total_paginas:data.totalPages || 1,
            nfs:          data.respostas || data.content || data || [],
            status_http:  resp.status,
            ok:           resp.ok,
          });
        } catch (err) {
          resultados.push({
            cliente_id:   config.cliente_id,
            cliente_nome: config.cliente_nome,
            ok:           false,
            erro:         err.message,
          });
        }
      }

      res.json({ ok: true, resultados });
    } catch (err) { next(err); }
  });

  // ── NFs recebidas — TODAS os clientes (sem filtro) ────────────
  router.get('/nfs', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          v.id, v.id_embarque, v.solicitacao_id, v.numero_nf, v.serie_nf,
          v.cnpj_embarcador, v.criado_em,
          sc.status,
          sc.tutts_os_numero,
          cs.nome AS cliente_nome
        FROM confirmafacil_vinculos v
        LEFT JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
        LEFT JOIN clientes_solicitacao cs ON cs.id = v.cliente_id
        ORDER BY v.criado_em DESC
        LIMIT 500
      `);
      res.json({ vinculos: rows });
    } catch (err) { next(err); }
  });

  // ── NFs recebidas por cliente ─────────────────────────────────
  router.get('/nfs/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT v.id, v.id_embarque, v.solicitacao_id, v.numero_nf, v.serie_nf,
               v.cnpj_embarcador, v.criado_em,
               sc.status, sc.tutts_os_numero
        FROM confirmafacil_vinculos v
        LEFT JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
        WHERE v.cliente_id = $1
        ORDER BY v.criado_em DESC
        LIMIT 500
      `, [req.params.clienteId]);
      res.json({ vinculos: rows });
    } catch (err) { next(err); }
  });

  // ── Test credenciais ──────────────────────────────
  router.post('/test/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM confirmafacil_config WHERE cliente_id = $1', [req.params.clienteId]);
      if (!rows[0]) throw new AppError('Config não encontrada', 404);

      auth.invalidar(Number(req.params.clienteId));
      const token = await auth.obterToken(Number(req.params.clienteId), rows[0]);
      res.json({ ok: true, mensagem: 'Credenciais válidas', token_obtido: !!token });
    } catch (err) {
      if (err.status) return next(err);
      res.json({ ok: false, mensagem: err.message });
    }
  });

  // ── Polling manual (força um ciclo agora) ─────────
  router.post('/polling/forcar', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const poller = getConfirmaFacilPoller(pool);
      // Roda em background — não aguarda
      poller._ciclo().catch(err => console.error('[CF Poller] forçado erro:', err.message));
      res.json({ ok: true, mensagem: 'Ciclo de polling iniciado em background' });
    } catch (err) { next(err); }
  });

// ── Criar corrida de teste a partir de uma NF do CF ───────────
  // Recebe os dados brutos da NF (já buscada no CF) e cria corrida na Mapp.
  // Usa endereço do embarcador como coleta e endereço do destinatário como entrega.
  router.post('/criar-corrida', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { nf: nfRaw, cliente_id } = req.body;

      // Normalizar — suporta NF do CF API e NF do cache local
      const nf = nfRaw.idEmbarque ? nfRaw : {
        idEmbarque:   nfRaw.id_embarque,
        numero:       nfRaw.numero_nf,
        serie:        nfRaw.serie_nf,
        chave:        nfRaw.chave_nfe,
        valor:        nfRaw.valor,
        diasAtraso:   nfRaw.dias_atraso || 0,
        dataPrevisao: nfRaw.data_previsao,
        statusEmbarque: { nome: nfRaw.status_cf || 'A_EMBARCAR' },
        embarcador: {
          cnpj: nfRaw.cnpj_embarcador || '',
          nome: nfRaw.nome_embarcador || '',
          endereco: {},
        },
        destinatario: {
          nome: nfRaw.destinatario_nome || '',
          cnpj: nfRaw.destinatario_cnpj || '',
          endereco: {
            logradouro: nfRaw.destinatario_end || '',
            cidade:     nfRaw.destinatario_cidade || '',
            uf:         nfRaw.destinatario_uf || '',
          },
        },
        linkExterno: nfRaw.link_rastreamento,
        // Se tiver payload_completo do CF, mescla
        ...(nfRaw.payload_completo && typeof nfRaw.payload_completo === 'object'
          ? nfRaw.payload_completo : {}),
      };

      if (!nf) throw new AppError('nf é obrigatório', 400);
      if (!cliente_id) throw new AppError('cliente_id é obrigatório', 400);

      // Verificar se já tem vínculo
      const idEmbarque = nf.idEmbarque || nf.id;
      if (idEmbarque) {
        const { rows: jaExiste } = await pool.query(
          'SELECT id FROM confirmafacil_vinculos WHERE id_embarque = $1', [idEmbarque]
        );
        if (jaExiste.length > 0) {
          return res.json({ ok: false, mensagem: `NF ${nf.numero} já tem corrida vinculada (solicitacao_id: ${jaExiste[0].id})` });
        }
      }

      // Buscar dados do cliente
      const { rows: [cliente] } = await pool.query(
        'SELECT * FROM clientes_solicitacao WHERE id = $1', [cliente_id]
      );
      if (!cliente) throw new AppError('Cliente não encontrado', 404);

      // Montar pontos a partir dos dados da NF
      // Ponto 1: coleta — endereço do embarcador
      const embEnd = nf.embarcador?.endereco || nf.enderecoRedespacho || {};
      // Ponto 2: entrega — endereço do destinatário
      // Prioriza trecho[0].enderecoDestino (mais completo), depois destinatario.endereco, depois nf.endereco
      const destEnd = nf.trecho?.[0]?.enderecoDestino
                   || nf.destinatario?.endereco
                   || nf.endereco
                   || {};
      const dest = nf.destinatario || {};

      const montarObs = (p, nomeExtra) => {
        const partes = [];
        if (nomeExtra) partes.push(`NOME FANTASIA: ${nomeExtra}`);
        if (nf.numero) partes.push(`NF: ${nf.numero}`);
        if (nf.serie) partes.push(`SÉRIE: ${nf.serie}`);
        if (dest.celular) partes.push(`TEL: ${dest.celular}`);
        if (nf.valor) partes.push(`VALOR: R$ ${Number(nf.valor).toFixed(2)}`);
        return partes.join(', ');
      };

      // Buscar centro_custo_mapp do embarcador desta NF
      const cnpjEmbNF = nf.embarcador?.cnpj || '';
      const { rows: [embConfig] } = await pool.query(`
        SELECT e.centro_custo_mapp, e.categoria_mapp, e.coleta_lat, e.coleta_lng,
               e.coleta_rua, e.coleta_numero, e.coleta_cidade, e.coleta_uf, e.coleta_cep
        FROM confirmafacil_embarcadores e
        INNER JOIN confirmafacil_config c ON c.id = e.config_id
        WHERE c.cliente_id = $1
          AND REGEXP_REPLACE(e.cnpj_embarcador, '[^0-9]', '', 'g') =
              REGEXP_REPLACE($2::text, '[^0-9]', '', 'g')
          AND e.ativo = TRUE
        LIMIT 1
      `, [cliente_id, cnpjEmbNF]).catch(() => ({ rows: [] }));

      console.log('[CF criar-corrida] cnpjEmbNF:', cnpjEmbNF, '| embConfig:', embConfig);

      const pontos = [
        // Coleta — usa dados do banco (embConfig) se disponível, senão dados da NF
        {
          rua:    embConfig?.coleta_rua    || embEnd.logradouro || '',
          numero: embConfig?.coleta_numero || embEnd.numero     || '',
          bairro: '',
          cidade: embConfig?.coleta_cidade || embEnd.cidade     || '',
          uf:     embConfig?.coleta_uf     || embEnd.uf         || '',
          cep:    embConfig?.coleta_cep    || embEnd.cep        || '',
          la:     embConfig?.coleta_lat    || null,
          lo:     embConfig?.coleta_lng    || null,
          obs:    `COLETA: ${nf.embarcador?.nome || 'Embarcador'}`,
        },
        // Entrega
        {
          rua:         destEnd.logradouro || '',
          numero:      destEnd.numero || '',
          bairro:      '',
          cidade:      destEnd.cidade || '',
          uf:          destEnd.uf || '',
          cep:         destEnd.cep || '',
          nome_fantasia: dest.nome || '',
          numero_nota: nf.numero || '',
          obs:         montarObs(destEnd, dest.nome),
        },
      ];

      // Validação mínima
      if (!pontos[1].cidade || !pontos[1].uf) {
        return res.json({ ok: false, mensagem: 'Endereço de entrega incompleto na NF — faltam cidade/UF' });
      }

      const httpRequest = require('../../shared/utils/httpRequest');

      const centroCusto = embConfig?.centro_custo_mapp
        || cliente.centro_custo_padrao
        || cliente.nome
        || 'Central';

      const payloadTutts = {
        token:          cliente.tutts_token_api,
        codCliente:     cliente.tutts_codigo_cliente,
        Usuario:        'ConfirmaFácil',
        centroCusto,
        pontos:         pontos.map(p => {
          const obj = { rua: p.rua, numero: p.numero, bairro: p.bairro,
                        cidade: p.cidade, uf: p.uf, obs: p.obs };
          if (p.cep) obj.cep = p.cep;
          if (p.la)  obj.la  = String(p.la);
          if (p.lo)  obj.lo  = String(p.lo);
          return obj;
        }),
        retorno:        'N',
        formaPagamento: cliente.forma_pagamento_padrao || 'F',
        UrlRetorno:     'https://tutts-backend-production.up.railway.app/api/webhook/tutts',
        numeroPedido:   String(idEmbarque || nf.numero),
      };

      // Categoria (modalidade de frete) do embarcador — mesma regra do poller.
      // Sem isso a Tutts rejeita com "Categoria nao informada".
      if (embConfig && embConfig.categoria_mapp && String(embConfig.categoria_mapp).trim()) {
        payloadTutts.categoria = String(embConfig.categoria_mapp).trim().toUpperCase();
      }

      console.log('📤 [CF criar-corrida] payload:', JSON.stringify(payloadTutts, null, 2));

      const resp = await httpRequest('https://tutts.com.br/integracao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadTutts),
      });

      const resultado = resp.json();
      console.log('📥 [CF criar-corrida] resultado:', resultado);

      if (resultado.Erro) {
        return res.json({ ok: false, mensagem: resultado.Erro, payload_enviado: payloadTutts });
      }

      const osNumero = resultado.Sucesso;

      // Salvar solicitacao_corrida
      const { rows: [solic] } = await pool.query(`
        INSERT INTO solicitacoes_corrida (
          cliente_id, numero_pedido, centro_custo, usuario_solicitante,
          forma_pagamento, retorno, tutts_os_numero, tutts_distancia,
          tutts_duracao, tutts_valor, tutts_url_rastreamento,
          status, provider_usado
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id
      `, [
        cliente_id,
        String(idEmbarque || nf.numero),
        centroCusto,
        'ConfirmaFácil',
        cliente.forma_pagamento_padrao || 'F',
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
      const pontosDB = [
        { ordem: 1, rua: embEnd.logradouro, numero: embEnd.numero, bairro: '',
          cidade: embEnd.cidade, uf: embEnd.uf, cep: embEnd.cep,
          nome_fantasia: nf.embarcador?.nome, numero_nota: null },
        { ordem: 2, rua: destEnd.logradouro, numero: destEnd.numero, bairro: '',
          cidade: destEnd.cidade, uf: destEnd.uf, cep: destEnd.cep,
          nome_fantasia: dest.nome, numero_nota: nf.numero },
      ];

      for (const p of pontosDB) {
        await pool.query(`
          INSERT INTO solicitacoes_pontos
            (solicitacao_id, ordem, rua, numero, bairro, cidade, uf, cep,
             nome_fantasia, numero_nota, status, endereco_completo)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendente',$11)
        `, [
          solicitacaoId, p.ordem, p.rua||'', p.numero||'', p.bairro||'',
          p.cidade||'', p.uf||'', p.cep||'',
          p.nome_fantasia||'', p.numero_nota||null,
          [p.rua, p.numero, p.cidade, p.uf].filter(Boolean).join(', '),
        ]);
      }

      // Salvar vínculo
      if (idEmbarque) {
        await pool.query(`
          INSERT INTO confirmafacil_vinculos
            (id_embarque, solicitacao_id, cliente_id, numero_nf, serie_nf, cnpj_embarcador)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (id_embarque) DO NOTHING
        `, [idEmbarque, solicitacaoId, cliente_id, nf.numero, nf.serie, nf.embarcador?.cnpj||'']);

        // Garantir entrada no cache com dados básicos da NF
        const end = nf.destinatario?.endereco || nf.endereco || {};
        await pool.query(`
          INSERT INTO confirmafacil_nfs_cache (
            cliente_id, id_embarque, numero_nf, serie_nf, chave_nfe,
            cnpj_embarcador, nome_embarcador,
            destinatario_nome, destinatario_cidade, destinatario_uf, destinatario_end,
            status_cf, status_nota, dias_atraso,
            data_previsao, data_emissao, valor,
            payload_completo, sincronizado_em
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
          ON CONFLICT (cliente_id, id_embarque) DO UPDATE SET
            status_cf       = EXCLUDED.status_cf,
            data_emissao    = COALESCE(confirmafacil_nfs_cache.data_emissao, EXCLUDED.data_emissao),
            data_previsao   = COALESCE(confirmafacil_nfs_cache.data_previsao, EXCLUDED.data_previsao),
            sincronizado_em = NOW()
        `, [
          cliente_id, idEmbarque, nf.numero, nf.serie, nf.chave||null,
          nf.embarcador?.cnpj||'', nf.embarcador?.nome||'',
          nf.destinatario?.nome||'',
          end.cidade||'', end.uf||'',
          [end.logradouro, end.numero, end.cidade, end.uf].filter(Boolean).join(', '),
          nf.statusEmbarque?.nome||'A_EMBARCAR',
          nf.statusNota||'', nf.diasAtraso||0,
          nf.dataPrevisao ? new Date(nf.dataPrevisao) : null,
          nf.dataEmissao  ? new Date(nf.dataEmissao)  : null,
          nf.valor||null, nf,
        ]).catch(e => console.warn('[CF] erro ao salvar cache no criar-corrida:', e.message));
      }

      res.json({
        ok:            true,
        os_numero:     osNumero,
        solicitacao_id: solicitacaoId,
        mensagem:      `Corrida criada! OS: ${osNumero}`,
        detalhes:      resultado.detalhes || null,
      });

    } catch (err) {
      console.error('❌ [CF criar-corrida] erro:', err.message, err.stack?.split('\n')[1]);
      next(err);
    }
  });

  // ── Testar envio de ocorrência para o CF ──────────────────────
  // Simula o que o webhook faz: envia uma ocorrência para uma OS já criada.
  // Use para verificar se o CF está recebendo corretamente.
  router.post('/testar-ocorrencia', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { solicitacao_id, status } = req.body;
      if (!solicitacao_id) throw new AppError('solicitacao_id é obrigatório', 400);

      // 1. Buscar OS
      const { rows: [solic] } = await pool.query(
        'SELECT * FROM solicitacoes_corrida WHERE id = $1', [solicitacao_id]
      );
      if (!solic) throw new AppError('Solicitação não encontrada', 404);

      // 2. Verificar se tem config CF para este cliente
      const { rows: [config] } = await pool.query(`
        SELECT cf.id, cf.cf_email, cf.cnpj_transportadora, cf.ativo,
               COALESCE(v.cnpj_embarcador,'') AS cnpj_embarcador
        FROM confirmafacil_config cf
        LEFT JOIN confirmafacil_vinculos v ON v.solicitacao_id = $1
        WHERE cf.cliente_id = $2 AND cf.ativo = TRUE
        LIMIT 1
      `, [solicitacao_id, solic.cliente_id]);

      if (!config) {
        return res.json({
          ok: false,
          mensagem: 'Cliente ID '+solic.cliente_id+' não tem configuração CF ativa. Vá em Configuração → selecione o cliente → preencha email/senha/CNPJ e salve.',
          logs: [],
        });
      }

      // 3. Verificar se tem NF vinculada (número de nota no ponto)
      const { rows: pontos } = await pool.query(`
        SELECT numero_nota FROM solicitacoes_pontos
        WHERE solicitacao_id = $1 AND ordem > 1 AND numero_nota IS NOT NULL
      `, [solicitacao_id]);

      if (pontos.length === 0) {
        return res.json({
          ok: false,
          mensagem: 'Nenhum ponto com número de NF encontrado para esta corrida. Verifique se os pontos foram salvos corretamente.',
          logs: [],
        });
      }

      // 4. Verificar mapa de ocorrências
      const { rows: [cfConfig] } = await pool.query(
        'SELECT mapa_ocorrencias FROM confirmafacil_config WHERE cliente_id = $1', [solic.cliente_id]
      );
      const mapa = cfConfig?.mapa_ocorrencias || {};
      const statusUsar = status || 'finalizado_ponto';
      const codMapeado = resolverCodigo(statusUsar, mapa);

      if (!codMapeado) {
        return res.json({
          ok: false,
          mensagem: 'Status "'+statusUsar+'" não tem código CF mapeado. Vá em Configuração e adicione o mapa de ocorrências. Ex: {"finalizado_ponto":"1","coletado":"58"}',
          config_atual: { email: config.cf_email, mapa_ocorrencias: mapa },
          nfs_encontradas: pontos.map(p => p.numero_nota),
          logs: [],
        });
      }

      // 5. Tudo OK — processar
      const { getConfirmaFacilService } = require('./confirmafacil.service');
      const cfService = getConfirmaFacilService(pool);

      await cfService.processar({
        solicitacaoId: solicitacao_id,
        osNumero:      solic.tutts_os_numero,
        novoStatus:    statusUsar,
        pontoStatus:   statusUsar,
      });

      // 6. Buscar log criado
      const { rows: logs } = await pool.query(`
        SELECT id, numero_nf, cod_ocorrencia, sucesso, erro_msg,
               resposta, criado_em
        FROM confirmafacil_log
        WHERE solicitacao_id = $1
        ORDER BY criado_em DESC
        LIMIT 5
      `, [solicitacao_id]);

      const sucesso = logs.some(l => l.sucesso);
      res.json({
        ok:          sucesso,
        mensagem:    sucesso ? '✅ CF recebeu a ocorrência!' : '❌ CF rejeitou — veja detalhes nos logs',
        os_numero:   solic.tutts_os_numero,
        status_usado: statusUsar,
        cod_ocorrencia: codMapeado,
        nfs:         pontos.map(p => p.numero_nota),
        logs,
      });
    } catch (err) { next(err); }
  });


  // ── Centros de custo disponíveis para um cliente ─────────────
  // Busca os centros de custo da Mapp a partir do cod_cliente interno
  router.get('/centros-custo/:clienteId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { clienteId } = req.params;

      // Buscar cod_cliente Tutts (campo tutts_codigo_cliente em clientes_solicitacao)
      const { rows: [cliente] } = await pool.query(
        'SELECT tutts_codigo_cliente FROM clientes_solicitacao WHERE id = $1',
        [clienteId]
      );

      if (!cliente?.tutts_codigo_cliente) {
        return res.json({ centros: [], mensagem: 'cod_cliente não encontrado para este cliente' });
      }

      const codCliente = cliente.tutts_codigo_cliente;

      // Buscar centros de custo do BI — cast para texto pra evitar mismatch de tipo
      const { rows } = await pool.query(`
        SELECT DISTINCT centro_custo
        FROM bi_entregas
        WHERE cod_cliente::text = $1::text
          AND centro_custo IS NOT NULL
          AND centro_custo != ''
        ORDER BY centro_custo
      `, [codCliente]);

      res.json({ centros: rows.map(r => r.centro_custo), cod_cliente: codCliente, total: rows.length });
    } catch (err) { next(err); }
  });


  // ── Listagem combinada de NFs (vinculos + filtros) ───────────
  // ── Listagem de embarcadores de todos os clientes (para filtro) ─
  router.get('/embarcadores-todos', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT e.id, e.cnpj_embarcador, e.nome_embarcador, e.coleta_cidade, e.coleta_uf,
               e.centro_custo_mapp, c.cliente_id
        FROM confirmafacil_embarcadores e
        INNER JOIN confirmafacil_config c ON c.id = e.config_id
        WHERE e.ativo = TRUE
        ORDER BY e.nome_embarcador
      `);
      res.json({ embarcadores: rows });
    } catch (err) { next(err); }
  });

  // ── Listagem de NFs — lê do cache local (rápido) ────────────
  router.get('/nfs-lista', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { embarcador_cnpj, tem_corrida, status_cf, sla,
              de, ate, busca, page = '0', size = '100' } = req.query;

      const pg = Math.max(0, Number(page));
      const sz = Math.min(500, Math.max(1, Number(size)));
      const offset = pg * sz;

      const params = [];
      const wheres = [];

      if (embarcador_cnpj) {
        params.push(embarcador_cnpj);
        wheres.push(`REGEXP_REPLACE(c.cnpj_embarcador,'[^0-9]','','g') = REGEXP_REPLACE($${params.length},'[^0-9]','','g')`);
      }
      if (de)  { params.push(de);  wheres.push(`c.data_previsao >= $${params.length}`); }
      if (ate) { params.push(ate); wheres.push(`c.data_previsao <= $${params.length}`); }
      if (tem_corrida === 'sim') wheres.push('v.solicitacao_id IS NOT NULL');
      if (tem_corrida === 'nao') wheres.push('v.solicitacao_id IS NULL');
      if (busca) {
        params.push('%' + busca + '%');
        const pi = params.length;
        wheres.push(`(c.numero_nf ILIKE $${pi} OR c.destinatario_nome ILIKE $${pi} OR sc.tutts_os_numero ILIKE $${pi})`);
      }

      // Filtros base (SEM status_cf) -> usados na CONTAGEM (cards mostram a
      // distribuicao completa, nao zeram ao selecionar um status).
      const whereCount  = wheres.length ? 'AND ' + wheres.join(' AND ') : '';
      const paramsCount = [...params];

      // A LISTA aplica tambem o filtro de status (selecao do card).
      const paramsData = [...params];
      let statusClause = '';
      if (status_cf) { paramsData.push(status_cf); statusClause = ` AND c.status_cf = $${paramsData.length}`; }

      // Filtro de SLA (server-side). Regra: 2h desde a criacao da corrida;
      // se criada apos 16:30 (BRT) conta a partir das 08:00 do dia seguinte.
      // created_at e armazenado em UTC (naive) -> interpretamos como UTC e convertemos para BRT.
      let slaClause = '';
      if (sla) {
        const criadoBrt   = `((COALESCE(sc.created_at, v.criado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')`;
        const inicioBrt   = `(CASE WHEN ${criadoBrt}::time > TIME '16:30' THEN ((date(${criadoBrt}) + 1) + TIME '08:00') ELSE ${criadoBrt} END)`;
        const inicioUtc   = `(${inicioBrt} AT TIME ZONE 'America/Sao_Paulo')`;
        const deadlineUtc = `((${inicioBrt} + INTERVAL '2 hours') AT TIME ZONE 'America/Sao_Paulo')`;
        let cond = null;
        if (sla === 'agendado')       cond = `NOW() < ${inicioUtc}`;
        else if (sla === 'estourado') cond = `NOW() >= ${deadlineUtc}`;
        else if (sla === 'iminente')  cond = `NOW() >= ${inicioUtc} AND NOW() < ${deadlineUtc} AND (${deadlineUtc} - NOW()) <= INTERVAL '15 minutes'`;
        else if (sla === 'atencao')   cond = `NOW() >= ${inicioUtc} AND (${deadlineUtc} - NOW()) > INTERVAL '15 minutes' AND (${deadlineUtc} - NOW()) <= INTERVAL '30 minutes'`;
        else if (sla === 'no_prazo')  cond = `NOW() >= ${inicioUtc} AND (${deadlineUtc} - NOW()) > INTERVAL '30 minutes'`;
        if (cond) slaClause = ` AND COALESCE(sc.created_at, v.criado_em) IS NOT NULL AND c.status_cf NOT IN ('ENTREGUE','CANCELADO','DEVOLVIDO') AND (${cond})`;
      }

      const where = whereCount + statusClause + slaClause;

      // Buscar embarcadores para nomes
      const { rows: embs } = await pool.query(`
        SELECT e.cnpj_embarcador, e.nome_embarcador, e.centro_custo_mapp, e.config_id,
               cf.cliente_id
        FROM confirmafacil_embarcadores e
        INNER JOIN confirmafacil_config cf ON cf.id = e.config_id
        WHERE e.ativo = TRUE
      `);
      const embMap = {};
      embs.forEach(e => {
        const k = (e.cnpj_embarcador||'').replace(/[^0-9]/g,'');
        embMap[k] = e;
      });

      const sqlData = `
        SELECT c.*,
          v.solicitacao_id, v.criado_em AS vinculado_em,
          sc.tutts_os_numero, sc.status AS status_corrida,
          COALESCE(sc.created_at, v.criado_em) AS corrida_criada_em,
          cs.nome AS cliente_nome,
          (SELECT cod_ocorrencia FROM confirmafacil_log
           WHERE solicitacao_id = v.solicitacao_id
           ORDER BY criado_em DESC LIMIT 1) AS ultimo_cod_cf,
          (SELECT sucesso FROM confirmafacil_log
           WHERE solicitacao_id = v.solicitacao_id
           ORDER BY criado_em DESC LIMIT 1) AS ultimo_cf_sucesso
        FROM confirmafacil_nfs_cache c
        LEFT JOIN confirmafacil_vinculos v
          ON v.id_embarque = c.id_embarque AND v.cliente_id = c.cliente_id
        LEFT JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
        LEFT JOIN clientes_solicitacao cs ON cs.id = c.cliente_id
        WHERE 1=1 ${where}
        ORDER BY c.data_previsao DESC NULLS LAST, c.id_embarque DESC
        LIMIT $${paramsData.length + 1} OFFSET $${paramsData.length + 2}
      `;

      const sqlCount = `
        SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE c.status_cf = 'A_EMBARCAR')  AS a_embarcar,
          COUNT(*) FILTER (WHERE c.status_cf = 'EM_TRANSITO') AS em_transito,
          COUNT(*) FILTER (WHERE c.status_cf = 'ENTREGUE')    AS entregue,
          COUNT(*) FILTER (WHERE c.status_cf = 'REENTREGA')   AS reentrega,
          COUNT(*) FILTER (WHERE c.status_cf = 'DEVOLVIDO')   AS devolvido,
          COUNT(*) FILTER (WHERE c.status_cf = 'CANCELADO')   AS cancelado,
          COUNT(*) FILTER (WHERE v.solicitacao_id IS NULL)    AS sem_os
        FROM confirmafacil_nfs_cache c
        LEFT JOIN confirmafacil_vinculos v ON v.id_embarque = c.id_embarque AND v.cliente_id = c.cliente_id
        LEFT JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
        WHERE 1=1 ${whereCount}
      `;

      const [{ rows }, { rows: [counts] }] = await Promise.all([
        pool.query(sqlData,  [...paramsData, sz, offset]),
        pool.query(sqlCount, paramsCount),
      ]);

      // Enriquecer com dados do embarcador
      const nfs = rows.map(r => {
        const k = (r.cnpj_embarcador||'').replace(/[^0-9]/g,'');
        const emb = embMap[k];
        return {
          ...r,
          nome_embarcador:  r.nome_embarcador || emb?.nome_embarcador || '',
          centro_custo_mapp: emb?.centro_custo_mapp || null,
        };
      });

      const total      = Number(counts.total);
      const totalSemOS = Number(counts.sem_os || 0);
      const totalComOS = total - totalSemOS;
      const totalCFOk  = rows.filter(r =>  r.ultimo_cf_sucesso).length;

      // Verificar última sincronização
      const { rows: [syncInfo] } = await pool.query(
        'SELECT MAX(sincronizado_em) AS ultima_sync, COUNT(*) AS total_cache FROM confirmafacil_nfs_cache'
      );

      res.json({
        nfs, total, page: pg, size: sz,
        contadores: {
          A_EMBARCAR:  Number(counts.a_embarcar),
          EM_TRANSITO: Number(counts.em_transito),
          ENTREGUE:    Number(counts.entregue),
          REENTREGA:   Number(counts.reentrega),
          DEVOLVIDO:   Number(counts.devolvido),
          CANCELADO:   Number(counts.cancelado),
        },
        totalComOS, totalSemOS, totalCFOk,
        ultima_sync: syncInfo?.ultima_sync || null,
        total_cache: Number(syncInfo?.total_cache || 0),
      });
    } catch (err) { next(err); }
  });
  // ── Sincronizar NFs do CF para o cache local ─────────────────
  router.post('/sincronizar', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { cliente_id } = req.body;

      const { rows: configs } = await pool.query(`
        SELECT cf.*, cs.nome AS cliente_nome
        FROM confirmafacil_config cf
        INNER JOIN clientes_solicitacao cs ON cs.id = cf.cliente_id
        WHERE cf.ativo = TRUE ${cliente_id ? 'AND cf.cliente_id = $1' : ''}
      `, cliente_id ? [cliente_id] : []);

      if (configs.length === 0)
        return res.json({ ok: false, mensagem: 'Nenhum cliente CF configurado' });

      // Roda sync em background
      (async () => {
        const httpRequest = require('../../shared/utils/httpRequest');

        for (const config of configs) {
          try {
            const cfAuth = getConfirmaFacilAuth();
            const token  = await cfAuth.obterToken(config.cliente_id, config);
            let pg2 = 0, total = 0;
            const ateStr = (() => { const n = new Date(); const p = x => String(x).padStart(2,'0');
              return `${n.getFullYear()}/${p(n.getMonth()+1)}/${p(n.getDate())} 23:59:59`; })();

            while (true) {
              const filtro = { page: pg2, size: 100,
                de:  '2024/01/01 00:00:00',
                ate: ateStr,
                cnpjTransportadora: [config.cnpj_transportadora] };

              const params = new URLSearchParams({ filtroDTO: JSON.stringify(filtro) });
              const resp = await httpRequest(
                'https://utilities.confirmafacil.com.br/filter/embarque?' + params,
                { method: 'GET', headers: { Authorization: token, accept: 'application/json' } }
              );
              const data = resp.json();
              const nfs  = data.respostas || data.content || [];
              console.log(`[CF Sync] pg ${pg2}: ${nfs.length} NFs | totalCount=${data.totalCount} totalPages=${data.totalPages} total=${data.total} keys=${Object.keys(data).join(',')}`);

              for (const nf of nfs) {
                const end = nf.destinatario?.endereco || nf.endereco || {};
                await pool.query(`
                  INSERT INTO confirmafacil_nfs_cache (
                    cliente_id, id_embarque, numero_nf, serie_nf, chave_nfe,
                    cnpj_embarcador, nome_embarcador,
                    destinatario_nome, destinatario_cnpj,
                    destinatario_cidade, destinatario_uf, destinatario_end,
                    status_cf, status_nota, dias_atraso, data_previsao, data_emissao,
                    valor, tipo_envio, tipo_frete, link_rastreamento, payload_completo,
                    sincronizado_em
                  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
                  ON CONFLICT (cliente_id, id_embarque) DO UPDATE SET
                    status_cf          = EXCLUDED.status_cf,
                    status_nota        = EXCLUDED.status_nota,
                    dias_atraso        = EXCLUDED.dias_atraso,
                    data_previsao      = EXCLUDED.data_previsao,
                    destinatario_nome  = EXCLUDED.destinatario_nome,
                    destinatario_cidade= EXCLUDED.destinatario_cidade,
                    destinatario_uf    = EXCLUDED.destinatario_uf,
                    link_rastreamento  = EXCLUDED.link_rastreamento,
                    payload_completo   = EXCLUDED.payload_completo,
                    sincronizado_em    = NOW()
                `, [
                  config.cliente_id,
                  nf.idEmbarque || nf.id,
                  nf.numero, nf.serie, nf.chave,
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
                total++;
              }

              // Para só se vier página vazia — nunca para por ter menos de 100
              if (nfs.length === 0) break;
              pg2++;
            }
            console.log(`✅ [CF Sync] cliente ${config.cliente_id}: ${total} NFs sincronizadas`);
          } catch(e) {
            console.error(`❌ [CF Sync] cliente ${config.cliente_id}:`, e.message);
          }
        }
      })();

      res.json({ ok: true, mensagem: 'Sincronização iniciada em background' });
    } catch (err) { next(err); }
  });

  // ── Status da última sincronização ───────────────────────────
  router.get('/sincronizar/status', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT cliente_id, COUNT(*) AS total, MAX(sincronizado_em) AS ultima_sync
        FROM confirmafacil_nfs_cache
        GROUP BY cliente_id
      `);
      res.json({ status: rows });
    } catch (err) { next(err); }
  });




  // ── Detalhes de uma OS com trilha + fotos ────────────────────
  router.get('/os-detalhes/:solicitacaoId', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { solicitacaoId } = req.params;

      // OS principal
      const { rows: [sc] } = await pool.query(`
        SELECT sc.*, cs.nome AS cliente_nome
        FROM solicitacoes_corrida sc
        LEFT JOIN clientes_solicitacao cs ON cs.id = sc.cliente_id
        WHERE sc.id = $1
      `, [solicitacaoId]);

      if (!sc) return res.status(404).json({ error: 'OS não encontrada' });

      // Pontos
      const { rows: pontos } = await pool.query(`
        SELECT * FROM solicitacoes_pontos WHERE solicitacao_id = $1 ORDER BY ordem
      `, [solicitacaoId]);

      // Vínculo CF + dados do cache
      const { rows: [vinculo] } = await pool.query(`
        SELECT v.*, c.data_emissao, c.data_previsao, c.status_cf,
               c.destinatario_nome, c.destinatario_cidade, c.destinatario_uf
        FROM confirmafacil_vinculos v
        LEFT JOIN confirmafacil_nfs_cache c
          ON c.id_embarque = v.id_embarque AND c.cliente_id = v.cliente_id
        WHERE v.solicitacao_id = $1
      `, [solicitacaoId]);

      // Trilha de eventos (log CF)
      const { rows: logs } = await pool.query(`
        SELECT id, numero_nf, status_tutts, cod_ocorrencia, sucesso, erro_msg,
               payload, resposta, criado_em
        FROM confirmafacil_log
        WHERE solicitacao_id = $1
        ORDER BY criado_em DESC
      `, [solicitacaoId]);

      // Extrair fotos e recebedor — verifica todos os logs (sucesso ou não)
      let fotos = [];
      let nomeRecebedor = null;
      let docRecebedor = null;

      for (const log of logs) {
        if (!log.payload) continue;
        try {
          const p = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
          // Fotos podem estar em p.fotos ou em p.itens[].ocorrencia.fotos
          if (!fotos.length && p.fotos?.length > 0) fotos = p.fotos;
          if (!nomeRecebedor && p.nomeRecebedor) nomeRecebedor = p.nomeRecebedor;
          if (!docRecebedor && p.docRecebedor)   docRecebedor  = p.docRecebedor;
          // Fallback: fotos dentro dos itens CF
          if (!fotos.length && Array.isArray(p.itens)) {
            for (const item of p.itens) {
              const f = item?.ocorrencia?.fotos;
              if (Array.isArray(f) && f.length > 0) { fotos = f; break; }
            }
          }
        } catch(_) {}
      }

      // Se não achou no log, tenta buscar nos detalhes da solicitação
      if (fotos.length === 0) {
        const { rows: pontosComFoto } = await pool.query(`
          SELECT foto_url FROM solicitacoes_pontos_fotos
          WHERE solicitacao_id = $1
          LIMIT 20
        `, [solicitacaoId]).catch(() => ({ rows: [] }));
        fotos = pontosComFoto.map(p => p.foto_url).filter(Boolean);
      }

      // Trilha formatada — filtra eventos internos sem relevância pro usuário
      const trilha = logs
        .filter(l => !(l.erro_msg === 'sem ponto com NF' && !l.sucesso))
        .filter(l => !(l.erro_msg === 'status nao mapeado' && !l.sucesso))
        .map(l => ({
          id:            l.id,
          numero_nf:     l.numero_nf,
          status_tutts:  l.status_tutts,
          cod_ocorrencia:l.cod_ocorrencia,
          sucesso:       l.sucesso,
          erro_msg:      l.erro_msg,
          criado_em:     l.criado_em,
        }));

      res.json({ sc, pontos, vinculo, trilha, fotos, nomeRecebedor, docRecebedor });
    } catch (err) { next(err); }
  });


  // ── Forçar ciclo do poller manualmente (debug) ───────────────
  router.post('/poller/ciclo', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { getConfirmaFacilPoller } = require('./index');
      const poller = getConfirmaFacilPoller(pool);
      console.log('[CF Poller] ciclo manual disparado via API');
      await poller._ciclo();
      res.json({ ok: true, mensagem: 'Ciclo executado — veja logs Railway' });
    } catch (err) {
      console.error('[CF Poller] erro ciclo manual:', err.message);
      res.json({ ok: false, erro: err.message });
    }
  });

  // ── Reprocessar notas barradas: limpa o backoff e dispara o ciclo na hora ──
  // As NFs que falharam (ex.: "Categoria nao informada") ficam em backoff. Este
  // endpoint zera o backoff e roda um ciclo imediatamente, entao tudo que estava
  // barrado e re-tentado agora (uteis depois de cadastrar a modalidade da filial).
  router.post('/reprocessar-barradas', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      let limpo = 0;
      try {
        const del = await pool.query('DELETE FROM confirmafacil_poller_retry');
        limpo = del.rowCount || 0;
      } catch (e) { /* tabela pode nao existir ainda — ignora */ }

      const { getConfirmaFacilPoller } = require('./index');
      const poller = getConfirmaFacilPoller(pool);
      console.log(`[CF Poller] reprocessamento manual: ${limpo} backoff(s) limpo(s) — disparando ciclo`);
      // fire-and-forget: o ciclo pagina varias paginas; nao travamos a resposta
      poller._ciclo().catch((e) => console.error('[CF Poller] erro no reprocesso:', e.message));

      res.json({ ok: true, backoff_limpo: limpo,
        mensagem: 'Backoff limpo e ciclo disparado — as notas barradas serao reprocessadas agora.' });
    } catch (err) { next(err); }
  });


  return router;
}

module.exports = { createConfirmaFacilRouter };
