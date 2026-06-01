/**
 * MÓDULO GARANTIDO - Shared
 * registrarGarantidoIngresso(): chamado pelos pontos de ENTRADA das duas filas
 * (profissional.routes 'entrada' e auto.routes 'entrada_auto') no 1º ingresso do dia.
 *
 * - Não faz nada se a central estiver com garantido desativado.
 * - Trava no 1º ingresso do dia (UNIQUE central+motoboy+data_ref).
 * - Retorna os dados pro endpoint montar o aviso ao motoboy, ou null se inativo.
 */

const { calcularGarantido } = require('./garantido.service');

function agoraBahia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
}
function dataRefBahia() {
  const d = agoraBahia();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function hhmm(t) {
  return String(t || '').slice(0, 5);
}

async function registrarGarantidoIngresso(pool, { central_id, cod_profissional, nome_profissional }) {
  try {
    if (!central_id || !cod_profissional) return null;

    // 1) Config da central
    const cfgR = await pool.query(
      `SELECT garantido_ativo, garantido_valor_padrao, garantido_hora_inicio, garantido_hora_fim,
              garantido_hora_tolerancia
         FROM filas_centrais WHERE id = $1`,
      [central_id]
    );
    if (cfgR.rows.length === 0 || !cfgR.rows[0].garantido_ativo) return null;
    const cfg = cfgR.rows[0];

    const dataRef = dataRefBahia();

    // 2) Já registrado hoje? (1º ingresso trava o valor)
    const jaR = await pool.query(
      `SELECT valor_base, fracao, minutos_atraso, valor_garantido
         FROM garantido_registros
        WHERE central_id = $1 AND cod_profissional = $2 AND data_ref = $3`,
      [central_id, cod_profissional, dataRef]
    );
    if (jaR.rows.length > 0) {
      const r = jaR.rows[0];
      return {
        primeiro_do_dia: false,
        atrasado: Number(r.minutos_atraso) > 0,
        valor_base: Number(r.valor_base),
        valor_garantido: Number(r.valor_garantido),
        fracao: Number(r.fracao),
        hora_inicio: hhmm(cfg.garantido_hora_inicio),
        hora_fim: hhmm(cfg.garantido_hora_fim),
        hora_desconto: hhmm(cfg.garantido_hora_tolerancia) || hhmm(cfg.garantido_hora_inicio),
      };
    }

    // 3) Valor base: especial do motoboy ou padrão da central
    const espR = await pool.query(
      `SELECT valor FROM garantido_valores_especiais WHERE central_id = $1 AND cod_profissional = $2`,
      [central_id, cod_profissional]
    );
    const valorBase = espR.rows.length > 0 ? Number(espR.rows[0].valor) : Number(cfg.garantido_valor_padrao) || 0;

    // 4) Calcular proporcional (fuso America/Bahia)
    const calc = calcularGarantido({
      valorBase,
      horaInicio: cfg.garantido_hora_inicio,
      horaFim: cfg.garantido_hora_fim,
      horaTolerancia: cfg.garantido_hora_tolerancia,
      agora: agoraBahia(),
    });

    // 5) Gravar (trava do dia)
    await pool.query(
      `INSERT INTO garantido_registros
         (central_id, cod_profissional, nome_profissional, data_ref, hora_ingresso,
          valor_base, fracao, minutos_atraso, valor_garantido)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8)
       ON CONFLICT (central_id, cod_profissional, data_ref) DO NOTHING`,
      [central_id, cod_profissional, nome_profissional || null, dataRef,
       valorBase, calc.fracao, calc.minutosAtraso, calc.valorGarantido]
    );

    return {
      primeiro_do_dia: true,
      atrasado: calc.minutosAtraso > 0,
      valor_base: valorBase,
      valor_garantido: calc.valorGarantido,
      fracao: calc.fracao,
      hora_inicio: hhmm(cfg.garantido_hora_inicio),
      hora_fim: hhmm(cfg.garantido_hora_fim),
      hora_desconto: hhmm(cfg.garantido_hora_tolerancia) || hhmm(cfg.garantido_hora_inicio),
    };
  } catch (err) {
    console.error('❌ [garantido/registrar]', err.message);
    return null;
  }
}

module.exports = { registrarGarantidoIngresso };
