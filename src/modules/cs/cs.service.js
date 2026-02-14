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
function calcularHealthScore(metricas) {
  if (!metricas) return 50;

  const totalEntregas = parseInt(metricas.total_entregas) || 0;
  if (totalEntregas === 0) return 10; // Sem entregas = score mínimo

  // ── 1. Taxa de prazo (35 pts) ──
  // Interpolação: 0% → 0 pts | 70% → 14 pts | 85% → 25 pts | 95% → 32 pts | 100% → 35 pts
  const taxaPrazo = parseFloat(metricas.taxa_prazo) || 0;
  let scorePrazo = 0;
  if (taxaPrazo >= 95) scorePrazo = 32 + ((taxaPrazo - 95) / 5) * 3;
  else if (taxaPrazo >= 85) scorePrazo = 25 + ((taxaPrazo - 85) / 10) * 7;
  else if (taxaPrazo >= 70) scorePrazo = 14 + ((taxaPrazo - 70) / 15) * 11;
  else if (taxaPrazo >= 50) scorePrazo = 5 + ((taxaPrazo - 50) / 20) * 9;
  else scorePrazo = (taxaPrazo / 50) * 5;

  // ── 2. Volume de entregas (20 pts) ──
  // Escala logarítmica: cresce rápido no início, estabiliza em volumes altos
  // 1 ent → ~0 | 20 → 8 | 100 → 13 | 500 → 18 | 1000+ → 20
  let scoreVolume = 0;
  if (totalEntregas >= 1000) scoreVolume = 20;
  else if (totalEntregas >= 1) scoreVolume = Math.min(20, (Math.log10(totalEntregas) / Math.log10(1000)) * 20);

  // ── 3. Taxa de retornos (15 pts) ──
  // Quanto menor, melhor: 0% → 15 pts | 2% → 12 pts | 5% → 8 pts | 10% → 3 pts | 15%+ → 0 pts
  const retornos = parseInt(metricas.total_retornos) || 0;
  const taxaRetorno = totalEntregas > 0 ? (retornos / totalEntregas) * 100 : 0;
  let scoreRetorno = 0;
  if (taxaRetorno <= 0) scoreRetorno = 15;
  else if (taxaRetorno <= 2) scoreRetorno = 15 - ((taxaRetorno / 2) * 3);
  else if (taxaRetorno <= 5) scoreRetorno = 12 - (((taxaRetorno - 2) / 3) * 4);
  else if (taxaRetorno <= 10) scoreRetorno = 8 - (((taxaRetorno - 5) / 5) * 5);
  else if (taxaRetorno <= 15) scoreRetorno = 3 - (((taxaRetorno - 10) / 5) * 3);
  else scoreRetorno = 0;

  // ── 4. Tempo médio de entrega (15 pts) ──
  // Referência mercado autopeças urbano: <=30min excelente, 45min bom, 60min ok, >90min ruim
  const tempoMedio = parseFloat(metricas.tempo_medio) || parseFloat(metricas.tempo_medio_entrega) || 0;
  let scoreTempo = 0;
  if (tempoMedio <= 0) scoreTempo = 7.5; // Sem dados = neutro
  else if (tempoMedio <= 30) scoreTempo = 15;
  else if (tempoMedio <= 45) scoreTempo = 15 - (((tempoMedio - 30) / 15) * 3);
  else if (tempoMedio <= 60) scoreTempo = 12 - (((tempoMedio - 45) / 15) * 4);
  else if (tempoMedio <= 90) scoreTempo = 8 - (((tempoMedio - 60) / 30) * 5);
  else if (tempoMedio <= 120) scoreTempo = 3 - (((tempoMedio - 90) / 30) * 3);
  else scoreTempo = 0;

  // ── 5. Recência — dias sem entrega (15 pts) ──
  // 0 dias → 15 pts | 3 dias → 13 pts | 7 dias → 10 pts | 15 dias → 5 pts | 30+ dias → 0 pts
  const diasSemEntrega = metricas.dias_sem_entrega != null
    ? parseInt(metricas.dias_sem_entrega)
    : (metricas.ultima_entrega
        ? Math.floor((Date.now() - new Date(metricas.ultima_entrega).getTime()) / (1000 * 60 * 60 * 24))
        : 999);
  let scoreRecencia = 0;
  if (diasSemEntrega <= 0) scoreRecencia = 15;
  else if (diasSemEntrega <= 3) scoreRecencia = 15 - ((diasSemEntrega / 3) * 2);
  else if (diasSemEntrega <= 7) scoreRecencia = 13 - (((diasSemEntrega - 3) / 4) * 3);
  else if (diasSemEntrega <= 15) scoreRecencia = 10 - (((diasSemEntrega - 7) / 8) * 5);
  else if (diasSemEntrega <= 30) scoreRecencia = 5 - (((diasSemEntrega - 15) / 15) * 5);
  else scoreRecencia = 0;

  // ── Score final ──
  const scoreTotal = scorePrazo + scoreVolume + scoreRetorno + scoreTempo + scoreRecencia;

  return Math.max(0, Math.min(100, Math.round(scoreTotal)));
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
