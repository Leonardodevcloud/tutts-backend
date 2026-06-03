'use strict';

/**
 * MÓDULO CONFIRMAFÁCIL — Service principal
 *
 * Ponto de entrada chamado pelo webhook da Mapp (server.js).
 * Recebe o evento de status, monta o payload e envia pro CF.
 *
 * Fluxo interno:
 *  1. Busca configuração CF do cliente da corrida
 *  2. Se não tiver CF ativo, sai silenciosamente
 *  3. Resolve código de ocorrência pelo status atual
 *  4. Se código null (não deve reportar), sai
 *  5. Busca NFs dos pontos da corrida (solicitacoes_pontos)
 *  6. Monta array de CamposEmbarqueDTO (um por ponto/NF)
 *  7. Obtém token CF (auth com cache diário)
 *  8. Envia via client
 *  9. Loga resultado em confirmafacil_log
 *
 * Nunca lança exceção — erros são logados e engolidos
 * para não derrubar o webhook principal.
 */

const { getConfirmaFacilAuth }   = require('./confirmafacil.auth');
const { getConfirmaFacilClient } = require('./confirmafacil.client');
const { resolverCodigo, formatarData, formatarHora } = require('./confirmafacil.map');

class ConfirmaFacilService {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool   = pool;
    this.auth   = getConfirmaFacilAuth();
    this.client = getConfirmaFacilClient();
  }

  // ══════════════════════════════════════════════════════
  // PONTO DE ENTRADA — chamado pelo webhook Tutts
  // ══════════════════════════════════════════════════════

  /**
   * Processa um evento de status e reporta ao CF se necessário.
   *
   * @param {{
   *   solicitacaoId: number,
   *   osNumero: string|number,
   *   novoStatus: string,
   *   pontoNumero?: number,
   *   pontoStatus?: string,
   *   lat?: string,
   *   lng?: string,
   *   fotos?: string[],
   *   nomeRecebedor?: string,
   *   docRecebedor?: string,
   * }} evento
   */
  async processar(evento) {
    try {
      await this._processar(evento);
    } catch (err) {
      // Nunca deixa o erro vazar pro webhook principal
      console.error('❌ [CF Service] erro não tratado:', err.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // ENVIO DE GEOLOCALIZAÇÃO — chamado quando tiver GPS
  // ══════════════════════════════════════════════════════

  /**
   * Envia GPS do motoboy para o CF.
   * @param {{
   *   solicitacaoId: number,
   *   placa: string,
   *   lat: string|number,
   *   lng: string|number,
   * }} dados
   */
  async enviarGps(dados) {
    try {
      await this._enviarGps(dados);
    } catch (err) {
      console.error('❌ [CF Service] erro GPS:', err.message);
    }
  }

  // ══════════════════════════════════════════════════════
  // IMPLEMENTAÇÃO PRIVADA
  // ══════════════════════════════════════════════════════

  async _processar(evento) {
    const { solicitacaoId, osNumero, novoStatus, pontoNumero, pontoStatus, lat, lng, fotos, nomeRecebedor, docRecebedor } = evento;

    console.log(`🔍 [CF Service] _processar OS=${osNumero} solicitacaoId=${solicitacaoId} pontoNumero=${pontoNumero} pontoStatus=${pontoStatus} novoStatus=${novoStatus} fotos=${fotos?.length||0}`);

    // 1. Config do cliente
    const config = await this._buscarConfig(solicitacaoId);
    if (!config) return; // CF não habilitado para este cliente

    // 2. Determinar status a reportar
    // Prioridade: status do ponto (mais específico) > status da corrida
    const statusParaMapear = pontoStatus || novoStatus;

    // Se o status é 'finalizado' (OS encerrada), verificar se houve insucesso anterior
    // Se sim, não enviar Cod.1 (entregue) — a OS foi encerrada sem entrega real
    if (novoStatus === 'finalizado' && !pontoStatus) {
      const { rows: logInsucesso } = await this.pool.query(`
        SELECT id FROM confirmafacil_log
        WHERE solicitacao_id = $1
          AND status_tutts IN ('ausente','fechado','recusou','nao_entregue')
          AND sucesso = TRUE
        LIMIT 1
      `, [solicitacaoId]);
      if (logInsucesso.length > 0) {
        console.log(`[CF Service] OS ${osNumero} finalizada mas teve insucesso anterior — ignorando Cod.1`);
        return;
      }
    }

    const codOcorrencia = resolverCodigo(statusParaMapear, config.mapa_ocorrencias);

    if (!codOcorrencia) {
      console.log(`[CF Service] status '${statusParaMapear}' não mapeado — ignorando corrida ${osNumero}`);
      // Mesmo sem código mapeado, salva log com fotos recebidas para consulta posterior
      if (fotos?.length > 0 || nomeRecebedor) {
        try {
          const config2 = await this._buscarConfig(solicitacaoId);
          if (config2) {
            await this.pool.query(`
              INSERT INTO confirmafacil_log
                (solicitacao_id, cliente_id, os_numero, status_tutts,
                 tipo, payload, sucesso, erro_msg)
              VALUES ($1,$2,$3,$4,'webhook',$5,FALSE,'status nao mapeado')
            `, [solicitacaoId, config2.cliente_id, osNumero, statusParaMapear,
                JSON.stringify({ fotos, nomeRecebedor, docRecebedor })]);
          }
        } catch(_) {}
      }
      return;
    }

    // 3. Buscar NFs dos pontos
    // Ponto 1 = coleta: se finalizado_ponto, ignora (motoboy coletou, não entregou)
    if (pontoNumero === 1 && pontoStatus === 'finalizado_ponto') {
      console.log(`[CF Service] OS ${osNumero} ponto 1 finalizado (coleta) — aguardando entrega, sem notificação CF`);
      return;
    }
    // Se pontoNumero = 1 com outro status (ausente, fechado etc) ou sem número, busca todos
    const pontoParaBuscar = (!pontoNumero || pontoNumero === 1) ? null : pontoNumero;
    const pontos = await this._buscarPontos(solicitacaoId, pontoParaBuscar);
    if (pontos.length === 0) {
      console.warn(`⚠️ [CF Service] corrida ${osNumero} sem pontos com NF — nada a enviar (pontoNumero=${pontoNumero})`);
      // Salvar fotos mesmo sem NF mapeada
      if (fotos?.length > 0 || nomeRecebedor) {
        try {
          if (config) await this.pool.query(`
            INSERT INTO confirmafacil_log (solicitacao_id, cliente_id, os_numero, status_tutts,
              tipo, payload, sucesso, erro_msg)
            VALUES ($1,$2,$3,$4,'webhook',$5,FALSE,'sem ponto com NF')
          `, [solicitacaoId, config.cliente_id, osNumero, novoStatus,
              JSON.stringify({ fotos, nomeRecebedor, docRecebedor })]);
        } catch(_) {}
      }
      return;
    }

    // 4. Montar payload (array de CamposEmbarqueDTO)
    const agora = new Date();
    const itens = pontos.map(p => this._montarItem({
      ponto:          p,
      config,
      codOcorrencia,
      agora,
      lat,
      lng,
      fotos:          fotos || [],
      nomeRecebedor,
      docRecebedor,
    }));

    // 5. Obter token
    const token = await this.auth.obterToken(config.cliente_id, config);

    // 6. Enviar
    console.log(`📤 [CF Service] enviando ${itens.length} item(s) para OS ${osNumero} | ocorrência ${codOcorrencia}`);
    console.log(`📦 [CF Service] payload:`, JSON.stringify(itens, null, 2).substring(0, 1000));
    const resultados = await this.client.enviarEmbarque(token, itens);
    console.log(`📥 [CF Service] resposta:`, JSON.stringify(resultados));

    // 7. Logar
    await this._logar({
      solicitacaoId,
      clienteId: config.cliente_id,
      osNumero,
      pontos,
      statusTutts: statusParaMapear,
      codOcorrencia,
      payload: itens,
      resultados,
      fotos,
      nomeRecebedor,
      docRecebedor,
    });
  }

  async _enviarGps(dados) {
    const { solicitacaoId, placa, lat, lng } = dados;

    const config = await this._buscarConfig(solicitacaoId);
    if (!config) return;

    const pontos = await this._buscarPontos(solicitacaoId, null);
    if (pontos.length === 0) return;

    const agora = new Date();
    const payload = {
      placa:          placa || 'SEM-PLACA',
      latitude:       String(lat),
      longitude:      String(lng),
      dataFormatada:  `${formatarData(agora)} ${agora.toLocaleTimeString('pt-BR')}`,
      notas:          pontos
        .filter(p => p.numero_nota)
        .map(p => ({
          numero:         p.numero_nota,
          serie:          p.serie_nota || '1',
          cnpjEmbarcador: config.cnpj_embarcador || '',
        })),
    };

    if (payload.notas.length === 0) return;

    const token = await this.auth.obterToken(config.cliente_id, config);
    const resultado = await this.client.enviarLocalizacao(token, payload);

    // Log leve de GPS (não vai pra confirmafacil_log pra não inflar)
    if (!resultado.ok) {
      console.warn(`⚠️ [CF Service] GPS falhou para corrida ${solicitacaoId}:`, resultado.erro || resultado.status);
    }
  }

  // ══════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════

  /**
   * Busca configuração CF ativa para o cliente da corrida.
   * @returns {Object|null}
   */
  async _buscarConfig(solicitacaoId) {
    const { rows } = await this.pool.query(`
      SELECT
        cf.id,
        cf.cliente_id,
        cf.cf_email,
        cf.cf_senha,
        cf.cf_id_cliente,
        cf.cnpj_transportadora,
        cf.mapa_ocorrencias,
        -- Pega cnpj_embarcador do vínculo
        COALESCE(v.cnpj_embarcador, '') AS cnpj_embarcador
      FROM confirmafacil_config cf
      INNER JOIN solicitacoes_corrida sc ON sc.cliente_id = cf.cliente_id
      LEFT JOIN confirmafacil_vinculos v ON v.solicitacao_id = sc.id
      WHERE sc.id = $1
        AND cf.ativo = TRUE
      LIMIT 1
    `, [solicitacaoId]);

    return rows[0] || null;
  }

  /**
   * Busca pontos da corrida que têm número de NF.
   * Se pontoNumero informado, retorna só aquele ponto.
   * Ponto 1 (coleta) é excluído — não tem NF de destinatário.
   */
  async _buscarPontos(solicitacaoId, pontoNumero) {
    const params = [solicitacaoId];
    let filtro = 'sp.solicitacao_id = $1 AND sp.ordem > 1 AND sp.numero_nota IS NOT NULL';

    if (pontoNumero) {
      filtro += ' AND sp.ordem = $2';
      params.push(pontoNumero);
    }

    const { rows } = await this.pool.query(`
      SELECT
        sp.id,
        sp.ordem,
        sp.numero_nota,
        sp.nome_fantasia,
        sp.razao_social,
        sp.rua,
        sp.numero,
        sp.bairro,
        sp.cidade,
        sp.uf,
        sp.cep,
        sp.latitude,
        sp.longitude,
        sp.status,
        -- Pega serie e cnpj_embarcador do vínculo CF
        v.serie_nf,
        v.cnpj_embarcador AS cnpj_embarcador_nf
      FROM solicitacoes_pontos sp
      LEFT JOIN confirmafacil_vinculos v ON v.solicitacao_id = sp.solicitacao_id
        AND v.numero_nf = sp.numero_nota
      WHERE ${filtro}
      ORDER BY sp.ordem
    `, params);

    return rows;
  }

  /**
   * Monta um CamposEmbarqueDTO para envio ao CF.
   */
  _montarItem({ ponto, config, codOcorrencia, agora, lat, lng, fotos, nomeRecebedor, docRecebedor }) {
    // cnpj_embarcador: prioriza o que veio do vínculo CF (mais preciso)
    const cnpjEmb = ponto.cnpj_embarcador_nf || config.cnpj_embarcador || '';
    // Remover formatação para enviar só dígitos (padrão CF)
    const cnpjEmbLimpo = cnpjEmb.replace(/[^0-9]/g, '');

    const item = {
      embarque: {
        numero: ponto.numero_nota,
        serie:  ponto.serie_nf || ponto.serie_nota || '1',
      },
      embarcador: {
        cnpj: cnpjEmbLimpo || cnpjEmb,
      },
      transportadora: {
        cnpj: config.cnpj_transportadora,
      },
      trecho: {
        ordem: '1',
      },
      ocorrencia: {
        tipoEntrega:       codOcorrencia,
        dtOcorrencia:      formatarData(agora),
        hrOcorrencia:      formatarHora(agora),
        comentario:        `Atualização automática via Central Tutts`,
        latitude:          lat ? String(lat) : undefined,
        longitude:         lng ? String(lng) : undefined,
        fotos:             fotos?.length > 0 ? fotos : undefined,
        nomeRecebedor:     nomeRecebedor || undefined,
        documentoRecebedor: docRecebedor || undefined,
      },
    };

    // Destinatário: usa dados do ponto se disponíveis
    const nomeDest = ponto.nome_fantasia || ponto.razao_social;
    if (nomeDest) {
      item.destinatario = { nome: nomeDest };
      if (ponto.uf && ponto.cidade) {
        item.destinatario.endereco = {
          uf:          ponto.uf,
          cidade:      ponto.cidade,
          logradouro:  ponto.rua || undefined,
          numero:      ponto.numero || undefined,
          cep:         ponto.cep || undefined,
          latitude:    ponto.latitude ? String(ponto.latitude) : undefined,
          longitude:   ponto.longitude ? String(ponto.longitude) : undefined,
        };
      }
    }

    // Limpa undefined recursivamente (CF rejeita campos null/undefined)
    return JSON.parse(JSON.stringify(item));
  }

  /**
   * Persiste resultado em confirmafacil_log (não bloqueante).
   */
  async _logar({ solicitacaoId, clienteId, osNumero, pontos, statusTutts, codOcorrencia, payload, resultados, fotos, nomeRecebedor, docRecebedor }) {
    const sucesso = resultados.every(r => r.ok);
    const erros   = resultados.filter(r => !r.ok).map(r => r.erro || `HTTP ${r.status}`).join('; ');

    for (const ponto of pontos) {
      try {
        await this.pool.query(`
          INSERT INTO confirmafacil_log
            (solicitacao_id, cliente_id, os_numero, numero_nf, status_tutts,
             cod_ocorrencia, tipo, payload, resposta, sucesso, erro_msg)
          VALUES ($1, $2, $3, $4, $5, $6, 'ocorrencia', $7, $8, $9, $10)
        `, [
          solicitacaoId,
          clienteId,
          osNumero,
          ponto.numero_nota,
          statusTutts,
          codOcorrencia,
          JSON.stringify({ itens: payload, fotos, nomeRecebedor, docRecebedor }),
          JSON.stringify(resultados.map(r => r.body)),
          sucesso,
          erros || null,
        ]);
      } catch (logErr) {
        console.error('⚠️ [CF Service] erro ao logar:', logErr.message);
      }
    }

    if (sucesso) {
      console.log(`✅ [CF Service] ${pontos.length} NF(s) reportadas com ocorrência ${codOcorrencia}`);
    } else {
      console.warn(`⚠️ [CF Service] falha parcial/total: ${erros}`);
    }
  }
}

// Singleton por pool
const _instancias = new Map();
function getConfirmaFacilService(pool) {
  if (!_instancias.has(pool)) {
    _instancias.set(pool, new ConfirmaFacilService(pool));
  }
  return _instancias.get(pool);
}

module.exports = { getConfirmaFacilService };
