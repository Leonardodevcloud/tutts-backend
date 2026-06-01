/**
 * MÓDULO GARANTIDO - Service
 * Lógica pura: cálculo proporcional da diária pelo horário de ingresso.
 *
 * Regra (confirmada 2026-05-31):
 *   - Janela de desconto = hora_fim - LIMITE, onde LIMITE = hora_tolerancia (se houver)
 *     ou hora_inicio. Antes do LIMITE não desconta nada (margem de tolerância).
 *   - Ingresso <= LIMITE          → 100% do valor base.
 *   - Ingresso >= fim             → 0 (operação encerrada, sem garantia).
 *   - Caso contrário              → fração = (fim - ingresso) / (fim - LIMITE).
 *   - valor_garantido = valor_base * fração (arredondado a 2 casas).
 */

function minutosDoDia(timeStr) {
  const [h, m] = String(timeStr || '00:00').slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * @param {Object} p
 * @param {number} p.valorBase      valor base da diária (especial ou padrão)
 * @param {string} p.horaInicio     'HH:MM' — início da operação
 * @param {string} p.horaFim        'HH:MM' — fim da operação (valor zera aqui)
 * @param {string} [p.horaTolerancia] 'HH:MM' — só desconta APÓS este horário. Sem ela, usa horaInicio.
 * @param {Date}   p.agora          instante de ingresso JÁ no fuso desejado (America/Bahia)
 * @returns {{ fracao:number, valorGarantido:number, minutosAtraso:number, minutosIngresso:number, minutosLimite:number }}
 */
function calcularGarantido({ valorBase, horaInicio, horaFim, horaTolerancia, agora }) {
  const inicio = minutosDoDia(horaInicio);
  const fim = minutosDoDia(horaFim);
  // LIMITE: a partir daqui começa a descontar. Tolerância (se houver) tem prioridade.
  let limite = horaTolerancia ? minutosDoDia(horaTolerancia) : inicio;
  if (limite < inicio) limite = inicio;      // tolerância não pode ser antes do início
  if (limite > fim) limite = fim;            // nem depois do fim
  const janela = Math.max(1, fim - limite);
  const ingresso = agora.getHours() * 60 + agora.getMinutes();

  let fracao;
  if (ingresso <= limite) fracao = 1;
  else if (ingresso >= fim) fracao = 0;
  else fracao = (fim - ingresso) / janela;

  const base = Number(valorBase) || 0;
  const valorGarantido = Math.round(base * fracao * 100) / 100;
  const minutosAtraso = Math.max(0, Math.min(ingresso, fim) - limite);

  return {
    fracao: Math.round(fracao * 100000) / 100000,
    valorGarantido,
    minutosAtraso,
    minutosIngresso: ingresso,
    minutosLimite: limite,
  };
}

module.exports = { calcularGarantido, minutosDoDia };
