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
const CLIENTES_CC_CONSOLIDADO = ['949', '1165', '1151'];

function ehClienteCcConsolidado(cod) {
  return CLIENTES_CC_CONSOLIDADO.includes(String(cod).trim());
}

module.exports = { AUDIT_CATEGORIES, ERRO_MSGS, CLIENTES_CC_CONSOLIDADO, ehClienteCcConsolidado };
