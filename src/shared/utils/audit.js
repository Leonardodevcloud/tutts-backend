/**
 * src/shared/utils/audit.js
 * Função de auditoria centralizada
 */

function createAuditLogger(pool) {
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
        status,
      ]);
    } catch (error) {
      console.error('❌ Erro ao registrar auditoria:', error.message);
    }
  };
}

module.exports = { createAuditLogger };
