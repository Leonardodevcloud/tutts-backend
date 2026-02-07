const { initBiTables } = require('./bi.migration');
const { createBiRouter } = require('./bi.routes');
function initBiRoutes(pool) { return createBiRouter(pool); }
module.exports = { initBiRoutes, initBiTables };
