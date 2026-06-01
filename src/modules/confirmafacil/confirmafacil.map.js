'use strict';

/**
 * MÓDULO CONFIRMAFÁCIL — Mapeamento de status
 *
 * Mapeia status internos do Tutts → código de ocorrência do CF.
 *
 * IMPORTANTE: os códigos de ocorrência variam por embarcador —
 * eles são configurados pelo embarcador no portal CF.
 * O mapa real fica em confirmafacil_config.mapa_ocorrencias (JSONB).
 *
 * Este arquivo define os DEFAULTS e a função de resolução.
 * Se o cliente tiver um mapa customizado no banco, ele prevalece.
 *
 * Status Tutts (webhook payload.Status.ID):
 *   0    → 'aceito'        (profissional recebeu a OS)
 *   0.5  → 'em_andamento'  (chegou no ponto)
 *   0.75 → 'em_andamento'  (coleta confirmada)
 *   1    → 'em_andamento'  (ponto finalizado)
 *   2    → 'finalizado'    (OS finalizada)
 *
 * Status de ponto (statusEndereco.codigo):
 *   'CHE' / 'CHEGOU'       → chegou no destinatário
 *   'FIN' / 'FINALIZADO'   → entregue
 *   'COL' / 'COLETADO'     → coletado na origem
 *
 * Códigos CF comuns (vistos no app na doc):
 *   1  → ENTREGA REALIZADA NORMALMENTE
 *   2  → ENTREGA FORA DA DATA PROGRAMADA
 *   19 → REENTREGA SOLICITADA PELO CLIENTE
 *   26 → NOTA FISCAL RETIDA PELA FISCALIZAÇÃO
 *   43 → FERIADO LOCAL/NACIONAL
 *   44 → EXCESSO DE VEÍCULOS
 *   52 → NF ENTREGUE PARA REDESPACHO
 *   58 → QUEBRA DO VEÍCULO DE ENTREGA
 */

// Mapa padrão — usado quando o cliente não configurou um mapa customizado.
// Altere aqui ou sobrescreva via banco (confirmafacil_config.mapa_ocorrencias).
const MAPA_PADRAO = {
  // status da corrida (novoStatus)
  finalizado:    '1',   // entrega realizada normalmente
  cancelado:     '52',  // NF entregue para redespacho (genérico para cancelamentos)
  em_andamento:  null,  // não reporta — só eventos terminais por padrão

  // status de ponto (pontoStatus)
  finalizado_ponto: '1',
  nao_entregue:     '2',
  chegou:           null,  // não reporta por padrão
  coletado:         null,  // não reporta por padrão
};

/**
 * Resolve o código de ocorrência CF para um dado status.
 *
 * @param {string} status         — status Tutts ('finalizado', 'em_andamento', etc.)
 * @param {Object} mapaCustom     — mapa do banco (pode ser null/undefined)
 * @returns {string|null}         — código CF, ou null se não deve ser reportado
 */
function resolverCodigo(status, mapaCustom) {
  const mapa = { ...MAPA_PADRAO, ...(mapaCustom || {}) };
  return mapa[status] ?? null;
}

/**
 * Formata uma data JS para o padrão DD-MM-AAAA exigido pelo CF.
 * @param {Date} [data]
 * @returns {string}
 */
function formatarData(data) {
  // Usa fuso BRT (UTC-3) porque o Railway roda em UTC
  const d = data || new Date();
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const dd   = String(brt.getUTCDate()).padStart(2, '0');
  const mm   = String(brt.getUTCMonth() + 1).padStart(2, '0');
  const aaaa = brt.getUTCFullYear();
  return `${dd}-${mm}-${aaaa}`;
}

/**
 * Formata hora JS para HH:MM:SS exigido pelo CF (BRT).
 * @param {Date} [data]
 * @returns {string}
 */
function formatarHora(data) {
  const d = data || new Date();
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const hh = String(brt.getUTCHours()).padStart(2, '0');
  const mi = String(brt.getUTCMinutes()).padStart(2, '0');
  const ss = String(brt.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mi}:${ss}`;
}

module.exports = { resolverCodigo, formatarData, formatarHora, MAPA_PADRAO };
