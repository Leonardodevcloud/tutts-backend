/**
 * MÓDULO UBER - Sistema de Integração com Uber Direct
 * 34+ endpoints, 6 tabelas, 1 worker polling
 * 
 * Orquestra entregas entre Mapp (Tutts) e Uber Direct:
 * - Polling automático de serviços abertos na Mapp
 * - Despacho pra Uber Direct (cotação + criação)
 * - Recebimento de webhooks (status + tracking a cada 20s)
 * - Sincronização bidirecional de status Mapp ↔ Uber
 * - Fallback: se Uber falha, reabre na Mapp pra fila interna
 */

const { initUberTables } = require('./uber.migration');
const { createUberRouter } = require('./uber.routes');
const {
  obterConfig, mappListarServicos, despacharParaUber, verificarTimeouts,
  uberCriarCotacao, mappAlterarStatus,
} = require('./uber.service');

function initUberRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  return createUberRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

/**
 * Worker de polling: roda a cada N segundos (configurável)
 * 1. Busca serviços abertos na Mapp (status 0)
 * 2. Aplica regras de decisão (OPT-IN ESTRITO — só despacha clientes cadastrados)
 * 3. Despacha pro Uber Direct
 * 4. Verifica timeouts (entregador não encontrado)
 *
 * Usa setTimeout recursivo (não setInterval) para que mudanças no
 * polling_intervalo_seg da config peguem em runtime sem precisar restart.
 *
 * 🔒 SEGURANÇA (redesign 2026-04-14):
 *   - ultimoId é PERSISTIDO em uber_config.worker_ultimo_id pra não retroagir
 *     em restart do worker (bug anterior: começava em 0 e pegava lixo histórico)
 *   - OS com dataHora mais antiga que worker_janela_minutos é IGNORADA
 *   - verificarRegras é OPT-IN ESTRITO: sem regra casando = NÃO despacha
 *   - Pré-validação de região ANTES de chamar mappAlterarStatus(1),
 *     pra não travar OS na Mapp em cidade fora da cobertura Uber
 */
function startUberWorker(pool) {
  let ultimoId = 0;
  let ultimoIdCarregado = false;
  let timeoutRef = null;
  let rodando = false;
  let parado = false;

  async function carregarUltimoId() {
    try {
      const { rows } = await pool.query('SELECT worker_ultimo_id FROM uber_config WHERE id = 1');
      ultimoId = parseInt(rows[0]?.worker_ultimo_id || 0, 10);
      ultimoIdCarregado = true;
      console.log(`🔖 [Uber Worker] Checkpoint carregado: ultimoId=${ultimoId}`);
    } catch (err) {
      console.error('❌ [Uber Worker] Erro ao carregar checkpoint:', err.message);
      ultimoId = 0;
    }
  }

  async function salvarUltimoId() {
    try {
      await pool.query('UPDATE uber_config SET worker_ultimo_id = $1 WHERE id = 1', [ultimoId]);
    } catch (err) {
      console.error('❌ [Uber Worker] Erro ao salvar checkpoint:', err.message);
    }
  }

  /**
   * Filtra serviços que ainda estão dentro da janela temporal aceitável.
   * Descartar OS antigas é crucial pra não pegar lixo histórico (OS que ficaram
   * abandonadas com status 0 na Mapp há semanas/meses).
   */
  function dentroDaJanela(servico, janelaMinutos) {
    if (!servico?.dataHora) return false;  // sem data, rejeita por segurança
    const dataOS = new Date(servico.dataHora.replace(' ', 'T'));  // "2026-04-14 14:30:00" → Date
    if (isNaN(dataOS.getTime())) return false;
    const idadeMin = (Date.now() - dataOS.getTime()) / 60000;
    return idadeMin >= 0 && idadeMin <= janelaMinutos;
  }

  async function executarCiclo() {
    if (rodando || parado) return;
    rodando = true;

    let intervaloProximo = 30; // default

    try {
      const config = await obterConfig(pool);
      intervaloProximo = config?.polling_intervalo_seg || 30;

      if (!config || !config.ativo) {
        rodando = false;
        agendarProximo(intervaloProximo);
        return;
      }

      if (!config.auto_despacho) {
        // Só verificar timeouts quando auto_despacho está desligado
        await verificarTimeouts(pool);
        rodando = false;
        agendarProximo(intervaloProximo);
        return;
      }

      // Carregar checkpoint persistido na primeira execução
      if (!ultimoIdCarregado) {
        await carregarUltimoId();
      }

      const janelaMin = config.worker_janela_minutos || 30;

      // 1. Buscar serviços abertos
      const servicos = await mappListarServicos(pool, 0, ultimoId);

      if (servicos.length > 0) {
        console.log(`🔍 [Uber Worker] ${servicos.length} serviço(s) retornado(s) da Mapp (ultimoId=${ultimoId}, janela=${janelaMin}min)`);

        let maiorIdProcessado = ultimoId;
        let despachadas = 0, puladas_janela = 0, puladas_regra = 0, puladas_regiao = 0;

        for (const servico of servicos) {
          try {
            // Sempre atualiza o ponteiro pro maior id visto, mesmo se a OS for rejeitada
            // (assim não voltamos a processar as mesmas OS em ciclos seguintes)
            if (servico.codigoOS > maiorIdProcessado) {
              maiorIdProcessado = servico.codigoOS;
            }

            // 🔒 Filtro 1: Janela temporal — descarta OS antigas
            if (!dentroDaJanela(servico, janelaMin)) {
              puladas_janela++;
              continue;
            }

            // 🔒 Filtro 2: Regras de cliente (opt-in estrito)
            const decisao = await verificarRegras(pool, servico);
            if (!decisao.despachar) {
              if (decisao.motivo === 'regiao') puladas_regiao++;
              else puladas_regra++;
              continue;
            }

            // 🔒 Filtro 3: Margem mínima da regra (Opção C)
            // Cota a Uber ANTES de criar a delivery e valida margem absoluta + percentual.
            // Se rejeitar, libera a OS na Mapp pros motoboys internos pegarem.
            const regra = decisao.regra;
            const exigeMargemAbs = regra.margem_minima_aceita != null;
            const exigeMargemPct = regra.margem_pct_minima != null;

            if (exigeMargemAbs || exigeMargemPct) {
              const enderecos = servico.endereco || [];
              const coleta = enderecos[0];
              const entrega = enderecos[enderecos.length - 1];

              let cotacaoPreview;
              try {
                cotacaoPreview = await uberCriarCotacao(pool, {
                  endereco: coleta.rua,
                  latitude: coleta.latitude,
                  longitude: coleta.longitude,
                }, {
                  endereco: entrega.rua,
                  latitude: entrega.latitude,
                  longitude: entrega.longitude,
                });
              } catch (errCotacao) {
                console.warn(`⚠️ [Uber Worker] OS ${servico.codigoOS}: cotação falhou (${errCotacao.message}) — pulando, mantém na Mapp`);
                puladas_regra++;
                continue;
              }

              const valorCliente = parseFloat(servico.valorServico) || 0;
              const valorUber = parseFloat(cotacaoPreview.valor) || 0;
              const margem = valorCliente - valorUber;
              const margem_pct = valorCliente > 0 ? (margem / valorCliente) * 100 : 0;

              const margemAbsMin = parseFloat(regra.margem_minima_aceita);
              const margemPctMin = parseFloat(regra.margem_pct_minima);

              if (exigeMargemAbs && margem < margemAbsMin) {
                console.log(`💸 [Uber Worker] OS ${servico.codigoOS} REJEITADA por margem absoluta — cliente=R$${valorCliente.toFixed(2)} uber=R$${valorUber.toFixed(2)} margem=R$${margem.toFixed(2)} (mínimo=R$${margemAbsMin.toFixed(2)}) regra="${regra.cliente_nome}"`);
                puladas_regra++;
                continue;
              }
              if (exigeMargemPct && margem_pct < margemPctMin) {
                console.log(`💸 [Uber Worker] OS ${servico.codigoOS} REJEITADA por margem percentual — ${margem_pct.toFixed(1)}% (mínimo=${margemPctMin}%) regra="${regra.cliente_nome}"`);
                puladas_regra++;
                continue;
              }

              console.log(`✅ [Uber Worker] OS ${servico.codigoOS} aprovada na validação de margem — margem=R$${margem.toFixed(2)} (${margem_pct.toFixed(1)}%)`);

              // Despacha REUSANDO a quote já cotada (não cota 2x)
              await despacharParaUber(pool, servico, {
                regraId: regra.id,
                quotePreCotada: cotacaoPreview,
              });
              despachadas++;
              continue;
            }

            // Sem filtro de margem na regra: despacho normal (cotação dentro do despachar)
            await despacharParaUber(pool, servico, { regraId: regra.id });
            despachadas++;

          } catch (err) {
            console.error(`❌ [Uber Worker] Erro processando OS ${servico.codigoOS}:`, err.message);
          }
        }

        // Persiste o checkpoint atualizado
        if (maiorIdProcessado > ultimoId) {
          ultimoId = maiorIdProcessado;
          await salvarUltimoId();
        }

        if (despachadas > 0 || puladas_janela > 0 || puladas_regra > 0 || puladas_regiao > 0) {
          console.log(`📊 [Uber Worker] Ciclo: ${despachadas} despachada(s), ${puladas_janela} fora da janela, ${puladas_regra} sem regra casando, ${puladas_regiao} fora da região`);
        }
      }

      // 4. Verificar timeouts
      await verificarTimeouts(pool);

    } catch (error) {
      console.error('❌ [Uber Worker] Erro no ciclo:', error.message);
    }

    rodando = false;
    agendarProximo(intervaloProximo);
  }

  function agendarProximo(seg) {
    if (parado) return;
    timeoutRef = setTimeout(executarCiclo, seg * 1000);
  }

  /**
   * verificarRegras — OPT-IN ESTRITO POR ENDEREÇO DE COLETA
   *
   * IMPORTANTE: A API "Integração App Externos" da Mapp NÃO retorna identificação
   * de cliente em nenhum campo (`endereco[].nome` vem sempre vazio, não há
   * `cliente_nome` no payload). Por isso o match é feito contra o ENDEREÇO da
   * coleta — cada cliente real tem endereços fixos e únicos, então um trecho
   * distintivo do endereço (ex: "rua pernambuco, 1500") identifica o cliente
   * com segurança.
   *
   * Como cadastrar a regra:
   *   - Campo `cliente_nome` da regra deve conter um TRECHO ÚNICO do endereço
   *     de coleta do cliente, em lowercase, com pelo menos 5 caracteres.
   *   - Exemplos: "pernambuco, 1500", "av paralela 9000", "shopping prêmio".
   *   - Quanto mais específico, melhor (evita falso-positivo com outros clientes
   *     do mesmo bairro/avenida).
   *
   * Retorna { despachar: boolean, motivo: string }:
   *   - despachar=true SE e SOMENTE SE:
   *     a) Existe pelo menos uma regra ativa em uber_regras_cliente
   *     b) O trecho da regra (cliente_nome) é encontrado em endereco[0].rua
   *     c) A regra tem usar_uber = true
   *     d) A OS cumpre horário, valor min/max (se definidos)
   *     e) O endereço de coleta OU entrega casa com pelo menos uma das regiões
   *        listadas em regioes_permitidas (se definidas)
   *
   *   - despachar=false em qualquer outro caso (SEM FALLBACK PERMISSIVO)
   */
  async function verificarRegras(pool, servico) {
    const { rows: regras } = await pool.query(
      'SELECT * FROM uber_regras_cliente WHERE ativo = true AND usar_uber = true'
    );

    // 🔒 Sem regras cadastradas = não despacha NADA
    if (regras.length === 0) {
      return { despachar: false, motivo: 'sem_regras_cadastradas' };
    }

    // ⚠ Match é feito contra o ENDEREÇO de coleta (rua), não contra o nome
    // — a Mapp não preenche endereco[].nome, então usamos rua que é o único
    // campo distintivo que vem confiável.
    const enderecoColeta = (servico.endereco?.[0]?.rua || '').toLowerCase();
    const enderecoEntrega = (servico.endereco?.[1]?.rua || '').toLowerCase();

    if (!enderecoColeta) {
      return { despachar: false, motivo: 'endereco_coleta_vazio' };
    }

    // Tentar casar regra: o campo trecho_endereco da regra (ou cliente_identificador
    // como segunda opção) deve aparecer como substring no endereço de coleta da OS.
    // Fallback de compatibilidade: se trecho_endereco for null (regra antiga), usa cliente_nome.
    let regraCasada = null;
    for (const regra of regras) {
      const trechoEnd = (regra.trecho_endereco || regra.cliente_nome || '').toLowerCase().trim();
      const trechoIdent = (regra.cliente_identificador || '').toLowerCase().trim();

      // Match 1: identificador alternativo (mín 4 chars)
      if (trechoIdent && trechoIdent.length >= 4 && enderecoColeta.includes(trechoIdent)) {
        regraCasada = regra;
        break;
      }

      // Match 2: trecho do endereço (mín 5 chars pra evitar match acidental)
      if (trechoEnd && trechoEnd.length >= 5 && enderecoColeta.includes(trechoEnd)) {
        regraCasada = regra;
        break;
      }
    }

    if (!regraCasada) {
      return { despachar: false, motivo: 'nenhuma_regra_casou' };
    }

    // Verificar horário
    if (regraCasada.horario_inicio && regraCasada.horario_fim) {
      const agora = new Date().toTimeString().slice(0, 5);
      if (agora < regraCasada.horario_inicio || agora > regraCasada.horario_fim) {
        console.log(`🕐 [Uber Worker] OS ${servico.codigoOS} — fora do horário ${regraCasada.horario_inicio}-${regraCasada.horario_fim}`);
        return { despachar: false, motivo: 'fora_horario' };
      }
    }

    // Verificar valor
    if (regraCasada.valor_minimo && parseFloat(servico.valorServico) < parseFloat(regraCasada.valor_minimo)) {
      return { despachar: false, motivo: 'valor_abaixo_minimo' };
    }
    if (regraCasada.valor_maximo && parseFloat(servico.valorServico) > parseFloat(regraCasada.valor_maximo)) {
      return { despachar: false, motivo: 'valor_acima_maximo' };
    }

    // 🔒 Validar região — se a regra tem regiões definidas, o endereço precisa casar
    if (Array.isArray(regraCasada.regioes_permitidas) && regraCasada.regioes_permitidas.length > 0) {
      const casouRegiao = regraCasada.regioes_permitidas.some(reg => {
        const r = (reg || '').toLowerCase().trim();
        if (!r) return false;
        return enderecoColeta.includes(r) || enderecoEntrega.includes(r);
      });
      if (!casouRegiao) {
        console.log(`🗺️ [Uber Worker] OS ${servico.codigoOS} — regra "${regraCasada.cliente_nome}" casou mas endereço fora das regiões permitidas`);
        return { despachar: false, motivo: 'regiao' };
      }
    }

    console.log(`✅ [Uber Worker] OS ${servico.codigoOS} casou com regra "${regraCasada.cliente_nome}" (id=${regraCasada.id})`);
    return { despachar: true, motivo: 'ok', regra: regraCasada };
  }

  // Iniciar polling
  async function iniciar() {
    try {
      const config = await obterConfig(pool);
      const intervaloSeg = config?.polling_intervalo_seg || 30;

      console.log(`🚀 [Uber Worker] Iniciando polling a cada ${intervaloSeg}s (ativo=${config?.ativo}, auto=${config?.auto_despacho})`);

      // Primeiro ciclo imediato — agendarProximo é chamado dentro do executarCiclo
      await executarCiclo();
    } catch (error) {
      console.error('❌ [Uber Worker] Erro ao iniciar:', error.message);
      // Tentar novamente em 60s
      setTimeout(() => iniciar(), 60000);
    }
  }

  iniciar();

  // Retornar handle para poder parar se necessário
  return {
    parar: () => {
      parado = true;
      if (timeoutRef) clearTimeout(timeoutRef);
      console.log('🛑 [Uber Worker] Polling parado');
    },
  };
}

module.exports = { initUberRoutes, initUberTables, startUberWorker };
