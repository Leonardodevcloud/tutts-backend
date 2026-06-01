'use strict';

const express = require('express');
const { getConfirmaFacilAuth }   = require('./confirmafacil.auth');
const { getConfirmaFacilPoller } = require('./confirmafacil.poller');
const AppError = require('../../shared/errors/AppError');

function createConfirmaFacilRouter(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  const router = express.Router();
  const auth   = getConfirmaFacilAuth();

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
      const coleta_uf     = partes[4] || '';
      const coleta_cep    = partes[5] || '';

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
      const { nf, cliente_id } = req.body;

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
        SELECT e.centro_custo_mapp, e.coleta_lat, e.coleta_lng,
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
      const codMapeado = mapa[statusUsar];

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

  // ── Listagem combinada: CF API + vinculos ────────────────────
  // Busca NFs direto na API CF e cruza com vinculos do banco
  router.get('/nfs-lista', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { embarcador_cnpj, tem_corrida, de, ate, busca, page = '0', size = '50' } = req.query;

      const pg = Math.max(0, Number(page));
      const sz = Math.min(500, Math.max(1, Number(size)));

      // 1. Buscar todas as configs ativas
      const { rows: configs } = await pool.query(`
        SELECT cf.*, cs.nome AS cliente_nome
        FROM confirmafacil_config cf
        INNER JOIN clientes_solicitacao cs ON cs.id = cf.cliente_id
        WHERE cf.ativo = TRUE
      `);

      if (configs.length === 0) {
        return res.json({ nfs: [], total: 0, page: pg, size: sz, mensagem: 'Nenhum cliente CF configurado' });
      }

      const httpRequest = require('../../shared/utils/httpRequest');
      const agora = new Date();

      // Definir período
      const inicio = de ? new Date(de) : new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fim    = ate ? new Date(ate) : agora;

      const fmtCF = d => {
        const p = n => String(n).padStart(2,'0');
        return d.getFullYear()+'/'+p(d.getMonth()+1)+'/'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())
      };

      // 2. Buscar NFs em todas as configs
      let todasNfs = [];
      for (const config of configs) {
        try {
          const cfAuth = getConfirmaFacilAuth();
          const token = await cfAuth.obterToken(config.cliente_id, config);
          let pg2 = 0;
          while (true) {
            const filtro = { page: pg2, size: 100, de: fmtCF(inicio), ate: fmtCF(fim),
                             cnpjTransportadora: [config.cnpj_transportadora] };
            const params = new URLSearchParams({ filtroDTO: JSON.stringify(filtro) });
            const resp = await httpRequest(
              'https://utilities.confirmafacil.com.br/filter/embarque?' + params,
              { method: 'GET', headers: { Authorization: token, accept: 'application/json' } }
            );
            const data = resp.json();
            const nfs = data.respostas || data.content || [];
            nfs.forEach(nf => { nf._cliente_id = config.cliente_id; nf._cliente_nome = config.cliente_nome; });
            todasNfs = todasNfs.concat(nfs);
            if (nfs.length < 100) break;
            pg2++;
          }
        } catch(e) {
          console.warn('[CF nfs-lista] erro config', config.cliente_id, e.message);
        }
      }

      // 3. Buscar todos os vinculos existentes
      const idsEmbarque = todasNfs.map(n => n.idEmbarque || n.id).filter(Boolean);
      let vinculos = [];
      if (idsEmbarque.length > 0) {
        const { rows: v } = await pool.query(`
          SELECT v.*, sc.tutts_os_numero, sc.status AS status_corrida,
                 cl.sucesso AS ultimo_cf_sucesso,
                 cl.cod_ocorrencia AS ultimo_cod_cf
          FROM confirmafacil_vinculos v
          LEFT JOIN solicitacoes_corrida sc ON sc.id = v.solicitacao_id
          LEFT JOIN LATERAL (
            SELECT cod_ocorrencia, sucesso FROM confirmafacil_log
            WHERE solicitacao_id = v.solicitacao_id
            ORDER BY criado_em DESC LIMIT 1
          ) cl ON TRUE
          WHERE v.id_embarque = ANY($1)
        `, [idsEmbarque]);
        vinculos = v;
      }
      const vinculoMap = {};
      vinculos.forEach(v => { vinculoMap[String(v.id_embarque)] = v; });

      // 4. Buscar embarcadores para nomes
      const { rows: embs } = await pool.query(`
        SELECT e.*, c.cliente_id FROM confirmafacil_embarcadores e
        INNER JOIN confirmafacil_config c ON c.id = e.config_id WHERE e.ativo = TRUE
      `);
      const embMap = {};
      embs.forEach(e => {
        const cnpjLimpo = (e.cnpj_embarcador||'').replace(/[^0-9]/g,'');
        embMap[cnpjLimpo] = e;
      });

      // 5. Montar resultado combinado
      let resultado = todasNfs.map(nf => {
        const id = String(nf.idEmbarque || nf.id || '');
        const vinc = vinculoMap[id] || null;
        const cnpjEmb = (nf.embarcador?.cnpj||'').replace(/[^0-9]/g,'');
        const emb = embMap[cnpjEmb] || null;
        return {
          id_embarque:       nf.idEmbarque || nf.id,
          numero_nf:         nf.numero,
          serie_nf:          nf.serie,
          cnpj_embarcador:   nf.embarcador?.cnpj || '',
          nome_embarcador:   nf.embarcador?.nome || emb?.nome_embarcador || '',
          cliente_id:        nf._cliente_id,
          cliente_nome:      nf._cliente_nome,
          destinatario_nome: nf.destinatario?.nome || '',
          destinatario_cidade: nf.destinatario?.endereco?.cidade || nf.endereco?.cidade || '',
          destinatario_uf:   nf.destinatario?.endereco?.uf || nf.endereco?.uf || '',
          status_cf:         nf.statusEmbarque?.nome || 'DESCONHECIDO',
          status_nota:       nf.statusNota || '',
          dias_atraso:       nf.diasAtraso || 0,
          data_previsao:     nf.dataPrevisao || null,
          valor:             nf.valor || null,
          centro_custo_mapp: emb?.centro_custo_mapp || null,
          // Dados do vínculo (se já criou corrida)
          solicitacao_id:    vinc?.solicitacao_id || null,
          tutts_os_numero:   vinc?.tutts_os_numero || null,
          status_corrida:    vinc?.status_corrida || null,
          ultimo_cf_sucesso: vinc?.ultimo_cf_sucesso || false,
          ultimo_cod_cf:     vinc?.ultimo_cod_cf || null,
          vinculado_em:      vinc?.criado_em || null,
          link_rastreamento: nf.linkExterno || null,
        };
      });

      // 6. Aplicar filtros locais
      if (embarcador_cnpj) {
        const cnpjBusca = embarcador_cnpj.replace(/[^0-9]/g,'');
        resultado = resultado.filter(n => (n.cnpj_embarcador||'').replace(/[^0-9]/g,'') === cnpjBusca);
      }
      if (tem_corrida === 'sim') resultado = resultado.filter(n => n.solicitacao_id);
      if (tem_corrida === 'nao') resultado = resultado.filter(n => !n.solicitacao_id);
      if (busca) {
        const b = busca.toLowerCase();
        resultado = resultado.filter(n =>
          (n.numero_nf||'').toLowerCase().includes(b) ||
          (n.destinatario_nome||'').toLowerCase().includes(b) ||
          (n.tutts_os_numero||'').toLowerCase().includes(b) ||
          (n.nome_embarcador||'').toLowerCase().includes(b)
        );
      }

      const total = resultado.length;
      const paginado = resultado.slice(pg * sz, (pg + 1) * sz);

      res.json({ nfs: paginado, total, page: pg, size: sz });
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

      // Vínculo CF
      const { rows: [vinculo] } = await pool.query(`
        SELECT * FROM confirmafacil_vinculos WHERE solicitacao_id = $1
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

      // Trilha formatada
      const trilha = logs.map(l => ({
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


  return router;
}

module.exports = { createConfirmaFacilRouter };
