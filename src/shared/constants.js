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

module.exports = { AUDIT_CATEGORIES, ERRO_MSGS };
