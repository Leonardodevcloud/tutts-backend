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
              coleta_rua, coleta_numero, coleta_bairro,
              coleta_cidade, coleta_uf, coleta_cep,
              coleta_lat, coleta_lng, coleta_nome_fantasia, coleta_telefone } = req.body;

      if (!cliente_id || !cnpj_embarcador || !coleta_cidade || !coleta_uf)
        throw new AppError('cliente_id, cnpj_embarcador, coleta_cidade e coleta_uf são obrigatórios', 400);

      // Buscar config_id
      const { rows: cfg } = await pool.query(
        'SELECT id FROM confirmafacil_config WHERE cliente_id = $1', [cliente_id]);
      if (!cfg[0]) throw new AppError('Config CF não encontrada para este cliente', 404);

      const { rows } = await pool.query(`
        INSERT INTO confirmafacil_embarcadores
          (config_id, cnpj_embarcador, nome_embarcador,
           coleta_rua, coleta_numero, coleta_bairro,
           coleta_cidade, coleta_uf, coleta_cep,
           coleta_lat, coleta_lng, coleta_nome_fantasia, coleta_telefone)
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
          coleta_telefone     = EXCLUDED.coleta_telefone
        RETURNING *
      `, [cfg[0].id, cnpj_embarcador, nome_embarcador,
          coleta_rua, coleta_numero, coleta_bairro,
          coleta_cidade, coleta_uf, coleta_cep,
          coleta_lat || null, coleta_lng || null,
          coleta_nome_fantasia, coleta_telefone]);

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

      const pontos = [
        // Coleta
        {
          rua:    embEnd.logradouro || '',
          numero: embEnd.numero || '',
          bairro: '',
          cidade: embEnd.cidade || '',
          uf:     embEnd.uf || '',
          cep:    embEnd.cep || '',
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

      const payloadTutts = {
        token:          cliente.tutts_token_api,
        codCliente:     cliente.tutts_codigo_cliente,
        Usuario:        'ConfirmaFácil',
        centroCusto:    cliente.centro_custo_padrao || cliente.nome || 'Central',
        pontos:         pontos.map(p => {
          const obj = { rua: p.rua, numero: p.numero, bairro: p.bairro,
                        cidade: p.cidade, uf: p.uf, obs: p.obs };
          if (p.cep) obj.cep = p.cep;
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
        cliente.centro_custo_padrao || cliente.nome || 'Central',
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

    } catch (err) { next(err); }
  });

  // ── Testar envio de ocorrência para o CF ──────────────────────
  // Simula o que o webhook faz: envia uma ocorrência para uma OS já criada.
  // Use para verificar se o CF está recebendo corretamente.
  router.post('/testar-ocorrencia', verificarToken, verificarAdmin, async (req, res, next) => {
    try {
      const { solicitacao_id, status, codigo_ocorrencia } = req.body;
      if (!solicitacao_id) throw new AppError('solicitacao_id é obrigatório', 400);

      const { getConfirmaFacilService } = require('./confirmafacil.service');
      const cfService = getConfirmaFacilService(pool);

      // Buscar OS
      const { rows: [solic] } = await pool.query(
        'SELECT * FROM solicitacoes_corrida WHERE id = $1', [solicitacao_id]
      );
      if (!solic) throw new AppError('Solicitação não encontrada', 404);

      // Se informou código direto, injeta no mapa temporariamente
      const statusUsar = status || 'finalizado_ponto';

      // Processar
      await cfService.processar({
        solicitacaoId: solicitacao_id,
        osNumero:      solic.tutts_os_numero,
        novoStatus:    statusUsar,
        pontoStatus:   statusUsar,
      });

      // Buscar último log
      const { rows: logs } = await pool.query(`
        SELECT id, numero_nf, cod_ocorrencia, sucesso, erro_msg, resposta, criado_em
        FROM confirmafacil_log
        WHERE solicitacao_id = $1
        ORDER BY criado_em DESC
        LIMIT 5
      `, [solicitacao_id]);

      res.json({
        ok:      true,
        mensagem: 'Ocorrência processada — veja o log abaixo',
        os_numero: solic.tutts_os_numero,
        status_usado: statusUsar,
        logs,
      });
    } catch (err) { next(err); }
  });


  return router;
}

module.exports = { createConfirmaFacilRouter };
