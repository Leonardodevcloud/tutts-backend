/**
 * MÓDULO GARANTIDO - Service
 * Lógica pura: cálculo proporcional da diária pelo horário de ingresso.
 *
 * Regra (confirmada 2026-05-31):
 *   - Janela de operação = hora_fim - hora_inicio (ex.: 08:00→17:00 = 540 min).
 *   - Ingresso <= início        → 100% do valor base.
 *   - Ingresso >= fim           → 0 (operação encerrada, sem garantia).
 *   - Caso contrário            → fração = (fim - ingresso) / janela.
 *   - valor_garantido = valor_base * fração (arredondado a 2 casas).
 */

function minutosDoDia(timeStr) {
  const [h, m] = String(timeStr || '00:00').slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * @param {Object} p
 * @param {number} p.valorBase    valor base da diária (especial ou padrão)
 * @param {string} p.horaInicio   'HH:MM' ou 'HH:MM:SS'
 * @param {string} p.horaFim      'HH:MM' ou 'HH:MM:SS'
 * @param {Date}   p.agora        instante de ingresso JÁ no fuso desejado (America/Bahia)
 * @returns {{ fracao:number, valorGarantido:number, minutosAtraso:number, minutosIngresso:number }}
 */
function calcularGarantido({ valorBase, horaInicio, horaFim, agora }) {
  const inicio = minutosDoDia(horaInicio);
  const fim = minutosDoDia(horaFim);
  const janela = Math.max(1, fim - inicio);
  const ingresso = agora.getHours() * 60 + agora.getMinutes();

  let fracao;
  if (ingresso <= inicio) fracao = 1;
  else if (ingresso >= fim) fracao = 0;
  else fracao = (fim - ingresso) / janela;

  const base = Number(valorBase) || 0;
  const valorGarantido = Math.round(base * fracao * 100) / 100;
  const minutosAtraso = Math.max(0, Math.min(ingresso, fim) - inicio);

  return {
    fracao: Math.round(fracao * 100000) / 100000,
    valorGarantido,
    minutosAtraso,
    minutosIngresso: ingresso,
  };
}

module.exports = { calcularGarantido, minutosDoDia };
