/**
 * MÓDULO SUCESSO DO CLIENTE (CS) - Service
 * Funções compartilhadas entre sub-routers
 */

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
 * Score de 0 a 100
 */
function calcularHealthScore(metricas) {
  if (!metricas) return 50;

  let score = 50; // Base

  // Taxa de prazo (peso 30)
  const taxaPrazo = parseFloat(metricas.taxa_prazo) || 0;
  if (taxaPrazo >= 95) score += 30;
  else if (taxaPrazo >= 85) score += 20;
  else if (taxaPrazo >= 70) score += 10;
  else if (taxaPrazo >= 50) score += 0;
  else score -= 15;

  // Volume de entregas (peso 15)
  const totalEntregas = parseInt(metricas.total_entregas) || 0;
  if (totalEntregas >= 100) score += 15;
  else if (totalEntregas >= 50) score += 10;
  else if (totalEntregas >= 20) score += 5;
  else score -= 5;

  // Retornos/Ocorrências (peso -15)
  const retornos = parseInt(metricas.total_retornos) || 0;
  const taxaRetorno = totalEntregas > 0 ? (retornos / totalEntregas) * 100 : 0;
  if (taxaRetorno <= 2) score += 5;
  else if (taxaRetorno <= 5) score += 0;
  else if (taxaRetorno <= 10) score -= 10;
  else score -= 15;

  // Clamp entre 0 e 100
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determina status do cliente baseado no health score
 */
function determinarStatusCliente(healthScore, diasSemEntrega) {
  if (diasSemEntrega > 30) return 'churned';
  if (diasSemEntrega > 15) return 'inativo';
  if (healthScore < 30) return 'em_risco';
  if (healthScore >= 70) return 'ativo';
  return 'ativo';
}

module.exports = {
  TIPOS_INTERACAO,
  TIPOS_OCORRENCIA,
  SEVERIDADES,
  STATUS_OCORRENCIA,
  STATUS_CLIENTE,
  calcularHealthScore,
  determinarStatusCliente,
};
