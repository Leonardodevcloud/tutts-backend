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
} = require('./uber.service');

function initUberRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  return createUberRouter(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

/**
 * Worker de polling: roda a cada N segundos (configurável)
 * 1. Busca serviços abertos na Mapp (status 0)
 * 2. Aplica regras de decisão
 * 3. Despacha pro Uber Direct
 * 4. Verifica timeouts (entregador não encontrado)
 *
 * Usa setTimeout recursivo (não setInterval) para que mudanças no
 * polling_intervalo_seg da config peguem em runtime sem precisar restart.
 */
function startUberWorker(pool) {
  let ultimoId = 0;
  let timeoutRef = null;
  let rodando = false;
  let parado = false;

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

      // 1. Buscar serviços abertos
      const servicos = await mappListarServicos(pool, 0, ultimoId);

      if (servicos.length > 0) {
        console.log(`🔍 [Uber Worker] ${servicos.length} serviço(s) aberto(s) encontrado(s)`);

        for (const servico of servicos) {
          try {
            // Atualizar ultimoId
            if (servico.codigoOS > ultimoId) {
              ultimoId = servico.codigoOS;
            }

            // 2. Verificar regras
            const deveEnviarUber = await verificarRegras(pool, servico);
            if (!deveEnviarUber) continue;

            // 3. Despachar pro Uber
            await despacharParaUber(pool, servico);

          } catch (err) {
            console.error(`❌ [Uber Worker] Erro processando OS ${servico.codigoOS}:`, err.message);
          }
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

  async function verificarRegras(pool, servico) {
    // Buscar regras ativas
    const { rows: regras } = await pool.query(
      'SELECT * FROM uber_regras_cliente WHERE ativo = true'
    );

    // Se não tem regras, envia tudo pro Uber (comportamento padrão quando auto_despacho ligado)
    if (regras.length === 0) return true;

    // Tentar casar com alguma regra pelo nome do ponto de coleta
    const nomeColeta = (servico.endereco?.[0]?.nome || '').toLowerCase();

    for (const regra of regras) {
      const nomeRegra = (regra.cliente_nome || '').toLowerCase();

      // Match por nome (contém)
      if (nomeColeta.includes(nomeRegra) || nomeRegra.includes(nomeColeta)) {
        if (!regra.usar_uber) {
          console.log(`🚫 [Uber Worker] OS ${servico.codigoOS} — regra "${regra.cliente_nome}": usar_uber=false`);
          return false;
        }

        // Verificar horário
        if (regra.horario_inicio && regra.horario_fim) {
          const agora = new Date().toTimeString().slice(0, 5);
          if (agora < regra.horario_inicio || agora > regra.horario_fim) {
            console.log(`🕐 [Uber Worker] OS ${servico.codigoOS} — fora do horário ${regra.horario_inicio}-${regra.horario_fim}`);
            return false;
          }
        }

        // Verificar valor
        if (regra.valor_minimo && servico.valorServico < parseFloat(regra.valor_minimo)) return false;
        if (regra.valor_maximo && servico.valorServico > parseFloat(regra.valor_maximo)) return false;

        return true;
      }
    }

    // Nenhuma regra casou — comportamento padrão: enviar
    return true;
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
