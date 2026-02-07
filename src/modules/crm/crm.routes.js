const { createCrmCoreRoutes } = require('./routes/crm.routes');

function initCrmRoutes(pool) {
  return createCrmCoreRoutes(pool);
}

module.exports = initCrmRoutes;
