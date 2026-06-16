/**
 * MÓDULO LOGISTICS — PollingWorker
 *
 * Worker de polling do hub. Substitui o stub que vinha desde a Fase 0.
 *
 * Generaliza o startUberWorker legado (uber/index.js:42-373):
 *  - Polling Mapp a cada N segundos (setTimeout recursivo, não setInterval —
 *    pra mudanças no intervalo pegarem em runtime sem restart)
 *  - Checkpoint persistido em logistics_worker_state.ultimo_id_mapp
 *  - Janela temporal — descarta OS antigas (lixo histórico)
 *  - Para cada OS: chama Orchestrator.tryDispatchByOS (que faz rule match +
 *    margem + cotação + despacho)
 *  - verifyTimeouts ao fim de cada ciclo
 *
 * CONTROLE POR BANCO (não por deploy):
 *  logistics_worker_state.ativo = false
 *    → worker dorme (loga "standby" a cada ciclo, não faz polling)
 *  logistics_worker_state.ativo = true, auto_despacho = false
 *    → faz polling mas SÓ verifica timeouts (não despacha)
 *  logistics_worker_state.ativo = true, auto_despacho = true
 *    → despacha de verdade
 *
 * Ligar/desligar a automação é UPDATE SQL — sem deploy, sem coreografia.
 *
 * DIFERENÇA vs worker legado: o legado lê config de uber_config. Este lê de
 * logistics_worker_state. Os dois podem coexistir sem conflito:
 *  - worker legado (startUberWorker) com uber_config.auto_despacho=false → só timeout
 *  - PollingWorker com logistics_worker_state.ativo=false → dorme
 * Nenhum dos dois despacha até ser explicitamente ligado.
 */

const { getDispatchOrchestrator } = require('../core/DispatchOrchestrator');
const { getEventLogger, EventType, EventSource } = require('../core/EventLogger');
const { getMappClient } = require('../core/MappClient');

const DEFAULT_INTERVALO_SEG = 30;
const DEFAULT_JANELA_MIN = 30;

/**
 * Inicia o PollingWorker.
 *
 * @param {import('pg').Pool} pool
 * @returns {{ parar: Function }}
 */
function startPollingWorker(pool) {
  let timeoutRef = null;
  let rodando = false;
  let parado = false;
  let logStandbyContador = 0;  // pra não floodar log de "standby"

  const orchestrator = getDispatchOrchestrator(pool);
  const events = getEventLogger(pool);
  const mapp = getMappClient(pool);

  /**
   * Lê o estado atual do worker da tabela logistics_worker_state.
   * @returns {Promise<{ativo, auto_despacho, ultimo_id_mapp, janela_minutos, intervalo_segundos}>}
   */
  async function lerEstado() {
    try {
      const { rows } = await pool.query(`
        SELECT ativo, auto_despacho, ultimo_id_mapp, janela_minutos, intervalo_segundos
        FROM logistics_worker_state
        WHERE worker_name = 'mapp_polling'
      `);
      if (rows.length === 0) {
        // Linha não existe (migration não rodou?) — cria com defaults
        await pool.query(`
          INSERT INTO logistics_worker_state (worker_name, ativo, auto_despacho)
          VALUES ('mapp_polling', false, false)
          ON CONFLICT (worker_name) DO NOTHING
        `);
        return { ativo: false, auto_despacho: false, ultimo_id_mapp: 0,
                 janela_minutos: DEFAULT_JANELA_MIN, intervalo_segundos: DEFAULT_INTERVALO_SEG };
      }
      return rows[0];
    } catch (err) {
      console.error('❌ [PollingWorker] erro ao ler estado:', err.message);
      // Fail-safe: retorna inativo (não faz nada se não consegue ler estado)
      return { ativo: false, auto_despacho: false, ultimo_id_mapp: 0,
               janela_minutos: DEFAULT_JANELA_MIN, intervalo_segundos: DEFAULT_INTERVALO_SEG };
    }
  }

  /**
   * Persiste o checkpoint (maior id de OS processado).
   */
  async function salvarCheckpoint(ultimoId) {
    try {
      await pool.query(`
        UPDATE logistics_worker_state
        SET ultimo_id_mapp = $1, ultimo_ciclo_em = NOW(), updated_at = NOW()
        WHERE worker_name = 'mapp_polling'
      `, [ultimoId]);
    } catch (err) {
      console.error('❌ [PollingWorker] erro ao salvar checkpoint:', err.message);
    }
  }

  /**
   * Atualiza só o timestamp do último ciclo (quando não houve mudança de checkpoint).
   */
  async function marcarCiclo() {
    try {
      await pool.query(`
        UPDATE logistics_worker_state SET ultimo_ciclo_em = NOW() WHERE worker_name = 'mapp_polling'
      `);
    } catch (err) { /* silencioso — é só telemetria */ }
  }

  /**
   * Filtra OS dentro da janela temporal aceitável.
   * Espelha dentroDaJanela do worker legado (uber/index.js:74-80).
   */
  function dentroDaJanela(servico, janelaMinutos) {
    if (!servico?.dataHora) return false;
    // Mapp envia dataHora no fuso de Brasilia (UTC-3) SEM marcador de timezone.
    // O servidor roda em UTC; sem marcar -03:00 a OS parece ~3h mais velha e cai fora da janela.
    let _iso = String(servico.dataHora).trim().replace(' ', 'T');
    if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(_iso)) _iso += '-03:00';
    const dataOS = new Date(_iso);
    if (isNaN(dataOS.getTime())) return false;
    const idadeMin = (Date.now() - dataOS.getTime()) / 60000;
    return idadeMin >= 0 && idadeMin <= janelaMinutos;
  }

  /**
   * Um ciclo completo do worker.
   */
  async function executarCiclo() {
    if (rodando || parado) return;
    rodando = true;

    let intervaloProximo = DEFAULT_INTERVALO_SEG;

    try {
      const estado = await lerEstado();
      intervaloProximo = estado.intervalo_segundos || DEFAULT_INTERVALO_SEG;

      // ─── Worker desligado: dorme ───
      if (!estado.ativo) {
        // Loga "standby" só a cada ~20 ciclos pra não floodar (≈ a cada 10min)
        logStandbyContador++;
        if (logStandbyContador % 20 === 1) {
          console.log('🛌 [PollingWorker] standby (logistics_worker_state.ativo=false)');
        }
        rodando = false;
        agendarProximo(intervaloProximo);
        return;
      }

      // ─── Worker ligado mas sem auto_despacho: só verifica timeouts ───
      if (!estado.auto_despacho) {
        const promovidas = await orchestrator.verifyTimeouts();
        if (promovidas > 0) {
          console.log(`⏰ [PollingWorker] ${promovidas} entrega(s) → fallback (modo só-timeout)`);
        }
        await marcarCiclo();
        rodando = false;
        agendarProximo(intervaloProximo);
        return;
      }

      // ─── Worker ligado COM auto_despacho: despacha de verdade ───
      const janelaMin = estado.janela_minutos || DEFAULT_JANELA_MIN;
      let ultimoId = parseInt(estado.ultimo_id_mapp, 10) || 0;

      // 1. Buscar serviços abertos na Mapp
      const servicos = await mapp.listarServicos(0, ultimoId);

      if (servicos.length > 0) {
        console.log(`🔍 [PollingWorker] ${servicos.length} serviço(s) da Mapp (ultimoId=${ultimoId}, janela=${janelaMin}min)`);

        let maiorId = ultimoId;
        let despachadas = 0, puladas_janela = 0, puladas_regra = 0, erros = 0;

        for (const servico of servicos) {
          try {
            // Atualiza ponteiro mesmo se a OS for rejeitada
            if (Number(servico.codigoOS) > maiorId) {
              maiorId = Number(servico.codigoOS);
            }

            // Filtro de janela temporal
            if (!dentroDaJanela(servico, janelaMin)) {
              puladas_janela++;
              continue;
            }

            // Delega ao Orchestrator: ele faz rule match + margem + cotação + despacho
            const resultado = await orchestrator.tryDispatchByOS(servico.codigoOS, {
              eventSource: EventSource.WORKER,
            });

            if (resultado.decision === 'despachado') {
              despachadas++;
            } else if (String(resultado.decision).startsWith('rejeitado_')) {
              puladas_regra++;
            } else if (resultado.decision === 'cotacao_falhou' || resultado.decision === 'despacho_falhou_ou_duplicado') {
              erros++;
            }
            // os_nao_encontrada: a OS sumiu da Mapp entre o listarServicos e o tryDispatch — ignora
          } catch (err) {
            erros++;
            console.error(`❌ [PollingWorker] erro processando OS ${servico.codigoOS}:`, err.message);
            events.logError('uber', err, {
              eventSource: EventSource.WORKER,
              codigoOS: servico.codigoOS,
            });
          }
        }

        // Persiste checkpoint
        if (maiorId > ultimoId) {
          await salvarCheckpoint(maiorId);
        } else {
          await marcarCiclo();
        }

        if (despachadas > 0 || puladas_janela > 0 || puladas_regra > 0 || erros > 0) {
          console.log(`📊 [PollingWorker] ciclo: ${despachadas} despachada(s), ${puladas_janela} fora da janela, ${puladas_regra} sem regra, ${erros} erro(s)`);
        }
      } else {
        await marcarCiclo();
      }

      // 2. Verificar timeouts
      const promovidas = await orchestrator.verifyTimeouts();
      if (promovidas > 0) {
        console.log(`⏰ [PollingWorker] ${promovidas} entrega(s) → fallback por timeout`);
      }

      // 2c. Alertas de monitoramento (corrida sem entregador 10/15 min)
      try {
        await orchestrator.verificarAlertasMonitoramento();
      } catch (eMon) {
        console.error('[PollingWorker] erro em verificarAlertasMonitoramento:', eMon.message);
      }

      // 2b. Coleta lenta: cancela e redespacha mantendo o mesmo link de rastreio.
      try {
        const redesp = await orchestrator.verifyColetaTimeoutsERedespacha();
        if (redesp > 0) {
          console.log(`🔁 [PollingWorker] ${redesp} entrega(s) redespachada(s) por coleta lenta`);
        }
      } catch (eCol) {
        console.error('[PollingWorker] erro em verifyColetaTimeoutsERedespacha:', eCol.message);
      }

    } catch (error) {
      console.error('❌ [PollingWorker] erro no ciclo:', error.message);
      events.logError('uber', error, { eventSource: EventSource.WORKER }).catch(() => {});
    }

    rodando = false;
    agendarProximo(intervaloProximo);
  }

  function agendarProximo(seg) {
    if (parado) return;
    timeoutRef = setTimeout(executarCiclo, Math.max(5, seg) * 1000);
    if (typeof timeoutRef.unref === 'function') timeoutRef.unref();
  }

  // Iniciar
  async function iniciar() {
    try {
      const estado = await lerEstado();
      console.log(`🚀 [PollingWorker] iniciado (ativo=${estado.ativo}, auto_despacho=${estado.auto_despacho}, intervalo=${estado.intervalo_segundos || DEFAULT_INTERVALO_SEG}s)`);
      await executarCiclo();
    } catch (error) {
      console.error('❌ [PollingWorker] erro ao iniciar:', error.message);
      // Retry em 60s
      setTimeout(() => iniciar(), 60_000);
    }
  }

  iniciar();

  return {
    parar: () => {
      parado = true;
      if (timeoutRef) clearTimeout(timeoutRef);
      console.log('🛑 [PollingWorker] parado');
    },
  };
}

module.exports = { startPollingWorker };
