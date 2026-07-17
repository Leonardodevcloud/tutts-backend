/**
 * MÓDULO DIÁRIA - Shared
 *
 * registrarDiariaIngresso(): chamado pelos MESMOS dois pontos de entrada que já
 * chamam o registrarGarantidoIngresso (profissional.routes 'entrada' e
 * auto.routes 'entrada_auto'), no 1º ingresso do dia.
 *
 * ── PADRÃO + EXCEÇÃO ──
 *   Sem linha na diaria_escala -> horário e valor PADRÃO da central
 *   Com linha na diaria_escala -> horário dele, e valor dele (ou o padrão, se NULL)
 *
 * ── O CÁLCULO É O DO GARANTIDO ──
 *   Esta função NÃO tem matemática. Ela monta os parâmetros e chama a
 *   calcularGarantido() que já roda em produção há meses — passando a hora do
 *   motoboy no lugar da hora da central.
 *
 *   Isso não é preguiça: é a garantia de que Diária e Garantido nunca vão
 *   divergir. Se a regra de desconto mudar, muda num arquivo e os dois mudam
 *   juntos. Duas cópias da mesma conta viram duas contas diferentes em seis
 *   meses — sempre viram.
 */
'use strict';

const { calcularGarantido } = require('../garantido/garantido.service');
const { agoraBahia, dataRefBahia } = require('../../shared/utils/tzBahia');

function hhmm(t) {
  return String(t || '').slice(0, 5);
}

async function registrarDiariaIngresso(pool, { central_id, cod_profissional, nome_profissional }) {
  try {
    if (!central_id || !cod_profissional) return null;

    // 1) Config da central
    const cfgR = await pool.query(
      `SELECT diaria_ativa, diaria_valor_padrao, diaria_hora_inicio, diaria_hora_fim,
              diaria_hora_tolerancia
         FROM filas_centrais WHERE id = $1`,
      [central_id]
    );
    if (cfgR.rows.length === 0 || !cfgR.rows[0].diaria_ativa) return null;
    const cfg = cfgR.rows[0];

    const dataRef = dataRefBahia();

    // 2) Já registrado hoje? O 1º ingresso trava. Sair e voltar não recalcula —
    //    senão o motoboy que almoça às 12h voltaria "atrasado" e perderia metade
    //    da diária que já tinha ganhado às 8h.
    const jaR = await pool.query(
      `SELECT valor_base, fracao, minutos_atraso, valor_diaria,
              hora_inicio_ref, hora_fim_ref, da_escala
         FROM diaria_registros
        WHERE central_id = $1 AND cod_profissional = $2 AND data_ref = $3`,
      [central_id, cod_profissional, dataRef]
    );
    if (jaR.rows.length > 0) {
      const r = jaR.rows[0];
      return {
        primeiro_do_dia: false,
        da_escala: r.da_escala,
        atrasado: Number(r.minutos_atraso) > 0,
        minutos_atraso: Number(r.minutos_atraso),
        valor_base: Number(r.valor_base),
        valor_diaria: Number(r.valor_diaria),
        fracao: Number(r.fracao),
        hora_inicio: hhmm(r.hora_inicio_ref),
        hora_fim: hhmm(r.hora_fim_ref),
      };
    }

    // 3) Escala (exceção) ou padrão da central
    const escR = await pool.query(
      `SELECT hora_inicio, hora_fim, valor FROM diaria_escala
        WHERE central_id = $1 AND cod_profissional = $2`,
      [central_id, cod_profissional]
    );
    const daEscala = escR.rows.length > 0;
    const esc = daEscala ? escR.rows[0] : null;

    const horaInicio = daEscala ? esc.hora_inicio : cfg.diaria_hora_inicio;
    const horaFim    = daEscala ? esc.hora_fim    : cfg.diaria_hora_fim;

    // valor da escala pode ser NULL de propósito: "esse cara tem horário próprio
    // mas ganha o valor padrão". Repare no `!== null` em vez de `||`: com `||`,
    // um valor R$ 0,00 (que é legítimo — motoboy em teste, penalizado, o que for)
    // viraria o padrão da central calado, e ninguém descobriria até o pagamento.
    const valorBase = daEscala && esc.valor !== null
      ? Number(esc.valor)
      : Number(cfg.diaria_valor_padrao) || 0;

    // 4) A tolerância é sempre da central. Ela é uma política ("15 min de folga
    //    pra todo mundo"), não uma característica do motoboy.
    //
    //    Detalhe que importa: no Garantido a tolerância é um HORÁRIO ('08:15'),
    //    porque lá todo mundo começa junto. Aqui o horário é individual — '08:15'
    //    não significa nada pra quem entra às 14h. Então o mesmo campo é lido
    //    como MINUTOS DE FOLGA ('00:15' = 15 minutos) e somado ao início DELE.
    //
    //    É a única linha onde a Diária diverge do Garantido, e é porque tem que
    //    divergir: o campo tem o mesmo tipo mas o significado é outro.
    let horaTolerancia = null;
    if (cfg.diaria_hora_tolerancia) {
      const [th, tm] = hhmm(cfg.diaria_hora_tolerancia).split(':').map(Number);
      const minutosFolga = (th || 0) * 60 + (tm || 0);
      if (minutosFolga > 0) {
        const [ih, im] = hhmm(horaInicio).split(':').map(Number);
        const limite = (ih || 0) * 60 + (im || 0) + minutosFolga;
        const lh = Math.floor(limite / 60), lm = limite % 60;
        // Passou da meia-noite? A calcularGarantido() trabalha com minutos do dia
        // e não sabe virar o dia. Sem tolerância é melhor que com tolerância
        // errada — e um turno que termina depois da meia-noite é outro problema,
        // que a gente resolve quando existir.
        horaTolerancia = lh > 23 ? null : `${String(lh).padStart(2, '0')}:${String(lm).padStart(2, '0')}`;
      }
    }

    // 5) O cálculo do Garantido, com a hora DELE
    const calc = calcularGarantido({
      valorBase,
      horaInicio,
      horaFim,
      horaTolerancia,
      agora: agoraBahia(),
    });

    // 6) Grava (trava do dia). Guarda o horário usado — recibo não muda depois.
    await pool.query(
      `INSERT INTO diaria_registros
         (central_id, cod_profissional, nome_profissional, data_ref, hora_ingresso,
          hora_inicio_ref, hora_fim_ref, da_escala,
          valor_base, fracao, minutos_atraso, valor_diaria)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (central_id, cod_profissional, data_ref) DO NOTHING`,
      [central_id, cod_profissional, nome_profissional || null, dataRef,
       horaInicio, horaFim, daEscala,
       valorBase, calc.fracao, calc.minutosAtraso, calc.valorGarantido]
    );

    return {
      primeiro_do_dia: true,
      da_escala: daEscala,
      atrasado: calc.minutosAtraso > 0,
      minutos_atraso: calc.minutosAtraso,
      valor_base: valorBase,
      valor_diaria: calc.valorGarantido,
      fracao: calc.fracao,
      hora_inicio: hhmm(horaInicio),
      hora_fim: hhmm(horaFim),
    };
  } catch (err) {
    console.error('❌ [diaria/registrar]', err.message);
    return null;
  }
}

/**
 * estaNaEscalaDiaria(): a trava de vagas precisa saber disso pra deixar o
 * escalado furar o limite. Fica aqui (e não na trava) porque quem sabe o que é
 * "estar na escala" é a diária — se um dia a escala virar por data, muda aqui e
 * a trava nem fica sabendo.
 */
async function estaNaEscalaDiaria(pool, { central_id, cod_profissional }) {
  try {
    const r = await pool.query(
      `SELECT 1 FROM diaria_escala WHERE central_id = $1 AND cod_profissional = $2 LIMIT 1`,
      [central_id, cod_profissional]
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

module.exports = { registrarDiariaIngresso, estaNaEscalaDiaria };
