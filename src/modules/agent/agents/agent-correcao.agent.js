/**
 * agents/agent-correcao.agent.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agente de correção automática de endereços (RPA via Playwright).
 * Substitui o `agent-worker.js` antigo.
 *
 * IMPORTANTE: Adicionado FOR UPDATE SKIP LOCKED na query — antes não tinha,
 * agora é obrigatório porque múltiplos slots concorrem pela mesma fila.
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const { normalizeLocation } = require('../location-normalizer');
const playwrightAgent = require('../playwright-agent');
const { haversineKm, RAIO_MAXIMO_KM } = require('../routes/correcao.routes');

const SLOTS = Number(process.env.POOL_AGENT_CORRECAO_SLOTS || 2);

module.exports = defineAgent({
  nome: 'agent-correcao',
  slots: SLOTS,
  sessionStrategy: 'isolada',  // 1 conta por slot
  intervalo: 10_000,           // 10s entre ticks quando fila vazia

  buscarPendentes: async (pool, _limite) => {
    // FOR UPDATE SKIP LOCKED — paralelismo seguro entre slots
    const { rows } = await pool.query(`
      SELECT * FROM ajustes_automaticos
      WHERE status = 'pendente'
      ORDER BY criado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return rows[0] || null;
  },

  marcarProcessando: async (pool, registro) => {
    await pool.query(
      `UPDATE ajustes_automaticos SET status = 'processando' WHERE id = $1`,
      [registro.id]
    );
  },

  processar: async (pool, registro, ctx) => {
    ctx.log(`📋 OS ${registro.os_numero} ponto ${registro.ponto}`);

    // 1. Normalizar localização
    let coords;
    try {
      coords = await normalizeLocation(registro.localizacao_raw);
      ctx.log(`📍 Coords: ${coords.latitude}, ${coords.longitude}`);
    } catch (err) {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'falhou', erro = $1, finalizado_em = NOW()
         WHERE id = $2`,
        [`Normalização: ${err.message}`.slice(0, 500), registro.id]
      );
      return; // erro já tratado, não relançar
    }

    await pool.query(
      `UPDATE ajustes_automaticos SET latitude = $1, longitude = $2 WHERE id = $3`,
      [coords.latitude, coords.longitude, registro.id]
    );

    // 2. Validação de raio (se OS tem coords originais)
    if (registro.endereco_antigo_lat && registro.endereco_antigo_lng) {
      const distKm = haversineKm(
        coords.latitude, coords.longitude,
        registro.endereco_antigo_lat, registro.endereco_antigo_lng
      );
      if (distKm > RAIO_MAXIMO_KM) {
        await pool.query(
          `UPDATE ajustes_automaticos
           SET status = 'falhou',
               erro = $1,
               finalizado_em = NOW()
           WHERE id = $2`,
          [`Distância ${distKm.toFixed(2)}km > ${RAIO_MAXIMO_KM}km`, registro.id]
        );
        return;
      }
    }

    await pool.query(
      `UPDATE ajustes_automaticos SET etapa_atual = 'iniciando', progresso = 5 WHERE id = $1`,
      [registro.id]
    );

    // 3. Configura overrides do Playwright (credenciais e arquivo de sessão deste slot)
    const creds = ctx.sessao.credenciaisDoSlot(ctx.slotIdx);
    const sessionFile = ctx.sessao.caminhoSessao(ctx.slotIdx);

    playwrightAgent.setOverrides({
      sessionFile,
      credentials: { email: creds.email, senha: creds.senha },
    });

    let resultado;
    try {
      resultado = await playwrightAgent.executarCorrecaoEndereco({
        os_numero:        registro.os_numero,
        ponto:            registro.ponto,
        latitude:         coords.latitude,
        longitude:        coords.longitude,
        cod_profissional: registro.cod_profissional || null,
        onProgresso: (etapa, pct) => {
          pool.query(
            `UPDATE ajustes_automaticos SET etapa_atual = $1, progresso = $2 WHERE id = $3`,
            [etapa, pct, registro.id]
          ).catch(() => {});
        },
      });
    } finally {
      playwrightAgent.clearOverrides();
    }

    // 4. Atualizar resultado final
    if (resultado && resultado.sucesso) {
      const updates = [
        `status = 'sucesso'`,
        `finalizado_em = NOW()`,
        `etapa_atual = 'concluido'`,
        `progresso = 100`,
      ];
      const params = [];
      if (resultado.endereco_corrigido) {
        updates.push(`endereco_corrigido = $${params.length + 1}`);
        params.push(resultado.endereco_corrigido);
      }
      if (resultado.endereco_antigo) {
        updates.push(`endereco_antigo = $${params.length + 1}`);
        params.push(resultado.endereco_antigo);
      }
      // 2026-04: gravar campos do Playwright que estavam sendo ignorados
      // (causavam: status "Frete pendente" e ausência do comparativo Antes/Depois)
      if (typeof resultado.frete_recalculado === 'boolean') {
        updates.push(`frete_recalculado = $${params.length + 1}`);
        params.push(resultado.frete_recalculado);
      }
      if (resultado.valores_antes) {
        updates.push(`valores_antes = $${params.length + 1}`);
        params.push(JSON.stringify(resultado.valores_antes));
      }
      if (resultado.valores_depois) {
        updates.push(`valores_depois = $${params.length + 1}`);
        params.push(JSON.stringify(resultado.valores_depois));
      }
      params.push(registro.id);

      await pool.query(
        `UPDATE ajustes_automaticos SET ${updates.join(', ')} WHERE id = $${params.length}`,
        params
      );

      // Salvar coords antigas se vieram
      if (resultado.endereco_antigo_lat && resultado.endereco_antigo_lng) {
        await pool.query(
          `UPDATE ajustes_automaticos SET endereco_antigo_lat = $1, endereco_antigo_lng = $2 WHERE id = $3`,
          [resultado.endereco_antigo_lat, resultado.endereco_antigo_lng, registro.id]
        ).catch(() => {});
      }

      ctx.log(`✅ OS ${registro.os_numero} corrigida`);
    } else {
      await pool.query(
        `UPDATE ajustes_automaticos
         SET status = 'falhou',
             erro = $1,
             finalizado_em = NOW(),
             screenshot_path = $2
         WHERE id = $3`,
        [
          (resultado && resultado.erro || 'Erro desconhecido').slice(0, 500),
          resultado && resultado.screenshot_path || null,
          registro.id,
        ]
      );
      ctx.log(`❌ OS ${registro.os_numero} falhou: ${resultado && resultado.erro}`);
    }
  },

  onErro: async (pool, registro, err) => {
    if (registro?.id) {
      try {
        await pool.query(
          `UPDATE ajustes_automaticos
           SET status = 'falhou',
               erro = $1,
               finalizado_em = NOW()
           WHERE id = $2 AND status = 'processando'`,
          [`pool_exception: ${err.message}`.slice(0, 500), registro.id]
        );
      } catch (_) {}
    }
  },
});
