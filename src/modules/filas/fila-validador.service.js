/**
 * fila-validador.service.js
 *
 * Núcleo de negócio do agente fila-validador. Separado do agente em si
 * (que só orquestra Playwright + cron) pra facilitar teste e leitura.
 *
 * RESPONSABILIDADES:
 *  1. Listar centrais auto com varredura habilitada
 *  2. Pra cada central, buscar motoboys que estão "aguardando"
 *  3. Receber (do agente) o mapa de cod_profissional → corridas ativas que
 *     foi extraído da ACOMP do sistema externo
 *  4. Cruzar e tomar ação:
 *       - Sem corrida ativa → marca 'validado'
 *       - Com corrida ativa → marca 'reprovado' e REMOVE (se config permitir)
 *  5. Compactar posições após remoções
 *  6. Gravar log em filas_agente_logs
 *
 * Por que separar do agente:
 *   - O agente já tem complexidade de Playwright/browser/login
 *   - Aqui é só SQL + JS — fácil de testar com pool mock
 *   - Permite o admin disparar "rodar agora" via endpoint sem mexer no cron
 */
'use strict';

const { compactarPosicoes, registrarLog } = require('./filas-auto.service');

/**
 * @param {Pool} pool
 * @returns {Promise<Array<{id, nome, varredura_intervalo_seg, remover_ao_pegar_corrida}>>}
 */
async function listarCentraisAtivasAuto(pool) {
  const r = await pool.query(
    `SELECT id, nome, varredura_intervalo_seg, remover_ao_pegar_corrida
       FROM filas_centrais
      WHERE ativa = true
        AND tipo = 'auto'
        AND validacao_agente_ativa = true`
  );
  return r.rows;
}

/**
 * Códigos de profissional que estão aguardando em centrais auto.
 * Usado pelo agente pra saber QUEM precisa verificar na ACOMP.
 *
 * @param {Pool} pool
 * @returns {Promise<Array<{cod_profissional, nome_profissional, central_id}>>}
 */
async function listarMotoboysParaValidar(pool) {
  const r = await pool.query(
    `SELECT p.cod_profissional, p.nome_profissional, p.central_id
       FROM filas_posicoes p
       JOIN filas_centrais c ON c.id = p.central_id
      WHERE p.status = 'aguardando'
        AND c.tipo = 'auto'
        AND c.ativa = true
        AND c.validacao_agente_ativa = true`
  );
  return r.rows;
}

/**
 * Aplica resultado da varredura ao banco.
 *
 * @param {Pool} pool
 * @param {Map<string, Array<{os_numero}>>} corridasPorMotoboy
 *        mapa cod_profissional → lista de corridas ativas (vazia ou null = sem corridas)
 * @returns {Promise<{validados, removidos, erros, total}>}
 */
async function aplicarResultadoVarredura(pool, corridasPorMotoboy) {
  const aguardando = await listarMotoboysParaValidar(pool);
  if (aguardando.length === 0) {
    return { validados: 0, removidos: 0, erros: 0, total: 0 };
  }

  // Cache configs por central (1 query)
  const centraisIds = [...new Set(aguardando.map(m => m.central_id))];
  const cfgR = await pool.query(
    `SELECT id, nome, remover_ao_pegar_corrida FROM filas_centrais WHERE id = ANY($1::int[])`,
    [centraisIds]
  );
  const configPorCentral = new Map(cfgR.rows.map(c => [c.id, c]));

  const centraisQueRemoveram = new Set();
  let validados = 0;
  let removidos = 0;
  let erros = 0;

  for (const m of aguardando) {
    try {
      const corridas = corridasPorMotoboy.get(String(m.cod_profissional)) || [];
      const temCorrida = corridas.length > 0;

      if (!temCorrida) {
        // Sem corrida → marca validado
        await pool.query(
          `UPDATE filas_posicoes
              SET agente_status = 'validado',
                  agente_ultima_validacao_at = NOW(),
                  corridas_ativas_count = 0,
                  updated_at = NOW()
            WHERE cod_profissional = $1 AND status = 'aguardando'`,
          [m.cod_profissional]
        );
        validados++;
        continue;
      }

      // Com corrida ativa
      const cfg = configPorCentral.get(m.central_id);
      const deveRemover = cfg && cfg.remover_ao_pegar_corrida !== false;

      if (deveRemover) {
        await pool.query(
          `DELETE FROM filas_posicoes
            WHERE cod_profissional = $1 AND status = 'aguardando' AND central_id = $2`,
          [m.cod_profissional, m.central_id]
        );
        centraisQueRemoveram.add(m.central_id);

        registrarLog(pool, m.central_id, 'removeu', {
          cod_profissional: m.cod_profissional,
          nome_profissional: m.nome_profissional,
          motivo: `Detectada(s) ${corridas.length} corrida(s) ativa(s)`,
          detalhes: { os_numeros: corridas.map(c => c.os_numero).filter(Boolean) },
        });
        removidos++;
      } else {
        // Só marca reprovado (admin verá no painel mas não remove)
        await pool.query(
          `UPDATE filas_posicoes
              SET agente_status = 'reprovado',
                  agente_ultima_validacao_at = NOW(),
                  corridas_ativas_count = $1,
                  updated_at = NOW()
            WHERE cod_profissional = $2 AND status = 'aguardando'`,
          [corridas.length, m.cod_profissional]
        );
      }
    } catch (e) {
      erros++;
      console.warn(`[fila-validador] erro processando ${m.cod_profissional}:`, e.message);
    }
  }

  // Compactar posições das centrais que tiveram remoções
  for (const cid of centraisQueRemoveram) {
    try {
      await compactarPosicoes(pool, cid);
    } catch (e) {
      console.warn(`[fila-validador] falha ao compactar central ${cid}:`, e.message);
    }
  }

  // Log de varredura completa por central
  for (const cid of centraisIds) {
    const dessaCentral = aguardando.filter(a => a.central_id === cid).length;
    registrarLog(pool, cid, 'varredura_completa', {
      motivo: `${dessaCentral} verificado(s), ${centraisQueRemoveram.has(cid) ? 'com remoções' : 'sem remoções'}`,
      detalhes: { validados_total: validados, removidos_total: removidos },
    });
  }

  return { validados, removidos, erros, total: aguardando.length };
}

/**
 * Registra tentativa de entrada bloqueada (motoboy tentou entrar mas o
 * agente já sabia que tinha corrida). Chamado em situações futuras —
 * por enquanto a entrada é otimista (entra primeiro, valida depois).
 */
async function registrarTentativaBloqueada(pool, centralId, opts) {
  await registrarLog(pool, centralId, 'bloqueou_entrada', opts);
}

module.exports = {
  listarCentraisAtivasAuto,
  listarMotoboysParaValidar,
  aplicarResultadoVarredura,
  registrarTentativaBloqueada,
};
