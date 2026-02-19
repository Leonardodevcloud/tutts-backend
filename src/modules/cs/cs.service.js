/**
 * MÓDULO SUCESSO DO CLIENTE (CS) - Service
 * Funções compartilhadas entre sub-routers
 */

// ── Configurações por cliente (prazo diferenciado) ──
// Clientes com SLA customizado: prazo_max_minutos define o tempo máximo de entrega
const CLIENTE_CONFIG = {
  767: { prazo_max_minutos: 120 }, // Grupo Comollati: 2 horas
  // Adicione outros clientes com prazo diferenciado aqui
};

function getClienteConfig(codCliente) {
  return CLIENTE_CONFIG[parseInt(codCliente)] || {};
}

// ── Constantes ──────────────────────────────────────────

const TIPOS_INTERACAO = {
  visita: { label: 'Visita Presencial', icon: 'map-pin', cor: '#3B82F6' },
  reuniao: { label: 'Reunião', icon: 'users', cor: '#8B5CF6' },
  ligacao: { label: 'Ligação', icon: 'phone', cor: '#10B981' },
  pos_venda: { label: 'Pós-Venda', icon: 'check-circle', cor: '#F59E0B' },
  email: { label: 'E-mail', icon: 'mail', cor: '#6366F1' },
  whatsapp: { label: 'WhatsApp', icon: 'message-circle', cor: '#22C55E' },
  anotacao: { label: 'Anotação Interna', icon: 'file-text', cor: '#64748B' },
};

const TIPOS_OCORRENCIA = {
  reclamacao: { label: 'Reclamação', cor: '#EF4444' },
  problema_entrega: { label: 'Problema na Entrega', cor: '#F97316' },
  atraso: { label: 'Atraso Recorrente', cor: '#F59E0B' },
  financeiro: { label: 'Problema Financeiro', cor: '#8B5CF6' },
  operacional: { label: 'Problema Operacional', cor: '#3B82F6' },
  sugestao: { label: 'Sugestão', cor: '#10B981' },
  elogio: { label: 'Elogio', cor: '#22C55E' },
  outro: { label: 'Outro', cor: '#64748B' },
};

const SEVERIDADES = {
  baixa: { label: 'Baixa', cor: '#10B981', peso: 1 },
  media: { label: 'Média', cor: '#F59E0B', peso: 2 },
  alta: { label: 'Alta', cor: '#F97316', peso: 3 },
  critica: { label: 'Crítica', cor: '#EF4444', peso: 4 },
};

const STATUS_OCORRENCIA = {
  aberta: { label: 'Aberta', cor: '#3B82F6' },
  em_andamento: { label: 'Em Andamento', cor: '#F59E0B' },
  aguardando_cliente: { label: 'Aguardando Cliente', cor: '#8B5CF6' },
  resolvida: { label: 'Resolvida', cor: '#10B981' },
  fechada: { label: 'Fechada', cor: '#64748B' },
};

const STATUS_CLIENTE = {
  ativo: { label: 'Ativo', cor: '#10B981' },
  em_risco: { label: 'Em Risco', cor: '#F59E0B' },
  inativo: { label: 'Inativo', cor: '#EF4444' },
  churned: { label: 'Churned', cor: '#64748B' },
  novo: { label: 'Novo', cor: '#3B82F6' },
};

// ── Funções Utilitárias ──────────────────────────────────

/**
 * Calcula Health Score do cliente baseado em métricas operacionais
 * Score de 0 a 100 — fórmula granular com interpolação linear
 * 
 * Usa o HISTÓRICO COMPLETO do cliente no BI (sem limite de dias).
 * 
 * Composição (pesos somam 100):
 *   1. Taxa de prazo .............. 35 pts  (métrica mais crítica para o cliente)
 *   2. Volume de entregas ......... 20 pts  (engajamento / tamanho da operação)
 *   3. Taxa de retornos ........... 15 pts  (qualidade operacional)
 *   4. Tempo médio de entrega ..... 15 pts  (eficiência logística)
 *   5. Recência (dias sem entrega)  15 pts  (atividade recente)
 */
function calcularHealthScore(metricas, opcoes = {}) {
  if (!metricas) return 50;

  const totalEntregas = parseInt(metricas.total_entregas) || 0;
  if (totalEntregas === 0) return 10; // Sem entregas = score mínimo

  // Prazo diferenciado por cliente (em minutos)
  const prazoMaxMin = opcoes.prazo_max_minutos || 45; // padrão 45min

  // ── 1. Taxa de prazo (50 pts) ──
  // Interpolação: 0% → 0 pts | 70% → 20 pts | 85% → 35 pts | 95% → 45 pts | 100% → 50 pts
  const taxaPrazo = parseFloat(metricas.taxa_prazo) || 0;
  let scorePrazo = 0;
  if (taxaPrazo >= 95) scorePrazo = 45 + ((taxaPrazo - 95) / 5) * 5;
  else if (taxaPrazo >= 85) scorePrazo = 35 + ((taxaPrazo - 85) / 10) * 10;
  else if (taxaPrazo >= 70) scorePrazo = 20 + ((taxaPrazo - 70) / 15) * 15;
  else if (taxaPrazo >= 50) scorePrazo = 7 + ((taxaPrazo - 50) / 20) * 13;
  else scorePrazo = (taxaPrazo / 50) * 7;

  // ── 2. Taxa de retornos (25 pts) ──
  // Quanto menor, melhor: 0% → 25 pts | 2% → 20 pts | 5% → 13 pts | 10% → 5 pts | 15%+ → 0 pts
  const retornos = parseInt(metricas.total_retornos) || 0;
  const taxaRetorno = totalEntregas > 0 ? (retornos / totalEntregas) * 100 : 0;
  let scoreRetorno = 0;
  if (taxaRetorno <= 0) scoreRetorno = 25;
  else if (taxaRetorno <= 2) scoreRetorno = 25 - ((taxaRetorno / 2) * 5);
  else if (taxaRetorno <= 5) scoreRetorno = 20 - (((taxaRetorno - 2) / 3) * 7);
  else if (taxaRetorno <= 10) scoreRetorno = 13 - (((taxaRetorno - 5) / 5) * 8);
  else if (taxaRetorno <= 15) scoreRetorno = 5 - (((taxaRetorno - 10) / 5) * 5);
  else scoreRetorno = 0;

  // ── 3. Tempo médio de entrega (25 pts) ──
  // Usa prazoMaxMin como referência: <=prazo/2 excelente, <=prazo bom, >prazo*2 ruim
  const tempoMedio = parseFloat(metricas.tempo_medio) || parseFloat(metricas.tempo_medio_entrega) || 0;
  const metade = prazoMaxMin / 2;
  const dobro = prazoMaxMin * 2;
  const triplo = prazoMaxMin * 3;
  let scoreTempo = 0;
  if (tempoMedio <= 0) scoreTempo = 12.5; // Sem dados = neutro
  else if (tempoMedio <= metade) scoreTempo = 25;
  else if (tempoMedio <= prazoMaxMin) scoreTempo = 25 - (((tempoMedio - metade) / metade) * 5);
  else if (tempoMedio <= dobro) scoreTempo = 20 - (((tempoMedio - prazoMaxMin) / prazoMaxMin) * 10);
  else if (tempoMedio <= triplo) scoreTempo = 10 - (((tempoMedio - dobro) / prazoMaxMin) * 7);
  else scoreTempo = Math.max(0, 3 - (((tempoMedio - triplo) / prazoMaxMin) * 3));

  // ── Score final ──
  const scoreTotal = scorePrazo + scoreRetorno + scoreTempo;

  return Math.max(0, Math.min(100, Math.round(scoreTotal)));
}

/**
 * Determina status do cliente baseado em múltiplos sinais
 * @param {number} healthScore
 * @param {number} diasSemEntrega
 * @param {object} sinais - { oscilacao_pct, media_semanal_anterior, media_semanal_recente }
 */
function determinarStatusCliente(healthScore, diasSemEntrega, sinais = {}) {
  // 1. Churn confirmado: >30 dias sem solicitar
  if (diasSemEntrega > 30) return 'churned';

  // 2. Inativo: >15 dias sem solicitar
  if (diasSemEntrega > 15) return 'inativo';

  // 3. Em risco: >7 dias sem solicitar OU oscilação abrupta de demanda OU health score crítico
  if (diasSemEntrega > 7) return 'em_risco';
  if (sinais.oscilacao_pct && Math.abs(sinais.oscilacao_pct) > 50) return 'em_risco';
  if (healthScore < 30) return 'em_risco';

  // 4. Ativo
  return 'ativo';
}

/**
 * Analisa sinais de churn para um cliente baseado no volume semanal
 * Compara as 2 últimas semanas com as 2 anteriores
 * @param {Array} semanais - [{ semana, entregas }] ordenado por semana ASC
 * @returns {{ oscilacao_pct, tendencia, alerta_churn, media_recente, media_anterior }}
 */
function analisarSinaisChurn(semanais) {
  if (!semanais || semanais.length < 2) {
    return { oscilacao_pct: 0, tendencia: 'sem_dados', alerta_churn: false, media_recente: 0, media_anterior: 0 };
  }

  const len = semanais.length;
  // Últimas 2 semanas vs 2 anteriores
  const recentes = semanais.slice(Math.max(0, len - 2));
  const anteriores = semanais.slice(Math.max(0, len - 4), Math.max(0, len - 2));

  const mediaRecente = recentes.reduce((s, w) => s + (parseInt(w.entregas) || 0), 0) / recentes.length;
  const mediaAnterior = anteriores.length > 0
    ? anteriores.reduce((s, w) => s + (parseInt(w.entregas) || 0), 0) / anteriores.length
    : mediaRecente;

  const oscilacao = mediaAnterior > 0
    ? ((mediaRecente - mediaAnterior) / mediaAnterior) * 100
    : 0;

  let tendencia = 'estavel';
  let alertaChurn = false;

  if (oscilacao <= -50) {
    tendencia = 'queda_abrupta';
    alertaChurn = true;
  } else if (oscilacao <= -30) {
    tendencia = 'queda_moderada';
    alertaChurn = true;
  } else if (oscilacao <= -15) {
    tendencia = 'queda_leve';
  } else if (oscilacao >= 30) {
    tendencia = 'crescimento';
  }

  return {
    oscilacao_pct: Math.round(oscilacao),
    tendencia,
    alerta_churn: alertaChurn,
    media_recente: Math.round(mediaRecente),
    media_anterior: Math.round(mediaAnterior),
  };
}

module.exports = {
  TIPOS_INTERACAO,
  TIPOS_OCORRENCIA,
  SEVERIDADES,
  STATUS_OCORRENCIA,
  STATUS_CLIENTE,
  calcularHealthScore,
  determinarStatusCliente,
  analisarSinaisChurn,
  getClienteConfig,
};
