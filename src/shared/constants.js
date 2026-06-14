/**
 * src/shared/constants.js
 * Constantes globais do sistema
 */

const AUDIT_CATEGORIES = {
  AUTH: 'auth',
  USER: 'user',
  FINANCIAL: 'financial',
  DATA: 'data',
  CONFIG: 'config',
  SCORE: 'score',
  ADMIN: 'admin',
  UBER: 'uber',
};

const ERRO_MSGS = {
  CRIAR: 'Não foi possível criar o registro',
  ATUALIZAR: 'Não foi possível atualizar o registro',
  DELETAR: 'Não foi possível excluir o registro',
  BUSCAR: 'Não foi possível buscar os dados',
  AUTENTICAR: 'Erro na autenticação',
  VALIDAR: 'Dados inválidos',
  PERMISSAO: 'Permissão negada',
};

/**
 * Clientes cujos centros de custo são CONSOLIDADOS numa única linha
 * nas telas de BI, BI Monitoramento e Análise Gerencial.
 * Para incluir um novo cliente, basta adicionar o código aqui.
 * Comparação sempre como string — use String(cod) ao verificar.
 */
const CLIENTES_CC_CONSOLIDADO = ['949', '1165', '1151', '1178', '35', '794', '249'];

function ehClienteCcConsolidado(cod) {
  return CLIENTES_CC_CONSOLIDADO.includes(String(cod).trim());
}

/**
 * Clientes cujos centros de custo são SEPARADOS (cada CC = 1 filial),
 * exibidos como linhas/pinos distintos — comportamento oposto ao consolidado.
 * Usado na localização de clientes (mapa Ponto 1) do BI: clientes normais
 * recebem 1 endereço consolidado, estes recebem 1 endereço por centro de custo.
 * Ex.: 767 (Comollati), 1046, 713 e 814.
 * Para incluir um novo cliente, basta adicionar o código aqui.
 * Comparação sempre como string — use String(cod) ao verificar.
 */
const CLIENTES_CC_SEPARADO = ['767', '1046', '713', '814'];

function ehClienteCcSeparado(cod) {
  return CLIENTES_CC_SEPARADO.includes(String(cod).trim());
}

module.exports = {
  AUDIT_CATEGORIES,
  ERRO_MSGS,
  CLIENTES_CC_CONSOLIDADO,
  ehClienteCcConsolidado,
  CLIENTES_CC_SEPARADO,
  ehClienteCcSeparado,
};
