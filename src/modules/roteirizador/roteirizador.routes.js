const { createRoutingRouter } = require('./routes/routing.routes');
const { createRoteirizadorRouter } = require('./routes/roteirizador.routes');
const { createAdminRoteirizadorRouter } = require('./routes/admin.routes');
const { createGeocodeRouter } = require('./routes/geocode.routes');

module.exports = { createRoutingRouter, createRoteirizadorRouter, createAdminRoteirizadorRouter, createGeocodeRouter };
