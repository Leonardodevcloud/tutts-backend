// ============================================================
// MÓDULO SUCESSO DO CLIENTE (CS) - INDEX
// Ponto de entrada único do módulo
//
// Endpoints: ~20 (CRUD clientes, interações, ocorrências,
//                  dashboard, raio-x IA)
// Tabelas: cs_clientes, cs_interacoes, cs_ocorrencias,
//          cs_raio_x_historico
// Integra com: bi_entregas, bi_resumo_cliente (módulo BI)
// ============================================================

const { createCsRouter } = require('./cs.routes');
const initCsTables = require('./cs.migration');
const {
  TIPOS_INTERACAO,
  TIPOS_OCORRENCIA,
  SEVERIDADES,
  STATUS_OCORRENCIA,
  STATUS_CLIENTE,
  calcularHealthScore,
  determinarStatusCliente,
} = require('./cs.service');

module.exports = {
  initCsRoutes: createCsRouter,
  initCsTables,
  TIPOS_INTERACAO,
  TIPOS_OCORRENCIA,
  SEVERIDADES,
  STATUS_OCORRENCIA,
  STATUS_CLIENTE,
  calcularHealthScore,
  determinarStatusCliente,
};
