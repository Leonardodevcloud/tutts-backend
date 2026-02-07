const { initMiscTables } = require('./misc.migration');
const { createMiscRouter } = require('./misc.routes');
function initMiscRoutes(pool) { return createMiscRouter(pool); }
module.exports = { initMiscRoutes, initMiscTables };
