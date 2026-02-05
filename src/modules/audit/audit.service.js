// ============================================================
// MÓDULO AUDITORIA - SERVICE (Lógica de Negócio)
// Extraído de server.js (linhas 1210-1253)
// 
// IMPORTANTE: registrarAuditoria é usado por TODOS os módulos.
// Este service exporta a função e as categorias para uso global.
// ============================================================

/**
 * Categorias de ações para auditoria
 * Usado por todos os módulos ao registrar logs
 */
const AUDIT_CATEGORIES = {
  AUTH: 'auth',           // Login, logout, registro
  USER: 'user',           // Gestão de usuários
  FINANCIAL: 'financial', // Saques, gratuidades
  DATA: 'data',           // BI, importações, exclusões
  CONFIG: 'config',       // Configurações do sistema
  SCORE: 'score',         // Sistema de pontuação
  ADMIN: 'admin'          // Ações administrativas
};

/**
 * Cria a função de registro de auditoria vinculada ao pool
 * @param {object} pool - Pool de conexão PostgreSQL
 * @returns {Function} Função registrarAuditoria
 */
function createRegistrarAuditoria(pool) {
  /**
   * Registra log de auditoria no banco
   * @param {object} req - Express request object
   * @param {string} action - Ação realizada (ex: 'LOGIN_SUCCESS')
   * @param {string} category - Categoria da ação (usar AUDIT_CATEGORIES)
   * @param {string|null} resource - Recurso afetado (ex: 'withdrawal_requests')
   * @param {string|number|null} resourceId - ID do recurso
   * @param {object|null} details - Detalhes adicionais (será serializado como JSON)
   * @param {string} status - Status: 'success' ou 'failure'
   */
  return async function registrarAuditoria(req, action, category, resource = null, resourceId = null, details = null, status = 'success') {
    try {
      const user = req.user || {};
      const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';

      await pool.query(`
        INSERT INTO audit_logs (user_id, user_cod, user_name, user_role, action, category, resource, resource_id, details, ip_address, user_agent, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        user.id || null,
        user.codProfissional || req.body?.codProfissional || 'anonymous',
        user.nome || req.body?.fullName || 'Anônimo',
        user.role || 'guest',
        action,
        category,
        resource,
        resourceId?.toString(),
        details ? JSON.stringify(details) : null,
        ip,
        userAgent,
        status
      ]);
    } catch (error) {
      console.error('❌ Erro ao registrar auditoria:', error.message);
      // Não propagar erro para não afetar a operação principal
    }
  };
}

module.exports = {
  AUDIT_CATEGORIES,
  createRegistrarAuditoria
};
