/**
 * agents/liberar-ponto.agent.js
 * Worker do pool — processa fila liberacoes_pontos.
 * 1 slot, conta exclusiva (SISTEMA_EXTERNO_LIBERACAO_*).
 */

'use strict';

const { defineAgent } = require('../core/agent-base');
const playwrightLib   = require('../playwright-liberar-ponto');

const SLOTS = Number(process.env.POOL_LIBERACAO_SLOTS || 1);

module.exports = defineAgent({
  nome: 'liberar-ponto',
  slots: SLOTS,
  sessionStrategy: 'isolada',  // 1 sessão por slot (mesmo padrão do agent-correcao)
  intervalo: 10_000,

  buscarPendentes: async (pool, _limite) => {
    const { rows } = await pool.query(`
      SELECT * FROM liberacoes_pontos
      WHERE status = 'pendente'
      ORDER BY criado_em ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return rows[0] || null;
  },

  marcarProcessando: async (pool, registro) => {
    await pool.query(
      `UPDATE liberacoes_pontos SET status = 'processando' WHERE id = $1`,
      [registro.id]
    );
  },

  processar: async (pool, registro, ctx) => {
    ctx.log(`📋 OS ${registro.os_numero}`);

    // Aplica credenciais e session file por slot (gerenciado por core/agent-base)
    const overrides = ctx.overrides || {};
    if (overrides.credentials || overrides.sessionFile) {
      playwrightLib.setOverrides(overrides);
    }

    let resultado;
    try {
      resultado = await playwrightLib.executarLiberacaoOS({
        os_numero: registro.os_numero,
        onProgresso: (etapa, pct) => {
          pool.query(
            `UPDATE liberacoes_pontos SET etapa_atual = $1, progresso = $2 WHERE id = $3`,
            [etapa, pct, registro.id]
          ).catch(() => {});
        },
      });
    } finally {
      playwrightLib.clearOverrides();
    }

    if (resultado && resultado.sucesso) {
      await pool.query(`
        UPDATE liberacoes_pontos
           SET status = 'sucesso',
               finalizado_em = NOW(),
               etapa_atual = 'concluido',
               progresso = 100,
               mensagem_retorno = $1
         WHERE id = $2
      `, [resultado.mensagem_retorno || 'Enviado', registro.id]);
      ctx.log(`✅ OS ${registro.os_numero} liberada`);
    } else {
      await pool.query(`
        UPDATE liberacoes_pontos
           SET status = 'falhou',
               erro = $1,
               finalizado_em = NOW(),
               screenshot_path = $2
         WHERE id = $3
      `, [
        ((resultado && resultado.erro) || 'Erro desconhecido').slice(0, 500),
        (resultado && resultado.screenshot_path) || null,
        registro.id,
      ]);
      ctx.log(`❌ OS ${registro.os_numero} falhou: ${resultado && resultado.erro}`);
    }
  },

  onErro: async (pool, registro, err) => {
    if (registro?.id) {
      try {
        await pool.query(`
          UPDATE liberacoes_pontos
             SET status = 'falhou',
                 erro = $1,
                 finalizado_em = NOW()
           WHERE id = $2 AND status = 'processando'
        `, [`pool_exception: ${err.message}`.slice(0, 500), registro.id]);
      } catch (_) {}
    }
  },
});
