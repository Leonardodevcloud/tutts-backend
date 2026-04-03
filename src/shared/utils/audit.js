/**
 * src/shared/utils/audit.js
 * Função de auditoria centralizada
 * 
 * 🔒 SECURITY FIX (AUDIT-09): Suporte a audit log transacional
 * Agora aceita um client (pg transaction) como parâmetro opcional.
 * Quando passado, o INSERT roda dentro da mesma transação do fluxo principal,
 * garantindo atomicidade: se a transação falhar, o audit log também é revertido.
 * 
 * Uso normal (fora de transação — comportamento original):
 *   await registrarAuditoria(req, 'ACAO', AUDIT_CATEGORIES.FINANCIAL, 'tabela', id, {});
 * 
 * Uso transacional (dentro de BEGIN/COMMIT):
 *   const client = await pool.connect();
 *   await client.query('BEGIN');
 *   // ... operação ...
 *   await registrarAuditoria(req, 'ACAO', AUDIT_CATEGORIES.FINANCIAL, 'tabela', id, {}, 'success', client);
 *   await client.query('COMMIT');
 */

function createAuditLogger(pool) {
  return async function registrarAuditoria(req, action, category, resource = null, resourceId = null, details = null, status = 'success', transactionClient = null) {
    try {
      const user = req.user || {};
      const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';

      // 🔒 AUDIT-09: Usa o client da transação se fornecido, senão usa o pool
      const queryRunner = transactionClient || pool;

      await queryRunner.query(`
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
      // Se estiver dentro de transação, propagar o erro para que o ROLLBACK funcione
      if (transactionClient) {
        console.error('❌ Erro ao registrar auditoria (transacional):', error.message);
        throw error;
      }
      // Fora de transação, apenas loga (comportamento original — não bloqueia o fluxo)
      console.error('❌ Erro ao registrar auditoria:', error.message);
    }
  };
}

module.exports = { createAuditLogger };
