const { createAuditCoreRoutes } = require('./routes/audit.routes');

function initAuditRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria) {
  return createAuditCoreRoutes(pool, verificarToken, verificarAdmin, registrarAuditoria);
}

module.exports = initAuditRoutes;
