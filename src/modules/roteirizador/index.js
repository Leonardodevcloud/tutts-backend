/**
 * MÓDULO ROTEIRIZADOR
 * Proxy ORS (3) + Roteirizador (8) + Admin (4) + Geocode (4)
 * Total: 19 endpoints, 4 tabelas
 */

const { initRoteirizadorTables } = require('./roteirizador.migration');
const { createRoutingRouter, createRoteirizadorRouter, createAdminRoteirizadorRouter, createGeocodeRouter } = require('./roteirizador.routes');
const { normalizarEndereco } = require('./roteirizador.service');

function initRoteirizadorRoutes(pool, verificarToken, httpRequest, registrarAuditoria, AUDIT_CATEGORIES) {
  return {
    routingRouter: createRoutingRouter(pool, verificarToken, httpRequest, registrarAuditoria, AUDIT_CATEGORIES),
    roteirizadorRouter: createRoteirizadorRouter(pool, verificarToken),
    adminRoteirizadorRouter: createAdminRoteirizadorRouter(pool, verificarToken),
    geocodeRouter: createGeocodeRouter(pool)
  };
}

module.exports = { initRoteirizadorRoutes, initRoteirizadorTables, normalizarEndereco };
