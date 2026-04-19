/**
 * MÓDULO COLETA DE ENDEREÇOS
 *
 * Base colaborativa de endereços alimentada por motoboys.
 * Sub-routers em ./routes/
 */

const { initColetaEnderecosTables } = require('./coletaEnderecos.migration');
const { createColetaEnderecosRouter } = require('./coletaEnderecos.routes');

function initColetaEnderecosRoutes(pool, verificarToken) {
  return createColetaEnderecosRouter(pool, verificarToken);
}

module.exports = { initColetaEnderecosRoutes, initColetaEnderecosTables };
